import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../core/logger.js', () => ({
  logger: {
    info: loggerSpies.info,
    warn: loggerSpies.warn,
  },
}));

import {
  PromptProfileService,
  getPromptProfileService,
  ensurePromptProfileBootstrapped,
} from './prompt-profile.js';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-prompt-profile-'));
}

describe('PromptProfileService', () => {
  const roots: string[] = [];

  afterEach(() => {
    loggerSpies.warn.mockReset();
    loggerSpies.info.mockReset();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds shared CLAUDE.md and preserves existing config files', () => {
    const root = makeTempRoot();
    roots.push(root);

    const configDir = path.join(root, 'config');
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(configDir, 'settings.yaml'), 'channels: {}\n');

    const service = new PromptProfileService({ agentsDir });
    service.ensureSeedFiles();

    expect(fs.existsSync(path.join(agentsDir, 'shared', 'CLAUDE.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'SOUL.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(configDir, 'settings.yaml'), 'utf-8'),
    ).toBe('channels: {}\n');
  });

  it('does not overwrite existing shared CLAUDE.md', () => {
    const root = makeTempRoot();
    roots.push(root);

    const agentsDir = path.join(root, 'agents');
    const sharedPath = path.join(agentsDir, 'shared', 'CLAUDE.md');
    const existingContent = '# Existing Shared Context\nDo not overwrite.';
    writeFile(sharedPath, existingContent);

    const service = new PromptProfileService({ agentsDir });
    service.ensureSeedFiles();

    expect(fs.readFileSync(sharedPath, 'utf-8')).toBe(existingContent);
  });

  it('compiles deterministic order: runtime rules, soul, shared context, group context', () => {
    const root = makeTempRoot();
    roots.push(root);

    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'team', 'SOUL.md'), '# Soul\nBe direct.');
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared context');
    writeFile(path.join(agentsDir, 'team', 'CLAUDE.md'), 'group context');

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.indexOf('[[RUNTIME_RULES]]')).toBeLessThan(
      prompt.indexOf('[[SOUL]]'),
    );
    expect(prompt.indexOf('[[SOUL]]')).toBeLessThan(
      prompt.indexOf('[[SHARED_CONTEXT]]'),
    );
    expect(prompt.indexOf('[[SHARED_CONTEXT]]')).toBeLessThan(
      prompt.indexOf('[[GROUP_CONTEXT]]'),
    );
    expect(prompt).toContain('source: myclaw://soul');
    expect(prompt).toContain('source: myclaw://shared-context');
    expect(prompt).toContain('source: myclaw://group-context');
    expect(prompt).not.toContain(root);
  });

  it('includes SOUL section with identity directive when SOUL.md exists', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(
      path.join(agentsDir, 'team', 'SOUL.md'),
      '# Soul\n\nBe sharp and direct.',
    );

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('[[SOUL]]');
    expect(prompt).toContain('CRITICAL IDENTITY DIRECTIVE');
    expect(prompt).toContain('Be sharp and direct.');
  });

  it('skips SOUL section when SOUL.md is missing', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared');

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });
    expect(prompt).not.toContain('[[SOUL]]');
  });

  it('skips SOUL section when SOUL.md is empty', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'team', 'SOUL.md'), ' \n \n');
    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });
    expect(prompt).not.toContain('[[SOUL]]');
  });

  it('skips invalid group folder names for SOUL and group sections', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared');
    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: '../../../etc' });

    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).toContain('[[SHARED_CONTEXT]]');
    expect(prompt).not.toContain('[[SOUL]]');
    expect(prompt).not.toContain('[[GROUP_CONTEXT]]');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('handles SOUL read failures gracefully', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');
    const soulPath = path.join(agentsDir, 'team', 'SOUL.md');

    fs.mkdirSync(soulPath, { recursive: true });
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared');

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).not.toContain('[[SOUL]]');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('handles group context read failures gracefully', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');
    const groupContextPath = path.join(agentsDir, 'team', 'CLAUDE.md');

    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared');
    writeFile(groupContextPath, 'group context');
    fs.unlinkSync(groupContextPath);
    fs.mkdirSync(groupContextPath, { recursive: true });

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('[[SHARED_CONTEXT]]');
    expect(prompt).not.toContain('[[GROUP_CONTEXT]]');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });

  it('enforces budget caps for sections and total output', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'team', 'SOUL.md'), 's'.repeat(8000));
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'g'.repeat(8000));
    writeFile(path.join(agentsDir, 'team', 'CLAUDE.md'), 't'.repeat(8000));

    const service = new PromptProfileService({
      agentsDir,
      sectionBudgets: {
        SOUL: 400,
        SHARED_CONTEXT: 300,
        GROUP_CONTEXT: 200,
      },
      totalBudget: 1100,
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.length).toBeLessThanOrEqual(1100);
    expect(prompt).toContain('[[SOUL]]');
    expect(prompt).toContain('[[SHARED_CONTEXT]]');
    expect(prompt).toContain('[[RUNTIME_RULES]]');
  });

  it('omits sections when section budgets are zero', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'team', 'SOUL.md'), 'soul');
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared');
    writeFile(path.join(agentsDir, 'team', 'CLAUDE.md'), 'group');

    const service = new PromptProfileService({
      agentsDir,
      sectionBudgets: {
        SOUL: 0,
        SHARED_CONTEXT: 0,
        GROUP_CONTEXT: 0,
      },
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('[[RUNTIME_RULES]]');
    expect(prompt).not.toContain('[[SOUL]]');
    expect(prompt).not.toContain('[[SHARED_CONTEXT]]');
    expect(prompt).not.toContain('[[GROUP_CONTEXT]]');
  });

  it('handles very small totalBudget by truncating early', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(path.join(agentsDir, 'team', 'SOUL.md'), '# Soul\nBe direct');
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared context');
    writeFile(path.join(agentsDir, 'team', 'CLAUDE.md'), 'group context');

    const service = new PromptProfileService({
      agentsDir,
      totalBudget: 60,
    });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt.length).toBeLessThanOrEqual(60);
    expect(prompt).toContain('[[RUNTIME_RULES]]');
  });

  it('normalizes CRLF in SOUL and context files', () => {
    const root = makeTempRoot();
    roots.push(root);
    const agentsDir = path.join(root, 'agents');

    writeFile(
      path.join(agentsDir, 'team', 'SOUL.md'),
      '# Soul\r\n\r\nVoice line\r\n',
    );
    writeFile(path.join(agentsDir, 'shared', 'CLAUDE.md'), 'shared\r\nrules');

    const service = new PromptProfileService({ agentsDir });
    const prompt = service.compileSystemPrompt({ groupFolder: 'team' });

    expect(prompt).toContain('Voice line');
    expect(prompt).toContain('shared\nrules');
  });

  it('getPromptProfileService returns singleton and bootstrap works', () => {
    const service = getPromptProfileService();
    expect(service).toBeInstanceOf(PromptProfileService);
    expect(getPromptProfileService()).toBe(service);
    expect(() => ensurePromptProfileBootstrapped()).not.toThrow();
  });
});
