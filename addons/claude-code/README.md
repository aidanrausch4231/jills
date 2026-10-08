# Jills add-on for Claude Code (v2)

> **v2 — not part of the v1 install.** Jills v1 targets Pi and DeepSeek Harness. This add-on's code
> and tests stay here (and still run in the root `pnpm test`), but do not install it for v1.

Three pieces, none with Jills logic of its own:

| File | What it does |
|---|---|
| `hook.mjs` | `UserPromptSubmit` hook. Sends each new prompt (plus the last 3 transcript turns) to the core `suggest`. On a suggestion it prints the documented hook JSON: `systemMessage` (shown to you) and `hookSpecificOutput.additionalContext` (added to Claude's context). Otherwise it prints nothing. It never blocks a prompt. It gives up only after the Jev request timeout (`jev.timeout_ms`, default 8 s) plus 3 s, so a slow Jev ends in Jev's own timeout and the keywords fallback. |
| `commands/jills.md` | `/jills go \| dismiss \| never \| quiet \| on \| status \| list \| auto on\|off`. Claude runs the matching `jills` CLI command with the chat's `${CLAUDE_SESSION_ID}`; after `go` it runs `jills wait <run>` in the background and reports the result. |
| `settings.snippet.json` | The hook entry to merge into `~/.claude/settings.json`. |

Hook contract (checked against code.claude.com/docs/en/hooks, Claude Code 2.1.294): input on stdin
has `session_id`, `prompt`, `cwd`, `transcript_path`; exit 0 with JSON
`{"systemMessage": ..., "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ...}}`.
The hook skips prompts that start with `/` or `!`.

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
4. Merge `settings.snippet.json` into `~/.claude/settings.json` (add the entry to any existing
   `hooks.UserPromptSubmit` list; do not replace other hooks).
5. Install the slash command:
   `mkdir -p ~/.claude/commands && cp commands/jills.md ~/.claude/commands/jills.md`
6. For Jev itself, export the key named by `jev.key_env` (default `OPENROUTER_API_KEY`) in the shell that
   starts Claude Code. Without it the hook uses the `keywords:` fallback.

Env knobs: `JILLS_HOME` (default `~/.jills`), `JILLS_LIB` (core entry, default `../../dist/src/index.js`),
`JILLS_HOOK_TIMEOUT_MS` (can only raise the give-up time above `jev.timeout_ms` + 3000; keep the hook `timeout` in
`settings.snippet.json`, 15 s, above it when you raise `jev.timeout_ms`), `JILLS_HOOK_DEBUG=1` (quiet reasons and errors on stderr).

## Test

`node --test 'addons/claude-code/test/*.test.mjs'` (after `pnpm build`). Tests use a temp `JILLS_HOME`, no network,
and cover: no match, manual suggestion, auto mode, quiet mode, slash prompts, bad input, transcript turns,
the give-up time staying above the Jev timeout (with a slow local mock Jev). Root `pnpm test` runs them too.
