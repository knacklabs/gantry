import { AlertTriangle, Merge } from 'lucide-react';
import { useState } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import { buildMergePreview, type PersonPreview } from '../people-preview';

export function MergePersonPreview({
  person,
  people,
}: {
  person: PersonPreview;
  people: PersonPreview[];
}) {
  const targets = people.filter((candidate) => candidate.id !== person.id);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const { requestConnection } = useConnectionGate();
  const target =
    targets.find((candidate) => candidate.id === targetId) ?? targets[0];

  if (!target)
    return (
      <p className="m-0 p-5 text-sm text-text-secondary">
        No merge target is available.
      </p>
    );

  const preview = buildMergePreview(person, target);
  const canConfirm = confirmed && preview.conflicts.length === 0;

  return (
    <div className="grid gap-5 p-5">
      <div>
        <h2 className="m-0 text-sm font-semibold text-text">Merge preview</h2>
        <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
          Inspect the source, target, provenance, and conflicts. This preview
          never changes People records.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <PersonSummary label="Source person" person={person} />
        <label className="grid gap-2 rounded-md border border-border p-4 text-xs font-semibold text-text">
          Target person
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            value={target.id}
            onChange={(event) => {
              setTargetId(event.target.value);
              setConfirmed(false);
            }}
          >
            {targets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <span className="font-mono text-[10px] font-normal text-text-muted">
            person:{target.id}
          </span>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Impact label="Aliases moved" value={preview.aliasCount} />
        <Impact
          label="Affected conversations"
          value={preview.conversationCount}
        />
      </div>
      <section>
        <h3 className="m-0 text-xs font-semibold text-text">
          Source aliases and provenance
        </h3>
        <div className="mt-3 grid gap-2">
          {person.aliases.map((alias) => (
            <div
              className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              key={alias.id}
            >
              <span>
                <strong className="block text-[13px] text-text">
                  {alias.provider} · {alias.display}
                </strong>
                <span className="mt-1 block text-xs text-text-secondary">
                  {alias.provenance}
                </span>
              </span>
              <Badge tone={alias.verified ? 'success' : 'attention'}>
                {alias.verified ? 'Verified' : 'Unverified'}
              </Badge>
            </div>
          ))}
        </div>
      </section>
      {preview.conflicts.length ? (
        <section className="rounded-md border border-danger/40 bg-danger-soft p-4">
          <h3 className="m-0 inline-flex items-center gap-2 text-xs font-semibold text-danger">
            <AlertTriangle size={15} aria-hidden="true" />
            Conflicts must be resolved
          </h3>
          <ul className="mb-0 grid gap-2 pl-5 text-xs leading-5 text-danger">
            {preview.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="rounded-md border border-status-success/40 bg-status-success-soft p-4 text-xs text-status-success">
          No preview conflicts were found. Server-side validation would still be
          authoritative.
        </div>
      )}
      <Checkbox
        checked={confirmed}
        id="confirm-merge"
        label={`I reviewed the provenance and want to merge ${person.name} into ${target.name}.`}
        onCheckedChange={setConfirmed}
      />
      <div>
        <Button
          disabled={!canConfirm}
          variant="danger"
          onClick={() =>
            requestConnection(`Merge ${person.name} into ${target.name}`)
          }
        >
          <Merge size={16} aria-hidden="true" />
          Confirm merge
        </Button>
        {preview.conflicts.length ? (
          <p className="mt-2 mb-0 text-xs text-danger">
            Choose a conflict-free target or resolve conflicts in the connected
            system.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PersonSummary({
  label,
  person,
}: {
  label: string;
  person: PersonPreview;
}) {
  return (
    <div className="grid gap-2 rounded-md border border-border p-4">
      <span className="text-xs font-semibold text-text-muted">{label}</span>
      <strong className="text-sm text-text">{person.name}</strong>
      <span className="font-mono text-[10px] text-text-muted">
        person:{person.id}
      </span>
    </div>
  );
}

function Impact({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted p-4">
      <strong className="block text-2xl text-text">{value}</strong>
      <span className="mt-1 block text-xs text-text-secondary">{label}</span>
    </div>
  );
}
