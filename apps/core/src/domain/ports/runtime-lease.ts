export interface RuntimeLease {
  /**
   * Durable ownership generation for this lease key: strictly increasing across
   * OWNERSHIP acquisitions and surviving process restarts. A shared acquisition
   * reports the current generation without advancing it. Required, not optional — an
   * optional generation lets a consumer receive `undefined`, fall back to 0 and
   * silently stop fencing, which is the failure this exists to remove.
   *
   * Only ever compare generations for the SAME lease key. It is a per-key
   * sequence, not a global clock, and it is unrelated to `run_leases`'
   * fencing_version (a run's reclaim epoch).
   */
  generation: number;
  isValid: () => boolean;
  onLost?: (handler: (err: Error) => void) => void;
  release: () => Promise<void>;
}

export interface RuntimeLeaseAcquireOptions {
  /**
   * SHARED acquisition: take the same advisory lock (so mutual exclusion is
   * unchanged) but do NOT advance the generation — read the current one.
   *
   * Use it for work that must not run concurrently with an owner but does not
   * itself constitute a new ownership epoch, such as taking a snapshot of the
   * bytes a previous owner produced. Bumping there would inflate the very
   * counter the snapshot is fenced against, and would hand a stale owner a
   * generation newer than the successor that displaced it.
   */
  shared?: boolean;
}

export interface RuntimeLeasePort {
  tryAcquire: (
    key: string,
    options?: RuntimeLeaseAcquireOptions,
  ) => Promise<RuntimeLease | undefined>;
}
