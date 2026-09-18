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
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Gauge,
  ExternalLink,
  Settings2,
  ShieldCheck,
  Workflow,
} from 'lucide-react';

import { GantryMark } from '../ui/compositions/gantry-logo';
import { Button } from '../ui/primitives/button';
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
    label: 'Today',
    items: [
      { to: '/overview', label: 'Overview', icon: LayoutDashboard },
      { to: '/interactions', label: 'Waiting on you', icon: CircleHelp },
      { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
    ],
  },
  {
    label: 'Employees',
    items: [
      { to: '/agents', label: 'Roster', icon: Bot },
      { to: '/skills', label: 'Skills', icon: PackageCheck },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/people', label: 'People', icon: Bot },
      { to: '/providers', label: 'Model providers', icon: PlugZap },
      { to: '/mcp-servers', label: 'Tools', icon: Boxes },
      { to: '/channel-accounts', label: 'Channel accounts', icon: MessagesSquare },
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
      { to: '/diagnostics', label: 'Diagnostics', icon: Activity },
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
  'flex min-h-[31px] items-center gap-2.5 rounded-[7px] border border-transparent px-[9px] text-ui font-normal text-text-secondary no-underline hover:bg-surface-muted hover:text-text';
const NAV_ITEM_ACTIVE_CLASS_NAME =
  'border-border-strong bg-surface-strong text-text';

export function AppNavigation({ collapsed = false, onNavigate, onToggleCollapse }: { collapsed?: boolean; onNavigate?: () => void; onToggleCollapse?: () => void }) {
  const summary = useQuery(navigationSummaryQuery);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[34px] flex-wrap items-center justify-center gap-x-[9px] gap-y-[14px] px-[5px] pt-1">
        <Link aria-label="Gantry home" className={`inline-flex min-h-7 min-w-0 items-center text-ink no-underline ${collapsed ? 'flex-none gap-0' : 'flex-1 gap-[9px]'}`} to="/overview" onClick={onNavigate}>
          <GantryMark className="size-4" />
          <span className={`overflow-hidden font-display text-[16px] font-bold tracking-[-0.04em] whitespace-nowrap transition-[max-width,opacity] duration-[180ms] ease-gantry ${collapsed ? 'max-w-0 opacity-0' : 'max-w-24 opacity-100'}`}>Gantry</span>
        </Link>
        <Button
          aria-controls="primary-navigation"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className={`relative z-20 mx-auto flex-none ${collapsed ? 'size-[38px] p-3' : 'size-[30px] p-2'}`}
          size="icon-sm"
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          variant="ghost"
          onClick={onToggleCollapse}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={14} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={14} />
          )}
        </Button>
      </div>

      <div className={`grid gap-[13px] ${collapsed ? 'mt-[36px]' : 'mt-[14px]'}`}>
        {navigation.map((group) => (
          <nav
            aria-label={group.label}
            className="grid gap-1"
            key={group.label}
          >
            <p className={`mt-0 mb-[3px] overflow-hidden px-[9px] font-mono text-micro font-medium tracking-[0.18em] whitespace-nowrap text-text-muted uppercase transition-opacity duration-[180ms] ease-gantry ${collapsed ? 'opacity-0' : 'opacity-100'}`}>
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
                {collapsed ? <Tooltip><TooltipTrigger asChild><span><Icon size={17} aria-hidden="true" /></span></TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip> : <Icon size={17} aria-hidden="true" />}
                <span className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap transition-opacity duration-[180ms] ease-gantry ${collapsed ? 'opacity-0' : 'opacity-100'}`}>{label}</span>
                <NavigationCount
                  item={to}
                  summary={summary.data}
                  pending={summary.isPending}
                  hidden={collapsed}
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
          <Settings2 size={17} aria-hidden="true" /><span className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap transition-opacity duration-[180ms] ease-gantry ${collapsed ? 'opacity-0' : 'opacity-100'}`}>Profile</span>
        </Link>
        <Link
          activeProps={{ className: NAV_ITEM_ACTIVE_CLASS_NAME }}
          className={NAV_ITEM_CLASS_NAME}
          to="/settings/authentication-access"
          onClick={onNavigate}
        >
          <ShieldCheck size={17} aria-hidden="true" /><span className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap transition-opacity duration-[180ms] ease-gantry ${collapsed ? 'opacity-0' : 'opacity-100'}`}>Authentication &amp; Access</span>
        </Link>
      </nav>
    </div>
  );
}

function NavigationCount({
  item,
  summary,
  pending,
  hidden = false,
}: {
  item: string;
  summary?: NavigationSummary;
  pending: boolean;
  hidden?: boolean;
}) {
  if (hidden) return null;
  const details = navigationCountDetails(item, summary);
  if (!details) {
    return pending &&
      (item === '/agents' ||
        item === '/mcp-servers' ||
        item === '/providers' ||
        item === '/skills') ? (
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
  if (item === '/agents' && summary.agents) {
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
  if (item === '/mcp-servers' && summary.mcpServers) {
    return {
      count: summary.mcpServers.active,
      lines: [
        `${summary.mcpServers.active} active MCP servers`,
        `${summary.mcpServers.disabled} disabled`,
      ],
    };
  }
  if (item === '/providers' && summary.modelProviders) {
    return {
      count: summary.modelProviders.ready,
      lines: [
        `${summary.modelProviders.ready} ready`,
        `${summary.modelProviders.missing} need credentials`,
        `${summary.modelProviders.disabled} disabled`,
      ],
    };
  }
  if (item === '/skills') {
    const installed = summary.skills.installed;
    return {
      count: installed,
      lines: [`${installed} installed skill${installed === 1 ? '' : 's'}`],
    };
  }
  return null;
}
