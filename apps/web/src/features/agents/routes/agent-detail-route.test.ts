import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('paginates the bounded audit table fifty records at a time', () => {
  const route = readFileSync(
    'src/features/agents/routes/agent-detail-route.tsx',
    'utf8',
  );
  const queries = readFileSync('src/features/agents/agents-queries.ts', 'utf8');

  expect(route).toContain('max-h-[480px] overflow-auto');
  expect(route).toContain('Previous audit page');
  expect(route).toContain('Next audit page');
  expect(route).toContain('audit.data?.pageSize ?? 50');
  expect(queries).toContain('/audit?page=${page}');
});

it('shows agent-specific, version-guarded SOUL.md and AGENTS.md editors', () => {
  const route = readFileSync(
    'src/features/agents/routes/agent-detail-route.tsx',
    'utf8',
  );
  const editor = readFileSync(
    'src/features/agents/components/agent-persona-editor.tsx',
    'utf8',
  );
  expect(route).toContain('<AgentProfileEditor');
  expect(route).toContain('agentId={agent.id}');
  expect(route).toContain('section="persona"');
  expect(route).toContain('section="instructions"');
  expect(editor).toContain('expectedVersion: profile.data![section].version');
  expect(editor).toContain('Edit persona');
  expect(editor).toContain('Edit AGENTS.md');
  expect(editor).toContain('Save AGENTS.md');
  expect(editor).toContain(
    'This profile changed elsewhere. Refresh it before saving.',
  );
});
