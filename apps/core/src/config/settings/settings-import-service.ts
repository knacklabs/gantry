import type { Pool } from 'pg';

import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import {
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '../../domain/mcp/mcp-servers.js';
import type {
  SettingsRevision,
  SettingsRevisionRepository,
} from '../../domain/ports/fleet-capability-state.js';
import type { RuntimeLeasePort } from '../../domain/ports/runtime-lease.js';
import { withSettingsProjectorLease } from '../../domain/ports/settings-projector-lease.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import {
  addAllMcpSourcesToRuntimeSettings,
  applyRuntimeSettingsDesiredState,
  snapshotConfiguredMcpBindingAuthority,
} from './restart-sync.js';
import { activateRuntimeModelAliases } from './runtime-settings.js';
import { normalizeConfiguredCapabilitiesInSettings } from './configured-capability-normalization.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
import { nextMcpCapabilityGrantTokens } from './mcp-capability-grant-provenance.js';
import {
  capturePendingMcpSourceEdits,
  restorePendingMcpSourceEdits,
} from './mcp-source-projection-preservation.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  SettingsRevisionConflictError,
  appendRejectedMcpApprovalRecoveryRevision,
  importFleetSettingsRevisionWithProjectionOps,
  settingsWithoutMcpCapabilityGrantTokens,
  validateProjectionPreconditions,
  validateSettingsForImport,
} from './settings-fleet-import.js';
import type {
  FleetImportDeps,
  FleetImportOptions,
  FleetImportOutcome,
  SettingsFleetProjectionOps,
  SettingsImportServiceDeps,
} from './settings-fleet-import.js';
import {
  agentIdsFromMcpBindingPreconditions,
  revisionDocumentMatchesSettings,
  revisionMcpBindingPreconditionsMatch,
  settingsFromRevisionDocument,
  stableJson,
} from './settings-revision-document.js';

export {
  CURRENT_SETTINGS_READER_VERSION,
  SettingsRevisionConflictError,
  validateSettingsForImport,
} from './settings-fleet-import.js';
export type {
  FleetImportDeps,
  FleetImportOptions,
  FleetImportOutcome,
  SettingsImportServiceDeps,
  SettingsImportValidationResult,
} from './settings-fleet-import.js';
export {
  settingsFromRevisionDocument,
  settingsMatchesLatestRevision,
  settingsToRevisionDocument,
  stableJson,
} from './settings-revision-document.js';

const SETTINGS_FLEET_PROJECTION_OPS: SettingsFleetProjectionOps = {
  addAllMcpSourcesToRuntimeSettings,
  snapshotConfiguredMcpBindingAuthority,
};

export async function importFleetSettingsRevision(
  deps: FleetImportDeps,
  settings: RuntimeSettings,
  options: FleetImportOptions = {},
): Promise<FleetImportOutcome> {
  return importFleetSettingsRevisionWithProjectionOps(
    deps,
    settings,
    options,
    SETTINGS_FLEET_PROJECTION_OPS,
  );
}

export interface SettingsRevisionMirror {
  settingsRevisions: SettingsRevisionRepository;
  /** Pool used to publish the `pg_notify` wakeup after a successful append. */
  pool?: Pool;
  createdBy: string;
  note?: string | null;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
}

export type WorkstationSettingsImportOutcome =
  | { status: 'revision_created'; revision: number }
  | { status: 'applied_no_revision' }
  | { status: 'no_op' };

export class SettingsStaleMutationError extends Error {
  constructor() {
    super(
      'Settings mutation is based on stale settings; reload latest desired state and retry.',
    );
    this.name = 'SettingsStaleMutationError';
  }
}

export class SettingsIncompatibleReaderError extends Error {
  constructor(
    readonly revision: number,
    readonly minReaderVersion: number,
    readonly readerVersion: number,
  ) {
    super(
      `Settings revision ${revision} requires settings reader version ` +
        `${minReaderVersion}; this runtime supports ${readerVersion}. ` +
        'Upgrade Gantry before applying this revision.',
    );
    this.name = 'SettingsIncompatibleReaderError';
  }
}

