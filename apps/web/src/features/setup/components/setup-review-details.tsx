import { Button } from '../../../ui/primitives/button';
import { useSetupReadinessCheck } from '../use-setup-readiness';

export function SetupReviewDetails({
  agentCreated,
  modelAlias,
  providerAccountId,
  conversationId,
  profileSaved,
}: {
  agentCreated: boolean;
  modelAlias: string;
  providerAccountId: string;
  conversationId: string;
  profileSaved: boolean;
}) {
  const check = useSetupReadinessCheck();
  const checks: Array<[string, boolean]> = [
    ['Agent', agentCreated],
    ['Model', Boolean(modelAlias)],
    ['Provider connection', Boolean(providerAccountId)],
    ['Conversation', Boolean(conversationId)],
    ['Profile', profileSaved],
  ];

  return (
    <div className="grid gap-4">
      <ul className="m-0 grid list-none gap-2 p-0 text-sm">
        {checks.map(([label, complete]) => (
          <li className="flex justify-between gap-3" key={label}>
            <span className="text-text-secondary">{label}</span>
            <span className={complete ? 'text-status-ready' : 'text-danger'}>
              {complete ? 'Configured' : 'Needs attention'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Checking runtime…' : 'Check runtime'}
        </Button>
        {check.data ? (
          <span className="text-sm text-status-ready">
            Runtime is healthy ({check.data.processRole}).
          </span>
        ) : null}
      </div>
      <p className="m-0 text-xs leading-5 text-text-muted">
        This check verifies the local control plane only. It does not restart
        Gantry or send a provider message.
      </p>
      {check.isError ? (
        <p className="m-0 text-sm text-danger">{check.error.message}</p>
      ) : null}
    </div>
  );
}
