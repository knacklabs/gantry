#!/usr/bin/env python3
"""Rebuild pip 26.3 with its setuptools pkg_resources subset actually refreshed."""
from __future__ import annotations
import base64
import csv
import hashlib
import io
import json
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SOURCES = {
    "pip": (
        "https://files.pythonhosted.org/packages/07/25/ee8c38ae72d66b844ce8eb9711ba905dba21ca1a8a0c960057c41cd23337/pip-26.3-py3-none-any.whl",
        "f3b60b20ffaadd4415ed7957212a38ac63fa4c5fa375bd0f4a797777940fad13",
    ),
    "setuptools": (
        "https://files.pythonhosted.org/packages/90/99/158ad0609729111163fc1f674a5a42f2605371a4cf036d0441070e2f7455/setuptools-78.1.1-py3-none-any.whl",
        "c3a9c4211ff4c309edb8b8c4f1cbfa7ae324c4ba9f91ff254e3d305b9fd54561",
    ),
}
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)

def fetch(url: str, expected: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("source hash mismatch")
    return data

def main() -> int:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pip-26.3-py3-none-any.whl")
    blobs = {name: fetch(*source) for name, source in SOURCES.items()}
    with tempfile.TemporaryDirectory(prefix="gantry-pip-vendor-") as tmp:
        root = Path(tmp) / "wheel"
        with zipfile.ZipFile(io.BytesIO(blobs["pip"])) as archive:
            archive.extractall(root)
        # Keep pip's existing standalone-vendor imports. Do not add a full
        # setuptools install or make pip depend on system/site packages.
        with zipfile.ZipFile(io.BytesIO(blobs["setuptools"])) as archive:
            source = archive.read("pkg_resources/__init__.py").decode()
            vendor_path_line = next(line for line in source.splitlines() if line.startswith("sys.path.extend(((vendor_path :="))
            source = source.replace(vendor_path_line + "\n", "")
            for name in ("markers", "requirements", "specifiers", "utils", "version"):
                source = source.replace(f"import packaging.{name}", f"from pip._vendor.packaging import {name} as _packaging_{name}")
                source = source.replace(f"packaging.{name}", f"_packaging_{name}")
            source = source.replace("from jaraco.text import", "from pip._internal.utils._jaraco_text import")
            source = source.replace("from platformdirs import", "from pip._vendor.platformdirs import")
            target = root / "pip/_vendor/pkg_resources"
            (target / "__init__.py").write_text(source)
            (target / "LICENSE").write_bytes(archive.read("setuptools-78.1.1.dist-info/licenses/LICENSE"))
        vendor = root / "pip/_vendor/vendor.txt"
        assert "msgpack==1.2.4" in vendor.read_text() and "urllib3==2.8.0" in vendor.read_text()
        vendor.write_text(vendor.read_text().replace("setuptools==70.3.0", "setuptools==78.1.1"))
        bom_path = root / "pip/_vendor/bom.cdx.json"
        bom = json.loads(bom_path.read_text())
        refs = {}
        for component in bom["components"]:
            if component.get("name") == "setuptools":
                new_ref = "pkg:pypi/setuptools@78.1.1"
                refs[component["bom-ref"]] = new_ref
                component.update({"version": "78.1.1", "purl": new_ref, "bom-ref": new_ref})
        def update(value):
            if isinstance(value, dict): return {key: update(item) for key, item in value.items()}
            if isinstance(value, list): return [update(item) for item in value]
            return refs.get(value, value) if isinstance(value, str) else value
        bom_path.write_text(json.dumps(update(bom), indent=2) + "\n")
        record = root / "pip-26.3.dist-info/RECORD"
        rows = []
        for source in sorted(root.rglob("*")):
            if source.is_file() and source != record:
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
                if source.is_file():
                    info = zipfile.ZipInfo(source.relative_to(root).as_posix(), ZIP_TIMESTAMP)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    print(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
