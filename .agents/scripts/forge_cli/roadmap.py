"""forge roadmap — the durable project backlog (plans/roadmap.json).

Task-scoped .factory state is cleared on every intake; this file is the
cross-task handoff artifact: the PM-owned epics and the EM-groomed, ordered
stories left to build. It is recorded once from the project-level
decomposition after sign-off (gated on an accepted `epics-approved` decision
— the PM handoff), then refined by PR. intake marks items active, pr_ready
marks them done, `forge roadmap assign` distributes them across the team,
and `forge next` suggests the next pending one.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from factory_lib import (
    dump_json, load_json, now_iso, repo_root, require_grill, validate_payload,
)

from .common import fail

# Set by the lifecycle scripts or grooming, never by import — re-importing a
# refined roadmap must not resurrect items, un-finish them, or unassign devs.
LIFECYCLE_FIELDS = {"status", "completed_at", "history", "assignee"}
ITEM_SKILLS = {"frontend", "backend", "fullstack"}
ITEM_KINDS = {"feature", "refactor"}


def roadmap_path(base: Path) -> Path:
    return base / "plans" / "roadmap.json"


def load_roadmap(base: Path) -> dict:
    return load_json(roadmap_path(base), default={})


def load_items(base: Path) -> list[dict]:
    return load_roadmap(base).get("items", [])


def save_roadmap(base: Path, items: list[dict], epics: list[dict] | None = None,
                 generated_by: str | None = None) -> None:
    data = load_roadmap(base)
    items.sort(key=lambda item: item.get("order", 0))
    data["items"] = items
    if epics is not None:
        data["epics"] = epics
    if generated_by:
        data["generated_by"] = generated_by
    # The persisted file satisfies its own schema: attribution survives.
    data.setdefault("generated_by", "human")
    data["updated_at"] = now_iso()
    roadmap_path(base).parent.mkdir(parents=True, exist_ok=True)
    dump_json(roadmap_path(base), data)


def mark_status(base: Path, key: str, status: str, **extra: str) -> bool:
    """Flip an item's lifecycle status; False if the key is not on the roadmap."""
    items = load_items(base)
    for item in items:
        if item.get("key") == key:
            item["status"] = status
            item.update(extra)
            save_roadmap(base, items)
            return True
    return False


FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def epics_approved(base: Path) -> bool:
    """The PM->EM handoff gate: an accepted epics-approved decision record —
    judged on PARSED frontmatter, never on prose that mentions the words."""
    for record in (base / "docs" / "decisions").glob("*epics-approved*.md"):
        match = FRONTMATTER.match(record.read_text())
        if not match:
            continue
        fields = {
            k.strip(): v.strip().strip('"').strip("'")
            for k, _, v in (line.partition(":") for line in match.group(1).splitlines())
            if k.strip()
        }
        if fields.get("status") == "accepted" and fields.get("confirmed_by"):
            return True
    return False


def activation_state(base: Path, key: str) -> tuple[str, list[str]]:
    """What intake may do with a roadmap key: ('activate'|'blocked'|'done'|
    'absent', waiting_on). depends_on is ENFORCED here, not just displayed."""
    items = load_items(base)
    status = {i.get("key"): i.get("status", "pending") for i in items}
    for item in items:
        if item.get("key") != key:
            continue
        if item.get("status") == "done":
            return "done", []
        waiting = [d for d in item.get("depends_on", []) if status.get(d) != "done"]
        return ("blocked", waiting) if waiting else ("activate", [])
    return "absent", []


def check_item(item: dict, pos: int) -> None:
    if not isinstance(item, dict):
        fail(f"roadmap item {pos} must be an object")
    for field in ("key", "title"):
        value = item.get(field)
        if not isinstance(value, str) or not value.strip():
            fail(f"roadmap item {pos}: '{field}' must be a non-empty string")
    for field in ("epic", "story"):
        if field in item and not isinstance(item[field], str):
            fail(f"roadmap item {item['key']}: '{field}' must be a string")
    criteria = item.get("acceptance_criteria")
    if criteria is not None and not isinstance(criteria, list):
        fail(f"roadmap item {item['key']}: acceptance_criteria must be a list")
    skill = item.get("skill")
    if skill is not None and (not isinstance(skill, str) or skill not in ITEM_SKILLS):
        fail(f"roadmap item {item['key']}: skill must be one of "
             f"{', '.join(sorted(ITEM_SKILLS))}")
    kind = item.get("kind")
    if kind is not None and kind not in ITEM_KINDS:
        fail(f"roadmap item {item['key']}: kind must be one of "
             f"{', '.join(sorted(ITEM_KINDS))} — refactor-tagged stories are held to "
             "the non-positive source-delta ratchet at pr_ready")
    deps = item.get("depends_on")
    if deps is not None:
        if not isinstance(deps, list) or not all(
            isinstance(d, str) and d.strip() for d in deps
        ):
            fail(f"roadmap item {item['key']}: depends_on must be a list of story keys")


