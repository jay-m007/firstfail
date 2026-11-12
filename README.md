# firstfail

The one real failure in a CI log, and the noise it caused.

```
$ firstfail ci-run-4471.log

  scrubbed 1 AWS access key id, 1 GitHub token, 1 password in a URL before anything else read the log

  cause  line 6  [infrastructure]

           4  Container app-postgres-1  Creating
           5  Container app-postgres-1  Creating
    →      6  Error response from daemon: driver failed programming external connectivity on
             endpoint app-postgres-1: Bind for 0.0.0.0:5432 failed: port is already allocated
           7  ##[endgroup]

  The database port was already taken, so postgres never started and nothing could connect.

  why this line
    · line 6 is the earliest environment failure in the log, and infrastructure failures
      explain the kinds of failure below it
    · something was already on that port, so the server never started

  followed from it  35 lines
        10  FAIL test/orders-0.test.ts
        12  connect ECONNREFUSED 127.0.0.1:5432
             and 31 more, all after line 6
             a test-failure after an infrastructure failure is usually its consequence

  noise  48 lines (84%) are repeats of 5 lines
       x11  connect ECONNREFUSED 127.0.0.1:5432

  57 lines of jest log, 36 of them error-shaped
  every line number above is the line in the file you gave, so sed -n '6p' will show it
```

Eleven failing tests, one cause. The eleven `ECONNREFUSED` lines are the loudest thing in that log
and none of them is the problem.

## The idea

A cause comes before its effects, and some kinds of failure can explain others while the reverse
never happens. A database that was not listening explains eleven failed tests. Eleven failed tests
never explain a database that was not listening.

So each error-shaped line gets a kind — environment, something missing, a build error, a timeout, an
assertion, a test failure, an exit code — and a score for how well it can explain the rest. A line
that appears eleven times loses points for being one of a crowd, because a repeated line is a symptom
being echoed, not the moment something broke. The highest score wins, and the earliest line wins ties.

Then everything after the cause that it could account for is folded away as consequence, and anything
it *cannot* account for is listed separately under **not explained by it**, because that is a second
problem hiding behind the first.

## Secrets go first

Scrubbing runs on the raw bytes, before the log is parsed, before a line is classified, and before
any of it reaches the model. It removes AWS keys, GitHub, Slack, Stripe, Google, OpenAI and npm
tokens, JWTs, private key blocks, passwords inside connection strings, bearer and basic auth headers,
and anything assigned to a variable whose name contains SECRET, TOKEN, PASSWORD, API_KEY or
CREDENTIALS. What was removed is counted and named at the top of the output.

It is careful about what it leaves alone: `TOKEN_URL=https://auth.example.com/token` is an address,
`PASSWORD_MIN_LENGTH=8` is a number, and `PASSWORD=***` is already redacted. A commit sha is not a
secret. Running it on an already-scrubbed log changes nothing.

`firstfail log.txt --scrubbed` prints just the cleaned log, which is the version you can paste into a
bug report.

## What the model is for

The rules pick the cause. The model is handed the handful of lines the rules already flagged,
numbered, and asked two things: which line started it, and one sentence about why.

Asking it to *choose from a list* is what makes the answer checkable. If it returns a number it was
never offered, the answer is thrown away. If its sentence mentions a line number it was not given,
the answer is thrown away. Where it picks a different line from the rules, the rules' answer is still
what gets reported and the disagreement is printed underneath — it is usually worth a look.

It never sees the whole log, only the candidates: a dozen lines, well inside what a 1B model can hold.

```
firstfail log.txt --show-prompt     # exactly what the model would be asked
firstfail log.txt --no-model        # rules only
```

## Install

Needs Node 22.18 or newer, which runs TypeScript directly.

```
git clone https://github.com/jay-m007/firstfail
cd firstfail && npm install && npm link
ollama pull llama3.2:1b
```

```
firstfail ci-run.log
cat ci-run.log | firstfail
gh run view 4471 --log-failed | firstfail
firstfail ci-run.log --from 2000     # ignore the setup section
firstfail ci-run.log -v              # every downstream line and noise group
firstfail ci-run.log --json
```

It recognises GitHub Actions, GitLab CI, Jest, Vitest, Mocha, pytest, go test, Maven, Gradle, cargo,
npm, docker build and systemd output, strips ANSI colour, collapses progress bars that rewrite one
line with carriage returns, and understands CI group markers and leading timestamps.

## Honest limits

- **These are heuristics, and the output says which one fired.** Every verdict names the rule and the
  reasoning, so when it is wrong you can see why rather than guessing. The rule list is in
  `src/classify.ts`, about 30 patterns.
- **Line numbers refer to the file you gave it.** Nothing is renumbered, which is why the output ends
  with the `sed` command to look up the cause.
- **It reads one log, with no memory.** It cannot tell you this test has been flaky for a week, that
  the failure started after a particular commit, or that a timeout is really a slow CI runner.
- **An interleaved log confuses it.** Parallel jobs writing to one stream, or a log where several
  tools' output is mixed line by line, break the assumption that earlier means causally first.
- **A cause that never prints anything cannot be found.** A silently truncated log, a job killed
  without a message, or a failure whose only sign is a non-zero exit code leaves it with nothing to
  point at, and it will say the exit code is the cause because that is all there is.
- **"Production" and severity come from words.** A line containing `error` in prose can be picked up,
  though lines about error *handling*, deprecations and stack frames are deliberately excluded.
- **Assertion failures are ranked low on purpose.** Usually they are the symptom. When a test really
  is the only thing wrong, that is exactly what gets reported, but in a log with an environment
  failure anywhere above them they will be folded into the consequences — including, occasionally,
  when they were genuinely separate.
- **The scrubber is a safety net, not a guarantee.** It catches well-known token shapes and
  secret-looking assignments. A credential with no recognisable shape, in a variable with an innocent
  name, will get through. Do not rely on it as your only protection.
- **The model's sentence is still generated text.** Its line choice is checked against the candidate
  list and anything unsupported is dropped, but the sentence itself can emphasise the wrong thing.
  The rules' reasoning is printed next to it so the two can be compared.

## Development

```
npm test          # 63 tests, no network and no model needed
npm run typecheck
npm run eval      # needs Ollama; scores the model against logs whose cause is known
```

The tests run on fixture logs covering a docker port clash that fails eleven tests, a genuine
assertion failure with nothing else wrong, an out-of-memory cascade, a clean passing log, a log full
of credentials, a pytest import error, two unrelated failures in one log, a node:test run where a
*passing* test is named "gives a readable error", and a log of ANSI colour and progress-bar rewrites.
Each one checks both the verdict and that the reported line numbers still point at the right lines of
the original file.

Two of those fixtures come from bugs found by running it against a real failed GitHub Actions log
rather than against anything written by hand: a passing test whose name contained the word "error"
outranked the test that actually failed, and the cross character node:test uses (`✖`) was not in the
pattern at all, so the real failing line was never even a candidate.

MIT licensed.
