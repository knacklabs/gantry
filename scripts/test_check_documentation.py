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
                },
            }), encoding="utf-8")
            artifact.write_text("<!doctype html><title>verified</title>", encoding="utf-8")
            rows.append({
                "diagram_type": diagram_type,
                "specification": specification.name,
                "output": artifact.name,
                "specification_sha256": self._sha(specification),
                "artifact_sha256": self._sha(artifact),
                "validation": {"checks_passed": 9, "check_count": 9, "errors": 0, "warnings": 0},
                "visual_review": "passed",
            })
        (self.atlas / "delivery-receipts.json").write_text(json.dumps({
            "generator": {"version": checker.ARCHIFY_VERSION},
            "source": {"revision": revision},
            "quality_profile": "showcase",
            "artifacts": rows,
        }), encoding="utf-8")
        (self.atlas / "README.md").write_text("[Evidence](source-evidence.md)\n", encoding="utf-8")
        (self.atlas / "source-evidence.md").write_text("# Evidence\n", encoding="utf-8")

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

    def test_revision_mismatch_is_reported(self) -> None:
        self._fixture(revision="0" * 40)
        errors = checker.check_repository(self.root)
        self.assertTrue(any("source revision mismatch" in error for error in errors))

    def test_prohibited_local_path_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text("Generated at /private/tmp/output\n", encoding="utf-8")
        self.assertTrue(any("prohibited local reference" in error for error in checker.check_repository(self.root)))


if __name__ == "__main__":
    unittest.main()
