import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the V2 Step 1 draft, rail, and Continue gate contract', () => {
  const route = [
    './features/onboarding/onboarding-flow.tsx',
    './features/onboarding/onboarding-step-content.tsx',
    './features/onboarding/use-onboarding-controller.ts',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const modelSetup = readFileSync(
    new URL(
      './features/onboarding/onboarding-model-setup.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  const assets = readFileSync(
    new URL('./assets/onboarding/index.ts', import.meta.url),
    'utf8',
  );
  const rail = readFileSync(
    new URL('./assets/onboarding/gantry-rail-step-4.svg', import.meta.url),
    'utf8',
  );
  const reducedRail = readFileSync(
    new URL(
      './assets/onboarding/gantry-rail-step-4-reduced.svg',
      import.meta.url,
    ),
    'utf8',
  );

  expect(route).toContain("name: 'Atlas'");
  expect(route).toContain("title: 'General assistant'");
  expect(route).toContain('Answer questions in the channels it is invited to.');
  expect(route).toContain('setStepOneReady(true)');
  expect(route).toContain('setStepOneReady(true);\n    setStep(resume.step);');
  expect(route).not.toContain(
    "localStorage.removeItem('gantry.onboarding.name')",
  );
  expect(route).toContain(
    'if (value !== flow.model) flow.setStepOneReady(false);',
  );
  expect(route).toContain("browserFetch('/ui/api/onboarding/setups'");
  expect(route).toContain("'idempotency-key': setupIdempotencyKey");
  expect(route).toContain('setSetupIdempotencyKey(nextIdempotencyKey)');
  expect(route).toContain("selectedConversation?.kind !== 'direct'");
  expect(route).toContain(
    'flow.setCredentialValidated(false);\n                  flow.setStepOneReady(false);',
  );
  expect(route).toContain('flow.step === 1');
  expect(route).toContain('flow.step === 1 || flow.step === 2');
  expect(route).not.toContain('Skip for now');
  expect(route).toContain('openConsole: () => {');
  expect(route).toMatch(
    /flow\.step === 1\s*\? !flow\.stepOneReady\s*:\s*!flow\.workspaceConnected/,
  );
  expect(route).toContain('if (flow.step === 2 && flow.workspaceConnected)');
  expect(route).toContain('selectOnboardingChannelProvider(');
  expect(route).toContain(
    'if (step !== 2 || channelId || !channelProviders.data) return;',
  );
  expect(route).toContain('onboarding-provider-action');
  expect(route).toContain('Tested &amp; connected');
  expect(route).toContain(
    'RAIL_MARKS[flow.step - 1][preferences.reduceMotion ? 1 : 0]',
  );
  expect(assets.match(/gantry-rail-step-[1-4]\.svg/g)).toHaveLength(4);
  expect(assets.match(/gantry-rail-step-[1-4]-reduced\.svg/g)).toHaveLength(4);
  expect(rail.match(/<rect/g)).toHaveLength(9);
  expect(rail).toContain('@keyframes pop');
  expect(rail).toContain('@media(prefers-reduced-motion:reduce)');
  expect(reducedRail).not.toContain('@keyframes');
  expect(styles).toContain('.onboarding-rail-mark');
  expect(styles).toMatch(
    /\.onboarding-powered \{\s*display: inline-flex;\s*align-self: center;/,
  );
  expect(styles).toContain('grid-template-columns: 266px minmax(0, 1fr)');
  expect(styles).toContain('@keyframes onboarding-pulse');
  expect(styles).toMatch(
    /@media \(min-width: 768px\) \{\s*\.onboarding-model-card \{\s*align-content: start;\s*height: 50dvh;/,
  );
  expect(styles).toMatch(
    /\.onboarding-model-card \.onboarding-model-setup \{\s*align-self: stretch;\s*height: calc\(100% - 15px\);\s*min-height: 0;\s*overflow: hidden;/,
  );
  expect(styles).toMatch(
    /\.onboarding-model-card \.onboarding-model-scroll \{\s*flex: 1;\s*min-height: 0;\s*overflow-y: auto;\s*overscroll-behavior: contain;\s*scrollbar-gutter: stable;\s*scroll-padding: 16px;/,
  );
  expect(modelSetup).toContain('className="onboarding-model-scroll"');
  expect(styles).toContain('@media (max-width: 767px)');
  expect(styles).toContain('animation: none !important;');
  expect(styles).not.toContain('.onboarding-toast');
  expect(modelSetup).toContain(
    "import { toast } from '../../ui/primitives/toast';",
  );
  expect(modelSetup).toContain(
    "toast.success('Configuration validated. Choose a model to continue.')",
  );
  expect(modelSetup).toContain("toast.error('Credential validation failed.')");
});

it('keeps Console handoff locked until exact verification and projection complete', () => {
  const route = [
    './features/onboarding/onboarding-flow.tsx',
    './features/onboarding/onboarding-step-content.tsx',
    './features/onboarding/use-onboarding-controller.ts',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');

  expect(route).toContain(
    "if (verification.data?.verification.status === 'completed')",
  );
  expect(route).toContain('/project`');
  expect(route).toContain(
    "status === 'satisfied' || status === 'projection_failed'",
  );
  expect(route).toContain("status === 'completed'");
  expect(route).toContain("{busy ? 'Finishing setup…' : 'Finish setup'}");
  expect(route).toContain("'gantry.onboarding.name'");
  expect(route).toContain('sessionStorage.removeItem(key)');
  expect(route).toContain('setChannelValues({})');
  expect(route).toMatch(/disabled=\{verificationStatus !== 'completed'\}/);
});
