import { describe, expect, it } from 'vitest';

import { compileCapabilityTemplateMismatch } from '@core/jobs/capability-template-compiler.js';
import { classifyCapabilityTemplateProposal } from '@core/shared/capability-template-widening.js';

const executablePath = '/usr/local/bin/gog';

it('CAPSAFE-1-COMPILER', () => {
  expect(
    compileCapabilityTemplateMismatch({
      executablePath,
      commandTemplates: [`${executablePath} sheets update *`],
      observedArgs: [
        'sheets',
        'update',
        'sheet-1',
        'Leads!A1:K1',
        '--values-json',
        '[["a","b,c"]]',
      ],
    }),
  ).toMatchObject({ kind: 'covered' });

  expect(
    compileCapabilityTemplateMismatch({
      executablePath,
      commandTemplates: [
        `${executablePath} sheets get`,
        `${executablePath} sheets 'get'`,
      ],
      observedArgs: ['sheets', 'get', 'sheet-1'],
    }),
  ).toMatchObject({
    kind: 'proposal',
    prefixMatches: 2,
    proposedTemplates: [`${executablePath} sheets get *`],
  });

  expect(
    compileCapabilityTemplateMismatch({
      executablePath,
      commandTemplates: [
        `${executablePath} sheets get`,
        `${executablePath} sheets get sheet-1`,
      ],
      observedArgs: ['sheets', 'get', 'sheet-1', 'extra'],
    }),
  ).toMatchObject({ kind: 'instruction', prefixMatches: 2 });
  expect(
    compileCapabilityTemplateMismatch({
      executablePath,
      commandTemplates: [
        `${executablePath} sheets get`,
        `${executablePath} sheets get range-*`,
      ],
      observedArgs: ['sheets', 'get', 'range-a', 'extra'],
    }),
  ).toMatchObject({ kind: 'instruction', prefixMatches: 2 });

  expect(
    classifyCapabilityTemplateProposal({
      currentTemplates: [`${executablePath} sheets get`],
      proposedTemplates: [`${executablePath} sheets get *`],
    }),
  ).toBe('expanded');
});

describe('capability template mismatch compiler', () => {
  it('compiles trailing positional inputs against exactly one literal prefix', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [
          `${executablePath} sheets get`,
          `${executablePath} docs get *`,
        ],
        observedArgs: ['sheets', 'get', 'sheet-1', 'Leads!A:B'],
      }),
    ).toMatchObject({
      kind: 'proposal',
      proposedTemplates: [`${executablePath} sheets get * *`],
      observedArgv: [executablePath, 'sheets', 'get', 'sheet-1', 'Leads!A:B'],
    });
  });

  it('proposes both pinned-path templates and preserves flags as literals', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [`${executablePath} sheets get`],
        observedArgs: [
          'sheets',
          'get',
          'sheet-1',
          'Leads!A:B',
          '--account',
          'owner@example.com',
        ],
      }),
    ).toMatchObject({
      kind: 'proposal',
      proposedTemplates: [
        `${executablePath} sheets get * *`,
        `${executablePath} sheets get * * --account *`,
      ],
      observedArgv: [
        executablePath,
        'sheets',
        'get',
        'sheet-1',
        'Leads!A:B',
        '--account',
        'owner@example.com',
      ],
    });
  });

  it('serializes multiple observed flags as one ordered template, not per-flag siblings', () => {
    // Guards against option-injection over-widening: an observed multi-flag call
    // must widen to a SINGLE template that preserves the observed flag order as
    // literals (a later flag can never be reached without the earlier one), NOT
    // a separate `--flag *` template per flag.
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [`${executablePath} sheets get`],
        observedArgs: [
          'sheets',
          'get',
          '--account',
          'owner@example.com',
          '--json',
          'true',
        ],
      }),
    ).toMatchObject({
      kind: 'proposal',
      proposedTemplates: [
        `${executablePath} sheets get`,
        `${executablePath} sheets get --account * --json *`,
      ],
    });
  });

  it('recognizes a flagged call already covered by the terminal remainder', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [`${executablePath} sheets update * * *`],
        observedArgs: [
          'sheets',
          'update',
          'sheet-1',
          'Leads!A1:K1',
          '--values-json',
          '[["a","b,c"]]',
        ],
      }),
    ).toMatchObject({ kind: 'covered' });
  });

  it('instructs when a flag arrives before required non-terminal wildcards', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [`${executablePath} sheets update * * * *`],
        observedArgs: [
          'sheets',
          'update',
          'sheet-1',
          '--values-json',
          '[["a","b,c"]]',
        ],
      }),
    ).toMatchObject({ kind: 'instruction' });
  });

  it.each([
    {
      name: 'interleaved trailing flag and positional',
      template: `${executablePath} sheets get *`,
      args: [
        'sheets',
        'get',
        'sheet-1',
        '--account',
        'owner@example.com',
        'Leads!A:B',
      ],
    },
    {
      name: 'flag without a value',
      template: `${executablePath} sheets get *`,
      args: ['sheets', 'get', 'sheet-1', '--json'],
    },
    {
      name: 'reviewed flag followed by a remainder',
      template: `${executablePath} sheets get * --account *`,
      args: ['sheets', 'get', 'sheet-1', '--account', '--json', 'v'],
    },
    {
      name: 'reviewed flag and remainder with no leading positional',
      template: `${executablePath} sheets get --account *`,
      args: ['sheets', 'get', '--account', '--json', 'v'],
    },
  ])('recognizes $name as covered authority', ({ template, args }) => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [template],
        observedArgs: args,
      }),
    ).toMatchObject({ kind: 'covered' });
  });

  it.each([
    {
      name: 'zero literal-prefix matches',
      templates: [`${executablePath} docs get *`],
      args: ['sheets', 'get', 'sheet-1', 'Leads!A:B'],
    },
    {
      name: 'divergent literal-prefix matches',
      templates: [
        `${executablePath} sheets get`,
        `${executablePath} sheets get sheet-1`,
      ],
      args: ['sheets', 'get', 'sheet-1', 'Leads!A:B', 'extra'],
    },
    {
      name: 'mixed glob',
      templates: [`${executablePath} sheets get range-*`],
      args: ['sheets', 'get', 'range-a', 'extra'],
    },
    {
      name: 'shorter argv',
      templates: [`${executablePath} sheets get * * fixed`],
      args: ['sheets', 'get', 'sheet-1'],
    },
    {
      name: 'literal mismatch after the prefix',
      templates: [`${executablePath} sheets get fixed`],
      args: ['sheets', 'get', 'other', 'extra'],
    },
  ])('falls to instruction for $name', ({ templates, args }) => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: templates,
        observedArgs: args,
      }),
    ).toMatchObject({ kind: 'instruction' });
  });
});
