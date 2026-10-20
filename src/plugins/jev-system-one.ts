import type { MatchInput, MatchResult } from "./types.js";

/** Longest text the matcher puts into an input (same cap as the keywords matcher). */
const MAX_INPUT = 4000;
const TURN_IN_STATE = 1000;
const NEW = "new:";

const ROUTE_TEXT =
  "Which route fits `latest_message`? Use `recent_turns`, `already_suggested_or_running` and `last_suggested_task` for context. " +
  "Pick `talk` for chat, thanks or questions that are not a task. Pick `same` when the message continues, repeats or rewords a task in `already_suggested_or_running` or `last_suggested_task`, even if the user ignored that suggestion. " +
  "Pick `new:<name>` when it starts a new task that one saved Jill in `jills` fits by meaning (the Jill's `when` and `description`). " +
  "Pick `none` when it is a new task and no saved Jill fits.";

/** One System One request body: a route Choice plus two yes/no questions over the same state. */
export function buildSystemOneRequest(input: MatchInput, model: string): Record<string, unknown> {
  const criteria: Record<string, unknown> = {
    talk: "Chat, thanks or a question; no task to run",
    same: "Continues, repeats or rewords a task already suggested (even if the user ignored it) or running in this chat, including `last_suggested_task`",
  };
  for (const j of input.jills) criteria[NEW + j.name] = { jill: j.name, when: j.when ?? "", description: j.description };
  criteria.none = "A new task, but no saved Jill fits it";
  return {
    model,
    state: {
      latest_message: input.message,
      recent_turns: input.recent.slice(-3).map((t) => ({ role: t.role, text: t.text.slice(0, TURN_IN_STATE) })),
      already_suggested_or_running: input.already,
      ...(input.suggestedTask ? { last_suggested_task: { jill: input.suggestedTask.jill, message: input.suggestedTask.task.slice(0, 500) } } : {}),
      jills: input.jills.map((j) => ({ name: j.name, when: j.when ?? "", description: j.description })),
    },
    questions: {
      route: { type: "choice", instructions: ROUTE_TEXT, criteria },
      action: { type: "noul", instructions: "Does `latest_message` ask for work to be done (not a question or chat)?" },
      refers_back: { type: "noul", instructions: 'Does `latest_message` depend on `recent_turns` to know the task, like "fix it" or "do that"?' },
    },
  };
}

type Answers = Record<string, { type?: unknown; choice?: unknown; probabilities?: unknown; noul?: unknown } | undefined>;
const prob = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/** The single required input with no default (same rule as the keywords matcher), else none. */
function inputsFor(input: MatchInput, jill: string, askedBack: boolean): Record<string, string> {
  const [only, ...more] = input.jills.find((j) => j.name === jill)?.required ?? [];
  const message = input.message.trim().slice(0, MAX_INPUT);
  if (only === undefined || more.length || !message) return {};
  const earlier = input.recent.slice(-3).map((t) => `${t.role}: ${t.text}`).join("\n");
  if (!askedBack || !earlier) return { [only]: message };
  const tail = `\n\nRequest:\n${message}`;
  const head = "Earlier chat:\n";
  const room = Math.max(0, MAX_INPUT - head.length - tail.length);
  return { [only]: `${head}${earlier.length > room ? earlier.slice(earlier.length - room) : earlier}${tail}`.slice(0, MAX_INPUT) };
}

/** Turn a System One reply into a match. Anything unexpected returns undefined (keywords answer). */
export function parseSystemOne(body: unknown, input: MatchInput, threshold: number): MatchResult | undefined {
  const answers = (body as { answers?: Answers } | null)?.answers;
  const route = answers?.route;
  if (!route || typeof route.choice !== "string" || !route.probabilities || typeof route.probabilities !== "object") return undefined;
  const probs = route.probabilities as Record<string, unknown>;
  const p = prob(probs[route.choice]);
  const action = prob(answers?.action?.noul);
  if (p === undefined || action === undefined) return undefined;
  const base = { confidence: p, matcher: "jev", sameProb: prob(probs.same) };
  const id = route.choice;
  if (id === "same") return { label: "same", ...base };
  if (!id.startsWith(NEW)) return { label: "talk", ...base };
  const jill = input.jills.find((j) => NEW + j.name === id)?.name; // never trust a name that is not in the list
  if (!jill) return { label: "talk", ...base, note: "jev named an unknown option" };
  if (p < threshold || action < 0.5) return { label: "talk", ...base };
  const back = prob(answers?.refers_back?.noul) ?? 0;
  return { label: "new", jill, inputs: inputsFor(input, jill, back >= 0.5), ...base };
}
