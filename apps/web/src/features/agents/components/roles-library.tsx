import { BookOpen, RefreshCw } from 'lucide-react';

import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import type { BrowserPage, BrowserRole } from '../agents-queries';

export function RolesLibrary({
  data,
  error,
  loading,
  onRetry,
}: {
  data: BrowserPage<BrowserRole> | undefined;
  error: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <PageState
        action={
          <Button onClick={onRetry}>
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </Button>
        }
        description="Try loading the role library again."
        icon={<BookOpen size={18} aria-hidden="true" />}
        kind="error"
        title="Roles could not be loaded"
      />
    );
  }
  return (
    <Panel
      title="Roles"
      description={
        loading
          ? 'Loading roles…'
          : 'Role prompts are visible. Custom role changes affect future selections only.'
      }
    >
      <div className="grid max-h-[calc(100vh-20rem)] gap-3 overflow-y-auto p-4 sm:grid-cols-2">
        {data?.data.map((role) => (
          <article
            className="grid gap-3 rounded-lg border border-border p-4"
            key={role.id}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-sm font-semibold text-text">
                {role.name}
              </h2>
              <Badge
                variant={role.kind === 'built-in' ? 'secondary' : 'outline'}
              >
                {role.kind === 'built-in' ? 'Built-in' : 'Custom'}
              </Badge>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
              {role.prompt}
            </pre>
          </article>
        ))}
      </div>
    </Panel>
  );
}
