import { createContext, type ReactNode, use, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../primitives/alert-dialog';
import { Button } from '../primitives/button';

type ConnectionGateValue = {
  requestConnection: (action: string) => void;
};

const ConnectionGateContext = createContext<ConnectionGateValue | null>(null);

export function ConnectionGateProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function requestConnection(nextAction: string) {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setAction(nextAction);
  }

  function closeGate() {
    setAction(undefined);
    queueMicrotask(() => returnFocusRef.current?.focus());
  }

  return (
    <ConnectionGateContext value={{ requestConnection }}>
      {children}
      <AlertDialog
        open={action !== undefined}
        onOpenChange={(open) => {
          if (!open) closeGate();
        }}
      >
        <AlertDialogContent className="w-[min(440px,calc(100vw-32px))] border border-border-strong bg-surface p-5 shadow-popover">
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="m-0 text-base font-semibold text-text">
              Connect Gantry to continue
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
              This action needs a live Gantry connection. API and access setup
              are not configured yet. Your local draft has not been submitted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {action ? (
            <p className="mt-3 mb-0 font-mono text-[11px] text-text-muted">
              Pending: {action}
            </p>
          ) : null}
          <AlertDialogFooter className="mt-1">
            <Button onClick={closeGate}>Close</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
