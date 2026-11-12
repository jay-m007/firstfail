// Deciding which lines are worth looking at, and which of those could be the cause rather than
// an effect. Every rule here is a pattern over one line plus the few lines after it; the ordering
// between them is the part that does the real work.

import type { Line } from "./lines.ts";

/**
 * A candidate's kind decides whether it can be a root cause. The separation that matters is
 * between something the environment did to the job (a port that was not listening, a disk that
 * filled, a process the kernel killed) and something the code said about itself (an assertion
 * that failed). The first kind explains the second; the second never explains the first.
 */
export type Kind =
  | "infrastructure"   // connection refused, DNS, permissions, disk, memory, killed
  | "missing"          // a module, file, binary or package that is not there
  | "compile"          // syntax, type and build errors
  | "timeout"          // something waited and gave up
  | "assertion"        // a test said the value was wrong
  | "test-failure"     // a test runner naming a failed test
  | "exit"             // a process exited non-zero
  | "error"            // something called itself an error and nothing more specific matched
  ;

export interface Candidate {
  line: number;
  text: string;
  kind: Kind;
  /** The rule that matched, so a verdict can be traced back to it. */
  rule: string;
  /** Can this be the thing that started it: higher means more likely to be the cause. */
  rootScore: number;
  /** What this line means, in words, when the pattern is specific enough to say. */
  meaning: string | null;
}

interface Rule { id: string; kind: Kind; re: RegExp; root: number; meaning?: string }

