import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, gitRaw, repoRoot } from "../git.js";
import type { IsolationPlugin, MergeResult, Workspace } from "./types.js";

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Git worktree isolation. The outermost run gets `jills/<name>-<runid>` under
 * $JILLS_HOME/worktrees/. Parallel writers get child worktrees branched from the
 * parent branch; merge-back uses merge-tree --write-tree + commit-tree + a CAS
 * update-ref, so a conflict never touches the parent. Never merges into the
 * user's branch. Worktrees are kept.
 */
const worktreeIsolation: IsolationPlugin = {
  slot: "isolation",
  apiVersion: 1,
  name: "worktree",

  async prepare({ repo, jill, runId, config }) {
    const root = await repoRoot(repo);
    if (!root) throw new Error(`${repo} is not inside a git repository (worktree: true needs one; set worktree: false or pass --input repo=<path>)`);
    const head = await gitRaw(root, ["rev-parse", "--verify", "HEAD"]);
    if (head.code !== 0) throw new Error(`${root} has no commits yet; make a first commit before running a Jill in a worktree`);
    const branch = `jills/${safe(jill)}-${runId}`;
    const dir = join(config.home, "worktrees", `${safe(jill)}-${runId}`);
    mkdirSync(join(config.home, "worktrees"), { recursive: true });
    await git(root, ["worktree", "add", "-b", branch, dir, "HEAD"]);
    return { dir, branch, repo: root, isolated: true };
  },

  async child(parent, { key, runId, config }) {
    if (!parent.branch || !parent.repo) throw new Error("child worktree needs a git parent workspace");
    const branch = `${parent.branch}--${safe(key)}`;
    const dir = join(config.home, "worktrees", `${runId}--${safe(key)}`);
    await git(parent.repo, ["worktree", "add", "-b", branch, dir, parent.branch]);
    return { dir, branch, repo: parent.repo, isolated: true };
  },

  async mergeBack(parent: Workspace, child: Workspace, message: string): Promise<MergeResult> {
    if (!parent.branch || !child.branch || !parent.repo) throw new Error("merge-back needs git workspaces");
    const repo = parent.repo;
    const parentRef = `refs/heads/${parent.branch}`;
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
    // Compare-and-swap: only move the parent branch if nobody else moved it.
    await git(repo, ["update-ref", "-m", `jills: ${message}`, parentRef, commit, oldHead]);
    // Bring the parent worktree's index and files up to the new commit.
    await git(parent.dir, ["read-tree", "-m", "-u", oldHead, commit]);
    return { ok: true, commit };
  },

  async commit(ws, message) {
    if (!ws.branch) return undefined;
    const st = await git(ws.dir, ["status", "--porcelain"]);
    if (!st) return undefined;
    await git(ws.dir, ["add", "-A"]);
    await git(ws.dir, ["commit", "-q", "--no-verify", "-m", message]);
    return git(ws.dir, ["rev-parse", "HEAD"]);
  },
};

export default worktreeIsolation;
