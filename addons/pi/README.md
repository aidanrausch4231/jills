# Jills add-on for Pi

One extension file, `jills.ts`, for Pi 1.0.4 (`@earendil-works/pi-coding-agent`).
It holds no Jills logic; it calls the Jills library (`dist/src/index.js`).

## What it does

| Pi hook | Jills action |
|---|---|
| `input` event (each typed message; `/…`, `!…` and extension input are skipped) | Starts core `suggest()` for chat session `pi-<session id>` with the last 3 turns, without holding the message. |
| `before_agent_start` | Waits up to 4 s for that check. If Jev suggests a Jill, adds a hidden `jills` message with the agent context. |
| Manual mode (`auto: false`) | Shows the suggestion in a widget above the editor plus a notice: `/jills go · /jills dismiss · /jills never · /jills quiet`. The agent is told to ask you and not start it. |
| Auto mode (`auto: true`) | The extension starts the Jill itself (`start()`), and the agent is told the run id and not to start it again. |
| After any start | Footer status `Jills: <jill> running (<run>)`; polls the run record every 2 s; when the run ends, posts the one-line result (state, branch, worktree, logs) in the chat and as a notice. Nothing merges itself. |
| Message delivery | Every Jills chat message uses `pi.sendMessage(..., { triggerTurn: false })` (Pi 1.0.4): while the agent streams it is held and appended when the current turn ends (never `steer`); when idle it is appended at once. It never starts or interrupts a turn; the agent reads it on its next turn. |

## Commands

```
/jills go [jill] [key=value ...]   start the last suggested Jill with the inputs Jev proposed (saved in
                                   the Jills session state, so they survive a reload) or a named one
/jills dismiss                     no more suggestions in this chat
/jills never [jill]                mute this Jill (default: the last suggested) for this repo
/jills quiet | /jills on [--unmute] quiet mode on / off for this chat
/jills status [run]                one run, or the 5 most recent
/jills list                        saved Jills
/jills auto on|off                 the global auto switch
```

## Install

1. Build the core once (the extension loads `../../dist/src/index.js` next to itself):

   ```bash
   cd /home/rausch/harness/v4/personal/jills
   pnpm install && pnpm build
   ```

2. Add the file to Pi by path, so it stays next to the core. Do not copy it.
   Put this in `~/.pi/agent/settings.json` (keep any entries already there):

   ```json
   { "extensions": ["/home/rausch/harness/v4/personal/jills/addons/pi/jills.ts"] }
   ```

   Or load it for one session: `pi -e /home/rausch/harness/v4/personal/jills/addons/pi/jills.ts`.
   If you do copy the file elsewhere, set `JILLS_LIB=/home/rausch/harness/v4/personal/jills/dist/src/index.js`.

3. Jev is TypeSafe System One. Export `TYPESAFE_API_KEY` (or the env var named by `jev.key_env`) in the shell that
   starts Pi. The add-on never passes Pi's own provider logins (such as OpenRouter) on to TypeSafe. Without a key there is no suggestion: Pi shows
   "Jev unavailable: ..." once per session. The key is never logged or stored, and Jills never reads Pi's credential files.

Jills state lives in `~/.jills` (or `$JILLS_HOME`). Run `jills check` to validate your Jills.

## Check

```bash
cd /home/rausch/harness/v4/personal/jills
pnpm build                       # the real-core test needs dist/
pnpm --dir addons/pi typecheck   # tsc against the installed Pi 1.0.4 types
pnpm --dir addons/pi test        # node:test with type stripping; temp JILLS_HOME, no network
```

The type check maps `@earendil-works/pi-coding-agent` to the global install under
`/home/rausch/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/` (see `tsconfig.json`).
Change that path if Pi lives elsewhere.

Smoke in real Pi without a model call (temp `JILLS_HOME`, RPC mode):

```bash
H=$(mktemp -d); mkdir -p $H/jills $H/agents; echo "agent_paths: [$H/agents]" > $H/config.yml
cp -r examples/hello $H/jills/
(echo '{"id":"1","type":"prompt","message":"/jills list"}'; sleep 3) |
  JILLS_HOME=$H timeout 20 pi -ne -e $PWD/addons/pi/jills.ts --no-session --no-mcp --mode rpc
# → an extension_ui_request notify line: "hello: Write a hello file ..."
```
