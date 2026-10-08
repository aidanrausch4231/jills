import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, runNow, suggest } from "../src/api.js";
import { checkNesting, parseJill } from "../src/jillfile.js";
import { git, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const ID = "-c user.name=t -c user.email=t@t";
/** The documented procedure: squash the run branch into the base in the user's checkout. */
const SQUASH = `cd "$JILLS_BASE_REPO" && git merge --squash "$JILLS_RUN_BRANCH" && git ${ID} commit -q -m "squash: $JILLS_RUN_BRANCH"`;
const jill = (mergeRun: string, extra = "", build = "echo built > new.txt") => `steps:
  build: {run: '${build}; echo "base=[\${JILLS_BASE_REPO-}\${JILLS_BASE_BRANCH-}\${JILLS_RUN_BRANCH-}]"', writes: true}
  merge:
    needs: [build]
    merges: true
    run: '${mergeRun}'${extra}`;
const status = (repo: string) => execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" });

test("merges: true squash-merges into the base branch; only that step sees JILLS_BASE_* (even when the runner had them)", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  const tip = git(repo, "rev-parse", "main");
  writeJill(home, "sq", jill(`echo "repo=$JILLS_BASE_REPO branch=$JILLS_BASE_BRANCH run=$JILLS_RUN_BRANCH"; ${SQUASH}`));
  process.env.JILLS_BASE_REPO = "/leak";
  process.env.JILLS_RUN_BRANCH = "leak";
  const r = await runNow("sq", { home, cwd: repo });
  assert.equal(process.env.JILLS_BASE_REPO, undefined);
  assert.equal(r.state, "done", r.error);
  assert.equal(r.base, "main");
  assert.equal(git(repo, "rev-list", "--count", `${tip}..main`), "1");
  assert.equal(git(repo, "rev-parse", "main^"), tip);
  assert.equal(git(repo, "rev-parse", "main^{tree}"), git(repo, "rev-parse", `${r.branch}^{tree}`));
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "built\n");
  assert.equal(status(repo), "");
  assert.match(readFileSync(r.steps.build!.log!, "utf8"), /^base=\[\]$/m);
  assert.match(readFileSync(r.steps.merge!.log!, "utf8"), new RegExp(`repo=${repo} branch=main run=${r.branch}`));
});

test("the base moved during the run: a clean squash on the new tip is accepted (merge-tree of base and run)", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  // the user commits to main while the run builds
  writeJill(home, "moved", jill(SQUASH, "", `echo built > new.txt; cd "${repo}" && echo u > u.txt && git add u.txt && git ${ID} commit -q -m user; cd - >/dev/null`));
  const r = await runNow("moved", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.equal(git(repo, "log", "-1", "--format=%s", "main^"), "user");
  for (const f of ["u.txt", "new.txt", "base.txt"]) assert.ok(existsSync(join(repo, f)), f);
});

test("a base that gains another commit during the merge step, or a wrong commit -> needs-you", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "two", jill(`git -C "$JILLS_BASE_REPO" ${ID} commit -q --allow-empty -m "user work" && ${SQUASH}`));
  const r = await runNow("two", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /main must get exactly one new commit/);

  writeJill(home, "other", jill(`cd "$JILLS_BASE_REPO" && echo x > other.txt && git add other.txt && git ${ID} commit -q -m other`));
  const o = await runNow("other", { home, cwd: repo });
  assert.equal(o.state, "needs-you");
  assert.match(o.error!, /left your checkout modified: main must get exactly one new commit/);
});

test("R3: moving the base ref without updating the checkout -> needs-you", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "ur", jill(`c=$(git ${ID} commit-tree HEAD^{tree} -p "refs/heads/$JILLS_BASE_BRANCH" -m sq) && git update-ref "refs/heads/$JILLS_BASE_BRANCH" "$c"`));
  const r = await runNow("ur", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /must be clean, on main, at its new tip/);
});

test("R4: a merge step that changes the run branch -> needs-you", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "ev", jill(`echo evil > evil.txt && git add evil.txt && git ${ID} commit -qm x && ${SQUASH}`, "\n    on_fail: {back_to: build}"));
  const r = await runNow("ev", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /changed the run branch/);
  assert.equal(r.steps["merge@2"], undefined);
});

