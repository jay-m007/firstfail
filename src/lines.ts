// Getting from a raw log to numbered, comparable lines: colour codes, CI decorations and
// timestamps out of the way, with the original line numbers kept so every finding can point at
// the line in the file the person actually has.

export interface Line {
  /** 1-based line number in the original file, which is what gets reported. */
  n: number;
  /** The line with colour codes, timestamps and CI markers taken off. */
  text: string;
  /** The line as it was, for printing. */
  raw: string;
  /** Timestamp found at the start of the line, if any. */
  at: string | null;
  /** The CI group or section this line sits inside. */
  group: string | null;
}

// ANSI colour, cursor movement and the carriage returns progress bars leave behind.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB012]|\x1b[=>]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const TIMESTAMPS: RegExp[] = [
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s/,            // GitHub Actions, ISO
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s/,            // common application logs
  /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s/,                            // [12:34:56]
  /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s/,                                // 12:34:56
  /^\[(\d+\.\d+)\]\s/,                                               // kernel-style seconds
];

export interface Parsed { lines: Line[]; /** Trailing \r progress rewrites that were collapsed. */ collapsedProgress: number }

/** Splits a log into lines, keeping the original numbering. */
export function parseLines(text: string): Parsed {
  const out: Line[] = [];
  let group: string | null = null;
  let collapsedProgress = 0;

  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    let raw = rawLines[i].replace(/\r$/, "");
    // A progress bar rewrites one line over and over with carriage returns; only the last state matters.
    if (raw.includes("\r")) { const parts = raw.split("\r").filter((p) => p !== ""); collapsedProgress += Math.max(0, parts.length - 1); raw = parts[parts.length - 1] ?? ""; }
    let text2 = raw.replace(ANSI, "");

    let at: string | null = null;
    for (const re of TIMESTAMPS) {
      const m = re.exec(text2);
      if (m) { at = m[1]; text2 = text2.slice(m[0].length); break; }
    }

    // CI section markers. GitHub Actions uses ##[group], GitLab uses section_start, Azure uses ##[section].
    const gh = /^##\[(group|endgroup|section|command|debug|warning|error)\](.*)$/.exec(text2);
    if (gh) {
      if (gh[1] === "group" || gh[1] === "section") group = gh[2].trim() || group;
      else if (gh[1] === "endgroup") group = null;
      if (gh[1] === "group" || gh[1] === "endgroup" || gh[1] === "section") { out.push({ n: i + 1, text: "", raw, at, group }); continue; }
      text2 = gh[2];
    }
    const gitlab = /^section_(start|end):\d+:(\S+)/.exec(text2);
    if (gitlab) { group = gitlab[1] === "start" ? gitlab[2] : null; out.push({ n: i + 1, text: "", raw, at, group }); continue; }
    // Travis/CircleCI fold markers.
    if (/^travis_fold:(start|end):/.test(text2)) { out.push({ n: i + 1, text: "", raw, at, group }); continue; }

    out.push({ n: i + 1, text: text2.trimEnd(), raw, at, group });
  }
  return { lines: out, collapsedProgress };
}

export type Format = "github-actions" | "gitlab-ci" | "jest" | "vitest" | "mocha" | "pytest" | "go-test" | "maven" | "gradle" | "cargo" | "npm" | "docker" | "systemd" | "plain";

export interface Detection { format: Format; /** The lines that gave it away, so the guess can be checked. */ evidence: string[] }

const SIGNS: { format: Format; re: RegExp; what: string }[] = [
  { format: "github-actions", re: /^##\[(group|endgroup|section)\]|^Run \S|::(error|warning|notice)(\s|::)/m, what: "GitHub Actions markers" },
  { format: "gitlab-ci", re: /^section_(start|end):\d+:/m, what: "GitLab section markers" },
  { format: "jest", re: /^(PASS|FAIL)\s+\S+|^Tests:\s+\d+ (passed|failed)|● .+ › /m, what: "Jest output" },
  // A bare tick or cross is used by too many tools to identify one, so vitest is only claimed on
  // something only vitest prints.
  { format: "vitest", re: /Test Files\s+\d+ (passed|failed)|\bvitest\b/m, what: "Vitest output" },
  { format: "mocha", re: /^\s+\d+\) |^\s+\d+ (passing|failing)/m, what: "Mocha output" },
  { format: "pytest", re: /={5,} (test session starts|FAILURES|short test summary) ={5,}|^(FAILED|ERROR) \S+::/m, what: "pytest output" },
  { format: "go-test", re: /^(---|===) (FAIL|RUN|PASS)[:\s]|^(FAIL|ok)\s+\S+\s+\d+\.\d+s/m, what: "go test output" },
  { format: "maven", re: /^\[(INFO|ERROR|WARNING)\]|BUILD FAILURE/m, what: "Maven output" },
  { format: "gradle", re: /^> Task :|FAILURE: Build failed with an exception/m, what: "Gradle output" },
  { format: "cargo", re: /^(error\[E\d+\]|warning: unused)|^\s+Compiling \S+ v/m, what: "cargo output" },
  { format: "docker", re: /^(#\d+ \[|Step \d+\/\d+ :)/m, what: "docker build output" },
  { format: "systemd", re: /^\w{3} \d{2} \d{2}:\d{2}:\d{2} \S+ \S+\[\d+\]:/m, what: "systemd journal format" },
  { format: "npm", re: /^npm (ERR!|WARN)|^> \S+@\S+ \S+$/m, what: "npm output" },
];

/** Works out which tool produced the log. Several can match; the most specific wins. */
export function detect(lines: Line[]): Detection {
  const text = lines.map((l) => l.text).join("\n");
  const hits = SIGNS.filter((s) => s.re.test(text));
  if (!hits.length) return { format: "plain", evidence: [] };
  // A test runner is more useful to know about than the CI system wrapping it.
  const order: Format[] = ["jest", "vitest", "pytest", "go-test", "mocha", "cargo", "maven", "gradle", "npm", "docker", "systemd", "github-actions", "gitlab-ci"];
  const best = order.find((f) => hits.some((h) => h.format === f)) ?? hits[0].format;
  return { format: best, evidence: hits.map((h) => h.what) };
}
