#!/usr/bin/env python3
"""Establish the project's client sign-off by pinning its decision record in
harness.yaml.

Sign-off happens ONCE for the project — the gate sits between prototype and
planning (WORKFLOW.md), not on every task. So this does not write a per-run
flag; it names the record in committed state and every gate derives the answer
from that. Re-running it on a signed-off project is refused rather than
silently re-pointing the attestation at whatever record happens to be newest.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from factory_lib import (
    canonical_signoff_path, insert_signoff_pin, load_json, parse_frontmatter,
    parse_sections, repo_root, require_grill, signoff_pin,
)
from forge_cli.events import append_event
from forge_cli.specs import spec_records, unreferenced_confirmed_specs


REQUIRED_BRIEF_HEADINGS = (
    "Summary",
    "Users",
    "Target Outcome",
    "Key Flows",
    "Domain Concepts",
    "Constraints",
    "Out of Scope",
)


def pin_into_harness(manifest: Path, relative: str) -> None:
    if manifest.is_symlink():
        raise SystemExit(
            f"VIOLATION: {manifest.name} is a symlink; refusing to write the sign-off "
            "pin through it. The manifest must be a regular file in this repo, or the "
            "gate's committed state is not committed here at all."
        )
    # A project vendored before this key existed keeps its own harness.yaml
    # through `forge upgrade` (it is project-owned), so the key may simply be
    # absent; insert_signoff_pin adds it rather than refusing, or the gate would
    # be unreachable in exactly the repos that predate it.
    manifest.write_text(insert_signoff_pin(manifest.read_text(encoding="utf-8"), relative), encoding="utf-8")


def workflow_input_problems(root: Path) -> list[str]:
    """Sign-off needs a complete brief, confirmed specs, and their roadmap."""
    specs = spec_records(root)
    roadmap = load_json(root / "plans" / "roadmap.json", default={})
    stories = roadmap.get("items", []) if isinstance(roadmap, dict) else []
    problems: list[str] = []
    if not specs:
        problems.append("at least one confirmed spec in docs/specs/")
    unconfirmed = [
        record["path"] for record in specs if record.get("status") != "confirmed"
    ]
    if unconfirmed:
        problems.append(f"specs still draft or unconfirmed: {', '.join(unconfirmed)}")
    if not stories:
        problems.append("plans/roadmap.json with at least one story")
    missing_refs = unreferenced_confirmed_specs(root)
    if missing_refs:
        problems.append(
            "confirmed specs not referenced by any roadmap story: "
            + ", ".join(missing_refs)
        )
    brief = root / "docs" / "product" / "BRIEF.md"
    if not brief.exists():
        problems.append(
            "docs/product/BRIEF.md is absent; required headings: "
            + ", ".join(REQUIRED_BRIEF_HEADINGS)
        )
    else:
        sections = parse_sections(brief.read_text(encoding="utf-8"))
        incomplete = [
            heading
            for heading in REQUIRED_BRIEF_HEADINGS
            if not sections.get(heading, "").strip()
        ]
        if incomplete:
            problems.append(
                "brief required headings missing or empty: "
                + ", ".join(incomplete)
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--record",
        help="Path to the accepted client-signoff decision record. Optional when "
        "exactly one exists; required when there are several.",
    )
    args = parser.parse_args()

    root = repo_root()
    already = signoff_pin(root)
    if already:
        print(
            f"VIOLATION: this project is already signed off ({already}).\n"
            "  Sign-off is a ONE-TIME project gate, so it is never re-recorded per task —\n"
            "  the per-task human gate is plan approval (`forge.py plan save`).\n"
            "  If the pin is genuinely wrong, change harness.yaml in a reviewed PR."
        )
        return 1

    problems = workflow_input_problems(root)
    if problems:
        print("SIGN-OFF REFUSED — missing workflow inputs:")
        for problem in problems:
            print(f"- {problem}")
        # Naming the artifact without the command that produces it left the
        # caller to work out the 0c order for themselves — and the roadmap step
        # in particular is easy to miss, since sign-off is the first thing that
        # demands it.
        print(
            "The 0c order that produces these: `forge spec save <slug> --from "
            "<draft>` -> grill it (`record_grill_from_json.py --gate spec "
            "--input-digest docs/specs/<slug>.md --input <grill.json>`, 2 logged "
            "rounds) -> `forge spec confirm <slug>` -> `forge roadmap derive "
            "--input <roadmap.json>` -> grill sign-off -> accept the "
            "client-signoff decision -> re-run this script. `forge next` prints "
            "the step you are actually on."
        )
        return 1

    # The handover must be grilled for gaps/contradictions BEFORE it becomes
    # the contract downstream work builds on. Fresh = product docs unchanged
    # since the grill (the sign-off record itself is expected exhaust).
    require_grill(
        root, "signoff",
        ("docs/product/", "docs/decisions/", "docs/specs/",
         "plans/roadmap.json", "prototype/"),
        ignore_names=("client-signoff", "epics-approved"),
    )

    decisions = root / "docs" / "decisions"
    if args.record:
        # Guarded resolution: a bare .resolve() would raise on a symlink loop
        # before the check could report it.
        canonical = canonical_signoff_path(root, args.record)
        if not canonical:
            print(
                f"VIOLATION: --record {args.record} is not a client sign-off record.\n"
                "  Expected docs/decisions/NNNN-<slug>client-signoff.md directly under "
                "this repo's docs/decisions/."
            )
            return 1
        record = root / canonical
    else:
        # Canonicalise each candidate, do not merely test it: a correctly named
        # SYMLINK beside its target passes the check, and persisting the link's
        # own spelling would write a pin the reader then rejects — success
        # reported, every gate locked, and repair refused because the pin is
        # non-empty. Deduplicating on the canonical path also means a symlink
        # and its target count as ONE record, not an ambiguous two.
        canonical_candidates = {
            canonical
            for c in decisions.glob("[0-9][0-9][0-9][0-9]-*client-signoff.md")
            if (canonical := canonical_signoff_path(
                root, c.relative_to(root).as_posix()))
        }
        candidates = sorted(root / c for c in canonical_candidates)
        if not candidates:
            print(
                "VIOLATION: no client sign-off decision record found.\n"
                f"  Expected: {decisions.relative_to(root)}/NNNN-client-signoff.md\n"
                "  Create one with `python3 factory/scripts/forge.py decision new client-signoff`,\n"
                "  get the client's confirmation, set status: accepted and confirmed_by, then re-run."
            )
            return 1
        if len(candidates) > 1:
            # NEVER guess which one is THE project sign-off. Guessing is the bug
            # this script had: it took the highest-numbered record, whatever task
            # it belonged to, and attested an unrelated human's confirmation.
            listing = "\n".join(f"    {c.relative_to(root)}" for c in candidates)
            print(
                "VIOLATION: several client-signoff records exist; name the project's "
                "one explicitly with --record.\n"
                f"{listing}"
            )
            return 1
        record = candidates[0]

    fields = parse_frontmatter(record.read_text(encoding="utf-8"))
    relative = record.relative_to(root).as_posix()
    if fields.get("status") != "accepted":
        print(
            f"VIOLATION: {relative} has status "
            f"'{fields.get('status', 'missing')}', expected 'accepted'.\n"
            "  Set status: accepted once the client has confirmed."
        )
        return 1
    if not fields.get("confirmed_by"):
        print(
            f"VIOLATION: {relative} has empty confirmed_by.\n"
            "  Record WHO confirmed (a human name); agents must not self-confirm —"
            "  an explicit human confirmation in chat authorizes recording it."
        )
        return 1

    pin_into_harness(root / "harness.yaml", relative)
    append_event(root, "client-signoff", actor="orchestrator", detail=relative)
    print(f"client sign-off pinned to {relative} in harness.yaml "
          f"(confirmed by {fields['confirmed_by']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
