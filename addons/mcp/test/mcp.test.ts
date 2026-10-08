import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp.js";
import { tmpHome, tmpRepo } from "../../../test/helpers.js";

const root = new URL("../../../../", import.meta.url).pathname;

async function connect(home: string) {
  const server = createMcpServer({ home });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { client, server };
}

function textOf(r: unknown): string {
  return ((r as { content: { text: string }[] }).content[0]!).text;
}

test("MCP lists the five tools and runs list/suggest/start/status/wait", async () => {
  const home = tmpHome();
  cpSync(join(root, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
  const { client, server } = await connect(home);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["jill_status", "list_jills", "start_jill", "suggest_jill", "wait_for_jill"]);

  const list = JSON.parse(textOf(await client.callTool({ name: "list_jills", arguments: {} }))) as { name: string }[];
  assert.deepEqual(list.map((j) => j.name), ["hello"]);

  const sug = JSON.parse(textOf(await client.callTool({ name: "suggest_jill", arguments: { session: "mcp-1", message: "say hello to bob" } }))) as { action: string; jill: string };
  assert.equal(sug.action, "suggest");
  assert.equal(sug.jill, "hello");

  const repo = tmpRepo();
  const started = textOf(await client.callTool({ name: "start_jill", arguments: { jill: "hello", inputs: { who: "mcp" }, repo, session: "mcp-1" } }));
  const id = /as run (\S+)\./.exec(started)![1]!;
  assert.match(started, new RegExp(`jills wait ${id}\` in the background`));

  const waited = textOf(await client.callTool({ name: "wait_for_jill", arguments: { run: id, timeout_seconds: 30 } }));
  assert.match(waited, new RegExp(`jills run ${id} done: hello`));
  const st = JSON.parse(textOf(await client.callTool({ name: "jill_status", arguments: { run: id } }))) as { state: string; steps: unknown[] };
  assert.equal(st.state, "done");
  assert.ok(st.steps.length >= 4);

  const bad = await client.callTool({ name: "start_jill", arguments: { jill: "ghost" } });
  assert.equal((bad as { isError?: boolean }).isError, true);
  assert.match(textOf(bad), /no Jill named "ghost"/);
  await client.close();
  await server.close();
});
