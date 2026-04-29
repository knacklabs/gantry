export interface RuntimeLease {
  release: () => Promise<void>;
}

export interface RuntimeLeasePort {
  tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}
