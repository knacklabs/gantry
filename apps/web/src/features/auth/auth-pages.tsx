import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react';

import { Button } from '../../ui/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import { Separator } from '../../ui/primitives/separator';

const GOOGLE_SIGN_IN_BUTTON_ASSET =
  'data:image/png;base64,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';

export function LocalAuthorizationPage() {
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      'token',
    );
    if (!token) {
      setMessage(
        'This authorization link has expired. Run `gantry ui authorize` to create a new one.',
      );
      return;
    }
    history.replaceState(null, '', window.location.pathname);
    void fetch('/auth/local/authorize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((response) => {
        if (response.ok) {
          setMessage('This browser is authorized.');
          window.setTimeout(() => window.location.replace('/ui'), 600);
          return;
        }
        return response.json().then((body) => setMessage(body.error?.message));
      })
      .catch(() =>
        setMessage(
          'This authorization link has expired. Run `gantry ui authorize` to create a new one.',
        ),
      );
  }, []);
  return (
    <AuthCard
      eyebrow="AUTHORIZE BROWSER"
      signalTitle="Secure local access."
      signalDescription="Authorize this browser to access the local Gantry console."
      signalMetadata="LOCAL CONSOLE · LOOPBACK ONLY"
      status={
        message
          ? message === 'This browser is authorized.'
            ? 'success'
            : 'attention'
          : 'loading'
      }
      title="Authorize browser"
      description={message ?? 'Authorizing this browser…'}
    />
  );
}

export function HostedSignInPage() {
  return (
    <AuthCard
      eyebrow="CONSOLE ACCESS"
      signalTitle="Secure console access."
      signalDescription="Sign in through your organization’s identity provider to access the Gantry console."
      signalMetadata="SECURE SIGN-IN · PROTECTED SESSION"
      title="Welcome back"
      description="Sign in to access the Gantry console."
      action={<GoogleSignInButton />}
    />
  );
}

export function AuthLoadingPage() {
  return (
    <AuthCard
      eyebrow="VERIFYING SESSION"
      signalTitle="Verifying your access."
      signalDescription="We’re verifying your session before opening the console."
      signalMetadata="SECURE SESSION CHECK"
      status="loading"
      title="Preparing your console"
      description="Checking your session. This should only take a moment."
      action={
        <p className="auth-page-loading-status">
          <span aria-hidden="true" />
          Secure session check
        </p>
      }
    />
  );
}

export function NoAccessPage({ disabled = false }: { disabled?: boolean }) {
  const params = new URLSearchParams(window.location.search);
  const mismatch = params.get('reason') === 'invitation-email-mismatch';
  const invitationExpired = params.get('reason') === 'invitation-expired';
  const invitationUsed = params.get('reason') === 'invitation-used';
  const reference = params.get('reference');
  return (
    <AuthCard
      eyebrow={disabled ? 'ACCESS DISABLED' : 'ACCESS REQUIRED'}
      signalTitle={disabled ? 'Access unavailable.' : 'Access is managed.'}
      signalDescription={
        disabled
          ? 'An administrator has disabled access to this console.'
          : 'Console access is managed by your organization.'
      }
      signalMetadata="SECURE SIGN-IN · IDENTITY VERIFIED"
      status="attention"
      title={
        disabled
          ? 'Your Gantry console access has been disabled.'
          : 'You do not have access to this Gantry console.'
      }
      description={
        disabled
          ? undefined
          : mismatch
            ? 'Sign in with the email address that was invited.'
            : invitationUsed
              ? 'This invitation has already been used.'
              : invitationExpired
                ? 'This invitation has expired. Ask an administrator for a new one.'
                : 'Ask a Gantry administrator to invite or approve your account.'
      }
      action={
        <div className="grid gap-3">
          {reference ? (
            <p className="auth-page-reference">Access reference: {reference}</p>
          ) : null}
          <Button
            className="auth-page-action w-full"
            onClick={() => window.location.assign('/auth/oidc/start')}
          >
            Try again
          </Button>
        </div>
      }
    />
  );
}

export function CallbackFailurePage() {
  return (
    <AuthCard
      eyebrow="SIGN-IN INTERRUPTED"
      signalTitle="Try again securely."
      signalDescription="Start a new sign-in session to continue."
      signalMetadata="SECURE SIGN-IN · NEW SESSION"
      status="attention"
      title="Sign in"
      description="Sign-in could not be completed. Start again from Gantry."
      action={
        <Button
          className="auth-page-action w-full"
          onClick={() => window.location.assign('/ui/auth/sign-in')}
        >
          Try again
        </Button>
      }
    />
  );
}

export function ReauthenticationPage() {
  return (
    <AuthCard
      eyebrow="REAUTHENTICATION"
      signalTitle="Confirm your identity."
      signalDescription="For your security, sign in again before making this change."
      signalMetadata="SECURE IDENTITY CHECK"
      status="shield"
      title="Sign in again"
      description="Sign in again to continue."
      action={
        <Button
          className="auth-page-action w-full"
          onClick={() => window.location.assign('/auth/oidc/reauth')}
        >
          Sign in again
        </Button>
      }
    />
  );
}

export function HostedSetupPage() {
  return (
    <AuthCard
      eyebrow="HOSTED SIGN-IN SETUP"
      signalTitle="Configure secure sign-in."
      signalDescription="Test your sign-in configuration before activating it for the console."
      signalMetadata="SIGN-IN CONFIGURATION"
      status="shield"
      title="Hosted sign-in setup"
      description="An Administrator can test and activate a candidate sign-in configuration."
      action={
        <Button
          className="auth-page-action w-full"
          onClick={() =>
            window.location.assign('/ui/settings/authentication-access')
          }
        >
          Test sign-in configuration
        </Button>
      }
    />
  );
}

export function InvitationPage() {
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      'token',
    );
    if (!token) {
      setMessage(
        'This invitation has expired. Ask an administrator for a new one.',
      );
      return;
    }
    history.replaceState(null, '', window.location.pathname);
    void fetch('/auth/invitations/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (response.ok && typeof body.redirectUrl === 'string') {
          window.location.assign(body.redirectUrl);
          return;
        }
        setMessage(body.error?.message);
      })
      .catch(() =>
        setMessage(
          'This invitation has expired. Ask an administrator for a new one.',
        ),
      );
  }, []);
  return (
    <AuthCard
      eyebrow="INVITATION"
      signalTitle="You’ve been invited."
      signalDescription="Sign in with the invited account to continue."
      signalMetadata="SECURE IDENTITY CHECK"
      status={message ? 'attention' : 'loading'}
      title="Invitation"
      description={message ?? 'Preparing sign-in…'}
    />
  );
}

function GoogleSignInButton() {
  return (
    <Button
      aria-label="Sign in with Google"
      className="auth-google-sign-in-button"
      onClick={() => window.location.assign('/auth/oidc/start')}
    >
      <img alt="" src={GOOGLE_SIGN_IN_BUTTON_ASSET} />
    </Button>
  );
}

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

function AuthCard({
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
          <span className="auth-page-mark" aria-hidden="true">
            G
          </span>
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
