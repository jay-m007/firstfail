// Measures the model against logs whose cause is known in advance.
//
// The rules already pick a cause, and the test suite checks that. What is measured here is whether
// the model agrees, how often it picks a line it was never offered, and how long it takes. The
// interesting number is agreement on the hard cases: a log where the real cause is quiet and the
// symptom is loud.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { triage } from "../src/triage.ts";
import { ask } from "../src/ask.ts";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const host = flag("host", process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/^(?!http)/, "http://");
const model = flag("model", process.env.FIRSTFAIL_MODEL && process.env.FIRSTFAIL_MODEL !== "off" ? process.env.FIRSTFAIL_MODEL : "llama3.2:1b");
const timeout = Number(flag("timeout", "30000"));

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

/** What the cause line must contain, per fixture. Anything not listed has no failure to find. */
const EXPECTED: Record<string, string | null> = {
  "docker-port-then-tests.log": "port is already allocated",
  "assertion-only.log": "expected 118 to equal 105",
  "oom-cascade.log": "heap out of memory",
  "clean.log": null,
  "pytest-missing-module.log": "No module named",
  "two-failures.log": "ECONNREFUSED",
  "ansi-progress.log": "no space left on device",
};

async function main(): Promise<void> {
  process.stdout.write(`firstfail eval\n  host   ${host}\n  model  ${model}\n\n`);
  try {
    const tags = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const installed = ((await tags.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    process.stdout.write(`  installed: ${installed.join(", ") || "none"}\n\n`);
    if (!installed.some((m) => m === model || m.split(":")[0] === model.split(":")[0])) { process.stdout.write(`  ${model} is not installed. Run: ollama pull ${model}\n`); process.exit(1); }
  } catch (e) {
    process.stdout.write(`  Ollama is not answering at ${host}: ${e instanceof Error ? e.message : String(e)}\n  Start it with "ollama serve".\n`);
    process.exit(1);
  }

  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".log")).sort();
  let rulesRight = 0, rulesTotal = 0, agreed = 0, asked = 0, offScript = 0, explained = 0;
  const latencies: number[] = [];
  const rows: unknown[] = [];

  for (const f of files) {
    const t = triage(readFileSync(join(FIXTURES, f), "utf8"));
    const expected = EXPECTED[f];
    if (expected !== undefined) {
      rulesTotal++;
      const ok = expected === null ? t.cause === null : !!t.cause && t.cause.text.includes(expected);
      if (ok) rulesRight++;
      if (!ok) process.stdout.write(`  RULES WRONG  ${f}: expected ${expected ?? "no failure"}, got ${t.cause?.text.slice(0, 50) ?? "no failure"}\n`);
    }
    if (!t.cause) { process.stdout.write(`  (no failure)                    ${f}\n`); continue; }

    const x = await ask(t, { host, model, timeoutMs: timeout });
    asked++;
    latencies.push(x.ms);
    if (x.text) explained++;
    if (x.invented !== null) offScript++;
    if (x.agrees) agreed++;
    const verdict = x.invented !== null ? `chose line ${x.invented}, not offered` : x.agrees === true ? "agreed" : x.agrees === false ? `picked line ${x.picked} instead of ${t.cause.line}` : x.skipped ?? "no answer";
    process.stdout.write(`  ${verdict.padEnd(32)} ${String(x.ms).padStart(6)} ms  ${f}\n`);
    if (x.text) process.stdout.write(`      ${x.text.slice(0, 100)}\n`);
    rows.push({ file: f, causeLine: t.cause.line, causeRule: t.cause.rule, picked: x.picked, agrees: x.agrees, invented: x.invented, text: x.text, ms: x.ms, skipped: x.skipped });
  }

  const q = (p: number) => { const s = [...latencies].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
  process.stdout.write([
    ``,
    `  rules found the right cause   ${rulesRight}/${rulesTotal}   (no model involved; this is what the test suite checks)`,
    `  model agreed with the rules   ${agreed}/${asked}`,
    `  model chose a line it was never offered   ${offScript}/${asked}   (rejected before being shown)`,
    `  model produced a usable sentence          ${explained}/${asked}`,
    `  latency p50 / p95             ${q(0.5)} / ${q(0.95)} ms`,
    ``,
    `  Disagreement is not automatically a model failure: on the two-failures log either answer is`,
    `  defensible. What must stay at zero is the third line, because a line number that was never`,
    `  offered means the model is talking about something that is not in the log.`,
    ``,
  ].join("\n"));

  writeFileSync(new URL(`./results-${model.replace(/[:/]/g, "-")}.json`, import.meta.url), JSON.stringify({ model, host, when: new Date().toISOString(), rulesRight, rulesTotal, agreed, asked, offScript, explained, p50: q(0.5), p95: q(0.95), rows }, null, 2));
  process.stdout.write(`written to eval/results-${model.replace(/[:/]/g, "-")}.json\n`);
}

main().catch((e) => { process.stderr.write(`eval failed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
