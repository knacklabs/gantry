import * as p from '@clack/prompts';

import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import {
  ensureRuntimeWritable,
  resolveRuntimeHome,
} from '../config/settings/runtime-home.js';
import {
  ensureConfiguredAgent,
  loadDesiredRuntimeSettingsForWrite,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { validatePostgresConnectionUrl } from '../adapters/storage/postgres/url.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  listModelCatalogEntries,
  memoryModelDefaultsForProvider,
  type MemoryModelDefaults,
  resolveModelSelectionForWorkload,
} from '../shared/model-catalog.js';
import { getModelProviderDefinition } from '../shared/model-provider-registry.js';
import {
  formatContextWindow,
  formatCostPerMillion,
} from '../shared/model-catalog-format.js';
import { AUTO_AGENT_HARNESS } from '../shared/agent-engine.js';
import {
  type FlowAction,
  isInputFlowControl,
  parseInputFlowControl,
  toAction,
} from './setup-flow-control.js';
import { chooseProgressAction } from './setup-flow-prompts.js';
import type { SetupDraft } from './setup-flow-state.js';

function agentIdFromName(
  name: string,
  agents: Record<string, unknown>,
): string {
  const normalized =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 64)
      .replace(/[_-]+$/g, '') || 'agent';
  const base = ['global', 'shared'].includes(normalized)
    ? `agent_${normalized}`
    : normalized;
  let candidate = base;
  let suffix = 2;
  while (agents[candidate]) {
    // Reserve room for the suffix so collisions on 64-char names still
    // produce ids within the workspace-folder limit.
    const tail = `_${suffix}`;
    candidate = `${base.slice(0, 64 - tail.length).replace(/[_-]+$/g, '')}${tail}`;
    suffix += 1;
  }
  return candidate;
}

async function ensureModelCredentialForProvider(
  runtimeHome: string,
  providerId: string,
): Promise<boolean> {
  const {
    listReadyModelCredentialProviders,
    promptModelCredentialPayload,
    storeModelCredentialInput,
    verifyModelCredentialInputWithPrompt,
  } = await import('./credentials.js');
  const ready = await listReadyModelCredentialProviders(runtimeHome);
  if (ready.has(providerId)) return true;

  while (true) {
    const credentialInput = await promptModelCredentialPayload(providerId);
    if (!credentialInput) return false;
    const verification = await verifyModelCredentialInputWithPrompt({
      providerId,
      authMode: credentialInput.authMode,
      payload: credentialInput.payload,
    });
    if (verification.type === 'reenter') continue;
    if (verification.type !== 'verified' && verification.type !== 'skip') {
      return false;
    }
    await storeModelCredentialInput({
      runtimeHome,
      providerId,
      authMode: credentialInput.authMode,
      payload: credentialInput.payload,
    });
    return true;
  }
}

