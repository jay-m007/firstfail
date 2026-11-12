// Test material for the scrubber, assembled at run time from fragments.
//
// Every value below is a published example credential, not a real one, but a file containing the
// literal patterns would be caught by GitHub's own push protection and by every scanner in CI —
// which is exactly the behaviour this tool exists to help with. So the pieces are joined here
// instead, and nothing in the repository ever contains a contiguous credential shape.

const j = (...parts: string[]): string => parts.join("");

export const EXAMPLES = {
  awsKeyId: j("AKIA", "IOSFODNN7", "EXAMPLE"),
  awsSecret: j("wJalrXUtnFEMI/", "K7MDENG/bPxRfiCY", "EXAMPLEKEY"),
  githubToken: j("ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"),
  githubPat: j("github_pat_", "11ABCDEFG0", "abcdefghijklmnop"),
  slackToken: j("xoxb-", "123456789012-", "abcdefghijkl"),
  stripeKey: j("sk_", "live_", "abcdefghijklmnopqrstuvwx"),
  googleKey: j("AIza", "SyA1234567890", "abcdefghijklmnopqrstuvw"),
  npmToken: j("npm_", "abcdefghijklmnopqrstuvwxyz", "0123456789"),
  jwt: j("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  dbPassword: "sup3rs3cret",
  bearer: "abcdefghijklmnopqrstuvwxyz",
  envSecret: "correcthorsebattery",
  apiKey: "zyxwvutsrqponmlkjihg",
  privateKey: [`-----BEGIN RSA PRIVATE KEY-----`, "MIIEowIBAAKCAQEA1234", "abcdef", `-----END RSA PRIVATE KEY-----`].join("\n"),
};

/** One line per secret shape: the kind it should be reported as, the line, and the secret in it. */
export const SAMPLES: [string, string, string][] = [
  ["AWS access key id", `export AWS_ACCESS_KEY_ID=${EXAMPLES.awsKeyId}`, EXAMPLES.awsKeyId],
  ["GitHub token", `token ${EXAMPLES.githubToken}`, EXAMPLES.githubToken],
  ["GitHub token", `GH_PAT=${EXAMPLES.githubPat}`, EXAMPLES.githubPat],
  ["Slack token", `SLACK=${EXAMPLES.slackToken}`, EXAMPLES.slackToken],
  ["Stripe key", `key ${EXAMPLES.stripeKey}`, EXAMPLES.stripeKey],
  ["Google API key", EXAMPLES.googleKey, EXAMPLES.googleKey],
  ["npm token", `//registry.npmjs.org/:_authToken=${EXAMPLES.npmToken}`, EXAMPLES.npmToken],
  ["JSON web token", `Cookie: s=${EXAMPLES.jwt}`, EXAMPLES.jwt.slice(0, 20)],
  ["password in a URL", `psql postgres://app:${EXAMPLES.dbPassword}@db:5432/app`, EXAMPLES.dbPassword],
  ["bearer token", `Authorization: Bearer ${EXAMPLES.bearer}`, EXAMPLES.bearer],
  ["secret in a variable", `DATABASE_PASSWORD=${EXAMPLES.envSecret}`, EXAMPLES.envSecret],
  ["secret in a variable", `API_KEY: "${EXAMPLES.apiKey}"`, EXAMPLES.apiKey],
];

/** A deploy log with credentials all over it and one real failure at the end. */
export function secretsLog(): string {
  return [
    "Run deploy.sh",
    `+ export AWS_ACCESS_KEY_ID=${EXAMPLES.awsKeyId}`,
    `+ export AWS_SECRET_ACCESS_KEY=${EXAMPLES.awsSecret}`,
    `+ curl -H 'Authorization: Bearer ${EXAMPLES.githubToken}' https://api.github.com/user`,
    `+ psql postgres://deploy:hunter2@db.prod.internal:5432/app -c 'select 1'`,
    `psql: error: connection to server at "db.prod.internal" (10.0.0.4), port 5432 failed: Connection refused`,
    "+ echo 'deploy failed'",
    "deploy failed",
    "##[error]Process completed with exit code 2.",
  ].join("\n") + "\n";
}

/** The values that must never survive scrubbing, for a blanket check. */
export const MUST_NOT_SURVIVE = [EXAMPLES.awsKeyId, EXAMPLES.awsSecret.slice(0, 13), EXAMPLES.githubToken, "hunter2"];
