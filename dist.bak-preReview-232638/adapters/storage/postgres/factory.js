import path from 'node:path';
import { createStorageService, } from './storage-service.js';
import { createPostgresDomainRepositories, } from './repositories/domain-repositories.postgres.js';
import { ARTIFACTS_DIR, GANTRY_HOME, createDefaultRuntimeSettings, getRuntimeSettingsForConfig, resolveRuntimeStorageConfig, resolveRuntimeStorageConfigFromSettings, } from '../../../config/index.js';
import { LocalFileArtifactBytes } from '../../artifacts/files/local-file-artifact-bytes.js';
import { LocalSkillArtifactStore } from '../../artifacts/skills/local-skill-artifact-store.js';
import { RemoteFirstSkillArtifactStore } from '../../artifacts/skills/remote-first-skill-artifact-store.js';
import { S3SkillArtifactStore } from '../../artifacts/skills/s3-skill-artifact-store.js';
import { createS3ArtifactClient } from '../../artifacts/skills/s3-artifact-client.js';
import { LocalBrowserProfileArtifactStore } from '../../artifacts/browser-profiles/local-browser-profile-artifact-store.js';
import { S3BrowserProfileArtifactStore } from '../../artifacts/browser-profiles/s3-browser-profile-artifact-store.js';
import { PostgresRuntimeRepositoryBundle } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import { PostgresFileArtifactStore } from './repositories/file-artifact-repository.postgres.js';
import { PostgresBrowserProfileSnapshotRepository } from './repositories/browser-profile-snapshot-repository.postgres.js';
import { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from './runtime-event-notifier.postgres.js';
import { PostgresLiveAdmissionNotifier, PostgresLiveAdmissionWakeupSource, PostgresLiveTurnCommandNotifier, PostgresLiveTurnCommandWakeupSource, } from './live-admission-notify.postgres.js';
const FILE_ARTIFACTS_DIR_NAME = 'files';
export function resolveStorageConfigFromRuntime() {
    const runtimeHome = process.env.GANTRY_HOME?.trim() || GANTRY_HOME;
    const config = resolveRuntimeStorageConfig(runtimeHome, runtimeHome);
    return {
        postgresUrl: config.postgresUrl,
        postgresUrlEnv: config.postgresUrlEnv,
        postgresSchema: config.postgresSchema,
        postgresPlaintextHostAllowlist: config.postgresPlaintextHostAllowlist,
    };
}
export function createStorageRuntime(config, options = {}) {
    const service = createStorageService(options.storageConfig ??
        config ??
        resolveStorageConfigFromSettings(options.runtimeSettings) ??
        resolveStorageConfigFromRuntime());
    const runtimeSettings = options.runtimeSettings ?? getRuntimeSettingsForStorageRuntime();
    const sessionSettings = runtimeSettings.agent.sessions;
    const maxLiveAdmissionBacklog = runtimeSettings.runtime.queue.maxLiveAdmissionBacklog;
    const control = new PostgresControlPlaneRepository(service.db);
    const liveTurnCommandNotifier = new PostgresLiveTurnCommandNotifier(service.pool);
    const repositories = createPostgresDomainRepositories(service.db, service.pool, { liveTurnCommandNotifier, maxLiveAdmissionBacklog });
    const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
    const liveAdmissionNotifier = new PostgresLiveAdmissionNotifier(service.pool);
    const liveAdmissionWakeupSource = new PostgresLiveAdmissionWakeupSource(service.pool);
    const liveTurnCommandWakeupSource = new PostgresLiveTurnCommandWakeupSource(service.pool);
    const runtimeEvents = new RuntimeEventExchange(repositories.runtimeEvents, runtimeEventNotifier);
    const ops = new PostgresRuntimeRepositoryBundle(service.pool, service.db, {
        runtimeEvents,
        liveAdmissionNotifier,
        maxLiveAdmissionBacklog,
        sessions: {
            ...sessionSettings,
            loadAppMemoryItems: options.loadSessionAppMemoryItems,
        },
    });
    const fileArtifacts = new PostgresFileArtifactStore(service.db, new LocalFileArtifactBytes(path.join(ARTIFACTS_DIR, FILE_ARTIFACTS_DIR_NAME)));
    const skillArtifacts = createSkillArtifactStore(runtimeSettings);
    const browserProfileSnapshots = new PostgresBrowserProfileSnapshotRepository(service.db);
    return {
        service,
        ops,
        control,
        repositories,
        runtimeEvents,
        runtimeEventNotifier,
        liveAdmissionWakeupSource,
        liveTurnCommandWakeupSource,
        fileArtifacts,
        skillArtifacts,
        browserProfileSnapshots,
    };
}
function resolveStorageConfigFromSettings(runtimeSettings) {
    if (!runtimeSettings)
        return undefined;
    return resolveRuntimeStorageConfigFromSettings({
        postgresUrlEnv: runtimeSettings.storage.postgres.urlEnv,
        postgresSchema: runtimeSettings.storage.postgres.schema,
    });
}
function createSkillArtifactStore(runtimeSettings = getRuntimeSettingsForStorageRuntime()) {
    const artifactStore = runtimeSettings.runtime.artifactStore;
    if (artifactStore.driver === 's3') {
        const { client, bucket } = createS3ArtifactClient({
            bucket: artifactStore.bucket ?? '',
            region: artifactStore.region,
            endpoint: artifactStore.endpoint,
            forcePathStyle: artifactStore.forcePathStyle,
        });
        return new RemoteFirstSkillArtifactStore(new S3SkillArtifactStore(client, bucket), new LocalSkillArtifactStore(ARTIFACTS_DIR));
    }
    return new LocalSkillArtifactStore(ARTIFACTS_DIR);
}
export function createRuntimeBrowserProfileArtifactStore() {
    const artifactStore = getRuntimeSettingsForStorageRuntime().runtime.artifactStore;
    if (artifactStore.driver === 's3') {
        const { client, bucket } = createS3ArtifactClient({
            bucket: artifactStore.bucket ?? '',
            region: artifactStore.region,
            endpoint: artifactStore.endpoint,
            forcePathStyle: artifactStore.forcePathStyle,
        });
        return new S3BrowserProfileArtifactStore(client, bucket);
    }
    return new LocalBrowserProfileArtifactStore(ARTIFACTS_DIR);
}
function getRuntimeSettingsForStorageRuntime() {
    try {
        return getRuntimeSettingsForConfig();
    }
    catch {
        return createDefaultRuntimeSettings();
    }
}
