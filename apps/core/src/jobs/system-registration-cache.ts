const signatures = new WeakMap<object, string>();

export function getSystemJobRegistrationSignature(
  opsRepository: object,
): string | undefined {
  return signatures.get(opsRepository);
}

export function setSystemJobRegistrationSignature(
  opsRepository: object,
  signature: string,
): void {
  signatures.set(opsRepository, signature);
}

export function invalidateSystemJobRegistrationSignature(
  opsRepository: object,
): void {
  signatures.delete(opsRepository);
}
