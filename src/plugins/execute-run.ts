import { fileURLToPath } from "node:url";
import { jillsHome, loadConfig } from "../config.js";
import { HEARTBEAT_MS, RunEngine, type EventListener } from "../engine.js";
import { scanJills } from "../jillfile.js";
import { bootId, stopTagged } from "../proc.js";
import { loadRecord, markTerminal, saveRecord, stuckReason, TERMINAL, type RunRecord } from "../runs.js";
import { loadPlugins } from "./index.js";

type Options = { home?: string; onEvent?: EventListener; signal?: AbortSignal; engine?: boolean };

/** The detached runner dispatches to the selected executor; engine bypasses it. */
export async function executeRun(id: string, o: Options = {}): Promise<RunRecord> {
  const config = loadConfig(o.home ?? jillsHome());
  const plugins = await loadPlugins(o.engine ? { ...config, raw: { ...config.raw, executor: undefined } } : config);
  const { backend } = plugins;
  const r = loadRecord(config.home, id, backend);
  if (!r) throw new Error(`no run ${id}`);
  const previousBeat = backend.loadBeat(config.home, id);
  if (!o.engine && r.state !== "queued") throw new Error(`run ${id} is ${r.state}, not queued`);
  if (o.engine) {
    if (!["queued", "running", "stuck", "failed"].includes(r.state)) throw new Error(`cannot resume run ${id}: ${r.state}`);
    const gone = stuckReason(r, previousBeat) === "the runner process is gone";
    if ((r.state !== "queued" || r.pid !== undefined) && !gone) throw new Error(`cannot resume run ${id}: runner is still alive (or its death cannot be verified)`);
  }
  if (!o.engine && plugins.executor) {
    r.executorPid = process.pid;
    r.executorBootId = bootId();
    saveRecord(config.home, r, backend);
    const since = String(process.hrtime.bigint());
    const beat = () => backend.beat(config.home, id, { at: new Date().toISOString(), mono: String(process.hrtime.bigint()), since, bootId: r.executorBootId });
    beat();
    const heart = setInterval(beat, HEARTBEAT_MS);
    try {
      await plugins.executor.execute(r, { config, cli: fileURLToPath(new URL("../cli.js", import.meta.url)), signal: o.signal ?? new AbortController().signal });
      const after = loadRecord(config.home, id, backend)!;
      if (!TERMINAL.has(after.state)) throw new Error(`executor ${plugins.executor.name} returned while run is ${after.state}`);
      return after;
    } catch (e) {
      const after = loadRecord(config.home, id, backend) ?? r;
      return markTerminal(config.home, after, "failed", `executor ${plugins.executor.name}: ${(e as Error).message}`, undefined, backend) ?? after;
    } finally {
      clearInterval(heart);
    }
  }
  const resume = o.engine && (r.state !== "queued" || Object.keys(r.steps).length > 0);
  const jills = scanJills(config.jill_paths).items;
  if (resume) {
    for (const s of Object.values(r.steps)) if (s.state !== "done") s.state = "pending";
    delete r.error;
    delete r.finished;
    delete r.conflicts;
    delete r.deadline;
  }
  // Claim synchronously before the engine's observer guard sees the old terminal record.
  Object.assign(r, { state: "running", pid: process.pid });
  saveRecord(config.home, r, backend);
  if (resume) {
    const mono = String(process.hrtime.bigint());
    backend.beat(config.home, id, { at: new Date().toISOString(), mono, since: mono, bootId: bootId() });
    await stopTagged(id, previousBeat?.bootId, 3000, r.executorPid ? [r.executorPid] : []);
  }
  return new RunEngine(r, { config, plugins, lookup: (name) => jills.get(name), ...o, resume }).execute();
}
