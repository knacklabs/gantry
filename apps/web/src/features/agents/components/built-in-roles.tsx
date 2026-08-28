import type { BrowserRole } from '../agents-queries';

const BUILT_IN_ROLE_SUMMARIES: Record<string, string> = {
  Generalist: 'Planning and coordination',
  Research: 'Sources and synthesis',
  Developer: 'Code and architecture',
  Operations: 'Runbooks and status',
  Sales: 'Accounts and follow-up',
  Marketing: 'Campaigns and content',
};

export function BuiltInRoles({
  roles,
  onView,
}: {
  roles: BrowserRole[];
  onView: (role: BrowserRole) => void;
}) {
  return (
    <section>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        {roles.map((role) => (
          <button
            className="grid min-h-20 content-start rounded-md border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            key={role.id}
            type="button"
            onClick={() => onView(role)}
          >
            <span className="w-full rounded-full border border-border bg-surface-muted px-2 py-0.5 font-mono text-[10px] text-text-secondary">
              Built-in
            </span>
            <span className="mt-2 text-xs font-semibold text-text">
              {role.name}
            </span>
            <span className="mt-0.5 text-[10px] text-text-secondary">
              {BUILT_IN_ROLE_SUMMARIES[role.name] ?? 'Canonical Gantry role'}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
