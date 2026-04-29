import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  allocateMainAgentFolder,
  defaultTriggerForAgentName,
  displayAgentName,
  mainAgentNameFromSettings,
  MAIN_AGENT_FOLDER,
  MAIN_AGENT_NAME,
  normalizeMainAgentName,
} from '@core/cli/main-agent.js';

const tempDirs: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-main-agent-test-'),
  );
  tempDirs.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of tempDirs.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('main-agent helpers', () => {
  it('normalizes blank names to Main Agent and trims configured names', () => {
    expect(normalizeMainAgentName(undefined)).toBe(MAIN_AGENT_NAME);
    expect(normalizeMainAgentName('   ')).toBe(MAIN_AGENT_NAME);
    expect(normalizeMainAgentName('  Kai  ')).toBe('Kai');
    expect(mainAgentNameFromSettings({ agent: { name: '  ' } })).toBe(
      MAIN_AGENT_NAME,
    );
  });

  it('derives default triggers from normalized names', () => {
    expect(defaultTriggerForAgentName('')).toBe(`@${MAIN_AGENT_NAME}`);
    expect(defaultTriggerForAgentName('  Kai  ')).toBe('@Kai');
  });

  it('allocates main_agent when no collision exists', () => {
    const runtimeHome = makeRuntimeHome();
    expect(allocateMainAgentFolder(runtimeHome, {})).toBe(MAIN_AGENT_FOLDER);
  });

  it('allocates the next available folder when main_agent already exists', () => {
    const runtimeHome = makeRuntimeHome();
    expect(
      allocateMainAgentFolder(runtimeHome, {
        'tg:1': { folder: MAIN_AGENT_FOLDER },
      }),
    ).toBe(`${MAIN_AGENT_FOLDER}_2`);
  });

  it('treats on-disk folders as collisions when allocating', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(path.join(runtimeHome, 'agents', MAIN_AGENT_FOLDER), {
      recursive: true,
    });

    expect(allocateMainAgentFolder(runtimeHome, {})).toBe(
      `${MAIN_AGENT_FOLDER}_2`,
    );
  });

  it('displays configured main agent name only for main entries', () => {
    expect(
      displayAgentName(
        { isMain: true, name: 'Ops Chat' },
        'Configured Main Agent',
      ),
    ).toBe('Configured Main Agent');
    expect(
      displayAgentName({ isMain: false, name: 'Ops Chat' }, 'Ignored'),
    ).toBe('Ops Chat');
  });
});
