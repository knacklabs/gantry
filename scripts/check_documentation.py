#!/usr/bin/env python3
"""Deterministic checks for Gantry's current public documentation surfaces."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

SOURCE_REVISION = "69ac5b71650d1d8ff99c24eb15fa368b9c3eb418"
ARCHIFY_VERSION = "2.13.0"
ATLAS = Path("docs/architecture/atlas")
ARTIFACTS = (
    ("architecture", "gantry-system.architecture"),
    ("sequence", "live-turn.sequence"),
    ("dataflow", "memory-dreaming.dataflow"),
    ("lifecycle", "permission-execution.lifecycle"),
    ("architecture", "fleet-execution.architecture"),
)
PUBLIC_ROOTS = (
    Path("README.md"),
    Path("docs/README.md"),
    Path("docs/getting-started.md"),
    Path("docs/product/company-adoption-guide.md"),
    Path("docs/architecture/README.md"),
    Path("docs/architecture/overview.md"),
    Path("docs/architecture/system-atlas.md"),
    Path("docs/architecture/runtime-flows.md"),
    Path("docs/architecture/scaling-and-deployment.md"),
    Path("docs/index.html"),
    ATLAS,
)
PROHIBITED = ("/private/tmp", "/Users/", "file://")
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
REQUIRED_VALIDATION = {
    "checks_passed": 9,
    "check_count": 9,
    "errors": 0,
    "warnings": 0,
}
EXPECTED_RECEIPTS = {f"{stem}.json" for _diagram_type, stem in ARTIFACTS}


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name.lower() in {"href", "src"} and value:
                self.links.append(value)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _public_files(root: Path) -> list[Path]:
    files: set[Path] = set()
    # The atlas is independently shippable in T1. Once the new public landing
    # page exists, expand the same check to every current public entrypoint.
    roots = PUBLIC_ROOTS if (root / "docs/index.html").is_file() else (ATLAS,)
    for relative in roots:
        path = root / relative
        if path.is_file() and path.suffix.lower() in {".md", ".html"}:
            files.add(path)
        elif path.is_dir():
            files.update(path.rglob("*.md"))
            files.update(path.rglob("*.html"))
    return sorted(files)


def _links(path: Path, text: str) -> list[str]:
    if path.suffix.lower() == ".md":
        return [match.group(1).strip().split(maxsplit=1)[0].strip("<>") for match in MARKDOWN_LINK.finditer(text)]
    parser = _LinkParser()
    parser.feed(text)
    return parser.links


def _is_external(target: str) -> bool:
    split = urlsplit(target)
    return bool(split.scheme or split.netloc or target.startswith(("#", "//")))


def _check_links(root: Path, errors: list[str]) -> None:
    for path in _public_files(root):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(root)
        for raw_target in _links(path, text):
            if not raw_target or _is_external(raw_target):
                continue
            target = unquote(urlsplit(raw_target).path)
            if not target:
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                errors.append(f"{relative}: local link escapes repository: {raw_target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: broken local link: {raw_target}")


def _check_prohibited_paths(root: Path, errors: list[str]) -> None:
    paths = set(_public_files(root))
    paths.update((root / ATLAS).rglob("*.json"))
    for path in sorted(paths):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(root)
        for marker in PROHIBITED:
            if marker in text:
                errors.append(f"{relative}: contains prohibited local reference {marker!r}")


def _check_evidence_manifest(root: Path, errors: list[str]) -> None:
    manifest = root / ATLAS / "source-evidence.md"
    if not manifest.is_file():
        errors.append(f"{manifest.relative_to(root)}: missing evidence manifest")
        return
    text = manifest.read_text(encoding="utf-8")
    required_markers = {
        SOURCE_REVISION: "pinned Gantry source revision",
        f"| Archify version | `{ARCHIFY_VERSION}` |": "pinned Archify version",
        "## Evidence policy": "authority order",
        "## Subsystem evidence map": "subsystem source entrypoints",
    }
    for marker, description in required_markers.items():
        if marker not in text:
            errors.append(f"{manifest.relative_to(root)}: missing {description}")


def _check_delivered_html(root: Path, path: Path, text: str, errors: list[str]) -> None:
    relative = path.relative_to(root)
    lower = text.lower()
    required_markers = {
        "<!doctype html": "HTML doctype",
        '<html lang="en"': "document language",
        "<title>": "document title",
        "<style": "inline styles",
        "<script": "inline interaction code",
        "aria-labelledby": "accessible diagram labelling",
    }
    for marker, description in required_markers.items():
        if marker not in lower:
            errors.append(f"{relative}: missing {description}")
    if SOURCE_REVISION not in text and SOURCE_REVISION[:7] not in text:
        errors.append(f"{relative}: missing pinned source revision")


def _check_artifacts(root: Path, errors: list[str]) -> None:
    atlas = root / ATLAS
    receipt_path = atlas / "delivery-receipts.json"
    if not receipt_path.is_file():
        errors.append(f"{receipt_path.relative_to(root)}: missing receipt manifest")
        return
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        errors.append(f"{receipt_path.relative_to(root)}: invalid receipt manifest: {exc}")
        return

    if not isinstance(receipt, dict):
        errors.append("delivery receipt: root must be an object")
        return
    generator = receipt.get("generator")
    source = receipt.get("source")
    if not isinstance(generator, dict) or generator.get("name") != "Archify":
        errors.append("delivery receipt: generator must be Archify")
        generator = {}
    if not isinstance(source, dict):
        errors.append("delivery receipt: source must be an object")
        source = {}
    if generator.get("version") != ARCHIFY_VERSION:
        errors.append("delivery receipt: Archify version mismatch")
    if source.get("revision") != SOURCE_REVISION:
        errors.append("delivery receipt: Gantry source revision mismatch")
    if receipt.get("quality_profile") != "showcase":
        errors.append("delivery receipt: quality profile must be showcase")

    receipt_rows = receipt.get("artifacts", [])
    if not isinstance(receipt_rows, list):
        errors.append("delivery receipt: artifacts must be a list")
        receipt_rows = []
    rows: dict[str, dict] = {}
    for row in receipt_rows:
        if not isinstance(row, dict):
            errors.append("delivery receipt: artifact row must be an object")
            continue
        name = row.get("specification")
        if not isinstance(name, str):
            errors.append("delivery receipt: artifact row lacks a specification")
            continue
        if name in rows:
            errors.append(f"delivery receipt: duplicate {name}")
        rows[name] = row
    unexpected = sorted(set(rows) - EXPECTED_RECEIPTS)
    if unexpected:
        errors.append(f"delivery receipt: unexpected specifications: {', '.join(unexpected)}")
    for diagram_type, stem in ARTIFACTS:
        specification = atlas / f"{stem}.json"
        artifact = atlas / f"{stem}.html"
        for path in (specification, artifact):
            if not path.is_file():
                errors.append(f"{path.relative_to(root)}: missing Archify pair member")
        if not specification.is_file() or not artifact.is_file():
            continue
        try:
            payload = json.loads(specification.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{specification.relative_to(root)}: invalid JSON: {exc}")
            continue
        if not isinstance(payload, dict):
            errors.append(f"{specification.relative_to(root)}: JSON root must be an object")
            continue
        if payload.get("diagram_type") != diagram_type:
            errors.append(f"{specification.relative_to(root)}: diagram type mismatch")
        meta = payload.get("meta", {})
        if not isinstance(meta, dict):
            errors.append(f"{specification.relative_to(root)}: meta must be an object")
            meta = {}
        if meta.get("quality_profile") != "showcase":
            errors.append(f"{specification.relative_to(root)}: quality profile must be showcase")
        if meta.get("output") != str(ATLAS / artifact.name):
            errors.append(f"{specification.relative_to(root)}: output path mismatch")
        repository = meta.get("repository")
        declared_revision = repository.get("revision", "") if isinstance(repository, dict) else ""
        if not isinstance(declared_revision, str):
            declared_revision = ""
        if not declared_revision and isinstance(meta.get("subtitle"), str):
            declared_revision = meta["subtitle"]
        if SOURCE_REVISION not in declared_revision and SOURCE_REVISION[:7] not in declared_revision:
            errors.append(f"{specification.relative_to(root)}: missing pinned source revision")

        artifact_text = artifact.read_text(encoding="utf-8")
        _check_delivered_html(root, artifact, artifact_text, errors)

        row = rows.get(specification.name)
        if row is None:
            errors.append(f"delivery receipt: missing {specification.name}")
            continue
        if row.get("diagram_type") != diagram_type:
            errors.append(f"delivery receipt: {specification.name} diagram type mismatch")
        checks = row.get("validation", {})
        if checks != REQUIRED_VALIDATION:
            errors.append(f"delivery receipt: {specification.name} is not a clean 9/9 showcase result")
        if row.get("visual_review") != "passed":
            errors.append(f"delivery receipt: {specification.name} lacks passed visual review")
        if row.get("specification_sha256") != _sha256(specification):
            errors.append(f"delivery receipt: {specification.name} specification hash mismatch")
        if row.get("output") != artifact.name or row.get("artifact_sha256") != _sha256(artifact):
            errors.append(f"delivery receipt: {artifact.name} artifact hash mismatch")


def check_repository(root: Path) -> list[str]:
    errors: list[str] = []
    _check_links(root, errors)
    _check_prohibited_paths(root, errors)
    _check_evidence_manifest(root, errors)
    _check_artifacts(root, errors)
    return errors


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors = check_repository(root)
    if errors:
        print("Documentation check failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"Documentation check passed: {len(_public_files(root))} public files, {len(ARTIFACTS)} verified Archify pairs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
