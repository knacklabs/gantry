"""Whether recorded evidence actually passes — the predicates pr_ready gates
on and the board displays.

Both read the same artifacts, so both must agree on what "passed" means. A
board that ticks a gate because the FILE EXISTS calls a failed test run green,
which is worse than showing nothing: it is proof of the opposite of the truth.
"""
from __future__ import annotations

MIN_SCORE = 8


def verify_passed(verify: dict | None) -> bool:
    return bool(verify) and verify.get("ok") is True


def tests_passed(entry: dict | None, *, functional: bool = False) -> bool:
    """One recorded test artifact. Functional runs additionally carry a score:
    a walkthrough nobody rated is not evidence the walk went well."""
    if not entry:
        return False
    if entry.get("blocking_findings") or entry.get("status") == "failed":
        return False
    if functional and entry.get("score", 0) < MIN_SCORE:
        return False
    return True


def review_passed(review: dict | None) -> bool:
    if not review:
        return False
    return not review.get("blocking_findings") and review.get("score", 0) >= MIN_SCORE
