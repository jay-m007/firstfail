import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { triage } from "../src/triage.ts";
import { ask, prompt, offer } from "../src/ask.ts";
import { startFake, linesInPrompt, promptOf } from "./fake-ollama.ts";
import { secretsLog, MUST_NOT_SURVIVE } from "./secrets.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const look = (name: string) => triage(fixture(name));
const opts = (host: string, timeoutMs = 5000) => ({ host, model: "test-model", timeoutMs });

test("an explanation that picks an offered line is kept", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  fake.replies.push({ cause_line: t.cause!.line, explanation: "The database port was taken, so nothing could connect to it." });
  const x = await ask(t, opts(fake.host));
  assert.match(x.text!, /port was taken/);
  assert.equal(x.picked, t.cause!.line);
  assert.equal(x.agrees, true);
  await fake.close();
});

test("a line the model was never offered is refused", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  fake.replies.push({ cause_line: 99999, explanation: "Something went wrong." });
  const x = await ask(t, opts(fake.host));
  assert.equal(x.text, null);
  assert.equal(x.invented, 99999);
  assert.match(x.skipped!, /not one of the lines it was given/);
  await fake.close();
});

test("an explanation naming a line it was not given is refused", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  fake.replies.push({ cause_line: t.cause!.line, explanation: "See line 4242 where the pool was exhausted." });
  const x = await ask(t, opts(fake.host));
  assert.equal(x.text, null);
  assert.equal(x.invented, 4242);
  await fake.close();
});

test("the model disagreeing with the rules is recorded rather than hidden", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  const other = offer(t).find((c) => c.line !== t.cause!.line)!;
  fake.replies.push({ cause_line: other.line, explanation: "The tests could not reach the database." });
  const x = await ask(t, opts(fake.host));
  assert.equal(x.agrees, false);
  assert.equal(x.picked, other.line);
  assert.ok(x.text, "a disagreement is still worth showing");
  await fake.close();
});

test("the model is only ever shown candidate lines, never the whole log", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  fake.replies.push({ cause_line: t.cause!.line, explanation: "ok." });
  await ask(t, opts(fake.host));
  const p = promptOf(fake);
  const offered = offer(t).length;
  assert.ok(offered <= 12, `offered ${offered} lines`);
  assert.deepEqual(linesInPrompt(fake), offer(t).map((c) => c.line));
  assert.ok(!p.includes("at Connection.connect"), "stack frames are not candidates and should not be sent");
  assert.ok(p.split("\n").length < 25, `the prompt was ${p.split("\n").length} lines, too long for a 1B model`);
  await fake.close();
});

test("secrets never reach the model, even when the failing line is next to one", async () => {
  const fake = await startFake();
  const t = triage(secretsLog());
  fake.replies.push({ cause_line: t.cause!.line, explanation: "The database refused the connection." });
  await ask(t, opts(fake.host));
  const sent = JSON.stringify(fake.requests);
  for (const secret of MUST_NOT_SURVIVE) assert.ok(!sent.includes(secret), `${secret} was sent to the model`);
  await fake.close();
});

test("a timeout, a dead Ollama and a missing model are all reported in words", async () => {
  const t = look("docker-port-then-tests.log");
  const fake = await startFake();
  fake.replies.push(600);
  assert.match((await ask(t, opts(fake.host, 120))).skipped!, /did not answer within/);
  fake.fail = 404;
  assert.match((await ask(t, opts(fake.host))).skipped!, /ollama pull test-model/);
  fake.fail = 500;
  assert.match((await ask(t, opts(fake.host))).skipped!, /returned 500/);
  await fake.close();
  assert.match((await ask(t, opts("http://127.0.0.1:1", 500))).skipped!, /not reachable/);
});

test("junk instead of json is reported, not thrown", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  for (const junk of ["not json", JSON.stringify({ cause_line: "nine", explanation: "x" }), "{}", JSON.stringify({ cause_line: 9 })]) {
    fake.replies.push(junk);
    const x = await ask(t, opts(fake.host));
    assert.equal(x.text, null, `junk accepted: ${junk}`);
  }
  await fake.close();
});

test("nothing is asked when the log contains no failure", async () => {
  const fake = await startFake();
  const x = await ask(look("clean.log"), opts(fake.host));
  assert.equal(fake.requests.length, 0);
  assert.match(x.skipped!, /nothing in the log looks like a failure/);
  await fake.close();
});

test("a rambling explanation is cut to one sentence", async () => {
  const fake = await startFake();
  const t = look("docker-port-then-tests.log");
  fake.replies.push({ cause_line: t.cause!.line, explanation: "The port was in use. Then the tests failed. Then everything else failed too. And more." });
  const x = await ask(t, opts(fake.host));
  assert.equal(x.text, "The port was in use.");
  await fake.close();
});

test("the prompt names the log format and the repeat counts", () => {
  const p = prompt(look("docker-port-then-tests.log"));
  assert.match(p, /came from: jest/);
  assert.match(p, /repeated lines: 11x/);
});

test("the cause is always among the lines offered", () => {
  for (const name of ["docker-port-then-tests.log", "oom-cascade.log", "two-failures.log", "pytest-missing-module.log"]) {
    const t = look(name);
    assert.ok(offer(t).some((c) => c.line === t.cause!.line), `${name}: the cause was not offered to the model`);
  }
});
