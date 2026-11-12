import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub, looksSecret } from "../src/scrub.ts";
import { SAMPLES, EXAMPLES } from "./secrets.ts";

for (const [kind, line, secret] of SAMPLES) {
  test(`${kind} is removed: ${secret.slice(0, 14)}…`, () => {
    const r = scrub(line);
    assert.ok(!r.text.includes(secret), `the secret survived: ${r.text}`);
    assert.ok(r.redactions.length > 0, "the redaction must be reported");
    assert.match(r.text, /removed\]/, "something should say what was taken out");
  });
}

test("a private key block is removed whole", () => {
  const r = scrub(`ssh setup\n${EXAMPLES.privateKey}\ndone`);
  assert.ok(!r.text.includes("MIIEowIBAAKCAQEA1234"));
  assert.match(r.text, /ssh setup/);
  assert.match(r.text, /done/);
});

test("what is taken out is counted and named", () => {
  const r = scrub(`${EXAMPLES.awsKeyId} and ${EXAMPLES.awsKeyId.slice(0, -1)}X and ${EXAMPLES.githubToken}`);
  const aws = r.redactions.find((x) => x.kind === "AWS access key id");
  assert.equal(aws?.count, 2);
  assert.ok(r.redactions.some((x) => x.kind === "GitHub token"));
});

test("ordinary log lines are left exactly as they are", () => {
  const log = [
    "NODE_ENV=production",
    "DEBUG=true",
    "npm notice package: api@1.2.3",
    "connect ECONNREFUSED 127.0.0.1:5432",
    "GET /api/orders 200 14ms",
    "commit a4e2a90f1234567890abcdef1234567890abcdef",
    "TOKEN_URL=https://auth.example.com/token",
    "PASSWORD_MIN_LENGTH=8",
  ].join("\n");
  const r = scrub(log);
  assert.equal(r.text, log, `a line was altered:\n${r.text}`);
  assert.deepEqual(r.redactions, []);
});

test("a placeholder is not treated as a secret", () => {
  for (const line of ["PASSWORD=***", "API_TOKEN=[secure]", "SECRET=redacted", "DB_PASSWORD=null"]) {
    assert.deepEqual(scrub(line).redactions, [], `${line} should be left alone`);
  }
});

test("scrubbing twice changes nothing the second time", () => {
  const once = scrub(`AWS_SECRET_ACCESS_KEY=${EXAMPLES.awsSecret}`);
  const twice = scrub(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.redactions, []);
});

test("the check for leftovers does not flag the replacement labels", () => {
  assert.equal(looksSecret(scrub(`AWS_SECRET_ACCESS_KEY=${EXAMPLES.awsSecret}`).text), null);
  assert.equal(looksSecret(scrub(`Authorization: Bearer ${EXAMPLES.bearer}`).text), null);
});

test("a line is still readable after its secret is taken out", () => {
  const r = scrub("psql postgres://deploy:hunter2@db.prod.internal:5432/app -c 'select 1'");
  assert.match(r.text, /db\.prod\.internal:5432\/app/, "the host is what makes the line useful");
  assert.match(r.text, /deploy/, "the username is not the secret");
  assert.ok(!r.text.includes("hunter2"));
});
