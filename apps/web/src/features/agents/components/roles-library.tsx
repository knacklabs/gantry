import { BookOpen, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Button } from '../../../ui/primitives/button';
import type { BrowserPage, BrowserRole } from '../agents-queries';
import { BuiltInRoles } from './built-in-roles';
import { CustomRolesTable } from './custom-roles-table';
import { RoleEditorDialog, type RoleEditorTarget } from './role-editor-dialog';

export function RolesLibrary({
  data,
  builtIns,
  error,
  loading,
  onPageChange,
  onRetry,
}: {
  data: BrowserPage<BrowserRole> | undefined;
  builtIns?: BrowserPage<BrowserRole>;
  error: boolean;
  loading: boolean;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  const [editor, setEditor] = useState<RoleEditorTarget>();
  const duplicate = (role: BrowserRole) =>
    setEditor({
      mode: 'create',
      seed: {
        ...role,
        name: `${role.name} copy`,
        sourceRoleId: role.id,
      },
    });

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
      action={
        <Button onClick={() => setEditor({ mode: 'create' })}>
          <Plus size={15} aria-hidden="true" />
          New custom role
        </Button>
      }
    >
      <BuiltInRoles
        roles={builtIns?.data ?? []}
        onView={(role) => setEditor({ mode: 'view', role })}
        onDuplicate={duplicate}
      />
      <CustomRolesTable
        data={data}
        loading={loading}
        onView={(role) => setEditor({ mode: 'view', role })}
        onEdit={(role) => setEditor({ mode: 'edit', role })}
        onDuplicate={duplicate}
      />
      <div className="flex min-h-[52px] items-center justify-end gap-2 border-t border-border px-3">
        <Button
          disabled={(data?.page ?? 1) <= 1}
          variant="secondary"
          onClick={() => onPageChange((data?.page ?? 1) - 1)}
        >
          Previous
        </Button>
        <Button
          disabled={!data?.hasNext}
          variant="secondary"
          onClick={() => onPageChange((data?.page ?? 1) + 1)}
        >
          Next
        </Button>
      </div>
      <RoleEditorDialog
        target={editor}
        onOpenChange={(open) => !open && setEditor(undefined)}
      />
    </Panel>
  );
}
