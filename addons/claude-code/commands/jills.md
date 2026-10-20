---
description: Jills - start the suggested Jill (go), or dismiss / never / quiet / on / status / auto on|off
argument-hint: go [jill] | dismiss | never | quiet | on | status [run] | list | auto on|off
allowed-tools: Bash(jills *)
disable-model-invocation: true
---

The user typed `/jills $ARGUMENTS`. This chat's Jills session id is `${CLAUDE_SESSION_ID}`.
Run exactly one `jills` command with the Bash tool, based on the first word of the arguments,
then tell the user the command's output in one or two short lines. Do nothing else.

| First word | Command to run |
|---|---|
| `go` (optional Jill name after it) | `jills go [<jill>] --session ${CLAUDE_SESSION_ID} --repo "$PWD"` (Jills reuses the inputs it saved with the last suggestion; add `--input 'name=value'` only for values the user typed after `go`, each in single quotes with any `'` inside written as `'\''`; never double quotes, so no `` ` `` or `$(` in a value can run) |
| `dismiss` | `jills dismiss --session ${CLAUDE_SESSION_ID}` |
| `never` (optional Jill name after it) | `jills never --session ${CLAUDE_SESSION_ID} --repo "$PWD"` (add `--jill <name>` when a name was given; without one it mutes the last suggested Jill) |
| `quiet` | `jills quiet --session ${CLAUDE_SESSION_ID}` |
| `on` | `jills on --session ${CLAUDE_SESSION_ID}` |
| `status` (optional run id after it) | `jills status [<run>]` |
| `list` | `jills list` |
| `auto on` / `auto off` | `jills auto on` / `jills auto off` |
| empty or anything else | `jills --help`, then show the user the `/jills` choices above |

After `go` succeeds, the output names the run id. Then run `jills wait <run-id>` with the Bash tool
in the background (`run_in_background: true`), tell the user the Jill started, and when the wait
finishes, tell the user its one-line result (state, branch and logs). Never merge the Jill's branch
yourself.
