import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Copy, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Button } from '../../../ui/primitives/button';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Textarea } from '../../../ui/primitives/textarea';
import { TextField } from '../../../ui/compositions/text-field';
import type { BrowserPage, BrowserRole } from '../agents-queries';

export function RolesLibrary({
  data,
  builtIns,
  error,
  loading,
  onRetry,
}: {
  data: BrowserPage<BrowserRole> | undefined;
  builtIns?: BrowserPage<BrowserRole>;
  error: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sourceRoleId, setSourceRoleId] = useState<string>();
  const [editing, setEditing] = useState<BrowserRole>();
  const save = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        editing
          ? `/ui/api/roles/${encodeURIComponent(editing.id)}`
          : '/ui/api/roles',
        {
          method: editing ? 'PATCH' : 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({
            name,
            prompt,
            ...(sourceRoleId ? { sourceRoleId } : {}),
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          `Role could not be ${editing ? 'updated' : 'created'}.`,
        );
    },
    onSuccess: () => {
      setOpen(false);
      setEditing(undefined);
      setName('');
      setPrompt('');
      setSourceRoleId(undefined);
      return queryClient.invalidateQueries({ queryKey: ['agents', 'roles'] });
    },
  });
  function start(role?: BrowserRole, duplicate = false) {
    setEditing(role?.kind === 'custom' && !duplicate ? role : undefined);
    setName(
      role ? (role.kind === 'custom' ? role.name : `${role.name} copy`) : '',
    );
    setPrompt(role?.prompt ?? '');
    setSourceRoleId(duplicate ? role?.id : role?.sourceRoleId);
    setOpen(true);
  }
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
        <Button onClick={() => start()}>
          <Plus size={15} aria-hidden="true" />
          New custom role
        </Button>
      }
    >
      <section className="grid gap-3 border-b border-border p-4">
        <h2 className="m-0 text-sm font-semibold">Built-in roles</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {builtIns?.data.map((role) => (
            <details
              className="rounded-md border border-border p-3"
              key={role.id}
            >
              <summary className="cursor-pointer text-sm font-medium">
                {role.name}
              </summary>
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                {role.prompt}
              </pre>
              <Button
                className="mt-3"
                variant="secondary"
                onClick={() => start(role, true)}
              >
                <Copy size={15} aria-hidden="true" /> Make custom copy
              </Button>
            </details>
          ))}
        </div>
      </section>
      <div className="max-h-[calc(100vh-28rem)] overflow-auto p-4">
        <h2 className="mb-3 text-sm font-semibold">Custom roles</h2>
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="sticky top-0 bg-surface-muted text-xs text-text-secondary">
            <tr>
              <th className="p-3">Role</th>
              <th className="p-3">Source</th>
              <th className="p-3">Prompt</th>
              <th className="p-3">Updated</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((role) => (
              <tr className="border-t border-border" key={role.id}>
                <td className="p-3 font-medium">{role.name}</td>
                <td className="p-3 text-text-secondary">
                  {role.sourceRoleId ?? '—'}
                </td>
                <td className="max-w-64 truncate p-3 text-text-secondary">
                  {role.prompt}
                </td>
                <td className="p-3 text-text-secondary">
                  {role.updatedAt ?? '—'}
                </td>
                <td className="p-3">
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => start(role)}>
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => start(role, true)}
                    >
                      <Copy size={15} aria-hidden="true" />
                      Duplicate
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive">
                          <Trash2 size={15} aria-hidden="true" />
                          Delete role
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete {role.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Existing agents keep their saved role snapshot. This
                            only removes the role from future selection.
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
                <td className="p-6 text-center text-text-secondary" colSpan={5}>
                  No custom roles yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.name}` : 'New custom role'}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <TextField
              id="role-name"
              label="Role name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label
              className="grid gap-1.5 text-xs font-semibold text-text"
              htmlFor="role-prompt"
            >
              Prompt
              <Textarea
                id="role-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={8}
              />
            </label>
            {save.isError ? (
              <p className="m-0 text-xs text-danger">{save.error.message}</p>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={!name.trim() || !prompt.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? 'Saving…'
                : editing
                  ? 'Save role'
                  : 'Create role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
