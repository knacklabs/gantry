import { Button } from '../../ui/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import { Input } from '../../ui/primitives/input';
import { BrowserSessionList } from './browser-session-list';
import { ConsoleAccessPanel } from './console-access-panel';
import type {
  AccessGrant,
  BrowserSession,
  CandidateForm,
  Invitation,
} from './authentication-access-types';

export function LocalAuthorizationPanel({
  authorizationUrl,
  onAuthorize,
}: {
  authorizationUrl?: string;
  onAuthorize: () => void;
}) {
  return (
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
          <Button onClick={onAuthorize}>Authorize browser</Button>
          {authorizationUrl ? (
            <code className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs text-text">
              {authorizationUrl}
            </code>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type HostedAuthenticationPanelsProps = {
  candidate: CandidateForm;
  configurationMessage?: string;
  currentSessionId?: string;
  grants: AccessGrant[];
  invitationUrl?: string;
  invitations: Invitation[];
  inviteEmail: string;
  inviteRole: 'administrator' | 'viewer';
  onCandidateChange: (key: keyof CandidateForm, value: string) => void;
  onConfigure: (action: 'test' | 'activate') => void;
  onCreateInvitation: () => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: 'administrator' | 'viewer') => void;
  onRevokeInvitation: (id: string) => void;
  onRevokeSession: (id: string) => void;
  onSaveCandidate: () => void;
  onUpdateAccess: (
    id: string,
    change: Partial<Pick<AccessGrant, 'role' | 'status'>>,
  ) => void;
  sessions: BrowserSession[];
};

export function HostedAuthenticationPanels({
  candidate,
  configurationMessage,
  currentSessionId,
  grants,
  invitationUrl,
  invitations,
  inviteEmail,
  inviteRole,
  onCandidateChange,
  onConfigure,
  onCreateInvitation,
  onInviteEmailChange,
  onInviteRoleChange,
  onRevokeInvitation,
  onRevokeSession,
  onSaveCandidate,
  onUpdateAccess,
  sessions,
}: HostedAuthenticationPanelsProps) {
  return (
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
                <label className="grid gap-1.5 text-sm text-text" key={key}>
                  {label}
                  <Input
                    onChange={(event) =>
                      onCandidateChange(key, event.target.value)
                    }
                    value={candidate[key]}
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onSaveCandidate}>
                Save candidate
              </Button>
              <Button onClick={() => onConfigure('test')}>
                Test sign-in configuration
              </Button>
              <Button variant="outline" onClick={() => onConfigure('activate')}>
                Activate configuration
              </Button>
            </div>
            {configurationMessage ? (
              <p className="text-sm text-text">{configurationMessage}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <ConsoleAccessPanel
        grants={grants}
        invitationUrl={invitationUrl}
        invitations={invitations}
        inviteEmail={inviteEmail}
        inviteRole={inviteRole}
        onCreateInvitation={onCreateInvitation}
        onInviteEmailChange={onInviteEmailChange}
        onInviteRoleChange={onInviteRoleChange}
        onRevokeInvitation={onRevokeInvitation}
        onUpdateAccess={onUpdateAccess}
      />
      <BrowserSessionList
        currentSessionId={currentSessionId}
        onRevoke={onRevokeSession}
        sessions={sessions}
      />
    </div>
  );
}
