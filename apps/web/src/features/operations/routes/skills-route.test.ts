import { readFileSync } from 'node:fs';

import { beforeEach, expect, it, vi } from 'vitest';

const browserAuth = vi.hoisted(() => ({
  browserCsrfHeader: vi.fn(() => ({ 'x-csrf-token': 'test-csrf' })),
  browserFetch: vi.fn(),
}));

vi.mock('../../../lib/auth/browser-auth', () => browserAuth);

vi.mock('@tanstack/react-query', () => ({
  queryOptions: <T>(options: T) => options,
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) =>
    values
      .filter((value): value is string => typeof value === 'string')
      .join(' '),
}));

vi.mock('@/ui/primitives/label', () => ({
  Label: 'label',
}));

vi.mock('@/ui/primitives/button', () => ({
  Button: 'button',
}));

vi.mock('@/ui/primitives/separator', () => ({
  Separator: 'hr',
}));

import { skillsSearchSchema } from '../operations-search';
import {
  installSkillZip,
  replaceSkillAttachments,
  skillAttachmentsQuery,
  skillFileQuery,
  skillFilesQuery,
  type BrowserSkill,
} from '../skills-queries';
import {
  MAX_SELECTED_AGENTS,
  toggleAgentSelection,
} from './skills-admin-dialogs';
import { filterSkills, resolveSkillSelection } from './skills-route';

const skill: BrowserSkill = {
  id: 'skill:one',
  name: 'Incident reader',
  description: 'Reads reviewed incident records.',
  source: 'admin_uploaded',
  status: 'installed',
  sizeBytes: 42,
  actions: [
    {
      id: 'read',
      capabilityId: 'skill.incident.read',
      displayName: 'Read incidents',
      risk: 'read',
      can: 'Read approved incident records.',
      cannot: 'Change incident records.',
      networkHosts: ['incidents.example.com:443'],
      requiredCredentialNames: ['INCIDENT_API_TOKEN'],
    },
  ],
  attachedAgents: [
    { id: 'agent:one', name: 'Operations agent', status: 'active' },
  ],
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T01:00:00.000Z',
};

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

beforeEach(() => {
  browserAuth.browserFetch.mockReset();
  browserAuth.browserCsrfHeader.mockClear();
});

it('renders Skills navigation and count contract', () => {
  const navigation = source('../../../app/app-navigation.tsx');
  const routes = source('../../../app/routes/operations-routes.ts');

  expect(navigation).toContain("{ to: '/skills', label: 'Skills'");
  expect(navigation).toContain("item === '/skills'");
  expect(navigation).toContain('summary.skills.installed');
  expect(navigation).toContain('installed skill');
  expect(routes).toContain("path: 'skills'");
  expect(routes).toContain("'SkillsRoute'");
});

