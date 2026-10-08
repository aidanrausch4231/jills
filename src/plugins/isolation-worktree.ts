import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkout, git, gitRaw } from "./git.js";
import { mergeCheck, mergeStart, retry } from "./squash-merge.js";
import { ancestors, type JillDef, type StepDef } from "../jillfile.js";
import type { IsolationPlugin, MergeResult, Workspace } from "./types.js";

/** Git work on one workspace dir runs one at a time (parallel steps commit and merge back). */
const tails = new Map<string, Promise<unknown>>();
function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const result = (tails.get(dir) ?? Promise.resolve()).then(fn, fn);
  const tail = result.catch(() => undefined);
  tails.set(dir, tail);
  void tail.then(() => tails.get(dir) === tail && tails.delete(dir));
  return result;
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Git worktree isolation. The outermost run gets `jills/<name>-<runid>` under
 * $JILLS_HOME/worktrees/. Parallel writers get child worktrees branched from the
 * parent branch; merge-back uses merge-tree --write-tree + commit-tree + a CAS
 * update-ref, so a conflict never touches the parent. Never merges into the
 * user's branch itself: a `merges: true` step does, judged by squash-merge.ts. Worktrees are kept.
 */
const worktreeIsolation: IsolationPlugin = {
  slot: "isolation",
  apiVersion: 1,
  name: "worktree",

  async prepare({ repo, jill, runId, config }) {
    const top = await gitRaw(repo, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 ? top.stdout.trim() : undefined;
    if (!root) throw new Error(`${repo} is not inside a git repository (worktree: true needs one; set worktree: false or pass --input repo=<path>)`);
    const head = await gitRaw(root, ["rev-parse", "--verify", "HEAD"]);
    if (head.code !== 0) throw new Error(`${root} has no commits yet; make a first commit before running a Jill in a worktree`);
    const branch = `jills/${safe(jill)}-${runId}`;
    const dir = join(config.home, "worktrees", `${safe(jill)}-${runId}`);
    mkdirSync(join(config.home, "worktrees"), { recursive: true });
    const base = (await checkout(root)).branch;
    await git(root, ["worktree", "add", "-b", branch, dir, "HEAD"]);
    return { dir, branch, repo: root, base, isolated: true };
  },

  async child(parent, { key, runId, config }) {
    if (!parent.branch || !parent.repo) throw new Error("child worktree needs a git parent workspace");
    const branch = `${parent.branch}--${safe(key)}`;
    const dir = join(config.home, "worktrees", `${runId}--${safe(key)}`);
    await git(parent.repo, ["worktree", "add", "-b", branch, dir, parent.branch]);
    return { dir, branch, repo: parent.repo, isolated: true };
  },

  mergeBack: (parent, child, message) => locked(parent.dir, () => mergeBack(parent, child, message)),
  commit: (ws, message) => locked(ws.dir, () => commit(ws, message)),
  parallel: parallelWriters,
  mergeStart,
  mergeCheck,
  retry,
};

/** Steps that write and may run at the same time as another writer (or as their own copies) → child worktrees. */
function parallelWriters(jill: JillDef, lookup: (n: string) => JillDef | undefined): Set<string> {
  const writes = (s: StepDef, seen: Set<string>): boolean => {
    if (s.writes) return true;
    const j = s.jill && !seen.has(s.jill) ? lookup(s.jill) : undefined;
    return !!j && j.steps.some((x) => writes(x, seen.add(j.name)));
  };
  const writers = jill.steps.filter((s) => writes(s, new Set()));
  const out = new Set<string>();
  for (const w of writers) {
    if (w.copies > 1) out.add(w.name);
    for (const o of writers) if (o !== w && !ancestors(jill.steps, w.name).has(o.name) && !ancestors(jill.steps, o.name).has(w.name)) out.add(w.name);
  }
  return out;
}

async function mergeBack(parent: Workspace, child: Workspace, message: string): Promise<MergeResult> {
  if (!parent.branch || !child.branch || !parent.repo) throw new Error("merge-back needs git workspaces");
  const repo = parent.repo;
  const parentRef = `refs/heads/${parent.branch}`;
  // The parent worktree must be clean before its files move: a step without
  // `writes: true` may have left changes there. Commit them (git stays outside
  // agents), so the merge sees them and a clash becomes a normal conflict.
  const dirty = await git(parent.dir, ["status", "--porcelain"]);
  if (dirty) {
    await git(parent.dir, ["add", "-A"]);
    await git(parent.dir, ["commit", "-q", "--no-verify", "-m", `${message} (pending changes in the run worktree)`]);
  }
  const oldHead = await git(repo, ["rev-parse", parentRef]);
  const childHead = await git(repo, ["rev-parse", `refs/heads/${child.branch}`]);
  // Child has nothing new: done.
  const isAnc = await gitRaw(repo, ["merge-base", "--is-ancestor", childHead, oldHead]);
  if (isAnc.code === 0) return { ok: true, commit: oldHead };
  const mt = await gitRaw(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", oldHead, childHead]);
  if (mt.code === 1) {
    const lines = mt.stdout.split("\n").map((l) => l.trim());
    const conflicts = [...new Set(lines.slice(1).filter(Boolean))];
    return { ok: false, conflicts, message: `merge of ${child.branch} into ${parent.branch} conflicts in: ${conflicts.join(", ")}` };
  }
  if (mt.code !== 0) throw new Error(`git merge-tree failed: ${mt.stderr.trim()}`);
  const tree = mt.stdout.split("\n")[0]!.trim();
  const commit = await git(repo, ["commit-tree", tree, "-p", oldHead, "-p", childHead, "-m", message]);
  // Move files, index and branch together. A fast-forward to `commit` (whose
  // first parent is oldHead) only succeeds while the branch still points at
  // oldHead, so it doubles as the compare-and-swap; if the worktree cannot be
  // updated, git changes neither the files nor the branch.
  const ff = await gitRaw(parent.dir, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "-q", commit]);
  if (ff.code !== 0) {
    const now = await git(repo, ["rev-parse", parentRef]);
    throw new Error(
      `could not move ${parent.branch} to the merge of ${child.branch}${now !== oldHead ? " (the branch moved meanwhile)" : ""}: ${ff.stderr.trim() || ff.stdout.trim()}`,
    );
  }
  return { ok: true, commit };
}

async function commit(ws: Workspace, message: string): Promise<string | undefined> {
  if (!ws.branch) return undefined;
  const st = await git(ws.dir, ["status", "--porcelain"]);
  if (!st) return undefined;
  await git(ws.dir, ["add", "-A"]);
  await git(ws.dir, ["commit", "-q", "--no-verify", "-m", message]);
  return git(ws.dir, ["rev-parse", "HEAD"]);
}

export default worktreeIsolation;
