import type { Pool } from 'pg';

import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import { SettingsDesiredStateService } from './desired-state-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import { applyRuntimeSettingsDesiredState } from './restart-sync.js';
import {
  activateRuntimeModelAliases,
  withRuntimeModelAliases,
} from './runtime-settings.js';
import { normalizeConfiguredCapabilitiesInSettings } from './configured-capability-normalization.js';
import { parseRuntimeSettingsObject } from './runtime-settings-parser.js';
import { validateLoadedRuntimeSettings } from './runtime-settings-validation.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
import {
  PostgresSettingsRevisionNotifier,
  type SettingsRevisionWakeup,
} from './settings-revision-notify.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import { migrateLegacyAgentBindings } from './settings-revision-legacy-bindings.js';

/**
 * Reader version of the settings-revision contract this build understands. A
 * revision stamped with a higher `min_reader_version` than this is held (not
 * applied) by an older worker until it is upgraded (ADR-3 skew safety contract).
 * Bump this whenever a settings-schema change would break older readers.
 */
export const CURRENT_SETTINGS_READER_VERSION = 12;

export interface SettingsImportValidationResult {
  ok: boolean;
  settings: RuntimeSettings;
  /** Path-level error strings, identical for the YAML and API surfaces. */
  errors: string[];
}

export interface SettingsImportServiceDeps {
  runtimeHome: string;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
}

export interface SettingsRevisionMirror {
  settingsRevisions: SettingsRevisionRepository;
  /** Pool used to publish the `pg_notify` wakeup after a successful append. */
  pool?: Pool;
  createdBy: string;
  note?: string | null;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
}

export class SettingsRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(input: {
    expectedRevision: number;
    actualRevision: number;
    message?: string;
  }) {
    super(
      input.message ??
        `settings revision conflicted: expected revision ${input.expectedRevision}, actual revision ${input.actualRevision}`,
    );
    this.name = 'SettingsRevisionConflictError';
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
  }
}

/**
 * The single validation path shared by every settings mutation surface (YAML
 * watcher auto-import, CLI `settings import`, and the control-API desired-state
 * update). Schema/path-level validation runs through `validateLoadedRuntimeSettings`
 * and capability-reference validation runs through the desired-state service, so
 * the workstation file and the fleet revision produce identical errors (ADR-3:
 * one mutation path, one validation, no authority fork).
 */
export async function validateSettingsForImport(
  deps: SettingsImportServiceDeps,
  settings: RuntimeSettings,
): Promise<SettingsImportValidationResult> {
  const errors: string[] = [];
  const schema = withRuntimeModelAliases(settings, () =>
    validateLoadedRuntimeSettings(deps.runtimeHome, settings),
  );
  if (!schema.ok && schema.failure) {
    errors.push(...schema.failure.details);
  }
  const service = new SettingsDesiredStateService({
    ops: deps.ops,
    repositories: deps.repositories,
    appId: deps.appId,
  });
  const invalidReferences =
    await service.validateCapabilityReferences(settings);
  errors.push(...invalidReferences);
  return { ok: errors.length === 0, settings, errors };
}

/**
 * Workstation import: validate, then write `settings.yaml` and reconcile through
 * the existing desired-state apply path. When a required revision mirror is
 * provided, append the `settings_revisions` row before mutating local runtime
 * projection. Fleet authority is the revision log; a failed local projection can
 * be retried from that committed revision without accepting an uncommitted file
 * change.
 */
