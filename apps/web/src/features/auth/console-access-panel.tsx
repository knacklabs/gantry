import { SelectField } from '../../ui/compositions/select-field';
import { Button } from '../../ui/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import { Input } from '../../ui/primitives/input';
import type { AccessGrant, Invitation } from './authentication-access-types';

type Props = {
  grants: AccessGrant[];
  invitationUrl?: string;
  invitations: Invitation[];
  inviteEmail: string;
  inviteRole: 'administrator' | 'viewer';
  onCreateInvitation: () => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: 'administrator' | 'viewer') => void;
  onRevokeInvitation: (id: string) => void;
  onUpdateAccess: (
    id: string,
    change: Partial<Pick<AccessGrant, 'role' | 'status'>>,
  ) => void;
};

export function ConsoleAccessPanel({
  grants,
  invitationUrl,
  invitations,
  inviteEmail,
  inviteRole,
  onCreateInvitation,
  onInviteEmailChange,
  onInviteRoleChange,
  onRevokeInvitation,
  onUpdateAccess,
}: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Console access</CardTitle>
        <CardDescription>
          Administrators can invite people or approve verified identities.
          Viewer is the default role.
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
              onChange={(event) => onInviteEmailChange(event.target.value)}
            />
          </label>
          <SelectField
            label="Role"
            onValueChange={onInviteRoleChange}
            options={[
              { label: 'Viewer', value: 'viewer' },
              { label: 'Administrator', value: 'administrator' },
            ]}
            value={inviteRole}
          />
          <Button onClick={onCreateInvitation}>Create invitation</Button>
          {invitationUrl ? (
            <code className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs text-text">
              {invitationUrl}
            </code>
          ) : null}
        </div>
        <InvitationTable
          invitations={invitations}
          onRevoke={onRevokeInvitation}
        />
        <AccessGrantTable grants={grants} onUpdate={onUpdateAccess} />
      </CardContent>
    </Card>
  );
}

function InvitationTable({
  invitations,
  onRevoke,
}: {
  invitations: Invitation[];
  onRevoke: (id: string) => void;
}) {
  return (
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
            <tr className="border-t border-border" key={invitation.id}>
              <td className="p-2">{invitation.invitedEmail}</td>
              <td className="p-2 capitalize">{invitation.role}</td>
              <td className="p-2">
                {new Date(invitation.expiresAt).toLocaleString()}
              </td>
              <td className="p-2">
                <Button
                  onClick={() => onRevoke(invitation.id)}
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
  );
}

function AccessGrantTable({
  grants,
  onUpdate,
}: {
  grants: AccessGrant[];
  onUpdate: Props['onUpdateAccess'];
}) {
  return (
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
              <td className="p-2">{grant.displayName ?? 'Unknown person'}</td>
              <td className="p-2 capitalize">{grant.role}</td>
              <td className="p-2 capitalize">
                {grant.status.replace('_', ' ')}
              </td>
              <td className="p-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() =>
                      onUpdate(grant.id, {
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
                      onUpdate(grant.id, {
                        status:
                          grant.status === 'disabled' ? 'active' : 'disabled',
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    {grant.status === 'disabled' ? 'Restore' : 'Disable'}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
