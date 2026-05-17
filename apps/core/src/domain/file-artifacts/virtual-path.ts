const VIRTUAL_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VIRTUAL_PATH_SEGMENT_RE = /^[A-Za-z0-9.][A-Za-z0-9._-]{0,127}$/;

export function normalizeFileArtifactScope(value: string | undefined): string {
  const scope = (value ?? 'default').trim();
  if (!VIRTUAL_SCOPE_RE.test(scope)) {
    throw new Error(
      'File artifact scope must use only letters, numbers, dot, underscore, or dash and must start with a letter or number.',
    );
  }
  return scope;
}

export function normalizeFileArtifactPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        !VIRTUAL_PATH_SEGMENT_RE.test(part),
    )
  ) {
    throw new Error(
      'File artifact path must be a safe relative virtual path without empty, dot, dot-dot, absolute, or drive segments.',
    );
  }
  return parts.join('/');
}
