"""The gate table — the ONE place a grill gate is defined.

A grill is a cold read: a fresh Codex context with no memory of the session
that authored the artifact. It does not go hunting for the document; the
launcher pastes the document's text into the brief, and the recorder hashes
that same text so "this grill was of THIS version" stays checkable rather than
assumed. Locating the artifact is therefore part of what a gate IS, not
plumbing bolted on beside it.

Before this table the six gates were spelled out in eight places — the runner's
label map and its two hand-written lookups, the recorder's round floors, its
`--gate` choices, its story-scoping tuple and its evidence filename branch,
`forge.py`'s own choices list, and the schema's prose. They drifted, silently,
in the direction you would expect: the runner could locate two of six gates, so
four gates could not be released through the ledgered launcher at all, and the
round floor covered four of six, so `signoff` and `epics` accepted a grill with
ZERO rounds behind them and passed.

A `Gate` therefore has no optional fields. A row cannot be declared without
saying where its artifact lives and how many rounds it needs, so "recordable
but not runnable" and "gated but unfloored" stop being states this harness can
represent. Adding a gate is adding a row; every consumer picks it up.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from factory_lib import (
    evidence_path, load_json, run_state_path,
)

# Said once, carried into every brief and every recorder message. The floor is
# the point below which a grill is not evidence at all — it was never the bar.
# A grill is done when a round comes back clean AND the round before it came
# back clean; a single clean round after a noisy one is a coincidence, not
# convergence.
FLOOR_IS_NOT_A_TARGET = (
    "The round count below is a FLOOR, not a target. Keep grilling until a "
    "round comes back clean AND stays clean on the next one — hitting the "
    "floor is not the same as passing."
)


def _fail(message: str) -> None:
    raise SystemExit(message)


def _read_text(path: Path, missing: str) -> str:
    if not path.is_file():
        _fail(missing)
    return path.read_text(encoding="utf-8")


def _explicit_file(base: Path, file_arg: str, gate: str, hint: str) -> Path:
    """Gates whose artifact is CHOSEN, not derived: which spec, which roadmap
    proposal, which plan draft. Guessing one would grill proposal A and let
    proposal B through the gate, so the choice is stated."""
    if not file_arg:
        _fail(f"`--gate {gate}` interrogates one specific artifact — pass "
              f"--file <{hint}>")
    candidate = Path(file_arg).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    if not candidate.is_file():
        _fail(f"--file {file_arg} not found")
    return candidate


def _active_story(base: Path) -> str:
    return load_json(run_state_path(base), default={}).get("issue_key", "")


def _locate_spec(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    path = _explicit_file(base, file_arg, "spec", "docs/specs/<slug>.md")
    try:
        path.resolve().relative_to((base / "docs" / "specs").resolve())
    except ValueError:
        _fail(f"--file {file_arg} is not a capability spec — specs live under "
              "docs/specs/")
    return f"spec {path.name}", path.read_text(encoding="utf-8")


def _locate_signoff(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    """The client->PM handover is not one file: it is the brief, the confirmed
    specs and the roadmap read TOGETHER, which is exactly the set
    `require_grill` holds frozen afterwards. Grilling one of them alone would
    miss the contradictions that only appear between them."""
    parts: list[str] = []
    brief = base / "docs" / "product" / "BRIEF.md"
    if brief.is_file():
        parts.append("## docs/product/BRIEF.md\n\n"
                     + brief.read_text(encoding="utf-8"))
    specs_dir = base / "docs" / "specs"
    for spec in sorted(specs_dir.glob("*.md")) if specs_dir.is_dir() else []:
        parts.append(f"## {spec.relative_to(base).as_posix()}\n\n"
                     + spec.read_text(encoding="utf-8"))
    roadmap = base / "plans" / "roadmap.json"
    if roadmap.is_file():
        parts.append("## plans/roadmap.json\n\n"
                     + roadmap.read_text(encoding="utf-8"))
    if not parts:
        _fail("nothing to grill for --gate signoff: no docs/product/BRIEF.md, "
              "no docs/specs/*.md and no plans/roadmap.json")
    return "the client sign-off handover", "\n\n".join(parts)


def _locate_epics(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    path = _explicit_file(base, file_arg, "epics", "roadmap-input.json")
    return f"the derived epics in {path.name}", path.read_text(encoding="utf-8")


def _locate_requirements(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    """The requirements round interrogates the confirmed spec BEHIND the active
    story — the same spec the recorder digests, so the grill and its record
    cannot describe different documents."""
    story = _active_story(base)
    if not story:
        _fail("no active story — run intake before the requirements grill")
    items = load_json(base / "plans" / "roadmap.json", default={}).get("items", [])
    item = next((entry for entry in items if entry.get("key") == story), None)
    reference = item.get("spec") if isinstance(item, dict) else None
    if not isinstance(reference, str) or not reference.strip():
        _fail(f"active story {story!r} has no confirmed spec to grill — link "
              f"one first: ./forge roadmap link-spec {story} --spec <path>")
    spec = base / reference
    text = _read_text(spec, f"the linked spec {reference!r} does not exist")
    return f"requirements for {story} ({reference})", text


def _locate_plan(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    """A plan is grilled BEFORE it is saved — plan save refuses without a
    passing grill — so the draft in hand is the normal case and the recorded
    plan is the fallback, not the other way round."""
    if file_arg:
        path = _explicit_file(base, file_arg, "plan", "plan draft")
        return f"plan draft {path.name}", path.read_text(encoding="utf-8")
    from factory_lib import protected_decomposition_state_path
    plan_file = load_json(protected_decomposition_state_path(base),
                          default={}).get("plan_file") \
        or load_json(run_state_path(base), default={}).get("plan_file")
    if not plan_file:
        _fail("no plan draft given and none recorded — pass --file <draft.md>")
    path = base / plan_file
    text = _read_text(path, f"the recorded plan {plan_file!r} does not exist")
    return f"plan {plan_file}", text


def _locate_task(base: Path, task_id: str, file_arg: str) -> tuple[str, str]:
    if not task_id:
        _fail("`--gate task` interrogates ONE task's plan: pass --task <id>")
    path = evidence_path(base, _active_story(base), f"task-plans/{task_id}.md")
    text = _read_text(
        path, f"no saved task plan for {task_id} — save it with "
              f"`./forge task plan save {task_id} --from <path>` first")
    return f"task plan {task_id}", text


@dataclass(frozen=True)
class Gate:
    """One gate. Every field is required: a row that cannot say where its
    artifact lives, or how many rounds it needs, is not a gate."""

    name: str
    describes: str
    min_rounds: int
    story_scoped: bool
    locate: Callable[[Path, str, str], tuple[str, str]]

    def evidence_name(self, task_id: str = "") -> str:
        return f"grills/tasks/{task_id}.json" if self.name == "task" \
            else f"grills/{self.name}.json"


GATES: dict[str, Gate] = {gate.name: gate for gate in (
    Gate("spec", "the capability spec under interrogation",
         1, False, _locate_spec),
    Gate("signoff", "the client sign-off handover under interrogation",
         1, False, _locate_signoff),
    Gate("epics", "the derived epics under interrogation",
         1, False, _locate_epics),
    Gate("requirements", "the requirements round under interrogation",
         1, True, _locate_requirements),
    Gate("plan", "the plan under interrogation",
         1, True, _locate_plan),
    Gate("task", "the per-task implementation plan under interrogation",
         1, True, _locate_task),
)}

# A blank column is a bug that ships quietly, so it is caught at import rather
# than by whoever first runs the gate months later.
for _gate in GATES.values():
    assert _gate.min_rounds >= 1, f"{_gate.name}: a gate with no floor is ungated"
    assert callable(_gate.locate), f"{_gate.name}: no way to locate its artifact"
    assert _gate.describes.strip(), f"{_gate.name}: no description for the brief"


def gate_names() -> list[str]:
    """The valid `--gate` values — derived, never typed out a second time."""
    return list(GATES)


def get_gate(name: str) -> Gate:
    if name not in GATES:
        _fail(f"unknown gate {name!r} — expected one of {', '.join(GATES)}")
    return GATES[name]
