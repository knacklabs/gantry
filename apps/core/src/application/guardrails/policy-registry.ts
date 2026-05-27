import { bssCustomerSupportPolicy } from './policies/bss-customer-support.js';
import type { GuardrailPolicy } from './types.js';

const REGISTERED_GUARDRAIL_POLICIES: readonly GuardrailPolicy[] = [
  bssCustomerSupportPolicy,
];

const GUARDRAIL_POLICIES_BY_ID = new Map(
  REGISTERED_GUARDRAIL_POLICIES.map((policy) => [policy.id, policy]),
);

export function getGuardrailPolicy(
  policyId: string,
): GuardrailPolicy | undefined {
  return GUARDRAIL_POLICIES_BY_ID.get(policyId);
}

export function isRegisteredGuardrailPolicy(policyId: string): boolean {
  return GUARDRAIL_POLICIES_BY_ID.has(policyId);
}

export function registeredGuardrailPolicyIds(): string[] {
  return [...GUARDRAIL_POLICIES_BY_ID.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function guardrailPolicySettingsValidator(): {
  isRegistered(policyId: string): boolean;
  registeredIds(): readonly string[];
} {
  return {
    isRegistered: isRegisteredGuardrailPolicy,
    registeredIds: registeredGuardrailPolicyIds,
  };
}
