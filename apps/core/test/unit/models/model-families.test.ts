import { describe, expect, it } from 'vitest';

import { resolveModelSelection } from '@core/shared/model-catalog.js';
import {
  MODEL_FAMILIES,
  describeFamilyResolution,
  effectiveFamilyMembers,
  getModelFamily,
  isModelFamilyAlias,
  listModelFamilies,
  providerIdForFamilyMember,
  resolveModelFamilyAlias,
  resolveModelFamilyCandidates,
  resolveModelSelectionForWorkloadWithFamilies,
} from '@core/shared/model-families.js';

const configured = (providers: string[]) => ({
  isProviderConfigured: (providerId: string) => providers.includes(providerId),
});

describe('model families', () => {
  it('seeds exactly the real catalog overlaps with preference order', () => {
    const gptOss = getModelFamily('gpt-oss');
    expect(gptOss?.members).toEqual(['groq-oss', 'cerebras']);
    const llama = getModelFamily('llama-70b');
    expect(llama?.members).toEqual(['groq', 'together']);
    expect(listModelFamilies()).toBe(MODEL_FAMILIES);
  });

  it('maps each member alias to its catalog provider id', () => {
    expect(providerIdForFamilyMember('groq-oss')).toBe('groq');
    expect(providerIdForFamilyMember('cerebras')).toBe('cerebras');
    expect(providerIdForFamilyMember('together')).toBe('together');
  });

  it('every family alias and member exists, and no alias collides with the catalog', () => {
    for (const family of MODEL_FAMILIES) {
      // A family alias must NOT be a concrete catalog alias.
      expect(resolveModelSelection(family.alias).ok).toBe(false);
      // Every member must be a real concrete catalog alias.
      for (const member of family.members) {
        expect(resolveModelSelection(member).ok).toBe(true);
      }
    }
  });

  describe('resolveModelFamilyAlias', () => {
    it('returns null for a non-family alias so the caller uses it unchanged', () => {
      // Concrete catalog aliases (including family members) are not families.
      expect(resolveModelFamilyAlias('opus', configured([]))).toBeNull();
      expect(resolveModelFamilyAlias('groq-oss', configured([]))).toBeNull();
      expect(resolveModelFamilyAlias('gpt-oss', configured([]))).not.toBeNull();
    });

    it('picks the first member whose provider is configured', () => {
      // Only the second member (cerebras) is configured -> resolve to cerebras.
      expect(
        resolveModelFamilyAlias('gpt-oss', configured(['cerebras'])),
      ).toEqual({ alias: 'cerebras' });
      // First member (groq) configured -> resolve to groq-oss (groq provider).
      expect(resolveModelFamilyAlias('gpt-oss', configured(['groq']))).toEqual({
        alias: 'groq-oss',
      });
      // Both configured -> first in preference order wins.
      expect(
        resolveModelFamilyAlias('gpt-oss', configured(['groq', 'cerebras'])),
      ).toEqual({ alias: 'groq-oss' });
    });

    it('falls back to the first member when no provider is configured', () => {
      expect(resolveModelFamilyAlias('gpt-oss', configured([]))).toEqual({
        alias: 'groq-oss',
      });
      expect(resolveModelFamilyAlias('llama-70b', configured([]))).toEqual({
        alias: 'groq',
      });
    });
  });

  describe('resolveModelFamilyCandidates (failover ordering)', () => {
    it('returns [alias] for a non-family alias', () => {
      expect(resolveModelFamilyCandidates('opus', configured([]))).toEqual([
        'opus',
      ]);
      expect(
        resolveModelFamilyCandidates('groq-oss', configured(['groq'])),
      ).toEqual(['groq-oss']);
    });

    it('returns [] for an empty alias', () => {
      expect(resolveModelFamilyCandidates('', configured([]))).toEqual([]);
      expect(resolveModelFamilyCandidates(undefined, configured([]))).toEqual(
        [],
      );
    });

    it('orders configured members first, unconfigured last', () => {
      // Only the second member (cerebras) configured -> it leads, groq-oss last.
      expect(
        resolveModelFamilyCandidates('gpt-oss', configured(['cerebras'])),
      ).toEqual(['cerebras', 'groq-oss']);
      // Both configured -> effective (declared) order preserved among configured.
      expect(
        resolveModelFamilyCandidates(
          'gpt-oss',
          configured(['groq', 'cerebras']),
        ),
      ).toEqual(['groq-oss', 'cerebras']);
    });

    it('falls back to the effective member order when none configured', () => {
      // candidates[0] equals resolveModelFamilyAlias's loud-failure first member.
      expect(resolveModelFamilyCandidates('gpt-oss', configured([]))).toEqual([
        'groq-oss',
        'cerebras',
      ]);
      expect(resolveModelFamilyCandidates('gpt-oss', configured([]))[0]).toBe(
        resolveModelFamilyAlias('gpt-oss', configured([]))?.alias,
      );
    });

    it('honors the order override and configured-first partition together', () => {
      // Override puts cerebras first; only groq configured -> groq-oss leads
      // (configured), cerebras appended last (unconfigured) despite override.
      expect(
        resolveModelFamilyCandidates('gpt-oss', {
          ...configured(['groq']),
          order: { 'gpt-oss': ['cerebras', 'groq-oss'] },
        }),
      ).toEqual(['groq-oss', 'cerebras']);
    });
  });

  describe('resolveModelSelectionForWorkloadWithFamilies', () => {
    it('accepts a family alias for chat and carries the family alias', () => {
      const resolved = resolveModelSelectionForWorkloadWithFamilies(
        'gpt-oss',
        'chat',
      );
      expect(resolved).toMatchObject({ ok: true, alias: 'gpt-oss' });
      // Borrows the first member's concrete entry for display.
      if (resolved.ok) {
        expect(resolved.entry.aliases).toContain('groq-oss');
      }
    });

    it('passes concrete aliases through unchanged', () => {
      expect(
        resolveModelSelectionForWorkloadWithFamilies('opus', 'chat'),
      ).toMatchObject({ ok: true, alias: 'opus' });
    });

    it('accepts family aliases for job workloads (all members support jobs)', () => {
      expect(
        resolveModelSelectionForWorkloadWithFamilies('gpt-oss', 'one_time_job'),
      ).toMatchObject({ ok: true, alias: 'gpt-oss' });
      expect(
        resolveModelSelectionForWorkloadWithFamilies(
          'llama-70b',
          'recurring_job',
        ),
      ).toMatchObject({ ok: true, alias: 'llama-70b' });
    });

    it('accepts a family alias for memory when every member is memory-eligible', () => {
      // The seeded families' members are general instruct models, which now also
      // serve the memory workloads, so the all-members gate passes. (Memory model
      // selection itself reads concrete memory.llm.models.* aliases, not this
      // user-selection seam, so this only governs /model acceptance.)
      for (const workload of [
        'memory_extractor',
        'memory_dreaming',
        'memory_consolidation',
      ] as const) {
        expect(
          resolveModelSelectionForWorkloadWithFamilies('gpt-oss', workload),
        ).toMatchObject({ ok: true, alias: 'gpt-oss' });
        expect(
          resolveModelSelectionForWorkloadWithFamilies('llama-70b', workload),
        ).toMatchObject({ ok: true, alias: 'llama-70b' });
      }
    });
  });

  describe('effectiveFamilyMembers (settings order override)', () => {
    const gptOss = getModelFamily('gpt-oss')!;

    it('returns the hardcoded order with no override', () => {
      expect(effectiveFamilyMembers(gptOss)).toEqual(['groq-oss', 'cerebras']);
      expect(effectiveFamilyMembers(gptOss, {})).toEqual([
        'groq-oss',
        'cerebras',
      ]);
    });

    it('reorders members by override, accepting member alias or provider id', () => {
      // By member alias.
      expect(
        effectiveFamilyMembers(gptOss, { 'gpt-oss': ['cerebras', 'groq-oss'] }),
      ).toEqual(['cerebras', 'groq-oss']);
      // By provider id (cerebras provider == cerebras member; groq provider ==
      // groq-oss member).
      expect(
        effectiveFamilyMembers(gptOss, { 'gpt-oss': ['cerebras', 'groq'] }),
      ).toEqual(['cerebras', 'groq-oss']);
    });

    it('ignores unknown tokens and appends unnamed default members', () => {
      expect(
        effectiveFamilyMembers(gptOss, {
          'gpt-oss': ['nope', 'cerebras', 'also-unknown'],
        }),
      ).toEqual(['cerebras', 'groq-oss']);
    });

    it('honors the override in resolveModelFamilyAlias', () => {
      // Override puts cerebras first; both providers configured -> cerebras wins.
      expect(
        resolveModelFamilyAlias('gpt-oss', {
          ...configured(['groq', 'cerebras']),
          order: { 'gpt-oss': ['cerebras', 'groq-oss'] },
        }),
      ).toEqual({ alias: 'cerebras' });
    });

    it('cost-orders members with the cheapest token (cheapest configured wins)', () => {
      const llama = getModelFamily('llama-70b')!;
      // groq total price ($0.59+$0.79=$1.38) < together ($1.04+$1.04=$2.08), so
      // cheapest puts groq first regardless of any contrary declared/override
      // order. Contrast: an explicit declared order can place together first.
      expect(
        effectiveFamilyMembers(llama, { 'llama-70b': ['cheapest'] }),
      ).toEqual(['groq', 'together']);
      // Explicit order (no cheapest) is honored as-is: together first.
      expect(
        effectiveFamilyMembers(llama, { 'llama-70b': ['together', 'groq'] }),
      ).toEqual(['together', 'groq']);
      // With both providers configured, cheapest selects the lower-priced member
      // (groq) even though the explicit override above selected together.
      expect(
        resolveModelFamilyAlias('llama-70b', {
          ...configured(['groq', 'together']),
          order: { 'llama-70b': ['cheapest'] },
        }),
      ).toEqual({ alias: 'groq' });
      // Only the pricier provider configured -> cheapest still falls through to
      // the configured one.
      expect(
        resolveModelFamilyAlias('llama-70b', {
          ...configured(['together']),
          order: { 'llama-70b': ['cheapest'] },
        }),
      ).toEqual({ alias: 'together' });
    });

    it('sorts unpriced members last under the cheapest token', () => {
      // gpt-oss: groq-oss is priced ($0.15+$0.60), cerebras omits pricing, so
      // cheapest keeps groq-oss first and pushes the unpriced cerebras last.
      const gptOss = getModelFamily('gpt-oss')!;
      expect(
        effectiveFamilyMembers(gptOss, { 'gpt-oss': ['cheapest'] }),
      ).toEqual(['groq-oss', 'cerebras']);
    });

    it('honors the override in resolveModelSelectionForWorkloadWithFamilies display', () => {
      const resolved = resolveModelSelectionForWorkloadWithFamilies(
        'gpt-oss',
        'chat',
        { 'gpt-oss': ['cerebras', 'groq-oss'] },
      );
      expect(resolved).toMatchObject({ ok: true, alias: 'gpt-oss' });
      // Borrows the FIRST effective member (cerebras) for display.
      if (resolved.ok) expect(resolved.entry.aliases).toContain('cerebras');
    });
  });

  describe('describeFamilyResolution', () => {
    const gptOss = getModelFamily('gpt-oss')!;
    const labelFor = (id: string | undefined) => id ?? 'unknown';

    it('selects the first configured member and reports availability', () => {
      const description = describeFamilyResolution(gptOss, {
        isProviderConfigured: (id) => id === 'cerebras',
        providerLabel: labelFor,
      });
      expect(description.selectedMember).toBe('cerebras');
      expect(description.selectedProviderId).toBe('cerebras');
      expect(description.selectedConfigured).toBe(true);
      expect(description.members.map((m) => m.configured)).toEqual([
        false,
        true,
      ]);
    });

    it('falls back to the first effective member when none configured', () => {
      const description = describeFamilyResolution(gptOss, {
        isProviderConfigured: () => false,
        providerLabel: labelFor,
      });
      expect(description.selectedMember).toBe('groq-oss');
      expect(description.selectedConfigured).toBe(false);
    });
  });

  it('exposes isModelFamilyAlias for the runtime rewrite seam', () => {
    expect(isModelFamilyAlias('gpt-oss')).toBe(true);
    expect(isModelFamilyAlias('llama-70b')).toBe(true);
    expect(isModelFamilyAlias('opus')).toBe(false);
    expect(isModelFamilyAlias('')).toBe(false);
    expect(isModelFamilyAlias(undefined)).toBe(false);
  });
});
