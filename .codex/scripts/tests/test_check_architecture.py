from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
CHECK_SCRIPT = SCRIPTS_DIR / "check_architecture.py"
VERIFY_SCRIPT = SCRIPTS_DIR / "verify.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def write_json(path: Path, payload: object) -> None:
    write_text(path, json.dumps(payload, indent=2) + "\n")


def write_lines(path: Path, count: int) -> None:
    body = "\n".join(f"const line_{index} = {index};" for index in range(count))
    write_text(path, body + "\n")


def make_base_fixture(root: Path) -> Path:
    write_text(root / "README.md", "# Fixture\n")
    write_lines(root / "apps/core/src/domain/ok.ts", 10)
    for rel_dir in (
        "apps/core/src/adapters",
        "apps/core/src/channels",
        "apps/core/src/cli",
        "apps/core/src/control",
        "apps/core/src/infrastructure",
        "apps/core/src/runner",
        "apps/core/src/application",
        "apps/core/src/config",
        "apps/core/src/runtime",
        "apps/core/src/shared",
        "packages/contracts/src",
        "packages/sdk/src",
    ):
        write_text(root / rel_dir / "README.md", "Fixture purpose.\n")
    write_json(root / ".codex/architecture-exceptions.json", [])
    write_json(
        root / ".codex/provider-boundary-exceptions.json",
        {
            "version": 1,
            "cleanupPlanId": "test-provider-boundary-plan",
            "exceptions": [],
        },
    )
    write_json(
        root / ".codex/architecture-map.json",
        {
            "version": 1,
            "layers": {
                "domain": {
                    "paths": ["apps/core/src/domain"],
                    "allowedImportLayers": ["domain", "shared", "packages/contracts"],
                    "allowedExternalImports": [],
                },
                "application": {
                    "paths": ["apps/core/src/application"],
                    "allowedImportLayers": [
                        "domain",
                        "application",
                        "shared",
                        "packages/contracts",
                    ],
                    "allowedExternalImports": [],
                },
                "runtime": {
                    "paths": ["apps/core/src/runtime"],
                    "allowedImportLayers": [
                        "domain",
                        "application",
                        "runtime",
                        "shared",
                        "packages/contracts",
                    ],
                    "allowedExternalImports": ["node:", "crypto"],
                },
                "adapters": {
                    "paths": [
                        "apps/core/src/adapters",
                        "apps/core/src/channels",
                        "apps/core/src/cli",
                        "apps/core/src/control",
                        "apps/core/src/infrastructure",
                        "apps/core/src/runner",
                    ],
                    "allowedImportLayers": [
                        "domain",
                        "application",
                        "adapters",
                        "shared",
                        "packages/contracts",
                    ],
                    "allowedExternalImports": ["*"],
                },
                "config": {
                    "paths": ["apps/core/src/config"],
                    "allowedImportLayers": ["config", "domain", "shared", "packages/contracts"],
                    "allowedExternalImports": ["node:"],
                },
                "shared": {
                    "paths": ["apps/core/src/shared"],
                    "allowedImportLayers": ["shared", "packages/contracts"],
                    "allowedExternalImports": ["node:"],
                },
                "packages/contracts": {
                    "paths": ["packages/contracts/src"],
                    "allowedImportLayers": ["packages/contracts"],
                    "allowedExternalImports": [],
                },
                "packages/sdk": {
                    "paths": ["packages/sdk/src"],
                    "allowedImportLayers": ["packages/contracts", "packages/sdk"],
                    "allowedExternalImports": ["node:"],
                },
            },
            "approvedProviderSpecificPaths": [
                "apps/core/src/adapters/llm",
                "apps/core/src/adapters/channels",
                "apps/core/src/adapters/sandbox",
                "apps/core/src/adapters/browser",
                "apps/core/src/channels",
            ],
            "approvedProviderBoundaryPaths": [
                "apps/core/src/adapters/llm/anthropic-claude-agent"
            ],
            "providerImportSpecifiers": [
                "@anthropic-ai/sdk",
                "@anthropic-ai/claude-agent-sdk",
                "openai",
                "@google/generative-ai",
                "@google/genai",
                "@slack/bolt",
                "grammy",
                "@grammyjs/",
                "playwright",
                "dockerode",
            ],
            "providerSpecificPatterns": {
                "anthropic": "\\b(?:Anthropic|anthropic|Claude|claude)\\b",
                "slack": "\\b(?:Slack|slack)\\b",
            },
            "riskyExecutionApprovedPaths": ["apps/core/src/adapters/sandbox"],
            "browserDefaultProfilePathPatterns": [
                "Google Chrome default profile",
                "~[/\\\\]\\.config[/\\\\]google-chrome",
            ],
            "oldTermPatterns": {
                "groupFolder": "\\bgroupFolder\\b",
                "registeredGroup": "\\bregisteredGroups?\\b",
                "claude_only": "\\b(?:claude-only|Claude-only|claude only|Claude only)\\b",
            },
            "emptyFolderScanRoots": ["apps/core/src", "packages"],
        },
    )
    return root


