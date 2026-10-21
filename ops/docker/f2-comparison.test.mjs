import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProbe, requiredChecks } from './f2-comparison.mjs';

test('container startup alone cannot pass the first comparison', () => {
  assert.equal(classifyProbe({ checks: { startup: true } }).status, 'partial');
});

test('a missing real agent receipt cannot be presented as a working job', () => {
  const checks = Object.fromEntries(requiredChecks.map(k => [k, true]));
  assert.equal(classifyProbe({ checks }).status, 'partial');
  const result = classifyProbe({ checks, jobId: 'job-fixture', runId: 'run-fixture' });
  assert.equal(result.status, 'working-first-comparison');
  assert.equal(result.f2Accepted, false);
});

test('failed and unavailable checks stay distinct and no failure is treated as success', () => {
  assert.equal(classifyProbe({ checks: { startup: false } }).status, 'failed');
  assert.equal(classifyProbe({ checks: { startup: 'blocked' } }).status, 'blocked');
  assert.equal(classifyProbe({ checks: { startup: 'passed' } }).status, 'partial');
});

test('a later passing candidate is not labelled as the privileged-only comparison or F2 closure', () => {
  const checks = Object.fromEntries(requiredChecks.map(k => [k, true]));
  const result = classifyProbe({ checks, jobId: 'job-fixture', runId: 'run-fixture' }, 'readonly-root');
  assert.equal(result.status, 'working-candidate');
  assert.equal(result.f2Accepted, false);
});
