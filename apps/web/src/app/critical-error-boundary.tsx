import type { ErrorComponentProps } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode, useEffect, useRef } from 'react';

import { GantryMark } from '../ui/compositions/gantry-logo';
import { Button, buttonVariants } from '../ui/primitives/button';

const overviewHref = `${import.meta.env.BASE_URL}overview`;

type RecoveryPanelProps = {
  copy: string;
  eyebrow: string;
  heading: string;
  reloadLabel: string;
  onReload: () => void;
};

function RecoveryPanel({
  copy,
  eyebrow,
  heading,
  reloadLabel,
  onReload,
}: RecoveryPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby="critical-error-heading"
      className="w-full max-w-[390px] rounded-lg border border-border-strong bg-surface p-6 shadow-lift sm:p-7"
      role="alert"
    >
      <p className="m-0 font-mono text-micro font-medium tracking-[0.18em] text-danger uppercase">
        {eyebrow}
      </p>
      <span
        aria-hidden="true"
        className="mt-4 mb-5 grid size-10 place-items-center rounded-lg border border-danger/40 bg-danger-soft text-danger"
      >
        <TriangleAlert size={19} strokeWidth={1.8} />
      </span>
      <h1
        className="m-0 font-display text-heading font-semibold tracking-[-0.035em] text-text outline-none"
        id="critical-error-heading"
        ref={headingRef}
        tabIndex={-1}
      >
        {heading}
      </h1>
      <p className="mt-2 mb-5 text-sm leading-6 text-text-secondary">{copy}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="min-h-9" onClick={onReload} type="button">
          {reloadLabel}
        </Button>
        <a
          className={buttonVariants({
            className: 'min-h-9 no-underline',
            variant: 'outline',
          })}
          href={overviewHref}
        >
          Back to Overview
        </a>
      </div>
    </section>
  );
}

export class CriticalErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-canvas px-4 py-24 text-text sm:px-6">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[-160px] left-[-120px] size-[520px] rounded-full bg-[radial-gradient(circle,rgb(95_174_140_/_16%),transparent_65%)]"
        />
        <div className="absolute top-5 left-5 flex items-center gap-2.5 font-display text-sm font-semibold sm:top-7 sm:left-7">
          <GantryMark className="size-6 text-text" />
          <span>Gantry</span>
        </div>
        <RecoveryPanel
          copy="Reload the console to restore the current view. If the problem continues, return to Overview."
          eyebrow="System interruption"
          heading="Gantry stopped unexpectedly"
          reloadLabel="Reload console"
          onReload={() => window.location.reload()}
        />
      </div>
    );
  }
}

export function RouteErrorPage({ reset }: ErrorComponentProps) {
  return (
    <div className="grid min-h-[calc(100dvh-98px)] place-items-center py-8">
      <RecoveryPanel
        copy="Try loading it again or return to Overview."
        eyebrow="View unavailable"
        heading="This view could not load"
        reloadLabel="Reload view"
        onReload={reset}
      />
    </div>
  );
}
