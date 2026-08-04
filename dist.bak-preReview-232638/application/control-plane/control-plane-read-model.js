export function buildControlPlaneReadModel(input) {
    const providerCounts = input.providers.reduce((counts, provider) => {
        if (provider.blocked)
            counts.blocked += 1;
        else if (provider.ready)
            counts.ready += 1;
        else
            counts.needsConnection += 1;
        return counts;
    }, { ready: 0, needsConnection: 0, blocked: 0 });
    const conversationsReady = input.conversations.filter((conversation) => conversation.ready).length;
    const jobCounts = input.jobs.reduce((counts, job) => {
        if (job.status === 'blocked')
            counts.blocked += 1;
        else if (job.status === 'needs_action')
            counts.needsAction += 1;
        else
            counts.ready += 1;
        return counts;
    }, { ready: 0, needsAction: 0, blocked: 0 });
    const blockedJobId = input.jobs.find((job) => job.status === 'blocked')?.id;
    const needsActionJobId = input.jobs.find((job) => job.status === 'needs_action')?.id;
    const nextAction = selectControlPlaneNextAction({
        runtimeBlocked: input.runtimeBlocked === true,
        modelCredentialReady: input.modelCredentialReady,
        providerCounts,
        conversationsReady,
        conversationsTotal: input.conversations.length,
        accessNeedsApprovalCount: input.accessNeedsApprovalCount,
        blockedJobs: jobCounts.blocked,
        blockedJobId,
        needsActionJobs: jobCounts.needsAction,
        needsActionJobId,
        memoryStatus: input.memoryStatus,
    });
    const agentDetails = input.agents.map((agent) => {
        const agentConversations = input.conversations.filter((conversation) => conversation.agentId === agent.id && conversation.ready).length;
        const activeJobs = input.jobs.filter((job) => job.agentId === agent.id && job.status !== 'blocked').length;
        return {
            id: agent.id,
            name: agent.name,
            modelAlias: agent.modelAlias,
            workspaceKey: input.workspaceKey,
            conversations: agentConversations,
            approvedCapabilities: agent.approvedCapabilities,
            activeJobs,
            memory: input.memoryStatus,
            nextAction: selectControlPlaneNextAction({
                runtimeBlocked: input.runtimeBlocked === true,
                modelCredentialReady: input.modelCredentialReady,
                providerCounts,
                conversationsReady: agentConversations,
                conversationsTotal: agentConversations,
                accessNeedsApprovalCount: input.accessNeedsApprovalCount,
                blockedJobs: input.jobs.filter((job) => job.agentId === agent.id && job.status === 'blocked').length,
                blockedJobId: input.jobs.find((job) => job.agentId === agent.id && job.status === 'blocked')?.id,
                needsActionJobs: input.jobs.filter((job) => job.agentId === agent.id && job.status === 'needs_action').length,
                needsActionJobId: input.jobs.find((job) => job.agentId === agent.id && job.status === 'needs_action')?.id,
                memoryStatus: input.memoryStatus,
            }),
        };
    });
    return {
        title: 'Gantry',
        runtime: runtimeStatus(nextAction),
        workspaceKey: input.workspaceKey,
        agents: {
            ready: input.agents.filter((agent) => input.modelCredentialReady && Boolean(agent.modelAlias)).length,
            total: input.agents.length,
        },
        conversations: {
            ready: conversationsReady,
            total: input.conversations.length,
        },
        jobs: jobCounts,
        access: {
            approved: input.approvedAccessCount,
            needsApproval: input.accessNeedsApprovalCount,
        },
        memory: input.memoryStatus,
        providers: providerCounts,
        nextAction,
        agentDetails,
    };
}
export function buildControlPlaneReadModelFromSettings(input) {
    const conversations = Object.keys(input.settings.conversations).map((id) => {
        const binding = Object.values(input.settings.bindings).find((candidate) => candidate.conversation === id);
        return {
            id,
            ...(binding?.agent ? { agentId: binding.agent } : {}),
            ready: Boolean(binding && input.settings.agents[binding.agent]),
        };
    });
    const agents = Object.entries(input.settings.agents).map(([id, agent]) => ({
        id,
        name: agent.name,
        modelAlias: agent.model || input.settings.agent.defaultModel,
        approvedCapabilities: agent.capabilities.length,
    }));
    const approvedAccessCount = agents.reduce((total, agent) => total + agent.approvedCapabilities, 0);
    return buildControlPlaneReadModel({
        workspaceKey: input.workspaceKey,
        runtimeBlocked: input.runtimeBlocked,
        modelCredentialReady: input.modelCredentialReady,
        providers: input.providers,
        conversations,
        agents,
        jobs: input.jobs ?? [],
        approvedAccessCount,
        accessNeedsApprovalCount: input.accessNeedsApprovalCount ?? 0,
        memoryStatus: input.memoryStatus,
    });
}
export function selectControlPlaneNextAction(input) {
    // Labels are copy-pasteable commands so the guided-action manual receipt is
    // actionable on every surface (CLI/API/MCP), even when an action can't be
    // executed automatically.
    if (input.runtimeBlocked) {
        return {
            kind: 'runtime_blocked',
            label: 'Run `gantry doctor` to fix blocking runtime checks.',
        };
    }
    if (!input.modelCredentialReady) {
        return {
            kind: 'missing_model_credential',
            label: 'Run `gantry credentials model set <provider>` to connect model access.',
        };
    }
    if (input.providerCounts.blocked > 0) {
        return {
            kind: 'missing_provider_connection',
            label: 'Run `gantry provider connect <provider>` to fix the blocked provider.',
        };
    }
    if (input.providerCounts.ready === 0 ||
        input.providerCounts.needsConnection > 0) {
        return {
            kind: 'missing_provider_connection',
            label: 'Run `gantry provider connect <provider>` to connect a provider.',
        };
    }
    if (input.conversationsTotal === 0 || input.conversationsReady === 0) {
        return {
            kind: 'missing_conversation_install',
            label: 'Run `gantry conversation install --agent <agent-id> --conversation <conversation-id>` to install an agent in a conversation.',
        };
    }
    if (input.accessNeedsApprovalCount > 0) {
        return {
            kind: 'missing_access_approval',
            label: 'Approve or deny the pending access prompt in its source conversation.',
        };
    }
    const jobActionCount = input.blockedJobs + (input.needsActionJobs ?? 0);
    const jobActionId = input.blockedJobId ?? input.needsActionJobId;
    if (jobActionCount > 0) {
        // Emit the concrete job id when known so the action is executable;
        // otherwise point at `gantry jobs list` to find it.
        return jobActionId
            ? {
                kind: 'blocked_job',
                label: `Run \`gantry jobs resume ${jobActionId}\` to resume the job that needs action.`,
                params: { jobId: jobActionId },
            }
            : {
                kind: 'blocked_job',
                label: 'Run `gantry jobs list` to find the job that needs action, then `gantry jobs resume <job-id>`.',
            };
    }
    if (input.memoryStatus === 'Needs review') {
        return {
            kind: 'memory_review_setup',
            label: 'Run `gantry memory status` to review pending memory items.',
        };
    }
    if (input.memoryStatus === 'Needs setup') {
        return {
            kind: 'memory_review_setup',
            label: 'Run `gantry memory embeddings <provider>` to finish memory setup.',
        };
    }
    return { kind: 'none', label: 'none' };
}
export function formatControlPlaneStatus(model, service) {
    return [
        model.title,
        '',
        `Runtime: ${model.runtime}`,
        ...(service ? [`Service (${service.kind}): ${service.status}`] : []),
        `Workspace: ${model.workspaceKey}`,
        `Agents: ${model.agents.ready}/${model.agents.total}`,
        `Conversations: ${model.conversations.ready}/${model.conversations.total}`,
        `Jobs: ${model.jobs.ready}/${model.jobs.needsAction}/${model.jobs.blocked}`,
        `Access: ${model.access.approved}/${model.access.needsApproval}`,
        `Memory: ${model.memory}`,
        `Providers: ${model.providers.ready}/${model.providers.needsConnection}/${model.providers.blocked}`,
        '',
        `Next action: ${model.nextAction.label}`,
    ].join('\n');
}
export function formatControlPlaneAgentDetail(detail) {
    return [
        `Agent: ${detail.name}`,
        `Model: ${detail.modelAlias}`,
        `Workspace: ${detail.workspaceKey}`,
        `Conversations: ${detail.conversations}`,
        `Access: ${detail.approvedCapabilities}`,
        `Jobs: ${detail.activeJobs}`,
        `Memory: ${detail.memory}`,
        `Next action: ${detail.nextAction.label}`,
    ].join('\n');
}
function runtimeStatus(nextAction) {
    if (nextAction.kind === 'runtime_blocked')
        return 'Blocked';
    if (nextAction.kind === 'blocked_job')
        return 'Blocked';
    if (nextAction.kind === 'none')
        return 'Ready';
    return 'Needs setup';
}
