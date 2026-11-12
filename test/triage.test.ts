import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { triage } from "../src/triage.ts";
import { secretsLog, MUST_NOT_SURVIVE } from "./secrets.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const look = (name: string) => triage(fixture(name));

test("a docker port clash is blamed, not the eleven tests that could not connect", () => {
  const t = look("docker-port-then-tests.log");
  assert.equal(t.cause?.kind, "infrastructure");
  assert.match(t.cause!.text, /port is already allocated/);
  assert.ok(t.downstream.length >= 11, `only ${t.downstream.length} lines were tied to the cause`);
  assert.ok(t.downstream.every((d) => d.candidate.line > t.cause!.line), "a consequence cannot come before its cause");
  assert.match(t.reasoning.join(" "), /something was already on that port/);
});

test("the repeated symptom is reported as noise rather than as the failure", () => {
  const t = look("docker-port-then-tests.log");
  assert.ok(t.noise.some((n) => /ECONNREFUSED/.test(n.example) && n.count === 11));
  assert.ok(t.noiseLines > t.totals.lines * 0.4, "most of this log is repeats");
  assert.ok(!/ECONNREFUSED/.test(t.cause!.text), "the symptom must not be the verdict");
});

test("a real assertion failure is the cause when nothing else went wrong", () => {
  const t = look("assertion-only.log");
  assert.ok(t.cause, "a failing test is still a failure");
  assert.match(t.cause!.text, /expected 118 to equal 105/);
  assert.equal(t.cause!.kind, "assertion");
});

test("running out of memory outranks everything it caused", () => {
  const t = look("oom-cascade.log");
  assert.equal(t.cause!.rule, "oom");
  assert.match(t.reasoning.join(" "), /ran out of memory/);
  assert.ok(t.downstream.some((d) => /Build failed/.test(d.candidate.text)));
});

test("a passing log is reported as having no failure, not as a mystery", () => {
  const t = look("clean.log");
  assert.equal(t.cause, null);
  assert.match(t.reasoning.join(" "), /no line in this log looks like a failure/);
});

test("lines that merely mention error handling are not mistaken for failures", () => {
  const t = look("clean.log");
  assert.equal(t.totals.candidates, 0, `picked up ${t.totals.candidates}: ${JSON.stringify(t.unexplained.map((u) => u.text))}`);
});

test("secrets are removed before the log is read, and the failure is still found", () => {
  const t = triage(secretsLog());
  const kinds = t.redactions.map((r) => r.kind);
  assert.ok(kinds.includes("AWS access key id"), `redacted: ${kinds.join(", ")}`);
  assert.ok(kinds.includes("GitHub token"));
  assert.ok(kinds.includes("password in a URL"));
  assert.match(t.cause!.text, /Connection refused/);
  const everything = JSON.stringify(t);
  for (const secret of MUST_NOT_SURVIVE) assert.ok(!everything.includes(secret), `${secret} survived into the result`);
});

test("a missing python module is the cause, above the collection error it produced", () => {
  const t = look("pytest-missing-module.log");
  assert.equal(t.cause!.kind, "missing");
  assert.match(t.cause!.text, /No module named 'httpx'/);
  assert.equal(t.detection.format, "pytest");
});

test("a second, unrelated failure is kept separate instead of being folded into the first", () => {
  const t = look("two-failures.log");
  assert.ok(t.cause, "there is a failure here");
  const all = [t.cause!, ...t.downstream.map((d) => d.candidate), ...t.unexplained];
  assert.ok(all.some((c) => /TS2304/.test(c.text)), "the type error must appear somewhere");
  assert.ok(all.some((c) => /ECONNREFUSED/.test(c.text)), "the connection error must appear somewhere");
  assert.ok(t.unexplained.length > 0, "two unrelated failures means one is not explained by the other");
});

test("colour codes and progress-bar rewrites do not hide the failure", () => {
  const t = look("ansi-progress.log");
  assert.equal(t.cause!.rule, "disk");
  assert.ok(!t.cause!.text.includes("\u001b"), "colour codes must be stripped from what is reported");
  assert.ok(t.totals.collapsedProgress >= 3, `collapsed ${t.totals.collapsedProgress} progress rewrites`);
});

test("line numbers point at the original file, so they can be looked up", () => {
  const t = look("docker-port-then-tests.log");
  const raw = fixture("docker-port-then-tests.log").split("\n");
  assert.match(raw[t.cause!.line - 1], /port is already allocated/, "the reported line number must match the file");
  for (const d of t.downstream.slice(0, 5)) {
    assert.ok(raw[d.candidate.line - 1].includes(d.candidate.text.slice(0, 20).trim()), `line ${d.candidate.line} does not contain what was reported`);
  }
});

test("--from skips a section without shifting the line numbers", () => {
  const whole = look("docker-port-then-tests.log");
  assert.match(whole.cause!.text, /port is already allocated/);
  // Skipping past the docker section leaves the tests, whose own first failure is the symptom.
  const later = triage(fixture("docker-port-then-tests.log"), { from: whole.cause!.line + 1 });
  assert.notEqual(later.cause!.line, whole.cause!.line);
  assert.ok(later.cause!.line > whole.cause!.line);
  const raw = fixture("docker-port-then-tests.log").split("\n");
  assert.ok(raw[later.cause!.line - 1].includes(later.cause!.text.slice(0, 20).trim()), "line numbers must still refer to the original file");
});

test("the format is detected and the evidence for the guess is kept", () => {
  assert.equal(look("docker-port-then-tests.log").detection.format, "jest");
  assert.equal(look("assertion-only.log").detection.format, "vitest");
  assert.equal(look("oom-cascade.log").detection.format, "gradle");
  assert.ok(look("docker-port-then-tests.log").detection.evidence.length > 0);
});

test("an empty log says nothing failed rather than crashing", () => {
  const t = triage("");
  assert.equal(t.cause, null);
  assert.equal(t.totals.candidates, 0);
});

test("a very large log is handled quickly", () => {
  const big = Array.from({ length: 60_000 }, (_, i) => i === 30_000 ? "ENOSPC: no space left on device" : `[info] processing item ${i} in /some/path/file-${i}.json`).join("\n");
  const started = Date.now();
  const t = triage(big);
  const took = Date.now() - started;
  assert.equal(t.cause!.rule, "disk");
  assert.equal(t.cause!.line, 30_001);
  assert.ok(took < 10_000, `took ${took} ms for 60,000 lines`);
});
