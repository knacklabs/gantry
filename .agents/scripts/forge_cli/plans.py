"""forge plan save/assume — approved plans and implementation assumptions."""
from __future__ import annotations

import argparse
import datetime
from pathlib import Path

from factory_lib import (
    dump_json, load_json, now_iso, repo_root, require_grill, run_state_path, slugify,
)

from .common import fail
from .context import pending_context


def cmd_save(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    if not state or not state.get("client_signoff"):
        fail(
            "plan approval requires an initialized run with client sign-off. Run "
            "intake, get docs/decisions/NNNN-client-signoff.md accepted, run "
            "record_signoff.py, then save the plan."
        )
    pending = pending_context(base)
    if pending:
        fail(
            f"{len(pending)} docs/context/ file(s) are unharvested: {', '.join(pending[:5])}"
            f"{'…' if len(pending) > 5 else ''}. Plans must not be approved over pending "
            "context — run `forge.py context scan`, harvest per .agents/prompts/harvester.md "
            "or mark irrelevant ones `forge.py context mark <file> --ignored`, then save."
        )
    issue = args.issue or state.get("issue_key")
    if not issue:
        fail("no --issue given and no issue_key in .factory/run.json (run intake first)")
    source = Path(args.source).expanduser()
    if not source.is_file():
        fail(f"plan source {source} not found — pass the approved plan file via --from")
    # Approval requires the plan to have been GRILLED (grill-me / griller.md
    # --gate plan): fresh, passing, for THIS task, and bound by digest to
    # THIS draft — grilling one version never approves an edited one.
    require_grill(
        base, "plan",
        ("docs/product/", "docs/decisions/", "docs/architecture/"),
        ignore_names=("client-signoff", "epics-approved"),
        expect_digest_of=source,
    )
    plan_grill = load_json(base / ".factory" / "grills" / "plan.json", default={})
    if plan_grill.get("issue") != issue:
        fail(
            f"the recorded plan grill is for {plan_grill.get('issue')!r}, not {issue!r} — "
            "grill THIS task's plan (record_grill_from_json.py --gate plan)."
        )
    # Surfaces left implicit are how API/CLI/docs/tests drift ships: the plan
    # must classify every surface, with a reason on anything not Changed.
    if "## Surface Impact" not in source.read_text():
        fail(
            "the plan has no '## Surface Impact' section. Classify each surface "
            "(runtime behavior, API, data/schema, CLI/ops, UI, docs, tests) as "
            "Changed / Read-only / Unchanged by design / Deferred / N-A — "
            "Deferred and Unchanged-by-design entries need a reason "
            "(.agents/prompts/planner.md)."
        )
    title = args.title or state.get("title") or issue
    dest_dir = base / "plans" / "active"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{issue}-{slugify(title)}.md"
    header = (
        f"---\nissue: {issue}\ntitle: {title}\nstatus: approved\nsaved: {now_iso()}\n---\n\n"
    )
    dest.write_text(header + source.read_text())
    if state:
        state["plan_status"] = "approved"
        state["plan_file"] = dest.relative_to(base).as_posix()
        state["updated_at"] = now_iso()
        dump_json(run_state_path(base), state)
    print(f"Plan saved to {dest.relative_to(base)} (plan_status: approved)")
    print(
        "Decisions made while planning must exist as docs/decisions/ records "
        "(forge.py decision new <slug>) and be referenced in the plan."
    )


def cmd_assume(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    issue = args.issue or state.get("issue_key")
    if not issue:
        fail("no --issue given and no issue_key in .factory/run.json (run intake first)")
    plans = sorted((base / "plans" / "active").glob(f"{issue}-*.md"))
    if not plans:
        fail(
            f"no active plan for {issue} (plans/active/{issue}-*.md). Save the approved "
            "plan first with `forge.py plan save` — assumptions attach to a plan."
        )
    plan = plans[-1]
    text = plan.read_text()
    heading = "## Implementation Assumptions"
    entry = f"- {datetime.date.today().isoformat()}: {args.text.strip()}\n"
    if heading in text:
        text = text.rstrip("\n") + "\n" + entry
    else:
        text = (
            text.rstrip("\n")
            + f"\n\n{heading}\n\n"
            "<!-- Made during implementation, NOT part of the approved plan. "
            "Dev: review these before merge; promote any that matter to docs/decisions/. -->\n"
            + entry
        )
    plan.write_text(text)
    from .assumptions import append_row
    entry_id = append_row(base, issue, args.text)
    print(f"Assumption recorded in {plan.relative_to(base)} and ledgered as {entry_id} "
          "(plans/assumptions.md)")
    print("The orchestrator guides it: forge.py assumptions resolve "
          f"{entry_id} --status confirmed|fix-needed|promoted --notes \"...\" — "
          "pr_ready refuses while it is open.")
