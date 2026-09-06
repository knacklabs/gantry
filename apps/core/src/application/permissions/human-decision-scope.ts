import { isProtectedArtifactEntry } from '../../domain/file-artifacts/protected-virtual-path.js';
import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../../domain/file-artifacts/virtual-path.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type HumanDecisionOutcome as HumanDecisionOutcomeValue,
  type HumanDecisionScope as HumanDecisionScopeValue,
} from '../../domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import { parseBashCommand } from '../../shared/bash-command-parser.js';
import {
  classifyPermissionEffectShape,
  PermissionEffectShape,
} from '../../shared/permission-effect-shape.js';
import { evaluateProspectiveWriteBoundary } from '../../shared/permission-prospective-write.js';
import { gantryNativeCanonicalToolName } from './gantry-tool-risk.js';

export const HumanDecisionNotRememberableReason = {
  ProtectedDestination: 'protected_destination',
  NoCategory: 'no_category',
  NoRoot: 'no_root',
  IncompleteEffect: 'incomplete_effect',
  DenyRequiresExact: 'deny_requires_exact',
} as const;
export type HumanDecisionNotRememberableReason =
  (typeof HumanDecisionNotRememberableReason)[keyof typeof HumanDecisionNotRememberableReason];

export const HumanDecisionKindCategory = {
  ReadOnlyCommand: 'read_only_command',
  FileRead: 'file_read',
  VirtualFileRead: 'virtual_file_read',
  WebSearch: 'web_search',
  WebRead: 'web_read',
} as const;
export type HumanDecisionKindCategory =
  (typeof HumanDecisionKindCategory)[keyof typeof HumanDecisionKindCategory];

export type HumanDecisionScopeKeyResult =
  | { ok: true; scopeKey: string; pathOnly: boolean }
  | { ok: false; reason: HumanDecisionNotRememberableReason };

export async function deriveHumanDecisionScopeKey(input: {
  outcome: HumanDecisionOutcomeValue;
  scope: HumanDecisionScopeValue;
  request: PermissionApprovalRequest;
  effectHash?: string;
  workspaceRoot?: string;
  canonicalRoot?: string;
  trustGrowthTool?: boolean;
}): Promise<HumanDecisionScopeKeyResult> {
  if (
    input.outcome === HumanDecisionOutcome.Deny &&
    input.scope !== HumanDecisionScope.Exact
  ) {
    return refused(HumanDecisionNotRememberableReason.DenyRequiresExact);
  }
  const canonicalTool =
    gantryNativeCanonicalToolName(input.request.toolName)?.canonical ??
    input.request.toolName;
  if (input.scope === HumanDecisionScope.Kind) {
    return deriveKindScope(input.request, canonicalTool, input.trustGrowthTool);
  }
  if (input.scope === HumanDecisionScope.Place) {
    const root = input.canonicalRoot?.trim();
    return root
      ? remembered(`place:${root}`)
      : refused(HumanDecisionNotRememberableReason.NoRoot);
  }
  if (input.outcome === HumanDecisionOutcome.Deny) {
    return fullEffect(input.effectHash);
  }
  if (canonicalTool === 'FileWrite' || canonicalTool === 'FileEdit') {
    const native = await deriveNativeWriteScope({
      canonicalTool,
      request: input.request,
      workspaceRoot: input.workspaceRoot,
    });
    return native ?? fullEffect(input.effectHash);
  }
  if (canonicalTool === 'file') {
    const virtual = deriveVirtualWriteScope(input.request, canonicalTool);
    return virtual ?? fullEffect(input.effectHash);
  }
  return fullEffect(input.effectHash);
}

async function deriveNativeWriteScope(input: {
  canonicalTool: string;
  request: PermissionApprovalRequest;
  workspaceRoot?: string;
}): Promise<HumanDecisionScopeKeyResult | undefined> {
  const toolInput = decisionToolInput(input.request);
  if (!toolInput) return undefined;
  if (
    (toolInput.file_path !== undefined &&
      typeof toolInput.file_path !== 'string') ||
    (toolInput.path !== undefined && typeof toolInput.path !== 'string')
  ) {
    return undefined;
  }
  const destinations = [toolInput.file_path, toolInput.path].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  const canonicalPaths: string[] = [];
  for (const candidatePath of destinations) {
    const boundary = await evaluateProspectiveWriteBoundary({
      workspaceRoot: input.workspaceRoot,
      candidatePath,
    });
    if (!boundary.inside) {
      return refused(HumanDecisionNotRememberableReason.ProtectedDestination);
    }
    canonicalPaths.push(boundary.canonicalPath);
  }
  return canonicalPaths.length === 1
    ? remembered(`exact:path:${input.canonicalTool}:${canonicalPaths[0]}`, true)
    : undefined;
}

