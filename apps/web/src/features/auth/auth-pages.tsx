import { useEffect, useState } from 'react';

import { Button } from '../../ui/primitives/button';
import { AuthCard } from './auth-card';
import { GoogleSignInButton } from './google-sign-in-button';
import { requestLocalAuthorizationUrl } from '../../lib/auth/browser-auth';

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

export function LocalReauthorizationPage() {
  const [message, setMessage] = useState<string>();

  async function reauthorize() {
    setMessage(undefined);
    try {
      window.location.assign(await requestLocalAuthorizationUrl());
    } catch {
      setMessage(
        'Your local session has expired. Run `gantry ui authorize` to create a new authorization link.',
      );
    }
  }

  return (
    <AuthCard
      eyebrow="REAUTHORIZE BROWSER"
      signalTitle="Keep local access active."
      signalDescription="Create a new one-time local authorization link in this tab."
      signalMetadata="LOCAL CONSOLE · LOOPBACK ONLY"
      status={message ? 'attention' : 'shield'}
      title="Reauthorize this browser"
      description={
        message ??
        'Your current local session can authorize a new browser session.'
      }
      action={
        <Button
          className="auth-page-action w-full"
          onClick={() => void reauthorize()}
        >
          Reauthorize this browser
        </Button>
      }
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
