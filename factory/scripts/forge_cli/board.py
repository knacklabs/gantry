"""forge board — read-only localhost lifecycle dashboard."""
from __future__ import annotations

import argparse
import json
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from factory_lib import (
    evidence_path, load_json, now_iso, parse_sections,
    plan_digest_without_assumptions, repo_root, run_state_path, story_dir, task_rows,
)

# Shipped/archived plans move out of active|completed; scan debt too or a
# shipped story reads as unplanned (no plan, stale approval blockers).
PLAN_LOCATIONS = ("active", "completed", "debt")
from record_signoff import REQUIRED_BRIEF_HEADINGS

from . import events
from . import fscache
from .assumptions import open_count as open_assumptions
from .decisions import decision_records
from .plans import parse_frontmatter
from .quickfix import ledger_path, load_active
from .readiness import review_passed, tests_passed, verify_passed
from .roadmap import load_roadmap, ready_pending
from .signal import open_signals
from .codex_status import STALL_MINUTES
from .specs import spec_records


def _plan_records(base: Path, location: str) -> list[dict]:
    # Every request scans all three plan locations to find one plan, and the
    # board polls itself every few seconds. Memoised against the directory's
    # stamp, so an added, edited, renamed or removed plan still reads fresh.
    directory = base / "plans" / location

    def compute() -> list[dict]:
        records = []
        for path in sorted(directory.glob("*.md")):
            fields, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
            records.append({
                **fields,
                "path": path.relative_to(base).as_posix(),
                "location": location,
            })
        return records

    records = fscache.cached(
        f"plan_records:{base}:{location}",
        fscache.dir_stamp(directory, ".md"), compute,
    )
    # Hand out copies: a caller mutating a record must not corrupt the memo.
    return [dict(record) for record in records]


def _stages_for(base: Path, story: str) -> dict:
    """Stage state for exactly this story.

    Stage status lives in a single git-local ``stages.json`` keyed to the active
    story, unlike every other evidence file (decomposition/verify/tests/reviews),
    which is per-story. A per-story scoped snapshot wins when present; otherwise
    the singleton is trusted only when its ``issue`` names THIS story — so a newly
    active but undecomposed story no longer inherits the previous story's stages,
    and a shipped story is not mislabelled from the next story's file.
    """
    if not story:  # no active story -> no active stages (story_dir rejects "")
        return {}
    scoped = story_dir(base, story) / "stages.json"
    if scoped.is_file():
        return load_json(scoped, default={})
    data = load_json(base / ".factory" / "stages.json", default={})
    return data if data.get("issue") == story else {}


def _stage_summary(base: Path) -> dict:
    story = load_json(run_state_path(base), default={}).get("issue_key", "")
    data = _stages_for(base, story)
    items = data.get("stages", [])
    return {
        "issue": data.get("issue"),
        "done": sum(1 for stage in items if stage.get("status") == "done"),
        "total": len(items),
        "items": items,
    }


TASK_NARRATIVE = ("objective", "acceptance_criteria", "reviewer_focus",
                  "write_scope", "verify_commands", "required_tests", "dependencies")


def merge_task_detail(
    decomposition: dict, stages: list[dict], derived_rows: list[dict] | None = None,
) -> list[dict]:
    """The stage tracker knows what is DONE; the decomposition knows what the
    task was FOR. Neither alone answers "what is this task?", and the tracker
    deliberately keeps only id/title/status so the two never disagree about
    progress — so they are joined here, at read time, by task id."""
    planned_tasks = decomposition.get("tasks", [])
    planned = {t.get("id"): t for t in planned_tasks}
    stage_by_id = {stage.get("id"): stage for stage in stages}
    derived = {row.get("id"): row for row in (derived_rows or [])}
    tasks = []
    sources = (
        [stage_by_id.get(task.get("id"), {
            "id": task.get("id"), "title": task.get("title"),
        }) for task in planned_tasks]
        if derived_rows is not None else stages
    )
    for stage in sources:
        task = {"id": stage.get("id"), "title": stage.get("title"),
                "status": stage.get("status", "pending"),
                "started_at": stage.get("started_at"),
                "completed_at": stage.get("completed_at")}
        source = planned.get(stage.get("id"), {})
        task.update({field: source[field] for field in TASK_NARRATIVE if field in source})
        task.update(derived.get(stage.get("id"), {}))
        tasks.append(task)
    return tasks


def _plan_evidence(
    base: Path, story_key: str, plan: dict | None,
    derived_rows: list[dict] | None = None,
) -> tuple[dict | None, dict, list]:
    """Stage progress, gate evidence, and the story's real task list.

    Tasks exist once a story is decomposed. A live story reads them via its plan
    record; a SHIPPED story's plan has moved out of plans/active|completed (to
    completed/, debt/, or elsewhere), so fall back to the story key and read the
    archived decomposition directly — otherwise a shipped story's task graph
    silently disappears from the board. An unplanned story (no plan AND no
    recorded decomposition) returns none rather than inventing children.
    """
    empty_reviews = {aspect: False for aspect in ("quality", "performance", "security")}
    story = str((plan or {}).get("story") or (plan or {}).get("issue")
                or story_key or "")
    decomposition = (load_json(evidence_path(base, story, "decomposition.json"),
                               default={}) if story else {})
    if not plan and not decomposition.get("tasks"):
        return None, {"verify": False, "tests": False, "reviews": empty_reviews}, []
    stages_data = _stages_for(base, story)
    stages = stages_data.get("stages", [])
    progress = None
    if stages:
        progress = {
            "done": sum(1 for stage in stages if stage.get("status") == "done"),
            "total": len(stages),
        }
    tasks = merge_task_detail(decomposition, stages, derived_rows)
    # The same predicates pr_ready gates on: a tick here must mean the gate
    # would open, not merely that a file is on disk.
    recorded = load_json(evidence_path(base, story, "tests.json"), default={})
    evidence = {
        "verify": verify_passed(load_json(
            evidence_path(base, story, "verify.json"), default={})),
        "tests": tests_passed(recorded.get("automated")) and (
            tests_passed(recorded.get("functional"), functional=True)
            if recorded.get("functional") else True),
        "reviews": {
            aspect: review_passed(load_json(
                evidence_path(base, story, f"reviews/{aspect}.json"), default={}))
            for aspect in ("quality", "performance", "security")
        },
    }
    return progress, evidence, tasks


