# Jills add-ons

One small add-on per harness. Each one calls the Jills library (`import { suggest, start, wait, status } from "jills"`)
or the `jills` CLI / MCP server; none of them holds Jills logic of its own.

| Folder         | Harness             | Status |
|----------------|---------------------|--------|
| `pi/`          | Pi 1.0.4            | v1: one extension file (`jills.ts`) |
| `dsh/`         | DeepSeek Harness    | v1: dsh plugin with suggestion card + status line |
| `claude-code/` | Claude Code         | **v2, not part of the v1 install**: UserPromptSubmit hook + `/jills` slash command (code and tests kept) |

v1 targets Pi and DeepSeek Harness only. The Claude Code add-on stays in the repo and its tests
still run, but v1 install steps do not set it up.

Root `pnpm test` runs every add-on's tests after the core tests (it builds the dsh add-on first and
type-checks the Pi extension). The dsh browser smoke runs separately: `pnpm smoke:dsh`.

Library API the add-ons use (see `src/index.ts`):

```ts
suggest({ session, message, recent?, repo?, cwd?, home? }): Promise<Suggestion>
start(jill, { inputs?, cwd?, session?, home? }): Promise<RunRecord>      // detached runner, returns at once
wait(runId, { timeoutMs?, pollMs?, onUpdate?, home? }): Promise<{ record, timedOut, line }>
status(runId?, { home? }): RunRecord | RunRecord[] | undefined
listJills({ home? }): Promise<JillSummary[]>
dismiss(session) / quiet(session) / on(session, { unmute? }) / never({ session?, jill?, repo? })
lastSuggestion(session): string | undefined                             // the Jill last suggested
lastSuggested(session): { jill, inputs } | undefined                    // ... with the inputs Jev proposed
go({ session, jill?, inputs?, cwd? }): Promise<{ record, inputs, dropped }>  // "/jills go": saved inputs + overrides
setAuto(on: boolean)
```

`Suggestion` carries `text` (show to the user) and `agentContext` (give to the main agent),
plus `auto` (the global switch). In manual mode the agent must ask the user; in auto mode it
starts the Jill (MCP `start_jill`) and runs `jills wait <id>` in the background.
