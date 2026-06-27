import { createClient } from '../../packages/sdk/dist/index.js';

const apiKey = process.env.GANTRY_CONTROL_API_KEY;
if (!apiKey) {
  throw new Error('Set GANTRY_CONTROL_API_KEY to a local development token.');
}

const client = createClient({
  apiKey,
  baseUrl: process.env.GANTRY_CONTROL_BASE_URL || 'http://127.0.0.1:3939',
});

const health = await client.health();
console.log({
  status: health.status,
  processRole: health.processRole,
  transport: health.transport.kind,
});
