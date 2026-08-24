import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../ui/primitives/card';
import { Button } from '../../ui/primitives/button';
import type { BrowserSession } from './authentication-access-types';

export function BrowserSessionList({
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
