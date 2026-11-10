export type ProviderBillingReason =
  | 'credits_exhausted'
  | 'spending_limit_reached'
  | 'billing_blocked';
export interface ProviderBillingFailure {
  readonly provider: string;
  readonly reason: ProviderBillingReason;
  readonly code: string;
}
export interface ProviderBillingContext {
  readonly provider: string;
  readonly credentialRef: string;
  readonly operation: string;
  readonly model?: string;
  readonly reference?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

// Inspect only provider error envelopes, never arbitrary model/tool output text.
export function classifyProviderBillingFailure(
  providerInput: string,
  input: unknown,
): ProviderBillingFailure | null {
  const provider = providerInput.toLowerCase().trim();
  let current: unknown = input;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 8 && current != null && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const outer = record(current);
    const error =
      typeof outer.error === 'string'
        ? { ...outer, message: outer.error }
        : Object.keys(record(outer.error)).length
          ? record(outer.error)
          : outer;
    const metadata = record(error.metadata);
    const status = Number(outer.status ?? outer.statusCode ?? error.code);
    const code = String(error.code ?? error.type ?? '').toLowerCase();
    const type = String(error.type ?? metadata.error_type ?? '').toLowerCase();
    const message =
      typeof error.message === 'string'
        ? error.message.slice(0, 8192).toLowerCase()
        : '';
    const result = (reason: ProviderBillingReason): ProviderBillingFailure => ({
      provider,
      reason,
      code: /^[a-z0-9_.-]{1,100}$/.test(code)
        ? code
        : String(Number.isFinite(status) ? status : 'billing_error'),
    });
    const insufficient =
      /(?:credit balance is too low|(?:prepayment |prepaid )?credits? (?:are |is )?(?:depleted|exhausted)|insufficient (?:account )?(?:credits?|balance)|no credits available)/.test(
        message,
      );
    const hardSpend =
      /(?:monthly spending cap|project spend cap|(?:organization|organisation|workspace|account|monthly|project|api key) (?:spend(?:ing)?|budget) (?:limit|cap)|spend limit (?:reached|exceeded))/.test(
        message,
      );
    if (
      provider === 'openrouter' &&
      metadata.limit_source === 'openrouter_in_flight_budget'
    )
      return null;
    if (provider === 'openai') {
      if (
        [
          'rate_limit_exceeded',
          'rate_limit_error',
          'slow_down',
          'organization_usage_limit_exceeded',
        ].includes(code)
      )
        return null;
      if (code === 'credit_balance_exhausted')
        return result('credits_exhausted');
      if (
        [
          'organization_spend_limit_exceeded',
          'project_spend_limit_exceeded',
        ].includes(code)
      )
        return result('spending_limit_reached');
      if (code === 'insufficient_quota' || type === 'insufficient_quota')
        return result(insufficient ? 'credits_exhausted' : 'billing_blocked');
    } else if (provider === 'anthropic') {
      if (insufficient) return result('credits_exhausted');
      if (hardSpend) return result('spending_limit_reached');
      if (code === 'billing_error' || type === 'billing_error')
        return result('billing_blocked');
    } else if (provider === 'gemini' || provider === 'google') {
      const billingDisabled =
        Array.isArray(error.details) &&
        error.details.some((value) =>
          [
            'BILLING_DISABLED',
            'BILLING_ACCOUNT_DISABLED',
            'BILLING_ACCOUNT_CLOSED',
          ].includes(String(record(value).reason)),
        );
      if (
        billingDisabled ||
        /billing account (?:has an? |has |with an? )outstanding balance/.test(
          message,
        )
      )
        return result('billing_blocked');
      if (
        status === 402 &&
        (code === '402' || code === 'payment_required' || insufficient)
      )
        return result('credits_exhausted');
      if (insufficient) return result('credits_exhausted');
    } else if (provider === 'sarvam') {
      if (
        code === 'insufficient_quota_error' ||
        type === 'insufficient_quota_error' ||
        insufficient
      )
        return result('credits_exhausted');
      if (code === 'seat_budget_exhausted_error')
        return result('spending_limit_reached');
    } else if (provider === 'openrouter') {
      if (
        [
          'openrouter_guardrail_budget',
          'openrouter_workspace_budget',
          'openrouter_key_limit',
        ].includes(String(metadata.limit_source))
      )
        return result('spending_limit_reached');
      if (
        status === 402 ||
        code === 'payment_required' ||
        type === 'payment_required' ||
        insufficient
      )
        return result('credits_exhausted');
    } else if (provider === 'firecrawl') {
      if (
        insufficient ||
        /(?:insufficient credits|credit limit (?:reached|exceeded)|not enough credits)/.test(
          message,
        )
      )
        return result('credits_exhausted');
      if (hardSpend) return result('spending_limit_reached');
    } else if (['vertex', 'azure', 'bedrock'].includes(provider)) {
      const reasons = Array.isArray(error.details)
        ? error.details.map((value) =>
            String(record(value).reason ?? '').toLowerCase(),
          )
        : [];
      if (
        [code, ...reasons].some((value) =>
          [
            'billing_disabled',
            'billing_account_disabled',
            'billing_account_closed',
            'invalid_payment_instrument',
          ].includes(value),
        ) ||
        message.includes('invalid_payment_instrument')
      )
        return result('billing_blocked');
      if (insufficient) return result('credits_exhausted');
      if (hardSpend) return result('spending_limit_reached');
    }
    // Some SDKs serialize their JSON error envelope into Error.message.
    const jsonStart = message.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(String(error.message).slice(jsonStart));
        current = parsed;
        continue;
      } catch {
        /* Keep the original failure when the SDK text is not JSON. */
      }
    }
    current = outer.cause ?? (outer.error !== current ? outer.error : null);
  }
  return null;
}
