import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import { TextField } from '../../../ui/compositions/text-field';
import { agentQueryKeys } from '../agents-queries';

const draftSchema = z.object({ agentId: z.string() });
const persistedDraftSchema = draftSchema.extend({
  name: z.string(),
  purpose: z.string().nullable(),
  version: z.number(),
});

export function AgentSetupDialog({
  open,
  setupId,
  onOpenChange,
}: {
  open: boolean;
  setupId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [draftId, setDraftId] = useState<string>();
  const [version, setVersion] = useState<number>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = Boolean(name.trim() || purpose.trim());

  useEffect(() => {
    if (!open || !setupId || setupId === 'new' || !connection.transport) return;
    void connection.transport
      .request({
        path: `/agent-setups/${encodeURIComponent(setupId)}`,
        schema: persistedDraftSchema,
      })
      .then((draft) => {
        setDraftId(draft.agentId);
        setVersion(draft.version);
        setName(draft.name);
        setPurpose(draft.purpose ?? '');
      });
  }, [connection.transport, open, setupId]);

  function requestClose() {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    reset();
    onOpenChange(false);
  }

  async function saveDraft() {
    if (!connection.transport || !name.trim()) return;
    setSaving(true);
    try {
      const result = draftId
        ? await connection.transport.request({
            path: `/agent-setups/${encodeURIComponent(draftId)}`,
            method: 'PATCH',
            body: { step: 'agent', expectedVersion: version, name, purpose },
            schema: persistedDraftSchema,
          })
        : await connection.transport.request({
            path: '/agent-setups',
            method: 'POST',
            body: { appId: 'default', name, purpose: purpose || undefined },
            schema: persistedDraftSchema,
          });
      setDraftId(result.agentId);
      if ('version' in result && typeof result.version === 'number') {
        setVersion(result.version);
      }
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
      if (confirmClose) {
        reset();
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
    await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
  }

  async function discardDraft() {
    if (draftId && connection.transport) {
      await connection.transport.request({
        path: `/agent-setups/${encodeURIComponent(draftId)}`,
        method: 'DELETE',
        schema: z.object({ discarded: z.literal(true), agentId: z.string() }),
      });
    }
    reset();
    onOpenChange(false);
  }

  function reset() {
    setName('');
    setPurpose('');
    setDraftId(undefined);
    setVersion(undefined);
    setConfirmClose(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          {confirmClose ? (
            <div className="grid gap-5">
              <div>
                <Dialog.Title className="m-0 text-base font-semibold text-text">
                  Leave agent setup?
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                  Choose whether to save this agent as a draft or discard the
                  draft and its setup-only resources.
                </Dialog.Description>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => setConfirmClose(false)}>
                  Continue setup
                </Button>
                <Button variant="danger" onClick={() => void discardDraft()}>
                  Discard draft
                </Button>
                <Button
                  disabled={!name.trim() || saving}
                  variant="primary"
                  onClick={() => void saveDraft()}
                >
                  {saving ? 'Saving…' : 'Save draft & close'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="m-0 text-base font-semibold text-text">
                    Create agent
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                    Start with an identity. You can complete model, channel,
                    conversation, and profile setup next.
                  </Dialog.Description>
                </div>
                <IconButton
                  aria-label="Close"
                  onClick={requestClose}
                  title="Close"
                >
                  <X size={17} aria-hidden="true" />
                </IconButton>
              </div>
              <TextField
                id="setup-agent-name"
                label="Agent name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <label className="grid gap-1.5 text-xs font-semibold text-text">
                Purpose
                <textarea
                  className="min-h-24 resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal text-text"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button onClick={requestClose}>Cancel</Button>
                <Button
                  disabled={!name.trim() || saving}
                  variant="primary"
                  onClick={() => void saveDraft()}
                >
                  {draftId ? 'Draft saved' : saving ? 'Saving…' : 'Save draft'}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