test("R5: a merge step that fails after touching the checkout -> needs-you, no back-arrow", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "half", jill(`cd "$JILLS_BASE_REPO" && git merge --squash "$JILLS_RUN_BRANCH" && exit 1`, "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const r = await runNow("half", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /merge step left your checkout modified/);
  assert.equal(r.steps["build@2"], undefined);

  writeJill(home, "after", jill(`${SQUASH} && exit 1`, "\n    on_fail: {back_to: build}"));
  const repo2 = tmpRepo();
  const a = await runNow("after", { home, cwd: repo2 });
  assert.equal(a.state, "needs-you");
  assert.match(a.error!, /failed after merging into main/);
  assert.equal(a.steps["merge@2"], undefined);
});

test("a merge step that fails or merges nothing with the checkout untouched takes its back-arrow", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "retry", jill("exit 1", "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const r = await runNow("retry", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /merge failed 2 rounds/);
  assert.ok(r.steps["build@2"] && r.steps["merge@2"]);

  writeJill(home, "noop", jill("true", "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const n = await runNow("noop", { home, cwd: repo });
  assert.equal(n.state, "needs-you");
  assert.match(n.steps.merge!.reason!, /nothing was merged into main/);
  assert.ok(n.steps["merge@2"]);
  assert.equal(status(repo), "");
});

test("N4: a squash conflict goes back to build with the base merged in; the builder resolves it", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  const userEdit = `[ {{round}} != 1 ] || { cd "${repo}" && echo user > base.txt && git ${ID} commit -qam user; }`;
  const build = `printf "%s" "{{feedback}}" > "$JILLS_WORKSPACE/../fb-{{round}}.txt"; echo built{{round}} > "$JILLS_WORKSPACE/base.txt"; ${userEdit}`;
  writeJill(home, "clash", jill(`cd "$JILLS_BASE_REPO" && { git merge --squash "$JILLS_RUN_BRANCH" || { git reset -q --merge; exit 1; }; } && git ${ID} commit -qm sq`, "\n    on_fail: {back_to: build, max_rounds: 3}", build));
  const r = await runNow("clash", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.ok(r.steps["merge@2"]);
  const fb = readFileSync(join(r.workspace!, "..", "fb-2.txt"), "utf8");
  assert.match(fb, /Resolve these merge conflicts with main .*: base\.txt/);
  // build@2's commit completes the merge of main into the run branch
  assert.equal(git(repo, "rev-list", "--parents", "-n", "1", r.steps["build@2"]!.commit!).split(" ").length, 3);
  assert.equal(readFileSync(join(repo, "base.txt"), "utf8"), "built2\n");
  assert.equal(git(repo, "log", "-1", "--format=%s", "main^"), "user");
  assert.equal(status(repo), "");
});

test("N3: untracked files the run would overwrite -> needs-you, nothing merged, no loop", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeFileSync(join(repo, "new.txt"), "user's untracked work\n");
  writeJill(home, "ut", jill(SQUASH, "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const r = await runNow("ut", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /untracked files in your checkout .* would be overwritten by the merge: new\.txt/);
  assert.equal(r.steps.merge!.log, undefined);
  assert.equal(r.steps["build@2"], undefined);
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "user's untracked work\n");
});

test("N5: a merge step that moves another branch or removes untracked files -> needs-you", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  git(repo, "branch", "other");
  writeJill(home, "br", jill(`${SQUASH} && git branch -f other "$JILLS_RUN_BRANCH"`));
  const r = await runNow("br", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /changed other branches or tags/);

  const repo2 = tmpRepo();
  writeFileSync(join(repo2, "notes.txt"), "precious\n");
  writeJill(home, "cl", jill(`${SQUASH} && git clean -fdq`));
  const c = await runNow("cl", { home, cwd: repo2 });
  assert.equal(c.state, "needs-you");
  assert.match(c.error!, /changed untracked files/);

  // untracked files that stay put are fine
  const repo3 = tmpRepo();
  writeFileSync(join(repo3, "notes.txt"), "precious\n");
  writeJill(home, "ok", jill(SQUASH));
  assert.equal((await runNow("ok", { home, cwd: repo3 })).state, "done");
});

test("N6: the run timing out after the merge commit still says the merge happened", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "tl", `timeout: 3s\n${jill(`${SQUASH} && sleep 10`)}`);
  const r = await runNow("tl", { home, cwd: repo });
  assert.equal(r.state, "stuck");
  assert.match(r.error!, /^merge step: merged into main; total time limit/);
});

