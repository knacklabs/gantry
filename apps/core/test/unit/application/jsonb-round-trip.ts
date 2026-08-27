/** Mimics PostgreSQL JSONB's normalized object-key order in memory tests. */
export function jsonbRoundTrip<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, candidate) => {
      if (
        candidate === null ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        Object.getPrototypeOf(candidate) !== Object.prototype
      ) {
        return candidate;
      }
      return Object.fromEntries(
        Object.keys(candidate)
          .sort(
            (left, right) =>
              left.length - right.length ||
              Buffer.compare(Buffer.from(left), Buffer.from(right)),
          )
          .map((key) => [key, candidate[key]]),
      );
    }),
  ) as T;
}
