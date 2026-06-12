#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path


IMAGE_LINE = re.compile(r"^(?P<indent>\s*)image:\s*(?P<image>\S+)\s*$")
KEY_LINE = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z0-9_.-]+):\s*(?:#.*)?$")
FORBIDDEN_IMAGE_PATTERNS = [
    re.compile(r"(^|/)\.git($|/)"),
    re.compile(r"(^|/)\.claude($|/)"),
    re.compile(r"(^|/)\.factory($|/)"),
    re.compile(r"(^|/)\.env(?:[./]|$)"),
    re.compile(
        r"(^|/)(?:id_rsa|id_ed25519|.*private[-_]?key.*|.*(?:^|[-_.])key(?:[-_.]|$).*\.pem|.*(?:^|[-_.])priv(?:ate)?(?:[-_.]|$).*\.pem)$",
        re.I,
    ),
    re.compile(r"(^|/).*\.(?:sqlite|sqlite3|db|duckdb)$", re.I),
]


@dataclass(frozen=True)
class ComposeImageEntry:
    image: str
    line_no: int
    built_locally: bool


@dataclass(frozen=True)
class ImageInspectionTarget:
    image: str
    pull_before_save: bool


def default_compose_files(root: Path = Path(".")) -> list[Path]:
    candidates = [
        *root.glob("docker-compose*.yml"),
        *root.glob("ops/docker/docker-compose*.yml"),
    ]
    return sorted({path for path in candidates if path.exists()})


def compose_image_entries(file: Path) -> list[ComposeImageEntry]:
    entries: list[ComposeImageEntry] = []
    if not file.exists():
        return entries

    block: dict[str, object] | None = None
    in_services = False
    service: dict[str, object] | None = None

    def finish_block() -> None:
        nonlocal block
        if block is not None and block["image"]:
            entries.append(
                ComposeImageEntry(
                    str(block["image"]),
                    int(block["line_no"]),
                    bool(block["build"]),
                )
            )
        block = None

    def finish_service() -> None:
        nonlocal service
        if service is not None and service["image"]:
            entries.append(
                ComposeImageEntry(
                    str(service["image"]),
                    int(service["line_no"]),
                    bool(service["build"]),
                )
            )
        service = None

    def record(container: dict[str, object], line: str, lineno: int) -> None:
        image_match = IMAGE_LINE.match(line)
        if image_match:
            container["image"] = image_match.group("image")
            container["line_no"] = lineno
        if line.strip().startswith("build:"):
            container["build"] = True

    for lineno, line in enumerate(file.read_text().splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip(" "))
        key_match = KEY_LINE.match(line)
        if indent == 0 and key_match:
            finish_service()
            finish_block()
            key = key_match.group("key")
            in_services = key == "services"
            if not in_services:
                block = {"image": "", "line_no": 0, "build": False}
            continue

        if in_services:
            if indent == 2 and key_match:
                finish_service()
                service = {"image": "", "line_no": 0, "build": False}
                continue
            if service is not None and indent > 2:
                record(service, line, lineno)
            continue

        if block is not None and indent > 0:
            record(block, line, lineno)

    finish_service()
    finish_block()
    return entries


def compose_image_violations(files: list[Path]) -> list[str]:
    violations: list[str] = []
    for file in files:
        for entry in compose_image_entries(file):
            if entry.built_locally:
                continue
            image = entry.image
            if "@sha256:" not in image:
                violations.append(f"{file}:{entry.line_no}: {image}")
    return violations


def compose_images(files: list[Path]) -> list[str]:
    images: list[str] = []
    for file in files:
        for entry in compose_image_entries(file):
            if not entry.built_locally:
                images.append(entry.image)
    return sorted(set(images))


def compose_image_inspection_targets(files: list[Path]) -> list[ImageInspectionTarget]:
    targets: dict[str, bool] = {}
    for file in files:
        for entry in compose_image_entries(file):
            # Built images are checked by saving the local image that CI built
            # from this checkout. Remote images are pulled before saving.
            pull_before_save = not entry.built_locally
            targets[entry.image] = targets.get(entry.image, True) and pull_before_save
    return [
        ImageInspectionTarget(image=image, pull_before_save=pull)
        for image, pull in sorted(targets.items())
    ]


def forbidden_members(members: list[str]) -> list[str]:
    matches: list[str] = []
    for member in members:
        normalized = member
        if normalized.startswith("./"):
            normalized = normalized[2:]
        for pattern in FORBIDDEN_IMAGE_PATTERNS:
            if pattern.search(normalized):
                matches.append(normalized)
                break
    return sorted(set(matches))


def inspect_image(image: str, *, pull_before_save: bool = True) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "image.tar"
        if pull_before_save:
            pull = subprocess.run(
                ["docker", "image", "pull", image],
                text=True,
                capture_output=True,
                check=False,
            )
            if pull.returncode != 0:
                sys.stderr.write(pull.stderr)
                raise SystemExit(pull.returncode)
        result = subprocess.run(
            ["docker", "image", "save", image, "-o", str(archive)],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            sys.stderr.write(result.stderr)
            raise SystemExit(result.returncode)
        members: list[str] = []
        with tarfile.open(archive) as outer:
            for outer_member in outer.getmembers():
                if not outer_member.name.endswith(".tar"):
                    continue
                layer = outer.extractfile(outer_member)
                if layer is None:
                    continue
                with tarfile.open(fileobj=layer) as layer_tar:
                    members.extend(member.name for member in layer_tar.getmembers())
        return forbidden_members(members)


def runtime_images_from_env() -> list[str]:
    raw = os.environ.get("GANTRY_RUNTIME_IMAGES", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check runtime image digest pins and forbidden image contents."
    )
    parser.add_argument(
        "--compose",
        action="append",
        default=[],
        help="Compose file to scan for digest-pinned image references.",
    )
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        help="Runtime image to inspect for forbidden paths.",
    )
    parser.add_argument(
        "--inspect-compose-images",
        action="store_true",
        help="Inspect digest-pinned images discovered in compose files.",
    )
    parser.add_argument(
        "--require-content-inspection",
        action="store_true",
        help="Fail when no image or member content was inspected.",
    )
    parser.add_argument(
        "--members",
        help="Test hook: newline-delimited image member paths to check.",
    )
    args = parser.parse_args()

    compose_files = [Path(path) for path in args.compose]
    if not compose_files:
        compose_files = default_compose_files()
    digest_violations = compose_image_violations(compose_files)
    if digest_violations:
        print("Mutable image references detected:")
        for violation in digest_violations:
            print(f"- {violation}")
        return 1

    if args.members is not None:
        content_failures = forbidden_members(args.members.splitlines())
        if content_failures:
            print("Forbidden runtime image contents detected:")
            for path in content_failures:
                print(f"- {path}")
            return 1
        print("Runtime image gate passed.")
        return 0

    targets = {
        image: True for image in [*args.image, *runtime_images_from_env()]
    }
    if args.inspect_compose_images:
        for target in compose_image_inspection_targets(compose_files):
            targets[target.image] = (
                targets.get(target.image, True) and target.pull_before_save
            )
    for image, pull_before_save in sorted(targets.items()):
        failures = inspect_image(image, pull_before_save=pull_before_save)
        if failures:
            print(f"Forbidden runtime image contents detected in {image}:")
            for path in failures:
                print(f"- {path}")
            return 1

    if not targets:
        if args.require_content_inspection:
            print("No runtime images configured for content inspection.")
            return 1
        print("Runtime image digest gate passed. No runtime images configured for content inspection.")
    else:
        print("Runtime image gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
