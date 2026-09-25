import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const dir = mkdtempSync(join(tmpdir(), 'motor-mcp-test-'));
const env = {
  ...process.env,
  PORT: '0',
  HOST: '127.0.0.1',
  STATE_FILE: join(dir, 'state.json'),
  EVIDENCE_DIR: join(dir, 'evidence'),
  MCP_TOKEN: 'test-only-token',
};
let child, client, serverUrl;
async function start() {
  child = spawn(process.execPath, ['server.mjs'], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Server start timed out')),
      10000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}`));
    });
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  serverUrl = url.replace(/\/mcp$/, '');
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  client = new Client({ name: 'motor-demo-smoke-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer test-only-token' } },
    }),
  );
}
async function stop() {
  await client?.close();
  if (child && child.exitCode === null)
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
}
async function call(name, args = {}, error = false) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(response.isError), error, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
}
async function post(path, body, authorized = true) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorized ? { Authorization: 'Bearer test-only-token' } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
try {
  await start();
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.equal(
    tools.find((t) => t.name === 'register_motor_claim').annotations
      .readOnlyHint,
    false,
  );
  assert.equal(
    tools.find((t) => t.name === 'ingest_claim_document').annotations
      .readOnlyHint,
    false,
  );
  assert.equal((await call('list_demo_scenarios')).policies.length, 5);
  assert.equal(
    (await call('get_motor_policy', { policyId: 'MOTOR-1001' })).policy
      .zeroDepreciation,
    true,
  );
  assert.equal(
    (await call('get_motor_policy', { policy_id: 'MOTOR-1001' })).policy
      .policyId,
    'MOTOR-1001',
  );
  assert.equal(
    (await call('get_motor_policy', { policy_number: 'MOTOR-1001' })).policy
      .policyId,
    'MOTOR-1001',
  );
  assert.equal(
    (await call('get_motor_policy', { policyId: 'MOTOR-1004' })).policy
      .engineProtection,
    true,
  );
  assert.equal(
    (await call('get_motor_policy', { policyId: 'MOTOR-1005' })).policy
      .zeroDepreciation,
    true,
  );
  assert.equal((await call('get_motor_policy')).error, 'POLICY_ID_REQUIRED');
  assert.equal(
    (
      await call('check_motor_coverage', {
        policyNumber: 'MOTOR-1001',
        incidentType: 'collision',
        incidentDate: '2026-08-28',
        location: 'Hyderabad',
      })
    ).assessment,
    'potentially_covered',
  );
  assert.equal(
    (
      await call('check_motor_coverage', {
        policy_number: 'MOTOR-1001',
        incident_type: 'collision',
        incident_date: '2026-08-28',
      })
    ).assessment,
    'potentially_covered',
  );
  assert.equal(
    (await call('check_motor_coverage', { policy_id: 'MOTOR-1001' })).error,
    'INCIDENT_DETAILS_REQUIRED',
  );
  const missingPolicy = await call('get_motor_policy', {
    policyId: 'MOTOR-001',
  });
  assert.equal(missingPolicy.error, 'POLICY_NOT_FOUND');
  assert.deepEqual(missingPolicy.availablePolicyIds, [
    'MOTOR-1001',
    'MOTOR-1002',
    'MOTOR-1003',
    'MOTOR-1004',
    'MOTOR-1005',
  ]);
  const missingAssessment = await call('assess_claim_eligibility', {
    policyId: 'MOTOR-001',
    incidentType: 'collision',
    incidentDate: '2026-08-28',
  });
  assert.equal(missingAssessment.error, 'POLICY_NOT_FOUND');
  for (const [policyId, incidentType, assessment] of [
    ['MOTOR-1001', 'collision', 'potentially_covered'],
    ['MOTOR-1001', 'engine_water_damage', 'not_included'],
    ['MOTOR-1002', 'collision', 'not_included'],
    ['MOTOR-1003', 'collision', 'outside_policy_period'],
    ['MOTOR-1004', 'engine_water_damage', 'potentially_covered'],
    ['MOTOR-1005', 'breakdown', 'assistance_available'],
  ])
    assert.equal(
      (
        await call('check_motor_coverage', {
          policyId,
          incidentType,
          incidentDate: '2026-09-22',
        })
      ).assessment,
      assessment,
    );
  assert.equal(
    (await call('find_cashless_garages', { city: 'Bengaluru' })).garages.length,
    2,
  );
  assert.equal(
    (await call('find_cashless_garages', { city: 'Unknown' })).garages.length,
    0,
  );
  const quote = await call('get_renewal_quote', {
    policyId: 'MOTOR-1001',
    plan: 'comprehensive',
  });
  const enhanced = await call('get_renewal_quote', {
    policyId: 'MOTOR-1001',
    plan: 'comprehensive',
    engineProtection: true,
  });
  assert.equal(enhanced.premium.total - quote.premium.total, 1500);
  await call(
    'get_renewal_quote',
    {
      policyId: 'MOTOR-1001',
      plan: 'third_party_only',
      zeroDepreciation: true,
    },
    true,
  );
  assert.equal(
    (await call('get_motor_claim', { claimId: 'CLM-DEMO-001' })).claim.status,
    'awaiting_documents',
  );
  const documentInput = {
    policyId: 'MOTOR-1001',
    claimId: 'CLM-DEMO-001',
    documentType: 'repair_estimate',
    fileName: 'fictional-estimate.pdf',
    mimeType: 'application/pdf',
    extractedText: 'Fictional repair estimate: bumper repair INR 12,000.',
    requestId: 'smoke-document-1',
  };
  const document = await call('ingest_claim_document', documentInput);
  assert.equal(document.status, 'stored_for_review');
  assert.equal(
    (await call('ingest_claim_document', documentInput)).replayed,
    true,
  );
  await call(
    'ingest_claim_document',
    { ...documentInput, extractedText: 'Different text' },
    true,
  );
  await call(
    'ingest_claim_document',
    { ...documentInput, policyId: 'MOTOR-1002', requestId: 'wrong-policy' },
    true,
  );
  assert.equal(
    (await call('get_claim_ticket', { claimId: 'CLM-DEMO-001' })).documents[0]
      .extractedText,
    documentInput.extractedText,
  );
  assert.equal(
    (await call('list_claim_tickets')).tickets.find(
      (t) => t.claimId === 'CLM-DEMO-001',
    ).documentCount,
    1,
  );
  assert.equal(
    (
      await call('assess_claim_eligibility', {
        policyId: 'MOTOR-1001',
        incidentType: 'collision',
        incidentDate: '2026-09-22',
        intakeId: document.intakeId,
      })
    ).assessment,
    'potentially_covered',
  );
  await call(
    'assess_claim_eligibility',
    {
      policyId: 'MOTOR-1002',
      incidentType: 'collision',
      incidentDate: '2026-09-22',
      intakeId: document.intakeId,
    },
    true,
  );
  const incident = {
    policyId: 'MOTOR-1001',
    incidentType: 'collision',
    incidentDate: '2026-09-22',
    location: 'Bengaluru',
    description: 'Hit a pillar while parking; bumper damaged.',
    confirmed: false,
    requestId: 'smoke-incident-1',
  };
  await call('register_motor_claim', incident, true);
  incident.confirmed = true;
  const created = await call('register_motor_claim', incident);
  assert.equal(created.replayed, false);
  assert.equal(created.claim.status, 'awaiting_documents');
  assert.equal(created.claim.registrationAssessment, 'potentially_covered');
  assert.equal(
    created.claim.registrationReason,
    'Included in the fictional cover; documents, exclusions and assessment still apply.',
  );
  assert.equal(
    (await call('list_claim_tickets')).tickets.find(
      (t) => t.claimId === created.claim.claimId,
    ).registrationReason,
    created.claim.registrationReason,
  );
  assert.equal(
    (await call('register_motor_claim', incident)).claim.claimId,
    created.claim.claimId,
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
    'base64',
  );
  const evidenceInput = {
    claimId: created.claim.claimId,
    requestId: 'evidence-1',
    documentType: 'damage_photo',
    fileName: 'damage.png',
    mimeType: 'image/png',
    dataBase64: png.toString('base64'),
    extractedText: 'Visible dent on front bumper.',
    extractedFields: { damageArea: 'front bumper' },
  };
  assert.equal((await post('/evidence', evidenceInput, false)).status, 401);
  const uploaded = await post('/evidence', evidenceInput);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.claim.status, 'awaiting_documents');
  assert.equal(uploaded.body.evidence.extractionStatus, 'extracted_unverified');
  assert.equal('storagePath' in uploaded.body.evidence, false);
  assert.equal((await post('/evidence', evidenceInput)).body.replayed, true);
  assert.equal(
    (
      await post('/evidence', {
        ...evidenceInput,
        extractedText: 'Different text',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post('/evidence', {
        ...evidenceInput,
        requestId: 'bad-mime',
        mimeType: 'application/pdf',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post('/evidence', {
        ...evidenceInput,
        requestId: 'no-claim',
        claimId: 'CLM-UNKNOWN',
      })
    ).status,
    404,
  );
  const storedPath = join(
    env.EVIDENCE_DIR,
    created.claim.claimId,
    `${uploaded.body.evidence.evidenceId}-damage.png`,
  );
  assert.equal(existsSync(storedPath), true);
  assert.deepEqual(readFileSync(storedPath), png);
  assert.equal(
    (await call('get_motor_claim', { claimId: created.claim.claimId })).evidence
      .length,
    1,
  );
  assert.equal(
    (await post(`/claims/${created.claim.claimId}/review-card-sent`, {}))
      .status,
    409,
  );
  const decisionInput = {
    decision: 'approve',
    actorId: 'U123ABC',
    requestId: 'decision-1',
    reason: '',
  };
  assert.equal(
    (await post(`/claims/${created.claim.claimId}/decision`, decisionInput))
      .status,
    409,
  );
  const estimatePdf = Buffer.from('%PDF-1.7\nEstimate total INR 10000\n');
  const uploadedEstimate = await post('/evidence', {
    ...evidenceInput,
    requestId: 'evidence-2',
    documentType: 'repair_estimate',
    fileName: 'estimate.pdf',
    mimeType: 'application/pdf',
    dataBase64: estimatePdf.toString('base64'),
    extractedText: 'Estimate total INR 10000',
    extractedFields: { total: 10000 },
  });
  assert.equal(uploadedEstimate.status, 201);
  assert.equal(uploadedEstimate.body.claim.status, 'submitted_for_review');
  assert.equal(
    (await post(`/claims/${created.claim.claimId}/review-card-sent`, {}))
      .status,
    200,
  );
  assert.equal(
    (
      await (
        await fetch(`${serverUrl}/claims/${created.claim.claimId}`, {
          headers: { Authorization: 'Bearer test-only-token' },
        })
      ).json()
    ).claim.reviewCardPostedAt !== undefined,
    true,
  );
  assert.equal(
    (
      await post(
        `/claims/${created.claim.claimId}/decision`,
        decisionInput,
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await post(`/claims/${created.claim.claimId}/decision`, {
        ...decisionInput,
        decision: 'decline',
      })
    ).status,
    400,
  );
  const decided = await post(
    `/claims/${created.claim.claimId}/decision`,
    decisionInput,
  );
  assert.equal(decided.status, 201);
  assert.equal(decided.body.claim.status, 'approved_internal_review');
  assert.equal(
    (await post(`/claims/${created.claim.claimId}/decision`, decisionInput))
      .body.replayed,
    true,
  );
  assert.equal(
    (
      await post(`/claims/${created.claim.claimId}/decision`, {
        ...decisionInput,
        requestId: 'decision-2',
        decision: 'decline',
        reason: 'Not covered',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        `/decisions/${decided.body.decision.decisionId}/notification-sent`,
        {},
      )
    ).body.decision.notificationStatus,
    'sent',
  );
  const formClaim = await call('register_motor_claim', {
    ...incident,
    requestId: 'smoke-form-claim',
  });
  assert.equal(formClaim.claim.status, 'awaiting_documents');
  assert.equal(
    (
      await post('/evidence', {
        ...evidenceInput,
        claimId: formClaim.claim.claimId,
        requestId: 'form-claim-photo',
      })
    ).status,
    201,
  );
  assert.equal(
    (await call('get_motor_claim', { claimId: formClaim.claim.claimId })).claim
      .status,
    'awaiting_documents',
  );
  const claimFormPdf = Buffer.from('%PDF-1.7\nFilled claim form for review\n');
  assert.equal(
    (
      await post('/evidence', {
        ...evidenceInput,
        claimId: formClaim.claim.claimId,
        requestId: 'form-claim-report',
        documentType: 'incident_report',
        fileName: 'claim-form.pdf',
        mimeType: 'application/pdf',
        dataBase64: claimFormPdf.toString('base64'),
        extractedText: 'Filled claim form; details unverified.',
      })
    ).status,
    201,
  );
  assert.equal(
    (await call('get_motor_claim', { claimId: formClaim.claim.claimId })).claim
      .status,
    'submitted_for_review',
  );
  assert.equal(
    (await post(`/claims/${formClaim.claim.claimId}/review-card-sent`, {}))
      .status,
    200,
  );
  await call(
    'register_motor_claim',
    { ...incident, description: 'Different incident description.' },
    true,
  );
  await call(
    'register_motor_claim',
    { ...incident, policyId: 'MOTOR-1003', requestId: 'expired' },
    true,
  );
  await call(
    'register_motor_claim',
    { ...incident, incidentDate: '2027-01-01', requestId: 'future' },
    true,
  );
  await stop();
  await start();
  assert.equal(
    (await call('get_motor_claim', { claimId: created.claim.claimId })).claim
      .description,
    incident.description,
  );
  assert.equal(
    (await call('get_claim_ticket', { claimId: created.claim.claimId })).ticket
      .registrationReason,
    created.claim.registrationReason,
  );
  assert.equal(
    (await call('get_claim_ticket', { claimId: 'CLM-DEMO-001' })).documents
      .length,
    1,
  );
  assert.equal((await call('register_motor_claim', incident)).replayed, true);
  assert.equal(
    (await call('get_motor_claim', { claimId: created.claim.claimId })).claim
      .status,
    'approved_internal_review',
  );
  assert.equal(
    (await call('get_motor_claim', { claimId: created.claim.claimId })).evidence
      .length,
    2,
  );
  console.log(
    'PASS: MCP handshake, 11 tools, auth, coverage, text and binary intake, review decisions, idempotency, and restart persistence.',
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
