import {
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
  type HumanDecisionOutcome,
  type HumanDecisionScope,
} from '../../domain/ports/permission-decision-memory.js';
import {
  encodeHumanDecisionProvenance,
  type HumanDecisionRememberRequest,
  isRememberResolution,
} from '../../domain/human-decision.js';
import {
  isHumanDecisionId,
  newHumanDecisionId,
} from '../../shared/human-decision-id.js';
import { nowIso as currentIso } from '../../shared/time/datetime.js';
import { gantryNativeCanonicalToolName } from './gantry-tool-risk.js';
import {
  deriveHumanDecisionScopeKey,
  type HumanDecisionNotRememberableReason,
} from './human-decision-scope.js';

export type HumanDecisionServiceRefusal =
  | HumanDecisionNotRememberableReason
  | 'unresolved_person'
  | 'once_never_remembered';

export type HumanDecisionMemoryListRow = PermissionDecisionMemoryRow & {
  shortId: string;
};

export interface HumanDecisionDerivedRememberRequest {
  appId: string;
  agentFolder: string;
  actingPersonId: string;
  actingPersonLabel?: string;
  canonicalTool: string;
  outcome: HumanDecisionOutcome;
  scope: HumanDecisionScope;
  scopeKey: string;
  pathOnly: boolean;
  effectHash?: string;
  effectSchemaVersion: number;
  railVersion: number;
  reason: string;
}

export type HumanDecisionRememberResult =
  | {
      status: 'remembered';
      id: string;
      shortId: string;
      scopeKey: string;
      pathOnly: boolean;
      stored: 'inserted' | 'refreshed';
    }
  | { status: 'not_rememberable'; reason: HumanDecisionServiceRefusal };

export class HumanDecisionMemoryService {
  private readonly repository: PermissionDecisionMemoryRepository;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor({
    repository,
    newId = newHumanDecisionId,
    now = currentIso,
  }: {
    repository: PermissionDecisionMemoryRepository;
    newId?: () => string;
    now?: () => string;
  }) {
    this.repository = repository;
    this.newId = newId;
    this.now = now;
  }

  async remember(
    dto: HumanDecisionRememberRequest,
  ): Promise<HumanDecisionRememberResult> {
    if (!dto.actingPersonId.trim()) {
      return { status: 'not_rememberable', reason: 'unresolved_person' };
    }
    if (!isRememberResolution(dto.resolution)) {
      return { status: 'not_rememberable', reason: 'once_never_remembered' };
    }
    const derived = await deriveHumanDecisionScopeKey({
      outcome: dto.resolution.outcome,
      scope: dto.resolution.scope,
      request: dto.request,
      effectHash: dto.effectHash,
      workspaceRoot: dto.workspaceRoot,
      canonicalRoot: dto.canonicalRoot,
      trustGrowthTool: dto.trustGrowthTool,
    });
    if (!derived.ok) {
      return { status: 'not_rememberable', reason: derived.reason };
    }
    const canonicalTool =
      gantryNativeCanonicalToolName(dto.request.toolName)?.canonical ??
      dto.request.toolName;
    return this.rememberDerived({
      appId: dto.appId,
      agentFolder: dto.agentFolder,
      actingPersonId: dto.actingPersonId,
      ...(dto.actingPersonLabel
        ? { actingPersonLabel: dto.actingPersonLabel }
        : {}),
      canonicalTool,
      outcome: dto.resolution.outcome,
      scope: dto.resolution.scope,
      scopeKey: derived.scopeKey,
      pathOnly: derived.pathOnly,
      ...(dto.effectHash ? { effectHash: dto.effectHash } : {}),
      effectSchemaVersion: dto.effectSchemaVersion,
      railVersion: dto.railVersion,
      reason: dto.reason,
    });
  }

  async rememberDerived(
    dto: HumanDecisionDerivedRememberRequest,
  ): Promise<HumanDecisionRememberResult> {
    if (!dto.actingPersonId.trim()) {
      return { status: 'not_rememberable', reason: 'unresolved_person' };
    }
    if (!dto.scopeKey.trim()) {
      return { status: 'not_rememberable', reason: 'incomplete_effect' };
    }
    if (dto.outcome === 'deny' && dto.scope !== 'exact') {
      return { status: 'not_rememberable', reason: 'deny_requires_exact' };
    }
    const id = this.newId();
    if (!isHumanDecisionId(id)) {
      throw new TypeError('Human decision id must be a UUID v4');
    }
    const stored = await this.repository.putHumanDecision({
      id,
      appId: dto.appId,
      agentFolder: dto.agentFolder,
      outcome: dto.outcome,
      scope: dto.scope,
      scopeKey: dto.scopeKey,
      actingPersonId: dto.actingPersonId,
      actingPersonLabel: dto.actingPersonLabel,
      canonicalTool: dto.canonicalTool,
      reason: dto.reason,
      effectSchemaVersion: dto.effectSchemaVersion,
      railVersion: dto.railVersion,
      provenance: encodeHumanDecisionProvenance({
        id,
        actingPersonId: dto.actingPersonId,
        outcome: dto.outcome,
        scope: dto.scope,
        railVersion: dto.railVersion,
      }),
      nowIso: this.now(),
      effectHash: dto.effectHash,
    });
    const siblings = await this.repository.listHumanDecisions({
      appId: dto.appId,
      agentFolder: dto.agentFolder,
      actingPersonId: dto.actingPersonId,
    });
    const activeIds = new Set(siblings.map((row) => row.id));
    activeIds.add(stored.id);
    const shortId = deriveHumanDecisionShortIds([...activeIds]).get(stored.id);
    if (shortId === undefined) {
      throw new Error('Human decision short id derivation failed');
    }
    return {
      status: 'remembered',
      id: stored.id,
      shortId,
      scopeKey: dto.scopeKey,
      pathOnly: dto.pathOnly,
      stored: stored.status,
    };
  }

  async list(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    limit?: number;
  }): Promise<HumanDecisionMemoryListRow[]> {
    const rows = await this.repository.listHumanDecisions(input);
    const ids = rows.map((row) => row.id);
    const shortIds = deriveHumanDecisionShortIds(ids);
    const withShortIds = rows.map((row) => ({
      ...row,
      shortId: shortIds.get(row.id)!,
    }));
    return input.limit === undefined
      ? withShortIds
      : withShortIds.slice(0, Math.max(0, input.limit));
  }

  revoke(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    recordId: string;
  }) {
    return this.repository.revokeById({ ...input, nowIso: this.now() });
  }

  countExactAllowsByTool(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
  }) {
    return this.repository.countExactAllowsByTool(input);
  }
}

export function deriveHumanDecisionShortIds(
  ids: string[],
): Map<string, string> {
  const idsByNormalized = new Map<string, string[]>();
  for (const id of ids) {
    const normalized = id.replaceAll('-', '').toLowerCase();
    const originals = idsByNormalized.get(normalized);
    if (originals) originals.push(id);
    else idsByNormalized.set(normalized, [id]);
  }

  const shortIds = new Map<string, string>();
  const unresolved = new Set(idsByNormalized.keys());
  for (let length = 6; unresolved.size > 0; length += 1) {
    const counts = new Map<string, number>();
    for (const normalized of unresolved) {
      const prefix = normalized.slice(0, length);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    for (const normalized of unresolved) {
      const prefix = normalized.slice(0, length);
      if (counts.get(prefix) === 1 || length >= normalized.length) {
        for (const id of idsByNormalized.get(normalized)!) {
          shortIds.set(id, prefix);
        }
        unresolved.delete(normalized);
      }
    }
  }
  return shortIds;
}
