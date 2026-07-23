from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
PACKAGE_SCRIPT = SCRIPTS_DIR / "check_package_contents.py"
IMAGE_SCRIPT = SCRIPTS_DIR / "check_runtime_images.py"


def load_package_script_module():
    spec = importlib.util.spec_from_file_location(
        "check_package_contents", PACKAGE_SCRIPT
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_image_script_module():
    spec = importlib.util.spec_from_file_location("check_runtime_images", IMAGE_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_script(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *args],
        text=True,
        capture_output=True,
        check=False,
    )


class SupplyChainGateTests(unittest.TestCase):
    def test_package_contents_rejects_forbidden_paths(self) -> None:
        result = run_script(
            PACKAGE_SCRIPT,
            "--paths-json",
            '["dist/index.js", ".factory/run.json", "secrets/id_rsa"]',
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn(".factory/run.json", result.stdout)
        self.assertIn("secrets/id_rsa", result.stdout)

    def test_package_contents_allows_expected_publish_files(self) -> None:
        result = run_script(
            PACKAGE_SCRIPT,
            "--paths-json",
            '["dist/index.js", "packages/contracts/dist/index.js", "docker-compose.yml"]',
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_package_contents_inspection_disables_npm_scripts(self) -> None:
        module = load_package_script_module()
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='[{"files":[{"path":"dist/index.js"}]}]',
            stderr="",
        )
        with mock.patch.object(module.subprocess, "run", return_value=completed) as run:
            self.assertEqual(module.npm_pack_files(Path("/repo")), ["dist/index.js"])

        run.assert_called_once()
        argv = run.call_args.args[0]
        self.assertIn("--ignore-scripts", argv)

    def test_package_contents_inspection_covers_publishable_workspaces(self) -> None:
        module = load_package_script_module()
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='[{"files":[{"path":"dist/index.js"}]}]',
            stderr="",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(
                '{"workspaces":["packages/*"]}', encoding="utf-8"
            )
            (root / "packages" / "sdk").mkdir(parents=True)
            (root / "packages" / "sdk" / "package.json").write_text(
                '{"name":"@gantry/sdk"}', encoding="utf-8"
            )
            with mock.patch.object(
                module.subprocess, "run", return_value=completed
            ) as run:
                module.npm_pack_files(root)

        self.assertEqual(run.call_count, 2)
        self.assertEqual(
            [call.kwargs["cwd"] for call in run.call_args_list],
            [root, root / "packages" / "sdk"],
        )

    def test_runtime_image_members_reject_forbidden_paths(self) -> None:
        result = run_script(
            IMAGE_SCRIPT,
            "--members",
            "app/index.js\napp/.factory/run.json\napp/.env\n",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("app/.factory/run.json", result.stdout)
        self.assertIn("app/.env", result.stdout)

    def test_runtime_image_members_allow_clean_paths(self) -> None:
        result = run_script(
            IMAGE_SCRIPT,
            "--members",
            "app/dist/index.js\napp/node_modules/pkg/index.js\nusr/bin/node\netc/ssl/certs/ACME_Root_CA.pem\n",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_runtime_image_members_reject_private_key_like_pem_paths(self) -> None:
        result = run_script(
            IMAGE_SCRIPT,
            "--members",
            "etc/ssl/certs/ACME_Root_CA.pem\nrun/secrets/service-private-key.pem\n",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("run/secrets/service-private-key.pem", result.stdout)
        self.assertNotIn("etc/ssl/certs/ACME_Root_CA.pem", result.stdout)

    def test_runtime_image_gate_can_require_content_inspection(self) -> None:
        result = run_script(IMAGE_SCRIPT, "--require-content-inspection")
        self.assertEqual(result.returncode, 1)
        self.assertIn("No runtime images configured", result.stdout)

    def test_runtime_image_gate_ignores_locally_built_compose_images(self) -> None:
        module = load_image_script_module()
        with tempfile.TemporaryDirectory() as tmp:
            compose = Path(tmp) / "docker-compose.yml"
            compose.write_text(
                """
x-worker-base:
  build:
    context: .
  image: gantry-runtime:fleet-rehearsal

services:
  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
  postgres:
    image: pgvector/pgvector:0.8.2-pg16-trixie@sha256:fce8fb583b92ef8af5150b373a96415d46a8cd38ba09b38efeea17c8b4c7d782
""",
                encoding="utf-8",
            )

            self.assertEqual(
                module.compose_image_violations([compose]),
                [f"{compose}:9: minio/minio:RELEASE.2025-04-22T22-12-26Z"],
            )
            self.assertEqual(
                module.compose_images([compose]),
                [
                    "minio/minio:RELEASE.2025-04-22T22-12-26Z",
                    "pgvector/pgvector:0.8.2-pg16-trixie@sha256:fce8fb583b92ef8af5150b373a96415d46a8cd38ba09b38efeea17c8b4c7d782",
                ],
            )
            self.assertEqual(
                module.compose_image_inspection_targets([compose]),
                [
                    module.ImageInspectionTarget(
                        image="gantry-runtime:fleet-rehearsal",
                        pull_before_save=False,
                    ),
                    module.ImageInspectionTarget(
                        image="minio/minio:RELEASE.2025-04-22T22-12-26Z",
                        pull_before_save=True,
                    ),
                    module.ImageInspectionTarget(
                        image="pgvector/pgvector:0.8.2-pg16-trixie@sha256:fce8fb583b92ef8af5150b373a96415d46a8cd38ba09b38efeea17c8b4c7d782",
                        pull_before_save=True,
                    ),
                ],
            )

    def test_runtime_image_gate_default_files_include_ops_compose(self) -> None:
        module = load_image_script_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
            (root / "ops" / "docker").mkdir(parents=True)
            (root / "ops" / "docker" / "docker-compose.fleet.yml").write_text(
                "services: {}\n", encoding="utf-8"
            )

            self.assertEqual(
                module.default_compose_files(root),
                [
                    root / "docker-compose.yml",
                    root / "ops" / "docker" / "docker-compose.fleet.yml",
                ],
            )
