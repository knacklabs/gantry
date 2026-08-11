import { describe, expect, it } from 'vitest';

import {
  classifyCapabilityTemplateProposal,
  isCapabilityTemplateProposalWidening,
} from '@core/shared/capability-template-widening.js';
import { canonicalCapabilityTemplateAmendment } from '@core/shared/capability-template-amendment.js';

describe('capability template widening classification', () => {
  // Tiered contract (decision 0122, amended 2026-08-11): nothing is
  // warning-free except an exact-equivalent reshape; added trailing input
  // slots get the soft sentence tier; everything else is 'expanded'.
  it.each([
    {
      name: 'identical template',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets get *'],
      kind: 'equivalent',
    },
    {
      name: 'identical exact command',
      current: ['/usr/local/bin/gog sheets get'],
      proposed: ['/usr/local/bin/gog sheets get'],
      kind: 'equivalent',
    },
    {
      name: 'reordered duplicate set is equivalent',
      current: [
        '/usr/local/bin/gog sheets get *',
        '/usr/local/bin/gog sheets values *',
      ],
      proposed: [
        '/usr/local/bin/gog sheets values *',
        '/usr/local/bin/gog sheets get *',
        '/usr/local/bin/gog sheets get *',
      ],
      kind: 'equivalent',
    },
    {
      name: 'added trailing positional slot',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets get * *'],
      kind: 'added_inputs',
    },
    {
      name: 'added first trailing positional slot to an exact command',
      current: ['/usr/local/bin/gog sheets get'],
      proposed: ['/usr/local/bin/gog sheets get *'],
      kind: 'added_inputs',
    },
    {
      name: 'kept template plus an added-inputs sibling',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: [
        '/usr/local/bin/gog sheets get *',
        '/usr/local/bin/gog sheets get * *',
      ],
      kind: 'added_inputs',
    },
    {
      name: 'wildcard-as-operation-selector still warns (git remote shape)',
      current: ['/usr/bin/git remote *'],
      proposed: ['/usr/bin/git remote * *'],
      kind: 'added_inputs',
    },
    {
      name: 'different executable',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/tmp/gog sheets get * *'],
      kind: 'expanded',
    },
    {
      name: 'different subcommand',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets update * *'],
      kind: 'expanded',
    },
    {
      name: 'removed literal prefix',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets * *'],
      kind: 'expanded',
    },
    {
      name: 'added flag',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets get * --json'],
      kind: 'expanded',
    },
    {
      name: 'flag-bearing prefix is unsure',
      current: ['/usr/local/bin/gog sheets get --json *'],
      proposed: ['/usr/local/bin/gog sheets get --json * *'],
      kind: 'expanded',
    },
    {
      name: 'glob-bearing prefix is unsure',
      current: ['/usr/local/bin/gog sheets get range-*'],
      proposed: ['/usr/local/bin/gog sheets get range-* *'],
      kind: 'expanded',
    },
    {
      name: 'removed positional slot',
      current: ['/usr/local/bin/gog sheets get * *'],
      proposed: ['/usr/local/bin/gog sheets get *'],
      kind: 'expanded',
    },
    {
      name: 'non-terminal wildcard is unsure',
      current: ['/usr/local/bin/gog sheets * get'],
      proposed: ['/usr/local/bin/gog sheets * get *'],
      kind: 'expanded',
    },
    {
      name: 'multi-leaf input is unsure',
      current: ['/usr/local/bin/gog sheets get *'],
      proposed: ['/usr/local/bin/gog sheets get * && echo done'],
      kind: 'expanded',
    },
    {
      name: 'empty current set',
      current: [],
      proposed: ['/usr/local/bin/gog sheets get *'],
      kind: 'expanded',
    },
  ])('$name -> $kind', ({ current, proposed, kind }) => {
    expect(
      classifyCapabilityTemplateProposal({
        currentTemplates: current,
        proposedTemplates: proposed,
      }),
    ).toBe(kind);
  });

  it('only an exact-equivalent reshape is warning-free', () => {
    expect(
      isCapabilityTemplateProposalWidening({
        currentTemplates: ['/usr/local/bin/gog sheets get *'],
        proposedTemplates: ['/usr/local/bin/gog sheets get *'],
      }),
    ).toBe(false);
    expect(
      isCapabilityTemplateProposalWidening({
        currentTemplates: ['/usr/local/bin/gog sheets get *'],
        proposedTemplates: ['/usr/local/bin/gog sheets get * *'],
      }),
    ).toBe(true);
    expect(
      isCapabilityTemplateProposalWidening({
        currentTemplates: ['/usr/local/bin/gog sheets get *'],
        proposedTemplates: [
          '/usr/local/bin/gog sheets get * *',
          '/usr/local/bin/gog sheets update *',
        ],
      }),
    ).toBe(true);
  });

  it('canonicalizes template order and duplicates without normalizing argv evidence', () => {
    const left = canonicalCapabilityTemplateAmendment({
      capabilityId: 'google.sheets.read',
      proposedTemplates: [
        '/usr/local/bin/gog sheets get * *',
        ' /usr/local/bin/gog sheets values * ',
      ],
      observedArgv: ['sheets', 'get', 'sheet-id', 'Sheet1!A:B'],
    });
    const reordered = canonicalCapabilityTemplateAmendment({
      capabilityId: 'google.sheets.read',
      proposedTemplates: [
        '/usr/local/bin/gog sheets values *',
        '/usr/local/bin/gog sheets get * *',
        '/usr/local/bin/gog sheets get * *',
      ],
      observedArgv: ['sheets', 'get', 'sheet-id', 'Sheet1!A:B'],
    });
    const differentArgv = canonicalCapabilityTemplateAmendment({
      capabilityId: 'google.sheets.read',
      proposedTemplates: reordered.proposedTemplates,
      observedArgv: ['sheets', 'get', 'Sheet1!A:B', 'sheet-id'],
    });

    expect(reordered.canonicalKey).toBe(left.canonicalKey);
    expect(reordered.proposedTemplates).toEqual(left.proposedTemplates);
    expect(differentArgv.canonicalKey).not.toBe(left.canonicalKey);
  });
});

describe('observed argv redaction', () => {
  it('masks credential-bearing and opaque values while preserving shape', async () => {
    const { redactObservedArgv } =
      await import('@core/shared/capability-template-amendment.js');
    expect(
      redactObservedArgv([
        'sheets',
        'get',
        'sheet-id',
        'Sheet1!A:B',
        '--token=abc123',
        '--api-key',
        'test-secret-value',
        'A'.repeat(80),
        '--json',
      ]),
    ).toEqual([
      'sheets',
      'get',
      'sheet-id',
      'Sheet1!A:B',
      '--token=<redacted>',
      '--api-key',
      '<redacted>',
      '<redacted>',
      '--json',
    ]);
  });

  it('drops URL query strings so signed URLs cannot carry credentials', async () => {
    const { redactObservedArgv } =
      await import('@core/shared/capability-template-amendment.js');
    expect(
      redactObservedArgv([
        'https://host/path?access_token=secret&signature=abc',
        'https://host/plain/path',
      ]),
    ).toEqual(['https://host/path?<redacted>', 'https://host/plain/path']);
  });
});