export async function importWorkstationSettings(
  deps: SettingsImportServiceDeps & {
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
    revisionMirror?: SettingsRevisionMirror;
    revisionMirrorRequired?: boolean;
    expectedRevision?: number | null;
  },
  settings: RuntimeSettings,
): Promise<{ revision?: number }> {
  if (
    deps.revisionMirrorRequired &&
    (!deps.previousSettings || !deps.revisionMirror)
  ) {
    throw new Error(
      'Settings mutation requires previous settings and a settings revision mirror for stale revision protection.',
    );
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
      throw new Error(
        'Settings mutation is based on stale settings; reload latest desired state and retry.',
      );
    }
    if (
      latest &&
      revisionDocumentMatchesSettings(latest.settingsDocument, revisionSettings)
    ) {
      await applyRuntimeSettingsDesiredState({
        runtimeHome: deps.runtimeHome,
        settings: revisionSettings,
        ops: deps.ops,
        repositories: deps.repositories,
        appId: deps.appId,
        previousSettings: deps.previousSettings,
        reloadRuntimeState: deps.reloadRuntimeState,
      });
      activateRuntimeModelAliases(revisionSettings);
      return {};
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
    const appliedSettings = await applyRuntimeSettingsDesiredState({
      runtimeHome: deps.runtimeHome,
      settings: revisionSettings,
      ops: deps.ops,
      repositories: deps.repositories,
      appId: deps.appId,
      previousSettings: deps.previousSettings,
      reloadRuntimeState: deps.reloadRuntimeState,
    });
    activateRuntimeModelAliases(appliedSettings);
    return { revision: outcome.revision };
  }
  const appliedSettings = await applyRuntimeSettingsDesiredState({
    runtimeHome: deps.runtimeHome,
    settings,
    ops: deps.ops,
    repositories: deps.repositories,
    appId: deps.appId,
    previousSettings: deps.previousSettings,
    reloadRuntimeState: deps.reloadRuntimeState,
  });
  activateRuntimeModelAliases(appliedSettings);
  if (!deps.revisionMirror) return {};
  try {
    const latest =
      await deps.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        appId,
      );
    if (
      latest &&
      revisionDocumentMatchesSettings(latest.settingsDocument, appliedSettings)
    ) {
      return {};
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
      return {};
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
      return {};
    }
    return { revision: outcome.revision };
  } catch (err) {
    deps.revisionMirror.logWarn?.(
      { err },
      'settings revision mirror failed after workstation settings applied',
    );
    return {};
  }
}

export type FleetImportOutcome =
  | { status: 'applied'; revision: number }
  | { status: 'invalid'; errors: string[] }
  | { status: 'conflict'; expectedRevision: number; actualRevision: number };

export interface FleetImportDeps extends SettingsImportServiceDeps {
  settingsRevisions: SettingsRevisionRepository;
  /** Pool used to publish the `pg_notify` wakeup after a successful append. */
  pool?: Pool;
  createdBy: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
}

/**
 * Fleet import: validate through the same path, enforce stale-revision
 * optimistic concurrency, append a `settings_revisions` row carrying
 * `CURRENT_SETTINGS_READER_VERSION`, and publish a `pg_notify` wakeup. Workers
 * converge by fetching the latest revision (NOTIFY + poll fallback). The
 * desired-state authority in fleet is Postgres, not the file (ADR-3).
 */
export async function importFleetSettingsRevision(
  deps: FleetImportDeps,
  settings: RuntimeSettings,
  options: { expectedRevision?: number | null; note?: string | null } = {},
): Promise<FleetImportOutcome> {
  const validation = await validateSettingsForImport(deps, settings);
  if (!validation.ok) {
    return { status: 'invalid', errors: validation.errors };
  }
  const appId = deps.appId ?? ('default' as AppId);
  // Optimistic concurrency lives in the repository: with expectedRevision the
  // append is a conditional insert at exactly expectedRevision + 1 — no
  // check-then-act window, no retry past a conflict. The loser of a concurrent
  // same-expectation race gets the contracted conflict, never a silent append.
  const appended = await deps.settingsRevisions.appendSettingsRevision({
    appId,
    settingsDocument: settingsToRevisionDocument(settings),
    minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
    createdBy: deps.createdBy,
    note: options.note ?? null,
    expectedRevision: options.expectedRevision ?? null,
  });
  if (appended.status === 'conflict') {
    return {
      status: 'conflict',
      expectedRevision: appended.expectedRevision,
      actualRevision: appended.actualRevision,
    };
  }
  if (deps.pool) {
    const notifier = new PostgresSettingsRevisionNotifier(
      deps.pool,
      deps.logWarn,
    );
    const wakeup: SettingsRevisionWakeup = {
      appId,
      revision: appended.revision.revision,
    };
    await notifier.notifyRevisionChanged(wakeup);
  }
  return { status: 'applied', revision: appended.revision.revision };
}

