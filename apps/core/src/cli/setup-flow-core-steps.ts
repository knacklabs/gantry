import * as p from '@clack/prompts';

import {
  ensureRuntimeWritable,
  resolveRuntimeHome,
} from '../config/settings/runtime-home.js';
import { validatePostgresConnectionUrl } from '../adapters/storage/postgres/url.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  formatModelDisplay,
  getModelPreset,
  isModelPresetId,
  listModelCatalogEntries,
  listModelPresets,
  resolveModelSelectionForWorkload,
} from '../shared/model-catalog.js';
import {
  ONECLI_DEFAULT_SCHEMA,
  renderOnecliDatabaseUrl,
  validateOnecliDatabaseUrl,
  validateSharedPostgresDatabase,
} from '../adapters/credentials/onecli/local/persistence.js';
import {
  type FlowAction,
  isInputFlowControl,
  parseInputFlowControl,
  toAction,
} from './setup-flow-control.js';
import { chooseProgressAction } from './setup-flow-prompts.js';
import type { SetupDraft } from './setup-flow-state.js';

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
      `Cannot write to ${resolved}. Next action: fix permissions or choose another path. (${message})`,
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
        'Gantry ships a docker-compose.yml for local Postgres + OneCLI if you want a ready local stack.',
        'Setup will not start Docker or create containers. Start your database first, then paste the URLs below.',
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

  const onecliSchema = await p.text({
    message: 'OneCLI Postgres schema',
    placeholder: ONECLI_DEFAULT_SCHEMA,
    defaultValue: draft.onecliPostgresSchema || ONECLI_DEFAULT_SCHEMA,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(trimmed)) {
        return 'Use a lowercase PostgreSQL schema identifier.';
      }
      if (trimmed === draft.postgresSchema) {
        return 'OneCLI schema must be separate from the Gantry schema.';
      }
      return undefined;
    },
  });
  if (p.isCancel(onecliSchema)) return { type: 'resume' };
  const onecliSchemaControl = parseInputFlowControl(onecliSchema);
  if (onecliSchemaControl) return onecliSchemaControl;
  draft.onecliPostgresSchema = String(onecliSchema).trim();

  const defaultOnecliUrl = draft.onecliPostgresDatabaseUrl;
  const onecliUrl = await p.text({
    message:
      'OneCLI Postgres URL (stored in ONECLI_DATABASE_URL, separate DB role)',
    placeholder: renderOnecliDatabaseUrl({
      postgresUrl:
        choice === 'hosted'
          ? 'postgres://onecli_user:pass@db.example.com:5432/gantry?sslmode=require'
          : 'postgres://onecli_user:pass@localhost:5432/gantry',
      schema: ONECLI_DEFAULT_SCHEMA,
    }),
    defaultValue: defaultOnecliUrl,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) {
        return 'OneCLI Postgres URL is required and must use a database role separate from Gantry.';
      }
      try {
        validatePostgresConnectionUrl(trimmed, {
          allowLocalhost: choice !== 'hosted',
        });
        const onecliValidation = validateOnecliDatabaseUrl({
          postgresUrl: trimmed,
          schema: draft.onecliPostgresSchema || ONECLI_DEFAULT_SCHEMA,
        });
        if (!onecliValidation.ok) {
          return onecliValidation.message;
        }
        const sharedDatabase = validateSharedPostgresDatabase({
          gantryPostgresUrl: normalizedUrl,
          onecliPostgresUrl: trimmed,
        });
        if (!sharedDatabase.ok) {
          return sharedDatabase.message;
        }
        if (new URL(trimmed).username === new URL(normalizedUrl).username) {
          return 'OneCLI and Gantry must use different Postgres roles.';
        }
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return undefined;
    },
  });
  if (p.isCancel(onecliUrl)) return { type: 'resume' };
  const onecliUrlControl = parseInputFlowControl(onecliUrl);
  if (onecliUrlControl) return onecliUrlControl;
  const normalizedOnecliUrl = String(onecliUrl).trim();
  validatePostgresConnectionUrl(normalizedOnecliUrl, {
    allowLocalhost: choice !== 'hosted',
  });
  const onecliValidation = validateOnecliDatabaseUrl({
    postgresUrl: normalizedOnecliUrl,
    schema: draft.onecliPostgresSchema || ONECLI_DEFAULT_SCHEMA,
  });
  if (!onecliValidation.ok) {
    throw new Error(onecliValidation.message);
  }
  const sharedDatabase = validateSharedPostgresDatabase({
    gantryPostgresUrl: normalizedUrl,
    onecliPostgresUrl: normalizedOnecliUrl,
  });
  if (!sharedDatabase.ok) {
    throw new Error(sharedDatabase.message);
  }
  if (
    new URL(normalizedOnecliUrl).username === new URL(normalizedUrl).username
  ) {
    throw new Error('OneCLI and Gantry must use different Postgres roles.');
  }
  draft.onecliPostgresDatabaseUrl = normalizedOnecliUrl;
  return { type: 'next' };
}

export async function runPrerequisitesStep(): Promise<FlowAction> {
  p.note(
    [
      'Gantry runs as a local host process.',
      'Proceed once Node.js and runtime-home checks are passing.',
    ].join('\n'),
    'Runtime Prerequisites',
  );

  return chooseProgressAction({
    message: 'Continue to provider selection?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

export async function runChannelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose your first provider',
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
      if (!trimmed) return 'Default agent name is required.';
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

  const preset = await p.select({
    message: 'Choose model preset',
    options: [
      ...listModelPresets().map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint: `Chat default ${preset.chatDefault}; memory is preset-managed.`,
      })),
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
    initialValue: draft.modelPreset || DEFAULT_MODEL_PRESET_ID,
  });

  if (p.isCancel(preset)) return { type: 'resume' };
  if (preset === 'back') return { type: 'back' };
  if (preset === 'resume' || preset === 'cancel') return { type: preset };
  if (!isModelPresetId(preset)) return { type: 'resume' };
  draft.modelPreset = preset;
  const selectedPreset = getModelPreset(draft.modelPreset);

  const chatModelOptions = listModelCatalogEntries()
    .filter(
      (entry) =>
        entry.modelRoute.id === draft.modelPreset &&
        entry.supportedWorkloads.includes('chat'),
    )
    .map((entry) => ({
      value: entry.recommendedAlias,
      label:
        entry.recommendedAlias === selectedPreset.chatDefault
          ? `${entry.displayName} (Recommended)`
          : entry.displayName,
      hint: `${formatModelDisplay(entry)}. Alias: ${entry.recommendedAlias}.`,
    }));
  const initialModel =
    chatModelOptions.some((option) => option.value === draft.selectedModel) &&
    resolveModelSelectionForWorkload(draft.selectedModel, 'chat').ok
      ? draft.selectedModel
      : selectedPreset.chatDefault;
  const value = await p.select({
    message: 'Choose main model',
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
    : selectedPreset.chatDefault;
  return { type: 'next' };
}
