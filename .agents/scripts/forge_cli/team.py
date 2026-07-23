"""forge team — the optional project roster (plans/team.json).

Defining the team upfront makes EM distribution checkable and suggestible:
`roadmap assign` validates handles against it, and story `skill`
(frontend|backend|fullstack) can be matched to member skills. It is OPTIONAL
— a one-dev project pays no ceremony (assign works unchecked without it).
Edited by command or PR.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root

from .common import fail

ROLES = {"dev", "em", "pm"}
SKILLS = {"frontend", "backend", "fullstack"}


def team_path(base: Path) -> Path:
    return base / "plans" / "team.json"


def load_members(base: Path) -> list[dict]:
    return load_json(team_path(base), default={}).get("members", [])


def member_handles(base: Path) -> set[str]:
    return {m["handle"] for m in load_members(base) if m.get("handle")}


def cmd_set(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    role = args.role or "dev"
    if role not in ROLES:
        fail(f"role must be one of {', '.join(sorted(ROLES))}")
    skills = [s.strip() for s in (args.skills or "").split(",") if s.strip()]
    bad = [s for s in skills if s not in SKILLS]
    if bad:
        fail(f"unknown skill(s): {', '.join(bad)} — use {', '.join(sorted(SKILLS))}")
    if role == "dev" and not skills:
        fail("a dev needs --skills (frontend,backend or fullstack) — "
             "that is what makes distribution suggestible")
    members = load_members(base)
    entry = next((m for m in members if m.get("handle") == args.handle), None)
    if entry is None:
        entry = {"handle": args.handle}
        members.append(entry)
    entry["role"] = role
    if skills:
        entry["skills"] = skills
    if args.name:
        entry["name"] = args.name
    team_path(base).parent.mkdir(parents=True, exist_ok=True)
    dump_json(team_path(base), {"updated_at": now_iso(), "members": members})
    print(f"Team: {args.handle} ({role}" + (f": {', '.join(skills)}" if skills else "") + ")")


def cmd_list(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    members = load_members(base)
    if not members:
        print("No team roster (plans/team.json) — optional; add members with "
              "`./forge team set <handle> --role dev --skills frontend,backend`")
        return
    for m in members:
        skills = f" [{', '.join(m['skills'])}]" if m.get("skills") else ""
        name = f" — {m['name']}" if m.get("name") else ""
        print(f"{m.get('role', 'dev'):<3} @{m['handle']}{skills}{name}")
