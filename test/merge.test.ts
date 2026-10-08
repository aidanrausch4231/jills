import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, runNow, suggest } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import { git, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const ID = "-c user.name=t -c user.email=t@t";
/** The documented procedure: bring the base into the run branch, then squash the run branch into the base. */
const SQUASH = `git ${ID} merge --no-edit "$JILLS_BASE_BRANCH" && cd "$JILLS_BASE_REPO" && git merge --squash "$JILLS_RUN_BRANCH" && git ${ID} commit -q -m "squash: $JILLS_RUN_BRANCH"`;
const jill = (mergeRun: string, extra = "") => `steps:
  build: {run: 'echo built > new.txt; echo "base=[\${JILLS_BASE_REPO-}\${JILLS_BASE_BRANCH-}\${JILLS_RUN_BRANCH-}]"', writes: true}
  merge:
    needs: [build]
    merges: true
    run: '${mergeRun}'${extra}`;

test("merges: true squash-merges into the base branch; only that step sees JILLS_BASE_*", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  const tip = git(repo, "rev-parse", "main");
  writeJill(home, "sq", jill(`echo "repo=$JILLS_BASE_REPO branch=$JILLS_BASE_BRANCH run=$JILLS_RUN_BRANCH"; ${SQUASH}`));
  const r = await runNow("sq", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.base, "main");
  assert.equal(git(repo, "rev-list", "--count", `${tip}..main`), "1");
  assert.equal(git(repo, "rev-parse", "main^"), tip);
  assert.equal(git(repo, "rev-parse", "main^{tree}"), git(repo, "rev-parse", `${r.branch}^{tree}`));
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "built\n");
  assert.match(readFileSync(r.steps.build!.log!, "utf8"), /^base=\[\]$/m);
  assert.match(readFileSync(r.steps.merge!.log!, "utf8"), new RegExp(`repo=${repo} branch=main run=${r.branch}`));
});

test("a base that gains another commit during the merge step -> not accepted", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "moved", jill(`git -C "$JILLS_BASE_REPO" ${ID} commit -q --allow-empty -m "user work" && ${SQUASH}`));
  const r = await runNow("moved", { home, cwd: repo });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /merge not accepted/);
});

test("a merge step that commits something else -> run fails", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "other", jill(`cd "$JILLS_BASE_REPO" && echo x > other.txt && git add other.txt && git ${ID} commit -q -m other`));
  const r = await runNow("other", { home, cwd: repo });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /merge not accepted: main must get exactly one new commit/);
});

test("a merge step that fails without touching the base takes its back-arrow; after changing it, no loop", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "retry", jill("exit 1", "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const r = await runNow("retry", { home, cwd: repo });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /merge failed 2 rounds/);
  assert.ok(r.steps["build@2"] && r.steps["merge@2"]);

  // exits 0 but merges nothing: the base is untouched, so that is a normal failure too
  writeJill(home, "noop", jill("true", "\n    on_fail: {back_to: build, max_rounds: 2}"));
  const n = await runNow("noop", { home, cwd: repo });
  assert.equal(n.state, "needs-you");
  assert.match(n.steps.merge!.reason!, /merge not accepted/);
  assert.ok(n.steps["merge@2"]);

  writeJill(home, "half", jill(`cd "$JILLS_BASE_REPO" && git ${ID} commit -q --allow-empty -m half && exit 1`, "\n    on_fail: {back_to: build}"));
  const h = await runNow("half", { home, cwd: repo });
  assert.equal(h.state, "failed");
  assert.match(h.error!, /after changing main/);
  assert.equal(h.steps["merge@2"], undefined);
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

  // the user switches branch while the run builds
  writeJill(home, "switch", `steps:
  build: {run: 'git -C "${repo}" checkout -q -b elsewhere; echo b > b.txt', writes: true}
  merge: {run: 'touch ran.txt', needs: [build], merges: true}`);
  const s = await runNow("switch", { home, cwd: repo });
  assert.equal(s.state, "needs-you");
  assert.match(s.error!, /is on another branch \(elsewhere, not main\)/);
  assert.equal(existsSync(join(s.workspace!, "ran.txt")), false);
});

test("merges: true needs worktree and an agent/run step; check, dry run and Jev say it merges", async () => {
  assert.throws(() => parseJill("---\nname: m\nworktree: false\nsteps:\n  a: {run: x, merges: true}\n---\n"), /merges: true needs worktree: true/);
  assert.throws(() => parseJill("---\nname: m\nsteps:\n  a: {jill: x, merges: true}\n---\n"), /merges: true needs an agent: or run: step/);
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "sq", `description: ship it\nkeywords: [ship it]\n${jill("true")}`);
  assert.ok((await check({ home })).warnings.some((w) => /step merge merges into the branch the run started from/.test(w)));
  assert.ok((await dryRun("sq", { home, cwd: repo })).some((l) => /merge .*merges into your branch/.test(l)));
  const s = await suggest({ home, session: "m1", message: "please ship it", repo });
  assert.equal(s.action, "suggest", s.reason);
  assert.equal(s.warning, "merges into main when done");
  assert.match(s.text!, /merges into main when done/);
});
