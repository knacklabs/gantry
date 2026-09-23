import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const asOf = '2026-09-23';
const policies = [
  {
    policyId: 'MOTOR-1001',
    customer: 'Aarav Demo',
    vehicle: 'Maruti Baleno',
    registration: 'DEMO-KA-1001',
    city: 'Bengaluru',
    plan: 'comprehensive',
    start: '2026-01-01',
    end: '2026-12-31',
    idvInr: 650000,
    deductibleInr: 1000,
    zeroDepreciation: true,
    engineProtection: false,
    roadsideAssistance: true,
    ncbPercent: 20,
  },
  {
    policyId: 'MOTOR-1002',
    customer: 'Meera Demo',
    vehicle: 'Hyundai i20',
    registration: 'DEMO-MH-1002',
    city: 'Pune',
    plan: 'third_party_only',
    start: '2026-04-01',
    end: '2027-03-31',
    idvInr: null,
    deductibleInr: null,
    zeroDepreciation: false,
    engineProtection: false,
    roadsideAssistance: false,
    ncbPercent: 0,
  },
  {
    policyId: 'MOTOR-1003',
    customer: 'Kabir Demo',
    vehicle: 'Tata Nexon',
    registration: 'DEMO-DL-1003',
    city: 'Delhi',
    plan: 'comprehensive',
    start: '2025-09-01',
    end: '2026-08-31',
    idvInr: 900000,
    deductibleInr: 1000,
    zeroDepreciation: false,
    engineProtection: true,
    roadsideAssistance: true,
    ncbPercent: 35,
  },
];
const garages = [
  {
    id: 'GAR-01',
    name: 'Demo Indiranagar Motors',
    city: 'Bengaluru',
    area: 'Indiranagar',
    cashless: true,
  },
  {
    id: 'GAR-02',
    name: 'Demo Whitefield Auto',
    city: 'Bengaluru',
    area: 'Whitefield',
    cashless: true,
  },
  {
    id: 'GAR-03',
    name: 'Demo Baner Motors',
    city: 'Pune',
    area: 'Baner',
    cashless: true,
  },
  {
    id: 'GAR-04',
    name: 'Demo Saket Auto',
    city: 'Delhi',
    area: 'Saket',
    cashless: true,
  },
];
const statePath =
  process.env.STATE_FILE ||
  fileURLToPath(new URL('./demo-state.json', import.meta.url));
const evidenceRoot =
  process.env.EVIDENCE_DIR || join(dirname(statePath), 'claim-evidence');
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
let state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : {
      claims: [
        {
          claimId: 'CLM-DEMO-001',
          policyId: 'MOTOR-1001',
          incidentType: 'collision',
          incidentDate: '2026-09-20',
          location: 'Bengaluru',
          description: 'Fictional bumper damage while parking.',
          status: 'awaiting_documents',
          requiredDocuments: ['Repair estimate', 'Damage photographs'],
          createdAt: '2026-09-20T10:00:00Z',
        },
      ],
      requests: {},
      documents: {},
    };
