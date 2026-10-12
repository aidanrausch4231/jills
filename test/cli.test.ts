import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

const root = new URL("../../", import.meta.url).pathname;
const cli = join(root, "dist", "src", "cli.js");

function jills(home: string, args: string[], opts: { cwd?: string; input?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, JILLS_HOME: home };
  delete env.OPENROUTER_API_KEY;
  delete env.TYPESAFE_API_KEY;
  const r = spawnSync(process.execPath, [cli, ...args], { env, cwd: opts.cwd, input: opts.input ?? "", encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("CLI exit codes and core commands", () => {
  const home = tmpHome();
  cpSync(join(root, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
  writeJill(home, "boxed", "box: docker\nsteps:\n  a: {run: echo}");
  writeJill(home, "fails", "worktree: false\nsteps:\n  a: {run: exit 9}");
  const repo = tmpRepo();

  assert.equal(jills(home, []).code, 2);
  assert.equal(jills(home, ["frobnicate"]).code, 2);
  assert.equal(jills(home, ["--help"]).code, 0);
  assert.match(jills(home, ["list"]).out, /hello\s+Write a hello file/);

  const sug = jills(home, ["suggest", "--session", "c1", "--json", "please say hello"], { cwd: repo, input: JSON.stringify([{ role: "user", text: "hi" }]) });
  assert.equal(sug.code, 0, sug.err);
  assert.equal(JSON.parse(sug.out).jill, "hello");
  assert.equal(jills(home, ["suggest", "--session", "c1", "nothing relevant"], { cwd: repo }).code, 3);
  assert.equal(jills(home, ["suggest", "nothing"]).code, 2);

  const boxed = jills(home, ["start", "boxed"], { cwd: repo });
  assert.equal(boxed.code, 1);
  assert.match(boxed.err, /"docker" isolation extension is not installed/);

  const dry = jills(home, ["try", "hello", "--dry-run", "--input", "who=x"], { cwd: repo });
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /greet \(writes\): bash -c "echo hello \\"\$\{JILLS_INPUT_WHO\}\\" > hello.txt".*env JILLS_INPUT_WHO="x"/);

  const fail = jills(home, ["start", "fails", "--wait"], { cwd: repo });
  assert.equal(fail.code, 4);
  assert.match(fail.out, /failed: fails/);

  const st = jills(home, ["start", "hello", "--json"], { cwd: repo });
  assert.equal(st.code, 0, st.err);
  const id = JSON.parse(st.out).run as string;
  const w = jills(home, ["wait", id, "--timeout", "45s"]);
  assert.equal(w.code, 0, w.out + w.err);
  assert.match(w.out, new RegExp(`^jills run ${id} done: hello \\| branch jills/hello-${id}`));
  assert.match(jills(home, ["status", id]).out, /done\s+greet/);
  assert.equal(jills(home, ["status", "nope"]).code, 1);

  assert.equal(jills(home, ["dismiss", "--session", "c2"]).code, 0);
  assert.equal(jills(home, ["quiet", "--session", "c2"]).code, 0);
  assert.equal(jills(home, ["on", "--session", "c2"]).code, 0);
  assert.equal(jills(home, ["never", "--jill", "hello", "--repo", repo]).code, 0);
  assert.equal(jills(home, ["auto", "on"]).code, 0);
  assert.match(readFileSync(join(home, "config.yml"), "utf8"), /auto: true/);
  assert.match(readFileSync(join(home, "config.yml"), "utf8"), /agent_paths/);
  assert.equal(jills(home, ["auto", "maybe"]).code, 2);

  const n = jills(home, ["new", "my-flow"]);
  assert.equal(n.code, 0);
  assert.ok(existsSync(join(home, "jills", "my-flow", "JILL.md")));
  const chk = jills(home, ["check"]);
  assert.match(chk.out, /error: .*"docker" isolation extension is not installed/);
  assert.equal(chk.code, 1);
});
