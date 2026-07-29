# Runtime Refactor Baseline

Baseline for `LOCAL-35` T0. This records the source line budget before the
runtime refactor phases start deleting and replacing active runtime paths.

## Revision

- Commit: `d18ba5f08a6496c462d27edf36773cb8a88cc4fe`
- Measured tree: current checkout working tree at T0 implementation time.
- Method: `python3 scripts/check_refactor_line_delta.py --baseline`
- Counted paths: `apps/core/src`
- Counted extensions: `.cjs`, `.js`, `.mjs`, `.ts`, `.tsx`
- Bucketing: root files under `apps/core/src`, and otherwise immediate child
  directories under `apps/core/src`.

## Counts

| Directory | Files | Lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| `apps/core/src` | 2 | 96 | 79 |
| `apps/core/src/adapters` | 79 | 17499 | 16649 |
| `apps/core/src/app` | 15 | 3561 | 3363 |
| `apps/core/src/application` | 69 | 9372 | 8875 |
| `apps/core/src/channels` | 32 | 8484 | 7956 |
| `apps/core/src/cli` | 45 | 10744 | 9967 |
| `apps/core/src/config` | 35 | 7326 | 6902 |
| `apps/core/src/control` | 29 | 6375 | 6052 |
| `apps/core/src/domain` | 42 | 3611 | 3344 |
| `apps/core/src/infrastructure` | 11 | 1806 | 1651 |
| `apps/core/src/jobs` | 37 | 5835 | 5542 |
| `apps/core/src/memory` | 33 | 8073 | 7618 |
| `apps/core/src/messaging` | 2 | 66 | 58 |
| `apps/core/src/platform` | 7 | 506 | 456 |
| `apps/core/src/runner` | 43 | 6407 | 6075 |
| `apps/core/src/runtime` | 55 | 10351 | 9653 |
| `apps/core/src/session` | 5 | 1292 | 1198 |
| `apps/core/src/shared` | 31 | 2914 | 2665 |
| **Total** | 572 | 104318 | 98103 |

## Deletion Budget Check

The LOCAL-35 phase-progress gate is:

```bash
python3 scripts/check_refactor_line_delta.py --check-diff --baseline-file docs/architecture/refactor-baseline.md
```

It reads the commit above as the T0 phase baseline, counts net added/deleted
lines in source files under `apps/core/src`, and fails when additions exceed
deletions. The `factory-scaffold` workflow runs this phase gate on pull
requests labelled `refactor` or `PR: Refactor`.

The final PR or overall deletion-budget gate is still explicit and compares
against the branch base:

```bash
python3 scripts/check_refactor_line_delta.py --check-diff --base-ref origin/main
```

Use the branch-base gate when validating the whole refactor line budget, not
for phase-progress checks that intentionally start from the recorded T0 commit.