/**
 * Serialize desired state into the typed JSON settings document that the
 * control API/SDK transport and `settings_revisions` store as jsonb. YAML is the
 * human file format for the workstation file + CLI `--file` edge only; it never
 * appears on the wire. The document is the parser's native snake_case object
 * form, built directly from RuntimeSettings so JSON strings and numbers stay
 * lossless.
 */
export function settingsToRevisionDocument(
  settings: RuntimeSettings,
): Record<string, unknown> {
  return stripUndefinedDeep({
    desired_state: snakeRecord(settings.desiredState),
    providers: mapRecord(settings.providers, snakeRecord),
    provider_accounts: mapRecord(settings.providerAccounts, (account) => ({
      agent: account.agentId,
      provider: account.provider,
      label: account.label,
      status: account.status === 'disabled' ? account.status : undefined,
      runtime_secret_refs: account.runtimeSecretRefs,
      external_identity_ref: account.externalIdentityRef,
      config:
        Object.keys(account.config ?? {}).length > 0
          ? account.config
          : undefined,
    })),
    conversations: mapRecord(settings.conversations, (conversation) => ({
      provider_account:
        conversation.providerAccount ?? conversation.providerConnection,
      external_id: conversation.externalId,
      kind: conversation.kind,
      display_name: conversation.displayName,
      brain_harvest: conversation.brainHarvest ? true : undefined,
      sender_policy: conversation.senderPolicy,
      control_approvers: conversation.controlApprovers,
      installed_agents: Object.fromEntries(
        Object.entries(conversation.installedAgents).map(
          ([installId, install]) => [
            installId,
            {
              provider_account: install.providerAccountId,
              agent:
                installId === install.agentId ? undefined : install.agentId,
              thread_id: install.threadId,
              status: install.status,
              added_at: install.addedAt,
              memory_scope: install.memoryScope,
              trigger: install.trigger,
              requires_trigger: install.requiresTrigger,
              model: install.model,
              permission_mode: install.permissionMode,
            },
          ],
        ),
      ),
    })),
    agents: mapRecord(settings.agents, (agent) => ({
      name: agent.name,
      persona: agent.persona,
      relationship_mode:
        agent.relationshipMode && agent.relationshipMode !== 'personal'
          ? agent.relationshipMode
          : undefined,
      runtime: agent.runtime === 'inline' ? 'inline' : undefined,
      max_turns: agent.maxTurns,
      max_run_tokens: agent.maxRunTokens,
      effort: agent.effort,
      thinking:
        agent.thinking?.budgetTokens === undefined
          ? agent.thinking?.mode
          : {
              mode: agent.thinking.mode,
              budget_tokens: agent.thinking.budgetTokens,
            },
      max_output_tokens: agent.maxOutputTokens,
      model: agent.model,
      agent_harness: agent.agentHarness,
      permission_mode: agent.permissionMode,
      one_time_job_default_model: agent.oneTimeJobDefaultModel,
      recurring_job_default_model: agent.recurringJobDefaultModel,
      tool_rules:
        agent.toolRules && agent.toolRules.length > 0
          ? agent.toolRules
          : undefined,
      access: {
        preset: agent.accessPreset,
        sources: {
          skills: agent.sources.skills.map(snakeRecord),
          mcp_servers: agent.sources.mcpServers.map(snakeRecord),
          tools: agent.sources.tools.map(snakeRecord),
        },
        selections: agent.capabilities.map(snakeRecord),
      },
    })),
    storage: {
      postgres: {
        url_env: settings.storage.postgres.urlEnv,
        schema: settings.storage.postgres.schema,
      },
    },
    agent: {
      name: settings.agent.name,
      default_model: settings.agent.defaultModel,
      agent_harness: settings.agent.agentHarness,
      one_time_job_default_model: settings.agent.oneTimeJobDefaultModel,
      recurring_job_default_model: settings.agent.recurringJobDefaultModel,
      sessions: {
        memory_item_limit: settings.agent.sessions.memoryItemLimit,
        max_memory_context_chars: settings.agent.sessions.maxMemoryContextChars,
      },
    },
    model_access: {
      enabled: settings.credentialBroker.mode === 'gantry',
      gateway: {
        bind_host: settings.credentialBroker.gateway.bindHost,
      },
    },
    memory: snakeRecord(settings.memory),
    runtime: snakeRecord(settings.runtime),
    browser: {
      usage: {
        enabled: settings.browser.usage.enabled,
        mode: settings.browser.usage.mode,
        window_ms: settings.browser.usage.windowMs,
        max_actions_per_window: settings.browser.usage.maxActionsPerWindow,
        max_concurrent_per_site: settings.browser.usage.maxConcurrentPerSite,
        overrides: mapRecord(settings.browser.usage.overrides, snakeRecord),
      },
    },
    permissions: snakeRecord(settings.permissions),
    model_aliases: mapRecord(settings.modelAliases, snakeRecord),
    limits: mapRecord(settings.limits.providers, snakeRecord),
    model_families: settings.modelFamilies,
  }) as Record<string, unknown>;
}

