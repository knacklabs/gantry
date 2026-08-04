import { resolveModelSelectionForWorkload, } from '../../shared/model-catalog.js';
import { DEFAULT_AGENT_ENGINE, } from '../../shared/agent-engine.js';
import { resolveExecutionRoute } from '../../shared/model-execution-route.js';
// The engine a job runs on is derived from the resolved job model's provider;
// there is no job-level engine selector. Resolution is
// `modelAlias -> provider -> executionRoute`.
function executionProviderIdForResolution(resolution, agentHarness) {
    if (!resolution.ok)
        return undefined;
    const route = resolveExecutionRoute({
        entry: resolution.entry,
        agentHarness,
    });
    return route.ok
        ? route.value.executionProviderId
        : undefined;
}
function routeForResolution(resolution, agentHarness) {
    return resolution?.ok
        ? resolveExecutionRoute({ entry: resolution.entry, agentHarness })
        : undefined;
}
function engineForResolution(resolution, agentHarness) {
    if (!resolution?.ok)
        return DEFAULT_AGENT_ENGINE;
    const route = resolveExecutionRoute({
        entry: resolution.entry,
        agentHarness,
    });
    return route.ok ? route.value.engine : DEFAULT_AGENT_ENGINE;
}
export function modelUseKindForJobSchedule(scheduleType) {
    return scheduleType === 'cron' || scheduleType === 'interval'
        ? 'recurringJob'
        : 'oneTimeJob';
}
export function jobModelWorkloadForSchedule(scheduleType) {
    return modelUseKindForJobSchedule(scheduleType) === 'recurringJob'
        ? 'recurring_job'
        : 'one_time_job';
}
export function resolveDefaultJobExecutionProviderId(scheduleType, agentHarness) {
    const resolution = resolveModelSelectionForWorkload('opus', jobModelWorkloadForSchedule(scheduleType));
    return executionProviderIdForResolution(resolution, agentHarness);
}
export function resolveJobModel(job, defaultConfig, agentHarness) {
    const selectedModel = job.model || defaultConfig.model;
    const defaultResolution = defaultConfig.model
        ? resolveModelSelectionForWorkload(defaultConfig.model, jobModelWorkloadForSchedule(job.schedule_type))
        : undefined;
    const resolution = selectedModel
        ? resolveModelSelectionForWorkload(selectedModel, jobModelWorkloadForSchedule(job.schedule_type))
        : undefined;
    const routeResolution = routeForResolution(resolution, agentHarness);
    return {
        selectedModel,
        source: job.model ? 'job.model' : defaultConfig.source,
        resolution,
        entry: resolution?.ok ? resolution.entry : undefined,
        agentHarness,
        routeResolution,
        agentEngine: routeResolution?.ok
            ? routeResolution.value.engine
            : engineForResolution(resolution, agentHarness),
        defaultExecutionProviderId: defaultResolution
            ? executionProviderIdForResolution(defaultResolution, agentHarness)
            : undefined,
    };
}
