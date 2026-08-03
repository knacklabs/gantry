from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts import check_documentation as checker


class DocumentationCheckerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.atlas = self.root / checker.ATLAS
        self.atlas.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _fixture(self, *, revision: str = checker.SOURCE_REVISION) -> None:
        rows = []
        for diagram_type, stem in checker.ARTIFACTS:
            specification = self.atlas / f"{stem}.json"
            artifact = self.atlas / f"{stem}.html"
            specification.write_text(json.dumps({
                "diagram_type": diagram_type,
                "meta": {
                    "quality_profile": "showcase",
                    "repository": {"revision": revision},
                    "output": str(checker.ATLAS / artifact.name),
                },
            }), encoding="utf-8")
            artifact.write_text(
                f'<!doctype html><html lang="en"><title>verified</title><style></style>'
                f'<svg role="img" aria-labelledby="diagram-title"><title id="diagram-title">'
                f'{checker.SOURCE_REVISION}</title></svg><script></script></html>',
                encoding="utf-8",
            )
            rows.append({
                "diagram_type": diagram_type,
                "specification": specification.name,
                "output": artifact.name,
                "specification_sha256": self._sha(specification),
                "artifact_sha256": self._sha(artifact),
                "validation": checker.REQUIRED_VALIDATION,
                "visual_review": "passed",
            })
        (self.atlas / "delivery-receipts.json").write_text(json.dumps({
            "generator": {"name": "Archify", "version": checker.ARCHIFY_VERSION},
            "source": {"revision": revision},
            "quality_profile": "showcase",
            "artifacts": rows,
        }), encoding="utf-8")
        (self.atlas / "README.md").write_text("[Evidence](source-evidence.md)\n", encoding="utf-8")
        (self.atlas / "source-evidence.md").write_text(
            "\n".join((
                "# Evidence",
                checker.SOURCE_REVISION,
                f"| Archify version | `{checker.ARCHIFY_VERSION}` |",
                "## Evidence policy",
                "## Subsystem evidence map",
            )),
            encoding="utf-8",
        )

    def test_valid_fixture_passes(self) -> None:
        self._fixture()
        self.assertEqual(checker.check_repository(self.root), [])

    def test_broken_link_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text("[Missing](missing.md)\n", encoding="utf-8")
        self.assertTrue(any("broken local link" in error for error in checker.check_repository(self.root)))

    def test_missing_artifact_pair_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "live-turn.sequence.html").unlink()
        self.assertTrue(any("missing Archify pair member" in error for error in checker.check_repository(self.root)))

    def test_missing_receipt_manifest_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "delivery-receipts.json").unlink()
        self.assertTrue(any("missing receipt manifest" in error for error in checker.check_repository(self.root)))

    def test_missing_artifact_receipt_is_reported(self) -> None:
        self._fixture()
        receipt_path = self.atlas / "delivery-receipts.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["artifacts"] = receipt["artifacts"][1:]
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        self.assertTrue(any("missing gantry-system.architecture.json" in error for error in checker.check_repository(self.root)))

    def test_revision_mismatch_is_reported(self) -> None:
        self._fixture(revision="0" * 40)
        errors = checker.check_repository(self.root)
        self.assertTrue(any("source revision mismatch" in error for error in errors))

    def test_null_specification_revision_is_reported_without_crashing(self) -> None:
        self._fixture()
        specification = self.atlas / "gantry-system.architecture.json"
        payload = json.loads(specification.read_text(encoding="utf-8"))
        payload["meta"]["repository"]["revision"] = None
        specification.write_text(json.dumps(payload), encoding="utf-8")
        self.assertTrue(any(
            "missing pinned source revision" in error and specification.name in error
            for error in checker.check_repository(self.root)
        ))

    def test_evidence_manifest_revision_mismatch_is_reported(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8").replace(checker.SOURCE_REVISION, "0" * 40),
            encoding="utf-8",
        )
        self.assertTrue(any("missing pinned Gantry source revision" in error for error in checker.check_repository(self.root)))

    def test_prohibited_local_path_is_reported(self) -> None:
        self._fixture()
        specification = self.atlas / "gantry-system.architecture.json"
        payload = json.loads(specification.read_text(encoding="utf-8"))
        payload["debug_output"] = "/private/tmp/output"
        specification.write_text(json.dumps(payload), encoding="utf-8")
        self.assertTrue(any("prohibited local reference" in error for error in checker.check_repository(self.root)))

    def test_prohibited_local_path_in_public_document_is_reported(self) -> None:
        self._fixture()
        docs = self.root / "docs"
        (docs / "index.html").write_text("<!doctype html><title>Docs</title>", encoding="utf-8")
        (self.root / "README.md").write_text("Generated at /Users/example/output\n", encoding="utf-8")
        self.assertTrue(any(
            error.startswith("README.md:") and "prohibited local reference" in error
            for error in checker.check_repository(self.root)
        ))

    def test_validation_error_is_reported(self) -> None:
        self._fixture()
        receipt_path = self.atlas / "delivery-receipts.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["artifacts"][0]["validation"]["errors"] = 1
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        self.assertTrue(any("not a clean 9/9 showcase result" in error for error in checker.check_repository(self.root)))

    def test_absent_visual_review_is_reported(self) -> None:
        self._fixture()
        receipt_path = self.atlas / "delivery-receipts.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        del receipt["artifacts"][0]["visual_review"]
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        self.assertTrue(any("lacks passed visual review" in error for error in checker.check_repository(self.root)))

    def test_artifact_hash_mismatch_is_reported(self) -> None:
        self._fixture()
        artifact = self.atlas / "gantry-system.architecture.html"
        artifact.write_text(artifact.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        self.assertTrue(any("artifact hash mismatch" in error for error in checker.check_repository(self.root)))

    def test_delivered_html_without_revision_is_reported(self) -> None:
        self._fixture()
        artifact = self.atlas / "gantry-system.architecture.html"
        artifact.write_text(
            artifact.read_text(encoding="utf-8").replace(checker.SOURCE_REVISION, "unversioned"),
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing pinned source revision" in error and artifact.name in error
            for error in checker.check_repository(self.root)
        ))


if __name__ == "__main__":
    unittest.main()
