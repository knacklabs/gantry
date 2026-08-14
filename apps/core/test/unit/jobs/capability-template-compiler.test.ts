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

  it('proposes the flag form when the observed call uses fewer positionals than the template before a flag', () => {
    // Regression: a `--values-json` write against a `* * *` template must NOT
    // dead-end on an instruction card just because the third positional `*`
    // lines up with the flag. The observed uses two positionals, then a flag.
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
    ).toMatchObject({
      kind: 'proposal',
      proposedTemplates: [
        `${executablePath} sheets update * *`,
        `${executablePath} sheets update * * --values-json *`,
      ],
    });
  });

  it('proposes the flag form even when the observed call omits several trailing positional wildcards', () => {
    // Regression: with a longer positional template the flag-form call has
    // FEWER total tokens than the template, so a full-length precheck would
    // reject it before the cursor ever reached the flag.
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
    ).toMatchObject({
      kind: 'proposal',
      proposedTemplates: [
        `${executablePath} sheets update *`,
        `${executablePath} sheets update * --values-json *`,
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
    {
      // A reviewed literal flag's value wildcard is NOT an optional trailing
      // positional: dropping it must not build a valueless `--account` proposal.
      name: 'reviewed flag value wildcard stays required',
      templates: [`${executablePath} sheets get * --account *`],
      args: ['sheets', 'get', 'sheet-1', '--account', '--json', 'v'],
    },
    {
      // Same rule when the reviewed flag precedes ANY positional wildcard: the
      // value stays required even with no leading positional run before it.
      name: 'reviewed flag value stays required with no leading positional',
      templates: [`${executablePath} sheets get --account *`],
      args: ['sheets', 'get', '--account', '--json', 'v'],
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
