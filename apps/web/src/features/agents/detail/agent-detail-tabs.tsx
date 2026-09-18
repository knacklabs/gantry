import { forwardRef } from 'react';

import { RouteTabs } from '../../../ui/compositions/route-tabs';
import type { AgentDetailTab } from './workflow-map/workflow-map-types';

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'access', label: 'Access' },
  { value: 'audit', label: 'Audit' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'usage', label: 'Usage' },
  { value: 'settings', label: 'Settings' },
] as const;

export const AgentDetailTabs = forwardRef<
  HTMLDivElement,
  {
    value: AgentDetailTab;
    onValueChange: (value: AgentDetailTab) => void;
  }
>(({ value, onValueChange }, ref) => (
  <div
    ref={ref}
    className="scroll-mt-4 border-x border-border bg-surface px-4 pt-1"
  >
    <RouteTabs
      label="AI employee detail"
      onValueChange={onValueChange}
      tabs={tabs}
      value={value}
    />
  </div>
));
AgentDetailTabs.displayName = 'AgentDetailTabs';
