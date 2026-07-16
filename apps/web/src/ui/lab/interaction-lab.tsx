import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { InteractionRenderer } from '../../features/chat/components/interaction-renderer';
import type { InteractionPreview } from '../../features/chat/chat-preview';
import { PageHeader } from '../compositions/page-header';
import { Panel } from '../compositions/panel';

const descriptors: InteractionPreview[] = [
  {
    kind: 'question',
    title: 'Long question',
    prompt:
      'Choose the reporting region that should govern currency conversion, operating-hour boundaries, escalation ownership, and all downstream comparison tables for this draft.',
    options: ['North America', 'Europe', 'Asia Pacific'],
  },
  {
    kind: 'question',
    title: 'Disabled question',
    prompt: 'This question has already closed and cannot be answered.',
    options: ['Option one', 'Option two'],
    disabled: true,
  },
  {
    kind: 'approval',
    title: 'Publish reviewed report',
    summary: 'Publish the final report to the shared operations channel.',
    risk: 'high',
  },
  {
    kind: 'approval',
    title: 'Disabled approval',
    summary: 'This approval is no longer actionable.',
    risk: 'low',
    disabled: true,
  },
  {
    kind: 'todo',
    title: 'Progress checklist',
    items: [
      { label: 'Gather records', status: 'done' },
      { label: 'Validate evidence', status: 'active' },
      { label: 'Prepare receipt', status: 'pending' },
    ],
  },
  {
    kind: 'progress',
    label: 'Preparing report',
    detail: '17 of 24 records validated',
    value: 71,
  },
  {
    kind: 'file',
    name: 'a-very-long-reviewed-operational-report-filename.csv',
    size: '1.4 MB',
    mediaType: 'text/csv',
  },
  {
    kind: 'receipt',
    outcome:
      'Prepared a long-form report with all requested evidence and owner-visible limitations',
    used: 'Conversation history, reviewed skill, source catalog',
    changed: 'Draft file only',
    delegated: true,
    attention: 'Owner review remains required before publishing',
  },
  {
    kind: 'fact',
    label: 'Empty fact value',
    value: 'Not provided',
    provenance: 'No provenance available',
  },
  { kind: 'list', title: 'Empty list', items: [] },
  {
    kind: 'table',
    title: 'Responsive table',
    columns: ['Area', 'Current', 'Target'],
    rows: [
      ['Coverage', '82%', '95%'],
      ['Escalations', '14', 'Under 8'],
    ],
  },
  {
    kind: 'form',
    title: 'Disabled form',
    fields: [
      { label: 'Region', value: 'North America' },
      { label: 'Period', value: 'Week 28' },
    ],
    disabled: true,
  },
  {
    kind: 'media',
    title: 'Missing media preview',
    caption: 'No bitmap is available in preview mode.',
    mediaType: 'image/png',
  },
  {
    kind: 'dependency',
    name: 'Browser',
    status: 'ready',
    detail: 'Reviewed capability is available.',
  },
  {
    kind: 'dependency',
    name: 'Reporting CLI',
    status: 'blocked',
    detail: 'Executable identity needs review.',
  },
];

export function InteractionLab() {
  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/__components"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Component lab
      </Link>
      <PageHeader
        eyebrow="UI system"
        title="Interaction renderers"
        description="Development-only coverage for populated, disabled, empty, and long-content states."
      />
      <Panel
        title="Gantry interaction descriptors"
        description={`${descriptors.length} representative variants`}
      >
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {descriptors.map((descriptor, index) => (
            <InteractionRenderer
              descriptor={descriptor}
              key={`${descriptor.kind}-${index}`}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}