export async function runAddAgentSetupSlice(
  runtimeHome: string,
): Promise<number> {
  const agentName = await p.text({
    message: 'Agent name',
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (!trimmed) return 'Agent name is required.';
      if (trimmed.length > 80)
        return 'Agent name must be 80 characters or fewer.';
      return undefined;
    },
  });
  if (p.isCancel(agentName)) return 1;

  const modelValue = await p.select({
    message: 'Choose this agent chat model',
    options: [
      ...chatModelSelectOptions(),
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: DEFAULT_SETUP_MODEL_ALIAS,
  });
  if (p.isCancel(modelValue) || modelValue === 'cancel') return 1;
  const resolved = resolveModelSelectionForWorkload(String(modelValue), 'chat');
  if (!resolved.ok) {
    p.log.error(resolved.message);
    return 1;
  }

  const name = String(agentName).trim();
  const settingsBeforeConnect = await loadDesiredRuntimeSettingsForWrite({
    runtimeHome,
  });
  const agentId = agentIdFromName(name, settingsBeforeConnect.agents);
  const channelStateSnapshot = structuredClone({
    agents: settingsBeforeConnect.agents,
    providerAccounts: settingsBeforeConnect.providerAccounts,
    providers: settingsBeforeConnect.providers,
  });

  if (
    !(await ensureModelCredentialForProvider(
      runtimeHome,
      resolved.entry.modelRoute.id,
    ))
  ) {
    return 1;
  }

  const provider = await p.select({
    message: 'Choose a channel to connect this agent',
    options: [
      ...listConnectableChannelProviders().map((entry) => ({
        value: entry.id,
        label: entry.label,
        hint: entry.setup.describe(),
      })),
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(provider) || provider === 'cancel') return 1;

  const { runProviderConnectCommand } = await import('./provider-connect.js');
  const connectCode = await runProviderConnectCommand(
    runtimeHome,
    String(provider),
    agentId,
    name,
  );
  if (connectCode !== 0) return connectCode;

  // Connect preserves the owner of an already-registered conversation, so a
  // successful exit does not guarantee the NEW agent got bound. Persist the
  // agent only when a conversation route actually points at it.
  const { openRuntimeGroupDb } = await import('./runtime-group-db.js');
  const db = await openRuntimeGroupDb(runtimeHome);
  try {
    const routes = await db.getAllConversationRoutes();
    const bound = Object.values(routes).some(
      (route) => route.folder === agentId,
    );
    if (!bound) {
      // Connect may have persisted agent/account/provider state under the
      // new agent id even though no conversation got bound — restore the
      // pre-connect channel state so nothing dangles. Stored channel secrets
      // stay in the secret store, so reconnecting later is quick.
      const current = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
      const previous = structuredClone(current);
      current.agents = structuredClone(channelStateSnapshot.agents);
      current.providerAccounts = structuredClone(
        channelStateSnapshot.providerAccounts,
      );
      current.providers = structuredClone(channelStateSnapshot.providers);
      await writeDesiredRuntimeSettings({
        runtimeHome,
        settings: current,
        previousSettings: previous,
        createdBy: 'cli:setup-add-agent-rollback',
      });
      p.log.error(
        [
          'No conversation was bound to the new agent (an existing conversation keeps its current agent).',
          'Channel and agent changes from this attempt were rolled back; stored tokens remain saved.',
          'Pick a conversation that is not yet connected, then run "Add another agent" again.',
        ].join('\n'),
      );
      return 1;
    }
  } finally {
    await db.close();
  }

  // Persist the agent's name and model only after credential and channel
  // connection succeeded — a cancelled flow must not leave a dangling agent.
  const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
  const previousSettings = structuredClone(settings);
  ensureConfiguredAgent(settings, {
    agentId,
    agentName: name,
    agentFolder: agentId,
  });
  settings.agents[agentId]!.name = name;
  settings.agents[agentId]!.model = resolved.alias;
  const writeResult = await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
    createdBy: 'cli:setup-add-agent',
  });
  noteRestartRequired(writeResult);
  return 0;
}

export async function runWelcomeStep(): Promise<FlowAction> {
  p.note(
    [
      'This setup will connect your first channel and prepare your Gantry runtime home.',
      'You can go Back, Resume Later, or Cancel until the final create-runtime confirmation.',
    ].join('\n'),
    'Welcome',
  );
  return chooseProgressAction({
    message: 'Start guided setup now?',
    continueLabel: 'Start Setup',
    includeBack: false,
  });
}