# The four states every story is in, exactly once — the segments of the
# project bar. "blocked" is a graph fact that clears when a parent ships;
# "needs you" is counted separately because a human must act on it.
def _story_state(story: dict, blocked: bool) -> str:
    lifecycle = story["lifecycle"]
    if lifecycle["shipped"]:
        return "shipped"
    if lifecycle["planned"]:
        return "building"
    if blocked:
        return "blocked"
    return "ready" if story["ready_to_plan"] else "waiting"


def _summary(stories: list[dict], specs: list[dict], signals: list[dict],
             assumptions_open: int) -> dict:
    counts = {state: 0 for state in
              ("shipped", "building", "ready", "waiting", "blocked")}
    for story in stories:
        counts[story["state"]] += 1
    spec_gaps = [s["key"] for s in stories
                 if s["lifecycle"]["spec"] != "confirmed" and not s["lifecycle"]["shipped"]]
    contradictions = [s["id"] for s in signals if s.get("kind") == "contradiction"]
    referenced = {s.get("spec") for s in stories if s.get("spec")}
    epics: dict[str, dict] = {}
    for story in stories:
        key = story.get("epic") or "Backlog"
        bucket = epics.setdefault(key, {"key": key, "total": 0, "shipped": 0})
        bucket["total"] += 1
        bucket["shipped"] += story["state"] == "shipped"
    return {
        "stories": {"total": len(stories), **counts},
        "attention": {
            "total": len(contradictions) + assumptions_open + len(spec_gaps),
            "contradictions": contradictions,
            "assumptions": assumptions_open,
            "spec_gaps": spec_gaps,
        },
        "specs": {
            "total": len(specs),
            "draft": [s["slug"] for s in specs if s.get("status") != "confirmed"],
            "unreferenced": [s["slug"] for s in specs if s["path"] not in referenced],
        },
        "epics": list(epics.values()),
    }


def quickfix_ledger(base: Path) -> list[dict]:
    """Closed quickfix windows, for the Library panel.

    Reads through the shared ledger helper (decision 0022), so the directory
    form and any legacy .jsonl both land here, ordered by each record's own
    timestamp rather than by position in a file a merge could rewrite.
    """
    from .quickfix import load_events
    return [event for event in load_events(base) if event.get("event") == "done"]


def pr_links(base: Path) -> dict[str, str]:
    """Latest recorded PR reference for each story."""
    return {
        event["story"]: event["detail"]
        for event in events.load_events(base, event="pr-linked")
        if event.get("story") and event.get("detail")
    }


def project_identity(base: Path) -> dict:
    """Project identity and capture status, derived from the committed brief.

    The name is the one `forge init --name` AUTHORED into run.json — `--name
    "Acme Billing"` into ~/work/acme-billing must read as Acme Billing, not
    its slug — falling back to the directory for a repo that never authored
    one. `pr_ready` carries `project` into the shipped run state, so it
    survives the whole lifecycle.

    The BRIEF's H1 is deliberately NOT a source: it is a document title, which
    is why the scaffold ships "# Product Brief". A repo that wants a name on
    the board authors one; inferring it from a heading would put a document's
    title where a project's name belongs.
    """
    brief = base / "docs" / "product" / "BRIEF.md"
    sections = parse_sections(brief.read_text(encoding="utf-8")) if brief.is_file() else {}
    authored = load_json(base / ".factory" / "run.json", default={})
    name = authored.get("project") if isinstance(authored, dict) else ""
    return {
        # resolve(): Path(".").name is "", which would render a nameless project.
        "name": (name or "").strip() or base.resolve().name,
        "sections": sections,
        "missing_sections": [
            heading for heading in REQUIRED_BRIEF_HEADINGS
            if not sections.get(heading, "").strip()
        ],
    }


def derived_epics(roadmap: dict, stories: list[dict]) -> list[dict]:
    """Resolve epic membership, progress, and authored cross-epic gating."""
    epics = [dict(epic) for epic in roadmap.get("epics", [])]
    by_id = {epic.get("id"): epic for epic in epics}
    story_epic = {story.get("key"): story.get("epic") for story in stories}
    blocked_by = {epic_id: [] for epic_id in by_id}

    for epic_id, epic in by_id.items():
        members = [story for story in stories if story.get("epic") == epic_id]
        epic["stories"] = [story.get("key") for story in members]
        epic["progress"] = {
            "done": sum(story.get("status") == "done" for story in members),
            "total": len(members),
        }
        for story in members:
            for dependency in story.get("depends_on", []):
                dependency_epic = story_epic.get(dependency)
                if (dependency_epic in by_id and dependency_epic != epic_id
                        and dependency_epic not in blocked_by[epic_id]):
                    blocked_by[epic_id].append(dependency_epic)

    for epic_id, epic in by_id.items():
        epic["blocked_by"] = blocked_by[epic_id]
        epic["unblocks"] = [
            other_id for other_id in by_id
            if epic_id in blocked_by[other_id]
        ]
    return epics


