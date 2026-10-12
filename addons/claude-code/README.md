# Jills add-on for Claude Code (v2)

> **v2 — not part of the v1 install.** Jills v1 targets Pi and DeepSeek Harness. This add-on's code
> and tests stay here (run them with root `pnpm test:v2`; they are not in the v1 `pnpm test` gate), but do not install it for v1.

**In Claude Code ≥ 2.1.287 install the mod instead of the settings hook; keep the /jills command and MCP server.**
With both installed, every prompt gets two suggestions.

## Mod (`mod/jills/`, Claude Code ≥ 2.1.287)

A Claude Code mod (a plugin with a function-hooks module, early-access API). It calls only the `jills` CLI
(`$.process.run` with an argv, never a shell) and draws:

- **Suggestion card** above the prompt after each of your prompts (not `/`, `!` or `<...>` system events, and only
  prompts you typed): `Jill <name> · <description>`, the proposed inputs, warnings (no worktree, merges into a
  branch) and **Start** (`s`) / **Not this** (`n`) / **Never here** (`v`), which run `jills go`, `jills dismiss` and
  `jills never`. The letter keys work only while the card has the focus (ctrl+x tab or a click); there are no digit
  keys, because a digit typed into an empty prompt would press them. The next prompt removes the card.
  In auto mode the run starts without a card or pane: status row, toast and a line for Claude; `/jills-panel` shows it.
  When the Jill has a required input the suggestion left empty, the card says `needs: <names> — use /jills go name=value`
  and has no Start (auto mode then shows the card instead of starting). A start that fails keeps the card and shows
  `couldn't start <jill>: <error>` in the status row for 60 s, besides the toast.
- **Progress pane** `jills-run`, opened by Start: Jill, state, elapsed time, one row per step instance in start
  order (`build@2` shows as "build (round 2)", nested steps indented), merge result, error or needs-you reason,
  branch, and **Stop** / **Close**. `/jills-panel` reopens it for the latest run of this session.
- **Status row** `<jill> · <current step> · <done>/<seen> steps`, then the final word for 60 s. Claude Code shows it after the plugin name (`jills:`); the API has no style choice, so it keeps the engine's icon.
- **On end**: a toast `Jill <name> <state>` and the `jills wait` result line (plus the merge note) added to the
  chat for Claude.

It polls `jills status <run> --json` every 1.5 s while the pane is open and every 5 s while it is closed (the
status row and the end notice still need it), and stops when the run ends or after 5 failed `jills status` calls in
a row (toast "Jills: lost track of run <id>"). `<seen>` counts the step instances
the record has started; the record has no planned total.

Develop and check (from the repo root; nothing is installed):

```sh
claude --plugin-dir addons/claude-code/mod/jills      # try it in one session, hot reload on save
claude plugin validate addons/claude-code/mod/jills
node addons/claude-code/mod/typecheck.mjs              # tsc with the Claude Code API types
claude plugin test addons/claude-code/mod/jills        # tests/*.test.tsx, every jills call mocked
```

`pnpm test:mod` runs the three checks. The `jills` CLI must be on the PATH Claude Code starts with (Install step 2).

## Settings hook and slash command (clients without mods)

Three pieces, none with Jills logic of its own:

| File | What it does |
|---|---|
| `hook.mjs` | `UserPromptSubmit` hook. Sends each new prompt (plus the last 3 transcript turns) to the core `suggest`. On a suggestion it prints the documented hook JSON: `systemMessage` (shown to you) and `hookSpecificOutput.additionalContext` (added to Claude's context). Otherwise it prints nothing. It never blocks a prompt. It gives up only after the Jev request timeout (`jev.timeout_ms`, default 8 s) plus 3 s, so a slow Jev ends in Jev's own timeout (no suggestion). |
| `commands/jills.md` | `/jills go \| dismiss \| never \| quiet \| on \| status \| list \| auto on\|off`. Claude runs the matching `jills` CLI command with the chat's `${CLAUDE_SESSION_ID}`; after `go` it runs `jills wait <run>` in the background and reports the result. |
| `settings.snippet.json` | The hook entry to merge into `~/.claude/settings.json`. |

Hook contract (checked against code.claude.com/docs/en/hooks, Claude Code 2.1.294): input on stdin
has `session_id`, `prompt`, `cwd`, `transcript_path`; exit 0 with JSON
`{"systemMessage": ..., "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ...}}`.
The hook skips prompts that start with `/`, `!` or `<` (system events such as `<task-notification>`).

## Modes

- **Manual** (`auto: false`, default): you see `Jev: this looks like a job for Jill "x" ...`. Claude is told
  not to start it and to ask you. Type `/jills go` to start it; it uses the inputs Jev proposed (saved with the suggestion).
- **Auto** (`jills auto on`): Claude is told to start it with the `start_jill` MCP tool (session and repo
  included in its context), then run `jills wait <run>` with `run_in_background` and report the result.
  Nothing merges itself.
- `/jills dismiss` quiets this chat, `/jills quiet` pauses it until `/jills on`, `/jills never` mutes the
  Jill for this repo.

## Install

1. Build the core: `cd /home/rausch/harness/v4/personal/jills && pnpm install && pnpm build`.
2. Put the CLI on your PATH (the slash command and `jills wait` call `jills`):
   `ln -s /home/rausch/harness/v4/personal/jills/dist/src/cli.js ~/.local/bin/jills`
3. Add the MCP server (for `start_jill` in auto mode):
   `claude mcp add --scope user jills -- node /home/rausch/harness/v4/personal/jills/dist/src/cli.js mcp`
4. Claude Code ≥ 2.1.287: install the mod (`mod/jills/`) instead of this step. Older clients: merge
   `settings.snippet.json` into `~/.claude/settings.json` (add the entry to any existing
   `hooks.UserPromptSubmit` list; do not replace other hooks).
5. Install the slash command:
   `mkdir -p ~/.claude/commands && cp commands/jills.md ~/.claude/commands/jills.md`
6. For Jev itself, export the key named by `jev.key_env` (default `TYPESAFE_API_KEY`, a TypeSafe System One key) in the shell that
   starts Claude Code. Without it there is no suggestion (the mod shows "jills: Jev off — ..." once per session for 60 s).

Env knobs: `JILLS_HOME` (default `~/.jills`), `JILLS_LIB` (core entry, default `../../dist/src/index.js`),
`JILLS_HOOK_TIMEOUT_MS` (can only raise the give-up time above `jev.timeout_ms` + 3000; keep the hook `timeout` in
`settings.snippet.json`, 15 s, above it when you raise `jev.timeout_ms`), `JILLS_HOOK_DEBUG=1` (quiet reasons and errors on stderr).

## Test

`node --test 'addons/claude-code/test/*.test.mjs'` (after `pnpm build`). Tests use a temp `JILLS_HOME`, no network,
and cover: no match, manual suggestion, auto mode, quiet mode, slash, `!` and `<...>` prompts, bad input, transcript turns,
`jev.timeout_ms` read from the config, the give-up time staying above the Jev timeout (with a slow local mock Jev). Root `pnpm test:v2` runs them.
