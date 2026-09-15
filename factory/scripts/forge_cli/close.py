"""forge task close -- one command from a built task to its open PR.

Closing a task was five commands run by hand in a fixed order -- review,
stage done, pr-ready, and after a post-seal fix `reopen --review-fix` then
the three again -- each recomputing its own fingerprint and refusing when it
disagreed with the one before. The coordinator spent turns reading "STALE",
"no launch bound", "not sealed" and deducing which command to re-run. On T2
that was 4.5 hours after a clean build.

`close` holds the stage lock from the first check to the seal, computes the
product delta once, and runs only what that delta still needs:

    clean tree -> open signals/windows -> delta_id -> proof
      -> review (only if no stamp covers this delta)
      -> measure (notes) -> stage done -> seal, push, PR

A stop names the step and the next action. Re-running after a fix repeats
only the steps the new delta needs. Nothing here is a new check: every
predicate is one `review`, `stage done` or `pr-ready` already ran.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import (
    load_json, product_delta_digest, repo_root, run_state_path,
    task_seal_shared_problems,
)

from .common import fail


def _stop(step: str, why: str, then: str) -> None:
    fail(f"close stopped at {step}: {why}\n  NEXT: {then}")


def cmd_task_close(args: argparse.Namespace) -> None:
    from .review import _product_dirty, review_task
    from .stages import (
        _find, _finish_stage, load_stages, reopen_stage_for_review_fix,
        run_stage_proof, stage_baseline, stamp_is_fresh, task_for,
    )
    from .tasks import seal_task
    from .delegate import delegation_exclusion

    base = Path(args.repo).resolve() if args.repo else repo_root()
    task_id = args.id
    task = task_for(base, task_id)
    if not task:
        fail(f"task {task_id} is not in the recorded decomposition")
    stage = _find(load_stages(base), task_id)
    if stage.get("status") not in ("active", "done"):
        _stop("stage", f"{task_id} has not started (stage "
              f"'{stage.get('status', 'pending')}')",
              f"`./forge stage start {task_id}` then `./forge delegate {task_id}`")

    # 1. A clean, committed product tree: the diff is what gets reviewed and
    #    sealed, so it must be a committed thing.
    dirty = _product_dirty(base)
    if dirty:
        _stop("tree", f"uncommitted product paths: {', '.join(dirty[:6])}"
              f"{' ...' if len(dirty) > 6 else ''}",
              "commit the product tree, then run close again")

    # 2. Anything the seal will refuse on, said now rather than last.
    state = load_json(run_state_path(base), default={})
    story = state.get("issue_key") or state.get("story") or ""
    problems = task_seal_shared_problems(base, story)
    if problems:
        _stop("open items", "; ".join(problems),
              "resolve them, then run close again")

    # 3. One identity for everything that follows.
    delta_id = product_delta_digest(base, stage_baseline(base, stage))

    # 4. A done stage whose diff moved (a post-seal fix) reopens itself. No
    #    separate verb, no hidden state flip.
    if stage.get("status") == "done":
        if stamp_is_fresh(base, stage, task):
            print(f"{task_id} is closed and its review covers the current diff.")
        else:
            reopen_stage_for_review_fix(base, task_id)
            stage = _find(load_stages(base), task_id)
            print(f"{task_id} reopened: the diff moved since it was sealed.")

    if stage.get("status") == "active":
        # 5. Proof first. A failing required test is the cheapest stop there
        #    is, and finding it after a review turned every test fix into a
        #    review as well.
        proof = run_stage_proof(base, task_id, task)

        # 6. Review only if no stamp covers THIS delta.
        if not stamp_is_fresh(base, stage, task):
            outcome = review_task(
                base, task_id, engine=getattr(args, "engine", "codex"),
                max_priority=getattr(args, "max_priority", "P2"),
                skill=getattr(args, "skill", None),
                parallel=not getattr(args, "sequential", False))
            if outcome["blocking"]:
                _stop("review", f"{outcome['blocking']} blocking finding(s)",
                      f"delegate the fixes (`./forge delegate {task_id}`), commit, "
                      "run close again -- it re-reviews only the new diff")
            stage = _find(load_stages(base), task_id)
        else:
            print(f"{task_id}: review stamp covers this diff ({delta_id[:12]}); "
                  "no review needed.")

        # 7. Measure (notes), close. Same lock and same checks `stage done`
        #    holds; the proof is the one already run.
        class _Done:
            pass
        done_args = _Done()
        done_args.id = task_id
        done_args.repo = str(base)
        done_args.incomplete = ""
        with delegation_exclusion(base, task_id, kind="stage-close"):
            data = load_stages(base)
            current = _find(data, task_id)
            if current.get("status") != "active":
                fail(f"{task_id} changed state while close was waiting for "
                     "exclusive access; inspect `forge stage list` and retry.")
            _finish_stage(base, done_args, data, current, task_for(base, task_id),
                          proof=proof)

    # 8. Seal: marker, push, PR. Idempotent.
    seal_task(base, task_id)