function deriveVirtualWriteScope(
  request: PermissionApprovalRequest,
  canonicalTool: string,
): HumanDecisionScopeKeyResult | undefined {
  const toolInput = decisionToolInput(request);
  if (!toolInput || toolInput.protected === true) {
    return toolInput?.protected === true
      ? refused(HumanDecisionNotRememberableReason.ProtectedDestination)
      : undefined;
  }
  if (
    toolInput.protected !== undefined &&
    typeof toolInput.protected !== 'boolean'
  ) {
    return undefined;
  }
  try {
    let scope: string;
    let path: string;
    if (toolInput.action === 'write') {
      if (
        typeof toolInput.path !== 'string' ||
        typeof toolInput.content !== 'string' ||
        (toolInput.scope !== undefined && typeof toolInput.scope !== 'string')
      ) {
        return undefined;
      }
      scope = normalizeFileArtifactScope(toolInput.scope);
      path = normalizeFileArtifactPath(toolInput.path);
    } else if (toolInput.action === 'promote_scratch') {
      if (
        typeof toolInput.path !== 'string' ||
        typeof toolInput.targetPath !== 'string' ||
        (toolInput.targetScope !== undefined &&
          typeof toolInput.targetScope !== 'string')
      ) {
        return undefined;
      }
      normalizeFileArtifactPath(toolInput.path);
      scope = normalizeFileArtifactScope(toolInput.targetScope);
      path = normalizeFileArtifactPath(toolInput.targetPath);
    } else {
      return undefined;
    }
    return isProtectedArtifactEntry(scope, path)
      ? refused(HumanDecisionNotRememberableReason.ProtectedDestination)
      : remembered(`exact:path:${canonicalTool}:${scope}/${path}`, true);
  } catch {
    return undefined;
  }
}

function deriveKindScope(
  request: PermissionApprovalRequest,
  canonicalTool: string,
  trustGrowthTool: boolean | undefined,
): HumanDecisionScopeKeyResult {
  if (trustGrowthTool) return remembered(`kind:tool:${canonicalTool}`);
  if (canonicalTool === 'Bash' || canonicalTool === 'RunCommand') {
    const toolInput = decisionToolInput(request);
    const command = toolInput?.command ?? toolInput?.cmd;
    if (typeof command !== 'string' || !command.trim()) {
      return refused(HumanDecisionNotRememberableReason.NoCategory);
    }
    const parsed = parseBashCommand(command);
    if (!parsed.ok || parsed.leaves.length === 0) {
      return refused(HumanDecisionNotRememberableReason.NoCategory);
    }
    const stdinOk = parsed.leaves.length > 1;
    const shapes = parsed.leaves.map((leaf) =>
      classifyPermissionEffectShape(leaf, { stdinOk }),
    );
    if (
      shapes.some((shape) => shape.kind === PermissionEffectShape.NotReadOnly)
    ) {
      return refused(HumanDecisionNotRememberableReason.NoCategory);
    }
    const category = shapes.every(
      (shape) => shape.kind === PermissionEffectShape.FileRead,
    )
      ? HumanDecisionKindCategory.FileRead
      : HumanDecisionKindCategory.ReadOnlyCommand;
    return remembered(`kind:${category}`);
  }
  const toolInput = decisionToolInput(request);
  if (
    canonicalTool === 'file' &&
    (toolInput?.action === 'list' || toolInput?.action === 'read')
  ) {
    return remembered(`kind:${HumanDecisionKindCategory.VirtualFileRead}`);
  }
  if (canonicalTool === 'WebSearch') {
    return remembered(`kind:${HumanDecisionKindCategory.WebSearch}`);
  }
  if (canonicalTool === 'WebRead') {
    return remembered(`kind:${HumanDecisionKindCategory.WebRead}`);
  }
  return refused(HumanDecisionNotRememberableReason.NoCategory);
}

function decisionToolInput(
  request: PermissionApprovalRequest,
): Record<string, unknown> | undefined {
  const value = request.classifierToolInput ?? request.toolInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function fullEffect(
  effectHash: string | undefined,
): HumanDecisionScopeKeyResult {
  return effectHash === undefined
    ? refused(HumanDecisionNotRememberableReason.IncompleteEffect)
    : remembered(effectHash);
}

function remembered(
  scopeKey: string,
  pathOnly = false,
): HumanDecisionScopeKeyResult {
  return { ok: true, scopeKey, pathOnly };
}

function refused(
  reason: HumanDecisionNotRememberableReason,
): HumanDecisionScopeKeyResult {
  return { ok: false, reason };
}
