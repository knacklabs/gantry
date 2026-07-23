#!/usr/bin/env python3
"""The gate machinery is FROZEN between vendorings (decision: frozen-gate-integrity).

An optimizing loop must never tune its own held-out set: in a client repo the
vendored gate surface (scripts, schemas, prompts, the forge launcher, the hook
config) is what makes every other gate mean anything, so a local edit there —
a lowered threshold, a weakened verify — silently invalidates all evidence.
`forge init/adopt/upgrade` write constitution/VENDOR_MANIFEST.json (path ->
sha256 over the gate surface); this check compares. No manifest = unarmed
(the harness repo itself, or a pre-manifest vendoring) — advisory only.
Drift = hard refusal at pr_ready: re-vendor via `forge upgrade`, or upstream
the fix to the harness — never patch gates in place.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from factory_lib import dump_json, repo_root

GATE_TREES = (".agents/scripts", ".agents/schemas", ".agents/prompts")
GATE_FILES = ("forge", ".claude/settings.json")
MANIFEST_REL = "constitution/VENDOR_MANIFEST.json"


def manifest_path(base: Path) -> Path:
    return base / MANIFEST_REL


def compute_hashes(base: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for tree in GATE_TREES:
        root = base / tree
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts \
                    and path.suffix != ".pyc":
                rel = path.relative_to(base).as_posix()
                hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    for rel in GATE_FILES:
        path = base / rel
        if path.is_file():
            hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def write_manifest(base: Path, harness_commit: str) -> None:
    dump_json(manifest_path(base), {
        "harness_commit": harness_commit,
        "files": compute_hashes(base),
    })


def integrity_problems(base: Path) -> list[str] | None:
    """None = no manifest (unarmed); [] = clean; else drift descriptions."""
    path = manifest_path(base)
    if not path.exists():
        return None
    recorded = json.loads(path.read_text()).get("files", {})
    current = compute_hashes(base)
    problems = []
    for rel in sorted(set(recorded) | set(current)):
        if rel not in current:
            problems.append(f"missing: {rel}")
        elif rel not in recorded:
            problems.append(f"unexpected: {rel} (not vendored — client scripts do not belong in the gate surface)")
        elif recorded[rel] != current[rel]:
            problems.append(f"edited: {rel}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo")
    args = parser.parse_args()
    base = Path(args.repo).resolve() if args.repo else repo_root()
    problems = integrity_problems(base)
    if problems is None:
        print("Vendor integrity: unarmed (no constitution/VENDOR_MANIFEST.json) — "
              "the next `forge upgrade` arms it. Advisory only.")
        return 0
    if not problems:
        print(f"Vendor integrity: OK ({len(compute_hashes(base))} gate file(s) match the manifest).")
        return 0
    print("Vendor integrity FAILED — the gate surface drifted from the vendored manifest:")
    for problem in problems:
        print(f"- {problem}")
    print("Locally edited gates make evidence unverifiable. Re-vendor via "
          "`forge upgrade` (run from the harness clone), or upstream the fix "
          "to the harness — never patch gate machinery in place.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
