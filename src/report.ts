// Printing the verdict. The shape of the output is the argument: one cause, then everything that
// followed from it, then the bulk that can be ignored.

import type { Triage } from "./triage.ts";
import { context } from "./triage.ts";
import type { Explanation } from "./ask.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", grey: "\x1b[90m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", blue: "\x1b[34m" };

export interface ReportOptions { color: boolean; width: number; verbose: boolean }

export function report(t: Triage, x: Explanation | null, o: ReportOptions): string {
  const c = (code: string, s: string) => (o.color ? code + s + C.reset : s);
  const out: string[] = [""];
  const pct = (n: number) => `${Math.round((n / Math.max(1, t.totals.lines)) * 100)}%`;

  if (t.redactions.length) {
    const what = t.redactions.map((r) => `${r.count} ${r.kind}${r.count > 1 ? "s" : ""}`).join(", ");
    out.push(`  ${c(C.green, "scrubbed")} ${what} before anything else read the log`, "");
  }

  if (!t.cause) {
    out.push(`  ${c(C.bold, "no failure found")} in ${t.totals.lines.toLocaleString("en-US")} lines`);
    out.push(`  ${c(C.grey, `${t.detection.format} log; ${t.totals.candidates} lines looked like errors and none of them were failures`)}`, "");
    return out.join("\n");
  }

  out.push(`  ${c(C.red + C.bold, "cause")}  ${c(C.bold, `line ${t.cause.line}`)}  ${c(C.grey, `[${t.cause.kind}]`)}`);
  out.push("");
  for (const l of context(t, t.cause.line, 2, 2)) {
    const isCause = l.n === t.cause.line;
    const marker = isCause ? c(C.red, "→") : " ";
    // A CI group marker is blanked out when the log is parsed, so fall back to the raw line
    // rather than printing an empty row next to the failure.
    const full = l.text.trim() || l.raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
    if (isCause) {
      // The cause is the one line that must never be cut off, so it wraps instead.
      const [first, ...rest] = wrap(full, o.width - 16);
      out.push(`    ${marker} ${c(C.grey, String(l.n).padStart(6))}  ${c(C.bold, first)}`);
      for (const r of rest) out.push(`             ${c(C.bold, r)}`);
    } else {
      out.push(`    ${marker} ${c(C.grey, String(l.n).padStart(6))}  ${c(C.dim, full.slice(0, o.width - 14))}`);
    }
  }
  out.push("");

  if (x?.text) {
    for (const line of wrap(x.text, o.width - 4)) out.push(`  ${line}`);
    if (x.agrees === false) out.push(`  ${c(C.yellow, `the model would have blamed line ${x.picked} instead; the lines above are what the rules found`)}`);
    out.push("");
  } else if (x?.skipped && o.verbose) {
    out.push(`  ${c(C.grey, `no model explanation: ${x.skipped}`)}`, "");
  }

  out.push(`  ${c(C.bold, "why this line")}`);
  for (const r of t.reasoning) for (const [i, line] of wrap(r, o.width - 8).entries()) out.push(`    ${i === 0 ? c(C.grey, "·") : " "} ${line}`);
  out.push("");

  if (t.downstream.length) {
    out.push(`  ${c(C.bold, "followed from it")}  ${c(C.grey, `${t.downstream.length} ${t.downstream.length === 1 ? "line" : "lines"}`)}`);
    const shown = t.downstream.slice(0, o.verbose ? 40 : 4);
    for (const d of shown) out.push(`    ${c(C.grey, String(d.candidate.line).padStart(6))}  ${c(C.dim, d.candidate.text.slice(0, o.width - 14))}`);
    if (t.downstream.length > shown.length) out.push(`    ${c(C.grey, `         and ${t.downstream.length - shown.length} more, all after line ${t.cause.line}`)}`);
    out.push(`    ${c(C.grey, `         ${t.downstream[0].because}`)}`, "");
  }

  if (t.unexplained.length) {
    out.push(`  ${c(C.yellow + C.bold, "not explained by it")}  ${c(C.grey, "worth a look on its own")}`);
    for (const u of t.unexplained.slice(0, o.verbose ? 20 : 5)) out.push(`    ${c(C.grey, String(u.line).padStart(6))}  ${u.text.slice(0, o.width - 14)}  ${c(C.grey, `[${u.kind}]`)}`);
    if (t.unexplained.length > (o.verbose ? 20 : 5)) out.push(`    ${c(C.grey, `         and ${t.unexplained.length - (o.verbose ? 20 : 5)} more`)}`);
    out.push("");
  }

  if (t.noise.length) {
    out.push(`  ${c(C.bold, "noise")}  ${c(C.grey, `${t.noiseLines.toLocaleString("en-US")} lines (${pct(t.noiseLines)}) are repeats of ${t.noise.length} ${t.noise.length === 1 ? "line" : "lines"}`)}`);
    for (const n of t.noise.slice(0, o.verbose ? 12 : 3)) out.push(`    ${c(C.grey, ("x" + n.count).padStart(6))}  ${c(C.dim, n.example.slice(0, o.width - 14))}`);
    out.push("");
  }

  const notes = [
    `${t.totals.lines.toLocaleString("en-US")} lines of ${t.detection.format} log, ${t.totals.candidates} of them error-shaped`,
    ...(t.totals.collapsedProgress ? [`${t.totals.collapsedProgress} progress-bar rewrites were collapsed`] : []),
    ...(o.verbose && x?.ms ? [`the model took ${x.ms} ms`] : []),
    `every line number above is the line in the file you gave, so sed -n '${t.cause.line}p' will show it`,
  ];
  for (const n of notes) out.push(`  ${c(C.grey, n)}`);
  out.push("");
  return out.join("\n");
}

export function wrap(text: string, width: number): string[] {
  if (width < 24) return [text];
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}
