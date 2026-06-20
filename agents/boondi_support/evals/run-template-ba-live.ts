import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

type Scenario = {
  scenarioId: string;
  intentId: string;
  group: string;
  kb: string;
  subflow: string;
  text: string;
  expectedDecision: string;
  expectedToolPolicy: string;
};

type Manifest = {
  version: number;
  source: string;
  headerRow: number;
  scenarioCount: number;
  scenarios: Scenario[];
};

type CliOptions = {
  all: boolean;
  dryRun: boolean;
  group?: string;
  id?: string;
  limit?: number;
  phone?: string;
  startPhone: string;
  waitMs: number;
  baseUrl: string;
  runtimeHome: string;
  manifestPath: string;
  outPath: string;
  envPath: string;
  name: string;
};

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  npx tsx agents/boondi_support/evals/run-template-ba-live.ts --dry-run --all',
      '  npx tsx agents/boondi_support/evals/run-template-ba-live.ts --id pre-04-allergen-jain',
      '  npx tsx agents/boondi_support/evals/run-template-ba-live.ts --group product-care --limit 3',
      '',
      'Options:',
      '  --all                  select all scenarios',
      '  --id a,b               select scenario id(s)',
      '  --group name           select group',
      '  --limit n              cap selected scenarios',
      '  --phone 000000900      force phone for exactly one scenario',
      '  --start-phone 000001000 first generated phone',
      '  --wait-ms 90000        per-scenario reply wait',
      '  --out path             evidence JSON output path',
      '  --dry-run              validate selection without sending',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    all: false,
    dryRun: false,
    startPhone: '000001000',
    waitMs: 90_000,
    baseUrl: process.env.GANTRY_BASE_URL || 'http://127.0.0.1:4710',
    runtimeHome: process.env.GANTRY_HOME || '/Users/caw-d/gantry',
    manifestPath: path.resolve(
      'agents/boondi_support/evals/template-ba-live-scenarios.json',
    ),
    outPath: path.join(
      '/tmp',
      `boondi-template-ba-live-evidence-${Date.now()}.json`,
    ),
    envPath: '/Users/caw-d/gantry/.env',
    name: 'Boondi Live Eval',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) usage();
      return value;
    };
    if (arg === '--all') opts.all = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--group') opts.group = next();
    else if (arg === '--id') opts.id = next();
    else if (arg === '--limit') opts.limit = Number.parseInt(next(), 10);
    else if (arg === '--phone') opts.phone = next();
    else if (arg === '--start-phone') opts.startPhone = next();
    else if (arg === '--wait-ms') opts.waitMs = Number.parseInt(next(), 10);
    else if (arg === '--base-url') opts.baseUrl = next();
    else if (arg === '--runtime-home') opts.runtimeHome = next();
    else if (arg === '--manifest') opts.manifestPath = next();
    else if (arg === '--out') opts.outPath = next();
    else if (arg === '--env') opts.envPath = next();
    else if (arg === '--name') opts.name = next();
    else usage();
  }
  if (!opts.all && !opts.group && !opts.id) usage();
  if (opts.phone && (opts.all || opts.group || opts.id?.includes(','))) {
    throw new Error('--phone is allowed only for one selected scenario.');
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  return opts;
}

function readManifest(filePath: string): Manifest {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Manifest;
  if (!Array.isArray(manifest.scenarios)) {
    throw new Error(`Manifest has no scenarios array: ${filePath}`);
  }
  if (manifest.scenarios.length !== manifest.scenarioCount) {
    throw new Error(
      `Manifest count mismatch: expected ${manifest.scenarioCount}, got ${manifest.scenarios.length}`,
    );
  }
  const seen = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (seen.has(scenario.scenarioId)) {
      throw new Error(`Duplicate scenarioId: ${scenario.scenarioId}`);
    }
    seen.add(scenario.scenarioId);
  }
  return manifest;
}

function selectScenarios(manifest: Manifest, opts: CliOptions): Scenario[] {
  let selected = manifest.scenarios;
  if (opts.id) {
    const ids = new Set(opts.id.split(',').map((id) => id.trim()).filter(Boolean));
    selected = selected.filter((scenario) => ids.has(scenario.scenarioId));
    if (selected.length !== ids.size) {
      const found = new Set(selected.map((scenario) => scenario.scenarioId));
      const missing = [...ids].filter((id) => !found.has(id));
      throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`);
    }
  } else if (opts.group) {
    selected = selected.filter((scenario) => scenario.group === opts.group);
  } else if (!opts.all) {
    usage();
  }
  if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
  if (selected.length === 0) throw new Error('No scenarios selected.');
  return selected;
}

function loadDotenv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]!] = value;
  }
  return env;
}

function phoneFor(opts: CliOptions, index: number): string {
  if (opts.phone) return opts.phone;
  const width = opts.startPhone.length;
  const value = Number.parseInt(opts.startPhone, 10) + index;
  if (!Number.isFinite(value)) throw new Error(`Invalid --start-phone: ${opts.startPhone}`);
  return String(value).padStart(width, '0');
}

function interaktBody(input: {
  phone: string;
  text: string;
  name: string;
  now: string;
  messageId: string;
}): string {
  return JSON.stringify({
    version: '1.0',
    timestamp: input.now,
    type: 'message_received',
    data: {
      customer: {
        channel_phone_number: input.phone,
        traits: { name: input.name },
      },
      message: {
        id: input.messageId,
        chat_message_type: 'CustomerMessage',
        message_content_type: 'Text',
        message: input.text,
        received_at_utc: input.now,
      },
    },
  });
}

async function sendWebhook(opts: CliOptions, secret: string, scenario: Scenario, phone: string) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000000');
  const messageId = crypto.randomUUID();
  const body = interaktBody({
    phone,
    text: scenario.text,
    name: opts.name,
    now,
    messageId,
  });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const response = await fetch(`${opts.baseUrl}/v1/channels/interakt/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'interakt-signature': `sha256=${signature}`,
    },
    body,
  });
  const responseText = await response.text();
  return {
    sentAt: new Date().toISOString(),
    messageId,
    status: response.status,
    ok: response.ok,
    responseText,
  };
}

