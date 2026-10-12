import { spawn } from "bun";

export const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
export const warn = (message: string) => console.warn(`${new Date().toISOString()} warning: ${message}`);

/** Runs a write (upload, tag, push, store update) unless this is a dry run, which prints what it skipped. */
export async function write<T>(dry: boolean, what: string, action: () => Promise<T>): Promise<T | undefined> {
  if (dry) {
    log(`dry run: skipped ${what}`);
    return undefined;
  }
  return action();
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Return stdout instead of streaming it to the terminal. */
  capture?: boolean;
}

/** Runs a command, streams its output, and throws when it exits non-zero. */
export async function run(command: string[], options: RunOptions = {}): Promise<string> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  const proc = spawn(command, {
    cwd: options.cwd,
    env,
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture ? "pipe" : "inherit",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    options.capture ? new Response(proc.stdout).text() : "",
    options.capture ? new Response(proc.stderr).text() : "",
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(`${command.join(" ")} exited ${code}${detail ? `: ${detail}` : ""}`);
  }
  return stdout;
}

export async function notify(title: string, message: string) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await run(["osascript", "-e", script], { capture: true }).catch(() => undefined);
}
