export function isSafeExecutionProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function assertSafeExecutionProviderId(value: string): void {
  if (!isSafeExecutionProviderId(value)) {
    throw new Error(`Invalid execution provider id: ${value}`);
  }
}
