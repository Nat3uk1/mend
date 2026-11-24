[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nat3uk1/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nat3uk1/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies AI-written edits in every format models produce, to one written
specification (`SPEC.md`):

- unified diffs, including wrong line numbers, drifted whitespace and renames;
- SEARCH/REPLACE blocks, with or without code fences and prose around them;
- V4A patches (`*** Begin Patch` … `*** End Patch`), with anchored and end-of-file chunks and moves;
- JSON text-editor tool calls, as one array or as JSON Lines.

Lines an edit names are found at the first of three matching tiers — exact, trailing-whitespace-insensitive,
then indentation-insensitive (with re-indentation of the replacement) — or exactly under `--strict`. Every
edit in a patch applies to the tree the earlier edits left, and the run writes every change or none:
failures are reported per edit with a code (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and
nothing is written.

    node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or standard input when absent or `-`. `--check` prints the same result without
writing. Success prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and an `ok:` summary.

Node 22, standard library alone. `runner.ts` is the kit's trial runner: when `MAKEFUN_ENV_URL` is set,
`main.ts` hands the trial over to it. `check.ts` runs the public practice set:

    node check.ts <practice.json>