export async function applySettingsRevisionWithMcpFenceRecovery(input: {
  runtimeHome: string;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId: AppId;
  revision: SettingsRevision;
  reloadRuntimeState?: () => Promise<void>;
  revisionMirror: SettingsRevisionMirror;
  applySettings?: typeof importWorkstationSettings;
}): Promise<{ settings: RuntimeSettings; revision: number }> {
  let revision = input.revision;
  const applySettings = input.applySettings ?? importWorkstationSettings;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current =
      await input.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        input.appId,
      );
    if (current && current.revision > revision.revision) revision = current;
    if (revision.minReaderVersion > CURRENT_SETTINGS_READER_VERSION) {
      throw new Error(
        `Settings revision ${revision.revision} requires settings reader version ` +
          `${revision.minReaderVersion}; this runtime supports ${CURRENT_SETTINGS_READER_VERSION}. ` +
          'Upgrade Gantry before applying this revision.',
      );
    }
    const settings = settingsFromRevisionDocument(revision.settingsDocument);
    try {
      await applySettings(
        {
          runtimeHome: input.runtimeHome,
          ops: input.ops,
          repositories: input.repositories,
          appId: input.appId,
          projectionAuthority: 'revision',
          reloadRuntimeState: input.reloadRuntimeState,
          expectedMcpBindingAgentIds: revision.mcpBindingPreconditionAgentIds,
          expectedMcpBindings: revision.mcpBindingPreconditions,
        },
        settings,
      );
      return { settings, revision: revision.revision };
    } catch (err) {
      if (
        !(err instanceof McpBindingAuthorityChangedError) ||
        (revision.mcpBindingPreconditionAgentIds?.length ?? 0) === 0
      ) {
        throw err;
      }
      const predecessor =
        revision.revision > 1
          ? await input.revisionMirror.settingsRevisions.getSettingsRevision({
              appId: input.appId,
              revision: revision.revision - 1,
            })
          : null;
      await appendRejectedMcpApprovalRecoveryRevision({
        deps: {
          runtimeHome: input.runtimeHome,
          ops: input.ops,
          repositories: input.repositories,
          appId: input.appId,
          reloadRuntimeState: input.reloadRuntimeState,
          revisionMirror: input.revisionMirror,
          expectedMcpBindingAgentIds: revision.mcpBindingPreconditionAgentIds,
          expectedMcpBindings: revision.mcpBindingPreconditions,
        },
        appId: input.appId,
        failedRevision: revision.revision,
        previousSettings: predecessor
          ? settingsFromRevisionDocument(predecessor.settingsDocument)
          : settingsWithoutMcpCapabilityGrantTokens(
              settings,
              revision.mcpCapabilityGrantTokens,
            ),
        rejectedSettings: settings,
        rejectedMcpCapabilityGrantTokens: revision.mcpCapabilityGrantTokens,
        projectionOps: SETTINGS_FLEET_PROJECTION_OPS,
      });
      const latest =
        await input.revisionMirror.settingsRevisions.getLatestSettingsRevision(
          input.appId,
        );
      if (!latest || latest.revision <= revision.revision) {
        throw new Error(
          'MCP fence recovery did not publish a successor settings revision.',
        );
      }
      revision = latest;
    }
  }
  throw new Error(
    'MCP binding authority changed repeatedly during settings revision recovery.',
  );
}

