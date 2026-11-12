// The model's part, which is deliberately small.
//
// It is not asked "what went wrong with this log" — that invites a plausible story. It is given the
// handful of lines the rules already picked out, numbered, and asked which one started it and why.
// A choice from a list can be checked: if the number is not one of the lines it was offered, the
// answer is thrown away. The rules' own pick is what gets reported either way; where the model
// disagrees, the disagreement is shown rather than silently resolved.

import type { Triage } from "./triage.ts";
import type { Candidate } from "./classify.ts";

export interface AskOptions { host: string; model: string; timeoutMs: number }

export interface Explanation {
  /** One sentence about the cause, or null. */
  text: string | null;
  /** The line the model picked, after checking it was one of the ones offered. */
  picked: number | null;
  /** True when the model picked the same line as the rules. */
  agrees: boolean | null;
  /** A line number the model named that it was never offered. */
  invented: number | null;
  ms: number;
  skipped: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    cause_line: { type: "integer" },
    explanation: { type: "string" },
  },
  required: ["cause_line", "explanation"],
} as const;

const SYSTEM = [
  "You are given numbered lines taken from a failing build log, and a note of how often each one repeated.",
  "Choose the line number where the failure started: the one that explains the others, not one it caused.",
  "A service that was unreachable, a missing module, a disk that filled or a process that was killed explains failing tests. Failing tests and non-zero exit codes never explain those.",
  "cause_line must be one of the numbers you were given, copied exactly.",
  "In explanation, say in one sentence of at most 25 words what went wrong and why the other lines followed from it.",
  "Use only what the lines say. Do not guess at code you cannot see, do not suggest a fix, and do not mention any line number.",
].join("\n");

/** The whole prompt. Only candidate lines are included: the model never sees the full log. */
export function prompt(t: Triage, max = 12): string {
  const offered = offer(t, max);
  const parts = [
    `the log came from: ${t.detection.format}`,
    `lines that look like failures, in order:`,
    ...offered.map((c) => `${c.line}: ${c.text.slice(0, 180)}`),
  ];
  const repeats = t.noise.slice(0, 3).filter((c) => c.count >= 3);
  if (repeats.length) parts.push(`repeated lines: ${repeats.map((c) => `${c.count}x "${c.example.slice(0, 60)}"`).join("; ")}`);
  return parts.join("\n");
}

/** The candidates the model is allowed to choose between: the cause plus the strongest others. */
export function offer(t: Triage, max = 12): Candidate[] {
  const seen = new Set<number>();
  const picked: Candidate[] = [];
  const add = (c: Candidate) => { if (!seen.has(c.line)) { seen.add(c.line); picked.push(c); } };
  if (t.cause) add(t.cause);
  for (const c of t.unexplained) add(c);
  for (const d of [...t.downstream].sort((a, b) => b.candidate.rootScore - a.candidate.rootScore)) { if (picked.length >= max) break; add(d.candidate); }
  return picked.slice(0, max).sort((a, b) => a.line - b.line);
}

export async function ask(t: Triage, o: AskOptions): Promise<Explanation> {
  const started = performance.now();
  const out: Explanation = { text: null, picked: null, agrees: null, invented: null, ms: 0, skipped: null };
  if (!t.cause) { out.skipped = "nothing in the log looks like a failure"; return out; }

  const offered = offer(t);
  let parsed: { cause_line?: unknown; explanation?: unknown };
  try {
    const res = await fetch(`${o.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(t) }],
        stream: false, format: SCHEMA, options: { temperature: 0, num_predict: 160 },
      }),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) { out.skipped = res.status === 404 ? `the model ${o.model} is not installed: run ollama pull ${o.model}` : `Ollama returned ${res.status}`; return out; }
    parsed = JSON.parse(((await res.json()) as { message?: { content?: string } }).message?.content ?? "{}");
  } catch (e) {
    const err = e as Error;
    out.skipped = err.name === "TimeoutError" ? `the model did not answer within ${Math.round(o.timeoutMs / 1000)} s` : `Ollama is not reachable at ${o.host} (${err.message})`;
    out.ms = Math.round(performance.now() - started);
    return out;
  }
  out.ms = Math.round(performance.now() - started);

  const line = Number(parsed.cause_line);
  if (Number.isInteger(line) && offered.some((c) => c.line === line)) {
    out.picked = line;
    out.agrees = line === t.cause.line;
  } else if (Number.isInteger(line)) {
    out.invented = line;
  }

  let text = typeof parsed.explanation === "string" ? parsed.explanation.replace(/\s+/g, " ").trim() : "";
  if (!text) { out.skipped = out.picked === null ? `the model chose line ${line}, which was not one of the lines it was given` : "the model returned an empty explanation"; return out; }

  // An explanation that names a line it was not given is talking about something imaginary.
  const named = [...text.matchAll(/\bline\s+(\d+)/gi)].map((m) => Number(m[1]));
  const bogus = named.find((n) => !offered.some((c) => c.line === n));
  if (bogus !== undefined) { out.invented = bogus; out.skipped = `the explanation referred to line ${bogus}, which is not one of the lines it was given`; return out; }

  if (out.picked === null) { out.skipped = `the model chose line ${line}, which was not one of the lines it was given`; return out; }

  // One sentence: a model asked for one often supplies three.
  const stop = text.search(/[.!?](\s|$)/);
  if (stop >= 8 && stop < text.length - 2) text = text.slice(0, stop + 1);
  out.text = text.length > 240 ? text.slice(0, 237).replace(/\s\S*$/, "") + "…" : text;
  return out;
}
