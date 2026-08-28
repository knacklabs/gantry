import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleOff, LoaderCircle } from 'lucide-react';

import { browserFetch } from '../../lib/auth/browser-auth';

export type RuntimeConnectionState = 'checking' | 'connected' | 'unavailable';

type RuntimeStatus = {
  status: 'connected';
  processRole: string;
};

export function useRuntimeConnection() {
  return useQuery({
    queryKey: ['runtime-connection'],
    queryFn: async (): Promise<RuntimeStatus> => {
      const response = await browserFetch('/ui/api/runtime-status', {
        credentials: 'same-origin',
      });
      const status = (await response
        .json()
        .catch(() => null)) as RuntimeStatus | null;
      if (!status || status.status !== 'connected') {
        throw new Error('Runtime status could not be read.');
      }
      return status;
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export function ConnectionState({ state }: { state: RuntimeConnectionState }) {
  const display = {
    checking: {
      Icon: LoaderCircle,
      label: 'Checking runtime…',
      className: 'text-text-secondary animate-spin',
    },
    connected: {
      Icon: CircleCheck,
      label: 'Runtime connected',
      className: 'text-status-success',
    },
    unavailable: {
      Icon: CircleOff,
      label: 'Runtime unavailable',
      className: 'text-danger',
    },
  }[state];

  return (
    <span
      aria-label={`Runtime connection: ${display.label}`}
      aria-live="polite"
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium text-text-secondary"
    >
      <display.Icon
        className={`shrink-0 ${display.className}`}
        size={14}
        aria-hidden="true"
      />
      <span className="max-[420px]:sr-only">{display.label}</span>
    </span>
  );
}
