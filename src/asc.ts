import type { AscCredentials } from "./config.ts";

const API = "https://api.appstoreconnect.apple.com/v1";

export interface Resource {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string } | null } | undefined>;
}

export interface Page {
  data: Resource[];
  included?: Resource[];
}

export interface Single {
  data: Resource;
}

const b64url = (data: string | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

export const attr = (resource: Resource | undefined, name: string): string | undefined => {
  const value = resource?.attributes?.[name];
  return typeof value === "string" ? value : undefined;
};

/** Thin App Store Connect client: ES256 JWT auth with crypto.subtle, JSON in and out. */
export class Asc {
  private cached: { token: string; expires: number } | undefined;

  constructor(
    private readonly credentials: AscCredentials,
    /** A read-only client refuses every request that is not a GET, so a dry run cannot write by accident. */
    private readonly readOnly = false,
  ) {}

  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expires - now > 60) return this.cached.token;
    const pem = await Bun.file(this.credentials.keyPath).text();
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const expires = now + 900;
    const body = `${b64url(JSON.stringify({ alg: "ES256", kid: this.credentials.keyId, typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: this.credentials.issuerId, iat: now, exp: expires, aud: "appstoreconnect-v1" }),
    )}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body));
    this.cached = { token: `${body}.${b64url(signature)}`, expires };
    return this.cached.token;
  }

  async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    if (this.readOnly && method !== "GET") throw new Error(`read-only client refused ${method} ${path}`);
    const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  list(path: string): Promise<Resource[]> {
    return this.api<Page>(path).then((page) => page.data);
  }

  post(path: string, body: unknown) {
    return this.api(path, { method: "POST", body: JSON.stringify(body) });
  }

  patch(path: string, body: unknown) {
    return this.api(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  /** The App Store Connect app for a bundle id; the app id is never stored. */
  async app(bundleId: string): Promise<Resource> {
    const apps = await this.list(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=200`);
    const app = apps.find((candidate) => attr(candidate, "bundleId") === bundleId);
    if (!app) throw new Error(`no App Store Connect app with bundle id ${bundleId} for this API key`);
    return app;
  }
}
