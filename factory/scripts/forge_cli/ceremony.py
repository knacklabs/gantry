"""forge ceremony — point one session's interactive ceremony at a sibling worktree.

A Claude session's AskUserQuestion grill rounds and plan-mode markers are
ledgered by the post_tool_use hook into the SESSION checkout's `.factory`
(`repo_root()` resolves the session project dir). When one session
orchestrates a second story in a sibling git worktree, that worktree's gate
recorders then refuse the rounds — they live in the wrong ledger.

`forge ceremony target set <path>` writes `.factory/ceremony-target` in the
session checkout: an explicit, orchestrator-declared pointer. While it is
set, the post_tool_use hook ledgers grill rounds and plan-mode markers into
the TARGET repo's `.factory` instead, so the worktree's own recorders see
them natively. `clear` removes the pointer (the default, self-ledgering
behavior); `show` prints the current target.

Safety: the target must be an existing directory containing `.factory`
(an adopted factory repo), must not be the session checkout itself, and the
pointer is re-validated by the hook on every use — a stale or invalid
pointer falls back to the session checkout rather than dropping evidence.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import ceremony_pointer_path, read_ceremony_target, repo_root

from .common import fail


def cmd_target(args: argparse.Namespace) -> None:
    root = repo_root()
    action = args.target_command
    if action == "show":
        target = read_ceremony_target(root)
        print(str(target) if target else "(none — ceremony ledgers to this checkout)")
        return
    if action == "clear":
        ceremony_pointer_path(root).unlink(missing_ok=True)
        print("Ceremony target cleared — rounds and markers ledger to this checkout.")
        return
    # set
    raw = Path(args.path).expanduser()
    if not raw.is_absolute():
        raw = (Path.cwd() / raw)
    try:
        target = raw.resolve()
    except OSError:
        fail(f"ceremony target is not resolvable: {raw}")
        return
    if target == root.resolve():
        fail("ceremony target must be a DIFFERENT checkout — the session checkout is the default.")
    if not target.is_dir():
        fail(f"ceremony target does not exist: {target}")
    if not (target / ".factory").is_dir():
        fail(f"ceremony target is not an adopted factory repo (no .factory/): {target}")
    pointer = ceremony_pointer_path(root)
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(f"{target}\n", encoding="utf-8")
    print(
        f"Ceremony target set: grill rounds and plan-mode markers now ledger to {target} "
        "until `forge ceremony target clear`."
    )
