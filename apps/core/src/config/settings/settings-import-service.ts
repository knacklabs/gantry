import type { Pool } from 'pg';

import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import { SettingsDesiredStateService } from './desired-state-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import { applyRuntimeSettingsDesiredState } from './restart-sync.js';
import { parseRuntimeSettingsObject } from './runtime-settings-parser.js';
import { validateLoadedRuntimeSettings } from './runtime-settings-validation.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
import {
  PostgresSettingsRevisionNotifier,
  type SettingsRevisionWakeup,
} from './settings-revision-notify.js';

/**
 * Reader version of the settings-revision contract this build understands. A
 * revision stamped with a higher `min_reader_version` than this is held (not
 * applied) by an older worker until it is upgraded (ADR-3 skew safety contract).
 * Bump this whenever a settings-schema change would break older readers.
 */
export const CURRENT_SETTINGS_READER_VERSION = 2;

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
  const schema = validateLoadedRuntimeSettings(deps.runtimeHome, settings);
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
 * the existing desired-state apply path (unchanged behavior). `settings.yaml`
 * remains the restart source of truth for workstation (AGENTS.md). Throws a
 * combined path-level error message on validation failure.
 */
export async function importWorkstationSettings(
  deps: SettingsImportServiceDeps & {
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
  },
  settings: RuntimeSettings,
): Promise<void> {
  const validation = await validateSettingsForImport(deps, settings);
  if (!validation.ok) {
    throw new Error(
      ['settings validation failed.', ...validation.errors].join('\n'),
    );
  }
  await applyRuntimeSettingsDesiredState({
    runtimeHome: deps.runtimeHome,
    settings,
    ops: deps.ops,
    repositories: deps.repositories,
    appId: deps.appId,
    previousSettings: deps.previousSettings,
    reloadRuntimeState: deps.reloadRuntimeState,
  });
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
  return stripUndefined({
    desired_state: snakeRecord(settings.desiredState),
    providers: mapRecord(settings.providers, snakeRecord),
    provider_connections: mapRecord(settings.providerConnections, snakeRecord),
    conversations: mapRecord(settings.conversations, (conversation) => ({
      provider_connection: conversation.providerConnection,
      external_id: conversation.externalId,
      kind: conversation.kind,
      display_name: conversation.displayName,
      sender_policy: conversation.senderPolicy,
      control_approvers: conversation.controlApprovers,
    })),
    bindings: mapRecord(settings.bindings, snakeRecord),
    agents: mapRecord(settings.agents, (agent) => ({
      name: agent.name,
      persona: agent.persona,
      relationship_mode: agent.relationshipMode,
      model: agent.model,
      agent_harness: agent.agentHarness,
      one_time_job_default_model: agent.oneTimeJobDefaultModel,
      recurring_job_default_model: agent.recurringJobDefaultModel,
      bindings: mapRecord(agent.bindings, snakeRecord),
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
  });
}

/** Re-hydrate a typed settings document back into typed runtime settings. */
export function settingsFromRevisionDocument(
  document: Record<string, unknown>,
): RuntimeSettings {
  return parseRuntimeSettingsObject(document);
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
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  return record;
}
