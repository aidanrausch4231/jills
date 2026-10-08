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
