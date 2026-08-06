"""forge plan save/assume — approved plans and implementation assumptions."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import re
from pathlib import Path
from typing import Any

import factory_lib
from factory_lib import (
    client_signoff, dump_json, load_json, now_iso, repo_root, require_grill,
    run_state_path, slugify,
)

from .common import fail
from .events import append_event
from .context import pending_context
from .decisions import active_decision_ids, decision_records
from .signal import open_signals

FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)

REQUIRED_PLAN_SECTIONS = (
    "Problem",
    "Scope / Non-goals",
    "Acceptance Criteria",
    "Technical Approach",
    "Decisions",
    "Surface Impact",
    "Task Decomposition",
    "Risks",
    "Verify Plan",
)


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text
    fields: dict[str, Any] = {}
    list_field: str | None = None
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if list_field and stripped.startswith("- "):
            fields[list_field].append(stripped[2:].strip().strip("\"'"))
            continue
        list_field = None
        if ":" not in line:
            continue
        key, _, raw = line.partition(":")
        key = key.strip()
        value = raw.strip()
        if value == "[]":
            fields[key] = []
        elif not value:
            fields[key] = []
            list_field = key
        elif value.startswith("[") and value.endswith("]"):
            fields[key] = [
                item.strip().strip("\"'")
                for item in value[1:-1].split(",") if item.strip()
            ]
        else:
            fields[key] = value.strip("\"'")
    return fields, text[match.end():]


def body_sha256(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


def _stages_progress(base: Path, issue: str, location: str) -> str:
    path = (
        base / ".factory" / "stages.json"
        if location == "active"
        else base / ".factory" / "history" / issue / "stages.json"
    )
    stages = load_json(path, default={}).get("stages", [])
    if not stages:
        return "-"
    done = sum(1 for stage in stages if stage.get("status") == "done")
    return f"{done}/{len(stages)}"


def cmd_save(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    state = load_json(run_state_path(base), default={})
    # Sign-off FIRST, and deliberately: it is derived from committed
    # harness.yaml, so it holds even with no run state at all — deleting
    # .factory/run.json cannot bypass the gate (autoreview r6).
    ok, why = client_signoff(base)
    if not ok:
        fail(f"plan approval requires client sign-off. {why}")
    if not state:
        fail("plan approval requires an initialized run. Run intake first.")
    pending = pending_context(base)
    if pending:
        fail(
            f"{len(pending)} docs/context/ file(s) are unharvested: {', '.join(pending[:5])}"
            f"{'…' if len(pending) > 5 else ''}. Plans must not be approved over pending "
            "context — run `forge.py context scan`, harvest per factory/prompts/harvester.md "
            "or mark irrelevant ones `forge.py context mark <file> --ignored`, then save."
        )
    issue = args.issue or state.get("issue_key")
    if not issue:
        fail("no --issue given and no issue_key in .factory/run.json (run intake first)")
    source = Path(args.source).expanduser()
    if not source.is_file():
        fail(f"plan source {source} not found — pass the approved plan file via --from")
    story = args.story or issue
    roadmap_items = load_json(base / "plans" / "roadmap.json", default={}).get("items", [])
    item = next((i for i in roadmap_items if i.get("key") == story), None)
    if item is None:
        fail(f"--story {story!r} is not in plans/roadmap.json")
    # Capture is not build authorization: `roadmap add --no-spec` exists so an
    # ad-hoc ask is visible rather than smuggled in, and this is where that debt
    # comes due — decision 0014 still governs what may be BUILT. Stories from
    # the PM handoff (`roadmap import`) are unaffected; only the escape hatch is.
    elif item.get("spec_debt_reason") and not item.get("spec"):
        fail(f"{story} was captured without a spec ({item['spec_debt_reason']}) — "
             "capture is not authorization (decision 0014). Draft and confirm the "
             f"capability spec, then: ./forge roadmap link-spec {story} "
             "--spec docs/specs/<slug>.md")
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
    contradictions = [
        signal for signal in open_signals(base) if signal.get("kind") == "contradiction"
    ]
    if contradictions:
        fail(
            "plan save refused while an open contradiction signal exists: "
            + ", ".join(signal["id"] for signal in contradictions)
            + ". Resolve the contradiction before approving the plan."
        )
    fields, body = parse_frontmatter(source.read_text())
    if "decisions_reviewed" not in fields or not isinstance(
        fields["decisions_reviewed"], list
    ):
        fail(
            "plan frontmatter must include decisions_reviewed as a list of every "
            "active decision id (`./forge decision list --active`)."
        )
    reviewed = set(fields["decisions_reviewed"])
    active = set(active_decision_ids(base))
    missing = sorted(active - reviewed)
    inactive = sorted(reviewed - active)
    if missing:
        fail("decisions_reviewed is missing active decisions: " + ", ".join(missing))
    if inactive:
        known = {str(record["id"]) for record in decision_records(base)}
        labels = [
            decision if decision not in known else f"{decision} (inactive)"
            for decision in inactive
        ]
        fail("decisions_reviewed contains unknown or inactive decisions: "
             + ", ".join(labels))
    sections = factory_lib.parse_sections(body)
    missing_sections = [
        section for section in REQUIRED_PLAN_SECTIONS if not sections.get(section)
    ]
    if missing_sections:
        fail("the plan is missing required sections: " + ", ".join(missing_sections))
    plan_digest = body_sha256(body)
    marker = load_json(base / ".factory" / "plan-approval.json", default={})
    # Bind to (issue, story) as well as the body: a body digest alone could be
    # replayed by saving the same text under a different --story/--issue, which
    # would approve a plan the human never reviewed in that context.
    approved = (marker.get("plan_sha256") == plan_digest
                and marker.get("issue") == issue
                and marker.get("story") == story)
    status = "approved" if approved else "awaiting-approval"
    title = args.title or state.get("title") or issue
    dest_dir = base / "plans" / "active"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{issue}-{slugify(title)}.md"
    decisions = "\n".join(f"  - {decision}" for decision in sorted(reviewed))
    decisions_value = f"\n{decisions}" if decisions else " []"
    header = (
        f"---\nissue: {issue}\ntitle: {title}\nstatus: {status}\n"
        f"saved: {now_iso()}\nstory: {story}\n"
        f"decisions_reviewed:{decisions_value}\n---\n"
    )
    dest.write_text(header + body)
    if state:
        state["plan_status"] = status
        state["plan_file"] = dest.relative_to(base).as_posix()
        state["story"] = story
        state["updated_at"] = now_iso()
        dump_json(run_state_path(base), state)
    if not approved:
        fail(
            f"plan saved to {dest.relative_to(base)} with plan_status awaiting-approval. "
            "A human must review it in plan mode, then run "
            "`./forge plan approve --by \"<name>\"` and save the unchanged plan again."
        )
    # Consume the marker: it authorizes exactly one save (0029). Leaving it
    # would let a later awaiting-approval reset re-approve the same body with no
    # fresh human action — the replay hole autoreview flagged.
    (base / ".factory" / "plan-approval.json").unlink(missing_ok=True)
    append_event(base, "plan-approved", actor="planner-high", story=story,
                 detail=dest.relative_to(base).as_posix())
    print(f"Plan saved to {dest.relative_to(base)} (plan_status: approved)")
    print(
        "Decisions made while planning must exist as docs/decisions/ records "
        "(forge.py decision new <slug>) and be referenced in the plan."
    )


def cmd_approve(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    approver = args.by.strip()
    if not approver:
        fail("plan approval requires --by with the human approver's name")
    state = load_json(run_state_path(base), default={})
    plan_file = state.get("plan_file")
    plan = base / plan_file if isinstance(plan_file, str) else None
    if plan is None or not plan.is_file():
        # `plan save --issue <key>` with no run.json records no plan_file, so
        # fall back to the active plan on disk. An explicit --issue selects
        # among several; a single active plan needs no selector; anything
        # ambiguous is refused rather than guessed.
        issue = args.issue or state.get("issue_key")
        active = sorted((base / "plans" / "active").glob("*.md"))
        if issue:
            issue_plans = [p for p in active if p.name.startswith(f"{issue}-")]
            plan = issue_plans[0] if len(issue_plans) == 1 else None
        elif len(active) == 1:
            plan = active[0]
    if plan is None or not plan.is_file():
        fail("no current active plan to approve — pass --issue <key> to select "
             "one, or run `forge plan save` first")
        return  # unreachable (fail raises); narrows `plan` to a real path below
    fields, body = parse_frontmatter(plan.read_text())
    # The approval is for THIS plan in THIS context: bind issue and story so a
    # matching body cannot be replayed under a different story.
    marker = {
        "plan_sha256": body_sha256(body),
        "issue": fields.get("issue") or state.get("issue_key"),
        "story": fields.get("story") or state.get("story")
                 or fields.get("issue") or state.get("issue_key"),
        "approver": approver,
        "at": now_iso(),
    }
    dump_json(base / ".factory" / "plan-approval.json", marker)
    # A committed audit trail of who approved and when — the marker itself is
    # ephemeral (0025), so the event is the durable record of the human gate.
    # actor is the allowlisted "human"; the approver's name is the detail.
    append_event(base, "plan-human-approved", actor="human",
                 story=marker["story"] or "",
                 detail=f"{marker['issue']} approved by {approver}")
    print(
        f"Plan approved by {approver}. Re-run `forge plan save --from <plan-file>` "
        "with the unchanged plan to continue."
    )


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    roadmap = {
        item.get("key"): item
        for item in load_json(base / "plans" / "roadmap.json", default={}).get("items", [])
    }
    rows = []
    for location in ("active", "completed"):
        for path in sorted((base / "plans" / location).glob("*.md")):
            fields, _ = parse_frontmatter(path.read_text())
            issue = str(fields.get("issue", "-"))
            story = str(fields.get("story", "-"))
            rows.append((
                location,
                issue,
                story,
                str(fields.get("status", "-")),
                str(roadmap.get(story, {}).get("status", "-")),
                _stages_progress(base, issue, location),
                path.relative_to(base).as_posix(),
            ))
    if not rows:
        print("No active or completed plans.")
        return
    print("LOCATION  ISSUE  STORY  PLAN      ROADMAP  STAGES  FILE")
    for row in rows:
        print(f"{row[0]:<9} {row[1]:<6} {row[2]:<6} {row[3]:<9} "
              f"{row[4]:<8} {row[5]:<6} {row[6]}")


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
