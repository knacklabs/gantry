import { describe, expect, it } from 'vitest';

import {
  DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE,
  deepAgentsEnforcingSandboxGuard,
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

  describe('deepAgentsEnforcingSandboxGuard (the operative gate)', () => {
    it('ALLOWS shell under sandbox_runtime + safe local posture (returns null)', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBeNull();
    });

    it('ALLOWS shell under sandbox_runtime even with production posture (the OS sandbox is enforcing)', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['FileWrite'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'sandbox_runtime',
        }),
      ).toBeNull();
    });

    it('BLOCKS shell under direct mode (non-enforcing) with the EXACT enforcing-sandbox copy — local posture', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE);
      expect(DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE).toBe(
        'DeepAgents requires an enforcing sandbox before shell or filesystem tools can be enabled in this deployment mode.',
      );
    });

    it('BLOCKS shell when the sandbox provider is undefined (fail closed)', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: undefined,
        }),
      ).toBe(DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE);
    });

    it('does not apply when no shell/fs authority is requested', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['WebSearch'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });

    it('does not apply to the default (Anthropic SDK) engine', () => {
      expect(
        deepAgentsEnforcingSandboxGuard({
          engine: DEFAULT_AGENT_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBeNull();
    });
  });

  describe('combined guard truth table', () => {
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

    it('deepagents + RunCommand rule + direct -> tier-2 enforcing-sandbox copy (FAIL CLOSED)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE);
    });

    it('deepagents + RunCommand rule + production-without-sandbox -> blocked (FAIL CLOSED)', () => {
      expect(
        deepAgentsShellFilesystemGuard({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: PRODUCTION_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE);
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

    it('false under direct mode (guard would block the spawn anyway)', () => {
      expect(
        deepAgentsShellToolEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['RunCommand(npm test)'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(false);
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

    it('false under direct mode', () => {
      expect(
        deepAgentsFilesystemToolsEnabled({
          engine: DEEPAGENTS_ENGINE,
          toolPolicyRules: ['FileRead'],
          securityEnv: SAFE_LOCAL_ENV,
          sandboxProvider: 'direct',
        }),
      ).toBe(false);
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
