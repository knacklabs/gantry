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

    def _governance_fixture(self) -> None:
        self._fixture()
        engineering = self.root / "docs" / "engineering"
        engineering.mkdir(parents=True)
        (engineering / "README.md").write_text(
            "\n".join(f"[{name}]({name})" for name in checker.ENGINEERING_POLICIES),
            encoding="utf-8",
        )
        policy = (
            "**Mechanical:** checked\n\n"
            "**Review:** reviewed\n\n"
            "**Recommendation:** recommended\n"
        )
        for name in checker.ENGINEERING_POLICIES:
            text = policy
            if name == "documentation.md":
                text += "\n".join((
                    "docs/engineering/",
                    "docs/architecture/",
                    "docs/decisions/",
                    "plans/active/",
                    "plans/completed/",
                ))
            (engineering / name).write_text(text, encoding="utf-8")

        architecture = self.root / "docs" / "architecture"
        architecture.mkdir(exist_ok=True)
        (architecture / "README.md").write_text("# Current architecture\n", encoding="utf-8")

        decisions = self.root / "docs" / "decisions"
        decisions.mkdir()
        (decisions / "0001-current.md").write_text(
            "---\nstatus: accepted\nconfirmed_by: human\n---\n# Current\n",
            encoding="utf-8",
        )

        completed = self.root / "plans" / "completed"
        completed.mkdir(parents=True)
        (completed / "done.md").write_text(
            "---\nissue: TEST-1\ntitle: Done\nstatus: completed\n---\n# Done\n",
            encoding="utf-8",
        )
        (self.root / "package.json").write_text(json.dumps({
            "name": "@gantry/runtime",
            "homepage": checker.CANONICAL_REPOSITORY,
            "bugs": {"url": f"{checker.CANONICAL_REPOSITORY}/issues"},
            "repository": {"url": f"git+{checker.CANONICAL_REPOSITORY}.git"},
            "packageManager": "npm@11.16.0",
            "engines": {"node": ">=24 <26"},
        }), encoding="utf-8")
        inventory_records = [
            {
                "path": "docs/decisions/0001-current.md",
                "category": "architecture-decision",
                "lifecycle": "accepted",
                "authority": "accepted-decision",
                "intendedAction": "retain-until-superseded",
            },
            {
                "path": "plans/completed/done.md",
                "category": "execution-plan",
                "lifecycle": "completed",
                "authority": "historical-outcome",
                "intendedAction": "retain-as-completion-record",
            },
        ]
        (self.root / "docs" / "documentation-inventory.json").write_text(json.dumps({
            "schemaVersion": 1,
            "sourceRoots": ["docs/decisions", "plans/completed"],
            "counts": {"architecture-decision": 1, "execution-plan": 1},
            "records": inventory_records,
        }), encoding="utf-8")

    def test_valid_governance_fixture_passes(self) -> None:
        self._governance_fixture()
        self.assertEqual(checker.check_repository(self.root), [])

    def test_unclassified_governed_record_is_reported(self) -> None:
        self._governance_fixture()
        (self.root / "docs" / "decisions" / "0002-new.md").write_text(
            "---\nstatus: proposed\nconfirmed_by: \"\"\n---\n# New\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "unclassified governed record" in error
            for error in checker.check_repository(self.root)
        ))

    def test_inventory_count_drift_is_reported(self) -> None:
        self._governance_fixture()
        inventory_path = self.root / "docs" / "documentation-inventory.json"
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        inventory["counts"]["architecture-decision"] = 2
        inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
        self.assertTrue(any(
            "counts do not match" in error
            for error in checker.check_repository(self.root)
        ))

    def test_missing_engineering_policy_is_reported(self) -> None:
        self._governance_fixture()
        (self.root / "docs" / "engineering" / checker.ENGINEERING_POLICIES[0]).unlink()
        self.assertTrue(any(
            "missing required engineering policy" in error
            for error in checker.check_repository(self.root)
        ))

    def test_missing_rule_classification_is_reported(self) -> None:
        self._governance_fixture()
        policy = self.root / "docs" / "engineering" / checker.ENGINEERING_POLICIES[0]
        policy.write_text("**Mechanical:** checked\n", encoding="utf-8")
        errors = checker.check_repository(self.root)
        self.assertTrue(any("missing **Review:**" in error for error in errors))

    def test_invalid_decision_lifecycle_is_reported(self) -> None:
        self._governance_fixture()
        decision = self.root / "docs" / "decisions" / "0001-current.md"
        decision.write_text("---\nstatus: retired\n---\n# Retired\n", encoding="utf-8")
        self.assertTrue(any(
            "invalid decision status" in error
            for error in checker.check_repository(self.root)
        ))

    def test_missing_decision_supersession_target_is_reported(self) -> None:
        self._governance_fixture()
        decision = self.root / "docs" / "decisions" / "0001-current.md"
        decision.write_text(
            "---\nstatus: superseded\nsuperseded_by: 0002-missing\n---\n# Old\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "superseded_by target does not exist" in error
            for error in checker.check_repository(self.root)
        ))

    def test_invalid_plan_lifecycle_is_reported(self) -> None:
        self._governance_fixture()
        plan = self.root / "plans" / "completed" / "done.md"
        plan.write_text(
            "---\nissue: TEST-1\ntitle: Done\nstatus: shipped\n---\n# Done\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "invalid plan status" in error
            for error in checker.check_repository(self.root)
        ))

    def test_plan_missing_issue_metadata_is_reported(self) -> None:
        self._governance_fixture()
        plan = self.root / "plans" / "completed" / "done.md"
        plan.write_text(
            "---\ntitle: Done\nstatus: completed\n---\n# Done\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "plan lifecycle metadata is missing issue" in error
            for error in checker.check_repository(self.root)
        ))

    def test_missing_taxonomy_location_is_reported(self) -> None:
        self._governance_fixture()
        governance = self.root / "docs" / "engineering" / "documentation.md"
        governance.write_text(
            governance.read_text(encoding="utf-8").replace("plans/completed/", ""),
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing taxonomy location plans/completed/" in error
            for error in checker.check_repository(self.root)
        ))

    def test_historical_architecture_index_entry_is_reported(self) -> None:
        self._governance_fixture()
        architecture = self.root / "docs" / "architecture"
        (architecture / "old-goal-prompt.md").write_text("# Old\n", encoding="utf-8")
        (architecture / "README.md").write_text(
            "[Old](old-goal-prompt.md)\n", encoding="utf-8"
        )
        self.assertTrue(any(
            "historical work record" in error
            for error in checker.check_repository(self.root)
        ))

    def test_repository_identity_drift_is_reported(self) -> None:
        self._governance_fixture()
        manifest = json.loads((self.root / "package.json").read_text(encoding="utf-8"))
        manifest["homepage"] = "https://example.invalid/fork"
        (self.root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertTrue(any(
            "canonical homepage" in error
            for error in checker.check_repository(self.root)
        ))

    def test_valid_fixture_passes(self) -> None:
        self._fixture()
        self.assertEqual(checker.check_repository(self.root), [])

    def test_broken_link_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text("[Missing](missing.md)\n", encoding="utf-8")
        self.assertTrue(any("broken local link" in error for error in checker.check_repository(self.root)))

    def test_valid_markdown_heading_fragment_passes(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text(
            "[Evidence policy](source-evidence.md#evidence-policy)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_invalid_markdown_heading_fragment_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text(
            "[Missing section](source-evidence.md#missing-section)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#missing-section" in error
            for error in checker.check_repository(self.root)
        ))

    def test_setext_markdown_heading_fragment_passes(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\nSetext section\n--------------\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Setext section](source-evidence.md#setext-section)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_duplicate_heading_slug_avoids_natural_suffix_collision(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\n# Foo\n# Foo-1\n# Foo\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Third Foo](source-evidence.md#foo-2)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_in_markdown_containers_produces_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\n> - ## Nested evidence\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Nested evidence](source-evidence.md#nested-evidence)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_ordered_list_continuation_heading_and_html_id_produce_fragments(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n10. item\n\n    ## Nested section\n    <span id="nested-id"></span>\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Nested section](source-evidence.md#nested-section)\n"
            "[Nested ID](source-evidence.md#nested-id)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_slug_uses_rendered_link_text_and_decoded_entity(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n## [Evidence policy](source-evidence.md) &amp; ownership\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Policy ownership](source-evidence.md#evidence-policy--ownership)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_in_raw_html_blocks_is_not_a_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n<!--\n# Retired section\n-->\n"
            + "<pre>\n# Example section\n</pre>\n\n"
            + "<xmp>\n# Legacy section\n</xmp>\n\n"
            + "<div>\n# Raw block section\n</div>\n\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Retired](source-evidence.md#retired-section)\n"
            "[Example](source-evidence.md#example-section)\n"
            "[Legacy](source-evidence.md#legacy-section)\n"
            "[Raw block](source-evidence.md#raw-block-section)\n",
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertTrue(any("#retired-section" in error for error in errors))
        self.assertTrue(any("#example-section" in error for error in errors))
        self.assertTrue(any("#legacy-section" in error for error in errors))
        self.assertTrue(any("#raw-block-section" in error for error in errors))

    def test_heading_slug_preserves_autolink_and_code_span_text(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n## API <https://example.com> and `<tag_name>`\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[API](source-evidence.md#api-httpsexamplecom-and-tag_name)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_slug_renders_underscore_emphasis_but_preserves_intraword_underscore(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n## _Evidence policy_ for agent_name\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Policy](source-evidence.md#evidence-policy-for-agent_name)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_slug_preserves_unicode_combining_marks(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\n## नमस्ते\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Greeting](source-evidence.md#नमस्ते)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_heading_slug_uses_exact_github_slugger_punctuation_policy(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\n## Foo·Bar\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Middle dot](source-evidence.md#foobar)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_fenced_html_id_does_not_create_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + '\n```html\n<section id="example"></section>\n```\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Example](source-evidence.md#example)\n",
            encoding="utf-8",
        )
        self.assertTrue(any("missing local fragment" in error for error in checker.check_repository(self.root)))

    def test_container_fenced_code_does_not_create_fragments(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n> ```html\n> # Ghost heading\n> <span id="ghost-id"></span>\n> ```\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Ghost heading](source-evidence.md#ghost-heading)\n"
            "[Ghost ID](source-evidence.md#ghost-id)\n",
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertTrue(any("#ghost-heading" in error for error in errors))
        self.assertTrue(any("#ghost-id" in error for error in errors))

    def test_unclosed_container_fence_does_not_hide_outer_heading(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n> ```text\n> quoted code\n# Real heading\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Real](source-evidence.md#real-heading)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_fence_with_trailing_text_does_not_close_block(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n```text\n``` not a closing fence\n# Still code\n```\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Still code](source-evidence.md#still-code)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "#still-code" in error for error in checker.check_repository(self.root)
        ))

    def test_container_looking_fence_content_does_not_close_root_fence(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + "\n```text\n> ```\n# Ghost root heading\n```\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Ghost](source-evidence.md#ghost-root-heading)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "#ghost-root-heading" in error for error in checker.check_repository(self.root)
        ))

    def test_ordered_list_continuation_fence_does_not_create_fragments(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n10. item\n\n    ```html\n    # Ghost list heading\n'
            + '    <span id="ghost-list-id"></span>\n    ```\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Ghost heading](source-evidence.md#ghost-list-heading)\n"
            "[Ghost ID](source-evidence.md#ghost-list-id)\n",
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertTrue(any("#ghost-list-heading" in error for error in errors))
        self.assertTrue(any("#ghost-list-id" in error for error in errors))

    def test_inline_and_indented_code_html_ids_do_not_create_fragments(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n`<span id="inline-example">`\n\n    <section id="indented-example"></section>\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Inline](source-evidence.md#inline-example)\n"
            "[Indented](source-evidence.md#indented-example)\n",
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertTrue(any("#inline-example" in error for error in errors))
        self.assertTrue(any("#indented-example" in error for error in errors))

    def test_multiline_code_span_html_id_does_not_create_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n`code starts\n<span id="multiline-code"></span>\ncode ends`\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Multiline code](source-evidence.md#multiline-code)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "#multiline-code" in error for error in checker.check_repository(self.root)
        ))

    def test_container_indented_code_html_id_does_not_create_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n>     <span id="quoted-code"></span>\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Quoted code](source-evidence.md#quoted-code)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "#quoted-code" in error for error in checker.check_repository(self.root)
        ))

    def test_raw_text_content_id_is_not_anchor_but_element_id_is(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8")
            + '\n<xmp id="real-xmp"><span id="ghost"></span></xmp>\n',
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Real](source-evidence.md#real-xmp)\n"
            "[Ghost](source-evidence.md#ghost)\n",
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertFalse(any("#real-xmp" in error for error in errors))
        self.assertTrue(any("#ghost" in error for error in errors))

    def test_valid_html_id_fragment_passes(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#details">Details</a><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_html_fragment_resolves_against_first_base_href(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><base href="details.html"><a href="#details">Details</a>',
            encoding="utf-8",
        )
        (self.atlas / "details.html").write_text(
            '<!doctype html><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_implicit_html_top_fragment_passes_case_insensitively(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#TOP">Top</a>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_implicit_markdown_top_fragment_passes(self) -> None:
        self._fixture()
        (self.atlas / "README.md").write_text(
            "[Back to top](source-evidence.md#top)\n",
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_list_followed_by_thematic_break_does_not_create_setext_fragment(self) -> None:
        self._fixture()
        manifest = self.atlas / "source-evidence.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8") + "\n- Not a heading\n---\n",
            encoding="utf-8",
        )
        (self.atlas / "README.md").write_text(
            "[Not a heading](source-evidence.md#not-a-heading)\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            "#not-a-heading" in error for error in checker.check_repository(self.root)
        ))

    def test_invalid_html_id_fragment_is_reported(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#missing">Missing</a><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#missing" in error
            for error in checker.check_repository(self.root)
        ))

    def test_html_raw_text_content_id_is_not_a_fragment(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#ghost">Ghost</a>'
            '<textarea><span id="ghost"></span></textarea>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#ghost" in error
            for error in checker.check_repository(self.root)
        ))

    def test_html_title_content_id_is_not_a_fragment(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#ghost">Ghost</a>'
            '<title><span id="ghost"></span></title>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#ghost" in error
            for error in checker.check_repository(self.root)
        ))

    def test_html_noscript_and_template_content_ids_are_not_fragments(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#noscript-ghost">Ghost</a>'
            '<a href="#template-ghost">Ghost</a>'
            '<noscript><span id="noscript-ghost"></span></noscript>'
            '<template><span id="template-ghost"></span></template>',
            encoding="utf-8",
        )
        errors = checker.check_repository(self.root)
        self.assertTrue(any("#noscript-ghost" in error for error in errors))
        self.assertTrue(any("#template-ghost" in error for error in errors))

    def test_nested_template_content_id_is_not_a_fragment(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#ghost">Ghost</a>'
            '<template><template></template><span id="ghost"></span></template>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#ghost" in error
            for error in checker.check_repository(self.root)
        ))

    def test_raw_text_start_tag_text_does_not_nest_parser_state(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#details">Details</a>'
            '<textarea><textarea></textarea><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_self_closing_syntax_on_nonvoid_inert_element_stays_inert(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#ghost">Ghost</a>'
            '<textarea/><span id="ghost"></span>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#ghost" in error
            for error in checker.check_repository(self.root)
        ))

    def test_rcdata_comment_text_does_not_swallow_matching_end_tag(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#details">Details</a>'
            '<textarea><!-- </textarea> --><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_raw_text_tag_inside_html_comment_does_not_hide_following_anchor(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#details">Details</a>'
            '<!-- <script> --><section id="details"></section>',
            encoding="utf-8",
        )
        self.assertEqual(checker.check_repository(self.root), [])

    def test_unclosed_html_raw_text_content_id_is_not_a_fragment(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#ghost">Ghost</a>'
            '<textarea><span id="ghost"></span>',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#ghost" in error
            for error in checker.check_repository(self.root)
        ))

    def test_non_anchor_html_name_attribute_is_not_a_fragment(self) -> None:
        self._fixture()
        (self.atlas / "guide.html").write_text(
            '<!doctype html><a href="#viewport">Viewport</a><meta name="viewport">',
            encoding="utf-8",
        )
        self.assertTrue(any(
            "missing local fragment" in error and "#viewport" in error
            for error in checker.check_repository(self.root)
        ))

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

    def test_changed_public_architecture_document_is_scanned(self) -> None:
        self._fixture()
        docs = self.root / "docs"
        architecture = docs / "architecture"
        architecture.mkdir(parents=True, exist_ok=True)
        (docs / "index.html").write_text("<!doctype html><title>Docs</title>", encoding="utf-8")
        (architecture / "deployment-profiles.md").write_text(
            "Local output: /Users/example/deployment\n",
            encoding="utf-8",
        )
        self.assertTrue(any(
            error.startswith("docs/architecture/deployment-profiles.md:")
            and "prohibited local reference" in error
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
