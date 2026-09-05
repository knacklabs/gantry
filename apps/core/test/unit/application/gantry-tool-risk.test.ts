import { describe, expect, it } from 'vitest';

import {
  GantryToolRiskVerdict,
  gantryNativeCanonicalToolName,
  gantryToolRisk,
} from '@core/application/permissions/gantry-tool-risk.js';
import {
  ALL_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  DELEGATION_DISPATCHERS,
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
  SCHEDULER_MUTATION_MCP_TOOL_NAMES,
} from '@core/shared/admin-mcp-tools.js';

const HIGH_TOOLS = new Set<string>([
  ...SCHEDULER_MUTATION_MCP_TOOL_NAMES,
  ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  ...DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  ...DELEGATION_DISPATCHERS,
  'capability_run',
]);
const AMBIGUOUS_EXECUTORS = new Set<string>(
  DURABLE_GRANT_EXCLUDED_DISPATCHERS.filter(
    (toolName) => toolName !== 'capability_run',
  ),
);

function validInput(toolName: string): unknown {
  if (toolName === 'file') return { action: 'list' };
  if (toolName === 'browser_act') return { action: 'click', payload: {} };
  return {};
}

function expectedReason(toolName: string): string {
  if (toolName === 'capability_run') {
    return 'capability dispatch requires approval';
  }
  if (AMBIGUOUS_EXECUTORS.has(toolName)) {
    return 'executor judged by the classifier';
  }
  if (SCHEDULER_MUTATION_MCP_TOOL_NAMES.includes(toolName as never)) {
    return 'scheduler mutation';
  }
  if (HIGH_TOOLS.has(toolName)) return 'admin mutation';
  if (toolName === 'file') return 'virtual file read';
  if (toolName === 'browser_act') return 'browser action';
  return 'registered gantry tool';
}

