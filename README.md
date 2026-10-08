# Jills

Jills are saved agent workflows (`JILL.md`, like `SKILL.md`). Jev reads chat passively; when a
message is a new task that fits a saved Jill it suggests it (manual) or the main agent starts it
(auto). A Jill runs as a separate job in its own git worktree and reports back with a branch and
logs. Nothing merges itself.

Light like Pi: a tiny core and single-file plug-ins behind small versioned interfaces.

## Install

Needs Node 22+, pnpm and git 2.38+ (for `git merge-tree --write-tree`).

```bash
cd personal/jills
pnpm install && pnpm build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/jills     # or: pnpm link --global
mkdir -p ~/.jills/jills && cp -r examples/* ~/.jills/jills/
jills check
jills try hello --dry-run
```

Set `JILLS_HOME` to use another home folder (tests always use a temp one).

### Per harness

- **MCP (any harness)**: register `jills mcp` as a stdio MCP server. Tools: `list_jills`,
  `suggest_jill`, `start_jill`, `jill_status`, `wait_for_jill`.
  - Claude Code: `claude mcp add jills -- node /abs/path/personal/jills/dist/src/cli.js mcp`
  - Pi: run `pi mcp add jills -- node /abs/path/personal/jills/dist/src/cli.js mcp`, or add this
    to the global `~/.pi/agent/mcp.json` (a project `.pi/mcp.json` applies only in trusted projects):
    `{"mcpServers": {"jills": {"command": "node", "args": ["/abs/path/personal/jills/dist/src/cli.js", "mcp"]}}}`
  - dsh: add the same command as an MCP server in the dsh config.
- **Chat suggestions** come from the add-ons in `addons/`, all built: the Claude Code hook and
  `/jills` command (`addons/claude-code/`), the Pi extension (`addons/pi/`) and the dsh card
  (`addons/dsh/`). Each folder's README has its install steps; `addons/README.md` lists the
  library API they call.

## Config: `~/.jills/config.yml`

```yaml
auto: false                     # global auto/manual switch (jills auto on|off)
agent_paths: [/home/rausch/harness/v4/agents-src]   # searched in order, first name wins
jill_paths: [~/.jills/jills]    # folders of <name>/JILL.md, first name wins
jev:
  model: typesafe/jev-router    # OpenRouter model
  key_env: OPENROUTER_API_KEY   # key is read ONLY from this env var, never logged
  threshold: 0.7                # suggest only when confidence >= threshold
agent_cli: pi                   # pi | claude
# agent_bin: /path/to/pi        # optional binary override
# claude_permission_mode: acceptEdits
tiers: { spinsoft: openrouter/some-cheap-model }
default_model: openai-codex/gpt-5.6-sol
# plugins: [~/.jills/plugins/my-runner.js]
# default_timeout: 2h           # total limit for Jills that set no timeout (default 2h)
```

No key or a network error → the keywords matcher answers (`keywords:` in JILL.md).

## JILL.md

```yaml
---
name: fix-bug
description: Research a bug, fix it on a Jills branch, then get an independent review.
when: The user reports a bug and wants it fixed.     # Jev matches on this
keywords: [bug, broken]                              # fallback matcher
inputs:
  - name: task
    required: true
worktree: true        # default true: run on branch jills/<name>-<run> in $JILLS_HOME/worktrees/
docker: false         # v1 refuses docker: true
machine: local        # v1 refuses anything else
timeout: 90m          # whole run; over → stuck
steps:
  research: { jill: research, inputs: { task: "Find the cause: {{inputs.task}}" } }
  implement: { agent: harness-implementer, needs: [research], writes: true, task: "Fix: {{inputs.task}}\n{{steps.research.output}}" }
  review: { agent: harness-reviewer, needs: [implement], timeout: 20m }
---
```

Step fields: exactly one of `agent: <name>`, `run: <shell>`, `jill: <name>`; plus `task`, `needs`,
`copies` (1–16 parallel copies), `writes`, `model`, `timeout`, `inputs` (for nested Jills).
Unknown fields pass through to plug-ins.

Templates: `{{inputs.x}}`, `{{task}}`, `{{copy}}`, `{{run_id}}`, `{{steps.<name>.output}}`.
In `run:` commands no value is ever pasted into the shell text: each placeholder becomes an env
var reference (`"${JILLS_INPUT_X}"`, `"${JILLS_TASK}"`, `"${JILLS_COPY}"`,
`"${JILLS_STEP_OUT_<NAME>}"`), quoted to fit where it sits, so placeholders work outside quotes,
inside `"double"` or `'single'` quotes and inside `$( )`, and inputs, chat text or agent output
cannot inject commands. Placeholders inside backticks are refused (use `$( )`). Steps also get env
vars `JILLS_RUN_ID`, `JILLS_STEP`, `JILLS_WORKSPACE`, `JILLS_COPY`, `JILLS_INPUT_<NAME>`.