def aggregate_state(base: Path) -> dict:
    roadmap = load_roadmap(base)
    items = roadmap.get("items", [])
    ready, _ = ready_pending(items)
    frontier = [item["key"] for item in ready]
    plans = {loc: _plan_records(base, loc) for loc in PLAN_LOCATIONS}
    # `story` postdates the earliest plans; fall back to `issue`, or every
    # story on a legacy project renders unplanned. Iterate so a live plan wins
    # over an archived one for the same story (active is last, overwrites debt).
    plan_by_story = {
        plan.get("story") or plan.get("issue"): plan
        for location in reversed(PLAN_LOCATIONS)
        for plan in plans[location]
        if plan.get("story") or plan.get("issue")
    }
    specs = [
        {key: value for key, value in record.items() if key != "_path"}
        for record in spec_records(base)
    ]
    spec_status = {record["path"]: record.get("status", "draft") for record in specs}
    run = load_json(run_state_path(base), default={})
    active = run.get("issue_key")
    live_task_rows = task_rows(base) if active else []
    record_origin = load_json(base / ".factory" / "record-origin.json", default=None)
    stages = _stage_summary(base)
    story_pr_links = pr_links(base)
    done_keys = {item.get("key") for item in items if item.get("status") == "done"}
    unblocks = {item.get("key"): [] for item in items}
    for item in items:
        for dependency in item.get("depends_on", []):
            if dependency in unblocks:
                unblocks[dependency].append(item.get("key"))
    stories = []
    for item in items:
        story = dict(item)
        plan = plan_by_story.get(item.get("key"))
        progress, evidence, tasks = _plan_evidence(
            base, item.get("key"), plan,
            live_task_rows if item.get("key") == active else None,
        )
        story["ready_to_plan"] = item.get("key") in frontier
        story["plan"] = plan
        story["tasks"] = tasks
        story["pr_link"] = (story_pr_links.get(item.get("key"))
                            if item.get("status") == "done" else None)
        story["blocked_by"] = [dep for dep in item.get("depends_on", [])
                               if dep not in done_keys]
        story["unblocks"] = unblocks.get(item.get("key"), [])
        story["lifecycle"] = {
            "spec": spec_status.get(item.get("spec"), "missing"),
            "roadmap": True,
            "planned": plan is not None or bool(tasks),
            "stages": progress,
            "verify": evidence["verify"],
            "tests": evidence["tests"],
            "reviews": evidence["reviews"],
            "shipped": item.get("status") == "done",
        }
        story["state"] = _story_state(story, bool(story["blocked_by"]))
        stories.append(story)
    epics = derived_epics(roadmap, stories)
    signals = open_signals(base)
    return {
        "generated_at": now_iso(),
        "root": str(base.resolve()),
        "specs": specs,
        "project": project_identity(base),
        "record_origin": record_origin,
        "epics": epics,
        "stories": stories,
        "summary": _summary(stories, specs, signals, open_assumptions(base)),
        "frontier": frontier,
        "plans": plans,
        "run": {
            key: run.get(key)
            for key in ("issue_key", "phase", "plan_status", "decomposition_status",
                        "plan_file", "story")
        },
        "stages": stages,
        # Same read as `signals` above; calling open_signals twice re-parsed the
        # signal log for one response.
        "signals": signals,
        "quickfix": load_active(base) or None,
        "quickfix_ledger": quickfix_ledger(base),
        "next": next_actions(base),
        "decisions": active_decisions(base),
        "signoff": signoff_state(base),
    }


def _next_actions_stamp(base: Path) -> tuple:
    """What `forge next` derives from, read cheaply. The git-control dir holds
    the authoritative run/stage/decomposition state; `.factory` and `plans` hold
    the workspace mirrors and the roadmap; HEAD and the index move on checkout,
    commit and staging. This stands in for the ~750ms of git subprocesses
    `cmd_next` costs.

    `.factory` is stamped as a TREE, not one level. Almost every transition
    writes nested -- a task grill lands in `stories/<key>/grills/tasks/`, a
    review in `stories/<key>/reviews/` -- and touches neither `.factory` nor
    `.factory/stories`, so a one-level stamp reported "unchanged" across most
    of the changes this memo has to notice."""
    from factory_lib import git_control_dir

    try:
        control = git_control_dir(base)
        git_stamps: tuple = (
            fscache.dir_stamp(control),
            fscache.file_stamp(control.parent / "HEAD"),
            fscache.file_stamp(control.parent / "index"),
        )
    except SystemExit:
        # The bundled board example — and any directory the board is pointed at
        # that is not a git repo root — has no control dir. `cmd_next` already
        # tolerates that, so the stamp must too rather than turning a rendered
        # board into a crash.
        git_stamps = ("<no-git-control-dir>",)
    return (
        git_stamps,
        fscache.tree_stamp(base / ".factory"),
        fscache.dir_stamp(base / "plans" / "active", ".md"),
        fscache.file_stamp(base / "plans" / "roadmap.json"),
        # `forge next` branches on accepted decisions and confirmed specs too.
        fscache.dir_stamp(base / "docs" / "decisions", ".md"),
        fscache.dir_stamp(base / "docs" / "specs", ".md"),
    )


