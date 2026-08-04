/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export declare function isValidTimezone(tz: string): boolean;
/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export declare function resolveTimezone(tz: string): string;
/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export declare function formatLocalTime(utcIso: string, timezone: string): string;
