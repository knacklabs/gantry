import { type ReactNode } from 'react';
import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import { Separator } from '../../ui/primitives/separator';
import { GantryMark } from '../../ui/compositions/gantry-mark';

type AuthCardProps = {
  eyebrow: string;
  signalTitle: string;
  signalDescription: string;
  signalMetadata: string;
  status?: 'success' | 'attention' | 'shield' | 'loading';
  title: string;
  description?: string;
  action?: ReactNode;
};

export function AuthCard({
  eyebrow,
  signalTitle,
  signalDescription,
  signalMetadata,
  status,
  title,
  description,
  action,
}: AuthCardProps) {
  const StatusIcon =
    status === 'success'
      ? CircleCheck
      : status === 'attention'
        ? CircleAlert
        : status === 'shield'
          ? ShieldCheck
          : null;
  return (
    <main className="auth-page-shell">
      <a className="auth-page-skip-link" href="#auth-content">
        Skip to authentication content
      </a>
      <aside className="auth-page-signal" aria-label="Gantry console access">
        <div className="auth-page-brand">
          <GantryMark className="size-7 text-[#c0985f]" />
          <span>GANTRY</span>
        </div>
        <div className="auth-page-signal-copy">
          <h1>{signalTitle}</h1>
          <p>{signalDescription}</p>
        </div>
        <p className="auth-page-metadata">{signalMetadata}</p>
      </aside>
      <section className="auth-page-panel" id="auth-content">
        <Card className="auth-page-card !overflow-visible !rounded-none !ring-0">
          <CardHeader>
            <p className="auth-page-eyebrow">{eyebrow}</p>
            {status === 'loading' ? (
              <span className="auth-page-loader" aria-hidden="true" />
            ) : StatusIcon ? (
              <span
                className={
                  status === 'success'
                    ? 'auth-page-status auth-page-status-success'
                    : 'auth-page-status auth-page-status-attention'
                }
              >
                <StatusIcon aria-hidden="true" />
              </span>
            ) : null}
            <CardTitle className="auth-page-title">{title}</CardTitle>
            {description ? (
              <CardDescription
                aria-live="polite"
                className="auth-page-description"
              >
                {description}
              </CardDescription>
            ) : null}
          </CardHeader>
          {action ? (
            <CardContent>
              <Separator className="mb-5" />
              {action}
            </CardContent>
          ) : null}
        </Card>
      </section>
    </main>
  );
}
