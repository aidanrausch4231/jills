# Jills add-on for DeepSeek Harness (dsh)

A dsh plugin package (`@jills/dsh`). After each typed user message in a chat, it asks Jev (through the
Jills library) whether a saved Jill fits. When one does, a card appears under the message:

```
Jev suggests a Jill                     jev · 93%
hello
Write a hello file in a fresh worktree; the smoke test for Jills.
[who Aidan]
[Start] [Edit] [Not this] [Never]
```

- **Start** starts the Jill as a detached Jills run. The card turns into a status line polled every 1.5 s
  (`Jill hello · running · 2/4 steps` → `… · done · branch jills/hello-…`); hover it for the full `jills wait` line. Nothing merges itself.
- **Edit** shows one field per declared input, filled with Jev's values; Start uses the edited values.
- **Not this** quiets Jev for the rest of the chat (`jills dismiss`); **Never** mutes that Jill for the session's git repo (`jills never`).
- Auto mode (`jills auto on`): the card starts the Jill at once and shows the status line.

## Layout

All Jills logic lives in the core library; this package only wires dsh to it. Every tracked file and why it exists:

| Path | Why |
|---|---|
| `src/index.ts` | Host service `jills` (`TypertRemoteService`) with Remote methods `suggest`, `start`, `status`, `dismiss`, `never`; reads turns and tells the agent through dsh's Session Controller |
| `src/bridge.ts` | Plain Node bridge to the Jills library (testable without dsh); one cached card per (session, message) so re-renders never ask Jev twice |
| `src/types.ts` | Wire types (`SuggestRequest`, `JillsCard`, `RunLine`, ...) shared by Host and card; Typert reads them |
| `src/client/index.tsx` | Browser entry: mounts the `jills` Remote, registers the chat node Definition and renderer |
| `src/client/model.ts` | Pure browser logic (node Definition on `user/message`, Remote face, dot state); unit-tested from `lib/client.js` |
| `src/client/Card.tsx` | The card and status line (React, dsh UI primitives) |
| `cordis.patch.yml` | Bundle patch: `dsh plugin add` activates the package and inserts the `jills` plugin |
| `package.json` | Package manifest: exports dsh loads (`lib/*`), dsh bundle/client metadata, dev links to a dsh checkout |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Standalone pnpm install (the add-on is not part of a dsh workspace) |
| `tsconfig.base.json` | Shared compiler settings |
| `tsconfig.json` | Host half: emits `lib/types` declarations (client excluded) |
| `tsconfig.client.json` | Browser half: type-check only, with DOM libs |
| `scripts/build.mjs` | tsc → Typert contracts → Host entry → browser bundle in dsh's closure-factory format |
| `scripts/contracts.mjs` | Runs dsh's own Typert generator on a staged copy (`.typert/`) to make `lib/typert.*` |
| `.gitignore` | Keeps `lib/`, `.typert/` and `node_modules/` out of git |
| `test/` | Bridge, client bundle and contract tests; `test/smoke/` is the isolated real-dsh browser smoke |

Messages older than 5 minutes (history reloads) and slash commands never reach Jev.

## Build and test

Needs Node 22.23+, pnpm, a built Jills core (`pnpm build` in the repo root) and a built clean dsh checkout at
`../../../switchboard/dsh-upstream` (the dev links point there, like Switchboard).

```sh
cd addons/dsh
pnpm install
pnpm build          # lib/index.js, lib/client.js, lib/typert.*
pnpm test           # bridge (real core, temp JILLS_HOME, mocked Jev), client bundle, contracts (root pnpm test runs these too)
pnpm smoke          # isolated real dsh + browser; writes ../../.work/shots/jills-dsh-*.png
```

The smoke uses a new temp `DSH_HOME`, `JILLS_HOME` and git repo, a local mock Jev server, a scripted model and a random port.
It needs `../../../switchboard/dsh-runtime` (or `DSH_RUNTIME`) and Playwright Chromium. It never touches `~/.dsh` or `~/.jills`.

## Install into a dsh profile

Use a separate profile; try it with an isolated `DSH_HOME` first.

```sh
cd /path/to/dsh                       # e.g. switchboard/dsh-runtime
pnpm dsh plugin --profile jills add /home/rausch/harness/v4/personal/jills/addons/dsh
pnpm dsh --profile jills --host 127.0.0.1 --port 0 --no-open
```

Configuration (all optional):

- `JILLS_HOME` — Jills home (default `~/.jills`); or plugin config `home`.
- `JILLS_LIB` — path to the Jills library `dist/src/index.js` (default: this repo's build); or plugin config `lib`.
- Jev uses the harness's OpenRouter login; the env var is a fallback. The Host asks dsh's own credentials service
  (`ctx.credentials`) for ref `OPENROUTER_API_KEY` (or the name in `jev.key_env`), then the Host's env var of that name.
  Without a key the keywords matcher answers. Jills never reads credential files and never logs the key.
- Plugin config `maxAgeMs` — how old a message may be and still be sent to Jev (default 300000).

Set plugin config with a profile patch, for example `- id: jills` / `config: { home: /path }`.

## Chat context and the main agent

- **Jev reads the last 3 turns.** For each card the Host reads the Session log with `sessionController.inspect`
  (never activates the Agent) and sends Jev the last 3 typed-user / assistant text turns before the message (`turnsBefore`).
- **The main agent is told when a Jill starts** (Start or auto mode). dsh has no hook that adds text to the current turn,
  so the Host queues a user-role `[Jills] Jill "x" started as run <id> ... Do not start it again` notice with
  `agent.inject(message)` (model-facing context for the next step, no wake-up), then flushes the Session. It never
  starts, steers or interrupts a turn; if the Agent cannot be reached the run still starts and the card says so.
- **No workspace folder, no run.** A chat without a working folder gets the card note "open a workspace folder first"
  for Start (and auto mode) and Never; Jills never falls back to the dsh Host's own folder.

## Limits (v1)

- The result is reported back by the card's status line, not by the agent.
- Cards are cached in Host memory; after a Host restart only messages newer than `maxAgeMs` are asked again.
