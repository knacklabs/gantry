import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps deferred areas out of the sidebar without removing their routes', () => {
  const navigation = readFileSync('src/app/app-navigation.tsx', 'utf8');
  const runtimeRoutes = readFileSync(
    'src/app/routes/runtime-routes.ts',
    'utf8',
  );
  const workflowRoutes = readFileSync(
    'src/app/routes/workflow-routes.ts',
    'utf8',
  );
  const channelRoutes = readFileSync(
    'src/app/routes/operations-routes.ts',
    'utf8',
  );
  const conversationRoutes = readFileSync(
    'src/app/routes/conversation-routes.ts',
    'utf8',
  );

  for (const path of [
    '/runtime/memory',
    '/runtime/capacity',
    '/activity',
    '/workflows',
    '/chat',
    '/memory',
  ]) {
    expect(navigation).not.toContain(`to: '${path}'`);
  }
  expect(navigation).not.toContain("label: 'Workflows'");
  expect(navigation).not.toMatch(/label: 'Conversations',\s*items:/);
  expect(navigation).toContain(
    "{ to: '/conversations', label: 'Conversations'",
  );
  expect(navigation).toContain(
    "{ to: '/channel-accounts', label: 'Channel accounts'",
  );
  expect(runtimeRoutes).toContain("path: 'runtime/memory'");
  expect(runtimeRoutes).toContain("path: 'runtime/capacity'");
  expect(runtimeRoutes).toContain("path: 'activity'");
  expect(workflowRoutes).toContain("path: 'workflows'");
  expect(channelRoutes).toContain("path: 'channel-accounts'");
  expect(conversationRoutes).toContain("path: 'chat'");
  expect(conversationRoutes).toContain("path: 'memory'");
});