export async function runRuntimeHomeStep(
  draft: SetupDraft,
): Promise<{ action: FlowAction; changedHome?: string }> {
  const defaultRuntimeHome = draft.runtimeHome || '~/gantry';
  const value = await p.text({
    message:
      'Where should Gantry store runtime data? (/back, /resume, /cancel)',
    placeholder: '~/gantry',
    defaultValue: defaultRuntimeHome,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if ((!input || !input.trim()) && !defaultRuntimeHome) {
        return 'Please enter a path (for example: ~/gantry).';
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    return { action: { type: 'resume' } };
  }
  const control = parseInputFlowControl(value);
  if (control) {
    return { action: control };
  }

  const resolved = resolveRuntimeHome(
    String(value).trim() || defaultRuntimeHome,
  );
  try {
    ensureRuntimeWritable(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      [
        `Setup blocked: cannot write to ${resolved} (${message})`,
        'Next action: choose another Runtime home path.',
      ].join('\n'),
    );
    return { action: { type: 'goto', step: 'runtime_home' } };
  }

  p.note(
    [
      `Runtime home: ${resolved}`,
      'Gantry will keep .env, settings.yaml, store/, agents/, data/, logs/, and onboarding state here.',
    ].join('\n'),
    'Runtime Home',
  );

  const action = await chooseProgressAction({
    message: 'Use this runtime home?',
    continueLabel: 'Use This Path',
    includeBack: true,
  });
  if (action.type !== 'next') {
    return { action };
  }
  return {
    action,
    changedHome: resolved,
  };
}

export async function runStorageStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    [
      'Gantry stores runtime state in Postgres.',
      'Use any Postgres URL: local Docker Compose, a locally installed database, or hosted Postgres such as Supabase/Neon.',
    ].join('\n'),
    'Storage',
  );

  const choice = await p.select({
    message: 'How should Gantry configure Postgres? (/back, /resume, /cancel)',
    options: [
      {
        value: 'local',
        label: 'Use local Postgres URL (Recommended)',
        hint: 'Start the provided docker-compose.yml or use your own local Postgres.',
      },
      {
        value: 'hosted',
        label: 'Use hosted Postgres',
        hint: 'For Neon, Supabase, or another managed Postgres URL.',
      },
      {
        value: 'existing',
        label: 'Use an existing Postgres URL',
        hint: 'Expert path for a database you already manage.',
      },
      { value: 'back', label: 'Back' },
      { value: 'resume', label: 'Resume Later' },
      { value: 'cancel', label: 'Cancel Setup' },
    ],
  });
  if (p.isCancel(choice)) return { type: 'resume' };
  if (choice === 'back' || choice === 'resume' || choice === 'cancel') {
    return toAction(choice);
  }

  if (choice === 'local') {
    p.note(
      [
        'Gantry ships a docker-compose.yml for local Postgres if you want a ready local database.',
        'Setup will not start Docker or create containers. Start your database first, then paste the URL below.',
      ].join('\n'),
      'Postgres',
    );
  }

  if (choice === 'hosted') {
    p.note(
      [
        'Use a managed Postgres database such as Neon or Supabase.',
        'Enable the vector extension and pg_trgm in the database before continuing.',
        'Remote URLs must include sslmode=require or stronger.',
        'On IPv4-only hosts, prefer an IPv4-capable pooler endpoint when your provider direct host resolves only to IPv6.',
        'If Node reports a certificate-chain error, install the provider CA bundle and set NODE_EXTRA_CA_CERTS in the runtime .env.',
      ].join('\n'),
      'Hosted Postgres',
    );
  }

  p.note(
    [
      'Gantry requires Postgres with pgvector, a text-search extension, and pg-boss readiness.',
      choice === 'hosted'
        ? 'Paste the hosted connection URL from your provider.'
        : 'Localhost and Docker-local URLs are supported.',
    ].join('\n'),
    'Postgres',
  );

  const url = await p.text({
    message: 'Postgres URL (stored in GANTRY_DATABASE_URL)',
    placeholder:
      'postgres://user:pass@db.example.com:5432/gantry?sslmode=require',
    defaultValue: draft.postgresDatabaseUrl,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) return 'Postgres URL is required.';
      try {
        validatePostgresConnectionUrl(trimmed, {
          allowLocalhost: choice !== 'hosted',
        });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return undefined;
    },
  });
  if (p.isCancel(url)) return { type: 'resume' };
  const urlControl = parseInputFlowControl(url);
  if (urlControl) return urlControl;
  const normalizedUrl = String(url).trim();
  validatePostgresConnectionUrl(normalizedUrl, {
    allowLocalhost: choice !== 'hosted',
  });
  draft.postgresSetupKind = choice;
  draft.postgresDatabaseUrl = normalizedUrl;

  const schema = await p.text({
    message: 'Postgres schema',
    placeholder: 'gantry',
    defaultValue: draft.postgresSchema || 'gantry',
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) return undefined;
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(trimmed)) {
        return 'Use a lowercase PostgreSQL schema identifier.';
      }
      return undefined;
    },
  });
  if (p.isCancel(schema)) return { type: 'resume' };
  const schemaControl = parseInputFlowControl(schema);
  if (schemaControl) return schemaControl;
  draft.postgresSchema = String(schema).trim();
  return { type: 'next' };
}

