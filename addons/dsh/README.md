# Jills add-on for DeepSeek Harness (dsh)

A dsh plugin package (`@jills/dsh`). After each typed user message in a chat, it asks Jev
(through the Jills library) whether a saved Jill fits. When one does, a card appears under the
message:

```
Jev suggests a Jill                     jev · 93%
hello
Write a hello file in a fresh worktree; the smoke test for Jills.
[who Aidan]
[Start] [Edit] [Not this] [Never]
```

- **Start** starts the Jill as a detached Jills run. The card turns into a status line
  (`Jill hello · running · 2/4 steps` → `Jill hello · done · branch jills/hello-…`), polled every 1.5 s.
  Hover it for the full `jills wait` line (worktree, logs). Nothing merges itself.
- **Edit** shows one field per declared input, filled with Jev's values; Start uses the edited values.
- **Not this** quiets Jev for the rest of the chat (`jills dismiss`).
- **Never** mutes that Jill for the session's git repo (`jills never`).
- Auto mode (`jills auto on`): the card starts the Jill at once and shows the status line.

All Jills logic lives in the core library; this package only wires dsh to it.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Host service `jills` (`TypertRemoteService`) with Remote methods `suggest`, `start`, `status`, `dismiss`, `never` |
| `src/bridge.ts` | Plain Node bridge to the Jills library; one cached card per (session, message) so re-renders never ask Jev twice |
| `src/types.ts` | Wire types (`SuggestRequest`, `JillsCard`, `RunLine`, ...) |
| `src/client/` | Browser half: mounts the `jills` Remote, registers a chat node Definition on `user/message` events and the `conversation.chat.node` renderer `jills-suggestion` |
| `cordis.patch.yml` | Bundle patch: `dsh plugin add` activates the package and inserts the `jills` plugin |
| `scripts/build.mjs` | tsc → Typert contracts (`scripts/contracts.mjs`, dsh's own generator) → Host entry → wrapped browser bundle |

Messages older than 5 minutes (history reloads) and slash commands never reach Jev.

## Build and test

Needs Node 22.23+, pnpm, a built Jills core (`pnpm build` in the repo root) and a built clean dsh
checkout at `../../../switchboard/dsh-upstream` (the dev links point there, like Switchboard).

```sh
cd addons/dsh
pnpm install
pnpm build          # lib/index.js, lib/client.js, lib/typert.*
pnpm test           # bridge (real core, temp JILLS_HOME, mocked Jev), client bundle, contracts (root pnpm test runs these too)
pnpm smoke          # isolated real dsh + browser; writes ../../.work/shots/jills-dsh-*.png
```

The smoke uses a new temp `DSH_HOME` and `JILLS_HOME`, a temp git repo, a local mock Jev server, a
scripted model and a random port. It needs `../../../switchboard/dsh-runtime` (or `DSH_RUNTIME`)
and Playwright Chromium. It never touches `~/.dsh` or `~/.jills`.

## Install into a dsh profile

Use a separate profile; try it with an isolated `DSH_HOME` first.

```sh
cd /path/to/dsh                       # e.g. switchboard/dsh-runtime
pnpm dsh plugin --profile jills add /home/rausch/harness/v4/personal/jills/addons/dsh
pnpm dsh --profile jills --host 127.0.0.1 --port 0 --no-open
```

Configuration (all optional):

- `JILLS_HOME` — Jills home (default `~/.jills`); or plugin config `home`.
- `JILLS_LIB` — path to the Jills library `dist/src/index.js` (default: this repo's build, found
  relative to the installed package); or plugin config `lib`.
- `OPENROUTER_API_KEY` (or the env var named by `jev.key_env` in `config.yml`) in the dsh Host's
  environment enables Jev; without it the keywords matcher answers.
- Plugin config `maxAgeMs` — how old a message may be and still be sent to Jev (default 300000).

Set plugin config with a profile patch, for example `- id: jills` / `config: { home: /path }`.

## Chat context and the main agent

- **Jev reads the last 3 turns.** For each card the Host reads the Session log with dsh's Session
  Controller (`sessionController.inspect`, which never activates the Agent) and sends Jev the last 3
  typed-user / assistant text turns before the message (`turnsBefore` in `src/bridge.ts`).
- **The main agent is told when a Jill starts** (Start button or auto mode). dsh's plugin API has no
  hook that adds text to the current turn's prompt, so the closest supported mechanism is used:
  `sessionController.resolveAgent(session)` then `agent.inject(message)`, dsh's "queue model-facing
  context for the next step without waking the agent". The message is a user-role `jills` notice
  (`[Jills] Jill "x" started as run <id> ... the Jills card ... reports the result ... Do not start it
  again`); the Session is then flushed so it is durable. It never starts, steers or interrupts a
  turn: a running agent reads it at its next step, an idle one with the user's next message. If the
  Agent cannot be reached the run still starts and the card says "The agent was not told: ...".
- **No workspace folder, no run.** A chat without a working folder gets the card note "open a
  workspace folder first" for Start (and auto mode) and Never; Jills never falls back to the dsh
  Host's own folder.

## Limits (v1)

- The result is reported back by the card's status line, not by the agent.
- Cards are cached in Host memory; after a Host restart only messages newer than `maxAgeMs` are asked again.