### Agent steps

Agent files are markdown with front matter `name`, `description`, `tools`, `model`, `tier`; the
body is the instructions. Model = `step.model ?? agent.model ?? tiers[agent.tier] ?? default_model`.

- pi: `pi -p --model M --append-system-prompt <instructions file> --tools read,grep -- "<task>"`
- claude: `claude -p --model M --append-system-prompt "<instructions>" --tools Read,Grep [--permission-mode P] -- "<task>"`

### How a run works

- Steps whose `needs` are done start in parallel; `copies: N` starts N instances.
- `jill:` steps run inline in the same run and worktree. No self or indirect recursion; depth ≤ 4.
- Per-step and total timeouts kill the whole process group; the run becomes `stuck`. Every run has a
  total limit: the Jill's `timeout`, else config `default_timeout` (default 2h). The record keeps the
  deadline, so `jills wait` reports `stuck` (and kills the runner and its steps) even when a runner
  hangs past it, instead of waiting forever.
- Git stays outside agents: Jills commits after each `writes: true` step.
- Writers that can run at the same time get child worktrees branched from the run branch, merged
  back with `git merge-tree --write-tree` + `commit-tree` + compare-and-swap `update-ref`. A conflict
  sets the run to `needs-you`, lists the files and leaves the run branch untouched.
- Jills never merges into your branch. Worktrees are kept until you delete them.
- `worktree: false` runs in the repo folder itself and never commits.
- Run states: `queued`, `running`, `done`, `failed`, `stuck`, `needs-you`.
- Records: `$JILLS_HOME/runs/<id>.json` (atomic writes) and per-step logs in `$JILLS_HOME/runs/<id>/`.
- No background service: `jills start` spawns a detached runner process and exits.

## CLI

```
jills list | check
jills suggest --session <id> [--repo p] [--json] "<message>"   # recent turns as JSON on stdin (optional)
jills start <jill> [--input k=v]... [--repo p] [--session id] [--json] [--wait]
jills go --session <id> [jill] [--input k=v] # start the last suggestion with the inputs Jev proposed
jills wait <run> [--timeout 30m]            # one-line result: state, branch, worktree, logs
jills status [run]
jills try <jill> --dry-run [--input k=v]    # without --dry-run: run in the foreground
jills dismiss|quiet|on --session <id>       # on --unmute also clears repo mutes
jills never [--session id] [--jill name] [--repo p]
jills auto on|off
jills new <name>
jills mcp
```

Exit codes: 0 ok / done / suggestion, 1 error or refusal, 2 usage, 3 no suggestion,
4 run failed, 5 run stuck, 6 run needs you, 7 wait timed out.

## Anti-nag rules (per chat session, `$JILLS_HOME/sessions/<id>.json`)

- Suggest only when Jev labels the message `new` with confidence ≥ threshold.
- Dismissed ("Not this") → quiet for the rest of this chat.
- A Jill running in this chat → quiet until it ends.
- An ignored suggestion → wait for a new task: the ignored Jill (and any Jill already suggested in
  this chat) stays quiet until a different Jill matches, or Jev names it for a different target
  (other inputs). A keyword hit never counts as a new task.
- Never → muted for this repo (one Jill, or all) in `$JILLS_HOME/muted.json`.
- `/jills quiet` → quiet mode for this chat.
- At most one suggestion per 3 messages.
- Jev may only fill inputs the Jill declares; any other key (such as `repo`) is dropped, for Jev,
  keyword and plug-in matches and for `jills go`.
- The last suggestion's inputs are saved in the session state; `jills go` (and `/jills go`) uses
  them, with `--input` overriding single values.

## Plug-ins

Slots (interface version 1, `src/plugins/types.ts`): `matcher`, `runner`, `isolation`, `check`.
Built-ins: matcher `jev` then `keywords`; runner `command` and `agent`; isolation `worktree`;
check `exit-code`. A plug-in is one ESM file whose default export is
`{ slot, apiVersion: 1, name, ...methods }`; list it under `plugins:` in config.yml. Core refuses an
unknown `apiVersion`. Later stages add `docker` isolation and `ssh` places in the same slots.

## Develop

```bash
pnpm build && pnpm test      # core + add-on tests (claude-code, pi, dsh unit); no network; temp JILLS_HOME
pnpm test:core               # core only
pnpm e2e                     # jills start hello in a temp repo → wait → branch with commits
pnpm smoke:dsh               # isolated real dsh + browser (not part of pnpm test)
```
