import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '../primitives/alert';
import { Button } from '../primitives/button';

type ConnectionGateValue = {
  requestConnection: (action: string) => void;
};

const ConnectionGateContext = createContext<ConnectionGateValue | null>(null);

export function ConnectionGateProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string>();

  const requestConnection = useCallback((nextAction: string) => {
    setAction(nextAction);
  }, []);

  const closeGate = useCallback(() => {
    setAction(undefined);
  }, []);

  const value = useMemo(() => ({ requestConnection }), [requestConnection]);

  return (
    <ConnectionGateContext value={value}>
      {children}
      {action ? (
        <Alert className="fixed right-6 bottom-6 z-50 w-[min(440px,calc(100vw-48px))] border-border-strong bg-surface p-5 shadow-popover">
          <AlertTitle className="m-0 text-base font-semibold text-text">
            Connect Gantry to continue
          </AlertTitle>
          <AlertDescription className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
            This action needs a live Gantry connection. API and access setup are
            not configured yet. Your local draft has not been submitted.
          </AlertDescription>
          <p className="mt-3 mb-0 font-mono text-[11px] text-text-muted">
            Pending: {action}
          </p>
          <AlertAction>
            <Button onClick={closeGate}>Close</Button>
          </AlertAction>
        </Alert>
      ) : null}
    </ConnectionGateContext>
  );
}

export function useConnectionGate() {
  const value = useContext(ConnectionGateContext);

  if (!value) {
    throw new Error(
      'useConnectionGate must be used inside ConnectionGateProvider',
    );
  }

  return value;
}
