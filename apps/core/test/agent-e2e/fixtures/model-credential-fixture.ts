export function requireRealModelCredential():
  | { credential: string }
  | { skipReason: string } {
  const credential = process.env.E2E_MODEL_API_KEY?.trim();
  return credential
    ? { credential }
    : { skipReason: 'E2E_MODEL_API_KEY not set' };
}
