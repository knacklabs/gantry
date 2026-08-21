---
name: knacklabs-upgrade-project
description: >-
  Upgrade or update an existing KnackLabs project to the latest Symphony
  Forge harness. Use when someone says "Upgrade this repo to the latest
  harness", "Update my-app to the latest harness", or asks to refresh an
  existing project's vendored Forge machinery.
---

# Upgrade a KnackLabs project

Trigger on requests such as "Upgrade this repo to the latest harness" and
"Update my-app to the latest harness".

Use this runbook for every harness refresh, not just the first one. Each cycle
starts from a clean, committed client baseline and converges the project's
machinery and incomplete planning records on the current harness contracts.

## 1. Locate and update the harness safely

The installed skill has its setup-time harness location substituted here:

```bash
HARNESS="{{HARNESS_PATH}}"
TARGET="$(git rev-parse --show-toplevel)"
```

Stop if the current directory is not the client repository to upgrade. Then
validate the recorded harness rather than trusting the path alone:

```bash
test -d "$HARNESS/.git"
test "$(git -C "$HARNESS" rev-parse --show-toplevel)" = "$HARNESS"
HARNESS_ORIGIN="$(git -C "$HARNESS" remote get-url origin)"
case "$HARNESS_ORIGIN" in
  git@github.com:knacklabs/symphony-forge.git|https://github.com/knacklabs/symphony-forge.git) ;;
  *) echo "Unexpected harness origin: $HARNESS_ORIGIN" >&2; exit 1 ;;
esac
test "$(git -C "$HARNESS" symbolic-ref --quiet HEAD)" = "refs/heads/main"
test -z "$(git -C "$HARNESS" status --porcelain)"
```

If any check fails, stop and ask the user to repair or re-run `setup` from the
intended harness clone. Do not guess another clone. Update the verified clone
with a fast-forward-only pull, and halt the upgrade if the pull fails:

```bash
if ! git -C "$HARNESS" pull --ff-only; then
  echo "Harness pull failed; the client was not upgraded." >&2
  exit 1
fi
```

## 2. Require a clean client baseline and audit it

```bash
test -z "$(git -C "$TARGET" status --porcelain)"
"$TARGET/forge" audit --repo "$TARGET"
```

If the client is dirty, stop. Ask the user to review and commit or otherwise
resolve those changes before starting this upgrade cycle. Do not use force.
Treat audit findings as pre-existing project health information; show them
before changing machinery.

## 3. Upgrade, repair tooling, and review the machinery diff

The upgrade is the only Forge step run from the harness clone:

```bash
(cd "$HARNESS" && ./forge upgrade --target "$TARGET")
```

Run the upgraded client's machine-level doctor next. `doctor` intentionally
has no repository flag; it checks and repairs local tooling, not client state:

```bash
"$TARGET/forge" doctor --fix
```

Review every change before continuing:

```bash
git -C "$TARGET" status --short
git -C "$TARGET" diff --stat
git -C "$TARGET" diff
```

Stop on surprising application, product-document, roadmap, decision, or
evidence changes. The upgrade should refresh harness-owned machinery only.

## 4. Backfill project contracts

```bash
"$TARGET/forge" project backfill --repo "$TARGET"
```

Review the backfill output and resulting diff. Backfill only deterministic
project-level gaps; do not invent product intent.

## 5. Re-author incomplete stories with the user

List only incomplete work:

```bash
"$TARGET/forge" roadmap list --pending --repo "$TARGET"
```

For each PENDING story that the upgraded validator says is incomplete, ask the
user for its user story, acceptance criteria, skill, epic, confirmed spec, and
dependencies. Preserve the key, then fill that one story explicitly:

```bash
"$TARGET/forge" roadmap fill "$KEY" --story "$USER_STORY" --ac "$ACCEPTANCE_CRITERION" --skill "$SKILL" --epic "$EPIC" --spec "$CONFIRMED_SPEC" --repo "$TARGET"
```

Repeat `--ac` and `--depends-on` as needed. Never select or rewrite a completed
story, and never bulk-load a replacement roadmap. This is guided re-authoring,
not a status migration.

## 6. Re-verify and hand off

Run the client's deterministic verifier, then repeat the health audit and ask
the phase engine for the next action:

```bash
python3 "$TARGET/factory/scripts/verify.py"
"$TARGET/forge" audit --repo "$TARGET"
"$TARGET/forge" next --repo "$TARGET"
```

Report the verifier result, remaining audit findings, the reviewed diff, and
the exact next action. The user reviews and commits the completed upgrade so
the next periodic cycle again begins from a clean, committed baseline.