def run_architecture_check(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(CHECK_SCRIPT),
            "--root",
            str(root),
            "--exceptions",
            ".codex/architecture-exceptions.json",
        ],
        capture_output=True,
        text=True,
    )


class CheckArchitectureTests(unittest.TestCase):
    def test_clean_fixture_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
            self.assertIn("Architecture checks passed.", result.stdout)

    def test_over_budget_file_fails_without_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/domain/oversized.ts", 701)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[File Size Budget]", result.stdout)
            self.assertIn("apps/core/src/domain/oversized.ts has 701 lines", result.stdout)

    def test_target_specific_file_size_limit_allows_postgres_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(
                root / "apps/core/src/adapters/storage/postgres/schema/schema.ts",
                900,
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_target_specific_file_size_limit_fails_above_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(
                root / "apps/core/src/adapters/storage/postgres/schema/schema.ts",
                901,
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "apps/core/src/adapters/storage/postgres/schema/schema.ts has 901 lines (limit 900)",
                result.stdout,
            )

    def test_file_line_budget_exception_is_not_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/domain/oversized.ts", 701)
            write_json(
                root / ".codex/architecture-exceptions.json",
                [
                    {
                        "file": "apps/core/src/domain/oversized.ts",
                        "rule": "file_line_budget",
                        "reason": "Fixture baseline",
                        "removeByPhase": "test-phase",
                        "max_lines": 701,
                    }
                ],
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Exception Hygiene]", result.stdout)
            self.assertIn("unsupported rule `file_line_budget`", result.stdout)
            self.assertIn("[File Size Budget]", result.stdout)

    def test_permanent_exception_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(root / "apps/core/src/runtime/index.ts", "export * from './ok.js';\n")
            write_json(
                root / ".codex/architecture-exceptions.json",
                [
                    {
                        "file": "apps/core/src/runtime/index.ts",
                        "rule": "wrapper_only_file",
                        "reason": "Fixture baseline",
                        "removeByPhase": "permanent",
                    }
                ],
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Exception Hygiene]", result.stdout)
            self.assertIn("removeByPhase must be time-bounded", result.stdout)

    def test_supported_exception_can_cap_non_line_rule(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(root / "apps/core/src/runtime/index.ts", "export * from './ok.js';\n")
            write_json(
                root / ".codex/architecture-exceptions.json",
                [
                    {
                        "file": "apps/core/src/runtime/index.ts",
                        "rule": "wrapper_only_file",
                        "reason": "Fixture baseline",
                        "removeByPhase": "test-phase",
                    }
                ],
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_forbidden_import_edge_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_lines(root / "apps/core/src/runtime/worker.ts", 5)
            write_text(
                root / "apps/core/src/domain/boundary-break.ts",
                'import { run } from "../runtime/worker";\nexport const value = run;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Layer Import Rules]", result.stdout)
            self.assertIn("domain imports runtime file apps/core/src/runtime/worker.ts", result.stdout)

    def test_enterprise_framework_import_in_runtime_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/nest-break.ts",
                'import { Injectable } from "@nestjs/common";\nexport const value = Injectable;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Framework Boundary Imports]", result.stdout)
            self.assertIn("NestJS and NextJS must integrate through SDK/control API", result.stdout)

    def test_fastify_import_outside_control_http_adapter_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/http-break.ts",
                'import Fastify from "fastify";\nexport const value = Fastify;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Framework Boundary Imports]", result.stdout)
            self.assertIn("Fastify is allowed only in the control HTTP adapter", result.stdout)

    def test_fastify_import_inside_control_http_adapter_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/adapters/control-http/server.ts",
                'import Fastify from "fastify";\nexport const value = Fastify;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_anthropic_import_outside_provider_adapter_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/model-break.ts",
                'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const value = query;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Framework Boundary Imports]", result.stdout)
            self.assertIn("Anthropic SDK imports must stay in approved provider adapter paths", result.stdout)

    def test_anthropic_provider_adapter_path_passes_provider_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/adapters/llm/anthropic-claude-agent/query-loop.ts",
                'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const value = query;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_anthropic_import_in_memory_fails_provider_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/memory/memory-llm-port.ts",
                'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const value = query;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("apps/core/src/memory/memory-llm-port.ts:1", result.stdout)
            self.assertIn("approved provider adapter boundary", result.stdout)

    def test_provider_boundary_exception_counts_are_exact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/memory/memory-llm-port.ts",
                "export const env = 'ANTHROPIC_MODEL';\n",
            )
            write_json(
                root / ".codex/provider-boundary-exceptions.json",
                {
                    "version": 1,
                    "cleanupPlanId": "test-provider-boundary-plan",
                    "exceptions": [
                        {
                            "file": "apps/core/src/memory/memory-llm-port.ts",
                            "matches": {"ANTHROPIC_": 1},
                            "reason": "Fixture baseline provider debt.",
                            "removeByPlan": "test-provider-boundary-plan",
                        }
                    ],
                },
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

            write_text(
                root / "apps/core/src/memory/memory-llm-port.ts",
                "export const env = 'ANTHROPIC_MODEL ANTHROPIC_API_KEY';\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("provider boundary exception count changed", result.stdout)

    def test_provider_boundary_detects_composed_anthropic_provider_literal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/adapters/storage/postgres/seeds.ts",
                "export const seed = { provider: `anth${'ropic'}`, kind: 'anthropic_sdk' };\n"
                "export const json = { \"provider\": \"anthropic\" };\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("provider token `provider: 'anthropic'` 2 time(s)", result.stdout)
            self.assertIn("anthropic_sdk", result.stdout)

    def test_provider_boundary_detects_anthropic_schema_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/adapters/storage/postgres/schema/agents.ts",
                "export const provider = text('provider').notNull().default('anthropic');\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("default('anthropic')", result.stdout)

    def test_provider_boundary_rejects_broad_config_memory_shared_approval(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            architecture_map = json.loads((root / ".codex/architecture-map.json").read_text())
            architecture_map["approvedProviderBoundaryPaths"] = ["apps/core/src/config"]
            write_json(root / ".codex/architecture-map.json", architecture_map)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("must not broadly approve `apps/core/src/config`", result.stdout)

    def test_provider_specific_paths_reject_broad_config_memory_shared_approval(self) -> None:
        for broad_path in [
            "apps/core/src/config",
            "apps/core/src/memory",
            "apps/core/src/shared",
        ]:
            with self.subTest(broad_path=broad_path):
                with tempfile.TemporaryDirectory() as tmp:
                    root = make_base_fixture(Path(tmp))
                    architecture_map = json.loads((root / ".codex/architecture-map.json").read_text())
                    architecture_map["approvedProviderSpecificPaths"] = [broad_path]
                    write_json(root / ".codex/architecture-map.json", architecture_map)
                    result = run_architecture_check(root)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("[Architecture Map Hygiene]", result.stdout)
                    self.assertIn(
                        f"approvedProviderSpecificPaths must not broadly approve `{broad_path}`",
                        result.stdout,
                    )

    def test_provider_boundary_rejects_runtime_approval_bypass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            architecture_map = json.loads((root / ".codex/architecture-map.json").read_text())
            architecture_map["approvedProviderBoundaryPaths"] = ["apps/core/src/runtime"]
            write_json(root / ".codex/architecture-map.json", architecture_map)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("contains unsupported path `apps/core/src/runtime`", result.stdout)

    def test_provider_boundary_empty_config_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            architecture_map = json.loads((root / ".codex/architecture-map.json").read_text())
            architecture_map["approvedProviderBoundaryPaths"] = []
            write_json(root / ".codex/architecture-map.json", architecture_map)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Boundary]", result.stdout)
            self.assertIn("must include at least one provider adapter path", result.stdout)

    def test_anthropic_llm_adapter_import_path_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/adapters/llm/anthropic-claude-agent/client.ts",
                'import Anthropic from "@anthropic-ai/sdk";\nexport const value = Anthropic;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_memory_anthropic_import_fails_provider_boundary_scan(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/memory/memory-llm-port.ts",
                'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const value = query;\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Imports]", result.stdout)
            self.assertIn(
                "apps/core/src/memory/memory-llm-port.ts:1: imports provider package",
                result.stdout,
            )

    def test_provider_import_exception_enforces_max_violations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/model-break.ts",
                'import { query } from "@anthropic-ai/claude-agent-sdk";\n'
                'import OpenAI from "openai";\n'
                "export const value = { query, OpenAI };\n",
            )
            write_json(
                root / ".codex/architecture-exceptions.json",
                [
                    {
                        "file": "apps/core/src/runtime/model-break.ts",
                        "rule": "forbidden_provider_import",
                        "reason": "Fixture baseline",
                        "removeByPhase": "test-phase",
                        "maxViolations": 1,
                    }
                ],
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Provider Imports]", result.stdout)
            self.assertIn("Exception maxViolations is 1", result.stdout)

    def test_forbidden_channel_registration_surface_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/channels/slack.ts",
                "registerChannel('slack', () => null);\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Channel Registration Surface]", result.stdout)
            self.assertIn("legacy channel self-registration API", result.stdout)

    def test_forbidden_ipc_contract_surface_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/ipc.ts",
                'import { MEMORY_IPC_ACTIONS } from "../memory/memory-ipc-contract";\n',
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[IPC Contract Surface]", result.stdout)
            self.assertIn("removed IPC contract import path", result.stdout)

    def test_forbidden_ipc_orchestrator_monolith_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/ipc.ts",
                "export async function processTaskIpc() {\n"
                "  switch (data.type) {\n"
                "    case 'scheduler_once':\n"
                "      return;\n"
                "  }\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[IPC Orchestrator]", result.stdout)
            self.assertIn("in-orchestrator task domain handler", result.stdout)

    def test_direct_provider_send_outside_channel_adapter_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/direct-send-break.ts",
                "export async function badSend(bot: any) {\n"
                "  await bot.api.sendMessage('123', 'hello');\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Direct Provider Sends]", result.stdout)
            self.assertIn("telegram bot api sendMessage", result.stdout)

    def test_direct_provider_send_alias_receivers_outside_channel_adapter_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/direct-send-alias-break.ts",
                "export async function badSendAliases(\n"
                "  client: any,\n"
                "  slackClient: any,\n"
                "  teamsClient: any,\n"
                "  telegramApi: any,\n"
                ") {\n"
                "  await client.chat.postMessage({ channel: 'C123', text: 'hello' });\n"
                "  await slackClient.chat.postMessage({ channel: 'C123', text: 'hello' });\n"
                "  await teamsClient.sendMessage('19:abc', 'hello');\n"
                "  await telegramApi.sendMessage('123', 'hello');\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Direct Provider Sends]", result.stdout)
            self.assertIn("slack chat.postMessage", result.stdout)
            self.assertIn("teams client sendMessage", result.stdout)
            self.assertIn("telegram api sendMessage", result.stdout)

    def test_direct_provider_send_inside_channel_adapter_path_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/channels/telegram/channel-delivery.ts",
                "export async function okSend(bot: any) {\n"
                "  await bot.api.sendMessage('123', 'hello');\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_recovery_channel_wiring_send_outside_runtime_services_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/recovery-send-break.ts",
                "export async function bad(channelWiring: any) {\n"
                "  await channelWiring.sendProviderMessage('tg:1', 'hello', {});\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Direct Provider Sends]", result.stdout)
            self.assertIn("recovery-only channel wiring call", result.stdout)

    def test_recovery_channel_wiring_send_inside_runtime_services_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/app/bootstrap/runtime-services.ts",
                "export async function ok(channelWiring: any) {\n"
                "  const permit = channelWiring.createRecoveryDispatchPermit({});\n"
                "  await channelWiring.sendProviderMessage('tg:1', 'hello', { permit });\n"
                "}\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_stale_doc_reference_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(root / "README.md", "[Missing](docs/not-real.md)\n")
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Active Doc References]", result.stdout)
            self.assertIn("README.md -> docs/not-real.md", result.stdout)

    def test_direct_risky_execution_outside_sandbox_adapter_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/run.ts",
                "import { spawn } from 'child_process';\nspawn('echo', ['hi']);\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Direct Risky Execution]", result.stdout)
            self.assertIn("must go through an approved sandbox adapter", result.stdout)

    def test_browser_default_profile_path_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/browser.ts",
                "export const profile = '~/Library/Application Support/Google/Chrome';\n",
            )
            write_json(
                root / ".codex/architecture-map.json",
                {
                    **json.loads((root / ".codex/architecture-map.json").read_text()),
                    "browserDefaultProfilePathPatterns": [
                        "~[/\\\\]Library[/\\\\]Application Support[/\\\\]Google[/\\\\]Chrome"
                    ],
                },
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Browser Default Profile Paths]", result.stdout)

    def test_old_architecture_term_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/legacy.ts",
                "export const groupFolder = 'legacy';\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Old Architecture Terms]", result.stdout)
            self.assertIn("old_term_groupFolder", result.stdout)

    def test_wrapper_only_file_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(
                root / "apps/core/src/runtime/index.ts",
                "export * from './ok.js';\n",
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Wrapper-Only Files]", result.stdout)

    def test_empty_folder_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            (root / "apps/core/src/runtime/empty").mkdir(parents=True)
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Empty Folders]", result.stdout)

    def test_malformed_exception_missing_remove_by_phase_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = make_base_fixture(Path(tmp))
            write_text(root / "apps/core/src/runtime/index.ts", "export * from './ok.js';\n")
            write_json(
                root / ".codex/architecture-exceptions.json",
                [
                    {
                        "file": "apps/core/src/runtime/index.ts",
                        "rule": "wrapper_only_file",
                        "reason": "Fixture baseline",
                    }
                ],
            )
            result = run_architecture_check(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("[Exception Hygiene]", result.stdout)
            self.assertIn("missing required fields: removeByPhase", result.stdout)


class VerifyContractTests(unittest.TestCase):
    def test_verify_print_only_includes_architecture_and_runtime_truth_phases(
        self,
    ) -> None:
        result = subprocess.run(
            [sys.executable, str(VERIFY_SCRIPT), "--print-only"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        phases = [line.split(":", 1)[0] for line in result.stdout.splitlines() if ":" in line]
        self.assertIn("architecture", phases)
        self.assertIn("runtime-truth", phases)
        self.assertIn("build", phases)
        self.assertIn("e2e", phases)
        self.assertLess(phases.index("structural"), phases.index("architecture"))
        self.assertLess(phases.index("structural"), phases.index("build"))
        self.assertLess(phases.index("architecture"), phases.index("runtime-truth"))
        self.assertLess(phases.index("runtime-truth"), phases.index("factory-python-tests"))
        self.assertLess(phases.index("factory-python-tests"), phases.index("typecheck"))
        self.assertLess(phases.index("tests"), phases.index("e2e"))


if __name__ == "__main__":
    unittest.main()
