#!/usr/bin/env python3
"""Record a per-stage LOCAL autoreview verdict, bound to the current HEAD.

`forge stage done <id>` refuses unless the latest stage review for <id> is
`clean` AND its reviewed_sha == current HEAD. So a fix applied after a clean
review (which advances HEAD) staleness-fails the gate until the final commit is
re-reviewed clean. This turns "LOCAL autoreview until clean before done" from
advice into an enforced gate, mirroring the grill freshness gate on plan save.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from factory_lib import (
    dump_json, factory_dir, head_sha, now_iso, repo_root, validate_payload,
)


def _stage_review_dir(root: Path) -> Path:
    d = factory_dir(root) / "stage-reviews"
    d.mkdir(parents=True, exist_ok=True)
    return d


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Record a per-stage autoreview verdict bound to HEAD")
    parser.add_argument("--stage", required=True, help="stage id, e.g. T-F1")
    parser.add_argument("--input", help="Path to review JSON; stdin if omitted")
    args = parser.parse_args()

    # The stage id is interpolated into the artifact path; reject anything that
    # is not a bare separator-free identifier so `--stage ../stages` cannot
    # escape .factory or overwrite the stage database.
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", args.stage) or args.stage in (
        ".", "..",
    ):
        raise SystemExit(
            f"invalid --stage {args.stage!r}: must be a bare identifier "
            "(letters, digits, dot, dash, underscore; no path separators).")

    raw = Path(args.input).read_text() if args.input else sys.stdin.read()
    payload = json.loads(raw)

    root = repo_root()
    validate_payload(root, "stage-review", payload)

    verdict = str(payload.get("verdict", "")).strip().lower()
    if verdict not in ("clean", "blocked"):
        raise SystemExit("stage-review verdict must be 'clean' or 'blocked'.")

    # A clean verdict must carry ZERO findings, of ANY severity. The autoreview
    # helper's definition of clean is "no accepted/actionable findings", so a
    # `clean` payload that still lists findings (incl. P2/P3) is a deferral, not
    # a clean review — and `forge stage done` only checks the stored verdict, so
    # accepting it would let unresolved findings pass the "autoreview until
    # clean" gate. Resolve them and re-review, or record verdict `blocked`.
    findings = payload.get("findings") or []
    if verdict == "clean" and findings:
        raise SystemExit(
            f"verdict 'clean' requires an EMPTY findings list — {len(findings)} "
            "finding(s) recorded. A clean autoreview has no accepted/actionable "
            "findings of ANY severity (including P2/P3). Fix them and re-review, "
            "or record verdict 'blocked'.")

    sha = head_sha(root)
    if not sha:
        raise SystemExit(
            "no HEAD commit — commit the stage first; a stage review attests "
            "the COMMITTED diff (review HEAD, then record, then `stage done`).")

    # The review OUTPUT must attest the commit it actually reviewed, and that
    # commit must be the CURRENT HEAD. Otherwise a clean review of commit A
    # could be recorded after commit B is created and be mis-stamped as B —
    # the recorder must never fabricate the reviewed_sha from HEAD.
    attested = str(payload.get("reviewed_sha") or "").strip()
    if not attested:
        raise SystemExit(
            "stage-review JSON must carry `reviewed_sha` — the exact commit the "
            "autoreview ran against (the HEAD you reviewed). Re-run the "
            "autoreview helper on HEAD and record its attested SHA.")
    if attested != sha:
        raise SystemExit(
            f"reviewed_sha {attested[:12]} does not match current HEAD "
            f"{sha[:12]} — the review is of a different commit (a fix landed "
            "after it). Re-review the current HEAD and record again.")

    record = {
        "stage": args.stage,
        "generated_by": payload["generated_by"],
        "verdict": verdict,
        "findings": findings,
        "reviewed_sha": attested,
        "recorded_at": now_iso(),
        **({"summary": payload["summary"]} if payload.get("summary") else {}),
        **({"passes": payload["passes"]} if payload.get("passes") else {}),
        **({"reviewed_scope": payload["reviewed_scope"]}
           if payload.get("reviewed_scope") else {}),
    }
    dump_json(_stage_review_dir(root) / f"{args.stage}.json", record)
    n = len(findings)
    print(f"Recorded stage review for {args.stage}: {verdict} "
          f"({n} finding(s)) @ {sha[:12]}")
    if verdict == "blocked":
        print("  blocked → fix the findings, then re-review the new commit and "
              "record again before `forge stage done`.")


if __name__ == "__main__":
    main()