describe('gantry tool risk table', () => {
  it('judges every registered gantry tool with a deterministic reason per rule: low by default, the imported scheduler and admin mutation sets and capability_run high, the other three executors and unknown suffixes ambiguous', () => {
    for (const toolName of ALL_GANTRY_MCP_TOOL_NAMES) {
      const result = gantryToolRisk({
        toolName: `mcp__gantry__${toolName}`,
        toolInput: validInput(toolName),
      });
      const expectedVerdict = HIGH_TOOLS.has(toolName)
        ? GantryToolRiskVerdict.High
        : AMBIGUOUS_EXECUTORS.has(toolName)
          ? GantryToolRiskVerdict.Ambiguous
          : GantryToolRiskVerdict.Low;
      expect(result, toolName).toEqual({
        verdict: expectedVerdict,
        reason: expectedReason(toolName),
      });
    }

    for (const toolName of [
      ...SCHEDULER_MUTATION_MCP_TOOL_NAMES,
      ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
      ...DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
      ...DELEGATION_DISPATCHERS,
    ]) {
      expect(
        gantryToolRisk({ toolName, toolInput: validInput(toolName) }).verdict,
        toolName,
      ).toBe(GantryToolRiskVerdict.High);
    }
    for (const toolName of DURABLE_GRANT_EXCLUDED_DISPATCHERS) {
      expect(
        gantryToolRisk({ toolName, toolInput: {} }).verdict,
        toolName,
      ).toBe(
        toolName === 'capability_run'
          ? GantryToolRiskVerdict.High
          : GantryToolRiskVerdict.Ambiguous,
      );
    }
    expect(
      gantryToolRisk({
        toolName: 'mcp__gantry__frobnicate_everything',
        toolInput: {},
      }),
    ).toEqual({
      verdict: GantryToolRiskVerdict.Ambiguous,
      reason: 'unknown gantry tool',
    });
  });

  it('judges file by action with omitted scopes accepted and non-throwing host-equivalent normalization: list and read low, write and promote_scratch low to an unprotected virtual target and high to a protected one or with protected true on either action including a whitespace-padded profile path, absolute or dot-segment or invalid-scope shapes ambiguous', () => {
    const judge = (toolInput: unknown) =>
      gantryToolRisk({ toolName: 'file', toolInput });

    expect(judge({ action: 'list' }).verdict).toBe(GantryToolRiskVerdict.Low);
    expect(judge({ action: 'read', path: 'notes/a.md' }).verdict).toBe(
      GantryToolRiskVerdict.Low,
    );
    expect(judge({ action: 'read', artifactId: 'artifact-1' }).verdict).toBe(
      GantryToolRiskVerdict.Low,
    );
    for (const toolInput of [
      { action: 'write', path: 'notes/a.md', content: 'hello' },
      {
        action: 'promote_scratch',
        path: 'scratch/a.md',
        targetPath: 'notes/a.md',
      },
    ]) {
      expect(judge(toolInput).verdict).toBe(GantryToolRiskVerdict.Low);
    }
    for (const toolInput of [
      { action: 'write', path: 'settings.yaml', content: 'x' },
      {
        action: 'write',
        scope: ' prompt-profile ',
        path: ' profiles/AGENTS.md ',
        content: 'x',
      },
      { action: 'write', path: 'notes/a.md', content: 'x', protected: true },
      {
        action: 'promote_scratch',
        path: 'scratch/a.md',
        targetScope: ' prompt-profile ',
        targetPath: ' profiles/AGENTS.md ',
      },
      {
        action: 'promote_scratch',
        path: 'scratch/a.md',
        targetPath: 'notes/a.md',
        protected: true,
      },
    ]) {
      expect(judge(toolInput).verdict).toBe(GantryToolRiskVerdict.High);
    }
    for (const toolInput of [
      { action: 'write', path: '/tmp/a', content: 'x' },
      { action: 'write', path: 'notes/../a', content: 'x' },
      { action: 'write', scope: 'bad scope', path: 'a', content: 'x' },
      {
        action: 'promote_scratch',
        path: './scratch',
        targetPath: 'notes/a.md',
      },
      { action: 'read', path: '/tmp/a' },
      { action: 'write', path: 'notes/a.md' },
    ]) {
      expect(judge(toolInput).verdict).toBe(GantryToolRiskVerdict.Ambiguous);
    }
  });

  it('judges browser file actions by payload source: any raw filesystem path source and artifact-source upload ambiguous, artifact-source attach and bytes source and inline files low, every other browser action low, malformed ambiguous', () => {
    const judge = (toolInput: unknown) =>
      gantryToolRisk({ toolName: 'browser_act', toolInput }).verdict;

    for (const toolInput of [
      { action: 'file_attach', payload: { paths: ['/tmp/a'] } },
      { action: 'file_upload', payload: { paths: ['/tmp/a'] } },
      {
        action: 'file_attach',
        payload: { source: { type: 'path', path: '/tmp/a' } },
      },
      {
        action: 'file_upload',
        payload: { source: { type: 'path', paths: ['/tmp/a'] } },
      },
      {
        action: 'file_upload',
        payload: { source: { type: 'artifact', artifactId: 'artifact-1' } },
      },
    ]) {
      expect(judge(toolInput)).toBe(GantryToolRiskVerdict.Ambiguous);
    }
    for (const toolInput of [
      {
        action: 'file_attach',
        payload: { source: { type: 'artifact', path: 'notes/a.md' } },
      },
      {
        action: 'file_attach',
        payload: { source: { type: 'bytes', content: 'a' } },
      },
      {
        action: 'file_upload',
        payload: { source: { type: 'bytes', content: 'a' } },
      },
      {
        action: 'file_attach',
        payload: { files: [{ name: 'a.txt', content: 'a' }] },
      },
      {
        action: 'file_upload',
        payload: { files: [{ name: 'a.txt', content: 'a' }] },
      },
      { action: 'click', payload: { ref: 'button-1' } },
    ]) {
      expect(judge(toolInput)).toBe(GantryToolRiskVerdict.Low);
    }
    for (const toolInput of [
      null,
      { action: 'click' },
      { action: 'frobnicate_everything', payload: {} },
      { action: 'file_attach', payload: {} },
      { action: 'file_attach', payload: { paths: [] } },
      {
        action: 'file_attach',
        payload: { paths: ['/tmp/a'], files: [] },
      },
      {
        action: 'file_attach',
        payload: { source: { type: 'artifact' } },
      },
      {
        action: 'file_upload',
        payload: { source: { type: 'bytes' } },
      },
    ]) {
      expect(judge(toolInput)).toBe(GantryToolRiskVerdict.Ambiguous);
    }
  });
});

describe('gantryNativeCanonicalToolName', () => {
  it('distinguishes known, unknown namespaced, bare, and non-gantry names', () => {
    expect(gantryNativeCanonicalToolName('mcp__gantry__memory_save')).toEqual({
      canonical: 'memory_save',
      known: true,
    });
    expect(gantryNativeCanonicalToolName('memory_save')).toEqual({
      canonical: 'memory_save',
      known: true,
    });
    expect(gantryNativeCanonicalToolName('mcp__gantry__frobnicate')).toEqual({
      canonical: 'frobnicate',
      known: false,
    });
    expect(gantryNativeCanonicalToolName('Bash')).toBeNull();
    expect(gantryNativeCanonicalToolName('mcp__github__search')).toBeNull();
  });
});
