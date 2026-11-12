import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { secretsLog, MUST_NOT_SURVIVE } from "./secrets.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const FIX = join(import.meta.dirname, "fixtures");

/** The credential-laden log is built at run time rather than committed. */
const secretsFile = (() => { const p = join(mkdtempSync(join(tmpdir(), "firstfail-")), "deploy.log"); writeFileSync(p, secretsLog()); return p; })();

function ff(args: string[], input?: string): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: input ?? "", env: { ...process.env, NO_COLOR: "1", FIRSTFAIL_MODEL: "off" } }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.status ?? -1 };
  }
}

test("a failing log gives the cause, the lines it caused and the noise", () => {
  const r = ff([join(FIX, "docker-port-then-tests.log")]);
  assert.equal(r.code, 0);
  assert.match(r.out, /cause\s+line 6/);
  assert.match(r.out, /port is already allocated/);
  assert.match(r.out, /followed from it/);
  assert.match(r.out, /noise/);
  assert.match(r.out, /x11/);
});

test("the reported line number is right, so sed can find it", () => {
  const r = ff([join(FIX, "docker-port-then-tests.log")]);
  const m = /sed -n '(\d+)p'/.exec(r.out);
  assert.ok(m, "the output should tell you how to look up the line");
  const line = execFileSync("sed", ["-n", `${m![1]}p`, join(FIX, "docker-port-then-tests.log")], { encoding: "utf8" });
  assert.match(line, /port is already allocated/);
});

test("a clean log exits 1 and says nothing failed", () => {
  const r = ff([join(FIX, "clean.log")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /no failure found/);
});

test("it reads standard input", () => {
  const r = ff([], "Run build\nENOSPC: no space left on device\nbuild failed\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /no space left on device/);
});

test("the scrubbing is announced before anything else", () => {
  const r = ff([secretsFile]);
  const scrubbedAt = r.out.indexOf("scrubbed");
  const causeAt = r.out.indexOf("cause");
  assert.ok(scrubbedAt >= 0 && scrubbedAt < causeAt, "the reader should know a secret was removed before reading the verdict");
  assert.match(r.out, /AWS access key id/);
});

test("--scrubbed prints a log that is safe to paste into a bug report", () => {
  const r = ff([secretsFile, "--scrubbed"]);
  assert.equal(r.code, 0);
  for (const secret of MUST_NOT_SURVIVE) assert.ok(!r.out.includes(secret), `${secret} survived --scrubbed`);
  assert.match(r.out, /Connection refused/, "the actual log must still be there");
});

test("--json carries the cause, the reasoning and the redactions", () => {
  const r = ff([join(FIX, "oom-cascade.log"), "--json"]);
  const parsed = JSON.parse(r.out) as { cause: { rule: string }; reasoning: string[]; downstream: unknown[]; format: string };
  assert.equal(parsed.cause.rule, "oom");
  assert.ok(parsed.reasoning.length > 0);
  assert.ok(parsed.downstream.length > 0);
});

test("--show-prompt prints only the candidate lines", () => {
  const r = ff([join(FIX, "docker-port-then-tests.log"), "--show-prompt"]);
  assert.match(r.out, /^the log came from: jest$/m);
  assert.ok(!r.out.includes("cause  line"), "only the prompt is printed");
  assert.ok(r.out.split("\n").length < 25);
});

test("-v shows every downstream line instead of the first few", () => {
  const brief = ff([join(FIX, "docker-port-then-tests.log")]);
  const full = ff([join(FIX, "docker-port-then-tests.log"), "-v"]);
  assert.ok(full.out.split("\n").length > brief.out.split("\n").length);
});

test("a missing file is reported clearly", () => {
  const r = ff(["/tmp/definitely-not-here.log"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /no such file/);
});

test("an unknown option is refused", () => {
  assert.equal(ff(["--nonsense"]).code, 2);
});

test("help is available", () => {
  assert.match(ff(["--help"]).out, /the one real failure in a log/);
});

test("two unrelated failures are both visible in the output", () => {
  const r = ff([join(FIX, "two-failures.log")]);
  assert.match(r.out, /not explained by it/);
  assert.match(r.out, /TS2304/);
});
