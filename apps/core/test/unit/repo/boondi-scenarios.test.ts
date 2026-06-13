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

  it('includes scenario phones and runtime .env operator phones without reading the real home', async () => {
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
        [
          'OTHER_KEY=ignored',
          'GANTRY_TEST_OPERATOR_PHONE="000000001, 000000999"',
        ].join('\n'),
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
        new Set(['000000001', '000000999']),
      );
      expect(phonesModule.ALL_TEST_PHONES).toContain('000000059');
      expect(phonesModule.ALL_TEST_PHONES).toContain('000000901');
      expect(phonesModule.OPERATOR_LIST.split(',')).toEqual(
        expect.arrayContaining(['000000001', '000000059', '000000999']),
      );
      expect(phonesModule.isAllowedTestPhone('000-000-999')).toBe(true);
      expect(phonesModule.isAllowedTestPhone('919654405340')).toBe(false);
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
    expect(setupScript).toContain('IDLE_TIMEOUT="$IDLE_TIMEOUT_MS"');
  });

  it('requires visible replies and bounds live-flow concurrency by default', () => {
    const runner = fs.readFileSync(regressionRunnerPath, 'utf-8');

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
});