def next_actions(base: Path) -> dict:
    """The deterministic 'where am I / what now', as the CLI computes it.

    # ponytail: captures cmd_next's own output rather than duplicating 100
    # lines of gate branching — one source of truth. If the shape ever needs
    # more than phase + steps, extract a builder from cmd_next instead.

    `cmd_next` shells out to git repeatedly, which dominated every `/api/state`
    poll; memoised against the state it reads.
    """
    def compute() -> dict:
        import argparse
        import contextlib
        import io

        from .phase import cmd_next

        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer):
                cmd_next(argparse.Namespace(repo=str(base)))
        except SystemExit:
            pass
        phase, steps = "", []
        for line in buffer.getvalue().splitlines():
            if line.startswith("PHASE:"):
                phase = line[len("PHASE:"):].strip()
            elif re.match(r"\s+\d+\.\s", line):
                steps.append(line.strip().split(". ", 1)[-1])
        return {"phase": phase, "steps": steps}

    actions = fscache.cached(
        f"next_actions:{base}", _next_actions_stamp(base), compute)
    return {"phase": actions["phase"], "steps": list(actions["steps"])}


def active_decisions(base: Path) -> list[dict]:
    """Accepted decisions AND the ones still waiting on a human.

    Only accepted records used to reach the board, which hid the only decision
    state a person can act on: a PROPOSED decision governs nothing until it is
    accepted, and until then the work resting on it is resting on a question
    nobody answered. Showing only the settled ones made the board quietest
    exactly where it should have been loudest.
    """
    records = decision_records(base)
    return [
        {"id": str(r.get("id") or r.get("slug") or ""),
         "title": str(r.get("title") or ""),
         "status": str(r.get("status") or ""),
         "path": Path(str(r["path"])).relative_to(base).as_posix() if r.get("path") else ""}
        for r in records if r.get("status") in ("accepted", "proposed")
    ]


def signoff_state(base: Path) -> dict:
    """Whether the project is signed off, and what its handover grill said.

    The sign-off grill is project-level (`.factory/grills/signoff.json`), not
    story-scoped, so the board -- which reads grills from the STORY directory
    -- never saw it. It is the gate every other gate sits behind: before it
    passes, planning is refused outright.
    """
    from factory_lib import client_signoff

    signed, reason = client_signoff(base)
    grill = load_json(base / ".factory" / "grills" / "signoff.json", default={})
    return {
        "signed_off": bool(signed),
        "reason": "" if signed else str(reason or ""),
        "grill": {
            "verdict": str(grill.get("verdict") or ""),
            "at": str(grill.get("at") or grill.get("recorded_at") or ""),
            "gaps": len(grill.get("gaps") or []),
        } if grill else None,
    }


def approval_readiness(base: Path, detail: dict) -> list[dict]:
    """What still stands between this story's plan and approval.

    Mirrors the refusals in `forge plan save` so the board explains a gate
    rather than offering a button that would bypass it.
    """
    checks = []
    plan = detail.get("plan")
    body = detail.get("plan_body") or ""
    grill = (detail.get("evidence", {}).get("grills") or {}).get("plan")
    reviewed = set(plan.get("decisions_reviewed") or []) if plan else set()
    active = {d["id"] for d in active_decisions(base)}
    missing = sorted(active - reviewed)
    contradictions = [s["id"] for s in open_signals(base)
                      if s.get("kind") == "contradiction"]
    checks.append({
        "ok": bool(plan), "label": "plan saved",
        "fix": "write the plan, then ask to save it against this story"})
    checks.append({
        "ok": bool(grill) and grill.get("verdict") == "pass",
        "label": "plan grill passed",
        "fix": "grill the plan and record the result — ask for it; save refuses without a passing grill"})
    checks.append({
        "ok": not missing,
        "label": "decisions reviewed" + (f" — {len(missing)} missing" if missing else ""),
        # The ids are the evidence, but sixteen of them inline is a wall of
        # text; the board discloses them behind the count.
        "detail": missing,
        "fix": "the plan must attest every active decision — ask for the missing ones"})
    checks.append({
        "ok": "## Surface Impact" in body,
        "label": "Surface Impact section",
        "fix": "the plan must classify every surface — runtime, API, data, CLI, UI, docs, tests"})
    checks.append({
        "ok": not contradictions,
        "label": "no open contradiction" + (f" — {', '.join(contradictions)}" if contradictions else ""),
        "fix": "answer the paused worker in your session"})
    return checks


