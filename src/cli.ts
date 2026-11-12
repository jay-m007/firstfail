#!/usr/bin/env node
// firstfail — the one real failure in a log, and the noise it caused.

import { readFileSync } from "node:fs";
import { triage } from "./triage.ts";
import { ask, prompt } from "./ask.ts";
import type { Explanation } from "./ask.ts";
import { report } from "./report.ts";

const VERSION = "0.1.0";

const USAGE = `firstfail ${VERSION} — the one real failure in a log, and the noise it caused

  firstfail <logfile>              read a file
  cat log | firstfail              or read standard input
  firstfail <logfile> --json       machine-readable

      --no-model       rules only, no Ollama call
      --model NAME     model to use (default $FIRSTFAIL_MODEL or llama3.2:1b)
      --host URL       Ollama (default $OLLAMA_HOST or http://127.0.0.1:11434)
      --timeout MS     how long to wait for the model (default 20000)
      --from N         ignore everything before line N
      --noise-min N    how many repeats before a line counts as noise (default 3)
      --show-prompt    print exactly what the model would be asked, and stop
      --scrubbed       print the log with secrets removed, and stop
  -v, --verbose        every downstream line, every noise group, timings

Exit codes: 0 a cause was found, 1 nothing in the log looks like a failure, 2 bad usage.
`;

interface Options { model: boolean; modelName: string; host: string; timeout: number; from?: number; noiseMin: number; showPrompt: boolean; scrubbed: boolean; json: boolean; verbose: boolean; color: boolean }

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const o: Options = {
    model: process.env.FIRSTFAIL_MODEL !== "off",
    modelName: process.env.FIRSTFAIL_MODEL && process.env.FIRSTFAIL_MODEL !== "off" ? process.env.FIRSTFAIL_MODEL : "llama3.2:1b",
    host: (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/^(?!http)/, "http://"),
    timeout: Number(process.env.FIRSTFAIL_TIMEOUT_MS || 20_000),
    noiseMin: 3, showPrompt: false, scrubbed: false, json: false, verbose: false,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-model") { o.model = false; continue; }
    if (a === "--model") { o.modelName = argv[++i] ?? o.modelName; continue; }
    if (a === "--host") { o.host = (argv[++i] ?? o.host).replace(/^(?!http)/, "http://"); continue; }
    if (a === "--timeout") { o.timeout = Number(argv[++i] ?? o.timeout); continue; }
    if (a === "--from") { o.from = Number(argv[++i] ?? 0) || undefined; continue; }
    if (a === "--noise-min") { o.noiseMin = Math.max(2, Number(argv[++i] ?? 3)); continue; }
    if (a === "--show-prompt") { o.showPrompt = true; continue; }
    if (a === "--scrubbed") { o.scrubbed = true; continue; }
    if (a === "--json") { o.json = true; continue; }
    if (a === "-v" || a === "--verbose") { o.verbose = true; continue; }
    if (a === "--no-color") { o.color = false; continue; }
    if (a === "--help" || a === "-h") { process.stdout.write(USAGE); return 0; }
    if (a === "--version") { process.stdout.write(VERSION + "\n"); return 0; }
    if (a.startsWith("-") && a !== "-") { process.stderr.write(`firstfail: unknown option ${a}\n`); return 2; }
    file ??= a;
  }

  let text: string;
  if (file && file !== "-") {
    try { text = readFileSync(file, "utf8"); }
    catch (e) { process.stderr.write(`firstfail: cannot read ${file}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (e as Error).message}\n`); return 2; }
  } else {
    text = await readStdin();
    if (!text.trim()) { process.stdout.write(USAGE); return 2; }
  }

  const t = triage(text, { from: o.from, noiseMin: o.noiseMin });

  if (o.scrubbed) {
    // Useful on its own: this is the log you can safely paste into a bug report.
    const { scrub } = await import("./scrub.ts");
    process.stdout.write(scrub(text).text);
    return 0;
  }
  if (o.showPrompt) { process.stdout.write(prompt(t) + "\n"); return 0; }

  let x: Explanation | null = null;
  if (o.model && t.cause) x = await ask(t, { host: o.host, model: o.modelName, timeoutMs: o.timeout });

  if (o.json) {
    process.stdout.write(JSON.stringify({
      cause: t.cause, reasoning: t.reasoning,
      downstream: t.downstream.map((d) => ({ line: d.candidate.line, text: d.candidate.text, kind: d.candidate.kind, because: d.because })),
      unexplained: t.unexplained, noise: t.noise.slice(0, 20),
      redactions: t.redactions, format: t.detection.format, totals: t.totals,
      model: x && { text: x.text, picked: x.picked, agrees: x.agrees, invented: x.invented, ms: x.ms, skipped: x.skipped },
    }, null, 2) + "\n");
    return t.cause ? 0 : 1;
  }

  process.stdout.write(report(t, x, { color: o.color, width: Math.min(process.stdout.columns || 96, 96), verbose: o.verbose }));
  return t.cause ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { process.stderr.write(`firstfail: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