test("dirty or switched user checkout -> needs-you, the merge step never runs", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "dirty", jill("touch ran.txt"));
  writeFileSync(join(repo, "base.txt"), "edited\n");
  const r = await runNow("dirty", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /has uncommitted changes/);
  assert.equal(r.steps.merge!.log, undefined);
  assert.equal(existsSync(join(r.workspace!, "ran.txt")), false);
  git(repo, "checkout", "-q", "base.txt");

  writeJill(home, "switch", `steps:
  build: {run: 'git -C "${repo}" checkout -q -b elsewhere; echo b > b.txt', writes: true}
  merge: {run: 'touch ran.txt', needs: [build], merges: true}`);
  const s = await runNow("switch", { home, cwd: repo });
  assert.equal(s.state, "needs-you");
  assert.match(s.error!, /is on another branch \(elsewhere, not main\)/);
  assert.equal(existsSync(join(s.workspace!, "ran.txt")), false);
});

test("R2: merges: true must be the single final step of the outermost Jill", async () => {
  const p = (steps: string, wt = "") => () => parseJill(`---\nname: m\n${wt}steps:\n${steps}\n---\n`);
  assert.throws(p("  a: {run: x, merges: true}", "worktree: false\n"), /merges: true needs worktree: true/);
  assert.throws(p("  a: {jill: x, merges: true}"), /merges: true needs an agent: or run: step/);
  assert.throws(p("  a: {run: x, merges: true, writes: true}"), /without writes: true/); // N7
  assert.throws(p("  b: {run: x}\n  m: {run: y, needs: [b], merges: true}\n  docs: {run: z, needs: [m]}"), /must be the single final step/);
  assert.throws(p("  b: {run: x}\n  side: {run: s}\n  m: {run: y, needs: [b], merges: true}"), /must be the single final step/);
  assert.throws(p("  b: {run: x}\n  m: {run: y, needs: [b], merges: true, copies: 2}"), /must be the single final step/);
  assert.doesNotThrow(p("  a: {run: x}\n  b: {run: x, needs: [a]}\n  c: {run: x, needs: [a]}\n  m: {run: y, needs: [b, c], merges: true}"));
  // only the outermost Jill may merge
  const inner = parseJill("---\nname: inner\nsteps:\n  m: {run: y, merges: true}\n---\n");
  const outer = parseJill("---\nname: outer\nsteps:\n  s: {jill: inner}\n---\n");
  assert.throws(() => checkNesting(outer, (n) => (n === "inner" ? inner : undefined)), /nested Jill "inner" has a merges: true step/);
  const home = tmpHome();
  writeJill(home, "inner", "steps:\n  m: {run: y, merges: true}");
  writeJill(home, "outer", "steps:\n  s: {jill: inner}");
  await assert.rejects(runNow("outer", { home, cwd: tmpRepo() }), /only the outermost Jill may merge/);
});

test("check, dry run and Jev say it merges (nested Jills too)", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "sq", `description: ship it\nkeywords: [ship it]\n${jill("true")}`);
  assert.ok((await check({ home })).warnings.some((w) => /step merge merges into the branch the run started from/.test(w)));
  assert.ok((await dryRun("sq", { home, cwd: repo })).some((l) => /merge .*merges into your branch/.test(l)));
  const s = await suggest({ home, session: "m1", message: "please ship it", repo });
  assert.equal(s.action, "suggest", s.reason);
  assert.equal(s.warning, "merges into main when done");
  assert.match(s.text!, /merges into main when done/);

  const h2 = tmpHome();
  writeJill(h2, "inner", "steps:\n  m: {run: y, merges: true}");
  writeJill(h2, "wrap", "description: wrap\nkeywords: [wrap it]\nsteps:\n  s: {jill: inner}");
  const w = await suggest({ home: h2, session: "m2", message: "wrap it", repo });
  assert.equal(w.jill, "wrap");
  assert.equal(w.warning, "merges into main when done");
});
