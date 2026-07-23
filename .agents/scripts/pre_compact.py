#!/usr/bin/env python3
"""PreCompact hook: snapshot the deterministic session facts to the scratchpad.

Compaction summarizes the conversation; whatever the summary drops is gone.
This hook writes .factory/scratchpad.md — every fact and finding the harness
can derive deterministically (run state, stage progress, open signals,
unguided assumptions, recurring finding classes, pending context, open
deferrals, the ready frontier) — so the post-compaction session re-anchors
on recorded state, not on what the summary happened to keep. The
SessionStart hook surfaces the file after compaction. Machine-local session
noise: gitignored, overwritten per compaction, never evidence.
"""
from __future__ import annotations

import sys
from pathlib import Path

from factory_lib import load_json, now_iso, read_hook_input, repo_root, run_state_path


def snapshot(root: Path, trigger: str) -> str:
    from forge_cli.assumptions import load_rows as assumption_rows
    from forge_cli.deferrals import load_rows as deferral_rows
    from forge_cli.findings import clusters
    from forge_cli.roadmap import load_items, ready_pending
    from forge_cli.signal import open_signals
    from forge_cli.stages import load_stages

    lines = [
        "# Compaction Scratchpad — deterministic facts, snapshotted",
        "",
        f"Written by the PreCompact hook ({trigger or 'unknown'} compaction) at "
        f"{now_iso()}. Facts only, all re-derivable from the ledgers — read this "
        "to re-anchor, then trust `./forge next` over any summary.",
        "",
    ]
    state = load_json(run_state_path(root), default={})
    if state.get("issue_key"):
        lines += [
            "## Active task",
            f"- {state['issue_key']} — {state.get('title', '')} "
            f"(phase: {state.get('phase')}, plan: {state.get('plan_status')}, "
            f"decomposition: {state.get('decomposition_status')})",
        ]
    else:
        lines += ["## Active task", f"- none (phase: {state.get('phase', 'uninitialized')}, "
                  f"client_signoff: {state.get('client_signoff', False)})"]
    stages = load_stages(root).get("stages", [])
    if stages:
        done = sum(1 for s in stages if s.get("status") == "done")
        current = next((s for s in stages if s.get("status") != "done"), None)
        lines += ["", "## Stage progress",
                  f"- {done}/{len(stages)} done" + (
                      f"; current: {current['id']} ({current.get('status', 'pending')}) — "
                      f"{current.get('title')}" if current else " — all complete")]
    signals = open_signals(root)
    if signals:
        lines += ["", "## OPEN worker signals (paused workers waiting)"]
        lines += [f"- {s['id']} [{s['kind']}] {s.get('message', '')}" for s in signals]
    try:
        open_assumptions = [r for r in assumption_rows(root)
                            if r["status"] in {"open", "fix-needed"}]
    except SystemExit:
        open_assumptions = []
    if open_assumptions:
        lines += ["", "## Assumptions awaiting guidance"]
        lines += [f"- {r['id']} ({r['issue']}, {r['status']}): {r['assumption']}"
                  for r in open_assumptions]
    flagged = [c for c in clusters(root) if c["count"] >= 2]
    if flagged:
        lines += ["", "## Finding classes (findings patterns)"]
        lines += [f"- {'RECURRING' if c['count'] >= 3 else 'watch'} x{c['count']}: "
                  f"{c['category']}" + (f" @ {c['area']}" if c["area"] else "")
                  for c in flagged]
    ledger = load_json(root / "docs" / "context" / "ledger.json", default={"files": {}})
    pending_ctx = [name for name, e in ledger.get("files", {}).items()
                   if e.get("status") == "pending"]
    if pending_ctx:
        lines += ["", "## Unharvested context", *[f"- {n}" for n in pending_ctx[:10]]]
    try:
        open_defers = [r for r in deferral_rows(root) if r["status"] == "open"]
    except SystemExit:
        open_defers = []
    if open_defers:
        lines += ["", "## Open deferrals (revisit triggers)"]
        lines += [f"- {r['id']}: {r['item']} — when: {r['trigger']}" for r in open_defers]
    items = load_items(root)
    if items:
        ready, _ = ready_pending(items)
        done_items = sum(1 for i in items if i.get("status") == "done")
        lines += ["", "## Roadmap",
                  f"- {done_items}/{len(items)} done; ready frontier: "
                  + (", ".join(i["key"] for i in ready[:5]) or "none")]
    lines += ["", "Re-derive everything: `./forge next` (state), "
              "`./forge signal list --open`, `./forge assumptions list --open`, "
              "`./forge findings patterns`, `./forge defer list --open`."]
    return "\n".join(lines) + "\n"


def main() -> int:
    payload = read_hook_input()
    root = repo_root()
    from forge_cli.scratchpad import notes_section, scratchpad_path
    path = scratchpad_path(root)
    # The facts zone is hook-owned and rewritten; the agent's working notes
    # (`forge note`) are the whole point of surviving compaction — keep them.
    notes = notes_section(path.read_text()) if path.exists() else None
    path.parent.mkdir(parents=True, exist_ok=True)
    body = snapshot(root, payload.get("trigger", ""))
    if notes:
        body += "\n" + notes
    path.write_text(body)
    print(f"scratchpad snapshot -> {path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
