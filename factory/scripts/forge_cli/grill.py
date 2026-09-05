"""forge grill run — release the read-only cold reader through the ledger.

Grills were the one Codex release the harness could not see. A delegation
records a pid and a review now does too, so a launcher killed uncatchably is
still detectable afterwards; a grill went out through the plugin directly, so
nothing on the forge side knew it had ever started. That is backwards: the
grill is the release the coordinator is told to WATCH every single round.

Releasing it through `launch_companion` — the same launcher a delegation uses —
gives it the same treatment for free: the pid and process create-time are
ledgered before the wait, the process tree is reaped on exit, the argv is
pinned, and `forge codex status` reports it dead if its launcher was killed.

It stays READ-ONLY. `write=False` means no delegation lock is taken and the
row can never satisfy `stage done`, which matches on a write launch bound to a
task contract. The cold read returns findings; recording the gate remains the
coordinator's job through the ledger-matched recorder, exactly as before.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import load_json, repo_root, run_state_path
from grill_gates import FLOOR_IS_NOT_A_TARGET, get_gate

def _artifact_text(base: Path, gate: str, task_id: str,
                   file_arg: str = "") -> tuple[str, str]:
    """Ask the gate table where this gate's artifact lives.

    This used to be a hand-written if-chain that knew two of the six gates;
    the other four failed with "no artifact resolver yet" and sent the
    coordinator around the ledgered launcher, which is where the pid that
    makes a dead grill detectable gets recorded. A missing lookup silently
    cost liveness detection in an unrelated subsystem.
    """
    return get_gate(gate).locate(base, task_id, file_arg)


def _grill_skill_section() -> str:
    """The grill technique, INLINED rather than named.

    Naming it does not work for a Codex cold reader. What `doctor` installs
    into ~/.codex/skills/grill-me is a 164-byte STUB whose whole body is "Call
    the Skill tool with 'grilling'" — and `grilling`, the 2KB skill that holds
    the actual technique, is installed only on the Claude side. So a Codex
    reader told to load grill-me finds a pointer to a Skill tool its runtime
    does not have, and falls back to the harness contract alone.

    `_skill_text` already looks in BOTH runtimes' skill directories, which is
    what lets the Claude-side text travel to Codex inside the brief. Prefer the
    real skill, accept grill-me only when it is not merely the stub, and carry
    a written floor when neither is installed — the same reason delegate
    inlines ponytail instead of trusting a per-machine install.
    """
    from .delegate import _skill_text

    for name in ("grilling", "grill-me"):
        text = _skill_text(name)
        # The stub points at a tool the reader may not have; it is not technique.
        if text and "Call the Skill tool" not in text:
            return ("## Interrogation technique\n\n"
                    "Run the interrogation this way. The harness contract above "
                    "is the floor; this is the technique.\n\n" + text)
    return ("## Interrogation technique\n\n"
            "No grill skill is installed (`./forge doctor --fix` installs it). "
            "Interrogate to the harness contract above: one line of questioning "
            "at a time, press each answer until it is concrete and checkable, "
            "and surface every place the artifact leaves the reader to guess.")


def _compose_brief(base: Path, gate: str, label: str, artifact: str) -> str:
    contract = base / "factory" / "prompts" / "griller.md"
    contract_text = (contract.read_text(encoding="utf-8")
                     if contract.is_file() else "")
    skill_section = _grill_skill_section()
    return "\n".join([
        f"# Cold-read grill — gate: {gate} — {label}",
        "",
        "You did NOT write what follows. Read it cold, as an adversary trying "
        "to break the handover, never as its author defending it. You are "
        "READ-ONLY: return findings, change nothing.",
        "",
        skill_section,
        "",
        "## Harness grill contract",
        "",
        contract_text,
        "",
        f"## The artifact under interrogation ({label})",
        "",
        artifact,
        "",
        "## What to return",
        "",
        "Findings only: contradictions, gaps, unstated assumptions, and "
        "anything a reader would have to guess. Say what would break and why. "
        "Do not record a gate — the coordinating session records it.",
        "",
        FLOOR_IS_NOT_A_TARGET,
        "",
    ])


def cmd_grill_run(args: argparse.Namespace) -> None:
    from .delegate import launch_companion, mode_run_config

    base = Path(args.repo).resolve() if args.repo else repo_root()
    gate = args.gate
    task_id = (args.task or "").strip()
    label, artifact = _artifact_text(
        base, gate, task_id, (getattr(args, "file", "") or "").strip())
    text = _compose_brief(base, gate, label, artifact)

    # Keyed apart from real task ids so a grill row can never be mistaken for
    # a task's delegation, and so concurrent grills of different gates do not
    # collide in the ledger.
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    path = base / ".factory" / f"grill-brief-{gate}" \
        f"{'-' + task_id if task_id else ''}.md"
    model, effort, _bound = mode_run_config(base, "grill")

    launch_companion(
        base,
        task_id=ledger_id,
        text=text,
        path=path,
        task_sha256_value="",
        model=model,
        effort=effort,
        write=False,          # a cold read never writes, and never authorises
        story=load_json(run_state_path(base), default={}).get("issue_key", ""),
        print_only=bool(args.print_only),
    )
    if args.print_only:
        return
    print(f"NEXT: carry these findings into your own rounds, then record with "
          f"`python3 factory/scripts/record_grill_from_json.py --gate {gate}"
          f"{' --task ' + task_id if task_id else ''} --input <json>`")
