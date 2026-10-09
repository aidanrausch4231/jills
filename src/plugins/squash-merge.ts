import { checkout, git, gitRaw } from "./git.js";
import type { MergeCheck, Workspace } from "./types.js";

/**
 * The worktree plug-in's guard for `merges: true` steps (git-specific, so not in
 * core). The step squash-merges the run branch into the user's checkout; these
 * functions refuse an unsafe start and judge the result. Nothing here trusts the agent.
 */
type Start = { tip: string; pre: string; refs: string; untracked: string };

/** Branches and tags of `repo`, without `base` (it may advance) and Jills run branches. */
const refsOf = async (repo: string, base: string) =>
  (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]))
    .split("\n")
    .filter((l) => !l.startsWith(`refs/heads/${base} `) && !l.startsWith("refs/heads/jills/"))
    .join("\n");
const untrackedOf = (repo: string) => git(repo, ["ls-files", "--others", "--exclude-standard"]);

/** Before the step: the checkout must be clean, on `base`, with no untracked file the run adds. Returns a reason to refuse, or the snapshot. */
export async function mergeStart(ws: Workspace, base: string): Promise<Start | string> {
  const repo = ws.repo!;
  const [b, pre, refs, untracked] = await Promise.all([checkout(repo), git(ws.dir, ["rev-parse", "HEAD"]), refsOf(repo, base), untrackedOf(repo)]);
  if (b.dirty) return `your checkout ${repo} has uncommitted changes; nothing was merged`;
  if (b.branch !== base) return `your checkout ${repo} is on another branch (${b.branch ?? "detached HEAD"}, not ${base}); nothing was merged`;
  const added = (await git(repo, ["diff", "--name-only", "--diff-filter=A", `${b.head}...${pre}`])).split("\n");
  const clash = untracked.split("\n").filter((f) => f && added.includes(f));
  if (clash.length) return `untracked files in your checkout ${repo} would be overwritten by the merge: ${clash.join(", ")}; move them away, then start again`;
  // A conflict with the base stops here: Jills never resolves or commits a conflict.
  const mt = await gitRaw(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", b.head, pre]);
  if (mt.code === 1) {
    const files = [...new Set(mt.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean))];
    return `${base} changed since the run started and conflicts with ${ws.branch} in: ${files.join(", ")}; nothing was merged. Merge it yourself or rerun the Jill on the new ${base}.`;
  }
  if (mt.code !== 0) return `git merge-tree of ${base} and ${ws.branch} failed: ${mt.stderr.trim()}; nothing was merged`;
  return { tip: b.head, pre, refs, untracked };
}

/**
 * After the step. "merged": `base` got exactly one new commit on the old tip whose
 * tree is the squash of the run commit (merge-tree of tip and pre), or there was
 * nothing to merge (reason "nothing to merge"). "untouched": nothing changed. "bad": anything else (run
 * branch, other branches or tags, untracked files changed; checkout dirty,
 * elsewhere or behind; wrong commit).
 */
export async function mergeCheck(ws: Workspace, base: string, s: Start): Promise<MergeCheck> {
  const repo = ws.repo!;
  const [run, b, line, mt, refs, untracked] = await Promise.all([
    git(ws.dir, ["rev-parse", "HEAD"]),
    checkout(repo),
    git(repo, ["log", "-1", "--format=%H %T %P", `refs/heads/${base}`]),
    gitRaw(repo, ["merge-tree", "--write-tree", s.tip, s.pre]),
    refsOf(repo, base),
    untrackedOf(repo),
  ]);
  const [commit, tree, ...parents] = line.split(" ");
  const want = mt.code === 0 ? mt.stdout.split("\n")[0]!.trim() : undefined;
  const bad = (reason: string): MergeCheck => ({ state: "bad", reason });
  if (run !== s.pre) return bad(`the step changed the run branch ${ws.branch}`);
  if (refs !== s.refs) return bad(`the step changed other branches or tags in ${repo}`);
  if (untracked !== s.untracked) return bad(`the step changed untracked files in ${repo}`);
  if (b.dirty || b.branch !== base || b.head !== commit) return bad(`${repo} must be clean, on ${base}, at its new tip`);
  if (commit === s.tip) return want === tree ? { state: "merged", reason: "nothing to merge" } : { state: "untouched" };
  if (parents.join() === s.tip && want === tree) return { state: "merged" };
  return bad(`${base} must get exactly one new commit on ${s.tip.slice(0, 12)} with the squash of ${ws.branch}`);
}

/** Before a back-arrow reruns: `discard` resets the run worktree to its last commit and removes untracked files (a stale step's writes). */
export async function retry(ws: Workspace, o: { discard?: boolean }): Promise<void> {
  if (o.discard) await git(ws.dir, ["reset", "-q", "--hard"]).then(() => git(ws.dir, ["clean", "-fdq"]));
}
