import { useEffect, useRef, useState } from 'react';

import { PageHeader } from '../../ui/compositions/page-header';
import { Button } from '../../ui/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/primitives/tabs';
import {
  HostedAuthenticationPanels,
  LocalAuthorizationPanel,
} from './authentication-access-panels';
import type {
  AccessGrant,
  BrowserSession,
  CandidateForm,
  Invitation,
} from './authentication-access-types';
import { BrowserSessionList } from './browser-session-list';
import { useAuthenticationAccessActions } from './use-authentication-access-actions';

export function AuthenticationAccessRoute() {
  const [accessState, setAccessState] = useState<
    'loading' | 'administrator' | 'viewer' | 'unavailable'
  >('loading');
  const [mode, setMode] = useState<'local' | 'hosted'>('local');
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'administrator' | 'viewer'>(
    'viewer',
  );
  const [invitationUrl, setInvitationUrl] = useState<string>();
  const [receipt, setReceipt] = useState<string>();
  const [configurationMessage, setConfigurationMessage] = useState<string>();
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false);
  const [candidate, setCandidate] = useState<CandidateForm>({
    issuer: '',
    clientId: '',
    clientSecretRef: '',
    companyDomain: '',
    providerLabel: 'Google',
  });
  const receiptRef = useRef<HTMLParagraphElement>(null);

  const reloadAccessData = async () => {
    const [grantsResponse, invitationsResponse, sessionsResponse] =
      await Promise.all([
        fetch('/ui/api/auth/access', { credentials: 'same-origin' }).catch(
          () => undefined,
        ),
        fetch('/ui/api/auth/invitations', {
          credentials: 'same-origin',
        }).catch(() => undefined),
        fetch('/ui/api/auth/sessions', { credentials: 'same-origin' }).catch(
          () => undefined,
        ),
      ]);
    if (grantsResponse?.ok) {
      const body = await grantsResponse.json();
      if (Array.isArray(body.grants)) setGrants(body.grants);
    }
    if (invitationsResponse?.ok) {
      const body = await invitationsResponse.json();
      if (Array.isArray(body.invitations)) setInvitations(body.invitations);
    }
    if (sessionsResponse?.ok) {
      const body = await sessionsResponse.json();
      if (Array.isArray(body.sessions)) setSessions(body.sessions);
      if (typeof body.currentSessionId === 'string')
        setCurrentSessionId(body.currentSessionId);
    }
  };

  useEffect(() => {
    void fetch('/ui/api/auth/config', { credentials: 'same-origin' })
      .then(async (response) => {
        if (response.status === 403) {
          setAccessState('viewer');
          await reloadAccessData();
          return;
        }
        if (!response.ok) {
          setAccessState('unavailable');
          return;
        }
        const body = await response.json();
        if (body.mode === 'local' || body.mode === 'hosted') setMode(body.mode);
        setAccessState('administrator');
        await reloadAccessData();
      })
      .catch(() => setAccessState('unavailable'));
  }, []);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (search.has('configuration-tested')) {
      setConfigurationMessage(
        'Sign-in configuration verified. Activate it for this deployment?',
      );
    }
    if (search.has('configuration-test-failed')) {
      setError(
        'Sign-in configuration could not be verified. The active configuration was not changed.',
      );
    }
  }, []);

  const showReceipt = (message: string) => {
    setReceipt(message);
    window.requestAnimationFrame(() => receiptRef.current?.focus());
  };
  const actions = useAuthenticationAccessActions({
    candidate,
    inviteEmail,
    inviteRole,
    reloadAccessData,
    setAuthorizationUrl,
    setConfigurationMessage,
    setError,
    setInvitationUrl,
    setReauthenticationRequired,
    setReceipt,
    showReceipt,
  });

  const content =
    accessState === 'administrator' ? (
      <Tabs
        className="mt-7"
        value={mode}
        onValueChange={(value) => setMode(value as typeof mode)}
      >
        <TabsList aria-label="Authentication mode">
          <TabsTrigger value="local">Local</TabsTrigger>
          <TabsTrigger value="hosted">Hosted</TabsTrigger>
        </TabsList>
        <TabsContent className="mt-5" value="local">
          <LocalAuthorizationPanel
            authorizationUrl={authorizationUrl}
            onAuthorize={() => void actions.authorizeBrowser()}
          />
        </TabsContent>
        <TabsContent className="mt-5" value="hosted">
          <HostedAuthenticationPanels
            candidate={candidate}
            configurationMessage={configurationMessage}
            currentSessionId={currentSessionId}
            grants={grants}
            invitationUrl={invitationUrl}
            invitations={invitations}
            inviteEmail={inviteEmail}
            inviteRole={inviteRole}
            onCandidateChange={(key, value) =>
              setCandidate((current) => ({ ...current, [key]: value }))
            }
            onConfigure={(action) => void actions.configureOidc(action)}
            onCreateInvitation={() => void actions.createInvitation()}
            onInviteEmailChange={setInviteEmail}
            onInviteRoleChange={setInviteRole}
            onRevokeInvitation={(id) => void actions.revokeInvitation(id)}
            onRevokeSession={(id) => void actions.revokeSession(id)}
            onSaveCandidate={() => void actions.saveCandidate()}
            onUpdateAccess={(id, change) =>
              void actions.updateAccess(id, change)
            }
            sessions={sessions}
          />
        </TabsContent>
      </Tabs>
    ) : (
      <UnavailableAccessPanel
        accessState={accessState}
        currentSessionId={currentSessionId}
        onRevoke={(id) => void actions.revokeSession(id)}
        sessions={sessions}
      />
    );

  return (
    <section
      aria-labelledby="authentication-access-title"
      className="mx-auto max-w-[960px]"
    >
      <PageHeader
        eyebrow="Settings"
        id="authentication-access-title"
        title="Authentication & Access"
      />
      {content}
      {error ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <p className="mt-4 text-sm text-text" ref={receiptRef} tabIndex={-1}>
          {receipt}
        </p>
      ) : null}
      {reauthenticationRequired ? (
        <Button
          className="mt-4"
          onClick={() => window.location.assign('/ui/auth/reauthenticate')}
          variant="outline"
        >
          Sign in again
        </Button>
      ) : null}
    </section>
  );
}

function UnavailableAccessPanel({
  accessState,
  currentSessionId,
  onRevoke,
  sessions,
}: {
  accessState: 'loading' | 'viewer' | 'unavailable';
  currentSessionId?: string;
  onRevoke: (id: string) => void;
  sessions: BrowserSession[];
}) {
  const message =
    accessState === 'viewer'
      ? 'Viewer access is read-only. Ask an Administrator to change Authentication & Access settings.'
      : accessState === 'unavailable'
        ? 'Authentication & Access is unavailable right now. Try again shortly.'
        : 'Loading Authentication & Access…';
  return (
    <>
      <Card className="mt-7">
        <CardHeader>
          <CardTitle>Console access</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
      </Card>
      {accessState === 'viewer' ? (
        <div className="mt-4">
          <BrowserSessionList
            currentSessionId={currentSessionId}
            onRevoke={onRevoke}
            sessions={sessions}
          />
        </div>
      ) : null}
    </>
  );
}
