import {
  Check,
  Circle,
  CircleCheck,
  Download,
  FileText,
  ListChecks,
  LockKeyhole,
} from 'lucide-react';
import { useState } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { ResultReceipt } from '../../../ui/compositions/result-receipt';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import type { InteractionPreview } from '../chat-preview';
import { ContentInteractionRenderer } from './content-interaction-renderer';
import { InteractionFrame } from './interaction-frame';

export function InteractionRenderer({
  descriptor,
}: {
  descriptor: InteractionPreview;
}) {
  if (descriptor.kind === 'question')
    return <QuestionInteraction descriptor={descriptor} />;
  if (descriptor.kind === 'approval')
    return <ApprovalInteraction descriptor={descriptor} />;
  if (descriptor.kind === 'todo')
    return <TodoInteraction descriptor={descriptor} />;
  if (descriptor.kind === 'progress')
    return <ProgressInteraction descriptor={descriptor} />;
  if (descriptor.kind === 'file')
    return <FileInteraction descriptor={descriptor} />;
  if (descriptor.kind === 'receipt')
    return <ReceiptInteraction descriptor={descriptor} />;
  return <ContentInteractionRenderer descriptor={descriptor} />;
}

function QuestionInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'question' }>;
}) {
  const [choice, setChoice] = useState('');
  const { requestConnection } = useConnectionGate();
  return (
    <InteractionFrame
      title={descriptor.title}
      icon={<ListChecks size={16} aria-hidden="true" />}
    >
      <p className="m-0 text-[13px] leading-5 text-text-secondary">
        {descriptor.prompt}
      </p>
      <div className="grid gap-2">
        {descriptor.options.map((option) => (
          <label
            className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border px-3 text-[13px] text-text"
            key={option}
          >
            <input
              checked={choice === option}
              disabled={descriptor.disabled}
              name={descriptor.title}
              type="radio"
              value={option}
              onChange={() => setChoice(option)}
            />
            {option}
          </label>
        ))}
      </div>
      <Button
        disabled={!choice || descriptor.disabled}
        onClick={() =>
          requestConnection(`Answer ${descriptor.title}: ${choice}`)
        }
      >
        Submit answer
      </Button>
    </InteractionFrame>
  );
}

function ApprovalInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'approval' }>;
}) {
  const { requestConnection } = useConnectionGate();
  return (
    <InteractionFrame
      title={descriptor.title}
      icon={<LockKeyhole size={16} aria-hidden="true" />}
      action={
        <Badge
          tone={
            descriptor.risk === 'high'
              ? 'danger'
              : descriptor.risk === 'medium'
                ? 'attention'
                : 'neutral'
          }
        >
          {descriptor.risk} risk
        </Badge>
      }
    >
      <p className="m-0 text-[13px] leading-5 text-text-secondary">
        {descriptor.summary}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={descriptor.disabled}
          onClick={() => requestConnection(`Allow once: ${descriptor.title}`)}
        >
          Allow once
        </Button>
        <Button
          disabled={descriptor.disabled}
          variant="secondary"
          onClick={() =>
            requestConnection(`Allow for future: ${descriptor.title}`)
          }
        >
          Allow for future
        </Button>
        <Button
          disabled={descriptor.disabled}
          variant="ghost"
          onClick={() => requestConnection(`Cancel: ${descriptor.title}`)}
        >
          Cancel
        </Button>
      </div>
    </InteractionFrame>
  );
}

function TodoInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'todo' }>;
}) {
  return (
    <InteractionFrame
      title={descriptor.title}
      icon={<ListChecks size={16} aria-hidden="true" />}
    >
      <div className="grid gap-2">
        {descriptor.items.map((item) => (
          <div
            className="flex items-center gap-2 text-[13px] text-text-secondary"
            key={item.label}
          >
            {item.status === 'done' ? (
              <CircleCheck
                className="text-status-success"
                size={16}
                aria-hidden="true"
              />
            ) : item.status === 'active' ? (
              <Circle
                className="text-status-attention"
                size={16}
                fill="currentColor"
                aria-hidden="true"
              />
            ) : (
              <Circle size={16} aria-hidden="true" />
            )}
            <span
              className={
                item.status === 'done' ? 'line-through opacity-70' : ''
              }
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </InteractionFrame>
  );
}

function ProgressInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'progress' }>;
}) {
  return (
    <InteractionFrame
      title={descriptor.label}
      action={
        <span className="font-mono text-[10px] text-text-muted">
          {descriptor.value}%
        </span>
      }
    >
      <div className="h-2 overflow-hidden rounded-full bg-surface-strong">
        <div
          className="h-full bg-status-attention"
          style={{ width: `${Math.min(100, Math.max(0, descriptor.value))}%` }}
        />
      </div>
      <p className="m-0 text-xs text-text-secondary">{descriptor.detail}</p>
    </InteractionFrame>
  );
}

function FileInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'file' }>;
}) {
  const { requestConnection } = useConnectionGate();
  return (
    <InteractionFrame
      title={descriptor.name}
      icon={<FileText size={16} aria-hidden="true" />}
      action={
        <Button
          variant="ghost"
          onClick={() => requestConnection(`Download ${descriptor.name}`)}
        >
          <Download size={15} aria-hidden="true" />
          Download
        </Button>
      }
    >
      <p className="m-0 font-mono text-[10px] text-text-muted">
        {descriptor.mediaType} · {descriptor.size}
      </p>
    </InteractionFrame>
  );
}

function ReceiptInteraction({
  descriptor,
}: {
  descriptor: Extract<InteractionPreview, { kind: 'receipt' }>;
}) {
  return (
    <InteractionFrame
      title="Result receipt"
      icon={<Check size={16} aria-hidden="true" />}
    >
      <ResultReceipt
        attention={descriptor.attention}
        changed={descriptor.changed}
        completed={descriptor.outcome}
        delegated={descriptor.delegated}
        used={descriptor.used}
      />
    </InteractionFrame>
  );
}
