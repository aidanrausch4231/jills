import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listJills, start, status, suggest, wait, type BaseOpts } from "../../src/api.js";
import { resultLine } from "../../src/runs.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });

/** MCP tools: list_jills, suggest_jill, start_jill, jill_status, wait_for_jill. */
export function createMcpServer(o: BaseOpts = {}): McpServer {
  const server = new McpServer({ name: "jills", version: "0.1.0" });
  // name, description, input schema, handler → text (a throw becomes an error result)
  const tools: [string, string, z.ZodRawShape, (a: any) => Promise<string>][] = [
    ["list_jills", "List saved Jills (name, when to use, description, inputs).", {}, async () => json(await listJills(o))],
    [
      "suggest_jill",
      "Ask Jev whether a chat message is a new task that fits a saved Jill. Applies the per-chat anti-nag rules.",
      { session: z.string().describe("Chat session id"), message: z.string().describe("The new user message"), recent: z.array(turn).optional().describe("Last turns before the message"), repo: z.string().optional() },
      async (a) => json(await suggest({ ...o, session: a.session, message: a.message, recent: a.recent, repo: a.repo })),
    ],
    [
      "start_jill",
      "Start a saved Jill as a separate, isolated run. Returns the run id at once; the run keeps going in the background.",
      { jill: z.string(), inputs: z.record(z.string()).optional(), repo: z.string().optional().describe("Repo folder to branch the worktree from (default: server cwd)"), session: z.string().optional() },
      async (a) => {
        const r = await start(a.jill, { ...o, inputs: a.inputs, cwd: a.repo, session: a.session }).catch((e: Error) => {
          throw new Error(`Could not start Jill "${a.jill}": ${e.message}`);
        });
        return `Started Jill "${r.jill}" as run ${r.id}.\nNow run \`jills wait ${r.id}\` in the background (e.g. Bash with run_in_background) and tell the user its one-line result (branch + logs) when it finishes. Do not merge anything yourself.`;
      },
    ],
    [
      "jill_status",
      "Status of one run (by id) or of recent runs.",
      { run: z.string().optional() },
      async (a) => {
        if (!a.run) return status(undefined, o).slice(0, 20).map(resultLine).join("\n") || "no runs";
        const r = status(a.run, o);
        if (!r) throw new Error(`no run ${a.run}`);
        return json({ line: resultLine(r), state: r.state, steps: Object.values(r.steps).map((s) => ({ key: s.key, state: s.state, reason: s.reason, log: s.log })) });
      },
    ],
    [
      "wait_for_jill",
      "Wait (up to timeout_seconds, default 600) for a run to finish; returns the one-line result. Prefer `jills wait <id>` in a background shell for long runs.",
      { run: z.string(), timeout_seconds: z.number().positive().optional() },
      async (a) => (await wait(a.run, { ...o, timeoutMs: (a.timeout_seconds ?? 600) * 1000 })).line,
    ],
  ];
  for (const [name, description, inputSchema, fn] of tools)
    server.registerTool(name, { description, inputSchema }, async (a: unknown) => {
      try {
        return { content: [{ type: "text" as const, text: await fn(a) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    });
  return server;
}

export async function serveStdio(o: BaseOpts = {}): Promise<void> {
  await createMcpServer(o).connect(new StdioServerTransport());
}
