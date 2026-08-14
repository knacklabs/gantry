import { describe, expect, it } from 'vitest';

import { compileCapabilityTemplateMismatch } from '@core/jobs/capability-template-compiler.js';

const executablePath = '/usr/local/bin/gog';

describe('capability template mismatch compiler', () => {
  it('compiles trailing positional inputs against exactly one literal prefix', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [
          `${executablePath} sheets get *`,
          `${executablePath} docs get *`,
        ],
        observedArgs: ['sheets', 'get', 'sheet-1', 'Leads!A:B'],
      }),
    ).toEqual({
      kind: 'proposal',
      proposedTemplates: [`${executablePath} sheets get * *`],
      observedArgv: [executablePath, 'sheets', 'get', 'sheet-1', 'Leads!A:B'],
    });
  });

  it('proposes both pinned-path templates and preserves flags as literals', () => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: [`${executablePath} sheets get *`],
        observedArgs: [
          'sheets',
          'get',
          'sheet-1',
          'Leads!A:B',
          '--account',
          'owner@example.com',
        ],
      }),
    ).toEqual({
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

  it.each([
    {
      name: 'zero literal-prefix matches',
      templates: [`${executablePath} docs get *`],
      args: ['sheets', 'get', 'sheet-1', 'Leads!A:B'],
    },
    {
      name: 'multiple literal-prefix matches',
      templates: [
        `${executablePath} sheets get *`,
        `${executablePath} sheets get * *`,
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
      templates: [`${executablePath} sheets get * *`],
      args: ['sheets', 'get', 'sheet-1'],
    },
    {
      name: 'literal mismatch after the prefix',
      templates: [`${executablePath} sheets get fixed`],
      args: ['sheets', 'get', 'other', 'extra'],
    },
    {
      name: 'interleaved trailing flag and positional',
      templates: [`${executablePath} sheets get *`],
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
      templates: [`${executablePath} sheets get *`],
      args: ['sheets', 'get', 'sheet-1', '--json'],
    },
  ])('falls to instruction for $name', ({ templates, args }) => {
    expect(
      compileCapabilityTemplateMismatch({
        executablePath,
        commandTemplates: templates,
        observedArgs: args,
      }),
    ).toEqual({ kind: 'instruction' });
  });
});
