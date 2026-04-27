import * as p from '@clack/prompts';

import {
  ensureRuntimeWritable,
  resolveRuntimeHome,
} from '../config/settings/runtime-home.js';
import { validatePostgresConnectionUrl } from '../adapters/storage/postgres/url.js';
import {
  CLAUDE_MODEL_PINS,
  DEFAULT_SETUP_MODEL,
  normalizeClaudeModelSelection,
} from '../models/claude-model-registry.js';
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
      'This setup will connect your first channel and prepare your MyClaw runtime home.',
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
  const defaultRuntimeHome = draft.runtimeHome || '~/myclaw';
  const value = await p.text({
    message:
      'Where should MyClaw store runtime data? (/back, /resume, /cancel)',
    placeholder: '~/myclaw',
    defaultValue: defaultRuntimeHome,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if ((!input || !input.trim()) && !defaultRuntimeHome) {
        return 'Please enter a path (for example: ~/myclaw).';
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
      'MyClaw will keep .env, settings.yaml, store/, agents/, data/, logs/, and onboarding state here.',
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
      'MyClaw stores runtime state in Postgres.',
      'Use any Postgres URL: local Docker Compose, a locally installed database, or hosted Postgres such as Supabase/Neon.',
    ].join('\n'),
    'Storage',
  );

  const choice = await p.select({
    message: 'How should MyClaw configure Postgres? (/back, /resume, /cancel)',
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
        'MyClaw ships a docker-compose.yml for local Postgres + OneCLI if you want a ready local stack.',
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
      'MyClaw requires Postgres with pgvector, a text-search extension, and pg-boss readiness.',
      choice === 'hosted'
        ? 'Paste the hosted connection URL from your provider.'
        : 'Localhost and Docker-local URLs are supported.',
    ].join('\n'),
    'Postgres',
  );

  const url = await p.text({
    message: 'Postgres URL (stored in MYCLAW_DATABASE_URL)',
    placeholder:
      'postgres://user:pass@db.example.com:5432/myclaw?sslmode=require',
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
    placeholder: 'myclaw',
    defaultValue: draft.postgresSchema || 'myclaw',
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
        return 'OneCLI schema must be separate from the MyClaw schema.';
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
          ? 'postgres://onecli_user:pass@db.example.com:5432/myclaw?sslmode=require'
          : 'postgres://onecli_user:pass@localhost:5432/myclaw',
      schema: ONECLI_DEFAULT_SCHEMA,
    }),
    defaultValue: defaultOnecliUrl,
    validate: (input) => {
      const trimmed = String(input ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) {
        return 'OneCLI Postgres URL is required and must use a database role separate from MyClaw.';
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
          myclawPostgresUrl: normalizedUrl,
          onecliPostgresUrl: trimmed,
        });
        if (!sharedDatabase.ok) {
          return sharedDatabase.message;
        }
        if (new URL(trimmed).username === new URL(normalizedUrl).username) {
          return 'OneCLI and MyClaw must use different Postgres roles.';
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
    myclawPostgresUrl: normalizedUrl,
    onecliPostgresUrl: normalizedOnecliUrl,
  });
  if (!sharedDatabase.ok) {
    throw new Error(sharedDatabase.message);
  }
  if (
    new URL(normalizedOnecliUrl).username === new URL(normalizedUrl).username
  ) {
    throw new Error('OneCLI and MyClaw must use different Postgres roles.');
  }
  draft.onecliPostgresDatabaseUrl = normalizedOnecliUrl;
  return { type: 'next' };
}

export async function runPrerequisitesStep(): Promise<FlowAction> {
  p.note(
    [
      'MyClaw runs as a local host process.',
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
    message: 'Choose your first channel provider',
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
  const value = await p.select({
    message: 'Choose main model',
    options: [
      {
        value: 'sonnet',
        label: 'Sonnet',
        hint: `Balanced speed/cost/quality. Uses the Claude Code ${CLAUDE_MODEL_PINS.sonnet} family without pinning your setup.`,
      },
      {
        value: 'opus',
        label: 'Opus (Recommended)',
        hint: 'Highest quality for agentic coding. Uses the Claude Code opus alias so your install tracks your account/provider safely.',
      },
      {
        value: 'opusplan',
        label: 'Opus Plan',
        hint: 'Uses Opus for planning and Sonnet for execution.',
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
    initialValue: draft.selectedModel || DEFAULT_SETUP_MODEL,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume' || value === 'cancel') return { type: value };
  draft.selectedModel =
    normalizeClaudeModelSelection(String(value)) || String(value);
  return { type: 'next' };
}
