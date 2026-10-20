import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Heartbeat, RunRecord } from "../runs.js";
import { readJson, writeJsonAtomic } from "../util.js";
import type { BackendPlugin } from "./types.js";

export const runsDir = (home: string) => join(home, "runs");
export const recordPath = (home: string, id: string) => join(runsDir(home), `${id}.json`);
export const runLogDir = (home: string, id: string) => join(runsDir(home), id);
export const heartbeatPath = (home: string, id: string) => join(runLogDir(home, id), "heartbeat.json");
const validId = (id: string) => /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
const requireId = (id: string) => { if (!validId(id)) throw new Error(`bad run id "${id}"`); };

const json: BackendPlugin = {
  slot: "backend",
  apiVersion: 1,
  name: "json",
  save(home, r) {
    requireId(r.id);
    writeJsonAtomic(recordPath(home, r.id), r);
  },
  load(home, id) {
    return validId(id) ? readJson<RunRecord>(recordPath(home, id)) : undefined;
  },
  list(home) {
    const dir = runsDir(home);
    if (!existsSync(dir)) return [];
    const out = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<RunRecord>(join(dir, f)));
    return (out.filter(Boolean) as RunRecord[]).sort((a, b) => (a.created < b.created ? 1 : -1));
  },
  beat(home, id, hb) {
    requireId(id);
    writeJsonAtomic(heartbeatPath(home, id), hb);
  },
  loadBeat(home, id) {
    return validId(id) ? readJson<Heartbeat>(heartbeatPath(home, id)) : undefined;
  },
};
export default json;