state.documents ??= {};
state.requests ??= {};
state.evidence ??= {};
state.decisions ??= {};
const id = z.string().trim().min(1).max(120);
const policyReference = {
  policyId: id.optional(),
  policy_id: id.optional(),
  policyNumber: id.optional(),
  policy_number: id.optional(),
};
const incident = z.enum([
  'collision',
  'theft',
  'flood',
  'engine_water_damage',
  'third_party_damage',
  'breakdown',
]);
const incidentReference = {
  incidentType: incident.optional(),
  incident_type: incident.optional(),
  incidentDate: z.string().date().optional(),
  incident_date: z.string().date().optional(),
};
const documentType = z.enum([
  'damage_photo',
  'repair_estimate',
  'incident_report',
  'policy_document',
  'other',
]);
function persist(next) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(`${statePath}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${statePath}.tmp`, statePath);
  state = next;
}
function safeEvidenceName(value) {
  return (
    String(value || '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120) || 'attachment'
  );
}
function evidenceForClaim(claimId) {
  return Object.values(state.evidence).filter(
    (item) => item.claimId === claimId,
  );
}
function claim(claimId) {
  const found = state.claims.find((c) => c.claimId === claimId.toUpperCase());
  if (!found) throw new Error('CLAIM_NOT_FOUND');
  return found;
}
function policy(policyId) {
  const found = policies.find((p) => p.policyId === policyId.toUpperCase());
  if (!found) throw new Error('POLICY_NOT_FOUND');
  return found;
}
function readOnlyPolicy(args) {
  const references = [
    args.policyId,
    args.policy_id,
    args.policyNumber,
    args.policy_number,
  ].filter(Boolean);
  if (!references.length) throw new Error('POLICY_ID_REQUIRED');
  if (
    references.some(
      (value) => value.toUpperCase() !== references[0].toUpperCase(),
    )
  )
    throw new Error('POLICY_ID_CONFLICT');
  return policy(references[0]);
}
function readOnlyIncident(args) {
  const incidentType = args.incidentType ?? args.incident_type;
  const incidentDate = args.incidentDate ?? args.incident_date;
  if (!incidentType || !incidentDate)
    throw new Error('INCIDENT_DETAILS_REQUIRED');
  if (
    args.incidentType &&
    args.incident_type &&
    args.incidentType !== args.incident_type
  )
    throw new Error('INCIDENT_TYPE_CONFLICT');
  if (
    args.incidentDate &&
    args.incident_date &&
    args.incidentDate !== args.incident_date
  )
    throw new Error('INCIDENT_DATE_CONFLICT');
  return { incidentType, incidentDate };
}
function coverage(p, type, date) {
  if (date < p.start || date > p.end)
    return {
      assessment: 'outside_policy_period',
      reason: 'Incident date is outside this fictional policy period.',
    };
  if (type === 'breakdown')
    return {
      assessment: p.roadsideAssistance
        ? 'assistance_available'
        : 'not_included',
      reason:
        'Roadside assistance is a service, not an automatic repair reimbursement.',
    };
  if (type === 'third_party_damage')
    return {
      assessment: 'potentially_covered',
      reason:
        'Third-party liability is included; liability and settlement need review.',
    };
  if (p.plan === 'third_party_only')
    return {
      assessment: 'not_included',
      reason:
        'This fictional plan does not include damage to or theft of the insured vehicle.',
    };
  if (type === 'engine_water_damage' && !p.engineProtection)
    return {
      assessment: 'not_included',
      reason:
        'Consequential engine damage from water ingress requires engine protection in this demo.',
    };
  return {
    assessment: 'potentially_covered',
    reason:
      'Included in the fictional cover; documents, exclusions and assessment still apply.',
  };
}
function result(data, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ simulation: true, asOf, ...data }),
      },
    ],
    isError,
  };
}
function buildServer() {
  const server = new McpServer({
    name: 'motor-insurance-demo',
    version: '1.0.0',
  });
  function tool(name, description, inputSchema, fn, write = false) {
    server.registerTool(
      name,
      {
        description: `FICTIONAL SIMULATION ONLY. ${description}`,
        inputSchema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          return result(await fn(args));
        } catch (error) {
          if (error.message === 'POLICY_NOT_FOUND')
            return result({
              error: 'POLICY_NOT_FOUND',
              message:
                'No fictional policy matches that ID. Ask the user to choose one of the available demo policy IDs.',
              availablePolicyIds: policies.map((p) => p.policyId),
            });
          if (error.message === 'POLICY_ID_REQUIRED')
            return result({
              error: 'POLICY_ID_REQUIRED',
              message:
                'Ask the user for a fictional demo policy ID before checking this policy.',
              availablePolicyIds: policies.map((p) => p.policyId),
            });
          if (error.message === 'INCIDENT_DETAILS_REQUIRED')
            return result({
              error: 'INCIDENT_DETAILS_REQUIRED',
              message:
                'Ask the user for the incident type and date before checking coverage.',
            });
          return result({ error: error.message }, true);
        }
      },
    );
  }
  tool(
    'list_demo_scenarios',
    'List fictional customers, policy IDs, and the seeded claim. Use when the user needs sample data.',
    {},
    () => ({
      policies: policies.map((p) => ({
        policyId: p.policyId,
        customer: p.customer,
        vehicle: p.vehicle,
        plan: p.plan,
        status: p.end < asOf ? 'expired' : 'active',
      })),
      sampleClaimId: 'CLM-DEMO-001',
      supportedCities: ['Bengaluru', 'Pune', 'Delhi'],
      note: 'Simulation clock is fixed at 2026-09-23. No real insurer, payment, booking, or external submission.',
    }),
  );
  tool(
    'get_motor_policy',
    'Retrieve cover, add-ons, dates, deductible, IDV and no-claim bonus for one fictional policy. Supply policyId; policy_id and policyNumber are accepted aliases.',
    policyReference,
    (args) => {
      const p = readOnlyPolicy(args);
      return { policy: { ...p, status: p.end < asOf ? 'expired' : 'active' } };
    },
  );
  tool(
    'check_motor_coverage',
    'Assess a specific incident under fictional policy rules. Not a claim approval.',
    {
      ...policyReference,
      ...incidentReference,
    },
    (args) => {
      const { incidentType, incidentDate } = readOnlyIncident(args);
      if (incidentDate > asOf)
        throw new Error(
          'Incident date must not be after the simulation date 2026-09-23.',
        );
      const p = readOnlyPolicy(args);
      return {
        policyId: p.policyId,
        incidentType,
        incidentDate,
        ...coverage(p, incidentType, incidentDate),
        deductibleInr: p.deductibleInr,
        requiredDocuments:
          incidentType === 'theft'
            ? [
                'Incident report reference (fictional)',
                'Vehicle keys declaration',
                'Policy reference',
              ]
            : ['Damage photographs', 'Repair estimate', 'Policy reference'],
        disclaimer:
          'Simulation assessment only. No approval or guaranteed payout.',
      };
    },
  );
  tool(
    'find_cashless_garages',
    'Find fictional cashless garages by city. Returns no results for unsupported cities. Does not book a repair.',
    { city: id },
    ({ city }) => ({
      garages: garages.filter(
        (g) => g.city.toLowerCase() === city.toLowerCase(),
      ),
      note: 'Cashless service remains subject to claim eligibility; these garages are fictional.',
    }),
  );
  tool(
    'get_renewal_quote',
    'Calculate a fictional illustrative renewal quote. Does not bind or renew cover and takes no payment.',
    {
      policyId: id,
      plan: z.enum(['comprehensive', 'third_party_only']),
      zeroDepreciation: z.boolean().default(false),
      engineProtection: z.boolean().default(false),
    },
    ({ policyId, plan, zeroDepreciation, engineProtection }) => {
      const p = policy(policyId);
      if (plan === 'third_party_only' && (zeroDepreciation || engineProtection))
        throw new Error(
          'Own-damage add-ons require the comprehensive plan in this demo.',
        );
      const ownDamage =
        plan === 'comprehensive' ? Math.round((p.idvInr || 600000) * 0.02) : 0;
      const ncbDiscount = Math.round((ownDamage * p.ncbPercent) / 100);
      const liability = 3500,
        addons = (zeroDepreciation ? 2500 : 0) + (engineProtection ? 1500 : 0);
      return {
        policyId: p.policyId,
        plan,
        currency: 'INR',
        premium: {
          ownDamage,
          ncbDiscount,
          liability,
          addons,
          total: ownDamage - ncbDiscount + liability + addons,
        },
        note: 'Invented demo pricing, taxes omitted, not a market quote. Existing claim effects on NCB are not modeled. No policy was purchased or renewed.',
      };
    },
  );
  tool(
    'register_motor_claim',
    'WRITE: Create a local fictional claim after explicit user confirmation. Use one requestId per incident; retry with the same requestId. Never submits to a real insurer.',
    {
      policyId: id,
      incidentType: incident,
      incidentDate: z.string().date(),
      location: z.string().trim().min(2).max(200),
      description: z.string().trim().min(10).max(2000),
      confirmed: z.boolean(),
      requestId: id,
    },
    (args) => {
      if (!args.confirmed)
        throw new Error(
          'CONFIRMATION_REQUIRED: Summarize the incident and ask the user to confirm registration.',
        );
      const { requestId, ...details } = args;
      const fingerprint = JSON.stringify(details);
      if (Object.hasOwn(state.requests, requestId)) {
        const old = state.requests[requestId];
        if (old.fingerprint !== fingerprint)
          throw new Error(
            'IDEMPOTENCY_CONFLICT: This requestId was used for different details.',
          );
        return {
          claim: state.claims.find((c) => c.claimId === old.claimId),
          replayed: true,
        };
      }
      if (args.incidentDate > asOf)
        throw new Error(
          'Incident date must not be after the simulation date 2026-09-23.',
        );
      const p = policy(args.policyId),
        assessment = coverage(p, args.incidentType, args.incidentDate);
      if (assessment.assessment !== 'potentially_covered')
        throw new Error(`CLAIM_NOT_REGISTERED: ${assessment.reason}`);
      const claim = {
        claimId: `CLM-${randomUUID().slice(0, 8).toUpperCase()}`,
        policyId: p.policyId,
        incidentType: args.incidentType,
        incidentDate: args.incidentDate,
        location: args.location,
        description: args.description,
        status: 'submitted_for_review',
        registrationAssessment: assessment.assessment,
        registrationReason: assessment.reason,
        requiredDocuments: [
          'Damage or incident evidence',
          'Repair estimate or loss details',
        ],
        createdAt: new Date().toISOString(),
      };
      const next = {
        ...state,
        claims: [...state.claims, claim],
        requests: {
          ...state.requests,
          [requestId]: { fingerprint, claimId: claim.claimId },
        },
      };
      persist(next);
      return {
        claim,
        replayed: false,
        note: 'Saved only in this local demo. Registration is not approval.',
      };
    },
    true,
  );
  tool(
    'get_motor_claim',
    'Read a fictional claim status and outstanding documents. Status does not progress automatically.',
    { claimId: id },
    ({ claimId }) => {
      const found = claim(claimId);
      return {
        claim: found,
        evidence: evidenceForClaim(found.claimId).map(
          ({ storagePath, ...metadata }) => metadata,
        ),
      };
    },
  );
  tool(
    'ingest_claim_document',
    'WRITE: Store text extracted by the agent from one fictional image or PDF. Never send binary, base64, credentials, or real identity data. Returns an intake ID; does not approve a claim.',
    {
      policyId: id,
      claimId: id.optional(),
      documentType,
      fileName: z.string().trim().min(1).max(200),
      mimeType: z.enum([
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
      ]),
      extractedText: z.string().trim().min(1).max(12000),
      requestId: id,
    },
    (args) => {
      const p = policy(args.policyId);
      const linkedClaim = args.claimId ? claim(args.claimId) : undefined;
      if (linkedClaim && linkedClaim.policyId !== p.policyId)
        throw new Error('CLAIM_POLICY_MISMATCH');
      const fingerprint = JSON.stringify({
        ...args,
        policyId: p.policyId,
        claimId: linkedClaim?.claimId,
      });
      if (Object.hasOwn(state.requests, args.requestId)) {
        const previous = state.requests[args.requestId];
        if (previous.fingerprint !== fingerprint || !previous.intakeId)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return {
          intakeId: previous.intakeId,
          replayed: true,
          status: 'stored_for_review',
        };
      }
      const intakeId = `DOC-${randomUUID().slice(0, 8).toUpperCase()}`;
      const document = {
        intakeId,
        policyId: p.policyId,
        ...(linkedClaim ? { claimId: linkedClaim.claimId } : {}),
        documentType: args.documentType,
        fileName: args.fileName,
        mimeType: args.mimeType,
        extractedText: args.extractedText,
        status: 'stored_for_review',
        createdAt: new Date().toISOString(),
      };
      persist({
        ...state,
        documents: { ...state.documents, [intakeId]: document },
        requests: {
          ...state.requests,
          [args.requestId]: { fingerprint, intakeId },
        },
      });
      return {
        intakeId,
        policyId: p.policyId,
        claimId: linkedClaim?.claimId,
        status: document.status,
        replayed: false,
        note: 'Only extracted text is stored in this local demo. The original image or PDF is not stored here.',
      };
    },
    true,
  );
  tool(
    'assess_claim_eligibility',
    'Explain whether a fictional incident may qualify for a claim, including document-intake status. Never approve or promise a payout.',
    {
      ...policyReference,
      ...incidentReference,
      intakeId: id.optional(),
    },
    (args) => {
      const { incidentType, incidentDate } = readOnlyIncident(args),
        { intakeId } = args;
      if (incidentDate > asOf)
        throw new Error(
          'Incident date must not be after the simulation date 2026-09-23.',
        );
      const p = readOnlyPolicy(args),
        assessment = coverage(p, incidentType, incidentDate);
      const document = intakeId
        ? state.documents[intakeId.toUpperCase()]
        : undefined;
      if (intakeId && !document) throw new Error('INTAKE_NOT_FOUND');
      if (document && document.policyId !== p.policyId)
        throw new Error('INTAKE_POLICY_MISMATCH');
      return {
        policyId: p.policyId,
        incidentType,
        incidentDate,
        ...assessment,
        documentIntake: document
          ? {
              intakeId: document.intakeId,
              status: document.status,
              documentType: document.documentType,
            }
          : null,
        nextStep:
          assessment.assessment === 'potentially_covered'
            ? 'Collect evidence and register a demo claim after confirmation; an adjuster must review it.'
            : 'Explain the rule or request clarification before registering a damage claim.',
        disclaimer:
          'Simulation assessment only; not claim approval or a payout guarantee.',
      };
    },
  );
  tool(
    'list_claim_tickets',
    'INTERNAL TEAM ONLY: List fictional claim tickets with status and document counts. Do not grant to a customer-facing agent.',
    {
      status: z
        .enum([
          'all',
          'awaiting_documents',
          'submitted_for_review',
          'under_review',
        ])
        .default('all'),
    },
    ({ status }) => ({
      tickets: state.claims
        .filter((c) => status === 'all' || c.status === status)
        .map((c) => ({
          claimId: c.claimId,
          policyId: c.policyId,
          status: c.status,
          incidentType: c.incidentType,
          registrationAssessment: c.registrationAssessment ?? null,
          registrationReason: c.registrationReason ?? null,
          createdAt: c.createdAt,
          documentCount: Object.values(state.documents).filter(
            (d) => d.claimId === c.claimId,
          ).length,
        })),
      note: 'Internal demo queue only; these are not real insurer tickets.',
    }),
  );
  tool(
    'get_claim_ticket',
    'INTERNAL TEAM ONLY: Read one fictional claim ticket and text extracted from its linked documents.',
    { claimId: id },
    ({ claimId }) => {
      const ticket = claim(claimId);
      return {
        ticket,
        documents: Object.values(state.documents).filter(
          (d) => d.claimId === ticket.claimId,
        ),
        evidence: evidenceForClaim(ticket.claimId).map(
          ({ storagePath, ...metadata }) => metadata,
        ),
      };
    },
  );
  return server;
}
const app = express();
app.use(express.json({ limit: '28mb' }));
function authorized(req) {
  return (
    !process.env.MCP_TOKEN ||
    req.headers.authorization === `Bearer ${process.env.MCP_TOKEN}`
  );
}
const evidenceUpload = z.object({
  claimId: id,
  requestId: id,
  documentType,
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
  ]),
  dataBase64: z.string().min(1),
  extractedText: z.string().max(12000).default(''),
  extractedFields: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});
