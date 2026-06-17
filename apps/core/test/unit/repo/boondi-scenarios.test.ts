import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type ScenarioTurn = {
  text?: unknown;
  expect?: Record<string, unknown>;
};

type BoondiScenario = {
  name?: unknown;
  phone?: unknown;
  testIntent?: unknown;
  turns?: unknown;
  expect?: Record<string, unknown>;
};

const baselineExpectationKeys = [
  'noBanned',
  'noLeak',
  'noNarration',
  'replyRequired',
];

const scenariosPath = path.join(process.cwd(), 'scripts/boondi-scenarios.json');
const regressionRunnerPath = path.join(
  process.cwd(),
  'scripts/boondi-regression.mjs',
);
const isolationRunnerPath = path.join(
  process.cwd(),
  'scripts/boondi-isolation.mjs',
);
const runtimeSmokePath = path.join(
  process.cwd(),
  'scripts/boondi-runtime-smoke.mjs',
);
const runtimeStackPath = path.join(
  process.cwd(),
  'scripts/boondi-runtime-stack.sh',
);
const packageJsonPath = path.join(process.cwd(), 'package.json');
const testSetupPath = path.join(process.cwd(), 'scripts/boondi-test-setup.sh');
const phonesModulePath = path.join(process.cwd(), 'scripts/lib/phones.mjs');
const boondiPromptPath = path.join(
  process.cwd(),
  'agents/boondi_support/CLAUDE.md',
);

function loadScenarios(): BoondiScenario[] {
  const cfg = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8')) as {
    scenarios?: unknown;
  };
  expect(Array.isArray(cfg.scenarios)).toBe(true);
  return cfg.scenarios as BoondiScenario[];
}