function stripUnsupportedDbQueryParams(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

function schemaIdent(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Unsafe Postgres schema identifier: ${schema}`);
  }
  return `"${schema}"`;
}

async function connectDb(env: Record<string, string>): Promise<Client> {
  const raw = env.GANTRY_DATABASE_URL || process.env.GANTRY_DATABASE_URL;
  if (!raw) throw new Error('GANTRY_DATABASE_URL is required for live evidence collection.');
  const client = new Client({ connectionString: stripUnsupportedDbQueryParams(raw) });
  await client.connect();
  return client;
}

async function collectEvidence(input: {
  client: Client;
  schema: string;
  phone: string;
  waitMs: number;
  startedAt: string;
}) {
  const conversationId = `conversation:wa:${input.phone}`;
  const deadline = Date.now() + input.waitMs;
  const schema = schemaIdent(input.schema);
  let messages: Array<{ id: string; direction: string; created_at: string; text: string }> = [];
  let trace: { message_id: string; timings_json: unknown; payloads_json: unknown } | undefined;
  let sawOutbound = false;
  while (Date.now() <= deadline) {
    const messagesResult = await input.client.query(
      `
        select
          m.id,
          m.direction,
          m.created_at::text,
          coalesce(string_agg(p.payload_json->>'text', '' order by p.ordinal), '') as text
        from ${schema}.messages m
        left join ${schema}.message_parts p on p.message_id = m.id
        where m.conversation_id = $1
          and m.created_at >= $2::timestamptz - interval '5 seconds'
        group by m.id, m.direction, m.created_at
        order by m.created_at
      `,
      [conversationId, input.startedAt],
    );
    messages = messagesResult.rows;
    const outbound = messages.find((message) => message.direction === 'outbound');
    if (outbound) {
      sawOutbound = true;
      const traceResult = await input.client.query(
        `
          select mt.message_id, mt.timings_json, mt.payloads_json
          from ${schema}.message_traces mt
          join ${schema}.messages m on m.id = mt.message_id
          where m.conversation_id = $1
            and m.created_at >= $2::timestamptz - interval '5 seconds'
          order by mt.created_at desc
          limit 1
        `,
        [conversationId, input.startedAt],
      );
      trace = traceResult.rows[0];
      if (trace) break;
    }
    if (sawOutbound) await new Promise((resolve) => setTimeout(resolve, 500));
    else await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const outbound = messages.find((message) => message.direction === 'outbound');
  const timings = trace?.timings_json as
    | { sections?: Array<{ kind?: string; label?: string; detail?: Record<string, unknown> }> }
    | undefined;
  const toolStages =
    timings?.sections
      ?.filter((section) => section.kind === 'tool')
      .map((section) => ({
        label: section.label,
        server: section.detail?.server,
        tool: section.detail?.tool,
        ok: section.detail?.ok,
      })) ?? [];
  return {
    conversationId,
    replyReceived: Boolean(outbound),
    inbound: messages.filter((message) => message.direction === 'inbound'),
    outbound,
    trace: trace
      ? {
          messageId: trace.message_id,
          toolStages,
          timings: trace.timings_json,
          payloads: trace.payloads_json,
        }
      : null,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest(opts.manifestPath);
  const selected = selectScenarios(manifest, opts);

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          selected: selected.map((scenario, index) => ({
            phone: phoneFor(opts, index),
            scenarioId: scenario.scenarioId,
            intentId: scenario.intentId,
            group: scenario.group,
            text: scenario.text,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const env = { ...loadDotenv(opts.envPath), ...process.env };
  const secret = env.INTERAKT_WEBHOOK_SECRET;
  if (!secret) throw new Error(`INTERAKT_WEBHOOK_SECRET missing from ${opts.envPath}`);
  const schema = env.GANTRY_DATABASE_SCHEMA || 'gantry';
  const client = await connectDb(env);
  const results: unknown[] = [];
  try {
    for (let i = 0; i < selected.length; i += 1) {
      const scenario = selected[i]!;
      const phone = phoneFor(opts, i);
      const startedAt = new Date().toISOString();
      const webhook = await sendWebhook(opts, secret, scenario, phone);
      const evidence = await collectEvidence({
        client,
        schema,
        phone,
        waitMs: opts.waitMs,
        startedAt,
      });
      const result = {
        scenario,
        phone,
        webhook,
        evidence,
      };
      results.push(result);
      console.log(
        JSON.stringify({
          scenarioId: scenario.scenarioId,
          phone,
          webhookStatus: webhook.status,
          replyReceived: evidence.replyReceived,
          toolStages: evidence.trace?.toolStages ?? [],
        }),
      );
    }
  } finally {
    await client.end();
  }

  const output = {
    capturedAt: new Date().toISOString(),
    manifest: {
      source: manifest.source,
      version: manifest.version,
      headerRow: manifest.headerRow,
    },
    results,
  };
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Evidence written: ${opts.outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
