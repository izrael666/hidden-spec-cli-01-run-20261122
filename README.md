# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/izrael666/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/izrael666/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON, finds the lines each edit names even when the model drifted their whitespace or indentation (three matching tiers: exact, trailing whitespace, indentation), and changes every file or none. `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; nothing is installed. `PATCH` is the patch file, or `-`/absent to read the patch from standard input. `--format` is `auto` (the default, detected per SPEC.md section 4), `unified`, `search-replace`, `v4a` or `json`. `--check` reports what would change without writing anything; `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for moves) and `ok: <n> files`; exit 1 lists each failed edit and `failed: <k> of <n> edits`; exit 2 is a usage, no-patch, format or parse error, one line, nothing else.

Practice score on the kit's 100 public checks: 1000 (100 of 100 passed).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
