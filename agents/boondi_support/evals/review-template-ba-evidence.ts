import fs from 'node:fs';
import path from 'node:path';

type ToolStage = {
  label?: string;
  server?: string;
  tool?: string;
  ok?: boolean;
};

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

type EvidenceRow = {
  scenario: Scenario;
  phone: string;
  webhook?: { status?: number; ok?: boolean };
  evidence?: {
    replyReceived?: boolean;
    outbound?: { text?: string };
    trace?: {
      toolStages?: ToolStage[];
      timings?: unknown;
      payloads?: unknown;
    } | null;
  };
};

type EvidenceFile = {
  capturedAt?: string;
  results?: EvidenceRow[];
};

type CliOptions = {
  evidencePath: string;
  expectCount?: number;
};

type Check = {
  any?: RegExp[];
  all?: RegExp[];
  none?: RegExp[];
  allowTools?: RegExp[];
};

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  npx tsx agents/boondi_support/evals/review-template-ba-evidence.ts --evidence /tmp/file.json',
      '',
      'Options:',
      '  --expect-count n       require exact row count, e.g. 59 for full Template_BA',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  let evidencePath = '';
  let expectCount: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) usage();
      return value;
    };
    if (arg === '--evidence') evidencePath = next();
    else if (arg === '--expect-count') expectCount = Number.parseInt(next(), 10);
    else usage();
  }
  if (!evidencePath) usage();
  if (expectCount !== undefined && (!Number.isInteger(expectCount) || expectCount < 1)) {
    throw new Error('--expect-count must be a positive integer.');
  }
  return { evidencePath, expectCount };
}

function readEvidence(filePath: string): EvidenceFile {
  const evidence = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvidenceFile;
  if (!Array.isArray(evidence.results)) {
    throw new Error(`Evidence file has no results array: ${filePath}`);
  }
  return evidence;
}

