import type { AndroidConfig } from "./config.ts";
import { resolvePath } from "./config.ts";
import { log } from "./log.ts";

const b64url = (data: string | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

export interface PlayRelease {
  status: string;
  versionCodes?: string[];
  releaseNotes?: { language: string; text: string }[];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const RETRY_AFTER = 5 * 60 * 1000;

/**
 * Google Play Developer API client, signed in as a service account. The account needs "Release to testing
 * tracks" on the app in Play Console (production also needs "Release to production").
 */
export class Play {
  readonly api: string;
  readonly upload: string;
  private token: string | undefined;

  constructor(
    private readonly keyFile: string,
    packageName: string,
    /** A read-only client refuses every request that is not a GET. */
    private readonly readOnly = false,
    /** Play reads tracks only through an edit, so a read-only client that inspects tracks may also create and delete edits. */
    private readonly inspectOnly = false,
  ) {
    this.api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`;
    this.upload = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}`;
  }

  static forConfig(root: string, android: AndroidConfig): Play {
    if (!android.playKey) throw new Error("android.playKey is not set in ship.json");
    return new Play(resolvePath(root, android.playKey), android.package);
  }

  /** For status and doctor: reads tracks through a short-lived edit and writes nothing else. */
  static inspector(root: string, android: AndroidConfig): Play {
    if (!android.playKey) throw new Error("android.playKey is not set in ship.json");
    return new Play(resolvePath(root, android.playKey), android.package, true, true);
  }

  async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const account = (await Bun.file(this.keyFile).json()) as ServiceAccount;
    const der = Buffer.from(account.private_key.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    };
    const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
    const response = await fetch(account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${body}.${b64url(signature)}`,
      }),
    });
    if (!response.ok) throw new Error(`token -> ${response.status}: ${await response.text()}`);
    this.token = ((await response.json()) as { access_token: string }).access_token;
    return this.token;
  }

  async call<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    const isEdit = /\/edits(\/[^/:]+)?$/.test(url.split("?")[0] ?? "");
    if (
      this.readOnly &&
      method !== "GET" &&
      !(this.inspectOnly && isEdit && (method === "POST" || method === "DELETE"))
    ) {
      throw new Error(`read-only client refused ${method} ${url}`);
    }
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...init.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** An edit is Play's transaction: nothing goes live until it is committed. */
  async newEdit(): Promise<string> {
    return (await this.call<{ id: string }>(`${this.api}/edits`, { method: "POST" })).id;
  }

  deleteEdit(edit: string) {
    return this.call(`${this.api}/edits/${edit}`, { method: "DELETE" });
  }

  async releases(edit: string, track: string): Promise<PlayRelease[]> {
    return (await this.call<{ releases?: PlayRelease[] }>(`${this.api}/edits/${edit}/tracks/${track}`)).releases ?? [];
  }

  async uploadBundle(edit: string, file: string): Promise<number> {
    const uploaded = await this.call<{ versionCode: number }>(`${this.upload}/edits/${edit}/bundles?uploadType=media`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Bun.file(file),
    });
    return uploaded.versionCode;
  }

  setTrack(
    edit: string,
    track: string,
    release: { versionCode: string; status: "completed" | "draft"; notes: string },
  ) {
    return this.call(`${this.api}/edits/${edit}/tracks/${track}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track,
        releases: [
          {
            versionCodes: [release.versionCode],
            status: release.status,
            releaseNotes: [{ language: "en-US", text: release.notes }],
          },
        ],
      }),
    });
  }

  /**
   * Commits an edit. Play reviews the whole app at once, so a commit fails while earlier changes, such as the
   * nightly's production release, are still in review. Wait once for that review to clear; if it has not,
   * cancel it and send everything for review again, the earlier changes included.
   */
  async commit(edit: string) {
    const url = (behavior: string) => `${this.api}/edits/${edit}:commit?changesInReviewBehavior=${behavior}`;
    for (let tries = 0; ; tries++) {
      try {
        return await this.call(url("ERROR_IF_IN_REVIEW"), { method: "POST" });
      } catch (error) {
        if (!String(error).includes("CHANGES_ALREADY_IN_REVIEW")) throw error;
        if (tries === 1) break;
        log(`changes already in review on Play; retrying in ${RETRY_AFTER / 60_000} minutes`);
        await Bun.sleep(RETRY_AFTER);
      }
    }
    log("changes still in review on Play; cancelling that review and sending everything again");
    return this.call(url("CANCEL_IN_REVIEW_AND_SUBMIT"), { method: "POST" });
  }
}

export const newestCode = (releases: PlayRelease[]) =>
  Math.max(0, ...releases.flatMap((release) => release.versionCodes ?? []).map(Number));
