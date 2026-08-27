import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  CalendarClock,
  CircleHelp,
  LayoutDashboard,
  MessagesSquare,
  MessageCircle,
  PlugZap,
  Gauge,
  ExternalLink,
  Settings2,
  ShieldCheck,
  Users,
  Workflow,
} from 'lucide-react';

import { GantryLogo } from '../ui/compositions/gantry-logo';
import {
  navigationSummaryQuery,
  type NavigationSummary,
} from '../features/navigation/navigation-summary-query';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../ui/primitives/tooltip';

const navigation = [
  {
    label: 'Operations',
    items: [
      { to: '/overview', label: 'Overview', icon: LayoutDashboard },
      { to: '/interactions', label: 'Waiting on you', icon: CircleHelp },
      { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
      { to: '/diagnostics', label: 'Diagnostics', icon: Activity },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/providers', label: 'Model providers', icon: PlugZap },
      { to: '/mcp-servers', label: 'MCP servers', icon: Boxes },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/people', label: 'People', icon: Users },
    ],
  },
  {
    label: 'Conversations',
    items: [
      { to: '/chat', label: 'Chat', icon: MessageCircle },
      { to: '/memory', label: 'What I remember', icon: Brain },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { to: '/jobs', label: 'Jobs', icon: CalendarClock },
      { to: '/runtime/models', label: 'Models', icon: Boxes },
      { to: '/runtime/memory', label: 'Memory engine', icon: BrainCircuit },
      { to: '/runtime/capacity', label: 'Capacity', icon: Gauge },
      { to: '/runtime/guardrails', label: 'Guardrails', icon: ShieldCheck },
      { to: '/activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    label: 'Workflows',
    items: [
      { to: '/workflows', label: 'Definitions', icon: Workflow },
      {
        to: '/workflows/external',
        label: 'External systems',
        icon: ExternalLink,
      },
    ],
  },
] as const;

const NAV_ITEM_CLASS_NAME =
  'flex min-h-9 items-center gap-2.5 rounded-md border border-transparent px-2.5 text-[13px] font-medium text-text-secondary no-underline hover:bg-surface-muted hover:text-text';
const NAV_ITEM_ACTIVE_CLASS_NAME =
  'border-border-strong bg-surface-strong text-text';

export function AppNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const summary = useQuery(navigationSummaryQuery);
  return (
    <div className="flex h-full flex-col">
      <Link
        aria-label="Gantry"
        className="inline-flex min-h-10 items-center px-2 text-ink no-underline"
        to="/overview"
        onClick={onNavigate}
      >
        <GantryLogo className="h-6 w-[102px]" />
      </Link>

      <div className="mt-6 grid gap-5">
        {navigation.map((group) => (
          <nav
            aria-label={group.label}
            className="grid gap-1"
            key={group.label}
          >
            <p className="mt-0 mb-1 px-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
              {group.label}
            </p>
            {group.items.map(({ to, label, icon: Icon }) => (
              <Link
                activeOptions={{ exact: to === '/overview' }}
                activeProps={{ className: NAV_ITEM_ACTIVE_CLASS_NAME }}
                className={NAV_ITEM_CLASS_NAME}
                key={to}
                to={to}
                onClick={onNavigate}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
                <NavigationCount
                  item={to}
                  summary={summary.data}
                  pending={summary.isPending}
                />
              </Link>
            ))}
          </nav>
        ))}
      </div>

      <nav
        aria-label="Account"
        className="mt-auto grid gap-1 border-t border-border pt-3"
      >
        <Link
          activeProps={{ className: NAV_ITEM_ACTIVE_CLASS_NAME }}
          className={NAV_ITEM_CLASS_NAME}
          to="/profile"
          onClick={onNavigate}
        >
          <Settings2 size={17} aria-hidden="true" />
          <span>Profile</span>
        </Link>
        <Link
          activeProps={{ className: NAV_ITEM_ACTIVE_CLASS_NAME }}
          className={NAV_ITEM_CLASS_NAME}
          to="/settings/authentication-access"
          onClick={onNavigate}
        >
          <ShieldCheck size={17} aria-hidden="true" />
          <span>Authentication &amp; Access</span>
        </Link>
      </nav>
    </div>
  );
}

function NavigationCount({
  item,
  summary,
  pending,
}: {
  item: string;
  summary?: NavigationSummary;
  pending: boolean;
}) {
  const details = navigationCountDetails(item, summary);
  if (!details) {
    return pending &&
      (item === '/agents' ||
        item === '/mcp-servers' ||
        item === '/providers') ? (
      <span
        aria-hidden="true"
        className="ml-auto h-4 w-5 animate-pulse rounded-full bg-surface-muted"
      />
    ) : null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={details.lines.join(', ')}
          className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-secondary"
        >
          {details.count}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="grid gap-0.5 whitespace-nowrap">
          {details.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function navigationCountDetails(item: string, summary?: NavigationSummary) {
  if (!summary) return null;
  if (item === '/agents') {
    return {
      count: summary.agents.total,
      lines: [
        `${summary.agents.total} configured`,
        `${summary.agents.active} active`,
        `${summary.agents.disabled} disabled`,
        ...(summary.agents.withoutRole
          ? [`${summary.agents.withoutRole} without role`]
          : []),
      ],
    };
  }
  if (item === '/mcp-servers') {
    return {
      count: summary.mcpServers.active,
      lines: [
        `${summary.mcpServers.active} active MCP servers`,
        `${summary.mcpServers.disabled} disabled`,
      ],
    };
  }
  if (item === '/providers') {
    return {
      count: summary.modelProviders.ready,
      lines: [
        `${summary.modelProviders.ready} ready`,
        `${summary.modelProviders.missing} need credentials`,
        `${summary.modelProviders.disabled} disabled`,
      ],
    };
  }
  return null;
}