const INTERNAL_OR_PROCESS_LEAKS: RegExp[] = [
  /\b(?:mcp|mcp_list_tools|mcp_call_tool)\b/i,
  /\b(?:KB|knowledge base|source adapter|source tool|unfilled docs)\b/,
  /\b(?:system prompt|developer instructions|guardrail|classifier|policy says|context says|payload)\b/i,
  /\b(?:(?:debug|flow|reply|latency|message|tool)\s+trace|trace\s+payload)\b/i,
  /\b(?:I searched|search returned|the results here|products returned|confirmed source data|reply contract)\b/i,
  /\b(?:clear\s+(?:corporate|bulk|B2B).*signal|strong\s+B2B\s+signals|brief intake|capturing the brief)\b/i,
  /\b(?:route this|routing this|routing to|route warmly)\b/i,
  /\b(?:useCustomerReplyDraft|here'?s a reply|the customer is asking)\b/i,
  /\bSorry,\s+I\s+can['’]?t\s+share\s+that\s+here\b/i,
];

const GLOBAL_FORBIDDEN_REPLY: RegExp[] = [
  ...INTERNAL_OR_PROCESS_LEAKS,
  /\b(?:get_contact|get_customer|get_customer_by_phone|search_orders)\b/i,
  /\b(?:OTP|CVV|UPI PIN|full card|card number)\b/i,
];

const ALWAYS_FORBIDDEN_TOOLS: RegExp[] = [
  /^:?(?:mcp_list_tools|list_tools)$/i,
  /(^|:)boondi-crm:/i,
  /(?:get_contact|get_customer|get_customer_by_phone|search_orders)/i,
];

const SHOPIFY_ALLOWED_BY_SCENARIO: Record<string, RegExp[]> = {
  'pre-03-piece-count': [/^shopify-api:search_products$/, /^shopify-api:get_product$/],
  'pre-03-custom-pack-size': [/^shopify-api:search_products$/],
  'pre-05-apply-discount': [/^shopify-api:validate_discount_code$/],
  'pre-06-gift-budget': [/^shopify-api:search_products$/],
  'pre-06-roka-anniversary': [/^shopify-api:search_products$/],
  'pre-07-haldi': [/^shopify-api:search_products$/],
  'del-01-order-status': [
    /^shopify-api:get_recent_orders_with_details$/,
    /^shopify-api:get_order$/,
  ],
  'del-01-tracking-link': [
    /^shopify-api:get_recent_orders_with_details$/,
    /^shopify-api:get_order$/,
  ],
  'del-01-repeat-followup': [
    /^shopify-api:get_recent_orders_with_details$/,
    /^shopify-api:get_order$/,
  ],
  'del-04-combine-orders': [
    /^shopify-api:get_recent_orders_with_details$/,
    /^shopify-api:get_order$/,
  ],
  'post-04-sender': [
    /^shopify-api:get_recent_orders_with_details$/,
    /^shopify-api:get_order$/,
  ],
  'cafe-05-store-availability': [/^shopify-api:search_products$/, /^shopify-api:get_product$/],
};

const CHECKS: Record<string, Check> = {
  'pre-01-shelf-life': {
    any: [/shelf life|team|source|confirm/i],
    none: [/\b\d+\s*(?:days?|weeks?|months?)\b/i],
  },
  'pre-01-refrigeration': {
    any: [/fridge|refrigerat|storage|team|confirm/i],
    none: [/\b(?:guarantee|definitely|will last)\b/i],
  },
  'pre-01-travel-suitability': {
    any: [/travel|train|carry|team|confirm|Kaju Katli/i],
    none: [/\b(?:will survive|guarantee|definitely safe|safe to carry)\b/i],
  },
  'pre-02-deliverability': {
    any: [/400050|pincode|delivery|serviceability|checkout|team|confirm/i],
    none: [/\b(?:definitely|guarantee)\b/i],
  },
  'pre-02-delivery-eta': {
    any: [/tomorrow|delivery|timing|checkout|team|confirm|serviceability/i],
    none: [/\b(?:definitely|guarantee|will be delivered)\b/i],
  },
  'pre-03-piece-count': {
    any: [/Kaju Katli|piece|box|team|confirm/i],
  },
  'pre-03-custom-pack-size': {
    any: [/which|what|product|box|12-piece|team|confirm|option/i],
    none: [/\b(?:custom.*(?:available|possible|doable)|we can make)\b/i],
  },
  'pre-04-sugar-free': {
    any: [/sugar[- ]?free|diabetic|team|confirm|source/i],
    none: [/\b(?:safe for diabetics|diabetic safe|medical|actually safe)\b/i],
  },
  'pre-04-allergen-jain': {
    all: [/cashew|tree nut|nut/i],
    none: [
      /\b(?:Kaju Katli|product|sweet)\s+(?:is|is confirmed)\s+dairy[- ]?free\b/i,
      /\bdefinitely\s+dairy[- ]?free\b/i,
    ],
  },
  'pre-04-ingredients-missing': {
    any: [/ingredient|nutritional|product|batch|team|confirm/i],
  },
  'pre-05-apply-discount': {
    any: [/BSSDIWALI20|discount|code|team|confirm|valid/i],
    none: [/\b(?:valid|active|expired)\b.*\b(?:definitely|for sure)\b/i],
  },
  'pre-05-missed-window': {
    any: [/discount|code|offer|team|confirm/i],
    none: [/\border date\b.*\bdelivery date\b/i],
  },
  'pre-06-gift-budget': {
    any: [/birthday|friend|website|Rs|500|option|gift/i],
    none: [/\bavailable right now\b/i],
  },
  'pre-06-roka-anniversary': {
    any: [/roka|900|website|option|gift|team/i],
    none: [/\bavailable right now\b/i],
  },
  'pre-07-wedding-hampers': {
    any: [/30|wedding|hamper|team|brief|Mumbai/i],
    none: [/\bavailable right now\b/i],
  },
  'pre-07-baby-announcement': {
    any: [/baby|40|team|brief|boxes|gifting/i],
  },
  'pre-07-haldi': {
    any: [/haldi|11|800|website|option|gift/i],
    none: [/\bavailable right now\b/i],
  },
  'pre-08-corporate-quote': {
    any: [/100|corporate|price|quote|team|budget|delivery|timeline/i],
    none: [/\b(?:firm quote|final quote|guarantee)\b/i],
  },
  'pre-08-gst-logo': {
    any: [/80|employee|GST|logo|branding|budget|delivery|timeline|team/i],
    none: [/\b(?:branding is possible|logo.*possible|GST.*guaranteed)\b/i],
  },
  'pre-09-message-card': {
    any: [/message|card|team|confirm|product|quantity|delivery/i],
    none: [/\b(?:yes|sure|absolutely|definitely)\b.{0,30}\b(?:add|custom)/i],
  },
  'pre-09-branded-sleeve': {
    any: [/logo|custom|team|confirm|quantity|timeline|delivery|occasion/i],
    none: [/\b(?:yes|sure|absolutely|definitely)\b.{0,30}\b(?:custom|logo)/i],
  },
  'pre-10-pincode-tech': {
    any: [/same[- ]day|pincode|400050|checkout|team|confirm|delivery/i],
    none: [/\b(?:guarantee|definitely)\b/i],
  },
  'pre-10-payment-failing': {
    any: [/payment|method|error|team|check/i],
    none: [/\b(?:OTP|CVV|UPI PIN|full card|card number)\b/i],
  },
  'del-01-order-status': {
    any: [/order number|order/i],
    none: [/\bI['’]?ll\s+(?:pull\s+up|check)\b/i, /\bchecking\b/i],
  },
  'del-01-tracking-link': { any: [/order number|tracking|link|team|check/i] },
  'del-01-repeat-followup': { any: [/order number|team|check|update/i] },
  'del-02-no-bill': {
    any: [/order number|bill|price|team|note|check/i],
    none: [/\b(?:guarantee|definitely|will not send)\b/i],
  },
  'del-03-date-request': {
    any: [/order number|Friday|team|check|delivery date/i],
    none: [
      /\b(?:guarantee|definitely|will deliver)\b/i,
      /^\s*To help with/i,
      /^\s*To look into/i,
      /\bI['’]?ll\s+(?:pull\s+up|check)\b/i,
    ],
  },
  'del-03-time-window': {
    any: [/order number|5|7|team|specific slot|time window|confirm/i],
    none: [/\bguarantee\b/i],
  },
  'del-04-add-remove': {
    any: [/order number|add|Kaju Katli|team|check/i],
    none: [/\b(?:added|will add|guarantee)\b/i],
  },
  'del-04-combine-orders': {
    any: [/order number|two orders|combine|team|check/i],
    none: [/\b(?:will combine|guarantee|combined (?:your|the|these|those|both))\b/i],
  },
  'del-05-cancel': {
    any: [/order number|cancel|team|check/i],
    none: [/\b(?:cancelled|canceled|will cancel|guarantee)\b/i],
  },
  'del-05-cancel-refund': {
    any: [/order number|cancel|refund|team|check/i],
    none: [
      /\b(?:refunded|refund approved|will refund|guarantee)\b/i,
      /^\s*To look into/i,
      /^\s*To help with/i,
      /\bI['’]?ll\s+(?:pull\s+up|check)\b/i,
    ],
  },
  'post-01-melted': { any: [/sorry|photo|picture|order number|team/i] },
  'post-01-stale': { any: [/sorry|photo|picture|order number|product|team/i] },
  'post-02-missing-item': { any: [/missing|item|order number|team|check/i] },
  'post-02-card-missing': {
    all: [/sorry|oh no|not okay/i],
    any: [/gift message|card|order number|team|check/i],
    none: [/^\s*What['’]?s the order number/i, /\bI['’]?ll\s+(?:pull\s+up|check)\b/i],
  },
  'post-03-damaged-packaging': { any: [/photo|picture|packaging|order number|team/i] },
  'post-03-wrong-packaging': { any: [/photo|picture|packaging|order number|team/i] },
  'post-04-sender': { any: [/order number|sender|privacy|team|check/i] },
  'post-05-gst-wrong': { any: [/GST|invoice|order number|team|check|correct/i] },
  'post-05-invoice-needed': { any: [/invoice|order number|team|send|check/i] },
  'post-06-delivered-not-received': {
    any: [/delivered|not received|order number|team|check/i],
    all: [/sorry|not okay|priority|urgent/i],
    none: [
      /\b(?:will deliver|guarantee)\b/i,
      /^\s*Could you share your order number/i,
      /\bI['’]?ll\s+(?:pull\s+up|check)\b/i,
    ],
  },
  'cafe-01-reservation': {
    any: [/Bandra|table|reservation|team|time|party/i],
    none: [
      /\b(?:confirm|hold|book|reserve|sort)\s+(?:the\s+)?(?:booking|table)\b/i,
      /\b(?:table|booking)\s+(?:is|will be|has been)\s+(?:booked|confirmed|held|sorted)\b/i,
    ],
  },
  'cafe-02-address-hours': { any: [/Bandra|address|timing|team|confirm/i] },
  'cafe-02-nearest-store': { any: [/Worli|nearest|store|outlet|team/i] },
  'cafe-03-dine-in-menu': { any: [/menu|soft serve|flavour|store|team|confirm/i] },
  'cafe-04-valet': { any: [/valet|cafe|outlet|team|confirm/i] },
  'cafe-05-store-availability': {
    any: [/Kaju Katli|Bandra|in-store|store|team|confirm|available/i],
    none: [/\bonline stock\b.*\bavailable\b/i],
  },
  'cafe-06-store-bill': { any: [/bill|GST|date|time|payment|outlet|team/i] },
  'misc-01-spam': {
    all: [/I can only help with Bombay Sweet Shop/i],
    allowTools: [],
  },
  'misc-02-opt-out': {
    any: [/sorry|understand|opt-out|team|review/i],
    none: [/\b(?:you(?:['’]?re| are| have been)?\s+removed|unsubscribed you|actioned|action it|flagged|messages (?:will|should) stop|stop receiving)\b/i, /\b(?:phone|email|WhatsApp number)\b/i],
    allowTools: [],
  },
  'misc-02-repeat-opt-out': {
    any: [/sorry|frustrating|opt-out|team|review/i],
    none: [/\b(?:you(?:['’]?re| are| have been)?\s+removed|unsubscribed you|actioned|action it|flagged|messages (?:will|should) stop|stop receiving)\b/i, /\b(?:phone|email|WhatsApp number)\b/i],
    allowTools: [],
  },
  'misc-03-franchise': {
    any: [/franchise|team|confirm|city|inquiry/i],
    none: [/\b(?:fees|timeline|available|process)\b.*\b(?:is|are)\b/i],
  },
  'misc-04-jobs': {
    any: [/hiring|job|team|role|guide|confirm/i],
    none: [/\b(?:apply on|careers link|vacancy is open)\b/i],
    allowTools: [],
  },
  'agg-01-quality': { any: [/sorry|Swiggy|order number|quality|photo|team/i] },
  'agg-02-missing-item': { any: [/Zomato|missing|item|order number|team/i] },
  'agg-03-availability': {
    any: [/Swiggy|Kaju Katli|area|pincode|team|platform|availability/i],
    none: [/\b(?:enable it|will make it available|guarantee|switching the delivery address)\b/i],
  },
  'agg-04-bill': { any: [/Swiggy|order number|bill|invoice|GST|team/i] },
};

function toolKey(tool: ToolStage): string {
  return `${tool.server ?? ''}:${tool.tool ?? tool.label ?? ''}`;
}

function isToolAllowed(scenarioId: string, key: string): boolean {
  if (key === 'sdk:Skill' || key === ':Skill') return true;
  if (ALWAYS_FORBIDDEN_TOOLS.some((pattern) => pattern.test(key))) return false;
  const allowed = SHOPIFY_ALLOWED_BY_SCENARIO[scenarioId] ?? [];
  return allowed.some((pattern) => pattern.test(key));
}

function matchesAny(text: string, patterns: RegExp[] | undefined): boolean {
  return Boolean(patterns?.some((pattern) => pattern.test(text)));
}

function checkRow(row: EvidenceRow): string[] {
  const failures: string[] = [];
  const scenarioId = row.scenario?.scenarioId ?? 'unknown';
  const reply = row.evidence?.outbound?.text?.trim() ?? '';
  const tools = row.evidence?.trace?.toolStages ?? [];
  const check = CHECKS[scenarioId] ?? {};

  if (row.webhook?.status !== 200 || row.webhook?.ok !== true) {
    failures.push(`webhook failed: status=${row.webhook?.status ?? 'missing'}`);
  }
  if (row.evidence?.replyReceived !== true || !reply) failures.push('missing outbound reply');
  if (!row.evidence?.trace) failures.push('missing reply trace/payload evidence');
  else if (typeof row.evidence.trace.payloads !== 'object' || !row.evidence.trace.payloads) {
    failures.push('missing trace payload evidence');
  }

  const forbiddenReply = [...GLOBAL_FORBIDDEN_REPLY, ...(check.none ?? [])].find((pattern) =>
    pattern.test(reply),
  );
  if (forbiddenReply) failures.push(`forbidden reply pattern: ${forbiddenReply.source}`);

  if (check.all) {
    for (const pattern of check.all) {
      if (!pattern.test(reply)) failures.push(`missing required pattern: ${pattern.source}`);
    }
  }
  if (check.any && !matchesAny(reply, check.any)) {
    failures.push(
      `missing one of required patterns: ${check.any.map((pattern) => pattern.source).join(' | ')}`,
    );
  }

  const allowedOverride = check.allowTools;
  for (const tool of tools) {
    const key = toolKey(tool);
    const allowed =
      allowedOverride !== undefined
        ? allowedOverride.some((pattern) => pattern.test(key))
        : isToolAllowed(scenarioId, key);
    if (!allowed) failures.push(`unexpected tool: ${key}`);
    if (tool.ok === false) failures.push(`tool failed: ${key}`);
  }

  return failures;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const evidence = readEvidence(opts.evidencePath);
  const rows = evidence.results ?? [];
  const failures: Array<{ id: string; phone: string; failures: string[]; reply: string }> = [];
  const seen = new Set<string>();

  if (opts.expectCount !== undefined && rows.length !== opts.expectCount) {
    throw new Error(`Expected ${opts.expectCount} rows, got ${rows.length}`);
  }

  for (const row of rows) {
    const id = row.scenario?.scenarioId ?? 'unknown';
    if (seen.has(id)) {
      failures.push({
        id,
        phone: row.phone,
        failures: ['duplicate scenario id in evidence'],
        reply: row.evidence?.outbound?.text ?? '',
      });
      continue;
    }
    seen.add(id);
    const rowFailures = checkRow(row);
    if (rowFailures.length > 0) {
      failures.push({
        id,
        phone: row.phone,
        failures: rowFailures,
        reply: row.evidence?.outbound?.text ?? '',
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        evidence: path.resolve(opts.evidencePath),
        capturedAt: evidence.capturedAt,
        rows: rows.length,
        passed: rows.length - failures.length,
        failed: failures.length,
        failures,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) process.exitCode = 1;
}

main();
