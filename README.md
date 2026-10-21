# Jills

Jills are saved agent workflows (`JILL.md`, like `SKILL.md`). Jev reads chat passively; when a
message is a new task that fits a saved Jill it suggests it (manual) or the main agent starts it
(auto). A Jill runs as a separate job in its own git worktree and reports back with a branch and
logs. Nothing merges into your branch unless a step declares `merges: true` (see [Merging](#merging)).

Light like Pi: a tiny core and single-file plug-ins behind small versioned interfaces.

**v1 = Pi + DeepSeek Harness (dsh).** The Claude Code add-on (`addons/claude-code/`) is v2: its code
and tests stay in the repo and run in `pnpm test`, but it is not part of the v1 install.
Its mod (suggestion card, progress pane, status row) installs in Claude Code with:

```
/plugin install jills --marketplace aidanrausch4231/jills
```

## Install

Needs Node 22+, pnpm and git 2.38+ (for `git merge-tree --write-tree`).

```bash
cd jills
pnpm install && pnpm build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/jills     # or: pnpm link --global
mkdir -p ~/.jills/jills ~/.jills/agents && cp -r examples/hello ~/.jills/jills/ && cp examples/agents/*.md ~/.jills/agents/
jills check
jills try hello --dry-run
```

Set `JILLS_HOME` to use another home folder (tests always use a temp one).

**Setup with an agent:** ask Claude Code, Pi or Codex to follow
[`skills/jills-setup/SKILL.md`](skills/jills-setup/SKILL.md). It checks prerequisites, builds the
CLI, writes `config.yml`, maps the example agents, offers the add-ons and verifies with `jills check`.

### Per harness

- **MCP (any harness)**: register `jills mcp` as a stdio MCP server. Tools: `list_jills`,
  `suggest_jill`, `start_jill`, `jill_status`, `wait_for_jill`. The server is the `addons/mcp/`
  add-on; the CLI loads it only for `jills mcp`.
  - Pi: run `pi mcp add jills -- node /path/to/jills/dist/src/cli.js mcp`, or add this
    to the global `~/.pi/agent/mcp.json` (a project `.pi/mcp.json` applies only in trusted projects):
    `{"mcpServers": {"jills": {"command": "node", "args": ["/path/to/jills/dist/src/cli.js", "mcp"]}}}`
  - dsh: add the same command as an MCP server in the dsh config.
- **Chat suggestions** come from the v1 add-ons in `addons/`: the Pi extension (`addons/pi/`) and
  the dsh card (`addons/dsh/`). Each folder's README has its install steps; `addons/README.md` lists
  the library API they call. `addons/claude-code/` (hook + `/jills` command) is v2: built and tested,
  but not installed in v1.

## Config: `~/.jills/config.yml`

```yaml
auto: false                     # global auto/manual switch (jills auto on|off)
agent_paths: [~/.jills/agents]  # agent runner plug-in: searched in order, first name wins (default $JILLS_HOME/agents)
jill_paths: [~/.jills/jills]    # folders of <name>/JILL.md, first name wins
jev:
  model: jev-latest             # TypeSafe System One model
  url: https://api.typesafe.ai/v1/systemone
  key_env: TYPESAFE_API_KEY     # env var (and dsh credential ref) for the key; never logged
  threshold: 0.5                # suggest only when P(chosen Jill route) >= threshold (default 0.5)
agent_cli: pi                   # pi or claude (Claude Code runner); other agent CLIs are add-ons
# agent_bin: /path/to/pi        # optional binary override
# claude_bin: /path/to/claude   # Claude Code runner: optional binary override
# claude_default_model: claude-opus-5-5  # replaces default_model for claude steps
# claude_tools: [Read, Grep, Glob, Write, Edit, "Bash(npm test:*)", "Bash(pnpm test:*)", "Bash(node --test:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"]  # writer claude steps only
tiers: { cheap: openrouter/some-cheap-model }
default_model: openai-codex/gpt-5.6-sol
# plugins: [~/.jills/plugins/my-runner.js]
# default_timeout: 2h           # total limit for Jills that set no timeout (default 2h)
```

Jev is [TypeSafe](https://docs.typesafe.ai) System One (`jev-latest`): one request per message with a
`route` Choice (`talk`, `same`, `new:<jill>`, `none`) and two yes/no questions (`action`, `refers_back`), and real
probabilities back. It never writes text. A Jill is suggested only when `route` is `new:<jill>`, its probability is
at least `jev.threshold` and `action` is at least 0.5. Jev fills only a Jill's single required input that has no default,
with your message. Custom `jev.url` values are not guarded: the key goes wherever you point it. A plain-string input (`inputs: [task]`) is never filled by Jev: mark it `required: true` (map form, `inputs: [{name: task, required: true}]`) to have it filled (plus the last 3 turns, quoted, when `refers_back` is at least 0.5). The key is read from the env var named by
`key_env` (the dsh add-on asks dsh's credentials service for exactly that name; Pi and other harnesses do not pass their
own logins). The key is never logged, written to Jills state or run records, or sent to agents. No key, an HTTP error
or a network error → **no suggestion** and a short reason ("Jev unavailable: TYPESAFE_API_KEY not set", "... HTTP 429",
"... timeout"). **Jev is required for suggestions: there is no keyword fallback.** The Claude Code mod and the Pi add-on show the
reason once per session. `jills go <jill>`, `jills start` and the MCP `start_jill` tool still work without Jev. Core reads only
`auto`, `jill_paths`, `jev.threshold`, `plugins`, `backend`, `executor` and `default_timeout`; every other key belongs to a
plug-in (`agent_*`, `tiers`, `default_model` to the agent runner, the rest of `jev:` to the Jev matcher).

## JILL.md

```yaml
---
name: fix-bug
description: Research a bug, fix it on a Jills branch, then get an independent review.
when: The user reports a bug and wants it fixed.     # Jev matches on this
inputs:
  - name: task
    required: true
worktree: true        # strongly recommended (default): run on branch jills/<name>-<run> in $JILLS_HOME/worktrees/
                      # worktree: false = no worktree: edits your checkout directly (jills check warns)
# box: docker         # optional isolation extension (docker | openshell | <name>); refused unless a
                      # matching isolation plug-in is listed in config plugins:. Nested Jills may not
                      # set a different box than the outermost one.
machine: local        # v1 refuses anything else
timeout: 90m          # whole run; over → stuck
steps:
  research: { jill: research, inputs: { task: "Find the cause: {{inputs.task}}" } }
  implement: { agent: harness-implementer, needs: [research], writes: true, task: "Fix: {{inputs.task}}\n{{steps.research.output}}" }
  review: { agent: harness-reviewer, needs: [implement], timeout: 20m }
---
```

Step fields: exactly one of `agent: <name>`, `run: <shell>`, `jill: <name>`; plus `task`, `needs`,
`copies` (1–16 parallel copies), `writes`, `model`, `timeout`, `inputs` (for nested Jills),
`on_fail` (see [Loops](#loops)), `verdict: true`, `merges: true` (see [Merging](#merging)).
Unknown fields pass through to plug-ins.

Checks are explicit steps: Jills never tests a writing step on its own. After each `writes: true`
step, add a step that needs it and checks the work: a `run:` test command (with `on_fail` back to the
writer), a reviewer with `verdict: true`, or a step with `checks: [...]`. `jills check` warns about
every writing step that no later step tests or reviews (a warning, not an error).

Templates: `{{inputs.x}}`, `{{task}}`, `{{copy}}`, `{{run_id}}`, `{{steps.<name>.output}}`,
`{{round}}`, `{{feedback}}`.
In `run:` commands no value is ever pasted into the shell text: each placeholder becomes an env
var reference (`"${JILLS_INPUT_X}"`, `"${JILLS_TASK}"`, `"${JILLS_COPY}"`,
`"${JILLS_STEP_OUT_<NAME>}"`, `"${JILLS_ROUND}"`, `"${JILLS_FEEDBACK}"`), quoted to fit where it sits, so placeholders work outside quotes,
inside `"double"` or `'single'` quotes and inside `$( )`, and inputs, chat text or agent output
cannot inject commands. Placeholders inside backticks are refused (use `$( )`). Steps also get env
vars `JILLS_RUN_ID`, `JILLS_STEP`, `JILLS_WORKSPACE`, `JILLS_COPY`, `JILLS_INPUT_<NAME>`.

### Agent steps

Agent files are markdown with front matter `name`, `description`, `tools`, `model`, `tier`; the
body is the instructions. Model = `step.model ?? agent.model ?? tiers[agent.tier] ?? default_model`.

- pi: `pi -p --model M --append-system-prompt <instructions file> --tools read,grep -- "<task>"`
- claude: see "Claude Code runner" below. Other agent CLIs (Codex) are v2 runner plug-ins.
  `jills check` asks each runner to describe every step, so an unknown agent is an error before anything runs.

### Claude Code runner

`src/plugins/runner-claude.ts` runs an agent step on Claude Code when the step's CLI is `claude`:
step `cli: claude`, else the agent file's `cli:`, else config `agent_cli`. It needs `claude`
installed and logged in; it uses your Claude plan through claude's own login (Jills passes no
credentials and never reads `~/.claude`). It runs
`claude -p --model M --append-system-prompt-file <instructions file> --permission-mode P --tools T --allowedTools A --strict-mcp-config --setting-sources "" --input-format text --output-format text`
with the task on stdin. `--setting-sources ""` and `--strict-mcp-config` keep your user, project and
local settings (allow rules, hooks) and MCP servers out of the run.

- Model: `step.model ?? agent.model ?? tiers[tier] ?? claude_default_model` (default
  `claude-opus-5-5`); a leading `anthropic/` is dropped.
- Tools: agent `tools:` map read→Read, grep→Grep, find/ls→Glob, write→Write, edit→Edit, bash→Bash
  (no `tools:` = read, grep, find, ls, plus write, edit for writers). Another name is a `jills check` error.
- Permissions: a `writes: true` step gets `acceptEdits`; any other step gets no Write/Edit tools at all
  and the ask-first mode (`manual`). Never `bypassPermissions`. In print mode an action nobody approved
  is denied, so a step must pre-approve what it needs in `--allowedTools`: the agent file's
  `claude_tools:` (verbatim), else for writer steps config `claude_tools` (example above), else the
  mapped tools without Bash. Bash is available only when `tools:` lists `bash`.
- A step without `writes: true` may approve only tools it has, and never Write, Edit, MultiEdit,
  NotebookEdit or any Bash entry. Every `claude_tools` entry is exactly one tool: `Tool` or `Tool(rule)`
  (spaces allowed in the rule; no commas, tabs, newlines or parentheses), or for writer steps an
  `mcp__server__tool` name; each is passed as its own argv value. A model or entry starting with `-` is refused.
  Both are `jills check` errors, and the step refuses to start.

### How a run works

- Steps whose `needs` are done start in parallel; `copies: N` starts N instances.
- `jill:` steps run inline in the same run and worktree. No self or indirect recursion; depth ≤ 4.
- Only the runner (the process that spawned the steps) signals them: per-step and total timeouts
  stop the step's process group (SIGTERM, then SIGKILL after a grace) and the run becomes `stuck`.
  Once a step's leader exits and is reaped, its pid (the group id) may be reused, so the runner
  signals that group only while a member (`/proc/<pid>/stat` pgrp) still carries `JILLS_RUN_ID=<run>`.
  Every run has a total limit: the Jill's `timeout`, else config `default_timeout`, else 2h. A value
  of 0 or less falls through to the next one; values above 2^31-1 ms (about 24.8 days) are clamped.
- Observers (`jills status`, `jills wait`, the Pi and dsh watchers) never signal anything. The
  runner writes a heartbeat every 5 s to its own file (`runs/<id>/heartbeat.json`, which no
  observer writes): wall time, `process.hrtime.bigint()` (one monotonic clock
  for every process on a boot; it does not advance during suspend) and the boot id. An observer marks
  a running record `stuck` when the runner is gone (its pid no longer exists, or another boot), or
  when the wall-clock deadline has passed and either the runner's own monotonic time is past the
  limit or its stamp stopped advancing on the observer's own clock. A suspend or clock jump alone
  never makes a live run stuck. A heartbeat never writes the run record; on each beat the runner
  reads the record, and when an observer marked it stuck it stops its own steps and keeps that mark.
- `jills stop <run>` stops a run's processes: the runner and every step process carry
  `JILLS_RUN_ID=<run>` in their environment. Stop scans `/proc/*/environ` for that tag (same boot
  only, by boot id), sends SIGTERM, then SIGKILL to what is still tagged. Nothing else is signaled.
- Git stays outside agents: Jills commits after each `writes: true` step.
- Writers that can run at the same time get child worktrees branched from the run branch, merged
  back with `git merge-tree --write-tree` + `commit-tree` + compare-and-swap `update-ref`. A conflict
  sets the run to `needs-you`, lists the files and leaves the run branch untouched.
- Jills never merges into your branch unless a step declares `merges: true` ([Merging](#merging)).
  Worktrees are kept until you delete them.
- `worktree: false` runs in the repo folder itself and never commits (no worktree: edits your checkout
  directly; `jills check` warns and suggestions say so).
- Run states: `queued`, `running`, `done`, `failed`, `stuck`, `needs-you`.

### Loops

A step can send work back to an earlier step when it fails (a back-arrow):

```yaml
review:
  agent: harness-reviewer
  needs: [build]
  verdict: true                              # fail unless the last VERDICT: line says clean
  on_fail: { back_to: build, max_rounds: 3 } # max_rounds: default 3, at most 10
```

- On a real failure of `review` (non-zero exit or a failed check), the runner reruns `build` and
  every step that needs it, directly or not, inside the same Jill (nested Jills loop inside their
  own steps). After `max_rounds` rounds in all the run ends `needs-you` ("review failed 3 rounds").
- `back_to` must name a step the failing step needs, directly or not; anything else is a parse error.
- Rerun steps get `{{round}}` (1-based) and `{{feedback}}`: the last 8,000 characters of the failed
  step's output (empty in round 1).
- Every round stays in the run record: `build`, `build@2`, `build@3`, ... (`jills status` lists
  them, each with its log).
- A step that the loop resets while it is still running (a sibling that also needs `back_to`, or
  any step inside such a nested Jill) is stale: Jills stops it like a timeout (SIGTERM, then
  SIGKILL to its process group) and waits for it to exit. Its result is dropped (record state
  `skipped`, even if it failed), its writes are never committed, a stale writer's child worktree is
  never merged back, and when a stale step ran in the shared run worktree Jills resets that
  worktree to its last commit (`git reset --hard` + `git clean -fd`, in the run worktree only)
  before `back_to` starts. Then it runs again in the new round. A step inside a nested Jill that
  goes stale this way is recorded `skipped` too; it never counts as a failure and never takes its
  own `on_fail`.
- Timeouts, `jills stop` and a stopped run never loop; they end the run as before. A step without
  `on_fail` still stops the run at its first failure.
- `verdict: true` (built-in `verdict` check, runs for every step): the step fails unless the last
  line containing `VERDICT:` in its output says `VERDICT: clean` (case-insensitive; a missing line
  fails). Tell the reviewer to end with that line.

### Merging

Only a step with `merges: true` may merge. It must be the single final step of the outermost Jill
(every other step comes before it), an `agent:` or `run:` step without `copies` or `writes: true`,
in a Jill with `worktree: true`; anything else is a parse error, and a nested Jill with a merge
step is refused. `jills check` notes such a step; the Pi and dsh suggestion says "merges into <branch>
when done". The run records the branch your checkout was on when the run started (`base` in the run
record). Example: [`examples/fix-jill-bug`](examples/fix-jill-bug/JILL.md) with the
[`squash-merge`](examples/agents/squash-merge.md) agent.

- Before the step runs, Jills commits pending worktree changes, then checks your checkout. When it
  has uncommitted changes to tracked files, is on another branch, or has untracked files that the
  run adds (the merge would overwrite them; they are named), the step does not run and the run
  ends `needs-you`. Jills also checks for conflicts with `git merge-tree --write-tree <base tip>
  <run commit>`: when your branch moved since the run started and conflicts with the run branch,
  the step does not run and the run ends `needs-you` with the files named ("main changed since the
  run started and conflicts with <run branch> in: a.js, b.js; nothing was merged. Merge it yourself
  or rerun the Jill on the new main."). Jills never resolves or commits a merge conflict. None of
  these is a step failure: no back-arrow. Jills records the base tip, the run commit, your branches
  and tags, and your untracked files at this point. Git-ignored files in your checkout are not
  checked.
- Only this step gets `JILLS_BASE_REPO` (your checkout), `JILLS_BASE_BRANCH` (the branch the run
  started from) and `JILLS_RUN_BRANCH`. The runner removes them from its own environment, so no
  other step sees them.
- The procedure is mechanical; the step never edits the run branch (the `squash-merge` agent does
  exactly this):

  ```bash
  cd "$JILLS_BASE_REPO"
  git merge --squash "$JILLS_RUN_BRANCH" && git commit -m "<one-line subject>"
  # any failure: git reset --merge (leaves the checkout clean), exit non-zero
  ```

- Afterwards Jills judges the result itself (core calls the worktree plug-in's `mergeCheck`); it
  never trusts the agent. The merge counts only when the run branch, your other branches and tags
  and your untracked files are unchanged, your checkout is
  clean, on `JILLS_BASE_BRANCH` at its new tip, and that branch gained exactly one new commit on its
  old tip whose tree equals `git merge-tree --write-tree <old tip> <run commit>` (the run tree when
  your branch had not moved), or when there was nothing to merge (the step then says "nothing to
  merge", not "merged").
- The step fails and may take its back-arrow only while everything is untouched (non-zero exit,
  or nothing merged). `back_to` reruns as for any step, with the step's output as `{{feedback}}`;
  Jills never merges your branch into the run branch.
- In any other case (run branch, other branches, tags or untracked files changed, checkout dirty or
  elsewhere, two commits, a different tree, a failure after merging) the run ends `needs-you` with
  no loop: check your branch by hand. When the run also times out or stops, its error still starts
  with what the merge step did ("merge step: merged into main; ..." or the reason).
- Records: `$JILLS_HOME/runs/<id>.json` (atomic writes) and per-step logs in `$JILLS_HOME/runs/<id>/`.
- No background service: `jills start` spawns a detached runner process and exits.

## CLI

```
jills list | check
jills suggest --session <id> [--repo p] [--json] "<message>"   # recent turns as JSON on stdin (optional)
jills start <jill> [--input k=v]... [--repo p] [--session id] [--json] [--wait]
jills go --session <id> [jill] [--input k=v] # start the last suggestion with the inputs Jev proposed
jills wait <run> [--timeout 30m]            # one-line result: state, branch, worktree, logs
jills status [run]                          # never signals; a hung or dead runner shows as stuck
jills stop <run>                            # SIGTERM/SIGKILL only processes with JILLS_RUN_ID=<run>
jills try <jill> --dry-run [--input k=v]    # without --dry-run: run in the foreground
jills dismiss|quiet|on --session <id>       # on --unmute also clears repo mutes
jills never [--session id] [--jill name] [--repo p]
jills auto on|off
jills new <name>                            # copies examples/JILL.template.md
jills mcp
jills engine <run>                         # internal: executors run/resume the engine directly
```

Exit codes: 0 ok / done / suggestion, 1 error or refusal, 2 usage, 3 no suggestion,
4 run failed, 5 run stuck, 6 run needs you, 7 wait timed out.

## Anti-nag rules (default `suggest` plug-in, per chat in `$JILLS_HOME/sessions/<id>.json`)

- Suggest only when Jev routes the message to a Jill (`new`) with probability ≥ threshold.
- Dismissed ("Not this") → quiet for the rest of this chat.
- A Jill running in this chat → quiet until it ends.
- An ignored suggestion → wait for a new task: the ignored Jill (and any Jill already suggested in
  this chat) stays quiet for the same task (a rewording or continuation, judged by Jev's `same` probability) and comes back for a new task
  (`same` below 0.2) or a different Jill.
- Never → muted for this repo (one Jill, or all) in `$JILLS_HOME/muted.json`.
- `/jills quiet` → quiet mode for this chat.
- At most one suggestion per 3 messages.
- Jev may only fill inputs the Jill declares; core drops any other key (such as `repo`), for Jev
  and plug-in matches, for any `suggest` plug-in's answer and for `jills go`.
- The last suggestion's inputs are saved in the session state; `jills go` (and `/jills go`) uses
  them, with `--input` overriding single values.

## Write a plug-in

A plug-in is one ESM file whose default export is one object `{ slot, apiVersion: 1, name, ...methods }`
(types: `src/plugins/types.ts`, interface version 1). List it under `plugins:` in config.yml; no core
edit is needed. Core refuses an unknown `apiVersion` or slot. Plug-ins read their own config keys from
`config.raw`, and unknown `JILL.md` fields reach them as `jill.extra` / `step.extra`.

```ts
// matcher: tried in order (config plug-ins first); return undefined to let the next one answer.
{ slot: "matcher", match(input: { message; recent: Turn[]; jills: JillSummary[]; already: string[]; config }): Promise<MatchResult | undefined> }
// runner: the first whose canRun(step, config, ctx) is true runs the step; describe() serves dry runs and `jills check`.
{ slot: "runner", canRun(step, config?, ctx?: RunnerSelectContext): boolean; describe(ctx): string; run(ctx: StepRunContext): Promise<StepRunResult>; check?(config): { errors; warnings } }
// isolation: picked by `box: <name>` (default "worktree"); child/mergeBack serve parallel writers.
{ slot: "isolation", prepare({ repo, jill, runId, config }): Promise<Workspace>; child(parent, { key, runId, config }); mergeBack(parent, child, msg): Promise<MergeResult>; commit(ws, msg); parallel?(jill, lookup): Set<string> /* steps that get a child workspace */; mergeStart?(ws, base); mergeCheck?(ws, base, start) /* merges: true */; retry?(ws, { discard }) /* before a back-arrow: drop stale writes */ }
// check: named in a step's `checks: [...]` (exit-code, then verdict, always run first).
{ slot: "check", check({ step, result, logPath }): Promise<{ ok: boolean; reason?: string }> }
// hook: sees every run event (started, step-started, step-done, finished, failed, stuck, needs-you); errors are ignored.
{ slot: "hook", on(event: RunEvent, record: RunRecord, config: JillsConfig): void | Promise<void> }
// suggest: the chat policy around the matchers (the last one loaded wins). ctx.match asks the matchers;
// core keeps only declared inputs. chat() applies dismiss/quiet/on/never/started and reads "last".
{ slot: "suggest", suggest(input: { session; message; recent; repo? }, ctx: { jills; config; match }): Promise<Suggestion>; chat(session, change: ChatChange, config): LastSuggestion | undefined }
```

Runner selection receives an optional third argument, `RunnerSelectContext`: `jill` owns the step,
and `box` is the run's actual box (`undefined` means no box). Nested steps receive their child Jill
and the outermost run's box, including in dry runs and `jills check`. Existing one-argument runners
still work. To claim only OpenShell steps, a runner can use:

```ts
canRun(step, config, ctx) {
  return ctx?.box === "openshell";
}
```

The `backend` slot stores run records and heartbeats through synchronous `save`, `load`, `list`, `beat`, and `loadBeat` methods.
Set `backend: <name>` in config to select one; unset uses built-in `json` (existing run files work unchanged).
Optional `sweep(home, config)` runs once after plug-ins load (never signals processes); `check(config)` adds diagnostics.
Logs remain plain files in `RunRecord.logDir`. The library's `status()` is now async so it can load configured ESM backends.

The independent `executor` slot drives a whole run: set `executor: <name>` alongside its `plugins:` path.
Its `execute(run, { config, cli, signal })` must await completion without writing the record; `check(config)` is optional.
Unset keeps the in-process detached engine. Storage (`backend: json`, sqlite, etc.) is independent of execution.
Executors invoke `node <cli> engine <id>`: queued runs start; running/stuck/failed runs resume only after their engine is gone.
Resume keeps the run id, workspace/branch and completed steps' log outputs, restarting unfinished steps at round 1.
A missing workspace, a live engine or a done run is refused. The detached supervisor keeps heartbeating across retries;
`jills stop` aborts its executor signal. Unfinished steps can repeat side effects: make them retry-safe.

Built-ins: matcher `jev` (the only default matcher; no fallback); runner `command` and `agent`; isolation `worktree`;
check `exit-code` and `verdict`; suggest `default` (the anti-nag rules above). Example: [`examples/plugins/notify.ts`](examples/plugins/notify.ts) appends each
finished run's one-line result to a file:

```yaml
plugins: [/path/to/jills/dist/examples/plugins/notify.js]   # pnpm build compiles examples/
notify: {file: ~/jills-done.txt}
```

Docker and OpenShell boxes are optional isolation plug-ins (none ship with core): a Jill opts in with
`box: docker`, and `jills check` / start refuse it, naming the missing extension, until a matching
isolation plug-in is listed under `plugins:`. Remote machines (`ssh`) come later (v2), the same way.

## Develop

```bash
pnpm build && pnpm test      # v1 gate: core + add-on tests (pi, dsh unit); no network; temp JILLS_HOME
pnpm test:core               # core only
pnpm test:v2                 # the v2 claude-code add-on (not part of pnpm test)
pnpm e2e                     # jills start hello in a temp repo → wait → branch with commits
pnpm smoke:dsh               # isolated real dsh + browser (not part of pnpm test)
```

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
