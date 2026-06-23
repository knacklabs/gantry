import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  allocateDefaultAgentFolder,
  defaultTriggerForAgentName,
  displayAgentName,
  defaultAgentNameFromSettings,
  DEFAULT_AGENT_FOLDER,
  DEFAULT_AGENT_CLI_NAME,
  normalizeDefaultAgentName,
} from '@core/cli/main-agent.js';

const tempDirs: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-default-agent-test-'),
  );
  tempDirs.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of tempDirs.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('default-agent helpers', () => {
  it('normalizes blank names to Default Agent and trims configured names', () => {
    expect(normalizeDefaultAgentName(undefined)).toBe(DEFAULT_AGENT_CLI_NAME);
    expect(normalizeDefaultAgentName('   ')).toBe(DEFAULT_AGENT_CLI_NAME);
    expect(normalizeDefaultAgentName('  Kai  ')).toBe('Kai');
    expect(defaultAgentNameFromSettings({ agent: { name: '  ' } })).toBe(
      DEFAULT_AGENT_CLI_NAME,
    );
  });

  it('derives default triggers from normalized names', () => {
    expect(defaultTriggerForAgentName('')).toBe(`@${DEFAULT_AGENT_CLI_NAME}`);
    expect(defaultTriggerForAgentName('  Kai  ')).toBe('@Kai');
  });

  it('allocates main_agent when no collision exists', () => {
    const runtimeHome = makeRuntimeHome();
    expect(allocateDefaultAgentFolder(runtimeHome, {})).toBe(
      DEFAULT_AGENT_FOLDER,
    );
  });

  it('allocates the next available folder when main_agent already exists', () => {
    const runtimeHome = makeRuntimeHome();
    expect(
      allocateDefaultAgentFolder(runtimeHome, {
        'tg:1': { folder: DEFAULT_AGENT_FOLDER },
      }),
    ).toBe(`${DEFAULT_AGENT_FOLDER}_2`);
  });

  it('does not treat the seeded default app route as a real main_agent collision', () => {
    const runtimeHome = makeRuntimeHome();
    expect(
      allocateDefaultAgentFolder(runtimeHome, {
        'app:default': { folder: DEFAULT_AGENT_FOLDER },
      }),
    ).toBe(DEFAULT_AGENT_FOLDER);
  });

  it('reuses the seeded default app route folder when it exists on disk', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(path.join(runtimeHome, 'agents', DEFAULT_AGENT_FOLDER), {
      recursive: true,
    });

    expect(
      allocateDefaultAgentFolder(runtimeHome, {
        'app:default': { folder: DEFAULT_AGENT_FOLDER },
      }),
    ).toBe(DEFAULT_AGENT_FOLDER);
  });

  it('treats on-disk folders as collisions when allocating', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(path.join(runtimeHome, 'agents', DEFAULT_AGENT_FOLDER), {
      recursive: true,
    });

    expect(allocateDefaultAgentFolder(runtimeHome, {})).toBe(
      `${DEFAULT_AGENT_FOLDER}_2`,
    );
  });

  it('displays the route name without default-agent override', () => {
    expect(
      displayAgentName({ name: 'Ops Chat' }, 'Configured Default Agent'),
    ).toBe('Ops Chat');
    expect(displayAgentName({ name: 'Ops Chat' }, 'Ignored')).toBe('Ops Chat');
  });
});
