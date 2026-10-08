import { execFile } from "node:child_process";

/** Git helpers for the worktree isolation plug-in. */
const IDENTITY = { GIT_AUTHOR_NAME: "Jills", GIT_AUTHOR_EMAIL: "jills@localhost", GIT_COMMITTER_NAME: "Jills", GIT_COMMITTER_EMAIL: "jills@localhost" };

/** Run git as Jills; never throws for a non-zero exit. */
export function gitRaw(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0" };
  return new Promise((resolve) =>
    execFile("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
}

/** Run git; throws with stderr on a non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await gitRaw(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

/** The checkout at `dir`: its branch (undefined when detached), HEAD commit, and whether tracked files differ from HEAD. */
export async function checkout(dir: string): Promise<{ branch?: string; head: string; dirty: boolean }> {
  const [sym, head, st] = await Promise.all([gitRaw(dir, ["symbolic-ref", "--short", "-q", "HEAD"]), git(dir, ["rev-parse", "HEAD"]), git(dir, ["status", "--porcelain", "--untracked-files=no"])]);
  return { branch: sym.code === 0 ? sym.stdout.trim() : undefined, head, dirty: st !== "" };
}