def check_dag(items: list[dict]) -> None:
    """The merged dependency graph must stay acyclic — a cycle deadlocks the
    ready frontier forever (Kahn's algorithm; leftovers = cycle members)."""
    deps = {i["key"]: set(i.get("depends_on", [])) for i in items}
    remaining = dict(deps)
    while remaining:
        free = [k for k, d in remaining.items() if not (d & remaining.keys())]
        if not free:
            fail(f"dependency cycle in roadmap: {', '.join(sorted(remaining))} — "
                 "no story in this set can ever become ready")
        for k in free:
            remaining.pop(k)


def ready_pending(items: list[dict]) -> tuple[list[dict], list[tuple[dict, list[str]]]]:
    """The parallelizable frontier: pending items whose depends_on are all
    done. Anything else pending is blocked, with the keys it waits on."""
    status = {i.get("key"): i.get("status", "pending") for i in items}
    ready: list[dict] = []
    blocked: list[tuple[dict, list[str]]] = []
    for item in items:
        if item.get("status", "pending") != "pending":
            continue
        waiting = [d for d in item.get("depends_on", []) if status.get(d) != "done"]
        if waiting:
            blocked.append((item, waiting))
        else:
            ready.append(item)
    return ready, blocked


def require_signoff(base: Path, action: str) -> None:
    from factory_lib import load_json as _lj, run_state_path as _rsp
    if not _lj(_rsp(base), default={}).get("client_signoff"):
        fail(f"{action} is a post-sign-off activity — record client sign-off first "
             "(record_signoff.py).")


