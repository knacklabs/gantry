// Test phone numbers for the Boondi regression harness.
//
// INVARIANT: every number here MUST be in the server's GANTRY_TEST_OPERATOR_PHONE
// set during a test run. With that set, each number is:
//   • outbound-scoped — dry-run sends only to listed numbers (a fake number's send
//     fails harmlessly at Interakt, but the reply is still PERSISTED so the
//     dashboard shows both sides). A number NOT in the list is never sent to.
//   • allowed to run /new (session reset between scenarios / lanes).
//   • never a real customer — so these are deliberately FAKE numbers, NOT the
//     operator's own WhatsApp (which would actually receive the test replies).
//
// Shopify identity: with GANTRY_TEST_CALLER_IDENTITY_PHONE=SHOPIFY_IDENTITY, every
// test turn's signed Shopify caller-identity resolves to SHOPIFY_IDENTITY — so
// "my own order" == SHOPIFY_IDENTITY and any other number is a privacy mismatch.
// CRM capture keys off the CONVERSATION phone (not the identity header), so each
// persona's records still land under its own number regardless of the override.

// The Shopify identity every test turn resolves to (set as GANTRY_TEST_CALLER_IDENTITY_PHONE).
export const SHOPIFY_IDENTITY = '918097288633';

// conversation + shopify groups: round-robin parallel lanes (fake numbers).
export const LANE_PHONES = ['919900050001', '919900050002', '919900050003'];

// crm group: one persona phone per scenario, so each is its own dashboard
// conversation and its own opportunity row(s).
export const CRM_PHONES = {
  softQuery: '919900000001',
  personalGift: '919900000002',
  weddingOccasion: '919900000003',
  corporateLead: '919900000004',
  b2bMulticity: '919900000005',
  curiousBrowser: '919900000006',
  returning: '919900000007', // seeded with a prior open lead (see reset/seed)
  negSupport: '919900000008',
  negComplaint: '919900000009',
  negOutOfScope: '919900000010',
  progressive: '919900000011',
  multiOpportunity: '919900000013',
  generalEnquiry: '919900000014',
  hindiGifting: '919900000015',
  privacySupport: '919900000016',
};
export const RETURNING_PHONE = CRM_PHONES.returning;

// isolation group: many users driven concurrently, each tagged with a distinctive
// marker, to prove no chat's content leaks into another (the bleed guard).
export const ISOLATION_PHONES = [
  '919900029001',
  '919900029002',
  '919900029003',
  '919900029004',
  '919900029005',
  '919900029006',
];

// The union — exactly what GANTRY_TEST_OPERATOR_PHONE must contain for a run.
export const ALL_TEST_PHONES = [
  ...LANE_PHONES,
  ...Object.values(CRM_PHONES),
  ...ISOLATION_PHONES,
];
export const OPERATOR_LIST = ALL_TEST_PHONES.join(',');
