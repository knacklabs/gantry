"""docs/context inbox: ledger tracking and the shared pending-context detector."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root

from .common import fail

# Inbox guards: dumping is free, but the inbox must not become a liability.
# Files over the cap or containing secret-shaped content are REFUSED at scan
# time (they stay unscanned, so the plan gate keeps blocking until fixed).
MAX_CONTEXT_BYTES = 5_000_000
SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"), "private key block"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "GitHub token"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "API secret key"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "Slack token"),
    (re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"),
     "hardcoded credential"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "JWT"),
]


def secret_findings(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []  # binary: size cap still applies; secret scan is text-only
    findings = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for pattern, label in SECRET_PATTERNS:
            if pattern.search(line):
                findings.append(f"line {lineno}: {label}")
                break
    return findings


def context_paths(base: Path) -> tuple[Path, Path]:
    context_dir = base / "docs" / "context"
    return context_dir, context_dir / "ledger.json"


def sha256_file(path: Path) -> str:
    import hashlib

    # Normalize CRLF so the fingerprint is identical no matter which OS (or
    # git autocrlf setting) checked out the working copy — otherwise a ledger
    # written on Windows fails the freshness check on Linux CI and vice versa.
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def context_files(context_dir: Path) -> list[Path]:
    # Only the inbox's own top-level README and ledger are infrastructure;
    # a dumped subdirectory may legitimately contain files with those names.
    skip = {"README.md", "ledger.json"}
    return sorted(
        p for p in context_dir.rglob("*")
        if p.is_file()
        and p.relative_to(context_dir).as_posix() not in skip
        and not p.name.startswith(".")
    )


def pending_context(base: Path) -> list[str]:
    """Pending = ledgered-pending PLUS unscanned/changed inbox files on disk.

    The single source of truth for 'is there unharvested context' — used by
    the plan-approval gate and the phase engine so they can never disagree.
    """
    context_dir, ledger_path = context_paths(base)
    ledger = load_json(ledger_path, default={"files": {}})
    pending = [
        rel for rel, e in ledger.get("files", {}).items() if e.get("status") == "pending"
    ]
    if context_dir.is_dir():
        for f in context_files(context_dir):
            rel = f.relative_to(context_dir).as_posix()
            entry = ledger.get("files", {}).get(rel)
            if entry is None or (
                entry.get("status") != "pending" and entry.get("sha256") != sha256_file(f)
            ):
                pending.append(f"{rel} (unscanned)")
    return pending


def cmd_scan(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    context_dir, ledger_path = context_paths(base)
    context_dir.mkdir(parents=True, exist_ok=True)
    ledger = load_json(ledger_path, default={"files": {}})
    refused: list[str] = []
    drift: list[str] = []
    for f in context_files(context_dir):
        rel = f.relative_to(context_dir).as_posix()
        if f.stat().st_size > MAX_CONTEXT_BYTES:
            refused.append(f"{rel}: {f.stat().st_size // 1_000_000}MB exceeds the "
                           f"{MAX_CONTEXT_BYTES // 1_000_000}MB inbox cap — summarize or split it")
            continue
        secrets = secret_findings(f)
        if secrets:
            refused.append(f"{rel}: secret-shaped content ({'; '.join(secrets[:3])}) — "
                           "REDACT before it enters git history")
            continue
        digest = sha256_file(f)
        entry = ledger["files"].get(rel)
        if entry is None:
            drift.append(f"new: {rel}")
            ledger["files"][rel] = {
                "sha256": digest, "added": now_iso(), "status": "pending",
                "outputs": [], "notes": "",
            }
        elif entry.get("sha256") != digest:
            drift.append(f"changed (re-pending): {rel}")
            entry.update({"sha256": digest, "status": "pending", "updated": now_iso()})
    on_disk = {f.relative_to(context_dir).as_posix() for f in context_files(context_dir)}
    for rel in sorted(set(ledger["files"]) - on_disk):
        drift.append(f"missing (marked removed): {rel}")
        ledger["files"][rel]["status"] = "removed"
    if refused:
        if not args.check:
            dump_json(ledger_path, ledger)  # register what passed; refuse the rest
        print("REFUSED (not registered — fix, then rescan):")
        for line in refused:
            print(f"- {line}")
        raise SystemExit(1)
    if args.check:
        if drift:
            print("Context ledger out of sync (run `forge.py context scan` and commit):")
            for line in drift:
                print(f"- {line}")
            raise SystemExit(1)
    else:
        dump_json(ledger_path, ledger)
        for line in drift:
            print(line)
    counts: dict[str, int] = {}
    for entry in ledger["files"].values():
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
    summary = ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "empty"
    print(f"context ledger — {summary}")
    if counts.get("pending"):
        print("Harvest pending files per .agents/prompts/harvester.md.")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    _, ledger_path = context_paths(base)
    ledger = load_json(ledger_path, default={"files": {}})
    for rel, entry in sorted(ledger["files"].items()):
        if args.pending and entry["status"] != "pending":
            continue
        outputs = f" -> {', '.join(entry['outputs'])}" if entry.get("outputs") else ""
        print(f"[{entry['status']:<9}] {rel}{outputs}")


def cmd_mark(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    _, ledger_path = context_paths(base)
    ledger = load_json(ledger_path, default={"files": {}})
    entry = ledger["files"].get(args.file)
    if entry is None:
        fail(f"{args.file} is not in the ledger — run `forge.py context scan` first")
    status = "harvested" if args.harvested else "ignored"
    outputs = args.outputs or []
    escaping = []
    for o in outputs:
        candidate = (base / o).resolve()
        if Path(o).is_absolute() or not candidate.is_relative_to(base):
            escaping.append(o)
    if escaping:
        fail(
            f"outputs must be repo-relative paths inside the repo: {', '.join(escaping)}"
        )
    missing = [o for o in outputs if not (base / o).exists()]
    if missing:
        fail(f"outputs do not exist: {', '.join(missing)} — create them before marking")
    if args.harvested and not args.outputs:
        fail("--harvested requires --outputs (what did the harvest produce?)")
    if args.ignored and not (args.notes or "").strip():
        fail("--ignored requires --notes (why is this context irrelevant? auditable rationale)")
    entry.update({
        "status": status,
        "marked_at": now_iso(),
        "outputs": args.outputs or [],
        "notes": args.notes or entry.get("notes", ""),
    })
    dump_json(ledger_path, ledger)
    print(f"{args.file}: {status}")
