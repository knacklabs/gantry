import { getGantryClient } from '../../../lib/gantry';

const DEMO_WINDOW_MS = 60 * 60 * 1_000;

export async function GET() {
  const to = new Date();
  const from = new Date(to.getTime() - DEMO_WINDOW_MS);
  const result = await getGantryClient().usage.query({
    from: from.toISOString(),
    to: to.toISOString(),
    group_by: 'model',
  });

  return Response.json({
    from: from.toISOString(),
    to: to.toISOString(),
    usage: result.usage,
  });
}
