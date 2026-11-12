// Secrets come out of the log before anything else happens to it.
//
// This runs first, on the raw bytes, before the log is parsed, before any line is grouped and
// before a single byte reaches the model. CI logs are full of tokens: a job that exports a
// deploy key, a curl with a bearer header, a connection string in a stack trace. The point of
// running the model locally is that none of this leaves the machine, but a log also gets pasted
// into chat messages and bug reports, so it is worth taking out either way.

export interface Redaction { kind: string; count: number }

export interface Scrubbed { text: string; redactions: Redaction[] }

interface Pattern {
  kind: string;
  re: RegExp;
  /** Which capture group holds the secret. 0 means the whole match. */
  group?: number;
  /**
   * Variable names that only look secret. TOKEN_URL holds an address, not a token, and
   * PASSWORD_MIN_LENGTH holds a number; replacing either would damage the log for no gain.
   */
  skipName?: RegExp;
}

// Specific, well-known shapes first: a match here is certain rather than a guess.
const PATTERNS: Pattern[] = [
  { kind: "AWS access key id", re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  { kind: "GitHub token", re: /\b((?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}))\b/g, group: 1 },
  { kind: "Slack token", re: /\b(xox[baprse]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { kind: "Stripe key", re: /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, group: 1 },
  { kind: "Google API key", re: /\b(AIza[0-9A-Za-z_-]{30,})/g, group: 1 },
  { kind: "OpenAI-style key", re: /\b(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { kind: "npm token", re: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { kind: "JSON web token", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, group: 1 },
  { kind: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "password in a URL", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s/@]+)@/gi, group: 2 },
  { kind: "bearer token", re: /\b(?:bearer|token)[ \t]+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1 },
  { kind: "basic auth header", re: /\bbasic[ \t]+([A-Za-z0-9+/=]{12,})/gi, group: 1 },
  // A secret-looking assignment: the name says secret, so the value goes whatever it looks like.
  { kind: "secret in a variable", re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS|ACCESS_KEY)[A-Z0-9_]*)[ \t]*[=:][ \t]*["']?([^\s"',;]{6,})/g, group: 2, skipName: /(URL|URI|HOST|ENDPOINT|PATH|FILE|NAME|LENGTH|EXPIRY|TTL|TYPE|ENABLED|REQUIRED|MIN|MAX|COUNT|SIZE|VERSION|HEADER|FIELD|PREFIX|SUFFIX|FORMAT|ALGORITHM|ISSUER|AUDIENCE)$/ },
  { kind: "authorization header", re: /\b(authorization)["']?[ \t]*[=:][ \t]*["']?([^\s"',;]{8,})/gi, group: 2 },
];

const KEEP = new Set(["true", "false", "null", "undefined", "none", "empty", "redacted", "hidden", "[secure]", "***", "xxx"]);

/**
 * Replaces secrets with a label that says what was taken out, so the log stays readable and the
 * reader knows something was removed rather than wondering about a blank.
 */
export function scrub(text: string): Scrubbed {
  const counts = new Map<string, number>();
  let out = text;

  for (const p of PATTERNS) {
    out = out.replace(p.re, (match, ...groups) => {
      const idx = (p.group ?? 0) - 1;
      const secret = p.group ? String(groups[idx] ?? "") : match;
      if (!secret || KEEP.has(secret.toLowerCase()) || /^\*+$/.test(secret)) return match;
      // Scrubbing an already-scrubbed log must be a no-op, so this module's own labels are skipped.
      if (secret.startsWith("[")) return match;
      if (p.skipName && typeof groups[0] === "string" && p.skipName.test(groups[0])) return match;
      // A plain address is not a credential; a URL carrying one is handled by its own pattern.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(secret) && !/:[^/@]+@/.test(secret)) return match;
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      const label = `[${p.kind} removed]`;
      return p.group ? match.replace(secret, label) : label;
    });
  }

  return { text: out, redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count) };
}

/** True when the text still contains something that looks like a secret: used by the tests. */
export function looksSecret(text: string): string | null {
  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.replace("g", ""));
    const m = re.exec(text);
    if (m) {
      const secret = p.group ? m[p.group] : m[0];
      // A value that starts with "[" is one of this module's own replacement labels.
      if (secret && !secret.startsWith("[") && !secret.includes("removed]") && !KEEP.has(secret.toLowerCase())) return `${p.kind}: ${secret.slice(0, 24)}`;
    }
  }
  return null;
}
