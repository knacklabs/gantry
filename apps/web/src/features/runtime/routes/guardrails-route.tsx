import { useQuery } from '@tanstack/react-query';
import { EyeOff, ShieldCheck } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { guardrailPreviewQuery } from '../runtime-queries';

export function GuardrailsRoute() {
  const { data } = useQuery(guardrailPreviewQuery);
  const { requestConnection } = useConnectionGate();

  return (
    <div className="mx-auto grid w-full max-w-[1080px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Guardrails"
        description="Sandbox, egress, permission, and denylist posture with redacted detail."
        action={
          <Button
            onClick={() => requestConnection('Review guardrail settings')}
          >
            <ShieldCheck size={16} aria-hidden="true" />
            Review settings
          </Button>
        }
      />
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-4 py-3 text-xs text-text-secondary">
        <EyeOff size={16} aria-hidden="true" /> Raw rules, protected paths,
        credentials, tokens, and gateway addresses are redacted.
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {data.map((guardrail) => (
          <Panel
            key={guardrail.id}
            title={guardrail.name}
            description={guardrail.summary}
            action={<StatusBadge status={guardrail.status} />}
          >
            <div className="grid gap-4 p-5">
              <p className="m-0 text-sm leading-6 text-text-secondary">
                {guardrail.detail}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge>policy:[redacted]</Badge>
                <Badge>secret:[never shown]</Badge>
              </div>
              <Button
                variant="secondary"
                onClick={() => requestConnection(`Review ${guardrail.name}`)}
              >
                Review {guardrail.name.toLowerCase()}
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
