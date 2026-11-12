# firstfail

CLI that finds the one real failure in a CI log and separates it from the noise it caused. Secrets
are scrubbed before anything, including the model, sees a byte.

## Commands
- `npm test`: offline test suite (node:test; fixture logs in `test/fixtures`)
- `npm run typecheck`: `tsc --noEmit`
- `node src/cli.ts <logfile>`: triage a log (Node 22.18+ runs .ts directly)
- `node src/cli.ts <logfile> --show-prompt`: print exactly what the model would be asked
- `npm run eval`: score the model against logs whose cause is known in advance

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Zero runtime dependencies. Use node: built-ins only.
- Scrubbing runs first, on the raw text, before parsing, classification or any model call. Add a test for every new secret shape, and a test that an innocent lookalike is left alone.
- Line numbers always refer to the original file. Never renumber, and never report a line that cannot be found with sed.
- The rules decide the cause, not the model. The model picks from the candidate lines by number; a number it was not offered, or a line number in its prose that it was not given, means the answer is thrown away.
- Never claim a cause the evidence does not support: every verdict names the rule that fired and the reasoning behind it.
- Add a test for every new rule or classification change, with a fixture log rather than a synthetic string where it is a realistic case.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.
