import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, Pencil, Trash2 } from 'lucide-react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../../ui/primitives/alert-dialog';
import { Button } from '../../../ui/primitives/button';
import type { BrowserPage, BrowserRole } from '../agents-queries';

export function CustomRolesTable({
  data,
  loading,
  onDuplicate,
  onEdit,
  onView,
}: {
  data?: BrowserPage<BrowserRole>;
  loading: boolean;
  onDuplicate: (role: BrowserRole) => void;
  onEdit: (role: BrowserRole) => void;
  onView: (role: BrowserRole) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await browserFetch(
        `/ui/api/roles/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: browserCsrfHeader(),
        },
      );
      if (!response.ok) throw new Error('Role could not be deleted.');
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['agents', 'roles'] }),
  });

  return (
    <div className="max-h-[calc(100dvh-20rem)] min-h-[330px] overflow-auto">
      <table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface-muted text-text-secondary">
          <tr className="border-b border-border">
            <th className="h-[39px] px-3 font-semibold">Role</th>
            <th className="h-[39px] px-3 font-semibold">Source</th>
            <th className="h-[39px] px-3 font-semibold">Prompt</th>
            <th className="h-[39px] px-3 font-semibold">Agents</th>
            <th className="h-[39px] px-3 font-semibold">Updated</th>
            <th className="h-[39px] px-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((role) => (
            <tr className="border-b border-border last:border-0" key={role.id}>
              <td className="h-[54px] px-3 py-[7px] font-medium">
                {role.name}
              </td>
              <td className="h-[54px] px-3 py-[7px] text-text-secondary">
                {role.sourceRoleId ?? '—'}
              </td>
              <td className="h-[54px] max-w-64 truncate px-3 py-[7px] text-text-secondary">
                {role.prompt}
              </td>
              <td className="h-[54px] px-3 py-[7px] text-text-secondary">
                {role.retainedAgentCount ?? 0}
              </td>
              <td className="h-[54px] px-3 py-[7px] text-text-secondary">
                {role.updatedAt ?? '—'}
              </td>
              <td className="h-[54px] px-3 py-[7px]">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onView(role)}
                  >
                    <Eye size={15} aria-hidden="true" />
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onEdit(role)}
                  >
                    <Pencil size={15} aria-hidden="true" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onDuplicate(role)}
                  >
                    <Copy size={15} aria-hidden="true" />
                    Duplicate
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="destructive">
                        <Trash2 size={15} aria-hidden="true" />
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {role.retainedAgentCount ?? 0} existing agent
                          {role.retainedAgentCount === 1 ? '' : 's'} retain{' '}
                          {role.retainedAgentCount === 1 ? 'its' : 'their'}{' '}
                          saved role snapshot. This only removes the role from
                          future selection.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                          <Button variant="secondary">Cancel</Button>
                        </AlertDialogCancel>
                        <Button
                          disabled={remove.isPending}
                          variant="destructive"
                          onClick={() => remove.mutate(role.id)}
                        >
                          Delete role
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </td>
            </tr>
          ))}
          {!loading && !data?.data.length ? (
            <tr>
              <td
                className="h-[330px] px-3 text-center text-text-secondary"
                colSpan={6}
              >
                No custom roles yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
