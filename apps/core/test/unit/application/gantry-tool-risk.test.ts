import { describe, expect, it } from 'vitest';

import {
  gantryNativeCanonicalToolName,
  gantryToolDefaultRisk,
} from '@core/application/permissions/gantry-tool-risk.js';

const AUTO_APPROVE = new Set(['low', 'medium']);

describe('gantryNativeCanonicalToolName', () => {
  it('strips the mcp__gantry__ prefix and flags known tools', () => {
    expect(gantryNativeCanonicalToolName('mcp__gantry__memory_save')).toEqual({
      canonical: 'memory_save',
      known: true,
    });
  });

  it('accepts bare canonical gantry names', () => {
    expect(gantryNativeCanonicalToolName('scheduler_update_job')).toEqual({
      canonical: 'scheduler_update_job',
      known: true,
    });
  });

  it('marks namespaced-but-unknown gantry tools as not known', () => {
    expect(gantryNativeCanonicalToolName('mcp__gantry__frobnicate')).toEqual({
      canonical: 'frobnicate',
      known: false,
    });
  });

  it('returns null for non-gantry tools', () => {
    expect(gantryNativeCanonicalToolName('Bash')).toBeNull();
    expect(gantryNativeCanonicalToolName('mcp__github__search')).toBeNull();
    expect(gantryNativeCanonicalToolName('WebSearch')).toBeNull();
  });
});

describe('gantryToolDefaultRisk', () => {
  it('returns undefined for non-gantry tools (existing paths unchanged)', () => {
    expect(gantryToolDefaultRisk('Bash')).toBeUndefined();
    expect(gantryToolDefaultRisk('RunCommand')).toBeUndefined();
    expect(
      gantryToolDefaultRisk('mcp__github__pull_requests.list'),
    ).toBeUndefined();
  });

  // (a) representative reads + routine low-risk mutations -> auto-approvable.
  it.each([
    'mcp__gantry__memory_search',
    'mcp__gantry__brain_query',
    'mcp__gantry__scheduler_get_job',
    'mcp__gantry__scheduler_list_jobs',
    'mcp__gantry__agent_profile_read',
    'mcp__gantry__admin_permission_list',
    'mcp__gantry__guided_action_preview',
    'mcp__gantry__scheduler_wait_for_events',
    'mcp__gantry__continuity_summary',
    'mcp__gantry__render_status',
    'mcp__gantry__ask_user_question',
    'mcp__gantry__send_message',
    'mcp__gantry__browser_status',
    'mcp__gantry__browser_inspect',
  ])('rates read/display tool %s low (auto-approve)', (tool) => {
    const risk = gantryToolDefaultRisk(tool);
    expect(risk?.risk_level).toBe('low');
    expect(AUTO_APPROVE.has(risk!.risk_level)).toBe(true);
  });

  it.each([
    'mcp__gantry__scheduler_update_job',
    'mcp__gantry__scheduler_upsert_job',
    'mcp__gantry__scheduler_pause_job',
    'mcp__gantry__scheduler_resume_job',
    'mcp__gantry__scheduler_run_now',
    'mcp__gantry__memory_save',
    'mcp__gantry__brain_write',
    'mcp__gantry__procedure_save',
    'mcp__gantry__memory_patch',
  ])('rates routine mutation %s medium (auto-approve)', (tool) => {
    const risk = gantryToolDefaultRisk(tool);
    expect(risk?.risk_level).toBe('medium');
    expect(AUTO_APPROVE.has(risk!.risk_level)).toBe(true);
  });

  // (b) genuinely risky gantry tools stay high (ask, never auto-approved).
  it.each([
    'mcp__gantry__request_access', // capability grant
    'mcp__gantry__request_skill_install', // authority-changing
    'mcp__gantry__request_mcp_server', // authority-changing
    'mcp__gantry__request_settings_update', // settings mutation
    'mcp__gantry__settings_desired_state', // admin settings mutation
    'mcp__gantry__admin_permission_revoke', // permission revoke
    'mcp__gantry__service_restart', // service restart
    'mcp__gantry__register_agent', // authority-changing
    'mcp__gantry__scheduler_delete_job', // destructive (delete)
    'mcp__gantry__mcp_call_tool', // unscoped dispatcher
    'mcp__gantry__async_run_command', // unscoped dispatcher
    'mcp__gantry__async_mcp_call', // unscoped dispatcher
    'mcp__gantry__pattern_candidate_decision', // decision actor
    'mcp__gantry__proactive_surfacing_consent', // decision actor
    'mcp__gantry__file', // arg-dependent protected config writes
    'mcp__gantry__browser_open', // browser action -> unbounded real-world effect
    'mcp__gantry__browser_act', // submit/click/type on a real page
    'mcp__gantry__browser_close', // browser action
  ])('rates high-risk tool %s high (ask)', (tool) => {
    const risk = gantryToolDefaultRisk(tool);
    expect(risk?.risk_level).toBe('high');
    expect(AUTO_APPROVE.has(risk!.risk_level)).toBe(false);
  });

  // (c) unknown / unmapped gantry tools default to ask, never silent approve.
  it.each([
    'mcp__gantry__frobnicate_everything',
    'mcp__gantry__totally_new_tool',
    'mcp__gantry__delete_all_the_things',
  ])('defaults unmapped gantry tool %s to high (ask)', (tool) => {
    expect(gantryToolDefaultRisk(tool)?.risk_level).toBe('high');
  });

  it('never auto-approves any authority-changing tool', () => {
    const authorityTools = [
      'request_skill_install',
      'request_skill_proposal',
      'request_skill_dependency_install',
      'request_mcp_server',
      'request_access',
      'request_agent_profile_update',
      'admin_permission_revoke',
      'register_agent',
      'request_settings_update',
      'service_restart',
    ];
    for (const tool of authorityTools) {
      expect(gantryToolDefaultRisk(`mcp__gantry__${tool}`)?.risk_level).toBe(
        'high',
      );
    }
  });
});