def cmd_import(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    require_signoff(base, "the roadmap handoff")
    source = Path(args.input).expanduser()
    if not source.is_file():
        fail(f"roadmap input {source} not found")
    # Grill BEFORE the PM accepts — and the grill must be bound to THIS
    # exact input (digest match), so grilling proposal A never imports B.
    require_grill(
        base, "epics",
        ("docs/product/", "docs/decisions/"),
        ignore_names=("epics-approved", "client-signoff"),
        expect_digest_of=source,
    )
    if not epics_approved(base):
        fail(
            "the roadmap import is the PM->EM handoff and requires PM approval of "
            "the epics first: `./forge decision new epics-approved` (list the epics "
            "in the record), then on the PM's explicit confirmation (in chat or "
            "typed themselves) run "
            '`./forge decision accept epics-approved --by "<PM name>"`.'
        )
    try:
        payload = json.loads(source.read_text())
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {source}: {exc}")
    if not isinstance(payload, dict):
        fail('roadmap input must be {"generated_by": "...", "epics": [...], "items": [...]}')
    validate_payload(base, "roadmap", payload)
    incoming = payload["items"]
    if not incoming:
        fail("roadmap input has no items")
    seen: set[str] = set()
    for pos, item in enumerate(incoming, 1):
        check_item(item, pos)
        if item["key"] in seen:
            fail(f"duplicate roadmap key: {item['key']}")
        seen.add(item["key"])
    # Dependency edges must resolve to real stories (incoming or existing) —
    # a dangling edge would silently serialize or silently unblock.
    known = seen | {i["key"] for i in load_items(base)}
    for item in incoming:
        for dep in item.get("depends_on", []):
            if dep == item["key"]:
                fail(f"roadmap item {item['key']} depends on itself")
            if dep not in known:
                fail(f"roadmap item {item['key']}: depends_on '{dep}' is not on the roadmap")
    incoming_epics = payload.get("epics", [])
    for pos, epic in enumerate(incoming_epics, 1):
        if not isinstance(epic, dict):
            fail(f"epic {pos} must be an object")
        for field in ("id", "title"):
            if not isinstance(epic.get(field), str) or not epic[field].strip():
                fail(f"epic {pos}: '{field}' must be a non-empty string")
    if len({e["id"] for e in incoming_epics}) != len(incoming_epics):
        fail("duplicate epic id in input")
    existing = {item["key"]: item for item in load_items(base)}
    merged: list[dict] = []
    added = updated = 0
    for pos, item in enumerate(incoming, 1):
        entry = existing.pop(item["key"], None)
        if entry is None:
            entry = {"status": "pending"}
            added += 1
        else:
            updated += 1
        entry.update({k: v for k, v in item.items() if k not in LIFECYCLE_FIELDS})
        # List position IS execution order (the input contract) — a caller-
        # supplied order field must not silently reshuffle the backlog.
        entry["order"] = pos
        merged.append(entry)
    # Items on the roadmap but absent from the input are kept — removing
    # scope is a deliberate PR edit, never a silent import side effect.
    kept = list(existing.values())
    for offset, item in enumerate(kept, 1):
        item["order"] = len(merged) + offset  # kept scope trails the new sequence
    merged.extend(kept)
    check_dag(merged)
    # Epics merge by id, same keep-what-input-omits rule.
    current_epics = {e["id"]: e for e in load_roadmap(base).get("epics", [])}
    for epic in incoming_epics:
        current_epics[epic["id"]] = {**current_epics.get(epic["id"], {}), **epic}
    save_roadmap(base, merged, epics=list(current_epics.values()),
                 generated_by=payload["generated_by"])
    summary = f"Roadmap: {added} added, {updated} updated"
    if kept:
        summary += f", {len(kept)} existing item(s) kept"
    if incoming_epics:
        summary += f", {len(incoming_epics)} epic(s) recorded"
    print(f"{summary} -> {roadmap_path(base).relative_to(base)}")


def cmd_add(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    require_signoff(base, "roadmap grooming")
    items = load_items(base)
    if any(item.get("key") == args.key for item in items):
        fail(f"{args.key} is already on the roadmap")
    order = max((item.get("order", 0) for item in items), default=0) + 1
    item = {"key": args.key, "title": args.title, "order": order, "status": "pending"}
    check_item(item, order)
    if args.epic:
        item["epic"] = args.epic
    if args.skill:
        if args.skill not in ITEM_SKILLS:
            fail(f"skill must be one of {', '.join(sorted(ITEM_SKILLS))}")
        item["skill"] = args.skill
    if getattr(args, "kind", None):
        item["kind"] = args.kind
        check_item(item, order)
    items.append(item)
    save_roadmap(base, items)
    print(f"Added {args.key} to the roadmap (order {order})")


def cmd_assign(args: argparse.Namespace) -> None:
    """EM distribution: put a dev's handle on a story, checked against the roster."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    from .team import load_members  # local import: team is optional machinery
    members = {m.get("handle"): m for m in load_members(base)}
    if members:
        member = members.get(args.to)
        if member is None:
            fail(
                f"'{args.to}' is not on the team roster ({', '.join(sorted(members))}) — "
                f"add them first: ./forge team set {args.to} --skills <frontend,backend|fullstack>"
            )
        if member.get("role", "dev") != "dev":
            fail(f"'{args.to}' is on the roster as {member.get('role')} — stories are "
                 "assigned to devs.")
        item = next((i for i in load_items(base) if i.get("key") == args.key), None)
        need = item.get("skill") if item else None
        has = set(member.get("skills") or [])
        if need and has and need not in has and "fullstack" not in has:
            print(f"WARNING: {args.key} needs [{need}] but @{args.to} has "
                  f"[{', '.join(sorted(has))}] — assigning anyway (EM's call).")
    if not mark_status_free_update(base, args.key, assignee=args.to):
        fail(f"{args.key} is not on the roadmap")
    print(f"{args.key} assigned to {args.to}")


def mark_status_free_update(base: Path, key: str, **fields: str) -> bool:
    items = load_items(base)
    for item in items:
        if item.get("key") == key:
            item.update(fields)
            save_roadmap(base, items)
            return True
    return False


STATUS_RANK = {"done": 3, "active": 2, "pending": 1}


def heal_items(items: list[dict]) -> tuple[list[dict], int]:
    """Union duplicates by key: the further-along status wins (done > active
    > pending), non-empty fields survive from both copies."""
    best: dict[str, dict] = {}
    order: list[str] = []
    for item in items:
        key = item.get("key")
        if key not in best:
            best[key] = dict(item)
            order.append(key)
            continue
        a, b = best[key], item
        winner, loser = (a, b) if STATUS_RANK.get(a.get("status", "pending"), 1) \
            >= STATUS_RANK.get(b.get("status", "pending"), 1) else (b, a)
        merged = dict(loser)
        merged.update({k: v for k, v in winner.items() if v not in ("", [], None)})
        merged["status"] = winner.get("status", "pending")
        best[key] = merged
    return [best[k] for k in order], len(items) - len(best)


def cmd_heal(args: argparse.Namespace) -> None:
    """Post-merge convergence: parallel story branches both touch
    plans/roadmap.json; heal rebuilds the union deterministically instead of
    a human hand-editing JSON. Works on a parseable file with duplicate keys,
    and mid-merge on an unparseable (conflict-markered) file by unioning the
    two merge stages."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    path = roadmap_path(base)
    if not path.exists():
        fail("no plans/roadmap.json to heal")
    try:
        data = json.loads(path.read_text())
        items = data.get("items", [])
        epics = data.get("epics", [])
    except json.JSONDecodeError:
        stages = []
        for stage in ("2", "3"):
            proc = subprocess.run(
                ["git", "show", f":{stage}:plans/roadmap.json"],
                cwd=base, capture_output=True, text=True,
            )
            if proc.returncode == 0:
                stages.append(json.loads(proc.stdout))
        if len(stages) != 2:
            fail(
                "plans/roadmap.json is unparseable and no merge is in progress — "
                "restore a good copy first (git show <branch>:plans/roadmap.json)."
            )
        items = stages[0].get("items", []) + stages[1].get("items", [])
        epics_by_id = {e["id"]: e for s in stages for e in s.get("epics", [])}
        epics = list(epics_by_id.values())
    healed, removed = heal_items(items)
    save_roadmap(base, healed, epics=epics)
    done = sum(1 for i in healed if i.get("status") == "done")
    print(f"Healed plans/roadmap.json: {len(healed)} item(s), "
          f"{removed} duplicate(s) unioned (status: further-along wins); {done} done.")
    print("Stage it if you are mid-merge: git add plans/roadmap.json")


def cmd_parallel(args: argparse.Namespace) -> None:
    """The orchestrator's fan-out view: which stories can run CONCURRENTLY
    right now (pending, dependencies done), each in its own worktree —
    one task per branch with its own committed .factory state (decision
    0002), implementations driven via /codex:rescue --background."""
    base = Path(args.repo).resolve() if args.repo else repo_root()
    from factory_lib import slugify
    items = load_items(base)
    if not items:
        print("No roadmap yet — nothing to parallelize (./forge roadmap import first).")
        return
    ready, blocked = ready_pending(items)
    if not ready:
        print("No pending stories are unblocked right now.")
    else:
        import shlex
        print(f"{len(ready)} stor{'y is' if len(ready) == 1 else 'ies are'} independent "
              "and can run IN PARALLEL — one worktree each:")
        for item in ready:
            who = f" @{item['assignee']}" if item.get("assignee") else ""
            skill = f" [{item['skill']}]" if item.get("skill") else ""
            branch = f"feat/{item['key']}-{slugify(item['title'])}"
            wt = shlex.quote(f"../{base.name}-{item['key']}")
            print(f"\n  {item['key']} — {item['title']}{skill}{who}")
            print(f"    git worktree add {wt} -b {shlex.quote(branch)}")
            print(f"    (cd {wt} && python3 .agents/scripts/intake.py "
                  f"--issue {shlex.quote(item['key'])} --title {shlex.quote(item['title'])})")
    for item, waiting in blocked:
        print(f"\n  BLOCKED {item['key']} — waiting on: {', '.join(waiting)}")
    print("\nEach worktree carries its own branch + .factory state; roadmap "
          "status flips converge when branches merge. Parallelize stories, "
          "never one story's dependent leaf tasks.")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    data = load_roadmap(base)
    items = data.get("items", [])
    if not items:
        print("No roadmap yet — record the project decomposition as the backlog: "
              "./forge roadmap import --input <json> (see .agents/prompts/decomposer.md)")
        return
    epic_titles = {e["id"]: e.get("title", e["id"]) for e in data.get("epics", [])}
    marks = {"pending": " ", "active": ">", "done": "x"}
    shown = 0
    by_epic: dict[str, list[dict]] = {}
    for item in items:
        by_epic.setdefault(item.get("epic", ""), []).append(item)
    for epic_id in by_epic:
        if epic_id:
            print(f"# {epic_titles.get(epic_id, epic_id)}")
        for item in by_epic[epic_id]:
            status = item.get("status", "pending")
            if args.pending and status != "pending":
                continue
            shown += 1
            extras = []
            if item.get("skill"):
                extras.append(item["skill"])
            if item.get("assignee"):
                extras.append(f"@{item['assignee']}")
            suffix = f" ({', '.join(extras)})" if extras else ""
            print(f"[{marks.get(status, '?')}] {item.get('order', 0):>3}. "
                  f"{item['key']} — {item['title']}{suffix}")
    done = sum(1 for item in items if item.get("status") == "done")
    if args.pending and not shown:
        print("Nothing pending — everything is in flight or done.")
    if not args.pending:
        print(f"({done}/{len(items)} done)")
