import { describe, expect, it } from 'vitest';

import {
  PROACTIVE_RECOMMENDATION_GUIDANCE,
  renderDefaultCapabilityRules,
} from '@core/shared/capability-guidance.js';

const STALE_TOOL_NAMES = [
  'request_permission',
  'capability_search',
  'request_capability',
  'propose_local_cli_capability',
];

describe('capability guidance', () => {
  it('renders only current tool names, never stale ones', () => {
    const rules = renderDefaultCapabilityRules();
    for (const toolName of [
      'request_access',
      'send_message',
      'ask_user_question',
      'service_restart',
      'register_agent',
    ]) {
      expect(rules).toContain(toolName);
    }
    for (const stale of STALE_TOOL_NAMES) {
      expect(rules).not.toContain(stale);
    }
    expect(rules).toContain(
      'first send one short natural acknowledgement with send_message',
    );
    expect(rules).toContain(
      'use todo_update for progress instead of repeated generic progress messages',
    );
  });

  it('includes settings admin tools only when requested', () => {
    expect(renderDefaultCapabilityRules()).not.toContain(
      'settings_desired_state',
    );
    const withSettings = renderDefaultCapabilityRules({
      includeSettingsTools: true,
    });
    expect(withSettings).toContain('settings_desired_state');
    expect(withSettings).toContain('request_settings_update');
  });

  it('suggests jobs, skills, and durable capabilities in the proactive ladder', () => {
    // Suggests jobs for recurring work and skills for repeatable procedures.
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain('scheduler_upsert_job');
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain(
      'request_skill_proposal',
    );
    // Suggests a durable capability when the same permission recurs.
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain(
      'request_access target.kind=capability',
    );
    // Suggests browser setup and permission-cleanup visibility.
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain('browser setup');
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain(
      'admin_permission_list',
    );
  });

  it('keeps secrets out of chat in the proactive ladder', () => {
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain('Credential Center');
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain('never in chat');
    expect(PROACTIVE_RECOMMENDATION_GUIDANCE).toContain(
      'Never ask for or accept a secret value',
    );
    for (const stale of STALE_TOOL_NAMES) {
      expect(PROACTIVE_RECOMMENDATION_GUIDANCE).not.toContain(stale);
    }
  });

  it('explains permission state in plain user-facing words', () => {
    const rules = renderDefaultCapabilityRules();
    for (const phrase of [
      'approval requested',
      'approved',
      'installed',
      'available now',
      'needs setup',
      'paused',
    ]) {
      expect(rules).toContain(phrase);
    }
  });
});
