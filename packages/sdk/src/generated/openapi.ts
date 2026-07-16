export interface paths {
    "/v1/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get unified Gantry status
         * @description Returns the operator read model used by status surfaces.
         */
        get: operations["getStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check control server health
         * @description Returns runtime transport details and enabled feature flags.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/doctor": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Run lightweight control diagnostics
         * @description Reports control-plane readiness checks.
         */
        get: operations["getDoctor"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/guided-actions/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Preview a guided action
         * @description Returns the action authority preview (effect, approval, settings write, restart) for the supplied action or the current next action.
         */
        post: operations["previewGuidedAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/guided-actions/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Execute a guided action
         * @description Executes the supplied action or the current next action and returns a done, failed, or manual receipt. Base scope is agents:admin; resume_job execution also requires jobs:write.
         */
        post: operations["executeGuidedAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List registered model aliases
         * @description Returns provider-neutral model catalog entries.
         */
        get: operations["listModels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/models/defaults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read configured and effective model defaults
         * @description Returns provider-neutral defaults for chat, jobs, and memory tasks.
         */
        get: operations["getModelDefaults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update model defaults
         * @description Applies chat, jobs, and memory reset changes to settings.yaml.
         */
        patch: operations["patchModelDefaults"];
        trace?: never;
    };
    "/v1/models/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Preview model selection
         * @description Explains what model chat, jobs, or memory will use and why. Chat, jobs, and memory previews require sessions:read; stored job previews require jobs:read.
         */
        post: operations["previewModelSelection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/credentials/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List model credential status
         * @description Returns redacted readiness for Gantry-managed model provider credentials.
         */
        get: operations["listModelCredentials"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/credentials/models/{providerId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set one model provider credential
         * @description Fully replaces one provider credential and returns redacted status.
         */
        put: operations["putModelCredential"];
        post?: never;
        /**
         * Disable one model provider credential
         * @description Disables future use of the provider credential without returning secret material.
         */
        delete: operations["disableModelCredential"];
        options?: never;
        head?: never;
        /**
         * Rotate model provider credential fields
         * @description Partially updates fields for the existing provider credential auth mode and returns redacted status.
         */
        patch: operations["patchModelCredential"];
        trace?: never;
    };
    "/v1/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read public runtime settings
         * @description Returns the non-secret settings projection.
         */
        get: operations["getSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Attempt a settings mutation
         * @description The typed settings API is read-only and returns SETTINGS_READ_ONLY.
         */
        patch: operations["patchSettingsReadOnly"];
        trace?: never;
    };
    "/v1/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agents
         * @description Lists user-facing agents in the API key app scope.
         */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create an agent
         * @description Creates an agent and syncs settings desired state.
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an agent
         * @description Reads one agent by id.
         */
        get: operations["getAgent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update an agent
         * @description Updates agent name or lifecycle status.
         */
        patch: operations["updateAgent"];
        trace?: never;
    };
    "/v1/agents/{agentId}/admin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get agent admin summary
         * @description Returns agent metadata, capabilities, and bound conversations.
         */
        get: operations["getAgentAdminSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inventory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List global inventory
         * @description Returns read-only global onboarded tools, skills, and MCP servers.
         */
        get: operations["getInventory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List approved capabilities
         * @description Returns approved immutable capability manifests.
         */
        get: operations["listCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/capabilities/{capabilityId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get one approved capability
         * @description Returns the immutable capability manifest and projection metadata.
         */
        get: operations["getCapability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get agent access
         * @description Returns attached sources, selected access ids, and the canonical tool access view.
         */
        get: operations["getAgentAccess"];
        /**
         * Replace agent access
         * @description Replaces the full access document (sources and selections) and exports readable settings entries.
         */
        put: operations["replaceAgentAccess"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/profile-files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent profile files
         * @description Returns the agent SOUL.md and AGENTS.md profile files with version, hash, and size.
         */
        get: operations["listAgentProfileFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/profile-files/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read an agent profile file
         * @description Returns the current content, version, and hash of a profile file (kind = soul | agents).
         */
        get: operations["getAgentProfileFile"];
        /**
         * Replace an agent profile file
         * @description Writes a new durable version of a profile file and refreshes its visible mirror. Supply expectedVersion for optimistic concurrency; a stale version returns 409.
         */
        put: operations["setAgentProfileFile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/ensure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ensure an SDK session
         * @description Creates or reuses an app-scoped durable session.
         */
        post: operations["ensureSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get session details
         * @description Returns app-scoped session metadata.
         */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List session messages
         * @description Lists durable session message history.
         */
        get: operations["listSessionMessages"];
        put?: never;
        /**
         * Accept a session message
         * @description Persists an inbound SDK message and enqueues processing. Optional response_schema and model controls apply to this turn.
         */
        post: operations["sendSessionMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List or stream session events
         * @description Returns JSON history or Server-Sent Events.
         */
        get: operations["listOrStreamSessionEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/wait": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wait for the next visible session event
         * @description Long-polls for the next visible runtime event.
         */
        get: operations["waitForSessionEvent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List session runs
         * @description Lists runtime runs associated with a session.
         */
        get: operations["listSessionRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List channel providers
         * @description Lists provider adapters that can be connected.
         */
        get: operations["listProviders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/provider-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List provider accounts
         * @description Lists installed provider accounts.
         */
        get: operations["listProviderAccounts"];
        put?: never;
        /**
         * Create a provider account
         * @description Creates a provider account using runtime secret references.
         */
        post: operations["createProviderAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/provider-accounts/{providerAccountId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get provider account
         * @description Reads a provider account.
         */
        get: operations["getProviderAccount"];
        put?: never;
        post?: never;
        /**
         * Disable provider account
         * @description Disables a provider account and syncs settings.
         */
        delete: operations["disableProviderAccount"];
        options?: never;
        head?: never;
        /**
         * Update provider account
         * @description Updates provider account metadata, status, config, and secret refs.
         */
        patch: operations["updateProviderAccount"];
        trace?: never;
    };
    "/v1/provider-accounts/{providerAccountId}/discover-conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Discover provider conversations
         * @description Discovers provider-side conversations available for install.
         */
        post: operations["discoverProviderConversations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversations
         * @description Lists normalized conversations.
         */
        get: operations["listConversations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get conversation
         * @description Reads one normalized conversation.
         */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}/approvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation approvers
         * @description Returns the control approver allowlist.
         */
        get: operations["listConversationApprovers"];
        /**
         * Replace conversation approvers
         * @description Replaces the allowlist after membership validation.
         */
        put: operations["replaceConversationApprovers"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}/threads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation threads
         * @description Lists normalized threads or topics.
         */
        get: operations["listConversationThreads"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/conversations/{conversationId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation messages
         * @description Lists durable messages, optionally scoped to a thread.
         */
        get: operations["listConversationMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/conversation-installs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation installs
         * @description Lists conversations where an agent is installed.
         */
        get: operations["listConversationInstalls"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/conversation-installs/{conversationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Enable a conversation install
         * @description Installs an agent in a conversation and projects the runtime route.
         */
        put: operations["enableConversationInstall"];
        post?: never;
        /**
         * Disable a conversation install
         * @description Disables an install and removes the live runtime route.
         */
        delete: operations["disableConversationInstall"];
        options?: never;
        head?: never;
        /**
         * Update a conversation install
         * @description Updates install metadata, memory, or thread policy.
         */
        patch: operations["updateConversationInstall"];
        trace?: never;
    };
    "/v1/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Query token usage
         * @description Returns app-scoped token and request counts recorded from deployment forward; historical usage is not backfilled.
         */
        get: operations["queryUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/llm/v1/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invoke Messages
         * @description Forwards a Messages-shaped request through the Gantry Model Gateway after resolving the Gantry model alias. Supports streaming, caller-defined tools with input_schema, structured output, and thinking parameters. Rejects provider-side server tools, MCP servers, containers, and execution betas.
         */
        post: operations["invokeLlmMessages"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/llm/v1/messages/count_tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Count Messages tokens
         * @description Counts input tokens for a Messages-shaped request after resolving the Gantry model alias.
         */
        post: operations["invokeLlmMessagesCountTokens"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/llm/v1/chat/completions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invoke Chat Completions
         * @description Forwards a Chat Completions-shaped request through the Gantry Model Gateway after resolving the Gantry model alias. Supports streaming, function tools, response_format structured output, and effort parameters. Rejects hosted provider tools, hosted-tool fields, attachments, and file references.
         */
        post: operations["invokeLlmChatCompletions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List jobs
         * @description Lists jobs visible to the API key app scope.
         */
        get: operations["listJobs"];
        put?: never;
        /**
         * Create a job
         * @description Creates or dry-runs a job using catalog-resolved models.
         */
        post: operations["createJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get job
         * @description Reads a job with runtime visibility metadata.
         */
        get: operations["getJob"];
        put?: never;
        post?: never;
        /**
         * Delete job
         * @description Deletes a job owned by the API key app scope.
         */
        delete: operations["deleteJob"];
        options?: never;
        head?: never;
        /**
         * Update job
         * @description Updates job prompt, context, routes, capabilities, status, or model.
         */
        patch: operations["updateJob"];
        trace?: never;
    };
    "/v1/jobs/{jobId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List job events
         * @description Lists persisted runtime events for a job.
         */
        get: operations["listJobEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{jobId}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pause job
         * @description Pauses future execution for a job.
         */
        post: operations["pauseJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{jobId}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resume job
         * @description Resumes a paused job and returns setup blockers if present.
         */
        post: operations["resumeJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{jobId}/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Trigger job now
         * @description Creates an immediate trigger subject to rate limits.
         */
        post: operations["triggerJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/triggers/{triggerId}/wait": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wait for trigger completion
         * @description Long-polls for a previously accepted job trigger.
         */
        get: operations["waitForTrigger"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List job runs
         * @description Lists job runs visible to the API key app scope.
         */
        get: operations["listRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get run
         * @description Reads one job run after verifying app ownership.
         */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List run events
         * @description Lists runtime events projected into run-event shape.
         */
        get: operations["listRunEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List outbound webhooks
         * @description Lists outbound callback registrations.
         */
        get: operations["listWebhooks"];
        put?: never;
        /**
         * Create outbound webhook
         * @description Registers an outbound callback URL with optional lifecycle event and subject filters.
         */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete outbound webhook
         * @description Deletes an outbound webhook registration.
         */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        /**
         * Update outbound webhook
         * @description Updates destination, enabled state, or lifecycle event subscription filters.
         */
        patch: operations["updateWebhook"];
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send webhook test event
         * @description Publishes a webhook test runtime event for delivery.
         */
        post: operations["testWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/replay-dead-letter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replay webhook dead letters
         * @description Requeues dead-lettered webhook deliveries.
         */
        post: operations["replayWebhookDeadLetters"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/{webhookId}/purge-dead-letter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Purge webhook dead letters
         * @description Deletes dead-lettered webhook deliveries.
         */
        post: operations["purgeWebhookDeadLetters"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ingresses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List external ingresses
         * @description Lists signed inbound authorities for systems without API keys.
         */
        get: operations["listExternalIngresses"];
        put?: never;
        /**
         * Create external ingress
         * @description Creates a signed ingress record with explicit target metadata.
         */
        post: operations["createExternalIngress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ingresses/{ingressId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get external ingress
         * @description Reads one signed ingress record.
         */
        get: operations["getExternalIngress"];
        put?: never;
        post?: never;
        /**
         * Delete external ingress
         * @description Deletes a signed ingress record.
         */
        delete: operations["deleteExternalIngress"];
        options?: never;
        head?: never;
        /**
         * Update external ingress
         * @description Updates ingress name, enabled state, or metadata.
         */
        patch: operations["updateExternalIngress"];
        trace?: never;
    };
    "/v1/ingresses/{ingressId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate external ingress secret
         * @description Rotates the signing secret for an external ingress.
         */
        post: operations["rotateExternalIngressSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ingresses/{ingressId}/invoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invoke external ingress
         * @description Accepts a signed inbound payload. conversation_message targets enqueue a normal provider conversation or thread message asynchronously.
         */
        post: operations["invokeExternalIngress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ingresses/{ingressId}/wait": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invoke and wait for external ingress
         * @description Accepts a signed ingress payload and waits for the result.
         */
        post: operations["waitForExternalIngress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List memory items
         * @description Lists app-scoped memory items with optional subject filters.
         */
        get: operations["listMemory"];
        put?: never;
        /**
         * Create memory item
         * @description Directly saves an app memory item using canonical kinds.
         */
        post: operations["createMemory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search memory
         * @description Searches app memory with configured subject filters.
         */
        post: operations["searchMemory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory/{memoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete memory item
         * @description Deletes a memory item in the requested subject scope.
         */
        delete: operations["deleteMemory"];
        options?: never;
        head?: never;
        /**
         * Patch memory item
         * @description Updates mutable memory item fields.
         */
        patch: operations["patchMemory"];
        trace?: never;
    };
    "/v1/memory/dreaming/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Trigger memory dreaming
         * @description Starts an app or agent scoped memory dreaming run.
         */
        post: operations["triggerMemoryDreaming"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory/dreaming/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get memory dreaming status
         * @description Returns recent memory dreaming runs.
         */
        get: operations["getMemoryDreamingStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/brain/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Import company brain pages
         * @description Upserts company brain markdown pages and extracts entities and edges.
         */
        post: operations["importBrainPages"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/brain/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get company brain status
         * @description Returns page, entity, edge, and embedding counts for the app-scoped company brain.
         */
        get: operations["getBrainStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List skills
         * @description Lists installed skill records.
         */
        get: operations["listSkills"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Install skill
         * @description Installs a zip package as a local skill.
         */
        post: operations["installSkill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills/{skillId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List skill files
         * @description Lists readable files for a skill artifact.
         */
        get: operations["listSkillFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills/{skillId}/files/{filePath}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get skill file
         * @description Reads one file from a skill artifact.
         */
        get: operations["getSkillFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent skill bindings
         * @description Lists skills currently bound to an agent.
         */
        get: operations["listAgentSkillBindings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/skills/{skillId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Bind skill to agent
         * @description Binds an installed skill and syncs settings desired state.
         */
        put: operations["bindSkillToAgent"];
        post?: never;
        /**
         * Unbind skill from agent
         * @description Removes a skill binding and syncs settings desired state.
         */
        delete: operations["unbindSkillFromAgent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mcp-servers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List MCP servers
         * @description Lists MCP server definitions, optionally filtered by status.
         */
        get: operations["listMcpServers"];
        put?: never;
        /**
         * Connect MCP server
         * @description Connects and validates a current MCP server definition.
         */
        post: operations["connectMcpServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mcp-servers/{serverId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get MCP server
         * @description Returns one MCP server definition.
         */
        get: operations["getMcpServer"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mcp-servers/{serverId}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable MCP server
         * @description Disables an active MCP server and syncs settings.
         */
        post: operations["disableMcpServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mcp-servers/{serverId}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test MCP server
         * @description Runs server-side MCP definition validation.
         */
        post: operations["testMcpServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/mcp-servers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent MCP server bindings
         * @description Lists MCP servers currently bound to an agent.
         */
        get: operations["listAgentMcpServerBindings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{agentId}/mcp-servers/{serverId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Bind MCP server to agent
         * @description Binds an active MCP server and syncs settings.
         */
        put: operations["bindMcpServerToAgent"];
        post?: never;
        /**
         * Unbind MCP server from agent
         * @description Removes an MCP server binding and syncs settings.
         */
        delete: operations["unbindMcpServerFromAgent"];
        options?: never;
        head?: never;
        /**
         * Update agent MCP server binding
         * @description Updates binding policy metadata.
         */
        patch: operations["updateAgentMcpServerBinding"];
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Agent: {
            /** @example agent:main */
            id: string;
            /** @example default */
            appId: string;
            /** @example Support Agent */
            name: string;
            /** @enum {string} */
            status: "active" | "disabled";
            /**
             * @description Public agent harness. auto preserves provider-derived behavior; explicit values are user intent validated against the selected model.
             * @enum {string}
             */
            agentHarness: "auto" | "anthropic_sdk" | "deepagents";
            currentConfigVersionId?: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AgentListResponse: {
            agents: components["schemas"]["Agent"][];
        };
        AgentCreateRequest: {
            /** @example default */
            appId: string;
            name: string;
            /**
             * @description Public agent harness. auto preserves provider-derived behavior; explicit values are user intent validated against the selected model.
             * @enum {string}
             */
            agentHarness?: "auto" | "anthropic_sdk" | "deepagents";
        };
        AgentUpdateRequest: {
            name?: string;
            /** @enum {string} */
            status?: "active" | "disabled";
            /**
             * @description Public agent harness. auto preserves provider-derived behavior; explicit values are user intent validated against the selected model.
             * @enum {string}
             */
            agentHarness?: "auto" | "anthropic_sdk" | "deepagents";
        };
        AgentAdminSummaryResponse: {
            agent: components["schemas"]["Agent"];
            capabilities?: components["schemas"]["AgentAccessResponse"];
            boundConversations: {
                conversationId?: string;
                provider?: string;
                kind?: string;
                displayName?: string;
                approverUserIds?: string[];
                requiresTrigger?: boolean;
            }[];
        };
        CapabilityCatalogResponse: {
            tools: {
                [key: string]: unknown;
            }[];
            skills: {
                [key: string]: unknown;
            }[];
            mcpServers: {
                [key: string]: unknown;
            }[];
        };
        InventoryResponse: {
            inventory: components["schemas"]["CapabilityCatalogResponse"];
        };
        CapabilitySelection: {
            id: string;
            version: string | number;
        };
        CapabilityManifest: {
            id: string;
            version: string | number;
            displayName: string;
            category: string;
            risk: string;
            can?: string;
            cannot?: string;
            source?: string;
            bindings?: {
                [key: string]: unknown;
            }[];
            inputs?: {
                [key: string]: unknown;
            };
            secrets?: {
                [key: string]: unknown;
            }[];
            preflight?: {
                [key: string]: unknown;
            };
            sandbox?: {
                [key: string]: unknown;
            };
            protectedPaths?: string[];
            redaction?: {
                [key: string]: unknown;
            };
            approval?: {
                [key: string]: unknown;
            };
            audit?: {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        CapabilityListResponse: {
            capabilities: components["schemas"]["CapabilityManifest"][];
        };
        ModelCredentialStatus: {
            /** @example provider-id */
            providerId: string;
            label?: string;
            /** @enum {string} */
            role?: "model_route" | "embedding_provider" | "provider";
            configured: boolean;
            /** @example api_key */
            authMode?: string | null;
            /** @enum {string} */
            status: "active" | "disabled";
            /** @enum {string} */
            health: "ready" | "missing" | "disabled";
            /** @example sha256:0123abcd */
            fingerprint?: string | null;
            fieldFingerprints?: {
                field: string;
                fingerprint: string;
            }[];
            schemaVersion?: number;
            configuredFields?: string[];
            credentialModes: {
                /** @example api_key */
                id: string;
                label: string;
                helpText: string;
                schemaVersion: number;
                gatewayAuthStrategy: string;
                fields: {
                    name: string;
                    label: string;
                    secret: boolean;
                    required: boolean;
                }[];
            }[];
            supportedWorkloads?: string[];
            updatedAt?: string | null;
        };
        ModelCredentialListResponse: {
            providers: components["schemas"]["ModelCredentialStatus"][];
        };
        ModelCredentialWriteRequest: {
            /**
             * @description Provider credential mode id. Must be one of the provider credentialModes[].id returned by GET /v1/credentials/models. Omit when the provider has a single mode.
             * @example api_key
             */
            authMode?: string;
            /** @description Credential fields for the chosen mode, keyed by the mode credentialModes[].fields[].name from GET /v1/credentials/models (e.g. {"apiKey":"..."} for api_key, {"oauthToken":"..."} for claude_code_oauth). Stored encrypted; never returned by read APIs. */
            payload: {
                [key: string]: string;
            };
        };
        ModelCredentialPatchRequest: {
            /** @description Credential fields to rotate for the existing authMode, keyed by the mode credentialModes[].fields[].name from GET /v1/credentials/models. Stored encrypted; never returned by read APIs. */
            payload: {
                [key: string]: string;
            };
        };
        ModelCredentialMutationResponse: {
            /** @example provider-id */
            providerId: string;
            label?: string;
            /** @enum {string} */
            role?: "model_route" | "embedding_provider" | "provider";
            configured: boolean;
            /** @example api_key */
            authMode?: string | null;
            /** @enum {string} */
            status: "active" | "disabled";
            /** @enum {string} */
            health: "ready" | "missing" | "disabled";
            /** @example sha256:0123abcd */
            fingerprint?: string | null;
            fieldFingerprints?: {
                field: string;
                fingerprint: string;
            }[];
            schemaVersion?: number;
            configuredFields?: string[];
            credentialModes: {
                /** @example api_key */
                id: string;
                label: string;
                helpText: string;
                schemaVersion: number;
                gatewayAuthStrategy: string;
                fields: {
                    name: string;
                    label: string;
                    secret: boolean;
                    required: boolean;
                }[];
            }[];
            supportedWorkloads?: string[];
            updatedAt?: string | null;
        };
        AgentSourceSelection: {
            name?: string;
            id: string;
            version?: string | number;
        };
        AgentToolSourceSelection: {
            id: string;
            /** @enum {string} */
            kind: "builtin" | "adapter" | "local_cli";
            version?: string | number;
        };
        AgentMcpSourceSelection: {
            name?: string;
            id: string;
            version?: string | number;
            tools?: string[];
        };
        AgentSources: {
            skills: components["schemas"]["AgentSourceSelection"][];
            mcpServers: components["schemas"]["AgentMcpSourceSelection"][];
            tools: components["schemas"]["AgentToolSourceSelection"][];
        };
        AgentSourcesRequest: {
            sources: components["schemas"]["AgentSources"];
        };
        AgentAccessRequest: {
            sources: components["schemas"]["AgentSources"];
            selections?: components["schemas"]["CapabilitySelection"][];
        };
        AgentAccessResponse: {
            agentId: string;
            sources: components["schemas"]["AgentSources"];
            selections: components["schemas"]["CapabilitySelection"][];
            toolAccess: {
                [key: string]: unknown;
            };
            summary?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            updatedAt: string;
        };
        AgentProfileFileSummary: {
            /** @enum {string} */
            kind: "soul" | "agents";
            /** @example AGENTS.md */
            path: string;
            version: number;
            contentHash: string;
            sizeBytes: number;
            /** Format: date-time */
            updatedAt: string | null;
        };
        AgentProfileFilesResponse: {
            agentId: string;
            files: components["schemas"]["AgentProfileFileSummary"][];
        };
        AgentProfileFileContentResponse: {
            agentId: string;
            /** @enum {string} */
            kind: "soul" | "agents";
            path: string;
            version: number;
            contentHash: string;
            content: string;
        };
        PutAgentProfileFileRequest: {
            content: string;
            expectedVersion?: number;
        };
        HealthResponse: {
            /** @example ok */
            status: string;
            /** @enum {string} */
            processRole: "all" | "control" | "live-worker" | "job-worker";
            transport: {
                [key: string]: unknown;
            };
            features: {
                [key: string]: unknown;
            };
        };
        DoctorResponse: {
            /** @example ok */
            status: string;
            checks: {
                [key: string]: unknown;
            }[];
        };
        Model: {
            id: string;
            displayName: string;
            aliases: string[];
            recommendedAlias: string;
            responseFamily: string;
            executionRoutes: {
                harness: string;
                executionProviderId: string;
            }[];
            credentialProfileRef: string;
            modelRoute: {
                /** @enum {string} */
                id: "anthropic" | "openrouter" | "openai" | "groq" | "deepseek" | "xai" | "together" | "fireworks" | "cerebras" | "perplexity" | "gemini" | "bedrock" | "vertex";
                label: string;
                metadata: {
                    providerModelId: string;
                };
            };
            capabilities: {
                streaming: boolean;
                toolUse: boolean;
                mcpProjection: boolean;
                browserProjection: boolean;
                sandboxProjection: boolean;
                providerSessionResume: boolean;
                thinking: boolean;
                tokenAccounting: boolean;
                cacheAccounting: boolean;
                structuredOutput: boolean;
            };
            supportedWorkloads: ("chat" | "one_time_job" | "recurring_job" | "memory_extractor" | "memory_dreaming" | "memory_consolidation")[];
            contextWindowTokens?: number;
            maxOutputTokens?: number;
            cacheMode?: string;
            cacheTokenFields?: string[];
            cacheSupport: {
                providerId: string;
                providerLabel: string;
                cacheProvider: string;
                statusLabel: string;
                prompt: {
                    mode: string;
                    automatic: boolean;
                    requestControl: string;
                    ttlOptions: string[];
                    minimumTokenThresholds: {
                        modelFamily: string;
                        tokens: number;
                    }[];
                    usageFields: {
                        [key: string]: unknown;
                    };
                    supported: boolean;
                    accounted: boolean;
                };
                response: {
                    mode: string;
                    enabledByDefault: boolean;
                    requestControl: string;
                    requestHeaders: string[];
                    responseHeaders: string[];
                    usageBehavior: string;
                    available: boolean;
                };
                tokenFields: string[];
            };
            supportsTools?: boolean;
            supportsThinking?: boolean;
            inputUsdPerMillionTokens?: number;
            outputUsdPerMillionTokens?: number;
            available?: boolean;
            source?: {
                [key: string]: unknown;
            };
            experimental?: boolean;
        };
        ModelListResponse: {
            models: components["schemas"]["Model"][];
        };
        ModelDefaultSlot: {
            configuredAlias: string | null;
            effectiveAlias: string | null;
            source: string;
            inherited: boolean;
            workload: string;
            model: components["schemas"]["Model"] | null;
        };
        ModelDefaultsResponse: {
            provider: {
                id: string;
                label: string;
            } | null;
            chat: components["schemas"]["ModelDefaultSlot"];
            jobs: {
                oneTime: components["schemas"]["ModelDefaultSlot"];
                recurring: components["schemas"]["ModelDefaultSlot"];
            };
            memory: {
                /** @enum {string} */
                mode: "provider-managed";
                extractor: components["schemas"]["ModelDefaultSlot"];
                dreaming: components["schemas"]["ModelDefaultSlot"];
                consolidation: components["schemas"]["ModelDefaultSlot"];
            };
            defaults: {
                chat: components["schemas"]["ModelDefaultSlot"];
                oneTime: components["schemas"]["ModelDefaultSlot"];
                recurring: components["schemas"]["ModelDefaultSlot"];
                memoryExtractor: components["schemas"]["ModelDefaultSlot"];
                memoryDreaming: components["schemas"]["ModelDefaultSlot"];
                memoryConsolidation: components["schemas"]["ModelDefaultSlot"];
            };
        };
        ModelDefaultsPatchRequest: {
            chat?: string | null;
            /** @description Model alias, "inherit", or null. */
            jobs?: string | null;
            oneTime?: string | null;
            recurring?: string | null;
            /** @description Use null, "reset", or "provider-managed". */
            memory?: ("reset" | "provider-managed") | null;
        };
        ModelPreviewRequest: {
            /** @enum {string} */
            target: "chat" | "jobs" | "job" | "agent" | "memory";
            jobId?: string;
            /** @description Agent folder for "agent". */
            agentId?: string;
            /** @description Alias for "agent". */
            modelAlias?: string;
            /** @description Optional chat preview scope for session /model overrides. */
            conversationJid?: string;
            /** @description Optional workspace key preview scope for session /model overrides. */
            workspaceKey?: string;
            /** @enum {string} */
            kind?: "one-time" | "recurring";
            /** @enum {string} */
            task?: "extractor" | "dreaming" | "consolidation";
        };
        ModelPreviewResponse: {
            /** @enum {string} */
            target: "chat" | "jobs" | "job" | "agent" | "memory";
            jobId?: string;
            agentId?: string;
            scope?: string;
            /** @enum {string} */
            kind?: "one-time" | "recurring";
            /** @enum {string} */
            task?: "extractor" | "dreaming" | "consolidation";
            /** @enum {string} */
            agentHarness?: "auto" | "anthropic_sdk" | "deepagents";
            credentialProfile?: string;
            executionProviderId?: string;
            incompatible?: string;
            selection: components["schemas"]["ModelDefaultSlot"];
            why: string[];
        };
        SettingsResponse: {
            settings: {
                [key: string]: unknown;
            };
        };
        ReadOnlySettingsPatchRequest: {
            [key: string]: unknown;
        };
        SessionEnsureRequest: {
            /** @description Optional API key app assertion. */
            appId?: string;
            conversationId: string;
            title?: string;
            /** @enum {string} */
            responseMode?: "sse" | "webhook" | "both" | "none";
            webhookId?: string;
        };
        SessionEnsureResponse: {
            sessionId: string;
            appId: string;
            conversationId: string;
            chatJid: string;
        };
        SendSessionMessageRequest: {
            message: string;
            /** @default sdk */
            senderId: string;
            /** @default SDK */
            senderName: string;
            threadId?: string;
            correlationId?: string;
            /** @enum {string} */
            responseMode?: "sse" | "webhook" | "both" | "none";
            webhookId?: string;
            /** @description JSON Schema object requesting strict structured output for this inline turn. */
            response_schema?: Record<string, never>;
            /** @enum {string} */
            effort?: "low" | "medium" | "high" | "xhigh" | "max";
            thinking?: ("off" | "on") | {
                /** @enum {string} */
                mode: "off";
            } | {
                /** @enum {string} */
                mode: "on";
                budget_tokens?: number;
            };
            max_output_tokens?: number;
        };
        SendSessionMessageResponse: {
            accepted: boolean;
            messageId: string;
            acceptedEventId: number;
        };
        RuntimeEvent: {
            eventId: number;
            eventType: string;
            payload?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt: string;
        };
        RuntimeEventListResponse: {
            events: components["schemas"]["RuntimeEvent"][];
        };
        Run: {
            run_id: string;
            job_id: string;
            status: string;
            /** Format: date-time */
            started_at?: string;
            completed_at?: string | null;
        };
        RunListResponse: {
            runs: components["schemas"]["Run"][];
        };
        Provider: {
            id: string;
            displayName: string;
            description?: string;
            capabilities?: {
                [key: string]: unknown;
            };
            runtimeSecretKeys?: string[];
        };
        ProviderListResponse: {
            providers: components["schemas"]["Provider"][];
        };
        ProviderAccount: {
            id: string;
            appId: string;
            agentId: string;
            providerId: string;
            label: string;
            status: string;
            config?: {
                [key: string]: unknown;
            };
            runtimeSecretRefs?: {
                [key: string]: string;
            };
            externalRef?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        ProviderAccountListResponse: {
            providerAccounts: components["schemas"]["ProviderAccount"][];
        };
        ProviderAccountDeleteResponse: {
            deleted: boolean;
            providerAccount: components["schemas"]["ProviderAccount"];
        };
        ProviderAccountRequest: {
            appId: string;
            agentId: string;
            providerId: string;
            label: string;
            config?: {
                [key: string]: unknown;
            };
            runtimeSecretRefs?: {
                [key: string]: string;
            };
            externalRef?: {
                [key: string]: unknown;
            };
            enabled?: boolean;
        };
        ProviderAccountUpdateRequest: {
            label?: string;
            /** @enum {string} */
            status?: "active" | "inactive" | "disabled" | "archived";
            config?: {
                [key: string]: unknown;
            };
            runtimeSecretRefs?: {
                [key: string]: string;
            };
            externalRef?: {
                [key: string]: unknown;
            } | null;
            enabled?: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
        Conversation: {
            id: string;
            appId: string;
            providerAccountId: string;
            providerId?: string;
            kind: string;
            displayName?: string;
            externalRef?: {
                [key: string]: unknown;
            };
            metadata?: {
                [key: string]: unknown;
            };
        };
        ConversationListResponse: {
            conversations: components["schemas"]["Conversation"][];
        };
        ConversationThread: {
            id: string;
            conversationId: string;
            displayName?: string;
            externalRef?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt?: string;
        };
        ConversationThreadListResponse: {
            threads: components["schemas"]["ConversationThread"][];
        };
        ConversationMessageListResponse: {
            messages: {
                id: string;
                conversationId: string;
                threadId?: string;
                senderId: string;
                senderName?: string;
                text: string;
                /** Format: date-time */
                createdAt: string;
            }[];
        };
        ConversationApproversResponse: {
            approvers: string[];
        };
        ConversationApproversRequest: {
            userIds: string[];
        };
        ConversationInstall: {
            id?: string;
            appId?: string;
            agentId: string;
            providerAccountId: string;
            conversationId: string;
            threadId?: string;
            displayName?: string;
            status: string;
            memoryScope?: string;
            memorySubject?: {
                [key: string]: unknown;
            };
            routeConfig?: {
                trigger?: string;
                requiresTrigger?: boolean;
                agentConfig?: {
                    [key: string]: unknown;
                };
            };
            workspaceSnapshotId?: string;
            permissionPolicyIds?: string[];
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        ConversationInstallListResponse: {
            conversationInstalls: components["schemas"]["ConversationInstall"][];
        };
        ConversationInstallRequest: {
            providerAccountId?: string;
            threadId?: string;
            displayName?: string;
            memoryScope?: string;
            memorySubject?: {
                [key: string]: unknown;
            };
            routeConfig?: {
                trigger?: string;
                requiresTrigger?: boolean;
                agentConfig?: {
                    [key: string]: unknown;
                };
            };
            workspaceSnapshotId?: string;
            permissionPolicyIds?: string[];
            status?: string;
        };
        ConversationInstallDeleteResponse: {
            disabled: boolean;
            conversationInstall: components["schemas"]["ConversationInstall"];
        };
        /** @enum {string} */
        GuidedActionType: "connect_provider" | "add_conversation_install" | "grant_access" | "resume_job" | "review_memory" | "change_agent_model" | "restart_runtime" | "run_verification" | "none";
        GuidedActionRequest: {
            action?: components["schemas"]["GuidedActionType"];
            label?: string;
            /** @description Target identifiers for execution (e.g. { "jobId": "job_1" } for resume_job). String values only. */
            params?: {
                [key: string]: string;
            };
        };
        GuidedActionPreview: {
            action: components["schemas"]["GuidedActionType"];
            label: string;
            effect: string;
            requiresApproval: boolean;
            writesSettings: boolean;
            restartsRuntime: boolean;
        };
        GuidedActionResult: {
            /** @enum {string} */
            status: "done";
            changed: string;
            /** @enum {string} */
            savedTo: "settings.yaml" | "runtime state" | "access policy" | "none";
            restartRequired: boolean;
            nextAction: string;
        } | {
            /** @enum {string} */
            status: "failed";
            cause: string;
            recover: string;
        } | {
            /** @enum {string} */
            status: "manual";
            instruction: string;
        };
        UsageAggregate: {
            requestCount: number;
            inputTokens: number;
            outputTokens: number;
            agentId?: string;
            apiKeyId?: string;
            model?: string;
            /** Format: date */
            day?: string;
        };
        UsageQueryResponse: {
            usage: components["schemas"]["UsageAggregate"][];
        };
        Job: {
            id: string;
            name: string;
            prompt?: string;
            /** @enum {string} */
            status: "active" | "paused" | "deleted";
            /** @enum {string} */
            kind: "manual" | "once" | "recurring";
            /** Format: date-time */
            runAt?: string;
            schedule?: {
                [key: string]: unknown;
            };
            executionContext?: {
                [key: string]: unknown;
            };
            notificationRoutes?: {
                [key: string]: unknown;
            }[];
            accessRequirements?: {
                target: {
                    /** @enum {string} */
                    kind: "tool_rule";
                    rule: string;
                } | {
                    /** @enum {string} */
                    kind: "capability";
                    capabilityId: string;
                    implementation?: {
                        /** @enum {string} */
                        kind: "configured_access" | "local_cli" | "mcp_server" | "builtin_tool";
                        name?: string;
                        executablePath?: string;
                        executableVersion?: string;
                        executableHash?: string;
                        commandTemplate?: string;
                        authPreflight?: string;
                        protectedPaths?: string[];
                    };
                } | {
                    /** @enum {string} */
                    kind: "mcp_server";
                    server: string;
                };
                reason?: string;
            }[];
            setup?: {
                [key: string]: unknown;
            };
            modelAlias?: string;
        };
        JobListResponse: {
            jobs: components["schemas"]["Job"][];
        };
        JobCreateRequest: {
            name: string;
            prompt: string;
            executionContext: {
                [key: string]: unknown;
            };
            notificationRoutes?: {
                [key: string]: unknown;
            }[];
            accessRequirements?: {
                target: {
                    /** @enum {string} */
                    kind: "tool_rule";
                    rule: string;
                } | {
                    /** @enum {string} */
                    kind: "capability";
                    capabilityId: string;
                    implementation?: {
                        /** @enum {string} */
                        kind: "configured_access" | "local_cli" | "mcp_server" | "builtin_tool";
                        name?: string;
                        executablePath?: string;
                        executableVersion?: string;
                        executableHash?: string;
                        commandTemplate?: string;
                        authPreflight?: string;
                        protectedPaths?: string[];
                    };
                } | {
                    /** @enum {string} */
                    kind: "mcp_server";
                    server: string;
                };
                reason?: string;
            }[];
            /** @enum {string} */
            kind?: "manual" | "once" | "recurring";
            /** Format: date-time */
            runAt?: string;
            schedule?: {
                [key: string]: unknown;
            };
            modelAlias?: string;
            dryRun?: boolean;
        };
        JobCreateResponse: {
            jobId?: string;
            dryRun?: boolean;
            status?: string;
            setup?: {
                [key: string]: unknown;
            };
            runtimeContext?: {
                [key: string]: unknown;
            };
            modelAlias?: string;
            modelSource?: string;
        };
        JobUpdateRequest: {
            name?: string;
            prompt?: string;
            executionContext?: {
                [key: string]: unknown;
            };
            notificationRoutes?: {
                [key: string]: unknown;
            }[];
            accessRequirements?: {
                target: {
                    /** @enum {string} */
                    kind: "tool_rule";
                    rule: string;
                } | {
                    /** @enum {string} */
                    kind: "capability";
                    capabilityId: string;
                    implementation?: {
                        /** @enum {string} */
                        kind: "configured_access" | "local_cli" | "mcp_server" | "builtin_tool";
                        name?: string;
                        executablePath?: string;
                        executableVersion?: string;
                        executableHash?: string;
                        commandTemplate?: string;
                        authPreflight?: string;
                        protectedPaths?: string[];
                    };
                } | {
                    /** @enum {string} */
                    kind: "mcp_server";
                    server: string;
                };
                reason?: string;
            }[];
            /** @enum {string} */
            status?: "active" | "paused";
            modelAlias?: string;
        };
        JobEventListResponse: {
            events: components["schemas"]["RuntimeEvent"][];
        };
        JobPauseResponse: {
            [key: string]: unknown;
        };
        JobResumeResponse: {
            resumed: boolean;
            setup?: {
                [key: string]: unknown;
            };
        };
        JobTriggerResponse: {
            triggerId: string;
        };
        DeleteResponse: {
            deleted: boolean;
        };
        TriggerWaitResponse: {
            [key: string]: unknown;
        };
        Webhook: {
            webhookId: string;
            appId: string;
            name: string;
            /** Format: uri */
            url: string;
            enabled: boolean;
            eventTypes: ("session.message.inbound" | "session.message.outbound" | "session.message.streaming" | "session.typing" | "session.progress" | "session.compaction.queued" | "session.compaction.running" | "session.compaction.ready" | "session.compaction.degraded" | "session.compaction.failed" | "session.compaction.timeout" | "conversation.message.inbound" | "conversation.message.outbound" | "job.triggered" | "job.run.started" | "job.started" | "job.streaming" | "job.heartbeat" | "job.setup_required" | "job.tool_denied" | "job.tool_activity" | "task.started" | "task.progress" | "task.updated" | "task.notification" | "job.completed" | "job.failed" | "job.run.completed" | "job.run.failed" | "permission.requested" | "permission.allowed" | "permission.denied" | "permission.cancelled" | "permission.persisted" | "permission.resumed" | "permission.final_outcome" | "permission.yolo_denylist_hit" | "permission.classifier_decision" | "interaction.pending" | "credential.capability.updated" | "credential.capability.removed" | "credential.model.updated" | "credential.model.disabled" | "credential.model.used" | "profile.file.read" | "profile.file.updated" | "egress.connect" | "mcp.tool_activity" | "sandbox.blocked" | "model.usage" | "run.started" | "run.startup_diagnostic" | "run.failover" | "run.canceled" | "run.completed" | "run.failed" | "run.timeout" | "run.dead_lettered" | "proactive.surfacing.outcome" | "webhook.test")[] | null;
            agentId: string | null;
            sessionId: string | null;
            jobId: string | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        WebhookListResponse: {
            webhooks: components["schemas"]["Webhook"][];
        };
        WebhookCreateRequest: {
            name: string;
            /** Format: uri */
            url: string;
            secret?: string;
            enabled?: boolean;
            eventTypes?: ("session.message.inbound" | "session.message.outbound" | "session.message.streaming" | "session.typing" | "session.progress" | "session.compaction.queued" | "session.compaction.running" | "session.compaction.ready" | "session.compaction.degraded" | "session.compaction.failed" | "session.compaction.timeout" | "conversation.message.inbound" | "conversation.message.outbound" | "job.triggered" | "job.run.started" | "job.started" | "job.streaming" | "job.heartbeat" | "job.setup_required" | "job.tool_denied" | "job.tool_activity" | "task.started" | "task.progress" | "task.updated" | "task.notification" | "job.completed" | "job.failed" | "job.run.completed" | "job.run.failed" | "permission.requested" | "permission.allowed" | "permission.denied" | "permission.cancelled" | "permission.persisted" | "permission.resumed" | "permission.final_outcome" | "permission.yolo_denylist_hit" | "permission.classifier_decision" | "interaction.pending" | "credential.capability.updated" | "credential.capability.removed" | "credential.model.updated" | "credential.model.disabled" | "credential.model.used" | "profile.file.read" | "profile.file.updated" | "egress.connect" | "mcp.tool_activity" | "sandbox.blocked" | "model.usage" | "run.started" | "run.startup_diagnostic" | "run.failover" | "run.canceled" | "run.completed" | "run.failed" | "run.timeout" | "run.dead_lettered" | "proactive.surfacing.outcome" | "webhook.test")[] | null;
            agentId?: string | null;
            sessionId?: string | null;
            jobId?: string | null;
        };
        WebhookUpdateRequest: {
            name?: string;
            /** Format: uri */
            url?: string;
            secret?: string;
            enabled?: boolean;
            eventTypes?: ("session.message.inbound" | "session.message.outbound" | "session.message.streaming" | "session.typing" | "session.progress" | "session.compaction.queued" | "session.compaction.running" | "session.compaction.ready" | "session.compaction.degraded" | "session.compaction.failed" | "session.compaction.timeout" | "conversation.message.inbound" | "conversation.message.outbound" | "job.triggered" | "job.run.started" | "job.started" | "job.streaming" | "job.heartbeat" | "job.setup_required" | "job.tool_denied" | "job.tool_activity" | "task.started" | "task.progress" | "task.updated" | "task.notification" | "job.completed" | "job.failed" | "job.run.completed" | "job.run.failed" | "permission.requested" | "permission.allowed" | "permission.denied" | "permission.cancelled" | "permission.persisted" | "permission.resumed" | "permission.final_outcome" | "permission.yolo_denylist_hit" | "permission.classifier_decision" | "interaction.pending" | "credential.capability.updated" | "credential.capability.removed" | "credential.model.updated" | "credential.model.disabled" | "credential.model.used" | "profile.file.read" | "profile.file.updated" | "egress.connect" | "mcp.tool_activity" | "sandbox.blocked" | "model.usage" | "run.started" | "run.startup_diagnostic" | "run.failover" | "run.canceled" | "run.completed" | "run.failed" | "run.timeout" | "run.dead_lettered" | "proactive.surfacing.outcome" | "webhook.test")[] | null;
            agentId?: string | null;
            sessionId?: string | null;
            jobId?: string | null;
        };
        WebhookTestResponse: {
            accepted: boolean;
            eventId: number;
        };
        CountResponse: {
            [key: string]: number;
        };
        ExternalIngress: {
            ingressId: string;
            appId: string;
            name: string;
            enabled: boolean;
            metadata?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        ExternalIngressListResponse: components["schemas"]["ExternalIngress"][];
        ExternalIngressRequest: {
            name: string;
            enabled?: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
        ExternalIngressConversationMessageTarget: {
            /** @enum {string} */
            kind: "conversation_message";
            conversationId: string;
            threadId?: string;
            agentId?: string;
            message: string;
            senderId?: string;
            senderName?: string;
            messageRef?: string;
            correlationId?: string;
        };
        ExternalIngressInvokeRequest: {
            appId?: string;
            idempotencyKey?: string;
            target: components["schemas"]["ExternalIngressConversationMessageTarget"] | {
                [key: string]: unknown;
            };
        };
        ExternalIngressInvokeResponse: {
            invocationId?: string;
            duplicate?: boolean;
            targetKind?: string;
            messageId?: string;
            acceptedEventId?: number;
            conversationId?: string;
            threadId?: string | null;
            sessionId?: string;
            jobId?: string;
            triggerId?: string;
        } & {
            [key: string]: unknown;
        };
        MemoryItem: {
            id: string;
            appId: string;
            agentId?: string;
            userId?: string;
            groupId?: string;
            channelId?: string;
            threadId?: string;
            /** @enum {string} */
            kind: "preference" | "decision" | "fact" | "correction" | "constraint";
            content: string;
            metadata?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        MemoryListResponse: {
            memories: components["schemas"]["MemoryItem"][];
        };
        MemorySearchResponse: {
            results: components["schemas"]["MemoryItem"][];
        };
        MemoryItemResponse: {
            memory: components["schemas"]["MemoryItem"];
        };
        MemorySaveRequest: {
            appId?: string;
            agentId?: string;
            userId?: string;
            groupId?: string;
            channelId?: string;
            threadId?: string;
            /** @enum {string} */
            kind: "preference" | "decision" | "fact" | "correction" | "constraint";
            content: string;
            metadata?: {
                [key: string]: unknown;
            };
        };
        MemorySearchRequest: {
            appId?: string;
            query: string;
            limit?: number;
            agentId?: string;
            userId?: string;
            groupId?: string;
        };
        MemoryDreamingTriggerRequest: {
            appId?: string;
            agentId?: string;
            userId?: string;
            groupId?: string;
            channelId?: string;
            threadId?: string;
            /** @enum {string} */
            subjectType?: "user" | "group" | "channel" | "common";
            subjectId?: string;
            /** @enum {string} */
            phase?: "light" | "rem" | "deep" | "all";
            dryRun?: boolean;
            timeoutMs?: number;
            deadlineAtMs?: number;
        };
        MemoryDreamingResponse: {
            run: {
                [key: string]: unknown;
            };
        };
        MemoryDreamingStatusResponse: {
            runs: {
                [key: string]: unknown;
            }[];
        };
        Skill: {
            id: string;
            appId: string;
            name: string;
            displayName?: string;
            description?: string;
            status: string;
            requiredEnvVars?: string[];
            actionPermissions?: {
                id: string;
                capabilityId: string;
                displayName: string;
                /** @enum {string} */
                risk: "read" | "write" | "admin";
                can: string;
                cannot: string;
                requiredEnvVars: string[];
                commandTemplates: string[];
                networkHosts?: string[];
            }[];
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        SkillListResponse: {
            skills: components["schemas"]["Skill"][];
        };
        SkillResponse: {
            skill: components["schemas"]["Skill"];
        };
        SkillFilesResponse: {
            skill: components["schemas"]["Skill"];
            files: {
                [key: string]: unknown;
            }[];
        };
        SkillFileResponse: {
            file: {
                [key: string]: unknown;
            };
        };
        AgentSkillBindingResponse: {
            binding: {
                [key: string]: unknown;
            };
        };
        AgentSkillBindingRequest: {
            appId?: string;
            required?: boolean;
        };
        AgentSkillBindingListResponse: {
            bindings: {
                [key: string]: unknown;
            }[];
        };
        McpServer: {
            id: string;
            appId: string;
            name: string;
            displayName?: string;
            description?: string;
            status: string;
            transport?: string;
            config?: {
                [key: string]: unknown;
            };
            allowedToolPatterns?: string[];
            autoApproveToolPatterns?: string[];
            credentialRefs?: {
                [key: string]: unknown;
            }[];
            networkHosts?: string[];
            sandboxProfileId?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        McpServerPageResponse: {
            servers?: components["schemas"]["McpServer"][];
            nextCursor?: string | null;
        };
        McpServerRequest: {
            appId?: string;
            name: string;
            displayName?: string;
            description?: string;
            transport: string;
            config: {
                [key: string]: unknown;
            };
            allowedToolPatterns?: string[];
            autoApproveToolPatterns?: string[];
            credentialRefs?: {
                [key: string]: unknown;
            }[];
            networkHosts?: string[];
            sandboxProfileId?: string;
            riskClass?: string;
        };
        McpServerResponse: {
            server: components["schemas"]["McpServer"];
        };
        McpServerTestRequest: {
            appId?: string;
            testedBy?: string;
        };
        McpServerTestResponse: {
            ok: boolean;
            message: string;
            server: components["schemas"]["McpServer"];
        };
        AgentMcpServerBindingResponse: {
            binding: {
                [key: string]: unknown;
            };
        };
        AgentMcpServerBindingRequest: {
            appId?: string;
            required?: boolean;
            permissionPolicyIds?: string[];
            allowedToolPatterns?: string[];
        };
        AgentMcpServerBindingListResponse: {
            bindings: {
                [key: string]: unknown;
            }[];
        };
        LlmJsonValue: unknown;
        LlmJsonObject: unknown;
        LlmMessagesContentBlockInput: {
            /** @enum {string} */
            type: "text";
            text: string;
            cache_control?: {
                /** @enum {string} */
                type: "ephemeral";
                /** @enum {string} */
                ttl?: "5m" | "1h";
            };
        } | ({
            type: string;
        } & {
            [key: string]: unknown;
        });
        LlmMessagesInputMessage: {
            /** @enum {string} */
            role: "user" | "assistant";
            content: string | components["schemas"]["LlmMessagesContentBlockInput"][];
        };
        LlmMessagesTool: {
            name: string;
            description?: string;
            input_schema: {
                /** @enum {string} */
                type: "object";
                properties?: Record<string, never> | null;
                required?: string[] | null;
            } & {
                [key: string]: unknown;
            };
            cache_control?: {
                /** @enum {string} */
                type: "ephemeral";
                /** @enum {string} */
                ttl?: "5m" | "1h";
            };
            strict?: boolean;
            defer_loading?: boolean;
        };
        LlmMessagesToolChoice: {
            /** @enum {string} */
            type: "auto" | "any" | "tool" | "none";
            name?: string;
            disable_parallel_tool_use?: boolean;
        };
        LlmMessagesThinking: {
            /** @enum {string} */
            type: "enabled" | "disabled" | "adaptive";
            budget_tokens?: number;
            /** @enum {string|null} */
            display?: "summarized" | "omitted" | null;
        };
        LlmMessagesOutputConfig: {
            /** @enum {string|null} */
            effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
            /** @description Provider JSON output-format schema. */
            format?: components["schemas"]["LlmJsonObject"] | null;
        };
        LlmMessagesRequest: {
            /** @description Registered Gantry model alias. */
            model: string;
            messages: components["schemas"]["LlmMessagesInputMessage"][];
            system?: string | {
                /** @enum {string} */
                type: "text";
                text: string;
                cache_control?: {
                    /** @enum {string} */
                    type: "ephemeral";
                    /** @enum {string} */
                    ttl?: "5m" | "1h";
                };
            }[];
            tools?: components["schemas"]["LlmMessagesTool"][];
            tool_choice?: components["schemas"]["LlmMessagesToolChoice"];
            thinking?: components["schemas"]["LlmMessagesThinking"];
            cache_control?: {
                /** @enum {string} */
                type: "ephemeral";
                /** @enum {string} */
                ttl?: "5m" | "1h";
            } | null;
            output_config?: components["schemas"]["LlmMessagesOutputConfig"];
            betas?: string[];
            max_tokens: number;
            stream?: boolean;
            stop_sequences?: string[];
            temperature?: number;
            top_p?: number;
            top_k?: number;
            metadata?: {
                user_id?: string;
            };
            /** @enum {string} */
            service_tier?: "auto" | "standard_only";
        };
        LlmMessagesCountTokensRequest: {
            /** @description Registered Gantry model alias. */
            model: string;
            messages: components["schemas"]["LlmMessagesInputMessage"][];
            system?: string | {
                /** @enum {string} */
                type: "text";
                text: string;
                cache_control?: {
                    /** @enum {string} */
                    type: "ephemeral";
                    /** @enum {string} */
                    ttl?: "5m" | "1h";
                };
            }[];
            tools?: components["schemas"]["LlmMessagesTool"][];
            tool_choice?: components["schemas"]["LlmMessagesToolChoice"];
            thinking?: components["schemas"]["LlmMessagesThinking"];
            cache_control?: {
                /** @enum {string} */
                type: "ephemeral";
                /** @enum {string} */
                ttl?: "5m" | "1h";
            } | null;
            output_config?: components["schemas"]["LlmMessagesOutputConfig"];
            betas?: string[];
        };
        LlmMessagesResponseContentBlock: {
            /** @enum {string} */
            type: "text";
            text: string;
            citations?: components["schemas"]["LlmJsonObject"][];
        } | {
            /** @enum {string} */
            type: "thinking";
            thinking: string;
            signature: string;
        } | {
            /** @enum {string} */
            type: "redacted_thinking";
            data: string;
        } | {
            /** @enum {string} */
            type: "tool_use";
            id: string;
            name: string;
            input: components["schemas"]["LlmJsonObject"];
        };
        LlmMessagesUsage: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
            service_tier?: string;
        };
        LlmMessagesResponse: {
            id: string;
            /** @enum {string} */
            type: "message";
            /** @enum {string} */
            role: "assistant";
            content: components["schemas"]["LlmMessagesResponseContentBlock"][];
            model: string;
            stop_reason: string | null;
            stop_sequence: string | null;
            usage: components["schemas"]["LlmMessagesUsage"];
        };
        LlmMessagesCountTokensResponse: {
            input_tokens: number;
        };
        LlmChatContentPart: {
            /** @enum {string} */
            type: "text";
            text: string;
        } | {
            /** @enum {string} */
            type: "image_url";
            image_url: string | {
                url: string;
                /** @enum {string} */
                detail?: "auto" | "low" | "high";
            };
        } | {
            /** @enum {string} */
            type: "refusal";
            refusal: string;
        };
        LlmChatToolCall: {
            id: string;
            /** @enum {string} */
            type: "function";
            function: {
                name: string;
                arguments: string;
            };
        };
        LlmChatInputMessage: {
            /** @enum {string} */
            role: "developer" | "system" | "user" | "assistant" | "tool";
            content?: string | null | components["schemas"]["LlmChatContentPart"][];
            name?: string;
            tool_call_id?: string;
            refusal?: string | null;
            tool_calls?: components["schemas"]["LlmChatToolCall"][];
        };
        LlmChatFunctionTool: {
            /** @enum {string} */
            type: "function";
            function: {
                name: string;
                description?: string;
                parameters?: components["schemas"]["LlmJsonObject"];
                strict?: boolean;
            };
        };
        LlmChatResponseFormat: {
            /** @enum {string} */
            type: "text";
        } | {
            /** @enum {string} */
            type: "json_object";
        } | {
            /** @enum {string} */
            type: "json_schema";
            json_schema: {
                name: string;
                description?: string;
                schema: components["schemas"]["LlmJsonObject"];
                strict?: boolean;
            };
        };
        LlmChatCompletionsRequest: {
            /** @description Registered Gantry model alias. */
            model: string;
            messages: components["schemas"]["LlmChatInputMessage"][];
            max_tokens?: number;
            max_completion_tokens?: number;
            stream?: boolean;
            stream_options?: {
                include_usage?: boolean;
            };
            temperature?: number;
            top_p?: number;
            n?: number;
            stop?: string | string[] | null;
            presence_penalty?: number;
            frequency_penalty?: number;
            logit_bias?: {
                [key: string]: number;
            };
            logprobs?: boolean;
            top_logprobs?: number;
            user?: string;
            seed?: number;
            tools?: components["schemas"]["LlmChatFunctionTool"][];
            tool_choice?: ("none" | "auto" | "required") | {
                /** @enum {string} */
                type: "function";
                function: {
                    name: string;
                };
            };
            parallel_tool_calls?: boolean;
            response_format?: components["schemas"]["LlmChatResponseFormat"];
            /** @enum {string} */
            reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
            service_tier?: string;
            store?: boolean;
            metadata?: {
                [key: string]: string;
            };
        };
        LlmChatResponseMessage: {
            /** @enum {string} */
            role: "assistant";
            content: string | null;
            refusal?: string | null;
            tool_calls?: components["schemas"]["LlmChatToolCall"][];
        };
        LlmChatUsage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            prompt_tokens_details?: components["schemas"]["LlmJsonObject"];
            completion_tokens_details?: components["schemas"]["LlmJsonObject"];
        };
        LlmChatCompletionsResponse: {
            id: string;
            /** @enum {string} */
            object: "chat.completion";
            created: number;
            model: string;
            choices: {
                index: number;
                message: components["schemas"]["LlmChatResponseMessage"];
                finish_reason: string | null;
                logprobs?: components["schemas"]["LlmJsonObject"] | null;
            }[];
            usage?: components["schemas"]["LlmChatUsage"] | null;
            service_tier?: string | null;
            system_fingerprint?: string | null;
        };
        ControlStatusResponse: {
            /** @enum {string} */
            title: "Gantry";
            /** @enum {string} */
            runtime: "Ready" | "Needs setup" | "Blocked";
            workspaceKey: string;
            agents: {
                ready: number;
                total: number;
            };
            conversations: {
                ready: number;
                total: number;
            };
            jobs: {
                ready: number;
                needsAction: number;
                blocked: number;
            };
            access: {
                approved: number;
                needsApproval: number;
            };
            /** @enum {string} */
            memory: "Ready" | "Needs setup" | "Needs review" | "Disabled";
            providers: {
                ready: number;
                needsConnection: number;
                blocked: number;
            };
            nextAction: {
                /** @enum {string} */
                kind: "runtime_blocked" | "missing_model_credential" | "missing_provider_connection" | "missing_conversation_install" | "missing_access_approval" | "blocked_job" | "memory_review_setup" | "none";
                label: string;
                params?: {
                    [key: string]: string;
                };
            };
            agentDetails: {
                id: string;
                name: string;
                modelAlias: string;
                workspaceKey: string;
                conversations: number;
                approvedCapabilities: number;
                activeJobs: number;
                /** @enum {string} */
                memory: "Ready" | "Needs setup" | "Needs review" | "Disabled";
                nextAction: {
                    /** @enum {string} */
                    kind: "runtime_blocked" | "missing_model_credential" | "missing_provider_connection" | "missing_conversation_install" | "missing_access_approval" | "blocked_job" | "memory_review_setup" | "none";
                    label: string;
                    params?: {
                        [key: string]: string;
                    };
                };
            }[];
        };
        SessionDetails: {
            session: {
                id: string;
                appId: string;
                agentId: string;
                conversationId?: string;
                threadId?: string;
                jobId?: string;
                userId?: string;
                /** @enum {string} */
                status: "active" | "reset" | "archived";
                model?: string;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
                /** Format: date-time */
                resetAt?: string;
            };
            providerSession: {
                provider: string;
                /** @enum {string} */
                status: "active" | "expired" | "reset" | "maintenance_compact" | "ready";
                hasProviderResume: boolean;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
            } | null;
        };
        SessionMessage: {
            id: string;
            appId: string;
            conversationId: string;
            threadId?: string;
            externalRef?: {
                /** @enum {string} */
                kind: "message";
                value: string;
            };
            /** @enum {string} */
            direction: "inbound" | "outbound" | "system" | "tool";
            senderUserId?: string;
            senderDisplayName?: string;
            /** @enum {string} */
            trust: "trusted" | "untrusted" | "system";
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            receivedAt?: string;
            /** @enum {string} */
            deliveryStatus?: "pending" | "sent" | "failed" | "partially_sent";
            /** Format: date-time */
            deliveredAt?: string;
            deliveryError?: string;
            parts: ({
                /** @enum {string} */
                kind: "text";
                text: string;
            } | {
                /** @enum {string} */
                kind: "markdown";
                markdown: string;
            } | {
                /** @enum {string} */
                kind: "code";
                language?: string;
                code: string;
            } | {
                /** @enum {string} */
                kind: "structured";
                value: unknown;
            } | {
                /** @enum {string} */
                kind: "tool_result";
                toolId: string;
                value: unknown;
            } | {
                /** @enum {string} */
                kind: "redacted";
                reason: string;
            })[];
            attachments: {
                id: string;
                messageId: string;
                /** @enum {string} */
                kind: "image" | "file" | "audio" | "video" | "other";
                contentType?: string;
                sizeBytes?: number;
                externalRef?: {
                    /** @enum {string} */
                    kind: "message_attachment";
                    value: string;
                };
                storageRef?: string;
                /** @enum {string} */
                trust: "trusted" | "untrusted" | "system";
            }[];
        };
        SessionMessageListResponse: {
            messages: components["schemas"]["SessionMessage"][];
        };
        SessionRuntimeEvent: {
            eventId: number;
            eventType: string;
            sessionId: string | null;
            threadId: string | null;
            correlationId: string | null;
            /** Format: date-time */
            createdAt: string;
            payload: unknown;
        };
        SessionRuntimeEventListResponse: {
            events: components["schemas"]["SessionRuntimeEvent"][];
        };
        SessionWaitEventResponse: {
            eventId: number;
            eventType: string;
            sessionId: string | null;
            threadId: string | null;
            correlationId: string | null;
            /** Format: date-time */
            createdAt: string;
            payload: unknown;
            afterEventId: number;
        };
        DiscoverProviderConversationsRequest: {
            query?: string;
            limit?: number;
            includeArchived?: boolean;
            providerMetadata?: {
                [key: string]: unknown;
            };
        };
        DisableMcpServerRequest: {
            appId?: string;
            disabledBy?: string;
            reason?: string;
        };
        BrainImportRequest: {
            appId?: string;
            pages?: {
                slug: string;
                markdown: string;
                title?: string;
                sourceRef?: string | null;
                authorId?: string | null;
            }[];
        };
        BrainImportResponse: {
            imported: number;
            created: number;
            updated: number;
        };
        BrainStatusResponse: {
            status: {
                pages: number;
                channelPages: number;
                dreamPages: number;
                entities: number;
                edges: number;
                dreamDecisions: number;
                lastDreamCursor: string | null;
                readyEmbeddings: number;
                pendingEmbeddings: number;
                harvestEnabledConversations: number;
            };
        };
        ErrorEnvelope: {
            error: {
                /** @example INVALID_REQUEST */
                code: string;
                message: string;
                details: Record<string, never> | null;
                retryable: boolean;
                /** Format: uuid */
                requestId: string;
            };
        };
    };
    responses: {
        /** @description Invalid request. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Missing or invalid API key. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description API key lacks app access or required scopes. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Requested resource was not found. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Unexpected control server failure. */
        InternalError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ControlStatusResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getDoctor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DoctorResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    previewGuidedAction: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["GuidedActionRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidedActionPreview"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    executeGuidedAction: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["GuidedActionRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidedActionResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listModels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getModelDefaults: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelDefaultsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchModelDefaults: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelDefaultsPatchRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelDefaultsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    previewModelSelection: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelPreviewRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelPreviewResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listModelCredentials: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCredentialListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    putModelCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model credential provider id. */
                providerId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelCredentialWriteRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCredentialMutationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    disableModelCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model credential provider id. */
                providerId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCredentialMutationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchModelCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model credential provider id. */
                providerId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelCredentialPatchRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCredentialMutationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchSettingsReadOnly: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReadOnlySettingsPatchRequest"];
            };
        };
        responses: {
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Request conflicts with current API policy. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            500: components["responses"]["InternalError"];
        };
    };
    listAgents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentCreateRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentUpdateRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getAgentAdminSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAdminSummaryResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getInventory: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InventoryResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CapabilityListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getCapability: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Capability id. */
                capabilityId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CapabilityManifest"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getAgentAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAccessResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    replaceAgentAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentAccessRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAccessResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listAgentProfileFiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentProfileFilesResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getAgentProfileFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Profile file kind (soul | agents). */
                kind: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentProfileFileContentResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    setAgentProfileFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Profile file kind (soul | agents). */
                kind: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutAgentProfileFileRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentProfileFileContentResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    ensureSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionEnsureRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionEnsureResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionDetails"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listSessionMessages: {
        parameters: {
            query?: {
                /** @description Maximum number of messages. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionMessageListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    sendSessionMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendSessionMessageRequest"];
            };
        };
        responses: {
            /** @description Request accepted for asynchronous processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SendSessionMessageResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listOrStreamSessionEvents: {
        parameters: {
            query?: {
                /** @description Event cursor. */
                afterEventId?: number;
            };
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionRuntimeEventListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    waitForSessionEvent: {
        parameters: {
            query?: {
                /** @description Event cursor. */
                afterEventId?: number;
                /** @description Timeout in milliseconds. */
                timeoutMs?: number;
            };
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionWaitEventResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listSessionRuns: {
        parameters: {
            query?: {
                /** @description Maximum number of runs. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Session id. */
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listProviders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listProviderAccounts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderAccountListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createProviderAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderAccountRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderAccount"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getProviderAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider account id. */
                providerAccountId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderAccount"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    disableProviderAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider account id. */
                providerAccountId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderAccountDeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateProviderAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider account id. */
                providerAccountId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderAccountUpdateRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderAccount"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    discoverProviderConversations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider account id. */
                providerAccountId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["DiscoverProviderConversationsRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listConversations: {
        parameters: {
            query?: {
                /** @description Filter by provider account id. */
                providerAccountId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listConversationApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationApproversResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    replaceConversationApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConversationApproversRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationApproversResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listConversationThreads: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationThreadListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listConversationMessages: {
        parameters: {
            query?: {
                /** @description Thread or topic id. */
                threadId?: string;
                /** @description Cursor or timestamp. */
                after?: string;
                /** @description Maximum number of messages. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessageListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listConversationInstalls: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationInstallListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    enableConversationInstall: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConversationInstallRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationInstall"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    disableConversationInstall: {
        parameters: {
            query?: {
                /** @description Optional thread install to disable. */
                threadId?: string;
            };
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationInstallDeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateConversationInstall: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Conversation id. */
                conversationId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConversationInstallRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationInstall"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    queryUsage: {
        parameters: {
            query: {
                /** @description Inclusive range start as an ISO 8601 date-time. */
                from: string;
                /** @description Exclusive range end as an ISO 8601 date-time. */
                to: string;
                /** @description Agent id filter. */
                agentId?: string;
                /** @description Control API key id filter. */
                apiKeyId?: string;
                /** @description Run id filter. */
                runId?: string;
                /** @description Job id filter. */
                jobId?: string;
                /** @description Model alias filter. */
                model?: string;
                /** @description Aggregation dimension. */
                group_by?: "agent" | "api_key" | "model" | "day";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UsageQueryResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    invokeLlmMessages: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["LlmMessagesRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmMessagesResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    invokeLlmMessagesCountTokens: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["LlmMessagesCountTokensRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmMessagesCountTokensResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    invokeLlmChatCompletions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["LlmChatCompletionsRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmChatCompletionsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listJobs: {
        parameters: {
            query?: {
                /** @description Status filters; repeat for multiple values. */
                status?: string[];
                /** @description Workspace key filter. */
                workspaceKey?: string;
                /** @description Agent id filter. */
                agentId?: string;
                /** @description Job kind filter. */
                kind?: "manual" | "once" | "recurring";
                /** @description Conversation JID filter. */
                conversationJid?: string;
                /** @description Maximum number of jobs. */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createJob: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["JobCreateRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobCreateResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Job"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["JobUpdateRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Job"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listJobEvents: {
        parameters: {
            query?: {
                /** @description Run id filter. */
                run?: string;
                /** @description Run id filter alias. */
                runId?: string;
                /** @description Runtime event type filter. */
                eventType?: string;
                /** @description Return events after this event id. */
                sinceId?: number;
                /** @description Return events after this timestamp. */
                since?: string;
                /** @description Maximum number of events. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobEventListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    pauseJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobPauseResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    resumeJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobResumeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    triggerJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Job id. */
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request accepted for asynchronous processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobTriggerResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    waitForTrigger: {
        parameters: {
            query?: {
                /** @description Timeout in milliseconds. */
                timeoutMs?: number;
            };
            header?: never;
            path: {
                /** @description Trigger id. */
                triggerId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggerWaitResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listRuns: {
        parameters: {
            query?: {
                /** @description Optional job id filter. */
                jobId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Run id. */
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Run"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listRunEvents: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Run id. */
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeEventListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookCreateRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Webhook id. */
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Webhook id. */
                webhookId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookUpdateRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    testWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Webhook id. */
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request accepted for asynchronous processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookTestResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    replayWebhookDeadLetters: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Webhook id. */
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CountResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    purgeWebhookDeadLetters: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Webhook id. */
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CountResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listExternalIngresses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngressListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExternalIngressRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngress"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngress"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExternalIngressRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngress"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    rotateExternalIngressSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngress"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    invokeExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExternalIngressInvokeRequest"];
            };
        };
        responses: {
            /** @description Request accepted for asynchronous processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngressInvokeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    waitForExternalIngress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Ingress id. */
                ingressId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExternalIngressInvokeRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExternalIngressInvokeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listMemory: {
        parameters: {
            query?: {
                /** @description App id. Defaults to API key app. */
                appId?: string;
                /** @description Agent id filter. */
                agentId?: string;
                /** @description User id filter. */
                userId?: string;
                /** @description Group id filter. */
                groupId?: string;
                /** @description Channel id filter. */
                channelId?: string;
                /** @description Thread id filter. */
                threadId?: string;
                /** @description Text query. */
                q?: string;
                /** @description Maximum number of memory items. */
                limit?: number;
                /** @description Include common memory. */
                includeCommon?: boolean;
                /** @description Subject type filters. */
                subjectType?: string[];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createMemory: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemorySaveRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItemResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    searchMemory: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemorySearchRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemorySearchResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteMemory: {
        parameters: {
            query?: {
                /** @description App id. Defaults to API key app. */
                appId?: string;
                /** @description Agent id filter. */
                agentId?: string;
                /** @description User id filter. */
                userId?: string;
                /** @description Group id filter. */
                groupId?: string;
                /** @description Channel id filter. */
                channelId?: string;
                /** @description Thread id filter. */
                threadId?: string;
            };
            header?: never;
            path: {
                /** @description Memory item id. */
                memoryId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchMemory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Memory item id. */
                memoryId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemorySaveRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItemResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    triggerMemoryDreaming: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemoryDreamingTriggerRequest"];
            };
        };
        responses: {
            /** @description Request accepted for asynchronous processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryDreamingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getMemoryDreamingStatus: {
        parameters: {
            query?: {
                /** @description App id. Defaults to API key app. */
                appId?: string;
                /** @description Agent id filter. */
                agentId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryDreamingStatusResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    importBrainPages: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrainImportRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrainImportResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getBrainStatus: {
        parameters: {
            query?: {
                /** @description App id. Defaults to API key app. */
                appId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrainStatusResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listSkills: {
        parameters: {
            query?: {
                /** @description Agent id filter. */
                agentId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    installSkill: {
        parameters: {
            query?: {
                /** @description App id. Defaults to API key app. */
                appId?: string;
                /** @description Agent id to bind after install. */
                agentId?: string;
                /** @description Installer identity. */
                createdBy?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Zip archive containing a skill package. */
        requestBody: {
            content: {
                "application/zip": string;
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listSkillFiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Skill id. */
                skillId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillFilesResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getSkillFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Skill id. */
                skillId: string;
                /** @description Skill-relative file path. */
                filePath: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillFileResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listAgentSkillBindings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSkillBindingListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    bindSkillToAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Skill id. */
                skillId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentSkillBindingRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSkillBindingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    unbindSkillFromAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description Skill id. */
                skillId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSkillBindingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listMcpServers: {
        parameters: {
            query?: {
                /** @description Server status filter. */
                status?: "active" | "disabled";
                /** @description Maximum number of servers. */
                limit?: number;
                /** @description Pagination cursor. */
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerPageResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    connectMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpServerRequest"];
            };
        };
        responses: {
            /** @description Resource created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    disableMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["DisableMcpServerRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    testMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpServerTestRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerTestResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listAgentMcpServerBindings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentMcpServerBindingListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    bindMcpServerToAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMcpServerBindingRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentMcpServerBindingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    unbindMcpServerFromAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentMcpServerBindingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    updateAgentMcpServerBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                agentId: string;
                /** @description MCP server id. */
                serverId: string;
            };
            cookie?: never;
        };
        /** @description JSON request payload. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMcpServerBindingRequest"];
            };
        };
        responses: {
            /** @description Request succeeded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentMcpServerBindingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
}
