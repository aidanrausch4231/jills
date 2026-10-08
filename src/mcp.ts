import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listJills, start, status, suggest, wait, type BaseOpts } from "./api.js";
import { resultLine } from "./runs.js";

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** MCP tools: list_jills, suggest_jill, start_jill, jill_status, wait_for_jill. */
export function createMcpServer(o: BaseOpts = {}): McpServer {
  const server = new McpServer({ name: "jills", version: "0.1.0" });

  server.registerTool(
    "list_jills",
    { description: "List saved Jills (name, when to use, description, inputs).", inputSchema: {} },
    async () => text(JSON.stringify(await listJills(o), null, 2)),
  );

  server.registerTool(
    "suggest_jill",
    {
      description: "Ask Jev whether a chat message is a new task that fits a saved Jill. Applies the per-chat anti-nag rules.",
      inputSchema: {
        session: z.string().describe("Chat session id"),
        message: z.string().describe("The new user message"),
        recent: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).optional().describe("Last turns before the message"),
        repo: z.string().optional(),
      },
    },
    async (a) => {
      try {
        return text(JSON.stringify(await suggest({ ...o, session: a.session, message: a.message, recent: a.recent, repo: a.repo }), null, 2));
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  server.registerTool(
    "start_jill",
    {
      description: "Start a saved Jill as a separate, isolated run. Returns the run id at once; the run keeps going in the background.",
      inputSchema: {
        jill: z.string(),
        inputs: z.record(z.string()).optional(),
        repo: z.string().optional().describe("Repo folder to branch the worktree from (default: server cwd)"),
        session: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const r = await start(a.jill, { ...o, inputs: a.inputs, cwd: a.repo, session: a.session });
        return text(
          `Started Jill "${r.jill}" as run ${r.id}.\n` +
            `Now run \`jills wait ${r.id}\` in the background (e.g. Bash with run_in_background) and tell the user its one-line result (branch + logs) when it finishes. ` +
            `Do not merge anything yourself.`,
        );
      } catch (e) {
        return text(`Could not start Jill "${a.jill}": ${(e as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "jill_status",
    { description: "Status of one run (by id) or of recent runs.", inputSchema: { run: z.string().optional() } },
    async (a) => {
      if (a.run) {
        const r = status(a.run, o);
        if (!r) return text(`no run ${a.run}`, true);
        return text(JSON.stringify({ line: resultLine(r), state: r.state, steps: Object.values(r.steps).map((s) => ({ key: s.key, state: s.state, reason: s.reason, log: s.log })) }, null, 2));
      }
      return text(status(undefined, o).slice(0, 20).map(resultLine).join("\n") || "no runs");
    },
  );

  server.registerTool(
    "wait_for_jill",
    {
      description: "Wait (up to timeout_seconds, default 600) for a run to finish; returns the one-line result. Prefer `jills wait <id>` in a background shell for long runs.",
      inputSchema: { run: z.string(), timeout_seconds: z.number().positive().optional() },
    },
    async (a) => {
      try {
        const w = await wait(a.run, { ...o, timeoutMs: (a.timeout_seconds ?? 600) * 1000 });
        return text(w.line);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  return server;
}

export async function serveStdio(o: BaseOpts = {}): Promise<void> {
  const server = createMcpServer(o);
  await server.connect(new StdioServerTransport());
}
