import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  AlertDialog,
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
  error,
  loading,
  onRetry,
}: {
  data: BrowserPage<BrowserRole> | undefined;
  error: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const response = await browserFetch('/ui/api/roles', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ name, prompt }),
      });
      if (!response.ok) throw new Error('Role could not be created.');
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setPrompt('');
      return queryClient.invalidateQueries({ queryKey: ['agents', 'roles'] });
    },
  });
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
        <Button onClick={() => setOpen(true)}>
          <Plus size={15} aria-hidden="true" />
          New custom role
        </Button>
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
            {role.kind === 'custom' ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 size={15} aria-hidden="true" />
                    Delete role
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Existing agents keep their saved role snapshot. This only
                      removes the role from future selection.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
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
            ) : null}
          </article>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New custom role</DialogTitle>
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
            {create.isError ? (
              <p className="m-0 text-xs text-danger">{create.error.message}</p>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={!name.trim() || !prompt.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
