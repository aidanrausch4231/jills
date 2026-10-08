import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Jills",
  GIT_AUTHOR_EMAIL: "jills@localhost",
  GIT_COMMITTER_NAME: "Jills",
  GIT_COMMITTER_EMAIL: "jills@localhost",
};

/** Run git; never throws for a non-zero exit. */
export function gitRaw(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Run git; throws with stderr on a non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await gitRaw(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export async function repoRoot(dir: string): Promise<string | undefined> {
  const r = await gitRaw(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
