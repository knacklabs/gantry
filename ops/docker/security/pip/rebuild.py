#!/usr/bin/env python3
"""Rebuild the reviewed pip 26.2.2 vendor refresh deterministically."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SOURCES = {
    "pip": (
        "https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl",
        "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70",
    ),
    "urllib3": (
        "https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl",
        "0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3",
    ),
    "msgpack": (
        "https://files.pythonhosted.org/packages/31/f9/c0a1c127f9049db9155afc316952ea571720dd01833ff5e4d7e8e6352dbb/msgpack-1.2.1.tar.gz",
        "04c721c2c7448767e9e3f2520a475663d8ee0f09c31890f6d2bd70fd636a9647",
    ),
}
PATCHES = (
    "urllib3-disable-brotli.patch",
    "urllib3-fix-emscripten-import.patch",
    "urllib3.patch",
)
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def fetch(url: str, expected: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        data = response.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise RuntimeError(f"source hash mismatch: expected {expected}, got {actual}")
    return data


def main() -> int:
    here = Path(__file__).resolve().parent
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pip-26.2.2-py3-none-any.whl")
    blobs = {name: fetch(*source) for name, source in SOURCES.items()}
    with tempfile.TemporaryDirectory(prefix="gantry-pip-vendor-") as tmp:
        root = Path(tmp) / "wheel"
        with zipfile.ZipFile(io.BytesIO(blobs["pip"])) as archive:
            archive.extractall(root)

        urllib_target = root / "pip/_vendor/urllib3"
        shutil.rmtree(urllib_target)
        with zipfile.ZipFile(io.BytesIO(blobs["urllib3"])) as archive:
            for member in archive.infolist():
                if member.filename.startswith("urllib3/") and not member.is_dir():
                    destination = urllib_target / member.filename.removeprefix("urllib3/")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read(member))

        msgpack_target = root / "pip/_vendor/msgpack"
        shutil.rmtree(msgpack_target)
        msgpack_target.mkdir()
        with tarfile.open(fileobj=io.BytesIO(blobs["msgpack"]), mode="r:gz") as archive:
            for name in ("__init__.py", "exceptions.py", "ext.py", "fallback.py"):
                member = archive.getmember(f"msgpack-1.2.1/msgpack/{name}")
                msgpack_target.joinpath(name).write_bytes(archive.extractfile(member).read())
            for name in ("COPYING",):
                member = archive.getmember(f"msgpack-1.2.1/{name}")
                msgpack_target.joinpath(name).write_bytes(archive.extractfile(member).read())

        for patch_name in PATCHES:
            subprocess.run(
                ["patch", "-d", str(root), "-p2", "--forward", "--batch", "-i", str(here / patch_name)],
                check=True,
            )

        for source in urllib_target.rglob("*.py"):
            text = source.read_text()
            text = text.replace("import urllib3.connection as urllib3_connection", "import pip._vendor.urllib3.connection as urllib3_connection")
            text = text.replace("import urllib3.connection\n", "import pip._vendor.urllib3.connection as urllib3_connection\n")
            text = text.replace("import urllib3\n", "from pip._vendor import urllib3\n")
            text = text.replace("import idna\n", "from pip._vendor import idna\n")
            source.write_text(text)

        vendor = root / "pip/_vendor/vendor.txt"
        vendor.write_text(vendor.read_text().replace("msgpack==1.1.2", "msgpack==1.2.1").replace("urllib3==2.7.0", "urllib3==2.8.0"))

        # Match pip's shipped component inventory to the code refreshed above.
        # Retain setuptools: pip still ships its pkg_resources subset.
        bom_path = root / "pip/_vendor/bom.cdx.json"
        bom = json.loads(bom_path.read_text())
        references = {}
        for component in bom.get("components", []):
            version = {"urllib3": "2.8.0", "msgpack": "1.2.1"}.get(component.get("name"))
            if version:
                old_ref = component["bom-ref"]
                new_ref = f"pkg:pypi/{component['name']}@{version}"
                references[old_ref] = new_ref
                component.update({"version": version, "purl": new_ref, "bom-ref": new_ref})

        def update_references(value):
            if isinstance(value, dict):
                return {key: update_references(item) for key, item in value.items()}
            if isinstance(value, list):
                return [update_references(item) for item in value]
            return references.get(value, value) if isinstance(value, str) else value

        bom_path.write_text(json.dumps(update_references(bom), indent=2) + "\n")

        record = root / "pip-26.2.2.dist-info/RECORD"
        rows = []
        for source in sorted(root.rglob("*")):
            if not source.is_file() or source == record:
                continue
            data = source.read_bytes()
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            rows.append((source.relative_to(root).as_posix(), f"sha256={digest}", str(len(data))))
        rows.append((record.relative_to(root).as_posix(), "", ""))
        buffer = io.StringIO(newline="")
        csv.writer(buffer, lineterminator="\n").writerows(rows)
        record.write_text(buffer.getvalue())

        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source in sorted(root.rglob("*")):
                if not source.is_file():
                    continue
                info = zipfile.ZipInfo(source.relative_to(root).as_posix(), ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    print(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