def story_detail(base: Path, key: str) -> dict | None:
    """The evidence bundle for one story, loaded on demand.

    The key is matched against the roadmap rather than used as a path, so no
    request can address a file outside the artifacts this story owns.
    """
    roadmap = load_roadmap(base)
    items = roadmap.get("items", [])
    item = next((i for i in items if i.get("key") == key), None)
    if item is None:
        return None
    plan = next(
        (record for location in PLAN_LOCATIONS
         for record in _plan_records(base, location)
         if record.get("story") == key or record.get("issue") == key),
        None,
    )
    plan_body = ""
    if plan:
        _, plan_body = parse_frontmatter((base / plan["path"]).read_text(encoding="utf-8"))
    active = load_json(run_state_path(base), default={}).get("issue_key")
    evidence = {
        name: load_json(evidence_path(base, key, f"{name}.json"), default=None)
        for name in ("decomposition", "verify", "tests", "outcome")
    }
    # Stages are the one evidence file that is not per-story on disk; read them
    # issue-guarded so a shipped or non-active story shows its own task status.
    evidence["stages"] = _stages_for(base, key) or None
    evidence["reviews"] = {
        aspect: load_json(
            evidence_path(base, key, f"reviews/{aspect}.json"), default=None)
        for aspect in ("quality", "performance", "security")
    }
    grills = evidence_path(base, key, "grills")
    evidence["grills"] = {
        path.stem: load_json(path, default=None)
        for path in sorted(grills.glob("*.json"))
    }
    evidence["task_grills"] = {
        path.stem: load_json(path, default=None)
        for path in sorted((grills / "tasks").glob("*.json"))
    }
    spec_path = item.get("spec")
    spec = None
    if spec_path and (base / spec_path).is_file():
        # `body` stays the EXACT committed source: the raw-json view exists to
        # show the artifact as it is, and stripping here would make the API
        # lossy for every consumer to fix one renderer. The drawer strips
        # frontmatter when it renders prose.
        spec = {"path": spec_path, "body": (base / spec_path).read_text(encoding="utf-8")}
    epic = next(
        (epic for epic in derived_epics(roadmap, items)
         if epic.get("id") == item.get("epic")),
        None,
    )
    story = dict(item)
    story["pr_link"] = (pr_links(base).get(key)
                        if item.get("status") == "done" else None)
    detail = {"key": key, "project": project_identity(base), "epic": epic,
              "story": story, "plan": plan, "plan_body": plan_body,
              "spec": spec, "evidence": evidence}
    detail["task_rows"] = task_rows(base) if active == key else []
    detail["tasks"] = task_dossiers(base, key, detail)
    detail["readiness"] = approval_readiness(base, detail)
    return detail


TASK_PREFIX = re.compile(r"^\s*(?:[-*]|\d+[.)])?\s*(?:\*\*)?[\w.-]+\s*(?:[—–-]\s*[^:*]*)?"
                         r"(?:\*\*)?\s*[:—–-]\s*")


def plan_section(body: str, task_id: str) -> str:
    """This task's own line from the approved plan — the argument for why this
    piece exists, in the plan's words.

    Line-precise, not paragraph-precise: a Task Decomposition is usually one
    unbroken list, so taking the whole block would show every sibling task
    under each task. The leading "1. **TS-3.1 — title**:" is stripped because
    the row above already says exactly that."""
    if not body or not task_id:
        return ""
    lines = body.splitlines()
    for index, line in enumerate(lines):
        if task_id not in line:
            continue
        collected = [TASK_PREFIX.sub("", line).strip()]
        # Keep indented continuations; stop at the next list item or blank line.
        for follow in lines[index + 1:]:
            if not follow.strip() or not follow.startswith((" ", "\t")):
                break
            collected.append(follow.strip())
        text = " ".join(part for part in collected if part)
        return text if len(text) > 3 else ""
    return ""


def task_plan_view(base: Path, key: str, task: dict, grill: dict | None) -> dict:
    """The per-task implementation plan, exposed to the board ONLY once its grill
    is clean — the grill passed AND was recorded against the EXACT current plan
    text (fresh, not stale). A saved-but-not-yet-grill-clean plan is withheld
    entirely (never sent, so it cannot leak through the raw-json view either), so
    a human first sees a task plan on the board only after it survives grilling,
    at which point it is theirs to approve.

    plan_state is 'none' (no plan saved), 'ungrilled' (saved, never survived a
    grill), 'stale' (it DID pass, and the plan text changed afterwards), or
    'clean'. The last two used to share one label, which hid the only
    distinction a reader acts on: 'ungrilled' means the plan was never
    stress-tested, 'stale' means it was and someone has edited it since -- so a
    human who already reviewed it is now looking at different text."""
    plan_path = evidence_path(base, key, f"task-plans/{task['id']}.md")
    if not plan_path.is_file():
        return {"plan_state": "none"}
    if not grill or grill.get("verdict") != "pass":
        return {"plan_state": "ungrilled"}
    digest = plan_digest_without_assumptions(plan_path)
    fresh = digest in (
        grill.get("task_plan_sha256"), grill.get("approved_task_plan_sha256"),
    )
    if not fresh:
        return {"plan_state": "stale"}
    return {
        "plan_state": "clean",
        "plan": plan_path.read_text(encoding="utf-8"),
        "plan_path": plan_path.relative_to(base).as_posix(),
    }


