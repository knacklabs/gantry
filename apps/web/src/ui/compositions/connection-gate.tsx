import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';

type ConnectionGateValue = {
  requestConnection: (action: string) => void;
};

const ConnectionGateContext = createContext<ConnectionGateValue | null>(null);

export function ConnectionGateProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const requestConnection = useCallback((nextAction: string) => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setAction(nextAction);
  }, []);

  const closeGate = useCallback(() => {
    setAction(undefined);
    queueMicrotask(() => returnFocusRef.current?.focus());
  }, []);

  const value = useMemo(() => ({ requestConnection }), [requestConnection]);

  return (
    <ConnectionGateContext value={value}>
      {children}
      <AlertDialog.Root
        open={action !== undefined}
        onOpenChange={(open) => {
          if (!open) closeGate();
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
            <AlertDialog.Title className="m-0 text-base font-semibold text-text">
              Connect Gantry to continue
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
              This action needs a live Gantry connection. API and access setup
              are not configured yet. Your local draft has not been submitted.
            </AlertDialog.Description>
            {action ? (
              <p className="mt-3 mb-0 font-mono text-[11px] text-text-muted">
                Pending: {action}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <AlertDialog.Cancel asChild>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-md border border-ink bg-ink px-4 text-sm font-semibold text-ink-on hover:bg-ink-hover"
                  type="button"
                >
                  Close
                </button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConnectionGateContext>
  );
}

export function useConnectionGate() {
  const value = use(ConnectionGateContext);

  if (!value) {
    throw new Error(
      'useConnectionGate must be used inside ConnectionGateProvider',
    );
  }

  return value;
}
