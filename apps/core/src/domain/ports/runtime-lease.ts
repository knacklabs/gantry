export interface RuntimeLease {
  /**
   * Durable ownership generation for this lease key: strictly increasing across
   * acquisitions and surviving process restarts. Required, not optional — an
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

export interface RuntimeLeasePort {
  tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}
