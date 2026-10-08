import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// Tests never use the network or a real key.
delete process.env.OPENROUTER_API_KEY;

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

export function tmp(prefix = "jills-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A temp JILLS_HOME with an empty agents folder and optional config lines. */
export function tmpHome(config = ""): string {
  const home = tmp("jills-home-");
  mkdirSync(join(home, "jills"), { recursive: true });
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "config.yml"), `agent_paths: [${join(home, "agents")}]\n${config}`);
  return home;
}

export function writeJill(home: string, name: string, frontMatter: string, body = ""): string {
  const dir = join(home, "jills", name);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "JILL.md");
  writeFileSync(f, `---\nname: ${name}\n${frontMatter.trim()}\n---\n${body}\n`);
  return f;
}

export function writeAgent(dir: string, file: string, fm: string, body = "Do the task."): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${fm.trim()}\n---\n${body}\n`);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** A temp git repo on branch main with one commit (base.txt). */
export function tmpRepo(): string {
  const repo = tmp("jills-repo-");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
