---
name: jills-setup
description: Set up Jills for a user step by step - check Node, pnpm and git, build the CLI, create the Jills home and config.yml, add a starter Jill and its agents, optionally turn on Jev suggestions, install add-ons (Claude Code, Pi, dsh, MCP) and run backends, then verify with jills check and a tiny run. Use when the user asks to install, set up or configure Jills.
---

# Set up Jills

Work through the steps in order. Each step starts with its purpose. Skip optional steps the user
does not want, and note each skip for the final report.

**Ground rules**

- Ask before any change outside the Jills repo and the Jills home: PATH symlinks, `pnpm link`,
  `~/.claude`, `~/.pi`, dsh profiles. Before you edit a global client file, copy it to
  `<file>.bak-<date>`, show the diff and wait for a yes.
- Never write an API key into `config.yml` or any other file. Never echo, print or log a key.
  Only check whether a key is set.
- Run nothing that sends the user's data off the machine. Package installs and `git clone` only
  download. Jev requests start only when the user chats with an add-on installed and a key set.
- Paths below: `/path/to/jills` = the Jills checkout, `~/.jills` = the Jills home
  (`$JILLS_HOME` when set).

## 1. Check prerequisites

Purpose: confirm the tools Jills needs.

```bash
node -v      # need >= 22 (package.json "engines": ">=22")
pnpm -v      # any recent pnpm
git --version   # need >= 2.38 (Jills uses git merge-tree --write-tree)
```

If one is missing or too old, tell the user what to install and stop until it is fixed.
The SQLite backend (step 6) needs Node >= 22.13.

## 2. Get and build Jills

Purpose: build the `jills` CLI and put it on PATH.

1. Find an existing checkout (look for a `package.json` with `"name": "jills"`), or ask the user
   where to clone it: `git clone https://github.com/aidanrausch4231/jills /path/to/jills`.
2. Build:

   ```bash
   cd /path/to/jills
   pnpm install && pnpm build
   ```

3. Ask the user which way to put `jills` on PATH (a global change):

   | Option | Command | Note |
   |---|---|---|
   | Symlink (default) | `mkdir -p ~/.local/bin && ln -sf /path/to/jills/dist/src/cli.js ~/.local/bin/jills` | `~/.local/bin` must be on PATH |
   | pnpm link | `cd /path/to/jills && pnpm link --global` | needs pnpm's global bin dir on PATH; if `pnpm link --help` shows no `--global`, use the symlink |
   | None | use `node /path/to/jills/dist/src/cli.js` instead of `jills` | changes nothing global |

4. Check: `jills --help` prints the usage.

## 3. Create the Jills home, config and a starter Jill

Purpose: give Jills a home folder with core config, one Jill, and the agents it uses.

1. Create the folders (skip what exists; never overwrite an existing `config.yml` without asking):

   ```bash
   mkdir -p ~/.jills/jills ~/.jills/agents
   ```

2. Write `~/.jills/config.yml` with core keys only. Core reads `auto`, `jill_paths`, `plugins`,
   `default_timeout` and `jev.threshold`; every other key belongs to a plug-in.

   ```yaml
   auto: false                    # manual: suggestions ask first (jills auto on|off)
   jill_paths: [~/.jills/jills]   # default: $JILLS_HOME/jills
   # agent_paths: [~/.jills/agents]  # agent runner; default: $JILLS_HOME/agents
   # agent_cli: pi                   # pi (default) or claude
   # default_timeout: 2h
   ```

   Ask which agent CLI the user runs agents with: `pi` (default) or `claude` (Claude Code, uses
   its own login). Set `agent_cli` only when it is `claude`.

3. Copy the starter Jill. `hello` needs no agent and no network:

   ```bash
   cp -r /path/to/jills/examples/hello ~/.jills/jills/
   ```

   Copy single folders only. Do not run `cp -r examples/* ~/.jills/jills/`: that also copies
   `agents/`, `plugins/` and the template into the Jills folder.

