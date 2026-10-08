#!/usr/bin/env bash
# End-to-end: `jills start hello` in a temp git repo, `jills wait` prints done,
# the branch exists with a commit. Uses a temp JILLS_HOME; never touches ~/.jills.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export JILLS_HOME="$tmp/home"
mkdir -p "$JILLS_HOME/jills"
cp -r "$here/examples/hello" "$JILLS_HOME/jills/"
repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
jills() { node "$here/dist/src/cli.js" "$@"; }
out="$(cd "$repo" && jills start hello --input who=e2e --json)"
run="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).run))')"
echo "run: $run"
line="$(jills wait "$run" --timeout 60s)"
echo "$line"
case "$line" in *" done: hello"*) ;; *) echo "FAIL: not done"; exit 1;; esac
branch="jills/hello-$run"
git -C "$repo" rev-parse --verify -q "refs/heads/$branch" >/dev/null || { echo "FAIL: no branch $branch"; exit 1; }
n="$(git -C "$repo" rev-list --count "main..$branch")"
[ "$n" -ge 1 ] || { echo "FAIL: no commit on $branch"; exit 1; }
git -C "$repo" show "$branch:hello.txt"
[ "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-list --max-parents=0 main)" ] || { echo "FAIL: main moved"; exit 1; }
echo "E2E OK: $branch has $n commit(s); main untouched"

# Merge variant: a `merges: true` step squash-merges the run branch into main.
mkdir -p "$JILLS_HOME/jills/merge-hello"
cat > "$JILLS_HOME/jills/merge-hello/JILL.md" <<'JILL'
---
name: merge-hello
description: Write a file, then squash-merge it into the branch the run started from.
steps:
  write: {run: 'echo merged > merged.txt', writes: true}
  merge:
    needs: [write]
    merges: true
    run: 'cd "$JILLS_BASE_REPO" && git merge --squash "$JILLS_RUN_BRANCH" && git -c user.name=e2e -c user.email=e2e@e2e commit -q -m "squash $JILLS_RUN_BRANCH"'
---
JILL
tip="$(git -C "$repo" rev-parse main)"
out="$(cd "$repo" && jills start merge-hello --json)"
run="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).run))')"
line="$(jills wait "$run" --timeout 60s)"
echo "$line"
case "$line" in *" done: merge-hello"*) ;; *) echo "FAIL: merge run not done"; exit 1;; esac
[ "$(git -C "$repo" rev-parse main^)" = "$tip" ] || { echo "FAIL: main did not get exactly one commit"; exit 1; }
[ "$(git -C "$repo" rev-parse 'main^{tree}')" = "$(git -C "$repo" rev-parse "jills/merge-hello-$run^{tree}")" ] || { echo "FAIL: main tree differs from the run branch"; exit 1; }
[ "$(cat "$repo/merged.txt")" = merged ] || { echo "FAIL: merged.txt missing in the checkout"; exit 1; }
echo "E2E MERGE OK: main has one squash commit of jills/merge-hello-$run"