/** Validate, append any required revision, then project the settings. */
export async function importWorkstationSettings(
  deps: SettingsImportServiceDeps & {
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
    revisionMirror?: SettingsRevisionMirror;
    revisionMirrorRequired?: boolean;
    expectedRevision?: number | null;
    expectedMcpBindingAgentIds?: AgentId[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    mcpCapabilityGrantTokens?: Record<string, string>;
    leases?: RuntimeLeasePort;
    projectionAuthority?: 'file' | 'revision';
  },
  settings: RuntimeSettings,
): Promise<WorkstationSettingsImportOutcome> {
  if (
    deps.revisionMirrorRequired &&
    (!deps.previousSettings || !deps.revisionMirror)
  ) {
    throw new Error(
      'Settings mutation requires previous settings and a settings revision mirror for stale revision protection.',
    );
  }
  if (deps.revisionMirrorRequired && !deps.leases) {
    throw new Error(
      'Settings mutation requires a runtime lease port for serialized projection.',
    );
  }
  if (deps.projectionAuthority !== 'revision' && !deps.previousSettings) {
    throw new Error('File-authority import requires previous settings.');
  }
  const validation = await validateSettingsForImport(deps, settings);
  if (!validation.ok) {
    throw new Error(
      ['settings validation failed.', ...validation.errors].join('\n'),
    );
  }
  const appId = deps.appId ?? ('default' as AppId);
  if (deps.revisionMirrorRequired && deps.revisionMirror) {
    const revisionSettings = (
      await normalizeConfiguredCapabilitiesInSettings({
        settings,
        repositories: deps.repositories,
        appId,
      })
    ).settings;
    const previousRevisionSettings = (
      await normalizeConfiguredCapabilitiesInSettings({
        settings: deps.previousSettings!,
        repositories: deps.repositories,
        appId,
      })
    ).settings;
    const latest =
      await deps.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        appId,
      );
    const actualRevision = latest?.revision ?? 0;
    if (
      deps.expectedRevision !== undefined &&
      deps.expectedRevision !== null &&
      deps.expectedRevision !== actualRevision
    ) {
      throw new SettingsRevisionConflictError({
        expectedRevision: deps.expectedRevision,
        actualRevision,
      });
    }
    if (
      latest &&
      !revisionDocumentMatchesSettings(
        latest.settingsDocument,
        previousRevisionSettings,
      )
    ) {
      throw new SettingsStaleMutationError();
    }
    let expectedMcpBindingAgentIds =
      deps.expectedMcpBindingAgentIds ??
      agentIdsFromMcpBindingPreconditions(deps.expectedMcpBindings);
    let expectedMcpBindings = deps.expectedMcpBindings;
    if (
      expectedMcpBindingAgentIds === undefined &&
      expectedMcpBindings === undefined &&
      (latest?.mcpBindingPreconditionAgentIds?.length ?? 0) > 0
    ) {
      const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
        settings: revisionSettings,
        agentIds: latest?.mcpBindingPreconditionAgentIds,
        bindings: latest?.mcpBindingPreconditions,
      });
      await addAllMcpSourcesToRuntimeSettings({
        settings: revisionSettings,
        repositories: deps.repositories,
        appId,
      });
      restorePendingMcpSourceEdits(revisionSettings, pendingMcpSourceEdits);
      const snapshot = await snapshotConfiguredMcpBindingAuthority({
        settings: revisionSettings,
        repositories: deps.repositories,
        appId,
        additionalAgentIds: latest?.mcpBindingPreconditionAgentIds,
      });
      expectedMcpBindingAgentIds = snapshot.agentIds;
      expectedMcpBindings = snapshot.bindings;
    }
    const prospectiveMcpCapabilityGrantTokens = nextMcpCapabilityGrantTokens({
      settings: revisionSettings,
      previous: latest?.mcpCapabilityGrantTokens,
      overrides: deps.mcpCapabilityGrantTokens,
    });
    if (
      latest &&
      revisionDocumentMatchesSettings(
        latest.settingsDocument,
        revisionSettings,
      ) &&
      revisionMcpBindingPreconditionsMatch(
        latest.mcpBindingPreconditionAgentIds,
        latest.mcpBindingPreconditions,
        expectedMcpBindingAgentIds,
        expectedMcpBindings,
      ) &&
      stableJson(latest.mcpCapabilityGrantTokens ?? {}) ===
        stableJson(prospectiveMcpCapabilityGrantTokens)
    ) {
      await projectRequiredSettingsRevision({
        deps,
        appId,
        revisionMirror: deps.revisionMirror,
        leases: deps.leases!,
        targetRevision: latest.revision,
        targetSettings: revisionSettings,
        expectedMcpBindingAgentIds,
        expectedMcpBindings,
      });
      return { status: 'no_op' };
    }
    await validateProjectionPreconditions({
      settings: revisionSettings,
      repositories: deps.repositories,
      appId,
    });
    const outcome = await importFleetSettingsRevision(
      {
        runtimeHome: deps.runtimeHome,
        ops: deps.ops,
        repositories: deps.repositories,
        appId: deps.appId,
        settingsRevisions: deps.revisionMirror.settingsRevisions,
        pool: deps.revisionMirror.pool,
        createdBy: deps.revisionMirror.createdBy,
        logWarn: deps.revisionMirror.logWarn,
      },
      revisionSettings,
      {
        expectedRevision: deps.expectedRevision ?? actualRevision,
        latestRevision: latest,
        expectedMcpBindingAgentIds,
        expectedMcpBindings,
        mcpCapabilityGrantTokens: deps.mcpCapabilityGrantTokens,
        note: deps.revisionMirror.note ?? null,
      },
    );
    if (outcome.status === 'invalid') {
      throw new Error(
        ['settings validation failed.', ...outcome.errors].join('\n'),
      );
    }
    if (outcome.status === 'conflict') {
      throw new SettingsRevisionConflictError(outcome);
    }
    try {
      await projectRequiredSettingsRevision({
        deps,
        appId,
        revisionMirror: deps.revisionMirror,
        leases: deps.leases!,
        targetRevision: outcome.revision,
        targetSettings: revisionSettings,
        expectedMcpBindingAgentIds,
        expectedMcpBindings,
      });
    } catch (err) {
      const hasRejectedMcpCapabilityGrant =
        Object.keys(deps.mcpCapabilityGrantTokens ?? {}).length > 0;
      if (
        hasRejectedMcpCapabilityGrant ||
        (err instanceof McpBindingAuthorityChangedError &&
          (expectedMcpBindingAgentIds?.length ?? 0) > 0)
      ) {
        await appendRejectedMcpApprovalRecoveryRevision({
          deps: {
            ...deps,
            revisionMirror: deps.revisionMirror,
            expectedMcpBindingAgentIds,
            expectedMcpBindings,
          },
          appId,
          failedRevision: outcome.revision,
          previousSettings: previousRevisionSettings,
          rejectedSettings: revisionSettings,
          rejectedMcpCapabilityGrantTokens: deps.mcpCapabilityGrantTokens,
          projectionOps: SETTINGS_FLEET_PROJECTION_OPS,
        });
      }
      throw err;
    }
    return { status: 'revision_created', revision: outcome.revision };
  }
  const appliedSettings = await applyRuntimeSettingsDesiredState({
    runtimeHome: deps.runtimeHome,
    settings,
    ops: deps.ops,
    repositories: deps.repositories,
    appId: deps.appId,
    forwardCorrected: deps.projectionAuthority === 'revision',
    previousSettings: deps.previousSettings,
    reloadRuntimeState: deps.reloadRuntimeState,
    expectedMcpBindingAgentIds: deps.expectedMcpBindingAgentIds,
    expectedMcpBindings: deps.expectedMcpBindings,
  });
  activateRuntimeModelAliases(appliedSettings);
  if (!deps.revisionMirror) return { status: 'applied_no_revision' };
  try {
    const latest =
      await deps.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        appId,
      );
    let mirrorMcpBindingAgentIds =
      deps.expectedMcpBindingAgentIds ??
      agentIdsFromMcpBindingPreconditions(deps.expectedMcpBindings);
    let mirrorMcpBindings = deps.expectedMcpBindings;
    if (
      mirrorMcpBindingAgentIds === undefined &&
      mirrorMcpBindings === undefined &&
      (latest?.mcpBindingPreconditionAgentIds?.length ?? 0) > 0
    ) {
      const snapshot = await snapshotConfiguredMcpBindingAuthority({
        settings: appliedSettings,
        repositories: deps.repositories,
        appId,
        additionalAgentIds: latest?.mcpBindingPreconditionAgentIds,
      });
      mirrorMcpBindingAgentIds = snapshot.agentIds;
      mirrorMcpBindings = snapshot.bindings;
    }
    if (
      latest &&
      revisionDocumentMatchesSettings(
        latest.settingsDocument,
        appliedSettings,
      ) &&
      revisionMcpBindingPreconditionsMatch(
        latest.mcpBindingPreconditionAgentIds,
        latest.mcpBindingPreconditions,
        mirrorMcpBindingAgentIds,
        mirrorMcpBindings,
      )
    ) {
      return { status: 'applied_no_revision' };
    }
    const outcome = await importFleetSettingsRevision(
      {
        runtimeHome: deps.runtimeHome,
        ops: deps.ops,
        repositories: deps.repositories,
        appId: deps.appId,
        settingsRevisions: deps.revisionMirror.settingsRevisions,
        pool: deps.revisionMirror.pool,
        createdBy: deps.revisionMirror.createdBy,
        logWarn: deps.revisionMirror.logWarn,
      },
      appliedSettings,
      {
        expectedRevision:
          mirrorMcpBindingAgentIds !== undefined ||
          mirrorMcpBindings !== undefined
            ? (latest?.revision ?? 0)
            : undefined,
        expectedMcpBindingAgentIds: mirrorMcpBindingAgentIds,
        expectedMcpBindings: mirrorMcpBindings,
        mcpCapabilityGrantTokens: deps.mcpCapabilityGrantTokens,
        note: deps.revisionMirror.note ?? null,
      },
    );
    if (outcome.status === 'invalid') {
      const error = new Error(
        ['settings validation failed.', ...outcome.errors].join('\n'),
      );
      if (deps.revisionMirrorRequired) throw error;
      deps.revisionMirror.logWarn?.(
        { errors: outcome.errors },
        'settings revision mirror failed validation after workstation settings applied',
      );
      return { status: 'applied_no_revision' };
    }
    if (outcome.status === 'conflict') {
      const error = new Error(
        `settings revision conflicted: expected revision ${outcome.expectedRevision}, actual revision ${outcome.actualRevision}`,
      );
      if (deps.revisionMirrorRequired) throw error;
      deps.revisionMirror.logWarn?.(
        {
          expectedRevision: outcome.expectedRevision,
          actualRevision: outcome.actualRevision,
        },
        'settings revision mirror conflicted after workstation settings applied',
      );
      return { status: 'applied_no_revision' };
    }
    return { status: 'revision_created', revision: outcome.revision };
  } catch (err) {
    deps.revisionMirror.logWarn?.(
      { err },
      'settings revision mirror failed after workstation settings applied',
    );
    return { status: 'applied_no_revision' };
  }
}
async function projectRequiredSettingsRevision(input: {
  deps: SettingsImportServiceDeps & {
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
  };
  appId: AppId;
  revisionMirror: SettingsRevisionMirror;
  leases: RuntimeLeasePort;
  targetRevision: number;
  targetSettings: RuntimeSettings;
  expectedMcpBindingAgentIds?: AgentId[];
  expectedMcpBindings?: McpBindingAuthorityPrecondition[];
}): Promise<RuntimeSettings> {
  return withSettingsProjectorLease(input.leases, input.appId, async () => {
    const head =
      await input.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        input.appId,
      );
    if (!head || head.revision < input.targetRevision) {
      throw new Error(
        `Settings projection revision ${input.targetRevision} is not present at the current head`,
      );
    }
    const projectsTarget = head.revision === input.targetRevision;
    if (head.minReaderVersion > CURRENT_SETTINGS_READER_VERSION) {
      throw new SettingsIncompatibleReaderError(
        head.revision,
        head.minReaderVersion,
        CURRENT_SETTINGS_READER_VERSION,
      );
    }
    const settings = projectsTarget
      ? input.targetSettings
      : settingsFromRevisionDocument(head.settingsDocument);
    const appliedSettings = await applyRuntimeSettingsDesiredState({
      runtimeHome: input.deps.runtimeHome,
      settings,
      ops: input.deps.ops,
      repositories: input.deps.repositories,
      appId: input.appId,
      forwardCorrected: true,
      reloadRuntimeState: input.deps.reloadRuntimeState,
      expectedMcpBindingAgentIds: input.expectedMcpBindingAgentIds,
      expectedMcpBindings: input.expectedMcpBindings,
    });
    activateRuntimeModelAliases(appliedSettings);
    return appliedSettings;
  });
}
