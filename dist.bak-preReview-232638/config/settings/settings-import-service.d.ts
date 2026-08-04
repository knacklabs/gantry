import type { Pool } from 'pg';
import type { AppId } from '../../domain/app/app.js';
import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import type { SettingsDesiredStateOps, SettingsDesiredStateRepositories } from './desired-state-service.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
/**
 * Reader version of the settings-revision contract this build understands. A
 * revision stamped with a higher `min_reader_version` than this is held (not
 * applied) by an older worker until it is upgraded (ADR-3 skew safety contract).
 * Bump this whenever a settings-schema change would break older readers.
 */
export declare const CURRENT_SETTINGS_READER_VERSION = 15;
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
export type WorkstationSettingsImportOutcome = {
    status: 'revision_created';
    revision: number;
} | {
    status: 'applied_no_revision';
} | {
    status: 'no_op';
};
export declare class SettingsStaleMutationError extends Error {
    constructor();
}
export declare class SettingsRevisionConflictError extends Error {
    readonly expectedRevision: number;
    readonly actualRevision: number;
    constructor(input: {
        expectedRevision: number;
        actualRevision: number;
        message?: string;
    });
}
/**
 * The single validation path shared by every settings mutation surface (YAML
 * watcher auto-import, CLI `settings import`, and the control-API desired-state
 * update). Schema/path-level validation runs through `validateLoadedRuntimeSettings`
 * and capability-reference validation runs through the desired-state service, so
 * the workstation file and the fleet revision produce identical errors (ADR-3:
 * one mutation path, one validation, no authority fork).
 */
export declare function validateSettingsForImport(deps: SettingsImportServiceDeps, settings: RuntimeSettings): Promise<SettingsImportValidationResult>;
/**
 * Workstation import: validate, then write `settings.yaml` and reconcile through
 * the existing desired-state apply path. When a required revision mirror is
 * provided, append the `settings_revisions` row before mutating local runtime
 * projection. Fleet authority is the revision log; a failed local projection can
 * be retried from that committed revision without accepting an uncommitted file
 * change.
 */
export declare function importWorkstationSettings(deps: SettingsImportServiceDeps & {
    previousSettings?: RuntimeSettings;
    reloadRuntimeState?: () => Promise<void>;
    revisionMirror?: SettingsRevisionMirror;
    revisionMirrorRequired?: boolean;
    expectedRevision?: number | null;
}, settings: RuntimeSettings): Promise<WorkstationSettingsImportOutcome>;
export type FleetImportOutcome = {
    status: 'applied';
    revision: number;
} | {
    status: 'invalid';
    errors: string[];
} | {
    status: 'conflict';
    expectedRevision: number;
    actualRevision: number;
};
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
export declare function importFleetSettingsRevision(deps: FleetImportDeps, settings: RuntimeSettings, options?: {
    expectedRevision?: number | null;
    note?: string | null;
}): Promise<FleetImportOutcome>;
/**
 * Serialize desired state into the typed JSON settings document that the
 * control API/SDK transport and `settings_revisions` store as jsonb. YAML is the
 * human file format for the workstation file + CLI `--file` edge only; it never
 * appears on the wire. The document is the parser's native snake_case object
 * form, built directly from RuntimeSettings so JSON strings and numbers stay
 * lossless.
 */
export declare function settingsToRevisionDocument(settings: RuntimeSettings): Record<string, unknown>;
/** Re-hydrate a typed settings document back into typed runtime settings. */
export declare function settingsFromRevisionDocument(document: Record<string, unknown>): RuntimeSettings;
export declare function settingsMatchesLatestRevision(input: {
    appId: AppId;
    settings: RuntimeSettings;
    settingsRevisions: SettingsRevisionRepository;
}): Promise<boolean>;
export declare function stableJson(value: unknown): string;
