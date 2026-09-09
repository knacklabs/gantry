"""forge grill run — release the read-only cold reader through the ledger.

Grills were the one Codex release the harness could not see. A delegation
records a pid and a review now does too, so a launcher killed uncatchably is
still detectable afterwards; a grill went out through the plugin directly, so
nothing on the forge side knew it had ever started. That is backwards: the
grill is the release the coordinator is told to WATCH every single round.

Releasing it through `launch_companion` — the same launcher a delegation uses —
gives it the same treatment for free: the pid and process create-time are
ledgered before the wait, the process tree is reaped on exit, the argv is
pinned, and `forge codex status` reports it dead if its launcher was killed.

It stays READ-ONLY. `write=False` means no delegation lock is taken and the
row can never satisfy `stage done`, which matches on a write launch bound to a
task contract. The cold read returns findings; recording the gate remains the
coordinator's job through the ledger-matched recorder, exactly as before.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from factory_lib import load_json, repo_root, run_state_path
from grill_gates import FLOOR_IS_NOT_A_TARGET, get_gate

from .common import fail

def _artifact_text(base: Path, gate: str, task_id: str,
                   file_arg: str = "") -> tuple[str, str]:
    """Ask the gate table where this gate's artifact lives.

    This used to be a hand-written if-chain that knew two of the six gates;
    the other four failed with "no artifact resolver yet" and sent the
    coordinator around the ledgered launcher, which is where the pid that
    makes a dead grill detectable gets recorded. A missing lookup silently
    cost liveness detection in an unrelated subsystem.
    """
    return get_gate(gate).locate(base, task_id, file_arg)


def _grill_skill_section() -> str:
    """The grill technique, INLINED rather than named.

    Naming a skill only works if the reader's runtime resolves it. `grill-me`
    is a 164-byte STUB whose body is "Call the Skill tool with 'grilling'",
    carrying `disable-model-invocation: true` — so no model invokes it, and a
    reader told to would find a redirect it may not follow. `doctor` mirrors
    the real `grilling` into ~/.codex/skills as well, so the technique IS
    reachable there; inlining is the belt to that braces, for a machine where
    `doctor --fix` has not run.

    `_skill_text` already looks in BOTH runtimes' skill directories, which is
    what lets the Claude-side text travel to Codex inside the brief. Prefer the
    real skill, accept grill-me only when it is not merely the stub, and carry
    a written floor when neither is installed — the same reason delegate
    inlines ponytail instead of trusting a per-machine install.
    """
    from .delegate import _skill_text

    for name in ("grilling", "grill-me"):
        text = _skill_text(name)
        # The stub points at a tool the reader may not have; it is not technique.
        if text and "Call the Skill tool" not in text:
            return ("## Interrogation technique\n\n"
                    "Run the interrogation this way. The harness contract above "
                    "is the floor; this is the technique.\n\n" + text)
    return ("## Interrogation technique\n\n"
            "No grill skill is installed (`./forge doctor --fix` installs it). "
            "Interrogate to the harness contract above: one line of questioning "
            "at a time, press each answer until it is concrete and checkable, "
            "and surface every place the artifact leaves the reader to guess.")


def _lessons_section(base: Path, gate: str, task_id: str) -> str:
    """Lessons in force for the paths this task may touch.

    Task-gate only: it is the one gate whose artifact names a write scope, and
    a lesson list unrelated to the work would be noise the reader learns to
    skip.
    """
    if gate != "task" or not task_id:
        return ""
    try:
        from factory_lib import (
            load_json, protected_decomposition_state_path,
        )
        from .lessons import relevant_lessons
        tasks = load_json(protected_decomposition_state_path(base),
                          default={}).get("tasks", [])
        task = next((t for t in tasks if t.get("id") == task_id), None)
        scope = [str(entry) for entry in (task or {}).get("write_scope") or []]
        lessons = relevant_lessons(base, scope) if scope else []
    except Exception:
        return ""
    if not lessons:
        return ""
    lines = ["## Lessons already in force for these paths", "",
             "The plan must design AROUND these. A plan that ignores one is "
             "not merely unlucky later — it is wrong now, and saying so is "
             "part of this read.", ""]
    lines += [f"- {entry.get('lesson', '')}" for entry in lessons]
    return "\n".join(lines) + "\n"


# The brief travels to the launcher as a file; the reader's prompt budget is
# finite. Measured on a 44-round story the whole history was 14.5 KB, so this
# ceiling is a backstop, not a working limit.
SETTLED_BUDGET_CHARS = 60_000


def _settled_rounds(base: Path, gate: str) -> str:
    """Every question already answered for this story, and the answer.

    Read from the AskUserQuestion ledger the recorder validates against, not
    from a summary: a summary would be written by the party whose work is being
    audited, and it would break the provenance the recorder depends on.
    """
    try:
        from factory_lib import evidence_path, load_json, run_state_path
        story = load_json(run_state_path(base), default={}).get("issue_key", "")
        directories = [d for d in (
            evidence_path(base, story, "grill-rounds"),
            evidence_path(base, None, "grill-rounds"),
        ) if d.is_dir()]
    except Exception:
        return ""

    seen: set[tuple[str, str]] = set()
    answered: list[tuple[str, str, str]] = []
    for directory in dict.fromkeys(directories):
        for path in sorted(directory.glob("*.json")):
            try:
                record = load_json(path, default={})
            except Exception:
                # One unreadable record costs THAT record. Letting it escape
                # loses every settled answer, which is the failure this
                # section exists to prevent.
                continue
            if not isinstance(record, dict):
                continue
            when = str(record.get("at") or "")
            for entry in record.get("questions", []):
                if not isinstance(entry, dict):
                    continue
                question = str(entry.get("question") or "").strip()
                chosen = str(entry.get("chosen") or "").strip()
                if not question or not chosen:
                    continue  # an unanswered round settles nothing
                key = (question, chosen)
                if key in seen:
                    continue
                seen.add(key)
                answered.append((when, question, chosen))
    if not answered:
        return ""

    answered.sort(key=lambda row: row[0])
    lines = [f"- Q: {q}\n  A: {a}" for _, q, a in answered]

    # Oldest first when it must be cut, and SAID so. A brief that silently
    # drops content is how a chunked review lost its verdicts.
    omitted = 0
    while sum(len(line) for line in lines) > SETTLED_BUDGET_CHARS and len(lines) > 1:
        lines.pop(0)
        omitted += 1

    header = [
        "## Already answered on this story — verify, do not re-ask",
        "",
        "These questions were put to the human and answered. Two obligations:",
        "",
        "1. Do NOT raise them again as open questions. They are settled.",
        "2. DO check each answer still holds — that the artifact actually "
        "honours it, and that it does not contradict another answer, an "
        "accepted decision, or the constitution. An answer can be wrong, or "
        "right and never applied. Saying so is part of this read.",
        "",
    ]
    if omitted:
        header.append(
            f"[{omitted} earlier answered question(s) omitted for length — "
            "ask for them if a gap seems to depend on settled ground.]")
        header.append("")
    return "\n".join(header + lines) + "\n"


def _compose_brief(base: Path, gate: str, label: str, artifact: str,
                   task_id: str = "") -> str:
    contract = base / "factory" / "prompts" / "griller.md"
    contract_text = (contract.read_text(encoding="utf-8")
                     if contract.is_file() else "")
    skill_section = _grill_skill_section()
    return "\n".join([
        f"# Cold-read grill — gate: {gate} — {label}",
        "",
        "You did NOT write what follows. Read it cold, as an adversary trying "
        "to break the handover, never as its author defending it. You are "
        "READ-ONLY: return findings, change nothing.",
        "",
        skill_section,
        "",
        "## Harness grill contract",
        "",
        contract_text,
        "",
        _lessons_section(base, gate, task_id),
        _settled_rounds(base, gate),
        f"## The artifact under interrogation ({label})",
        "",
        artifact,
        "",
        "## What to return",
        "",
        "Findings only: contradictions, gaps, unstated assumptions, and "
        "anything a reader would have to guess. Say what would break and why. "
        "Do not record a gate — the coordinating session records it.",
        "",
        FLOOR_IS_NOT_A_TARGET,
        "",
    ])


# Two cold reads without a recordable pass means the grill is no longer
# converging on the artifact. Round one finds the seam errors, round two
# checks the fold; every round past that on the stories measured bought only
# residue an implementer hits anyway (one ran to eleven and asked for help,
# one to twenty-six, one to forty over six hours; a task grill's third round
# returned locks, a locale and a bounded key). Past two, the human is brought
# in or the residue is folded and the work starts.
ROUNDS_BEFORE_ESCALATING = 2


def _rounds_since_last_pass(base: Path, ledger_id: str, gate: str,
                            task_id: str) -> int:
    """Cold reads released for this gate since its last recorded pass.

    From the delegation ledger, which carries a row per launch with its pid —
    a count of runs that actually happened. Distinct launch ids, because one
    launch appends several rows as it starts, runs and finishes.
    """
    try:
        from factory_lib import (
            evidence_path, load_json, run_state_path,
        )
        from .delegate import load_delegations
        from grill_gates import get_gate

        story = load_json(run_state_path(base), default={}).get("issue_key", "")
        record = load_json(
            evidence_path(base, story if get_gate(gate).story_scoped else "",
                          get_gate(gate).evidence_name(task_id)), default={})
        since = str(record.get("recorded_at") or "")
        launches = {
            row.get("launch_id") for row in load_delegations(base)
            if row.get("task") == ledger_id
            and row.get("launch_id")
            and str(row.get("at") or "") > since
        }
        return len(launches)
    except (Exception, SystemExit):
        # SystemExit is NOT an Exception: load_delegations calls fail() on a
        # malformed ledger. Never let the counter refuse a grill it cannot
        # count — a missed cap costs a round, a false cap costs the story.
        return 0


def _refuse_past_the_cap(base: Path, ledger_id: str, gate: str,
                         task_id: str) -> None:
    rounds = _rounds_since_last_pass(base, ledger_id, gate, task_id)
    if rounds < ROUNDS_BEFORE_ESCALATING:
        return
    try:
        from forge_cli.signal import open_escalation
        if open_escalation(base):
            return  # the human has been brought in; carry on
    except (Exception, SystemExit):
        return

    fail(
        f"{rounds} cold reads on --gate {gate} without a recorded pass.\n\n"
        "  This is no longer a grilling problem. Past a handful of rounds the "
        "reader has stopped converging on the artifact and started circling "
        "something nobody has decided, and another round cannot settle that — "
        "stories that kept going reached eleven, twenty-six and forty rounds, "
        "the last costing six hours.\n\n"
        "  Take the open findings to the human, say what you recommend, and "
        "record what they decide:\n"
        "    ./forge signal escalate --missing-decision \"<what nobody has "
        "decided>\" --checked \"contract,plan,constitution,decisions,lessons\"\n"
        "  Grilling continues after that. Recording a pass resets the count."
    )


def _artifact_digest(artifact: str) -> str:
    """Digest the exact bytes the reader was shown.

    Gate-agnostic on purpose: every gate resolves its artifact to text through
    the gate table, so hashing that text works for all six without a per-gate
    digest rule to drift out of sync.
    """
    import hashlib
    return hashlib.sha256(artifact.encode("utf-8")).hexdigest()


def _launch_rows(base: Path, ledger_id: str, since: str) -> list[dict]:
    """Ledger rows for one grill key, newest last, after `since`."""
    from .delegate import load_delegations
    return sorted(
        (row for row in load_delegations(base)
         if row.get("task") == ledger_id and str(row.get("at") or "") > since),
        key=lambda row: str(row.get("at") or ""),
    )


def _last_pass_at(base: Path, gate: str, task_id: str) -> str:
    """When this gate last recorded a pass. Empty if never."""
    from factory_lib import evidence_path, load_json, run_state_path
    from grill_gates import get_gate
    story = load_json(run_state_path(base), default={}).get("issue_key", "")
    record = load_json(
        evidence_path(base, story if get_gate(gate).story_scoped else "",
                      get_gate(gate).evidence_name(task_id)), default={})
    return str(record.get("recorded_at") or "")


def _refuse_a_second_cold_read(base: Path, ledger_id: str, gate: str,
                               task_id: str, reread: str) -> None:
    """One unconstrained cold read per recorded pass.

    The second read is the one that diverges: it has no memory of what the
    first found, so it returns a different frontier and the grill never ends.
    Amending the artifact is exactly when a second read feels necessary and
    exactly when it is wrong: the amendment answers the findings, so a reader
    that never saw them will not check it, it will look for new ones.

    This is not a wall. The findings go to the human, the artifact is amended
    once, and the pass is recorded against the AMENDED version -- one read,
    then save. A reread stays available as a CHOICE with a reason, for when
    the answers changed the artifact's SHAPE rather than its details; the
    reason is ledgered, and the five-read cap still backstops it.
    """
    if reread:
        return
    try:
        since = _last_pass_at(base, gate, task_id)
        cold = [row for row in _launch_rows(base, ledger_id, since)
                if row.get("launch_status") != "failed"]
        if not cold:
            return
    except (Exception, SystemExit):
        # A ledger this cannot read must not refuse a first grill.
        return

    fail(
        f"--gate {gate} has already been cold-read since its last recorded "
        f"pass.\n\n"
        "  A second unconstrained read is how the grill stops converging: it "
        "does not know what the first read found, so it returns a DIFFERENT "
        "frontier, and the artifact you amended to close round one becomes "
        "round two's input. Stories that kept re-reading reached eleven, "
        "twenty-six and forty rounds.\n\n"
        "  One read is the whole grill. Put its findings to the human NOW, "
        "amend the artifact to what they decided, and record the pass against "
        "the amended version:\n"
        "    python3 factory/scripts/record_grill_from_json.py "
        f"--gate {gate}"
        f"{' --task ' + task_id if task_id else ''} --input <json>\n\n"
        "  If their answers changed the artifact's SHAPE rather than its "
        "details, say so and read again:\n"
        f"    ./forge grill run --gate {gate}"
        f"{' --task ' + task_id if task_id else ''} "
        "--reread \"<what changed shape>\""
    )


def cmd_grill_run(args: argparse.Namespace) -> None:
    from .delegate import launch_companion, mode_run_config

    base = Path(args.repo).resolve() if args.repo else repo_root()
    gate = args.gate
    task_id = (args.task or "").strip()
    # Keyed apart from real task ids so a grill row can never be mistaken for
    # a task's delegation, and so concurrent grills of different gates do not
    # collide in the ledger.
    ledger_id = f"grill-{gate}" + (f"-{task_id}" if task_id else "")
    # Before composing anything: a capped run should not pay for a brief, and
    # a missing artifact should not report itself ahead of the real problem.
    _refuse_past_the_cap(base, ledger_id, gate, task_id)
    # One unconstrained read per recorded pass. Amending the artifact is when
    # a second read feels necessary and exactly when it diverges.
    _refuse_a_second_cold_read(base, ledger_id, gate, task_id,
                               (getattr(args, "reread", "") or "").strip())

    label, artifact = _artifact_text(
        base, gate, task_id, (getattr(args, "file", "") or "").strip())
    text = _compose_brief(base, gate, label, artifact, task_id)
    path = base / ".factory" / f"grill-brief-{gate}" \
        f"{'-' + task_id if task_id else ''}.md"
    model, effort, _bound = mode_run_config(base, "grill")

    launch_companion(
        base,
        task_id=ledger_id,
        text=text,
        path=path,
        task_sha256_value=_artifact_digest(artifact),
        model=model,
        effort=effort,
        write=False,          # a cold read never writes, and never authorises
        story=load_json(run_state_path(base), default={}).get("issue_key", ""),
        print_only=bool(args.print_only),
    )
    if args.print_only:
        return
    print(
        "NEXT: put EVERY finding to the human in THIS grill "
        "(AskUserQuestion -- the ledger the recorder reads), amend the "
        "artifact to what they decided, then record the pass:\n"
        "  python3 factory/scripts/record_grill_from_json.py "
        f"--gate {gate}"
        f"{' --task ' + task_id if task_id else ''} --input <json>\n"
        "This is the whole grill. Do not cold-read again: a second read "
        "returns a different frontier, not a shorter one.")