function matchesMime(bytes, mimeType) {
  if (mimeType === 'application/pdf')
    return bytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg')
    return (
      bytes.length > 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    );
  return (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  );
}
app.post('/evidence', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const parsed = evidenceUpload.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'INVALID_EVIDENCE' });
  const input = parsed.data;
  let linkedClaim;
  try {
    linkedClaim = claim(input.claimId);
  } catch {
    return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
  }
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64) ||
    input.dataBase64.length % 4 !== 0
  )
    return res.status(400).json({ error: 'INVALID_BASE64' });
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_EVIDENCE_BYTES)
    return res.status(413).json({ error: 'EVIDENCE_SIZE_INVALID' });
  if (!matchesMime(bytes, input.mimeType))
    return res.status(400).json({ error: 'EVIDENCE_TYPE_MISMATCH' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fingerprint = JSON.stringify({
    claimId: linkedClaim.claimId,
    documentType: input.documentType,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sha256,
    extractedText: input.extractedText,
    extractedFields: input.extractedFields,
  });
  const previous = state.requests[input.requestId];
  if (previous) {
    if (previous.fingerprint !== fingerprint || !previous.evidenceId)
      return res.status(409).json({ error: 'IDEMPOTENCY_CONFLICT' });
    const { storagePath: ignored, ...publicEvidence } =
      state.evidence[previous.evidenceId];
    return res.json({ evidence: publicEvidence, replayed: true });
  }
  const evidenceId = `EVD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const directory = join(evidenceRoot, linkedClaim.claimId);
  const storagePath = join(
    directory,
    `${evidenceId}-${safeEvidenceName(input.fileName)}`,
  );
  const evidence = {
    evidenceId,
    claimId: linkedClaim.claimId,
    policyId: linkedClaim.policyId,
    documentType: input.documentType,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.length,
    sha256,
    extractedText: input.extractedText,
    extractedFields: input.extractedFields,
    extractionStatus: input.extractedText
      ? 'extracted_unverified'
      : 'needs_review',
    storagePath,
    createdAt: new Date().toISOString(),
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(storagePath, bytes, { flag: 'wx', mode: 0o600 });
    persist({
      ...state,
      evidence: { ...state.evidence, [evidenceId]: evidence },
      requests: {
        ...state.requests,
        [input.requestId]: { fingerprint, evidenceId },
      },
    });
  } catch (error) {
    try {
      unlinkSync(storagePath);
    } catch {}
    return res.status(500).json({ error: 'EVIDENCE_STORE_FAILED' });
  }
  const { storagePath: ignored, ...publicEvidence } = evidence;
  return res.status(201).json({ evidence: publicEvidence, replayed: false });
});
const claimDecision = z.object({
  decision: z.enum(['approve', 'decline']),
  actorId: z.string().regex(/^U[A-Z0-9]+$/),
  requestId: id,
  reason: z.string().trim().max(2000).default(''),
});
app.post('/claims/:claimId/decision', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const parsed = claimDecision.safeParse(req.body);
  if (
    !parsed.success ||
    (parsed.data?.decision === 'decline' && !parsed.data.reason)
  )
    return res.status(400).json({ error: 'INVALID_DECISION' });
  const input = parsed.data;
  let current;
  try {
    current = claim(req.params.claimId);
  } catch {
    return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
  }
  const fingerprint = JSON.stringify({ claimId: current.claimId, ...input });
  const previous = state.requests[input.requestId];
  if (previous) {
    if (previous.fingerprint !== fingerprint || !previous.decisionId)
      return res.status(409).json({ error: 'IDEMPOTENCY_CONFLICT' });
    return res.json({
      claim: current,
      decision: state.decisions[previous.decisionId],
      replayed: true,
    });
  }
  if (!['submitted_for_review', 'under_review'].includes(current.status))
    return res
      .status(409)
      .json({ error: 'CLAIM_NOT_AWAITING_REVIEW', status: current.status });
  if (!current.reviewCardPostedAt)
    return res.status(409).json({ error: 'CLAIM_REVIEW_CARD_NOT_POSTED' });
  const decisionId = `DEC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const decidedAt = new Date().toISOString();
  const decision = {
    decisionId,
    claimId: current.claimId,
    decision: input.decision,
    actorId: input.actorId,
    reason: input.reason,
    decidedAt,
    notificationStatus: 'pending',
  };
  const updated = {
    ...current,
    status:
      input.decision === 'approve'
        ? 'approved_internal_review'
        : 'declined_internal_review',
    decisionId,
    decidedAt,
  };
  persist({
    ...state,
    claims: state.claims.map((item) =>
      item.claimId === current.claimId ? updated : item,
    ),
    decisions: { ...state.decisions, [decisionId]: decision },
    requests: {
      ...state.requests,
      [input.requestId]: { fingerprint, decisionId },
    },
  });
  return res.status(201).json({ claim: updated, decision, replayed: false });
});
app.post('/decisions/:decisionId/notification-sent', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const existing = state.decisions[req.params.decisionId];
  if (!existing) return res.status(404).json({ error: 'DECISION_NOT_FOUND' });
  if (existing.notificationStatus !== 'sent') {
    const updated = {
      ...existing,
      notificationStatus: 'sent',
      notifiedAt: new Date().toISOString(),
    };
    persist({
      ...state,
      decisions: { ...state.decisions, [existing.decisionId]: updated },
    });
  }
  return res.json({ decision: state.decisions[existing.decisionId] });
});
app.get('/claims/:claimId', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    const found = claim(req.params.claimId);
    return res.json({
      claim: found,
      evidence: evidenceForClaim(found.claimId).map(
        ({ storagePath, ...metadata }) => metadata,
      ),
    });
  } catch {
    return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
  }
});
app.post('/claims/:claimId/review-card-sent', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  let found;
  try {
    found = claim(req.params.claimId);
  } catch {
    return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
  }
  const evidenceTypes = new Set(
    evidenceForClaim(found.claimId).map((item) => item.documentType),
  );
  if (
    found.status !== 'submitted_for_review' ||
    !evidenceTypes.has('damage_photo') ||
    (!evidenceTypes.has('repair_estimate') &&
      !evidenceTypes.has('incident_report'))
  )
    return res.status(409).json({ error: 'CLAIM_EVIDENCE_INCOMPLETE' });
  if (!found.reviewCardPostedAt) {
    const updated = { ...found, reviewCardPostedAt: new Date().toISOString() };
    persist({
      ...state,
      claims: state.claims.map((item) =>
        item.claimId === found.claimId ? updated : item,
      ),
    });
  }
  return res.json({ claim: claim(found.claimId) });
});
app.get('/health', (_req, res) =>
  res.json({ ok: true, simulation: true, asOf, tools: 11 }),
);
app.post('/mcp', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent)
      res.status(500).json({ error: 'Mock MCP request failed' });
  }
});
app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
const host = process.env.HOST || '127.0.0.1';
if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.MCP_TOKEN)
  throw new Error('Set MCP_TOKEN before binding to a network interface.');
const listener = app.listen(Number(process.env.PORT || 14319), host, () =>
  console.log(
    `Mock motor insurance MCP: http://${host}:${listener.address().port}/mcp`,
  ),
);
