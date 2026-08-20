import { useEffect, useRef, useState } from 'react';

import { PageHeader } from '../../ui/compositions/page-header';
import { SelectField } from '../../ui/compositions/select-field';
import { Button } from '../../ui/primitives/button';
import {
  Card,
  CardContent,
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
import { Input } from '../../ui/primitives/input';

type AccessGrant = {
  id: string;
  displayName?: string | null;
  role: 'administrator' | 'viewer';
  status: 'awaiting_approval' | 'active' | 'disabled';
  updatedAt: string;
};

type BrowserSession = {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string | null;
};

type Invitation = {
  id: string;
  invitedEmail: string;
  role: 'administrator' | 'viewer';
  expiresAt: string;
};

type CandidateForm = {
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  companyDomain: string;
  providerLabel: string;
};

function BrowserSessionList({
  currentSessionId,
  onRevoke,
  sessions,
}: {
  currentSessionId?: string;
  onRevoke: (sessionId: string) => void;
  sessions: BrowserSession[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser sessions</CardTitle>
        <CardDescription>
          Sessions are revocable and checked against current access on every
          request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {sessions.map((session) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
              key={session.id}
            >
              <span>
                {session.id === currentSessionId
                  ? 'This browser'
                  : 'Browser session'}{' '}
                · Created {new Date(session.createdAt).toLocaleString()} · Last
                active {new Date(session.lastActiveAt).toLocaleString()} ·
                Expires {new Date(session.absoluteExpiresAt).toLocaleString()} ·{' '}
                {session.revokedAt ? 'Revoked' : 'Active'}
              </span>
              <Button
                disabled={Boolean(session.revokedAt)}
                onClick={() => onRevoke(session.id)}
                size="sm"
                variant="outline"
              >
                {session.revokedAt ? 'Revoked' : 'Revoke'}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find(
      (entry) =>
        entry.startsWith('gantry_csrf=') ||
        entry.startsWith('__Host-gantry-csrf='),
    )
    ?.split('=')
    .slice(1)
    .join('=');
}

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

  const authorizeBrowser = async () => {
    setError(undefined);
    const token = csrfToken();
    const response = await fetch('/ui/api/auth/local/authorize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { 'x-csrf-token': token } : {},
    });
    const body = await response.json();
    if (!response.ok || typeof body.authorizationUrl !== 'string') {
      setError(
        body.error?.message ?? 'Unable to create an authorization link.',
      );
      return;
    }
    setAuthorizationUrl(body.authorizationUrl);
  };

  const createInvitation = async () => {
    setError(undefined);
    setReceipt(undefined);
    const token = csrfToken();
    const response = await fetch('/ui/api/auth/invitations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.invitationUrl !== 'string') {
      setError(body.error?.message ?? 'Unable to create an invitation.');
      return;
    }
    setInvitationUrl(body.invitationUrl);
    showReceipt(body.message);
    await reloadAccessData();
  };

  const revokeInvitation = async (invitationId: string) => {
    setError(undefined);
    const token = csrfToken();
    const response = await fetch(`/ui/api/auth/invitations/${invitationId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: token ? { 'x-csrf-token': token } : {},
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error?.message ?? 'Unable to revoke this invitation.');
      return;
    }
    showReceipt(body.message);
    await reloadAccessData();
  };

  const configureOidc = async (action: 'test' | 'activate') => {
    setError(undefined);
    const token = csrfToken();
    const response = await fetch(`/ui/api/auth/config/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { 'x-csrf-token': token } : {},
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      setError(
        body.error?.message ?? 'Unable to update sign-in configuration.',
      );
      return;
    }
    if (typeof body.redirectUrl === 'string') {
      window.location.assign(body.redirectUrl);
      return;
    }
    setConfigurationMessage(body.message);
  };

  const saveCandidate = async () => {
    setError(undefined);
    const token = csrfToken();
    const response = await fetch('/ui/api/auth/config/candidate', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: JSON.stringify(candidate),
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      setError(body.error?.message ?? 'Unable to save sign-in configuration.');
      return;
    }
    setConfigurationMessage(body.message);
  };

  const updateAccess = async (
    grantId: string,
    change: Partial<Pick<AccessGrant, 'role' | 'status'>>,
  ) => {
    setError(undefined);
    setReauthenticationRequired(false);
    const token = csrfToken();
    const response = await fetch(`/ui/api/auth/access/${grantId}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: JSON.stringify(change),
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      setError(body.error?.message ?? 'Unable to update console access.');
      return;
    }
    showReceipt(body.message);
    await reloadAccessData();
  };

  const revokeSession = async (sessionId: string) => {
    setError(undefined);
    const token = csrfToken();
    const response = await fetch(`/ui/api/auth/sessions/${sessionId}/revoke`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { 'x-csrf-token': token } : {},
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error?.message ?? 'Unable to revoke this browser session.');
      return;
    }
    showReceipt(body.message);
    await reloadAccessData();
  };

  if (accessState !== 'administrator') {
    const message =
      accessState === 'viewer'
        ? 'Viewer access is read-only. Ask an Administrator to change Authentication & Access settings.'
        : accessState === 'unavailable'
          ? 'Authentication & Access is unavailable right now. Try again shortly.'
          : 'Loading Authentication & Access…';
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
              onRevoke={(sessionId) => void revokeSession(sessionId)}
              sessions={sessions}
            />
          </div>
        ) : null}
      </section>
    );
  }

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
          <Card>
            <CardHeader>
              <CardTitle>Authorize a browser</CardTitle>
              <CardDescription>
                Create a one-time authorization link for this Gantry host. Links
                expire after 10 minutes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                <Button onClick={() => void authorizeBrowser()}>
                  Authorize browser
                </Button>
                {authorizationUrl ? (
                  <code className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs text-text">
                    {authorizationUrl}
                  </code>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent className="mt-5" value="hosted">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Sign-in</CardTitle>
                <CardDescription>
                  Google is configured first. Client secrets remain server-side.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ['issuer', 'Issuer URL'],
                        ['clientId', 'Client ID'],
                        ['clientSecretRef', 'Client-secret reference'],
                        ['companyDomain', 'Company domain'],
                        ['providerLabel', 'Provider label'],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        className="grid gap-1.5 text-sm text-text"
                        key={key}
                      >
                        {label}
                        <Input
                          onChange={(event) =>
                            setCandidate((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }))
                          }
                          value={candidate[key]}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void saveCandidate()}
                    >
                      Save candidate
                    </Button>
                    <Button onClick={() => void configureOidc('test')}>
                      Test sign-in configuration
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void configureOidc('activate')}
                    >
                      Activate configuration
                    </Button>
                  </div>
                  {configurationMessage ? (
                    <p className="text-sm text-text">{configurationMessage}</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Console access</CardTitle>
                <CardDescription>
                  Administrators can invite people or approve verified
                  identities. Viewer is the default role.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid max-w-md gap-3">
                  <label
                    className="grid gap-1.5 text-sm text-text"
                    htmlFor="invite-email"
                  >
                    Verified email
                    <Input
                      id="invite-email"
                      type="email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </label>
                  <SelectField
                    label="Role"
                    onValueChange={setInviteRole}
                    options={[
                      { label: 'Viewer', value: 'viewer' },
                      { label: 'Administrator', value: 'administrator' },
                    ]}
                    value={inviteRole}
                  />
                  <Button onClick={() => void createInvitation()}>
                    Create invitation
                  </Button>
                  {invitationUrl ? (
                    <code className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs text-text">
                      {invitationUrl}
                    </code>
                  ) : null}
                </div>
                <div className="mt-6 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Pending invitations</caption>
                    <thead className="text-text-secondary">
                      <tr>
                        <th className="p-2">Email</th>
                        <th className="p-2">Role</th>
                        <th className="p-2">Expires</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invitations.map((invitation) => (
                        <tr
                          className="border-t border-border"
                          key={invitation.id}
                        >
                          <td className="p-2">{invitation.invitedEmail}</td>
                          <td className="p-2 capitalize">{invitation.role}</td>
                          <td className="p-2">
                            {new Date(invitation.expiresAt).toLocaleString()}
                          </td>
                          <td className="p-2">
                            <Button
                              onClick={() =>
                                void revokeInvitation(invitation.id)
                              }
                              size="sm"
                              variant="outline"
                            >
                              Revoke
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-6 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Console access grants</caption>
                    <thead className="text-text-secondary">
                      <tr>
                        <th className="p-2">Person</th>
                        <th className="p-2">Role</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.map((grant) => (
                        <tr className="border-t border-border" key={grant.id}>
                          <td className="p-2">
                            {grant.displayName ?? 'Unknown person'}
                          </td>
                          <td className="p-2 capitalize">{grant.role}</td>
                          <td className="p-2 capitalize">
                            {grant.status.replace('_', ' ')}
                          </td>
                          <td className="p-2">
                            <div className="flex flex-wrap gap-2">
                              <Button
                                onClick={() =>
                                  void updateAccess(grant.id, {
                                    role:
                                      grant.role === 'administrator'
                                        ? 'viewer'
                                        : 'administrator',
                                  })
                                }
                                size="sm"
                                variant="outline"
                              >
                                Make{' '}
                                {grant.role === 'administrator'
                                  ? 'Viewer'
                                  : 'Administrator'}
                              </Button>
                              <Button
                                onClick={() =>
                                  void updateAccess(grant.id, {
                                    status:
                                      grant.status === 'disabled'
                                        ? 'active'
                                        : 'disabled',
                                  })
                                }
                                size="sm"
                                variant="outline"
                              >
                                {grant.status === 'disabled'
                                  ? 'Restore'
                                  : 'Disable'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
            <BrowserSessionList
              currentSessionId={currentSessionId}
              onRevoke={(sessionId) => void revokeSession(sessionId)}
              sessions={sessions}
            />
          </div>
        </TabsContent>
      </Tabs>
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