/** Re-hydrate a typed settings document back into typed runtime settings. */
export function settingsFromRevisionDocument(
  document: Record<string, unknown>,
): RuntimeSettings {
  return parseRuntimeSettingsObject(migrateLegacyAgentBindings(document));
}

export async function settingsMatchesLatestRevision(input: {
  appId: AppId;
  settings: RuntimeSettings;
  settingsRevisions: SettingsRevisionRepository;
}): Promise<boolean> {
  const latest = await input.settingsRevisions.getLatestSettingsRevision(
    input.appId,
  );
  if (!latest) return false;
  return revisionDocumentMatchesSettings(
    latest.settingsDocument,
    input.settings,
  );
}

function revisionDocumentMatchesSettings(
  document: Record<string, unknown>,
  settings: RuntimeSettings,
): boolean {
  return (
    stableJson(canonicalizeRevisionDocument(document)) ===
    stableJson(
      canonicalizeRevisionDocument(settingsToRevisionDocument(settings)),
    )
  );
}

function canonicalizeRevisionDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return settingsToRevisionDocument(settingsFromRevisionDocument(document));
  } catch {
    return document;
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function validateProjectionPreconditions(input: {
  settings: RuntimeSettings;
  repositories: SettingsDesiredStateRepositories;
  appId: AppId;
}): Promise<void> {
  const providerAccounts = input.repositories.providerAccounts;
  if (!providerAccounts) return;
  for (const [accountId, account] of Object.entries(
    input.settings.providerAccounts,
  )) {
    const existing = await providerAccounts.getProviderAccount(
      accountId as ProviderAccountId,
    );
    if (!existing) continue;
    if (existing.appId !== input.appId) {
      throw new Error(
        `provider_accounts.${accountId} already belongs to another app`,
      );
    }
    if (existing.providerId !== (account.provider as ProviderId)) {
      throw new Error(
        `provider_accounts.${accountId}.provider cannot change from ${existing.providerId} to ${account.provider}; use a new provider account id.`,
      );
    }
  }
}

function mapRecord<T>(
  record: Record<string, T>,
  mapValue: (value: T) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, mapValue(value)]),
  );
}

function snakeRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeRecord);
  if (typeof value !== 'object' || value === null) return value;
  return stripUndefined(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        snakeRecord(item),
      ]),
    ),
  );
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return stripUndefinedDeep(record) as T;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, stripUndefinedDeep(item)]],
    ),
  );
}
