"""forge spec — capture and confirm capability specifications."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from factory_lib import (
    ATX_CLOSING_RUN, load_json, now_iso, outside_examples, parse_sections,
    repo_root, require_grill,
)

from .common import fail
from .events import append_event

FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)
SAFE_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
REQUIRED_SECTIONS = ("Why", "Behaviour", "Acceptance criteria")


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip().strip("\"'")
    return fields


# The H1 rule; the H2 rule lives in factory_lib.parse_sections and both strip
# the same ATX closing run, so `# Billing #` and `## Why ##` mean what they say.
ATX_TITLE = re.compile(r"^#[ \t]+(?P<title>.*)$", re.MULTILINE)


def document_structure(text: str) -> str:
    """The spec body — frontmatter removed.

    Frontmatter goes first so a `status:` line can never read as content;
    fenced blocks and HTML comments are excluded at the point of asking, by
    factory_lib.example_ranges, so a section written only inside an example
    still counts as its own body but never as a heading.
    """
    return FRONTMATTER.sub("", text, count=1)


def missing_required_content(text: str) -> list[str]:
    body = document_structure(text)
    missing = []
    if not any(
        ATX_CLOSING_RUN.sub("", match.group("title")).strip()
        for match in outside_examples(body, ATX_TITLE.finditer(body))
    ):
        missing.append("H1 title")
    sections = parse_sections(body)
    for title in REQUIRED_SECTIONS:
        if not sections.get(title, "").strip():
            missing.append(f"## {title}")
    return missing


def spec_records(base: Path) -> list[dict]:
    records = []
    for path in sorted((base / "docs" / "specs").glob("*.md")):
        fields = parse_frontmatter(path.read_text(encoding="utf-8"))
        if not fields.get("slug"):
            continue
        records.append({
            **fields,
            "path": path.relative_to(base).as_posix(),
            "_path": path,
        })
    return records


def unreferenced_confirmed_specs(base: Path) -> list[str]:
    """Confirmed spec paths that no roadmap item references."""
    confirmed = {
        record["path"]
        for record in spec_records(base)
        if record.get("status") == "confirmed"
    }
    roadmap = load_json(base / "plans" / "roadmap.json", default={})
    items = roadmap.get("items", []) if isinstance(roadmap, dict) else []
    referenced = {
        Path(item["spec"]).as_posix()
        for item in items
        if isinstance(item, dict) and isinstance(item.get("spec"), str)
    }
    return sorted(confirmed - referenced)


def resolve_spec_reference(base: Path, value: str, *, confirmed: bool = False) -> Path:
    reference = Path(value)
    if reference.is_absolute():
        fail(f"spec reference must be repo-relative, got {value!r}")
    path = (base / reference).resolve()
    specs_dir = (base / "docs" / "specs").resolve()
    try:
        path.relative_to(specs_dir)
    except ValueError:
        fail(f"spec reference must stay under docs/specs/, got {value!r}")
    if path.suffix.lower() != ".md" or not path.is_file():
        fail(f"spec reference does not exist: {value}")
    fields = parse_frontmatter(path.read_text(encoding="utf-8"))
    if not fields.get("slug"):
        fail(f"spec reference has no Forge frontmatter: {value}")
    if confirmed and fields.get("status") != "confirmed":
        fail(f"spec reference is not confirmed: {value}")
    return path


def cmd_save(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    slug = args.slug.strip().lower()
    if not SAFE_SLUG.fullmatch(slug) or slug != args.slug.strip():
        fail("spec slug must be lowercase words separated by hyphens")
    source = Path(args.source).expanduser()
    if not source.is_file():
        fail(f"spec source {source} not found")
    body = source.read_text(encoding="utf-8")
    heading = re.search(r"^#\s+(.+?)\s*$", body, re.MULTILINE)
    title = args.title or (heading.group(1) if heading else slug.replace("-", " ").title())
    header = (
        f"---\nslug: {slug}\ntitle: {title}\nstatus: draft\n"
        f"saved: {now_iso()}\n---\n\n"
    )
    destination = base / "docs" / "specs" / f"{slug}.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(header + body, encoding="utf-8")
    append_event(base, "spec-draft", actor="orchestrator", detail=f"{slug}: {title}")
    print(f"Spec saved as draft: {destination.relative_to(base)}")


def cmd_confirm(args: argparse.Namespace) -> None:
    base = Path(args.repo).resolve() if args.repo else repo_root()
    slug = args.slug.strip().lower()
    path = base / "docs" / "specs" / f"{slug}.md"
    if not path.is_file():
        fail(f"no spec at docs/specs/{slug}.md")
    text = path.read_text(encoding="utf-8")
    fields = parse_frontmatter(text)
    if fields.get("status") == "confirmed":
        print(f"Spec already confirmed: {path.relative_to(base)}")
        return
    if fields.get("status") != "draft":
        fail(f"spec status must be draft before confirmation, got "
             f"{fields.get('status', 'missing')!r}")
    missing = missing_required_content(text)
    if missing:
        fail(f"spec is incomplete; missing or empty: {', '.join(missing)}")
    require_grill(
        base,
        "spec",
        ("docs/product/", "docs/decisions/", "docs/architecture/", "prototype/"),
        expect_digest_of=path,
    )
    updated = re.sub(
        r"(^---\r?\n.*?^status:[ \t]*)[\"']?draft[\"']?([ \t]*\r?$)",
        r"\1confirmed\2",
        text,
        count=1,
        flags=re.DOTALL | re.MULTILINE,
    )
    # Never report a confirmation the file did not receive: parse_frontmatter
    # is lenient (it strips quotes) where this rewrite is exact, so a status
    # line it accepts could otherwise leave the spec on disk still draft.
    if updated == text or parse_frontmatter(updated).get("status") != "confirmed":
        fail(f"could not rewrite the status line in {path.relative_to(base)} — "
             "set `status: draft` on its own frontmatter line and retry")
    path.write_text(updated, encoding="utf-8")
    append_event(base, "spec-confirmed", actor="orchestrator", detail=slug)
    print(f"Spec confirmed: {path.relative_to(base)}")