// rootScore: 90+ explains everything after it, 50 is a real failure but probably caused by
// something above it, 20 is a symptom that is almost never the cause.
const RULES: Rule[] = [
  // The environment failed the job.
  { id: "conn-refused", kind: "infrastructure", re: /\b(ECONNREFUSED|connection refused|could not connect to server|Can't connect to \w+ server|Connection refused)\b/i, root: 95, meaning: "nothing was listening on that address, so whatever needed it could not start" },
  { id: "dns", kind: "infrastructure", re: /\b(ENOTFOUND|EAI_AGAIN|Name or service not known|Temporary failure in name resolution|no such host)\b/i, root: 95, meaning: "a hostname did not resolve, which is usually a network or service-name problem rather than a code problem" },
  { id: "conn-reset", kind: "infrastructure", re: /\b(ECONNRESET|socket hang up|Connection reset by peer|EPIPE)\b/i, root: 80, meaning: "the other end dropped the connection part-way" },
  { id: "oom", kind: "infrastructure", re: /\b(out of memory|OOMKilled|Killed process|JavaScript heap out of memory|MemoryError|Cannot allocate memory|java\.lang\.OutOfMemoryError)\b/i, root: 98, meaning: "the process ran out of memory and was stopped, so anything it was doing stopped with it" },
  { id: "killed", kind: "infrastructure", re: /\b(signal (SIGKILL|SIGTERM|9|15)|Killed\b|received signal|terminated by signal)\b/i, root: 85, meaning: "the process was killed from outside rather than exiting on its own" },
  { id: "disk", kind: "infrastructure", re: /\b(ENOSPC|No space left on device|disk quota exceeded)\b/i, root: 98, meaning: "the disk filled up, so any write after this point failed too" },
  { id: "perms", kind: "infrastructure", re: /\b(EACCES|EPERM|permission denied|Operation not permitted|Permission denied)\b/i, root: 88, meaning: "the job did not have permission, which no retry will change" },
  { id: "port-in-use", kind: "infrastructure", re: /\b(EADDRINUSE|address already in use|port is already allocated)\b/i, root: 92, meaning: "something was already on that port, so the server never started" },
  { id: "auth", kind: "infrastructure", re: /\b(401 Unauthorized|403 Forbidden|authentication failed|invalid credentials|permission to .+ denied|bad credentials)\b/i, root: 90, meaning: "a credential was missing or wrong" },
  { id: "rate-limit", kind: "infrastructure", re: /\b(429 Too Many Requests|rate limit exceeded|too many requests)\b/i, root: 90, meaning: "a service refused the job for asking too often" },
  { id: "segfault", kind: "infrastructure", re: /\b(Segmentation fault|SIGSEGV|core dumped|panic: runtime error|fatal error: unexpected signal)\b/i, root: 96, meaning: "a process crashed outright" },

  // Something was not there.
  { id: "module-not-found", kind: "missing", re: /\b(MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named|Could not resolve|Module not found|cannot find package)\b/i, root: 94, meaning: "an import pointed at something that is not installed, so nothing downstream of it could run" },
  { id: "file-not-found", kind: "missing", re: /\b(ENOENT|No such file or directory|FileNotFoundError|could not open file)\b/i, root: 86, meaning: "a file the job expected was not there" },
  { id: "command-not-found", kind: "missing", re: /\b(command not found|not recognized as an internal|is not installed|executable file not found)\b/i, root: 93, meaning: "a program the job runs is not on the machine" },
  { id: "package-missing", kind: "missing", re: /\b(404 Not Found - GET https:\/\/registry|No matching distribution found|Could not find a version that satisfies)\b/i, root: 92, meaning: "a dependency could not be downloaded" },

  // The code did not build.
  { id: "syntax", kind: "compile", re: /\b(SyntaxError|ParseError|unexpected token|expected .+ but found|IndentationError)\b/i, root: 93, meaning: "the code could not be parsed, so nothing after it ran" },
  { id: "type-error", kind: "compile", re: /\b(error TS\d+|error\[E\d+\]|type error|cannot find name|Type .+ is not assignable)\b/i, root: 90, meaning: "the build failed type checking" },
  { id: "compile", kind: "compile", re: /\b(compilation (error|failed)|BUILD FAILURE|Build failed|error: could not compile|FAILURE: Build failed)\b/i, root: 70, meaning: "the build failed, usually because of a more specific error above this line" },
  { id: "import-error", kind: "compile", re: /\b(ImportError|cannot import name|ReferenceError: \w+ is not defined)\b/i, root: 88 },

  // Waiting.
  { id: "timeout", kind: "timeout", re: /\b(ETIMEDOUT|timed out|Timeout .* exceeded|timeout of \d+ms exceeded|context deadline exceeded|Exceeded timeout of)\b/i, root: 72, meaning: "something waited and gave up, which can be the cause or just the first thing to notice" },
  { id: "deadlock", kind: "timeout", re: /\b(deadlock detected|lock wait timeout)\b/i, root: 85 },

  // What tests say.
  { id: "assertion", kind: "assertion", re: /\b(AssertionError|expected .+ (to equal|to be|but (got|received))|assert(ion)? failed|Expected:.*Received:|should (equal|be))\b/i, root: 30, meaning: "a test compared two values and they differed, which is the usual way a cause further up shows itself" },
  // The cross is written differently by every runner: ✕ (jest), ✗, ✖ (node:test), × (vitest), ❌.
  { id: "jest-fail", kind: "test-failure", re: /^\s*(●|[✕✗✖×❌]|FAIL|not ok)\s*\S|^\s*\d+\)\s+\S|^(FAILED|ERROR)\s+\S+::|^--- FAIL:/, root: 25, meaning: "a test runner naming a test that failed" },
  { id: "test-summary", kind: "test-failure", re: /\b(\d+ (failed|failing|failures)|Tests:\s+\d+ failed|Test Files\s+\d+ failed)\b/i, root: 15, meaning: "a count of failures, which is a summary rather than a cause" },

  // Generic last resorts.
  { id: "nonzero-exit", kind: "exit", re: /\b(exit(ed)? (with )?(code|status) [1-9]\d*|Process completed with exit code [1-9]\d*|npm ERR! code E?[1-9])\b/i, root: 20, meaning: "a process reported failure; the reason is above this line" },
  { id: "fatal", kind: "error", re: /\b(FATAL|fatal error|panic|unhandled (exception|rejection)|Uncaught \w*Error)\b/i, root: 75 },
  { id: "error-line", kind: "error", re: /(^|\s)(error|ERROR|Error:|##\[error\]|npm ERR!|\[ERROR\]|E\/)\b/, root: 40 },
];

/**
 * A test that passed is never a failure, however it is named. This matters more than it sounds:
 * a passing test called "a crashing app gives a readable error with its log" contains the word
 * error, and without this rule it outranks the test that actually failed two lines below it.
 */
const PASSED = /^\s*(✔|✓|√|ok\s+\d|PASS\b|--- PASS|\[PASS\])/;

/** Lines that say "error" but are only telling you about handling errors, not reporting one. */
const NOT_REALLY = [
  /\b(error|warning)s?\s*[:=]\s*(0|none|\[\])\b/i,
  /\b(no errors|0 errors|without error|error handling|onError|errorMessage|catch\s*\(|error_log|--quiet|ignore-errors|errorlevel|set \+e)\b/i,
  /\b(deprecat|warning)\b/i,
  /^\s*(at|from|File ")/,            // stack frames belong to the error above them
  /\berror\b.*\bexpected\b.*\btest\b/i,
];

export function classifyLine(l: Line): Candidate | null {
  const text = l.text.trim();
  if (!text || text.length < 3) return null;
  if (PASSED.test(text)) return null;
  if (NOT_REALLY.some((re) => re.test(text))) {
    // A stack frame or a deprecation is not a candidate, unless it also carries a hard failure.
    if (!RULES.slice(0, 20).some((r) => r.re.test(text))) return null;
  }
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    return { line: l.n, text: text.slice(0, 400), kind: r.kind, rule: r.id, rootScore: r.root, meaning: r.meaning ?? null };
  }
  return null;
}

export function candidates(lines: Line[]): Candidate[] {
  const out: Candidate[] = [];
  for (const l of lines) {
    const c = classifyLine(l);
    if (c) out.push(c);
  }
  return out;
}

export const KINDS: Kind[] = ["infrastructure", "missing", "compile", "timeout", "assertion", "test-failure", "exit", "error"];