it('restores Skills URL state and responsive page states', () => {
  expect(
    skillsSearchSchema.parse({
      q: 'incident',
      skill: 'skill:one',
      tab: 'actions',
    }),
  ).toEqual({ q: 'incident', skill: 'skill:one', tab: 'actions' });
  expect(skillsSearchSchema.parse({ tab: 'unknown' }).tab).toBe('overview');
  expect(resolveSkillSelection([skill], 'missing')?.id).toBe('skill:one');
  expect(filterSkills([skill], 'admin uploaded')).toEqual([skill]);
  expect(filterSkills([skill], 'SKILL:ONE')).toEqual([skill]);
  expect(filterSkills([skill], 'INSTALLED')).toEqual([skill]);

  const route = source('./skills-route.tsx');
  expect(route).toMatch(/search: \(previous\) => \(\{\s+\.\.\.previous,\s+q:/);
  expect(route).toMatch(
    /search: \(previous\) => \(\{\s+\.\.\.previous,\s+skill:/,
  );
  expect(route).toMatch(
    /search: \(previous\) => \(\{\s+\.\.\.previous,\s+tab\s*[,}]/,
  );
  expect(route).not.toMatch(/search:\s*\{\s*\.\.\.search/);
  expect(route).toContain('replace: true');
  expect(route).toContain('selectedSkillId === search.skill');
  expect(route).toContain('skills.some((skill) => skill.id === search.skill)');
  expect(route).toContain('Loading skills');
  expect(route).toContain('Skills could not be loaded');
  expect(route).toContain('inventoryQuery.refetch()');
  expect(route).toContain('filesQuery.refetch()');
  expect(route).toContain('fileQuery.refetch()');
  expect(route).toContain('No skills installed');
  expect(route).toContain('No skills match this search');
  expect(route).toContain('data-layout="responsive-split"');
  expect(route).toContain(
    'lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,1.6fr)]',
  );
});

it('keeps Skills inspection read only and lazy with Agent Access links', () => {
  const route = source('./skills-route.tsx');

  expect(route).toContain("search.tab === 'files'");
  expect(skillFilesQuery(skill.id, false).enabled).toBe(false);
  expect(skillFileQuery(skill.id, 'SKILL.md', false).enabled).toBe(false);
  expect(route).toContain('requiredCredentialNames');
  expect(route).toContain('Declared actions are read-only inventory metadata');

  expect(route).toContain('to="/agents/$agentId"');
  expect(route).toContain("search={{ tab: 'access' }}");
  expect(route).toContain('Open Agent Access');

  expect(route).toContain('<pre');
  expect(route).toContain('{file.content}');
  expect(route).not.toContain('dangerouslySetInnerHTML');
  expect(route).toContain('Binary contents are not displayed');
  expect(route).toContain('file.contentType');
  expect(route).toContain('file.sizeBytes');
});

it('renders admin Skills controls and keeps viewers read only', () => {
  const route = source('./skills-route.tsx');

  expect(route).toContain("inventoryQuery.data?.role === 'administrator'");
  expect(route).toMatch(/canManage \? \(\s*<Button[\s\S]*Install skill/);
  expect(route).toMatch(/canManage && skill\.status === 'installed'/);
  expect(route).toContain('Manage attachments');
  expect(route).toMatch(/\{canManage \? \(\s*<>[\s\S]*SkillInstallDialog/);
});

it('supports administrator ZIP installation without automatic attachment', async () => {
  browserAuth.browserFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ skill }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const file = new File(['zip bytes'], 'incident-reader.zip', {
    type: 'application/zip',
  });

  await expect(installSkillZip(file)).resolves.toEqual(skill);
  expect(browserAuth.browserFetch).toHaveBeenCalledTimes(1);
  expect(browserAuth.browserFetch).toHaveBeenCalledWith(
    '/ui/api/skills/install',
    expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({
        'content-type': 'application/zip',
        'x-csrf-token': 'test-csrf',
      }),
    }),
  );

  const dialogs = source('./skills-admin-dialogs.tsx').replace(/\s+/g, ' ');
  expect(dialogs).toContain(
    'Add a ZIP package to Gantry’s skill inventory. Agent attachment is managed separately after installation.',
  );
  expect(dialogs).toContain('Choose a skill ZIP');
  expect(dialogs).toContain('ZIP only · Maximum 5 MB');
  expect(dialogs).toContain(
    'Installing a package with the same skill name updates it in place. Attached agents receive the updated instructions on their next run.',
  );
  expect(dialogs).toContain('Skill installed.');
  expect(dialogs).toContain('View skill');
  expect(dialogs).toContain('Attach agents');
  expect(dialogs).toContain('...skill.attachedAgents.map((agent) =>');
  expect(dialogs).toContain("agentQueryKeys.all, 'sources', agent.id");
  expect(dialogs).toContain('queryKey: agentQueryKeys.all');
});

it('replaces the complete attachment set and keeps disabled agents selectable', async () => {
  const attachments = {
    skillId: skill.id,
    agents: [
      { ...skill.attachedAgents[0], attached: false },
      {
        id: 'agent:disabled',
        name: 'Paused agent',
        status: 'disabled' as const,
        attached: true,
      },
    ],
  };
  browserAuth.browserFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(attachments), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await expect(
    replaceSkillAttachments(skill.id, ['agent:one', 'agent:disabled']),
  ).resolves.toEqual(attachments);
  expect(browserAuth.browserFetch).toHaveBeenCalledWith(
    `/ui/api/skills/${encodeURIComponent(skill.id)}/agents`,
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ agentIds: ['agent:one', 'agent:disabled'] }),
    }),
  );

  const dialogs = source('./skills-admin-dialogs.tsx').replace(/\s+/g, ' ');
  expect(dialogs).toContain('Disabled · available when the agent is enabled.');
  expect(dialogs).toContain(
    '<DialogTitle className="text-lg font-semibold"> Attach agents </DialogTitle>',
  );
  expect(dialogs).toContain(
    'Choose which agents receive this skill’s instructions on their next run.',
  );
  expect(dialogs).toContain(
    'Attachment is not authorization. Declared actions must still be enabled from each agent’s Access tab.',
  );
  expect(dialogs).toContain('checked={selected.has(agent.id)}');
  expect(skillAttachmentsQuery(skill.id, false).enabled).toBe(false);

  let selected = new Set(
    Array.from({ length: MAX_SELECTED_AGENTS }, (_, index) => `agent:${index}`),
  );
  selected = toggleAgentSelection(selected, 'agent:extra');
  expect(selected.size).toBe(MAX_SELECTED_AGENTS);
  expect(selected.has('agent:extra')).toBe(false);
  selected = toggleAgentSelection(selected, 'agent:0');
  expect(selected.size).toBe(MAX_SELECTED_AGENTS - 1);
  selected = toggleAgentSelection(selected, 'agent:extra');
  expect(selected.has('agent:extra')).toBe(true);
  expect(dialogs).toContain(
    'disabled={ !selected.has(agent.id) && selected.size >= MAX_SELECTED_AGENTS }',
  );
});

it('preserves mutation failures and invalidates affected queries', async () => {
  browserAuth.browserFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ error: { message: 'Confirmed failure message.' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ),
  );

  await expect(
    replaceSkillAttachments(skill.id, ['agent:one']),
  ).rejects.toThrow('Confirmed failure message.');

  const dialogs = source('./skills-admin-dialogs.tsx');
  expect(dialogs).toContain('query.isFetching');
  expect(dialogs).toContain('query.isError');
  expect(dialogs).toContain('hydratedSkillId !== skill.id');
  expect(dialogs).toContain('setHydratedSkillId(undefined)');
  expect(dialogs).toContain(
    'Attachments saved. Changes apply on each agent’s next run.',
  );
  expect(dialogs).toContain('role="alert"');
  expect(dialogs).toContain('const refreshed = await query.refetch()');
  expect(dialogs).toContain('setSelected(ids)');
  expect(dialogs).toContain('refreshed.isSuccess && refreshed.data');
  expect(dialogs).toContain('setReconciliationRequired(true)');
  expect(dialogs).toMatch(/query\.isError\s*\|\|\s*reconciliationRequired/);
  expect(dialogs.match(/skillInventoryQuery\.queryKey/g)).toHaveLength(4);
  expect(dialogs.match(/navigationSummaryQuery\.queryKey/g)).toHaveLength(4);
  expect(
    dialogs.match(/agentQueryKeys\.all, 'sources', agentId/g),
  ).toHaveLength(2);
  expect(dialogs).toContain("'Attachments could not be saved.'");
  expect(source('./skills-route.tsx')).toContain(
    'Attachments saved. Changes apply on each agent’s next run.',
  );
});

it('keeps Skills dialogs accessible and constrained', () => {
  const dialogs = source('./skills-admin-dialogs.tsx');

  expect(dialogs).toContain('accept=".zip,application/zip"');
  expect(dialogs).toContain(
    'aria-describedby="skill-zip-hint skill-update-warning"',
  );
  expect(dialogs).toContain('aria-live="polite"');
  expect(dialogs).toContain('aria-atomic="true"');
  expect(dialogs).toContain('aria-live="assertive"');
  expect(dialogs).toContain('onOpenAutoFocus');
  expect(dialogs).toContain('onCloseAutoFocus');
  expect(dialogs).toContain('onEscapeKeyDown');
  expect(dialogs).toContain('onInteractOutside');
  expect(dialogs).toContain('successActionRef.current?.focus()');
  expect(dialogs).toContain('doneRef.current?.focus()');
  expect(dialogs).toContain('max-h-[calc(100dvh-32px)]');
  expect(dialogs).toContain('w-[min(680px,calc(100vw-32px))]');
});
