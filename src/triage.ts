// Picking the one failure that explains the rest.
//
// The ordering rule is the whole idea: a cause comes before its effects in the log, and some kinds
// of failure can explain others while the reverse never happens. A database that was not listening
// explains eleven failed tests; eleven failed tests never explain a database that was not listening.

import type { Line } from "./lines.ts";
import { parseLines, detect } from "./lines.ts";
import type { Detection } from "./lines.ts";
import type { Candidate } from "./classify.ts";
import { candidates } from "./classify.ts";
import type { Cluster } from "./template.ts";
import { cluster, noisiest, shapeOf } from "./template.ts";
import { scrub } from "./scrub.ts";
import type { Redaction } from "./scrub.ts";

export interface Downstream {
  /** The candidate that is explained by the cause. */
  candidate: Candidate;
  /** Why it is thought to be a consequence rather than a cause. */
  because: string;
}

export interface Triage {
  /** The failure that best explains the rest, or null when nothing failed. */
  cause: Candidate | null;
  /** Why this one and not another. */
  reasoning: string[];
  /** Candidates after the cause that it can account for. */
  downstream: Downstream[];
  /** Other candidates that the cause does not account for: worth a look on their own. */
  unexplained: Candidate[];
  /** Repeated lines, biggest group first. */
  noise: Cluster[];
  /** How many lines the repeats take up. */
  noiseLines: number;
  redactions: Redaction[];
  detection: Detection;
  totals: { lines: number; blank: number; candidates: number; collapsedProgress: number };
  lines: Line[];
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Which kinds a cause of a given kind can account for. */
const EXPLAINS: Record<string, string[]> = {
  // An environment failure explains a build that then failed too: the build had nothing to work
  // with. The reverse is not true, which is what makes the ordering useful.
  infrastructure: ["assertion", "test-failure", "exit", "error", "timeout", "infrastructure", "compile", "missing"],
  missing: ["assertion", "test-failure", "exit", "error", "compile", "missing"],
  compile: ["assertion", "test-failure", "exit", "error", "compile"],
  timeout: ["assertion", "test-failure", "exit", "error"],
  assertion: ["test-failure", "exit"],
  "test-failure": ["exit", "test-failure"],
  exit: [],
  error: ["exit"],
};

export interface TriageOptions {
  /** Ignore everything before this line, e.g. to skip a setup section. */
  from?: number;
  /** How many repeats before a shape counts as noise. */
  noiseMin?: number;
}

/** Reads a whole log and works out what happened. The log is scrubbed before anything else. */
export function triage(rawText: string, o: TriageOptions = {}): Triage {
  const { text, redactions } = scrub(rawText);
  const { lines, collapsedProgress } = parseLines(text);
  const detection = detect(lines);
  const considered = o.from ? lines.filter((l) => l.n >= o.from!) : lines;

  const all = candidates(considered);
  const clusters = cluster(considered);
  const noise = noisiest(clusters, o.noiseMin ?? 3);

  // A line that appears many times is a symptom being repeated, not the moment something broke,
  // so a candidate loses weight for being one of a crowd.
  const repeatCount = new Map<string, number>();
  for (const c of clusters) repeatCount.set(c.shape, c.count);
  const weighted = all.map((c) => {
    const repeats = repeatCount.get(shapeOf(c.text)) ?? 1;
    const penalty = repeats >= 10 ? 25 : repeats >= 3 ? 10 : 0;
    return { c, score: c.rootScore - penalty, repeats };
  });

  // The cause is the strongest explanation; where two are equally strong, the earlier one wins,
  // because a cause cannot come after its effect.
  const ranked = [...weighted].sort((a, b) => (b.score - a.score) || (a.c.line - b.c.line));
  const best = ranked[0];

  const reasoning: string[] = [];
  let cause: Candidate | null = null;
  let downstream: Downstream[] = [];
  let unexplained: Candidate[] = [];

  if (best) {
    cause = best.c;
    reasoning.push(`line ${cause.line} is the earliest ${cause.kind === "infrastructure" ? "environment failure" : cause.kind + " failure"} in the log${ranked.length > 1 ? `, and ${cause.kind} failures explain ${EXPLAINS[cause.kind]?.length ? "the kinds of failure below it" : "nothing else here"}` : ""}`);
    if (cause.meaning) reasoning.push(cause.meaning);
    if (best.repeats > 1) reasoning.push(`the same line appears ${best.repeats} times; this is the first`);

    const canExplain = EXPLAINS[cause.kind] ?? [];
    for (const { c } of weighted) {
      if (c.line <= cause.line) continue;
      if (canExplain.includes(c.kind)) downstream.push({ candidate: c, because: c.kind === cause.kind ? `the same failure again, after line ${cause.line}` : `${article(c.kind)} ${c.kind} after ${article(cause.kind)} ${cause.kind} failure is usually its consequence` });
      else unexplained.push(c);
    }
    // Anything before the cause that the cause cannot have produced deserves to be seen.
    for (const { c } of weighted) if (c.line < cause.line) unexplained.push(c);
    unexplained.sort((a, b) => a.line - b.line);

    if (!downstream.length && !unexplained.length && all.length === 1) reasoning.push("it is the only failure in the log");
  } else {
    reasoning.push("no line in this log looks like a failure");
  }

  const blank = lines.filter((l) => !l.text.trim()).length;
  return {
    cause, reasoning, downstream, unexplained, noise,
    noiseLines: noise.reduce((n, c) => n + c.count, 0),
    redactions, detection,
    totals: { lines: lines.length, blank, candidates: all.length, collapsedProgress },
    lines,
  };
}

/** A few lines around a line number, for showing the failure in place. */
export function context(t: Triage, line: number, before = 2, after = 2): Line[] {
  return t.lines.filter((l) => l.n >= line - before && l.n <= line + after);
}
