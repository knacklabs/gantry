export interface RuntimeLease {
  isValid: () => boolean;
  onLost?: (handler: (err: Error) => void) => void;
  release: () => Promise<void>;
}

export interface RuntimeLeasePort {
  tryAcquire: (key: string) => Promise<RuntimeLease | undefined>;
}
