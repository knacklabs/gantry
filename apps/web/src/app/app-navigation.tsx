import { Link } from '@tanstack/react-router';
import {
  Activity,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  CalendarClock,
  CircleHelp,
  LayoutDashboard,
  Library,
  MessagesSquare,
  MessageCircle,
  PauseCircle,
  PlugZap,
  Gauge,
  ExternalLink,
  Settings2,
  ShieldCheck,
  Users,
  Workflow,
} from 'lucide-react';

import { GantryMark } from '../ui/compositions/gantry-mark';

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
      { to: '/sources', label: 'Sources & access', icon: Library },
      { to: '/pause', label: 'Pause everywhere', icon: PauseCircle },
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
  return (
    <div className="flex h-full flex-col">
      <Link
        className="inline-flex min-h-10 items-center gap-2.5 px-2 font-['Helvetica_Neue',Helvetica,Arial,sans-serif] text-[17px] font-normal tracking-[-0.02em] text-text no-underline"
        to="/overview"
        onClick={onNavigate}
      >
        <GantryMark className="size-6 text-ink" />
        <span>Gantry</span>
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
