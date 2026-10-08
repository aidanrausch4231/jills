# AGENTS.md — Jills

Read this first. It applies to every agent (human or AI) changing this repo.

## What Jills is

**Jills = Jev skills.** A skill tells one agent how to behave; a Jill is a saved
**agent-team workflow** that runs as a separate, isolated job.

- **Jev** quietly reads each chat message (in Pi, DeepSeek Harness, later Claude Code
  and Codex). When a message is a *new task* that fits a saved Jill, it suggests it.
  Nothing runs until the user presses Start, unless auto mode is on, in which case the
  add-on starts it and tells the main agent.
- A **Jill** is a `JILL.md` file: name, `when` (when to use it), inputs, and steps.
  A step is an existing **agent file** (e.g. `agent: harness-reviewer`), a shell
  command (`run:`), or **another Jill** (`jill:`). Small Jills nest into bigger ones.
- A **run** gets one git worktree (on by default, strongly recommended). The outermost
  Jill decides worktree, box and machine; nested Jills share them. Parallel writing
  steps get child worktrees merged back; conflicts stop at "needs you". Jills never
  merges into the user's branch.
- The main agent is told when a Jill starts and is woken with the result (`jills wait`).

## The goal: simple and extendable, like Pi

Pi stays small because its core is tiny and almost everything is an extension.
Jills follows the same rules:

1. **Tiny core.** The core only loads Jills and agents, schedules steps, keeps run
   records, guards safety, and fires events. It knows no harness, model, box or cloud.
2. **Everything else is a plug-in or add-on.** New features go in a plug-in slot
   (`matcher`, `runner`, `isolation`, `check`, `hook`, `suggest`; remote places later, v2) or an add-on (one per harness),
   never in the core. The defaults are plug-ins too, so replacing one is never a hack.
3. **One file, one job.** A plug-in is a single file behind the versioned interface in
   `src/plugins/types.ts`. Add it to `plugins:` in config; no core edit needed.
4. **Unknown `JILL.md` fields pass through** so plug-ins can add their own settings.
5. **Size budgets** (enforced by `test/size.test.ts`): core ≤ 1,500 lines (excluding tests and
   plug-ins); each plug-in ≤ ~150 lines; each add-on as small as its harness allows
   (Pi ≤ 400). If a change pushes past a budget, simplify or move it to a plug-in.
6. **No new runtime dependencies without a written reason.**
7. **No background service.** Each CLI call runs and exits; only the run itself is detached.

## Layout

- `src/` — core library and CLI (`jills ...`).
- `src/plugins/` — built-in plug-ins (Jev and keyword matchers, command and agent
  runners, worktree isolation, exit-code check, default suggest/anti-nag) and the plug-in interface.
- `addons/` — one folder per harness: `mcp/` (any MCP client, served by `jills mcp`), `pi/`,
  `dsh/` (v1); `claude-code/` (v2).
- `examples/` — example Jills.
- `test/` — tests; add-on tests live in each add-on.

## Safety rules (never remove when simplifying)

- Values from chat, inputs or agent output never reach a shell as code.
- Jev may only fill inputs the Jill declares.
- Stopping or timing out a run stops every process it started, and never signals an
  unrelated process.
- Worktree off → Jills never commits. Nothing merges into the user's branch.
- Credentials: read only from the harness's own credential API or the env var named in config;
  never log them; never read credential files.
- `box:` (docker, openshell, ...) and remote machines are add-ons; without the add-on a
  Jill that asks for one is refused clearly.

## Checks before you finish

```sh
pnpm build
pnpm test        # core + add-on tests; run 3x for engine changes
pnpm e2e         # hello Jill end to end in a temp repo
pnpm smoke:dsh   # DeepSeek Harness card, isolated DSH_HOME (when touching addons/dsh)
```

Tests always use a temporary `JILLS_HOME` / `DSH_HOME`; never touch the real
`~/.jills`, `~/.pi`, `~/.dsh` or `~/.claude`.

## Version scope

- **v1:** core, CLI, MCP, Pi and DeepSeek Harness add-ons, worktree isolation.
- **v2 (later, all optional add-ons):** Claude Code, Codex, docker and OpenShell boxes,
  ssh machines, goal mode, reviewer check, saving repeated chat as a Jill.
  Build only what real use of v1 shows is needed.