export async function runChannelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose your chat channel',
    options: [
      {
        value: 'telegram',
        label: 'Telegram (Recommended)',
        hint: 'Bot token from BotFather + chat auto-discovery.',
      },
      {
        value: 'slack',
        label: 'Slack',
        hint: 'Bot token + app token + conversation auto-discovery.',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.primaryProvider,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.primaryProvider = value === 'slack' ? 'slack' : 'telegram';
  return { type: 'next' };
}

export async function runModelStep(draft: SetupDraft): Promise<FlowAction> {
  const agentName = await p.text({
    message: 'Default agent name (/back, /resume, /cancel)',
    defaultValue: draft.agentName || 'Default Agent',
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) return undefined;
      if (trimmed.length > 80) {
        return 'Default agent name must be 80 characters or fewer.';
      }
      return undefined;
    },
  });
  if (p.isCancel(agentName)) return { type: 'resume' };
  const agentNameControl = parseInputFlowControl(agentName);
  if (agentNameControl) return agentNameControl;
  draft.agentName = String(agentName).trim();

  const chatModelOptions = chatModelSelectOptions();
  const initialModel =
    chatModelOptions.some((option) => option.value === draft.selectedModel) &&
    resolveModelSelectionForWorkload(draft.selectedModel, 'chat').ok
      ? draft.selectedModel
      : DEFAULT_SETUP_MODEL_ALIAS;
  const value = await p.select({
    message: 'Choose your main chat model',
    options: [
      ...chatModelOptions,
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: initialModel,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume' || value === 'cancel') return { type: value };
  const resolvedModel = resolveModelSelectionForWorkload(String(value), 'chat');
  draft.selectedModel = resolvedModel.ok
    ? resolvedModel.alias
    : DEFAULT_SETUP_MODEL_ALIAS;
  if (resolvedModel.ok) {
    p.note(
      `Memory LLM defaults derive from ${resolvedModel.entry.modelRoute.id}: ${formatMemoryDefaultAliases(memoryModelDefaultsForProvider(resolvedModel.entry.modelRoute.id))}. Memory embeddings use OpenAI when enabled.`,
    );
  }
  draft.agentHarness = AUTO_AGENT_HARNESS;
  return { type: 'next' };
}

export function chatModelSelectOptions(): Array<{
  value: string;
  label: string;
  hint: string;
}> {
  return listModelCatalogEntries()
    .filter((entry) => entry.supportedWorkloads.includes('chat'))
    .map((entry) => ({
      value: entry.recommendedAlias,
      label:
        entry.recommendedAlias === DEFAULT_SETUP_MODEL_ALIAS
          ? `${entry.displayName} (Recommended)`
          : entry.displayName,
      hint: `${entry.modelRoute.label} · Alias: ${entry.recommendedAlias} · Context: ${formatContextWindow(entry.contextWindowTokens)} · Cost: ${formatCostPerMillion(entry)} per 1M.`,
    }));
}

export async function runMemoryStep(draft: SetupDraft): Promise<FlowAction> {
  const memoryEnabled = await p.confirm({
    message: 'Enable memory?',
    initialValue: draft.memoryEnabled ?? true,
  });
  if (p.isCancel(memoryEnabled)) return { type: 'resume' };

  draft.memoryEnabled = Boolean(memoryEnabled);
  if (draft.memoryEnabled) {
    const chatModel = resolveModelSelectionForWorkload(
      draft.selectedModel || DEFAULT_SETUP_MODEL_ALIAS,
      'chat',
    );
    const chatProviderId = chatModel.ok ? chatModel.entry.modelRoute.id : '';
    const memoryDefaults = memoryModelDefaultsForProvider(chatProviderId);
    const memoryModel = resolveModelSelectionForWorkload(
      memoryDefaults.extractor,
      'memory_extractor',
    );
    const memoryProviderId = memoryModel.ok
      ? memoryModel.entry.modelRoute.id
      : chatProviderId;
    if (chatProviderId && memoryProviderId !== chatProviderId) {
      const memoryProvider =
        getModelProviderDefinition(memoryProviderId)?.label ?? memoryProviderId;
      p.note(
        `Memory models run on ${memoryProvider} and require its credential.`,
      );
      const memoryChoice = await p.select({
        message: 'Use memory with this extra credential?',
        options: [
          {
            value: 'keep',
            label: `Keep memory on (needs ${memoryProvider} credential)`,
          },
          { value: 'disable', label: 'Disable memory' },
          { value: 'back', label: 'Back' },
          { value: 'resume', label: 'Resume Later' },
        ],
        initialValue: 'keep',
      });
      if (p.isCancel(memoryChoice)) return { type: 'resume' };
      if (memoryChoice === 'back') return { type: 'back' };
      if (memoryChoice === 'resume') return { type: 'resume' };
      if (memoryChoice === 'disable') {
        draft.memoryEnabled = false;
        draft.embeddingsEnabled = false;
      }
    }
  }

  if (draft.memoryEnabled) {
    const embeddingsEnabled = await p.confirm({
      message:
        'Enable semantic search? Requires an OpenAI API key for embeddings',
      initialValue: draft.embeddingsEnabled ?? false,
    });
    if (p.isCancel(embeddingsEnabled)) return { type: 'resume' };
    draft.embeddingsEnabled = Boolean(embeddingsEnabled);
  } else {
    draft.embeddingsEnabled = false;
  }

  return chooseProgressAction({
    message: 'Use these memory settings?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

function formatMemoryDefaultAliases(defaults: MemoryModelDefaults): string {
  return [defaults.extractor, defaults.dreaming, defaults.consolidation].join(
    ', ',
  );
}