def _worktree_roots(base: Path) -> list[Path]:
    """This repo plus every linked worktree.

    `forge task start` puts each task in its OWN sibling worktree, and a
    worktree has its own git control directory -- so the delegation ledger a
    running companion writes lives under the WORKTREE, not here. A board
    reading only its own root is therefore blind to exactly the runs it most
    needs to report on.

    Read from git's own bookkeeping rather than `git worktree list`: the
    control directory already holds one `worktrees/<name>/gitdir` file per
    linked worktree, so this is a couple of small reads instead of a
    subprocess on a polled path -- and it needs no lenient decode policy for
    process output.
    """
    try:
        from factory_lib import git_control_dir
        from .fscache import cached, dir_stamp
        # git_control_dir appends forge's own subdirectory, so the git dir
        # itself is its parent. From inside a LINKED worktree that git dir is
        # .git/worktrees/<name>, whose grandparent is the shared .git holding
        # the registry every worktree is listed in.
        git_dir = git_control_dir(base).parent
        common = (git_dir.parent.parent
                  if git_dir.parent.name == "worktrees" else git_dir)
        registry = common / "worktrees"
        # The set changes only when `task start` or `worktree prune` touches
        # it, so stamp the registry rather than re-reading on every poll.
        return cached("board.worktree_roots", (str(base), dir_stamp(registry)),
                      lambda: _scan_worktrees(base, registry))
    except (Exception, SystemExit):
        return [base]


def _scan_worktrees(base: Path, registry: Path) -> list[Path]:
    roots = [base]
    if not registry.is_dir():
        return roots
    for entry in sorted(registry.iterdir()):
        pointer = entry / "gitdir"
        try:
            # Points at the worktree's own `.git` file; its parent is the tree.
            recorded = pointer.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            continue
        if not recorded:
            continue
        root = Path(recorded).parent
        try:
            if root.is_dir() and root.resolve() != base.resolve():
                roots.append(root)
        except OSError:
            continue
    return roots


def _codex_jobs_by_root(roots: list[Path]) -> dict[Path, dict]:
    """Newest plugin job per workspace root, for the live phase/heartbeat.

    The companion records its own phase and progress timestamps; nothing on the
    board read them, so an implementation step was one opaque block that looked
    identical at minute 1 and minute 90.
    """
    jobs: dict[Path, dict] = {}
    try:
        from .codex_status import STATE_ROOT, load_jobs
    except Exception:
        return jobs
    for root in roots:
        try:
            found = load_jobs(root.resolve(), STATE_ROOT)
        except (Exception, SystemExit):
            continue
        if found:
            jobs[root.resolve()] = found[-1]  # sorted by createdAt
    return jobs


def task_launches(base: Path) -> dict[str, dict]:
    """Latest delegation per task, with liveness resolved against the OS and
    the companion's own live phase attached.

    `launch_status` is a flag on disk, and a companion killed uncatchably (a
    job-object teardown, TerminateProcess, SIGKILL) runs no handler -- so the
    ledger keeps saying "running" forever. A watcher polling that flag then
    waits on a process that no longer exists; that is how a crash five minutes
    in reads as a job still working hours later. `pid` and `pid_started` are
    already recorded, so liveness is a fact to check rather than a timeout to
    guess at.

    Deliberately NOT memoised: liveness and phase change with nothing touching
    this repo's disk, so a file stamp would pin the answer to the moment of the
    crash -- exactly the staleness this exists to break.
    """
    try:
        from .codex_status import inactivity_minutes
        from .delegate import (
            _pid_alive, _process_start_identity, delegations_path,
            load_delegations,
        )
    except (Exception, SystemExit):
        return {}

    roots = _worktree_roots(base)
    jobs = _codex_jobs_by_root(roots)
    latest: dict[str, tuple[Path, dict]] = {}
    for root in roots:
        try:
            if not delegations_path(root).exists():
                continue
            entries = load_delegations(root)
        except (Exception, SystemExit):
            # SystemExit is not an Exception: a malformed ledger calls fail(),
            # and resolving a control directory exits outright outside a git
            # repo. Neither may take down a read-only view.
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not entry.get("task"):
                continue
            task_id = str(entry["task"])
            previous = latest.get(task_id)
            # Rows are appended in order per ledger; across ledgers the newest
            # timestamp wins so a re-run in a worktree beats a stale main-tree
            # row for the same task.
            if previous is None or str(entry.get("at") or "") >= str(
                    previous[1].get("at") or ""):
                latest[task_id] = (root, entry)

    resolved = {}
    for task_id, (root, entry) in latest.items():
        status = str(entry.get("launch_status") or "")
        pid = entry.get("pid")
        if status in {"starting", "running"} and isinstance(pid, int):
            alive = False
            try:
                if _pid_alive(pid):
                    recorded = entry.get("pid_started")
                    identity = _process_start_identity(pid) if recorded else None
                    # A recycled pid on an unrelated process would otherwise
                    # read as alive and keep the crash hidden.
                    alive = (not recorded or identity is None
                             or str(identity) == str(recorded))
            except (Exception, SystemExit):
                alive = True  # cannot tell: never invent a crash
            status = "running" if alive else "dead"
        job = jobs.get(root.resolve(), {})
        idle = None
        try:
            idle = inactivity_minutes(job) if job else None
        except (Exception, SystemExit):
            idle = None
        resolved[task_id] = {
            "status": status,
            "pid": pid,
            "at": entry.get("at"),
            "log": entry.get("log") or job.get("logFile"),
            "mode": entry.get("mode"),
            "write": entry.get("write"),
            "worktree": str(root) if root.resolve() != base.resolve() else "",
            # The companion's own account of what it is doing right now.
            "phase": job.get("phase") or "",
            "summary": (str(job.get("summary") or job.get("title") or "")
                        .strip()[:160]),
            "job_status": job.get("status") or "",
            "idle_minutes": round(idle, 1) if isinstance(idle, (int, float)) else None,
        }
    return resolved


