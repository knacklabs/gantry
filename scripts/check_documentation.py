#!/usr/bin/env python3
"""Deterministic checks for Gantry's current public documentation surfaces."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

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
    Path("docs/MEMORY.md"),
    Path("docs/getting-started.md"),
    Path("docs/product/BRIEF.md"),
    Path("docs/product/company-adoption-guide.md"),
    Path("docs/architecture/README.md"),
    Path("docs/architecture/deployment-profiles.md"),
    Path("docs/architecture/multi-agent-provider-configuration.md"),
    Path("docs/architecture/overview.md"),
    Path("docs/architecture/system-atlas.md"),
    Path("docs/architecture/runtime-flows.md"),
    Path("docs/architecture/scaling-and-deployment.md"),
    Path("docs/engineering"),
    Path("docs/specs/architecture-atlas-and-adoption.md"),
    Path("docs/index.html"),
    ATLAS / "known-limitations.md",
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
ENGINEERING_POLICIES = (
    "api-and-contracts.md",
    "architecture-rules.md",
    "coding-standards.md",
    "configuration-and-secrets.md",
    "dependencies.md",
    "documentation.md",
    "errors-and-observability.md",
    "performance.md",
    "persistence-and-migrations.md",
    "source-organization.md",
    "testing.md",
)
DECISION_STATUSES = {"proposed", "accepted", "superseded"}
PLAN_STATUSES = {"proposed", "approved", "in-progress", "completed", "abandoned"}
CANONICAL_REPOSITORY = "https://github.com/knacklabs/gantry"
HISTORICAL_ARCHITECTURE_NAME = re.compile(
    r"(?:^|[-_])(?:audit|draft|goal-prompt|handoff|plan|review|validation)(?:[-_.]|$)",
    re.IGNORECASE,
)
FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


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
    links, _anchors, _base_href = _html_ast_evidence(text)
    return list(links)


def _is_external(target: str) -> bool:
    split = urlsplit(target)
    return bool(split.scheme or split.netloc or target.startswith("//"))


MARKDOWN_AST_SCRIPT = r"""
import * as prettier from "prettier";
import GithubSlugger from "github-slugger";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const { ast } = await prettier.__debug.parse(source, { parser: "markdown" });
const slugger = new GithubSlugger();
const headings = [];
const html = [];
function text(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value || "";
  if (node.type === "image" || node.type === "imageReference") return node.alt || "";
  return Array.isArray(node.children) ? node.children.map(text).join("") : "";
}
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "heading") headings.push(slugger.slug(text(node)));
  if (node.type === "html" && typeof node.value === "string") html.push(node.value);
  if (Array.isArray(node.children)) node.children.forEach(visit);
}
visit(ast);
process.stdout.write(JSON.stringify({ headings, html }));
"""

HTML_AST_SCRIPT = r"""
import { parse } from "parse5";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const document = parse(source, { scriptingEnabled: true });
const links = [];
const anchors = [];
let baseHref = null;
function visit(node) {
  if (!node || typeof node !== "object") return;
  const attrs = Array.isArray(node.attrs) ? node.attrs : [];
  const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    if (tag === "base" && name === "href" && baseHref === null) baseHref = attr.value;
    if (tag !== "base" && (name === "href" || name === "src") && attr.value) links.push(attr.value);
    if (attr.value && (name === "id" || (tag === "a" && name === "name"))) {
      anchors.push(attr.value);
    }
  }
  // Template descendants live in a separate DocumentFragment and cannot be
  // fragment targets in this document. parse5 exposes them on `content`, not
  // `childNodes`, so walking childNodes mirrors the browser document tree.
  if (Array.isArray(node.childNodes)) node.childNodes.forEach(visit);
}
visit(document);
process.stdout.write(JSON.stringify({ links, anchors, baseHref }));
"""


@lru_cache(maxsize=128)
def _markdown_ast_evidence(text: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", MARKDOWN_AST_SCRIPT],
        input=text,
        text=True,
        capture_output=True,
        check=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    payload = json.loads(result.stdout)
    return tuple(payload["headings"]), tuple(payload["html"])


@lru_cache(maxsize=128)
def _html_ast_evidence(text: str) -> tuple[tuple[str, ...], tuple[str, ...], str | None]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", HTML_AST_SCRIPT],
        input=text,
        text=True,
        capture_output=True,
        check=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    payload = json.loads(result.stdout)
    return tuple(payload["links"]), tuple(payload["anchors"]), payload["baseHref"]


def _anchors(path: Path, text: str) -> set[str]:
    headings: tuple[str, ...] = ()
    if path.suffix.lower() == ".md":
        headings, html_blocks = _markdown_ast_evidence(text)
        _links, html_anchors, _base_href = _html_ast_evidence("\n".join(html_blocks))
    else:
        _links, html_anchors, _base_href = _html_ast_evidence(text)
    anchors = set(html_anchors)
    if path.suffix.lower() == ".md":
        anchors.update(headings)
    return anchors


def _check_links(root: Path, errors: list[str]) -> None:
    for path in _public_files(root):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(root)
        base_href = _html_ast_evidence(text)[2] if path.suffix.lower() == ".html" else None
        for raw_target in _links(path, text):
            effective_target = urljoin(base_href, raw_target) if base_href else raw_target
            if not effective_target or _is_external(effective_target):
                continue
            split = urlsplit(effective_target)
            target = unquote(split.path)
            if not target:
                resolved = path.resolve()
            elif target.startswith("/"):
                resolved = (root / target.lstrip("/")).resolve()
            else:
                resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                errors.append(f"{relative}: local link escapes repository: {raw_target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: broken local link: {raw_target}")
                continue
            fragment = unquote(split.fragment)
            if not fragment or not resolved.is_file() or resolved.suffix.lower() not in {".md", ".html"}:
                continue
            # HTML Standard §7.4.6.4 selects the top of the document when the
            # decoded fragment is an ASCII-case-insensitive `top`. Markdown
            # targets here are renderable documents and receive that browser
            # behavior after rendering just like checked `.html` targets.
            if fragment.lower() == "top":
                continue
            target_text = resolved.read_text(encoding="utf-8")
            if fragment not in _anchors(resolved, target_text):
                errors.append(
                    f"{relative}: missing local fragment in {resolved.relative_to(root.resolve())}: #{fragment}"
                )


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


def _frontmatter_fields(path: Path) -> dict[str, str] | None:
    match = FRONTMATTER.match(path.read_text(encoding="utf-8", errors="replace"))
    if not match:
        return None
    return {
        key.strip(): value.strip().strip('"').strip("'")
        for line in match.group(1).splitlines()
        for key, separator, value in (line.partition(":"),)
        if separator and key.strip()
    }


def _governance_enabled(root: Path) -> bool:
    return (root / "docs" / "engineering").is_dir() or (root / "package.json").is_file()


def _check_engineering_contract(root: Path, errors: list[str]) -> None:
    engineering = root / "docs" / "engineering"
    index = engineering / "README.md"
    if not index.is_file():
        errors.append("docs/engineering/README.md: missing canonical engineering index")
        return
    index_text = index.read_text(encoding="utf-8")
    for name in ENGINEERING_POLICIES:
        policy = engineering / name
        if not policy.is_file():
            errors.append(f"docs/engineering/{name}: missing required engineering policy")
            continue
        if f"({name})" not in index_text:
            errors.append(f"docs/engineering/README.md: policy is not indexed: {name}")
        text = policy.read_text(encoding="utf-8")
        for label in ("Mechanical", "Review", "Recommendation"):
            if f"**{label}:**" not in text:
                errors.append(
                    f"docs/engineering/{name}: missing **{label}:** rule classification"
                )


def _check_decision_lifecycle(root: Path, errors: list[str]) -> None:
    decisions = root / "docs" / "decisions"
    records = sorted(decisions.glob("[0-9][0-9][0-9][0-9]-*.md"))
    stems = {record.stem for record in records}
    for record in records:
        relative = record.relative_to(root)
        fields = _frontmatter_fields(record)
        if fields is None:
            errors.append(f"{relative}: decision record has no YAML frontmatter")
            continue
        status = fields.get("status", "")
        if status not in DECISION_STATUSES:
            allowed = ", ".join(sorted(DECISION_STATUSES))
            errors.append(f"{relative}: invalid decision status {status!r}; allowed: {allowed}")
        if status == "accepted" and not fields.get("confirmed_by"):
            errors.append(f"{relative}: accepted decision has no confirmed_by")
        if status == "superseded" and not fields.get("superseded_by"):
            errors.append(f"{relative}: superseded decision has no superseded_by")
        for field in ("supersedes", "superseded_by"):
            target = fields.get(field)
            if target and target not in stems:
                errors.append(f"{relative}: {field} target does not exist: {target}")


def _check_plan_lifecycle(root: Path, errors: list[str]) -> None:
    records = sorted((root / "plans" / "active").glob("*.md"))
    records.extend(sorted((root / "plans" / "completed").glob("*.md")))
    records.extend(sorted((root / "plans" / "archive").glob("*.md")))
    for record in records:
        relative = record.relative_to(root)
        fields = _frontmatter_fields(record)
        if fields is None:
            errors.append(f"{relative}: plan record has no YAML frontmatter")
            continue
        status = fields.get("status", "")
        if status not in PLAN_STATUSES:
            allowed = ", ".join(sorted(PLAN_STATUSES))
            errors.append(f"{relative}: invalid plan status {status!r}; allowed: {allowed}")
        for field in ("issue", "title"):
            if not fields.get(field):
                errors.append(f"{relative}: plan lifecycle metadata is missing {field}")


def _check_taxonomy_and_indexes(root: Path, errors: list[str]) -> None:
    governance = root / "docs" / "engineering" / "documentation.md"
    if governance.is_file():
        text = governance.read_text(encoding="utf-8")
        for marker in (
            "docs/engineering/",
            "docs/architecture/",
            "docs/decisions/",
            "plans/active/",
            "plans/completed/",
        ):
            if marker not in text:
                errors.append(f"{governance.relative_to(root)}: missing taxonomy location {marker}")

    architecture_index = root / "docs" / "architecture" / "README.md"
    if not architecture_index.is_file():
        errors.append("docs/architecture/README.md: missing current architecture index")
        return
    for target in _links(architecture_index, architecture_index.read_text(encoding="utf-8")):
        name = Path(urlsplit(target).path).name
        if name and HISTORICAL_ARCHITECTURE_NAME.search(name):
            errors.append(
                "docs/architecture/README.md: current architecture index references "
                f"historical work record: {target}"
            )


def _check_repository_identity(root: Path, errors: list[str]) -> None:
    manifest = root / "package.json"
    if not manifest.is_file():
        errors.append("package.json: missing canonical repository manifest")
        return
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"package.json: invalid JSON: {exc}")
        return
    repository = package.get("repository")
    repository_url = repository.get("url", "") if isinstance(repository, dict) else ""
    expected = {
        "name": "@gantry/runtime",
        "homepage": CANONICAL_REPOSITORY,
        "bugs.url": f"{CANONICAL_REPOSITORY}/issues",
        "repository.url": f"git+{CANONICAL_REPOSITORY}.git",
    }
    actual = {
        "name": package.get("name"),
        "homepage": package.get("homepage"),
        "bugs.url": package.get("bugs", {}).get("url")
        if isinstance(package.get("bugs"), dict)
        else None,
        "repository.url": repository_url,
    }
    for field, value in expected.items():
        if actual[field] != value:
            errors.append(f"package.json: canonical {field} must be {value!r}")
    if not re.fullmatch(r"npm@\d+\.\d+\.\d+", str(package.get("packageManager", ""))):
        errors.append("package.json: packageManager must pin npm as npm@<major>.<minor>.<patch>")
    engines = package.get("engines")
    node_range = engines.get("node") if isinstance(engines, dict) else None
    if not node_range:
        errors.append("package.json: engines.node must declare the supported Node.js range")


def _check_governance(root: Path, errors: list[str]) -> None:
    if not _governance_enabled(root):
        return
    _check_engineering_contract(root, errors)
    _check_decision_lifecycle(root, errors)
    _check_plan_lifecycle(root, errors)
    _check_taxonomy_and_indexes(root, errors)
    _check_repository_identity(root, errors)


def check_repository(root: Path) -> list[str]:
    errors: list[str] = []
    _check_links(root, errors)
    _check_prohibited_paths(root, errors)
    _check_evidence_manifest(root, errors)
    _check_artifacts(root, errors)
    _check_governance(root, errors)
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
