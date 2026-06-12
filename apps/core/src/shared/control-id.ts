const CONTROL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidControlId(value: string): boolean {
  return CONTROL_ID_PATTERN.test(value);
}
