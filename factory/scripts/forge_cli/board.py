"""forge board — read-only localhost lifecycle dashboard."""
from __future__ import annotations

import argparse
import json
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from factory_lib import load_json, now_iso, parse_sections, repo_root, run_state_path
from record_signoff import REQUIRED_BRIEF_HEADINGS

from . import events
from .assumptions import open_count as open_assumptions
from .decisions import decision_records
from .plans import parse_frontmatter
from .quickfix import ledger_path, load_active
from .readiness import review_passed, tests_passed, verify_passed
from .roadmap import load_roadmap, ready_pending
from .signal import open_signals
from .specs import spec_records


def _plan_records(base: Path, location: str) -> list[dict]:
    records = []
    for path in sorted((base / "plans" / location).glob("*.md")):
        fields, _ = parse_frontmatter(path.read_text())
        records.append({
            **fields,
            "path": path.relative_to(base).as_posix(),
            "location": location,
        })
    return records


def _stage_summary(base: Path) -> dict:
    data = load_json(base / ".factory" / "stages.json", default={})
    items = data.get("stages", [])
    return {
        "issue": data.get("issue"),
        "done": sum(1 for stage in items if stage.get("status") == "done"),
        "total": len(items),
        "items": items,
    }


TASK_NARRATIVE = ("objective", "acceptance_criteria", "reviewer_focus",
                  "write_scope", "verify_commands", "required_tests", "dependencies")


def merge_task_detail(decomposition: dict, stages: list[dict]) -> list[dict]:
    """The stage tracker knows what is DONE; the decomposition knows what the
    task was FOR. Neither alone answers "what is this task?", and the tracker
    deliberately keeps only id/title/status so the two never disagree about
    progress — so they are joined here, at read time, by task id."""
    planned = {t.get("id"): t for t in decomposition.get("tasks", [])}
    tasks = []
    for stage in stages:
        task = {"id": stage.get("id"), "title": stage.get("title"),
                "status": stage.get("status", "pending"),
                "started_at": stage.get("started_at"),
                "completed_at": stage.get("completed_at")}
        source = planned.get(stage.get("id"), {})
        task.update({field: source[field] for field in TASK_NARRATIVE if field in source})
        tasks.append(task)
    return tasks


def _plan_evidence(base: Path, plan: dict | None) -> tuple[dict | None, dict, list]:
    """Stage progress, gate evidence, and the story's real task list.

    Tasks exist only once a story's plan is approved and decomposed, so an
    unplanned story returns none rather than inventing children.
    """
    empty_reviews = {aspect: False for aspect in ("quality", "performance", "security")}
    if not plan:
        return None, {"verify": False, "tests": False, "reviews": empty_reviews}, []
    if plan.get("location") == "completed":
        root = base / ".factory" / "history" / str(plan.get("issue", ""))
    else:
        root = base / ".factory"
    stages_data = load_json(root / "stages.json", default={})
    stages = stages_data.get("stages", [])
    progress = None
    if stages:
        progress = {
            "done": sum(1 for stage in stages if stage.get("status") == "done"),
            "total": len(stages),
        }
    tasks = merge_task_detail(load_json(root / "decomposition.json", default={}), stages)
    # The same predicates pr_ready gates on: a tick here must mean the gate
    # would open, not merely that a file is on disk.
    recorded = load_json(root / "tests.json", default={})
    evidence = {
        "verify": verify_passed(load_json(root / "verify.json", default={})),
        "tests": tests_passed(recorded.get("automated")) and (
            tests_passed(recorded.get("functional"), functional=True)
            if recorded.get("functional") else True),
        "reviews": {
            aspect: review_passed(load_json(root / "reviews" / f"{aspect}.json",
                                            default={}))
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
    sections = parse_sections(brief.read_text()) if brief.is_file() else {}
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
    plans = {
        "active": _plan_records(base, "active"),
        "completed": _plan_records(base, "completed"),
    }
    # `story` postdates the earliest plans; fall back to `issue`, or every
    # story on a legacy project renders unplanned.
    plan_by_story = {
        plan.get("story") or plan.get("issue"): plan
        for location in ("completed", "active")
        for plan in plans[location]
        if plan.get("story") or plan.get("issue")
    }
    specs = [
        {key: value for key, value in record.items() if key != "_path"}
        for record in spec_records(base)
    ]
    spec_status = {record["path"]: record.get("status", "draft") for record in specs}
    run = load_json(base / ".factory" / "run.json", default={})
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
        progress, evidence, tasks = _plan_evidence(base, plan)
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
            "planned": plan is not None,
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
        "signals": open_signals(base),
        "quickfix": load_active(base) or None,
        "quickfix_ledger": quickfix_ledger(base),
        "next": next_actions(base),
        "decisions": active_decisions(base),
    }


def next_actions(base: Path) -> dict:
    """The deterministic 'where am I / what now', as the CLI computes it.

    # ponytail: captures cmd_next's own output rather than duplicating 100
    # lines of gate branching — one source of truth. If the shape ever needs
    # more than phase + steps, extract a builder from cmd_next instead.
    """
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


def active_decisions(base: Path) -> list[dict]:
    records = decision_records(base)
    return [
        {"id": str(r.get("id") or r.get("slug") or ""),
         "title": str(r.get("title") or ""),
         "status": str(r.get("status") or ""),
         "path": Path(str(r["path"])).relative_to(base).as_posix() if r.get("path") else ""}
        for r in records if r.get("status") == "accepted"
    ]


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
        (record for location in ("active", "completed")
         for record in _plan_records(base, location)
         if record.get("story") == key or record.get("issue") == key),
        None,
    )
    plan_body = ""
    if plan:
        _, plan_body = parse_frontmatter((base / plan["path"]).read_text())
    # Live .factory/ belongs to whatever story is ACTIVE. Handing it to any
    # other story shows one story's proof under another's name.
    active = load_json(run_state_path(base), default={}).get("issue_key")
    if plan and plan.get("location") == "completed":
        root = base / ".factory" / "history" / str(plan.get("issue", ""))
    elif active == key:
        root = base / ".factory"
    else:
        root = base / ".factory" / "history" / key
    evidence = {
        name: load_json(root / f"{name}.json", default=None)
        for name in ("decomposition", "verify", "tests", "stages", "outcome")
    }
    evidence["reviews"] = {
        aspect: load_json(root / "reviews" / f"{aspect}.json", default=None)
        for aspect in ("quality", "performance", "security")
    }
    evidence["grills"] = {
        path.stem: load_json(path, default=None)
        for path in sorted((root / "grills").glob("*.json"))
    }
    evidence["task_grills"] = {
        path.stem: load_json(path, default=None)
        for path in sorted((root / "grills" / "tasks").glob("*.json"))
    }
    spec_path = item.get("spec")
    spec = None
    if spec_path and (base / spec_path).is_file():
        # `body` stays the EXACT committed source: the raw-json view exists to
        # show the artifact as it is, and stripping here would make the API
        # lossy for every consumer to fix one renderer. The drawer strips
        # frontmatter when it renders prose.
        spec = {"path": spec_path, "body": (base / spec_path).read_text()}
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
    detail["tasks"] = task_dossiers(detail)
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


def task_dossiers(detail: dict) -> list[dict]:
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

    recorded_tests = []
    for entry in tests.values():
        if isinstance(entry, dict):
            recorded_tests.extend(entry.get("tests_added_or_updated") or [])

    dossiers = []
    for task in merge_task_detail(decomposition, stages):
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
        dossiers.append(task)
    return dossiers


def make_server(base: Path, port: int) -> ThreadingHTTPServer:
    root = base.resolve()

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
