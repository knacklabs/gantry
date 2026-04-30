export interface RuntimeLease {
  onLost?: (handler: (err: Error) => void) => void;
  release: () => Promise<void>;
}

export interface RuntimeLeasePort {
  tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}
