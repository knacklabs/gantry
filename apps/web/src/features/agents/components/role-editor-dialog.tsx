import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Textarea } from '../../../ui/primitives/textarea';
import { TextField } from '../../../ui/compositions/text-field';
import type { BrowserRole } from '../agents-queries';

export type RoleEditorTarget =
  | { mode: 'create'; seed?: BrowserRole }
  | { mode: 'view'; role: BrowserRole }
  | { mode: 'edit'; role: BrowserRole };

export function RoleEditorDialog({
  target,
  onOpenChange,
}: {
  target?: RoleEditorTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const role = target
    ? target.mode === 'create'
      ? target.seed
      : target.role
    : undefined;
  const editable = target?.mode !== 'view';
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    setName(role?.name ?? '');
    setPrompt(role?.prompt ?? '');
  }, [role]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        target?.mode === 'edit'
          ? `/ui/api/roles/${encodeURIComponent(role!.id)}`
          : '/ui/api/roles',
        {
          method: target?.mode === 'edit' ? 'PATCH' : 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({
            name,
            prompt,
            ...(role?.sourceRoleId ? { sourceRoleId: role.sourceRoleId } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error('Role could not be saved.');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agents', 'roles'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === 'create'
              ? 'New custom role'
              : target?.mode === 'edit'
                ? `Edit ${role?.name}`
                : role?.name}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <TextField
            disabled={!editable}
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
              disabled={!editable}
              id="role-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={12}
            />
          </label>
          {save.isError ? (
            <p className="m-0 text-xs text-danger">{save.error.message}</p>
          ) : null}
        </div>
        <DialogFooter showCloseButton>
          {editable ? (
            <Button
              disabled={!name.trim() || !prompt.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save role'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