4. Optional agent Jills. Show this table and let the user pick:

   | Example | Agents it needs | Also needs |
   |---|---|---|
   | `research` | `harness-explorer`, `harness-researcher` | - |
   | `fix-bug` | `harness-implementer`, `harness-reviewer` | the `research` Jill |
   | `fix-jill-bug` | `harness-implementer`, `harness-reviewer`, `squash-merge` | the `research` Jill; step `build` sets `cli: claude` |

   Say this plainly: **the repo does not ship the `harness-*` agents.** Only `squash-merge` ships
   (`cp /path/to/jills/examples/agents/squash-merge.md ~/.jills/agents/`). For each `harness-*`
   name, offer two choices:

   - **Map** to an agent the user already has: edit the copied `JILL.md` and change
     `agent: harness-explorer` to their agent's name, and add that agent's folder to `agent_paths`.
   - **Create** a simple agent file `~/.jills/agents/<name>.md`. Front matter: `name`,
     `description`, `tools`, optional `model`, `tier`, `cli`; the body is the instructions.

   ```markdown
   ---
   name: harness-explorer
   description: Read-only explorer that returns path:line evidence.
   tools: read,grep,find,ls
   ---
   Answer the task by reading the code. Do not edit files. Return exact path:line evidence.
   ```

   | Agent | `tools` | Body says |
   |---|---|---|
   | `harness-explorer` | `read,grep,find,ls` | read only, return path:line evidence |
   | `harness-researcher` | `read,grep,find,ls` | merge reports into one cited answer, say what is unknown |
   | `harness-implementer` | `read,grep,find,ls,write,edit,bash` | make the smallest fix, add a test, run tests, never commit |
   | `harness-reviewer` | `read,grep,find,ls,bash` | review the change, list defects with path:line, never edit; end with `VERDICT: clean` or `VERDICT: <list>` |

   Model: `step.model`, else the agent's `model`, else `tiers[tier]`, else config `default_model`
   (`claude_default_model` for Claude Code). For Claude Code steps, Bash also needs a
   `claude_tools:` allow list (see README "Claude Code runner").

5. Check: `jills list` shows the Jills, `jills check` prints `ok` (an unknown agent is an error).

## 4. Optional: Jev suggestions

Purpose: let Jev (TypeSafe System One) suggest a Jill from chat. Without it, `jills start`,
`jills try` and the MCP `start_jill` tool still work; there is no keyword fallback.

- Key: a TypeSafe API key in the env var named by `jev.key_env`, default **`TYPESAFE_API_KEY`**.
  For `api.typesafe.ai` the name must be `TYPESAFE_API_KEY`. Jev does not use `OPENROUTER_API_KEY`
  or any other provider key, and the add-ons never pass a harness's own logins to it.
- The key must come from the environment the harness starts with, or the dsh add-on's
  credentials service (it asks dsh for exactly that name). Tell the user to export it in their own
  shell profile or secret manager. Do not write it anywhere yourself.
- Check without showing it: `[ -n "$TYPESAFE_API_KEY" ] && echo set || echo missing`.
- Optional `jev:` keys in `config.yml` (no key value ever goes here):

  ```yaml
  jev:
    threshold: 0.5   # suggest only when P(route) >= threshold
  ```

## 5. Optional: add-ons

Purpose: connect Jills to the user's chat clients. Ask which ones. For every global file: ask,
back it up, show the diff.

| Add-on | Where | Status |
|---|---|---|
| MCP server | `addons/mcp/` | any MCP client; built by `pnpm build` |
| Pi extension | `addons/pi/` | v1 |
| dsh plugin | `addons/dsh/` | v1 |
| Claude Code mod, hook, `/jills` | `addons/claude-code/` | v2: works, not part of the v1 install |

**MCP server** (`jills mcp`, stdio; tools `list_jills`, `suggest_jill`, `start_jill`,
`jill_status`, `wait_for_jill`):

| Client | Command or file |
|---|---|
| Pi | `pi mcp add jills -- node /path/to/jills/dist/src/cli.js mcp` (writes `~/.pi/agent/mcp.json`) |
| Claude Code | `claude mcp add --scope user jills -- node /path/to/jills/dist/src/cli.js mcp` |
| dsh | add the same command as an MCP server in the dsh config |

**Pi extension**: add the file by path (do not copy it) to `~/.pi/agent/settings.json`, keeping
existing entries:

```json
{ "extensions": ["/path/to/jills/addons/pi/jills.ts"] }
```

Or try it for one session without a global change: `pi -e /path/to/jills/addons/pi/jills.ts`.

**dsh plugin**: build it first (needs a built dsh checkout, see `addons/dsh/README.md`), then
install into a separate profile:

```bash
cd /path/to/jills/addons/dsh && pnpm install && pnpm build
cd /path/to/dsh
pnpm dsh plugin --profile jills add /path/to/jills/addons/dsh
pnpm dsh --profile jills --host 127.0.0.1 --port 0 --no-open
```

**Claude Code** (v2). Pick one of mod or hook; with both, every prompt gets two suggestions.

| Piece | Command |
|---|---|
| Mod (Claude Code >= 2.1.287) | `claude plugin install jills --marketplace /path/to/jills`, or try it for one session: `claude --plugin-dir /path/to/jills/addons/claude-code/mod/jills` |
| Hook (older clients) | merge `addons/claude-code/settings.snippet.json` into `~/.claude/settings.json` (fix the `/path/to/jills` path; append to any existing `hooks.UserPromptSubmit` list) |
| `/jills` command | `mkdir -p ~/.claude/commands && cp /path/to/jills/addons/claude-code/commands/jills.md ~/.claude/commands/jills.md` |
| MCP server | see the MCP table above |