def task_progress(task: dict, launch: dict | None, reviews: dict) -> dict:
    """Where this task actually is, as an ordered pipeline.

    The board could say a task was `active` but not whether anything was still
    working on it, so "taking a while" and "died an hour ago" looked identical.
    Each step is done / now / blocked / todo, so the first step that is not
    done is the answer to "what is happening?".
    """
    proof = task.get("proof") or {}
    state = task.get("state") or task.get("status") or "skeleton"
    done = state == "done"
    required = proof.get("required_tests") or []
    covered = proof.get("covered_tests") or []
    grill = proof.get("grill") or {}
    lenses = {aspect: bool(review) for aspect, review in (reviews or {}).items()}
    clean = [aspect for aspect, review in (reviews or {}).items()
             if isinstance(review, dict)
             and not (review.get("blocking_findings") or [])]

    def step(key, label, state_, note=""):
        return {"key": key, "label": label, "state": state_, "note": note}

    plan_state = task.get("plan_state")
    if plan_state == "clean":
        plan_step = step("plan", "Task plan", "done", "grill-clean")
    elif plan_state == "stale":
        plan_step = step("plan", "Task plan", "now",
                         "passed a grill, then edited - re-grill")
    elif plan_state == "ungrilled":
        plan_step = step("plan", "Task plan", "now", "saved - not yet grilled")
    else:
        plan_step = step("plan", "Task plan", "todo", "not authored")

    if state in {"active", "done"}:
        start_step = step("start", "Started", "done",
                          str(task.get("started_at") or "")[:10])
    elif state in {"ready", "grilled"}:
        start_step = step("start", "Started", "now",
                          "run `forge task start` then `stage start`")
    else:
        start_step = step("start", "Started", "todo")

    # A finished task is finished: a stale launch row left behind by a crash
    # that was later recovered (a re-run, or a ledgered degraded window) must
    # not put a dead companion on a shipped task.
    if done:
        build = step("build", "Implementation", "done")
    elif launch and launch.get("status") == "running":
        # Say what it is DOING, not just that it exists: an implementation step
        # with no live detail looks identical at minute 1 and minute 90.
        idle = launch.get("idle_minutes")
        beat = ("no progress for "
                f"{int(idle)}m" if isinstance(idle, (int, float)) and idle >= 1
                else "moving")
        detail = launch.get("phase") or launch.get("summary") or "working"
        build = step("build", "Implementation", "now",
                     f"Codex {detail} - {beat} (pid {launch.get('pid')})")
        # A companion that has gone quiet is not yet a crash, and must not be
        # reported as one; it is still the thing worth looking at.
        if isinstance(idle, (int, float)) and idle >= STALL_MINUTES:
            build["state"] = "blocked"
            build["note"] = (
                f"Codex alive (pid {launch.get('pid')}) but SILENT for "
                f"{int(idle)}m in phase {detail!r}. Check its log before "
                "assuming it is still working.")
    elif launch and launch.get("status") == "dead":
        build = step("build", "Implementation", "blocked",
                     f"Codex DEAD - pid {launch.get('pid')} is gone while the "
                     "ledger still says running. It crashed; nothing is coming.")
    elif launch and launch.get("status") == "failed":
        build = step("build", "Implementation", "blocked", "last launch failed")
    elif launch and launch.get("status") == "succeeded":
        build = step("build", "Implementation", "done", "companion finished")
    else:
        build = step("build", "Implementation",
                     "now" if state == "active" else "todo",
                     "no delegation recorded yet" if state == "active" else "")

    verify = step("verify", "Verify", "done" if proof.get("verify_ok") else
                  ("now" if state == "active" else "todo"),
                  str(proof.get("verify_at") or "")[:10])
    tests = step("tests", "Tests",
                 "done" if required and len(covered) == len(required) else
                 ("now" if covered else "todo"),
                 f"{len(covered)}/{len(required)} proven" if required
                 else "none required")
    review = step("review", "Review - 3 lenses",
                  "done" if len(clean) == 3 else
                  ("now" if lenses and any(lenses.values()) else "todo"),
                  " / ".join(
                      f"{aspect} "
                      f"{'clean' if aspect in clean else 'open' if lenses.get(aspect) else '-'}"
                      for aspect in ("quality", "performance", "security")))
    ship = step("ship", "PR ready", "done" if done else "todo",
                str(task.get("completed_at") or "")[:10])

    steps = [plan_step, start_step, build, verify, tests, review, ship]
    if grill.get("verdict") and grill.get("verdict") != "pass":
        plan_step["state"] = "blocked"
        plan_step["note"] = f"grill verdict {grill.get('verdict')}"
    blocked = next((s for s in steps if s["state"] == "blocked"), None)
    current = blocked or next((s for s in steps if s["state"] == "now"), None)
    live = None
    if launch and launch.get("status") in {"running", "dead"}:
        budget = task.get("budget") or {}
        used = budget.get("used") or {}
        limit = budget.get("limit") or {}
        live = {
            "status": launch.get("status"),
            "pid": launch.get("pid"),
            "phase": launch.get("phase") or "",
            "summary": launch.get("summary") or "",
            "idle_minutes": launch.get("idle_minutes"),
            "since": launch.get("at") or "",
            "log": launch.get("log") or "",
            "worktree": launch.get("worktree") or "",
            "write": launch.get("write"),
            # Files and lines already written are the one progress signal that
            # comes from the work itself rather than from the companion's own
            # self-report.
            "files": used.get("files"), "files_limit": limit.get("files"),
            "lines": used.get("lines"), "lines_limit": limit.get("lines"),
        }
    return {
        "steps": steps,
        "done": sum(1 for s in steps if s["state"] == "done"),
        "total": len(steps),
        "current": current["label"] if current else ("Shipped" if done else ""),
        "headline": (current or {}).get("note", ""),
        "stalled": bool(blocked),
        "launch": launch or None,
        "live": live,
    }


