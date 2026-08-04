const signatures = new WeakMap();
export function getSystemJobRegistrationSignature(opsRepository) {
    return signatures.get(opsRepository);
}
export function setSystemJobRegistrationSignature(opsRepository, signature) {
    signatures.set(opsRepository, signature);
}
export function invalidateSystemJobRegistrationSignature(opsRepository) {
    signatures.delete(opsRepository);
}