## 6. Optional: run backends

Purpose: store runs somewhere other than the default JSON files (storage backend), or
let Temporal drive runs so they resume after a crash (executor). The two combine.

| Plug-in | Slot | Needs |
|---|---|---|
| SQLite storage, `github.com/aidanrausch4231/jills-run-sqlite` | `backend` | Node >= 22.13 and a Jills version with the backend plug-in slot |
| Temporal executor, `github.com/aidanrausch4231/jills-run-temporal` | `executor` | a Jills version with the executor slot and `jills engine`, a Temporal server, and a running worker |

SQLite:

```bash
git clone https://github.com/aidanrausch4231/jills-run-sqlite /path/to/jills-run-sqlite
cd /path/to/jills-run-sqlite
npm install && npm run build
```

Then add to `~/.jills/config.yml`:

```yaml
plugins:
  - /path/to/jills-run-sqlite/dist/jills-run-sqlite.js
backend: sqlite
# sqlite_path: data/runs.sqlite   # optional; default <JILLS_HOME>/runs.sqlite
```

Run `jills check`. If it says `unknown plug-in slot "backend"`, this Jills build has no backend
slot yet: remove both lines and tell the user. Existing JSON runs are not migrated.

Temporal (each run becomes a Temporal workflow; after a crash Temporal retries and Jills
resumes the same run, skipping steps that already finished):

1. A Temporal server. For a single machine, the Temporal CLI's dev server is enough. If
   `temporal --version` fails, point the user to the official install instructions at
   https://docs.temporal.io/cli and let them install it; do not pipe an install script
   into a shell for them. The default address is `localhost:7233`; only use a remote or
   cloud address if the user gives one.
2. Build the plug-in. It runs from its own folder and needs its `node_modules`:

   ```bash
   git clone https://github.com/aidanrausch4231/jills-run-temporal /path/to/jills-run-temporal
   cd /path/to/jills-run-temporal
   npm install && npm run build
   ```

3. Two long-running processes are needed. Ask the user where to keep them, such as two
   terminals, tmux, or a user service they set up themselves. Do not install a service
   for them.

   ```bash
   temporal server start-dev                       # terminal 1 (dev server)
   node /path/to/jills-run-temporal/dist/worker.js # terminal 2 (worker)
   ```

   The worker passes its whole environment to Jill steps, so start it with only the
   variables those steps need.
4. Add to `~/.jills/config.yml` (keep any `backend:` lines from above):

   ```yaml
   plugins:
     - /path/to/jills-run-temporal/dist/index.js
   executor: temporal
   # Optional; these are the defaults. The worker takes matching flags:
   # --address --namespace --task-queue
   # temporal:
   #   address: localhost:7233
   #   namespace: default
   #   task_queue: jills
   #   max_attempts: 3
   ```

5. Run `jills check`. It probes the Temporal server. If it says `unknown plug-in slot
   "executor"`, this Jills build has no executor slot yet: remove the two lines and tell
   the user. If the server is unreachable, check that steps 1 and 3 are running.

`jills start`, `jills status` and `jills stop` work as before; `jills stop <id>` also
cancels the Temporal workflow.

## 7. Verify and report

Purpose: prove the setup works.

1. `jills check` must print `ok` (warnings are fine; read them to the user).
2. Dry run: `jills try hello --dry-run`.
3. Real run: `hello` uses a worktree, so run it inside a git repo with at least one commit. Ask
   before using one of the user's repos; otherwise use a scratch repo:

   ```bash
   mkdir -p /tmp/jills-smoke && cd /tmp/jills-smoke && git init -q && git commit -q --allow-empty -m init
   jills try hello
   ```

   It prints `done` with a branch `jills/hello-<run>`, a worktree and logs under `~/.jills`.
4. No `hello`? Create a one-step Jill with `jills new say-hi` and replace its front matter with:

   ```yaml
   ---
   name: say-hi
   description: One-step smoke test that prints hi.
   when: The user asks to test that Jills works.
   timeout: 1m
   steps:
     hi:
       run: echo hi
   ---
   ```

   Then `jills check` and `jills try say-hi` inside the scratch repo.
5. Report to the user:

   | Item | Result |
   |---|---|
   | Node, pnpm, git | versions |
   | CLI on PATH | symlink / pnpm link / none |
   | Jills home | path, Jills and agents added (mapped or created) |
   | Jev | key set or missing (never the value) |
   | Add-ons | installed, skipped, backups made |
   | Backend | json / sqlite |
   | Checks | `jills check` and the test run result |
