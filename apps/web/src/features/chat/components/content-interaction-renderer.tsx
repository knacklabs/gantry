import { AlertTriangle, CircleCheck, Image } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import type { InteractionPreview } from '../chat-preview';
import { InteractionFrame } from './interaction-frame';

type ContentDescriptor = Extract<
  InteractionPreview,
  { kind: 'fact' | 'list' | 'table' | 'form' | 'media' | 'dependency' }
>;

export function ContentInteractionRenderer({
  descriptor,
}: {
  descriptor: ContentDescriptor;
}) {
  if (descriptor.kind === 'fact') {
    return (
      <InteractionFrame title={descriptor.label}>
        <strong className="text-sm text-text">{descriptor.value}</strong>
        <p className="m-0 text-xs text-text-muted">{descriptor.provenance}</p>
      </InteractionFrame>
    );
  }

  if (descriptor.kind === 'list') {
    return (
      <InteractionFrame title={descriptor.title}>
        {descriptor.items.length ? (
          <ul className="m-0 grid gap-2 pl-5 text-[13px] leading-5 text-text-secondary">
            {descriptor.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-xs text-text-muted">
            No list items were provided.
          </p>
        )}
      </InteractionFrame>
    );
  }

  if (descriptor.kind === 'table') {
    return (
      <InteractionFrame title={descriptor.title}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-xs">
            <thead>
              <tr>
                {descriptor.columns.map((column) => (
                  <th
                    className="border-b border-border bg-surface-muted px-3 py-2 text-text"
                    key={column}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {descriptor.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      className="border-b border-border px-3 py-2 text-text-secondary last:border-b-0"
                      key={cellIndex}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </InteractionFrame>
    );
  }

  if (descriptor.kind === 'form')
    return <FormInteraction descriptor={descriptor} />;

  if (descriptor.kind === 'media') {
    return (
      <InteractionFrame
        title={descriptor.title}
        icon={<Image size={16} aria-hidden="true" />}
      >
        <div className="flex aspect-[16/7] items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted text-text-muted">
          <Image size={28} aria-hidden="true" />
        </div>
        <p className="m-0 text-xs text-text-secondary">
          {descriptor.caption} · {descriptor.mediaType}
        </p>
      </InteractionFrame>
    );
  }

  return (
    <InteractionFrame
      title={descriptor.name}
      icon={
        descriptor.status === 'blocked' ? (
          <AlertTriangle size={16} aria-hidden="true" />
        ) : (
          <CircleCheck size={16} aria-hidden="true" />
        )
      }
      action={<StatusBadge status={descriptor.status} />}
    >
      <p className="m-0 text-xs leading-5 text-text-secondary">
        {descriptor.detail}
      </p>
    </InteractionFrame>
  );
}

function FormInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'form' }>;
}) {
  const { requestConnection } = useConnectionGate();
  return (
    <InteractionFrame title={descriptor.title}>
      {descriptor.fields.map((field) => (
        <label
          className="grid gap-1 text-xs font-semibold text-text"
          key={field.label}
        >
          {field.label}
          <input
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            defaultValue={field.value}
            disabled={descriptor.disabled}
          />
        </label>
      ))}
      <Button
        disabled={descriptor.disabled}
        onClick={() => requestConnection(`Submit ${descriptor.title}`)}
      >
        Submit form
      </Button>
    </InteractionFrame>
  );
}