describe('Boondi regression scenarios', () => {
  it('keeps every scenario documented with an explicit test intent', () => {
    const missingIntent = loadScenarios()
      .filter(
        (scenario) =>
          typeof scenario.testIntent !== 'string' ||
          scenario.testIntent.trim() === '',
      )
      .map((scenario) => scenario.name);

    expect(missingIntent).toEqual([]);
  });

  it('keeps every test intent behavior-specific instead of boilerplate', () => {
    const genericIntents = loadScenarios()
      .filter(
        (scenario) =>
          typeof scenario.testIntent === 'string' &&
          /^Proves Boondi handles\b/.test(scenario.testIntent),
      )
      .map((scenario) => scenario.name);

    expect(genericIntents).toEqual([]);
  });

  it('keeps all scenario turns in object form with optional non-empty expectations', () => {
    const primitiveTurns = loadScenarios().flatMap((scenario) =>
      Array.isArray(scenario.turns)
        ? scenario.turns
            .map((turn, index) => ({ scenario: scenario.name, turn, index }))
            .filter(
              ({ turn }) =>
                turn === null ||
                typeof turn !== 'object' ||
                Array.isArray(turn),
            )
            .map(
              ({ scenario, index }) => `${String(scenario)} turn ${index + 1}`,
            )
        : [`${String(scenario.name)} has non-array turns`],
    );

    expect(primitiveTurns).toEqual([]);
    const emptyExpectBlocks: string[] = [];
    for (const scenario of loadScenarios()) {
      for (const turn of scenario.turns as ScenarioTurn[]) {
        expect(typeof turn.text).toBe('string');
        expect((turn.text as string).trim()).not.toBe('');
        if (turn.expect !== undefined) {
          expect(turn.expect && typeof turn.expect === 'object').toBe(true);
          expect(Array.isArray(turn.expect)).toBe(false);
          if (Object.keys(turn.expect).length === 0) {
            emptyExpectBlocks.push(
              `${String(scenario.name)} turn ${turn.text}`,
            );
          }
        }
      }
    }
    expect(emptyExpectBlocks).toEqual([]);
  });

  it('allows omitted turn expectations because the runner applies defaults', () => {
    const scenarios = loadScenarios();
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');
    const omittedTurnExpectations = scenarios.flatMap((scenario) =>
      Array.isArray(scenario.turns)
        ? scenario.turns
            .map((turn, index) => ({
              scenario: scenario.name,
              turn: turn as ScenarioTurn,
              index,
            }))
            .filter(({ turn }) => turn.expect === undefined)
            .map(
              ({ scenario, index }) => `${String(scenario)} turn ${index + 1}`,
            )
        : [],
    );

    expect(omittedTurnExpectations.length).toBeGreaterThan(0);
    expect(runner).toContain(
      'for (const f of evaluate(turnsEvents[i] || [], turn.expect, cfg).failures)',
    );
    expect(runner).toContain(
      'const exp = { ...DEFAULT_EXPECT, ...(expect || {}) };',
    );
    expect(runner).not.toContain('if (!turn.expect) return;');
  });

  it('keeps scenario phones unique and reserved to the 000000001-000000059 fake range', () => {
    const phones = loadScenarios().map((scenario) => scenario.phone);

    expect(phones).toEqual(
      Array.from({ length: 59 }, (_, index) =>
        String(index + 1).padStart(9, '0'),
      ),
    );
    expect(new Set(phones).size).toBe(phones.length);
  });

  it('parses operator phone allowlists without punctuation or empty tokens', async () => {
    const phonesModule = (await import(
      pathToFileURL(phonesModulePath).href
    )) as {
      phonesFromEnvValue: (value: string) => Set<string>;
    };

    expect([
      ...phonesModule.phonesFromEnvValue(
        ' 000000001, +91-99000-00002\n\n000000003 ',
      ),
    ]).toEqual(['000000001', '919900000002', '000000003']);
    expect([...phonesModule.phonesFromEnvValue(' , \n\t ')]).toEqual([]);
  });

  it('allows 000-prefixed fake phones when an operator phone is configured', async () => {
    const oldHome = process.env.GANTRY_HOME;
    const oldOperatorPhones = process.env.GANTRY_TEST_OPERATOR_PHONE;
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-boondi-phones-'),
    );
    try {
      delete process.env.GANTRY_TEST_OPERATOR_PHONE;
      process.env.GANTRY_HOME = runtimeHome;
      fs.writeFileSync(
        path.join(runtimeHome, '.env'),
        ['OTHER_KEY=ignored', 'GANTRY_TEST_OPERATOR_PHONE="919654405340"'].join(
          '\n',
        ),
      );

      const phonesModule = (await import(
        `${pathToFileURL(phonesModulePath).href}?home=${encodeURIComponent(runtimeHome)}`
      )) as {
        ALL_TEST_PHONES: string[];
        OPERATOR_LIST: string;
        configuredOperatorPhones: () => Set<string>;
        isAllowedTestPhone: (phone: string) => boolean;
      };

      expect(phonesModule.configuredOperatorPhones()).toEqual(
        new Set(['919654405340']),
      );
      expect(phonesModule.ALL_TEST_PHONES).toContain('000000059');
      expect(phonesModule.ALL_TEST_PHONES).toContain('000000901');
      expect(phonesModule.OPERATOR_LIST.split(',')).toEqual(
        expect.arrayContaining(['000000001', '000000059', '919654405340']),
      );
      expect(phonesModule.isAllowedTestPhone('000-000-999')).toBe(true);
      expect(phonesModule.isAllowedTestPhone('919654405340')).toBe(true);
      expect(phonesModule.isAllowedTestPhone('919999999999')).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = oldHome;
      if (oldOperatorPhones === undefined)
        delete process.env.GANTRY_TEST_OPERATOR_PHONE;
      else process.env.GANTRY_TEST_OPERATOR_PHONE = oldOperatorPhones;
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('keeps baseline reply hygiene as runner defaults instead of repeated scenario keys', () => {
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');
    const repeatedBaselineKeys = loadScenarios().flatMap((scenario) => {
      const scenarioKeys = Object.keys(scenario.expect ?? {})
        .filter((key) => baselineExpectationKeys.includes(key))
        .map((key) => `${String(scenario.name)} scenario.expect.${key}`);
      const turnKeys = Array.isArray(scenario.turns)
        ? scenario.turns.flatMap((turn, index) =>
            Object.keys((turn as ScenarioTurn).expect ?? {})
              .filter((key) => baselineExpectationKeys.includes(key))
              .map(
                (key) =>
                  `${String(scenario.name)} turn ${index + 1}.expect.${key}`,
              ),
          )
        : [];
      return [...scenarioKeys, ...turnKeys];
    });

    expect(repeatedBaselineKeys).toEqual([]);
    for (const key of baselineExpectationKeys) {
      expect(runner).toContain(`${key}: true`);
    }
    expect(runner).toContain(
      'const exp = { ...DEFAULT_EXPECT, ...(expect || {}) };',
    );
    expect(runner).not.toContain('missing expect');
    expect(runner).not.toContain('if (!turn.expect) return;');
  });

  it('guards substantive shopping flows against returning-greeting CRM lookups', () => {
    const scenarios = loadScenarios();
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');
    const shoppingFlow = scenarios.find(
      (scenario) => scenario.name === 'qualified-gifting-product-options',
    );

    expect(shoppingFlow?.expect?.mcpMustNotCall).toEqual(
      expect.arrayContaining([
        {
          serverName: 'boondi-crm',
          toolName: 'get_open_records',
        },
      ]),
    );
    expect(runner).toContain('if (exp.mcpMustNotCall)');
    expect(runner).toContain('forbidden MCP call observed');
  });

  it('keeps open CRM lookup reserved to bare returning greetings in Boondi guidance', () => {
    const prompt = fs.readFileSync(boondiPromptPath, 'utf-8');

    expect(prompt).toContain(
      'Use `get_open_records` only for a bare returning greeting',
    );
    expect(prompt).toContain(
      'Do not call `get_open_records` for substantive order, product, or gifting turns',
    );
  });

  it('guards qualified gifting recommendation flows against product-search fanout', () => {
    const scenarios = loadScenarios();
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');
    const giftingFlow = scenarios.find(
      (scenario) => scenario.name === 'qualified-gifting-product-options',
    );

    expect(giftingFlow?.expect?.mcpMaxCallCount).toEqual(
      expect.arrayContaining([
        {
          serverName: 'shopify-api',
          toolName: 'search_products',
          max: 1,
        },
      ]),
    );
    expect(runner).toContain('if (exp.mcpMaxCallCount)');
    expect(runner).toContain('expected at most');
  });

  it('routes qualified gifting recommendation flows through the aggregate Shopify tool', () => {
    const scenarios = loadScenarios();
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');
    const giftingFlow = scenarios.find(
      (scenario) => scenario.name === 'qualified-gifting-product-options',
    );

    expect(giftingFlow?.expect?.mcpMustCall).toEqual([
      {
        serverName: 'shopify-api',
        toolName: 'get_gifting_context',
      },
    ]);
    expect(giftingFlow?.expect?.mcpMustNotCall).toEqual(
      expect.arrayContaining([
        {
          serverName: 'shopify-api',
          toolName: 'get_recent_orders_with_details',
        },
        {
          serverName: 'shopify-api',
          toolName: 'search_products',
        },
      ]),
    );
    expect(runner).toContain('if (exp.mcpMustCall)');
    expect(runner).toContain('expected MCP call');
  });

  it('requires Boondi to surface latest order data from qualified gifting context', () => {
    const prompt = fs.readFileSync(boondiPromptPath, 'utf-8');
    const scenarios = loadScenarios();
    const giftingFlow = scenarios.find(
      (scenario) => scenario.name === 'qualified-gifting-product-options',
    );

    expect(prompt).toContain(
      'If `latestOrder` is returned, mention `latestOrder.name` explicitly',
    );
    expect(prompt).toContain(
      'Do not say order details are unavailable when `latestOrder` is present',
    );
    expect(prompt).toContain(
      'An empty `products` array is not a live-data failure when `latestOrder` is',
    );
    expect(prompt).toContain(
      'present; mention the latest order, then say the gifting team will curate options',
    );
    expect(prompt).toContain(
      'Never use hiccup or live-data-unavailable wording after a successful',
    );
    expect(prompt).toContain(
      '`get_gifting_context` result containing `latestOrder`',
    );
    expect(prompt).toContain('If `products` is empty,');
    expect(prompt).toContain(
      'say product curation is team-owned and the gifting team will curate',
    );
    expect(prompt).not.toContain('No live product matches');
    expect(prompt).not.toContain('no live product matches');
    expect(prompt).toContain(
      'If `answerGuidance` is returned, follow it as the authoritative reply plan',
    );
    expect(prompt).toContain(
      'If `replyContract.useCustomerReplyDraft` is true',
    );
    expect(prompt).toContain(
      'do not reply unless the customer-visible answer includes `replyContract.mustMentionLatestOrderName`',
    );
    expect(prompt).toContain(
      'If `customerReplyDraft` is returned, base the customer reply on it and do not',
    );
    expect(prompt).toContain('contradict it.');
    expect(giftingFlow?.expect?.replyMustMatch).toContain(
      'last order|latest order|most recent order|Order:',
    );
  });

  it('requires explicit phone lookups to reach Shopify before privacy denial', () => {
    const prompt = fs.readFileSync(boondiPromptPath, 'utf-8');

    expect(prompt).toContain(
      'You cannot infer whether an explicit phone, email, or order number belongs to the customer from the visible chat text alone',
    );
    expect(prompt).toContain(
      'Never answer an explicit phone, email, or order lookup with the privacy denial before a Shopify MCP call',
    );
  });

  it('requires return and refund asks to check the customer order before handoff', () => {
    const prompt = fs.readFileSync(boondiPromptPath, 'utf-8');

    expect(prompt).toContain(
      'For return, refund, stale, damaged, missing, or wrong-item asks about the',
    );
    expect(prompt).toContain(
      'customer order, call `get_recent_orders_with_details` first',
    );
  });

  it('keeps transient tool-error wording free of lookup narration', () => {
    const prompt = fs.readFileSync(boondiPromptPath, 'utf-8');

    expect(prompt).toMatch(/I'm having a small\s+hiccup with that right now/);
    expect(prompt).toContain(
      'Never say "I will look it up", "I will pull it up", "I will check it", "fetching", "searching", "one moment", or similar lookup narration in a customer-visible reply',
    );
    expect(prompt).toContain(
      'If any Shopify tool returns `replyContract.useCustomerReplyDraft: true`, adapt `customerReplyDraft` directly',
    );
    expect(prompt).toContain(
      'Do not use hiccup wording after a Shopify tool returns a successful `replyContract`',
    );
    expect(prompt).not.toContain('pulling that up');
    expect(prompt).not.toContain('pulling live');
  });

  it('preserves admin-visible scenario transcripts by default', () => {
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');

    expect(runner).toContain(
      "const FORCE_SESSION_RESET = process.env.BOONDI_SESSION_RESET === '1';",
    );
    expect(runner).toContain(
      "const TEARDOWN_RESET = process.env.BOONDI_TEARDOWN_RESET === '1';",
    );
    expect(runner).toContain(
      'setupReset: FORCE_SESSION_RESET || !dbResetSucceeded',
    );
    expect(runner).toContain('teardownReset: TEARDOWN_RESET');
    expect(runner).not.toContain(
      'Non-CRM groups reset only to free the warm session.',
    );
  });

  it('keeps Boondi regression idle timeout configurable for warm-retention checks', () => {
    const setupScript = fs.readFileSync(testSetupPath, 'utf-8');

    expect(setupScript).toContain(
      'IDLE_TIMEOUT_MS=${BOONDI_TEST_IDLE_TIMEOUT_MS:-2500}',
    );
    expect(setupScript).toContain('runtime.runner.idle_timeout_ms');
    expect(setupScript).not.toContain('IDLE_TIMEOUT="$IDLE_TIMEOUT_MS"');
  });

  it('starts local Boondi services so they survive setup script exit', () => {
    const setupScript = fs.readFileSync(testSetupPath, 'utf-8');

    expect(setupScript.match(/nohup env \$STRIP/g)).toHaveLength(2);
    expect(setupScript.match(/< \/dev\/null & disown \)/g)).toHaveLength(2);
  });

  it('requires visible replies and bounds live-flow concurrency by default', () => {
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');

    expect(runner).toContain(
      'const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180_000);',
    );
    expect(runner).toContain('replyRequired: true');
    expect(runner).toContain(
      "failures.push('expected a customer-visible reply, none seen');",
    );
    expect(runner).toContain('const LIVE_FLOW_CONCURRENCY = Number(');
    expect(runner).toContain(
      'await mapPool(liveFlow, LIVE_FLOW_CONCURRENCY, async (scenario) => {',
    );
    expect(runner).not.toContain(
      'liveFlow.forEach((s, i) => queues[i % LANE_PHONES.length].push(s));',
    );
  });

  it('does not finish a live turn on an empty LLM output from a retryable agent failure', () => {
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');

    expect(runner).toContain('const isNonEmptyLlmOutput = (e) =>');
    expect(runner).toContain(
      "e.flow === 'llm.output' && typeof e.reply === 'string' && e.reply.trim()",
    );
    expect(runner).not.toContain("events.some((e) => e.flow === 'llm.output')");
  });

  it('waits long enough for concurrent isolation replies by default', () => {
    const runner = fs.readFileSync(isolationRunnerPath, 'utf-8');

    expect(runner).toContain(
      'const SETTLE_MS = Number(process.env.ISOLATION_SETTLE_MS || 180_000);',
    );
  });

  it('keeps a basic runtime smoke separate from Boondi semantic scenarios', () => {
    const smoke = fs.readFileSync(runtimeSmokePath, 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    expect(smoke).toContain("import { sendWebhook } from './lib/webhook.mjs';");
    expect(smoke).toContain(
      "import { parseRuntimeSmokeEnv } from './lib/runtime-smoke-env.mjs';",
    );
    expect(smoke).toContain("serverName: 'shopify-api'");
    expect(smoke).toContain("serverName: 'boondi-crm'");
    expect(smoke).toContain('expectAgentMcpFlow: false');
    expect(smoke).toContain("if (label === 'core') return response.status;");
    expect(smoke).toContain('await runtimeWorkersHealth();');
    expect(smoke).toContain("'/v1/runtime/workers'");
    expect(smoke).toContain('Authorization: `Bearer ${smokeEnv.controlToken}`');
    expect(smoke).toContain('workerInventory.healthyTotals.instances');
    expect(smoke).toContain("'mcp.request'");
    expect(smoke).toContain("'mcp.response'");
    expect(smoke).toContain('Outbound dry-run: sent to listed test number');
    expect(smoke).toContain('messageId: firstTurn.messageId');
    expect(smoke).toContain('duplicateInbound: true');
    expect(smoke).toContain('const SMOKE_CASES =');
    expect(smoke).toContain(
      'SMOKE_CASES did not match any runtime smoke cases',
    );
    expect(smoke).toContain('SMOKE_CONCURRENCY');
    expect(smoke).toContain('await mapPool(cases, SMOKE_CONCURRENCY');
    expect(smoke).toContain("name: 'shopify-secondary'");
    expect(smoke).toContain(
      'phone: process.env.BOONDI_SMOKE_SHOPIFY_SECONDARY_PHONE',
    );
    expect(smoke).toContain('function hasFlowForChat');
    expect(smoke).toContain('function countFlowForChat');
    expect(smoke).toContain('smokeCase.expectAgentMcpFlow === false');
    expect(smoke).toContain(
      "hasFlowForChat(text, chatJid, 'mcp.request', smokeCase.serverName)",
    );
    expect(smoke).toContain(
      "guardrail: countFlowForChat(finalLog, chatJid, 'guardrail')",
    );
    expect(smoke).toContain(
      "hasFlowForChat(duplicateLog, chatJid, 'outbound')",
    );
    expect(smoke).not.toContain('boondi-scenarios.json');
    expect(smoke).not.toContain('expectRecord');
    expect(smoke).not.toContain('replyMustMatch');
    expect(pkg.scripts?.['smoke:boondi-runtime']).toBe(
      'node scripts/boondi-runtime-smoke.mjs',
    );
  });

  it('keeps a checked-in command for the basic runtime MCP stack', () => {
    const stack = fs.readFileSync(runtimeStackPath, 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    expect(stack).toContain('packages/mcp-shopify/src/index.ts');
    expect(stack).toContain('packages/mcp-crm/src/index.ts');
    expect(stack).toContain('apps/core/src/index.ts');
    expect(stack.match(/-u OPENAI_API_KEY/g) ?? []).toHaveLength(3);
    expect(stack).toContain('GANTRY_FLOW_LOG=1');
    expect(stack).toContain('GANTRY_OUTBOUND_DRYRUN=1');
    expect(stack).toContain(
      'SMOKE_ENV_FILE="${GANTRY_RUNTIME_SMOKE_ENV:-/tmp/gantry-runtime-smoke.env}"',
    );
    expect(stack).toContain('chmod 600 "$smoke_env"');
    expect(stack).toContain('const token=process.env.SMOKE_CONTROL_TOKEN;');
    expect(stack).not.toContain('const token=process.argv[1]');
    expect(stack).toContain(
      'GANTRY_CONTROL_API_KEYS_JSON="$control_api_keys_json"',
    );
    expect(stack).toContain(
      'GANTRY_RUNTIME_SMOKE_ENV=${CORE_SMOKE_ENVS[$idx]} npm run smoke:boondi-runtime',
    );
    expect(stack).toContain('GANTRY_TEST_OPERATOR_PHONE="$OPERATOR"');
    expect(stack).toContain(
      'CALLER_IDENTITY_PHONE="${GANTRY_TEST_CALLER_IDENTITY_PHONE:-918097288633}"',
    );
    expect(stack).toContain(
      'GANTRY_TEST_CALLER_IDENTITY_PHONE="$CALLER_IDENTITY_PHONE"',
    );
    expect(stack).toContain('BOONDI_CRM_RECONCILE_INTERVAL_MS');
    expect(stack).toContain('GANTRY_DEV_LOG');
    expect(stack).toContain('GANTRY_EXPECTED_RUNTIME_INSTANCES');
    expect(stack).toContain('GANTRY_CONTROL_API_KEYS_JSON');
    expect(stack).toContain('GANTRY_SMOKE_CONTROL_TOKEN');
    expect(stack).toContain('smoke_token_from_control_keys_json');
    expect(stack).toContain('raw.slice(1,-1)');
    expect(stack).toContain('CORE_SMOKE_TOKENS=()');
    expect(stack).toContain('CORE_SMOKE_TOKENS+=("$smoke_token")');
    expect(stack).toContain('${CORE_SMOKE_TOKENS[$idx]}');
    expect(stack).toContain('http://127.0.0.1:8081/healthz');
    expect(stack).toContain('http://127.0.0.1:8082/healthz');
    expect(stack).not.toContain('CORE_URL');
    expect(stack).toContain('kill "${CORE_PIDS[@]}" "$SHOPIFY_PID" "$CRM_PID"');
    expect(stack).toContain('npm run smoke:boondi-runtime');
    expect(pkg.scripts?.['dev:boondi-runtime']).toBe(
      'bash scripts/boondi-runtime-stack.sh',
    );
  });

  it('can start a local multi-core runtime MCP stack with isolated IPC sockets', () => {
    const stack = fs.readFileSync(runtimeStackPath, 'utf-8');

    expect(stack).toContain('GANTRY_CORE_COUNT="${GANTRY_CORE_COUNT:-1}"');
    expect(stack).toContain('GANTRY_RUNTIME_IPC_DIR');
    expect(stack).toContain('CORE_PIDS=()');
    expect(stack).toContain('CORE_SMOKE_ENVS=()');
    expect(stack).toContain('wait_for_core_port()');
    expect(stack).toContain('wait_for_core_port "$core_port"');
    expect(stack).toContain('core-${idx}.sock');
    expect(stack).toContain('GANTRY_IPC_SOCKET_PATH="$core_ipc_socket"');
    expect(stack).toContain('GANTRY_CONTROL_PORT="$core_port"');
    expect(stack).toContain('GANTRY_DEV_LOG="$core_log"');
    expect(stack).toContain(
      'GANTRY_RUNTIME_SMOKE_ENV=${CORE_SMOKE_ENVS[$idx]}',
    );
    expect(stack).toContain('READY core_ports=${CORE_PORTS[*]}');
  });

  it('requires the runtime smoke to prove multi-instance worker inventory', () => {
    const smoke = fs.readFileSync(runtimeSmokePath, 'utf-8');
    const envParser = fs.readFileSync(
      path.join(process.cwd(), 'scripts/lib/runtime-smoke-env.mjs'),
      'utf-8',
    );

    expect(envParser).toContain('GANTRY_EXPECTED_RUNTIME_INSTANCES');
    expect(smoke).toContain('expectedRuntimeInstances');
    expect(smoke).toContain(
      'workerInventory.healthyTotals.instances < smokeEnv.expectedRuntimeInstances',
    );
    expect(smoke).toContain(
      'workerInventory.instances.length < smokeEnv.expectedRuntimeInstances',
    );
  });
});
