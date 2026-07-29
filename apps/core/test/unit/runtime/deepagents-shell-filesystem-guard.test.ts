import { describe, expect, it } from 'vitest';

import {
  deepAgentsFilesystemToolsEnabled,
  deepAgentsShellFilesystemGuard,
  deepAgentsShellToolEnabled,
  requestsFilesystemAuthority,
  requestsShellAuthority,
  requestsShellOrFilesystemAuthority,
} from '@core/runtime/deepagents-shell-filesystem-guard.js';
import type { RuntimeSecurityEnv } from '@core/shared/security-posture.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

const SAFE_LOCAL_ENV: RuntimeSecurityEnv = {};
const PRODUCTION_ENV: RuntimeSecurityEnv = { NODE_ENV: 'production' };

describe('deepAgentsShellFilesystemGuard', () => {
  describe('requestsShellOrFilesystemAuthority', () => {
    it('detects bare RunCommand, scoped RunCommand, and raw Bash', () => {
      expect(requestsShellOrFilesystemAuthority(['RunCommand'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['RunCommand(npm test)'])).toBe(
        true,
      );
      expect(requestsShellOrFilesystemAuthority(['Bash'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Bash(ls *)'])).toBe(true);
    });

    it('detects Gantry facade filesystem tools and raw provider-native file tools', () => {
      expect(requestsShellOrFilesystemAuthority(['FileWrite'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['FileRead'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['FileEdit'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['FileSearch'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Write'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Read'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Edit'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['MultiEdit'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Glob'])).toBe(true);
      expect(requestsShellOrFilesystemAuthority(['Grep'])).toBe(true);
    });

    it('does not trip on web/search/browser facade tools', () => {
      expect(
        requestsShellOrFilesystemAuthority(['WebSearch', 'WebRead', 'Browser']),
      ).toBe(false);
      expect(requestsShellOrFilesystemAuthority([])).toBe(false);
      expect(requestsShellOrFilesystemAuthority(undefined)).toBe(false);
    });
  });

  describe('requestsShellAuthority', () => {
    it('matches shell (RunCommand/Bash) authority but NOT filesystem-only authority', () => {
      expect(requestsShellAuthority(['RunCommand(npm test)'])).toBe(true);
      expect(requestsShellAuthority(['RunCommand'])).toBe(true);
      expect(requestsShellAuthority(['Bash'])).toBe(true);
      expect(requestsShellAuthority(['FileWrite'])).toBe(false);
      expect(requestsShellAuthority(['FileRead', 'WebSearch'])).toBe(false);
      expect(requestsShellAuthority([])).toBe(false);
    });
  });

  describe('requestsFilesystemAuthority', () => {
    it('matches filesystem authority but not shell-only or web authority', () => {
      expect(requestsFilesystemAuthority(['FileWrite'])).toBe(true);
      expect(requestsFilesystemAuthority(['FileRead', 'WebSearch'])).toBe(true);
      expect(requestsFilesystemAuthority(['Read'])).toBe(true);
      expect(requestsFilesystemAuthority(['Grep'])).toBe(true);
      expect(requestsFilesystemAuthority(['RunCommand(npm test)'])).toBe(false);
      expect(requestsFilesystemAuthority(['WebSearch'])).toBe(false);
      expect(requestsFilesystemAuthority([])).toBe(false);
    });
  });

  describe('combined guard truth table (two-axis model: sandbox provider never gates)', () => {
    it('deepagents + RunCommand rule + sandbox_runtime -> null (allowed)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBeNull();
    });

    it('deepagents + RunCommand rule + direct -> null (authorization is the control)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });

    it('deepagents + RunCommand rule + production posture + direct -> null (allowed)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });

    it('deepagents + RunCommand rule + undefined sandbox provider -> null (allowed)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: undefined,
        }),
      ).toBeNull();
    });

    it('deepagents + NO shell/fs rule -> null (no shell requested, no block)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['WebSearch', 'WebRead'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });

    it('non-deepagents engine -> null regardless of rules/posture', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEFAULT_AGENT_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)', 'FileWrite'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });
  });

  describe('deepAgentsShellToolEnabled (host projection flag)', () => {
    it('true for deepagents + RunCommand rule + sandbox_runtime', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(true);
    });

    it('true for deepagents + RunCommand rule under direct mode too (two-axis: provider does not gate)', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(true);
    });

    it('false for filesystem-only authority (the shell tool is shell, not FS)', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['FileWrite'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(false);
    });

    it('false for the default (Anthropic SDK) engine', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEFAULT_AGENT_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(false);
    });

    it('false when no shell rule is present', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['WebSearch'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(false);
    });
  });

  describe('deepAgentsFilesystemToolsEnabled (host projection flag)', () => {
    it('true for deepagents under sandbox_runtime even without preselected File rules', () => {
      expect(
        deepAgentsFilesystemToolsEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['WebSearch'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(true);
    });

    it('true under direct mode too (two-axis: provider does not gate)', () => {
      expect(
        deepAgentsFilesystemToolsEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['FileRead'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(true);
    });

    it('false for the default (Anthropic SDK) engine', () => {
      expect(
        deepAgentsFilesystemToolsEnabled({
          engine: DEFAULT_AGENT_ENGINE,
          toolPolicyRules: ['FileRead'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBe(false);
    });
  });
});
