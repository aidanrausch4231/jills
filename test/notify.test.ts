import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runNow } from "../src/api.js";
import { tmp, tmpHome, tmpRepo } from "./helpers.js";

const root = new URL("../../", import.meta.url).pathname;

test("examples/plugins/notify hooks `finished` from config plugins: alone (no core edit)", async () => {
  const out = join(tmp(), "done.txt");
  const home = tmpHome(`plugins: [${join(root, "dist", "examples", "plugins", "notify.js")}]\nnotify: {file: ${out}}\n`);
  cpSync(join(root, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
  const r = await runNow("hello", { home, cwd: tmpRepo(), inputs: { who: "notify" } });
  assert.equal(r.state, "done", r.error);
  assert.equal(readFileSync(out, "utf8"), `jills run ${r.id} done: hello | branch ${r.branch} | worktree ${r.workspace} | logs ${r.logDir}\n`);
});
