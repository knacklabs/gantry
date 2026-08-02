// In-process serialization of edits to a SINGLE observer digest message. Two
// near-simultaneous owner clicks each snapshot the digest and then edit the
// provider message; if the edit carrying the older snapshot lands last it
// resurrects a settled insight's buttons (durable state is fine, but the shown
// message is stale + falsely actionable). Chaining per message key forces the
// later click to run — and rebuild — only after the earlier one has committed.
//
// ponytail: in-process lock, so it only serializes clicks handled by the same
// runtime instance. The upgrade path for multi-instance deployments is a durable
// per-message revision guard (compare-and-set on the reservation) across the
// channel edit paths.
const chains = new Map<string, Promise<unknown>>();

export function withObserverDigestEditLock<T>(
  messageKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = chains.get(messageKey) ?? Promise.resolve();
  // Run fn after the prior holder settles (success OR failure — a failed edit
  // must not wedge the chain).
  const run = prior.then(
    () => fn(),
    () => fn(),
  );
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  // Drop the map entry once this is the last edit in flight, so keys don't leak.
  const cleaned = tail.then(() => {
    if (chains.get(messageKey) === cleaned) chains.delete(messageKey);
  });
  chains.set(messageKey, cleaned);
  return run;
}