def task_dossiers(base: Path, key: str, detail: dict) -> list[dict]:
    """Everything known about each task, assembled once for the drawer: what it
    was for (decomposition), what the plan said about it, which spec governs it,
    and the proof it produced."""
    evidence = detail.get("evidence") or {}
    decomposition = evidence.get("decomposition") or {}
    stages = (evidence.get("stages") or {}).get("stages", [])
    tests = evidence.get("tests") or {}
    verify = evidence.get("verify") or {}
    reviews = evidence.get("reviews") or {}
    task_grills = evidence.get("task_grills") or {}
    spec_path = (detail.get("spec") or {}).get("path", "")
    launches = task_launches(base)

    recorded_tests = []
    for entry in tests.values():
        if isinstance(entry, dict):
            recorded_tests.extend(entry.get("tests_added_or_updated") or [])

    dossiers = []
    for task in merge_task_detail(decomposition, stages, detail.get("task_rows")):
        required = task.get("required_tests") or []
        # A required test counts as proven only if a recorded artifact names it;
        # "tests.json exists" is not evidence that THIS task was covered. Entries
        # are {id, path, command} objects (a legacy plan may still use a bare
        # string), so match on the test id — never the whole dict.
        covered = [t for t in required
                   if isinstance((tid := t.get("id") if isinstance(t, dict) else t), str)
                   and any(tid in str(recorded) for recorded in recorded_tests)]
        findings = []
        for aspect, review in reviews.items():
            if not isinstance(review, dict):
                continue
            for finding in (review.get("blocking_findings") or []) + \
                           (review.get("non_blocking_findings") or []):
                text = finding if isinstance(finding, str) else finding.get("summary", "")
                area = "" if isinstance(finding, str) else finding.get("area", "")
                # Bounded match: a substring test hands TS-3.10's findings to
                # TS-3.1, which is silent misattribution of review evidence.
                if re.search(rf"(?<![\w.]){re.escape(task['id'])}(?![\w]|\.\d)",
                             f"{text} {area}"):
                    findings.append({"aspect": aspect, "summary": text})
        task["proof"] = {
            "required_tests": required,
            "covered_tests": covered,
            "verify_ok": verify.get("ok") is True,
            "verify_at": verify.get("completed_at"),
            "grill": task_grills.get(task["id"]),
            "findings": findings,
            "spec": spec_path,
        }
        excerpt = plan_section(detail.get("plan_body", ""), task["id"])
        # A plan that restates the objective verbatim has nothing to add; showing
        # both reads as a rendering bug rather than as two sources agreeing.
        objective = (task.get("objective") or "").strip()
        task["plan_excerpt"] = "" if excerpt.strip() == objective else excerpt
        task.update(task_plan_view(base, key, task, task_grills.get(task["id"])))
        task["progress"] = task_progress(
            task, launches.get(task["id"]), reviews)
        dossiers.append(task)
    return dossiers


def make_server(base: Path, port: int) -> ThreadingHTTPServer:
    root = base.resolve()
    # This process is the read-only board: it re-renders every few seconds, and
    # a live `git fetch` per render is what made opening a story slow. Let the
    # marker check reuse a recent fetch here — and ONLY here; every CLI process
    # leaves the TTL at zero so the frontier and ship gates stay live.
    import factory_lib

    factory_lib.MARKER_FETCH_TTL = 15.0

    class BoardHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            route = urlsplit(self.path).path
            if route == "/api/state":
                body = json.dumps(aggregate_state(root)).encode()
                content_type = "application/json; charset=utf-8"
                status = 200
            elif route.startswith("/api/story/"):
                detail = story_detail(root, unquote(route[len("/api/story/"):]))
                body = json.dumps(detail or {"error": "unknown story"}).encode()
                content_type = "application/json; charset=utf-8"
                status = 200 if detail else 404
            elif route == "/":
                body = (root / "factory" / "board" / "index.html").read_bytes()
                content_type = "text/html; charset=utf-8"
                status = 200
            else:
                body = b"Not found\n"
                content_type = "text/plain; charset=utf-8"
                status = 404
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    # ponytail: stdlib server + polling, no websockets/framework — upgrade
    # only if multiple simultaneous viewers ever matter.
    return ThreadingHTTPServer(("127.0.0.1", port), BoardHandler)


def already_serving(port: int) -> bool:
    """True when a board for this repo is already up on the port.

    The skill is told to reuse rather than duplicate; without this a second
    `forge board` dies on 'address in use' and looks broken.
    """
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1) as r:
            return json.loads(r.read()).get("root") is not None
    except (urllib.error.URLError, OSError, ValueError):
        return False


def cmd_board(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    if already_serving(args.port):
        url = f"http://127.0.0.1:{args.port}/"
        print(f"Lifecycle board already running: {url}")
        webbrowser.open(url)
        return
    server = make_server(base, args.port)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Lifecycle board: {url} (Ctrl+C to stop)")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBoard stopped.")
    finally:
        server.server_close()
