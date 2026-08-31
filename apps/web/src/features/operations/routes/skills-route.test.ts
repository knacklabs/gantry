import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-query', () => ({
  queryOptions: <T>(options: T) => options,
  useQuery: vi.fn(),
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

vi.mock('@/ui/primitives/separator', () => ({
  Separator: 'hr',
}));

import { skillsSearchSchema } from '../operations-search';
import {
  skillFileQuery,
  skillFilesQuery,
  type BrowserSkill,
} from '../skills-queries';
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
  expect(route).toContain('Loading skills');
  expect(route).toContain('Skills could not be loaded');
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
  expect(route).not.toMatch(/Install skill|Attach agents|Save changes/);

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
