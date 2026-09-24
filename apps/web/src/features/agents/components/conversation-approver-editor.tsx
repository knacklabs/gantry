import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { X } from 'lucide-react';

import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import {
  conversationApproversQuery,
  loadSlackConversationMembers,
  replaceConversationApprovers,
  verifyConversationApprovers,
} from '../../channel-accounts/channel-account-queries';
import { agentWorkflowMapQuery } from '../agents-queries';
import {
  normalizeApproverIds,
  sameApprovers,
  saveConversationApprovers,
} from './conversation-approver-save';

export function ConversationApproverEditor({
  agentId,
  conversationId,
  conversationName,
  initialApprovers,
  onClose,
}: {
  agentId: string;
  conversationId: string;
  conversationName: string;
  initialApprovers: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() =>
    normalizeApproverIds(initialApprovers),
  );
  const [manualId, setManualId] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const members = useQuery({
    queryKey: ['conversation-approver-members', conversationId],
    queryFn: () => loadSlackConversationMembers(conversationId),
    retry: false,
  });
  const nameById = new Map(
    (members.data?.members ?? []).map((member) => [
      member.id,
      member.displayName,
    ]),
  );
  const save = useMutation({
    mutationFn: () =>
      saveConversationApprovers({
        selected,
        initial: initialApprovers,
        current: async () => {
          const current = await queryClient.fetchQuery({
            ...conversationApproversQuery(conversationId),
            staleTime: 0,
          });
          return current.approvers;
        },
        verify: async (ids) =>
          (await verifyConversationApprovers(conversationId, ids)).verification,
        replace: (ids) => replaceConversationApprovers(conversationId, ids),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationApproversQuery(conversationId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: agentWorkflowMapQuery(agentId).queryKey,
        }),
      ]);
      onClose();
    },
  });
  const addManual = () => {
    const added = manualId.split(',');
    setSelected((current) => normalizeApproverIds([...current, ...added]));
    setManualId('');
  };
  const pending = save.isPending;
  const unchanged = sameApprovers(selected, initialApprovers);
  const availableMembers = (members.data?.members ?? []).filter(
    (member) =>
      !selected.includes(member.id) &&
      `${member.displayName} ${member.id}`
        .toLocaleLowerCase()
        .includes(memberSearch.trim().toLocaleLowerCase()),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[min(85vh,720px)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit conversation approvers</DialogTitle>
          <DialogDescription>
            {conversationName} · These people can approve risky actions for
            every agent installed in this conversation.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">
              Current selection
            </p>
            <div className="flex flex-wrap gap-2">
              {selected.length ? (
                selected.map((id) => (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-muted px-2 py-1 text-xs"
                    key={id}
                  >
                    {nameById.get(id) ?? id}
                    <button
                      aria-label={`Remove ${nameById.get(id) ?? id}`}
                      className="rounded p-0.5 hover:bg-foreground/10"
                      disabled={pending}
                      onClick={() =>
                        setSelected((current) =>
                          current.filter((item) => item !== id),
                        )
                      }
                      type="button"
                    >
                      <X aria-hidden="true" size={12} />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-xs text-text-secondary">
                  No approvers selected.
                </span>
              )}
            </div>
          </div>
          {members.data?.members.length ? (
            <div className="grid gap-2">
              <label className="grid gap-1 text-xs font-medium">
                Add a conversation member
                <input
                  className="rounded-md border border-border bg-surface px-2 py-2 text-sm"
                  disabled={pending}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  placeholder="Search members"
                  value={memberSearch}
                />
              </label>
              <div
                aria-label="Available conversation members"
                className="max-h-40 overflow-y-auto rounded-md border border-border"
                role="group"
              >
                {availableMembers.length ? (
                  availableMembers.map((member) => (
                    <button
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none"
                      disabled={pending}
                      key={member.id}
                      onClick={() => {
                        setSelected((current) =>
                          normalizeApproverIds([...current, member.id]),
                        );
                        setMemberSearch('');
                      }}
                      type="button"
                    >
                      {member.displayName}
                    </button>
                  ))
                ) : (
                  <p className="m-0 px-3 py-2 text-xs text-text-secondary">
                    {memberSearch
                      ? 'No matching members.'
                      : 'All members selected.'}
                  </p>
                )}
              </div>
            </div>
          ) : members.isPending ? (
            <p className="m-0 text-xs text-text-secondary">
              Loading conversation members…
            </p>
          ) : null}
          <label className="grid gap-1 text-xs font-medium">
            Or add member IDs
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-2 text-sm"
                disabled={pending}
                onChange={(event) => setManualId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addManual();
                  }
                }}
                placeholder="U0123ABC, U0456DEF"
                value={manualId}
              />
              <Button
                disabled={pending || !manualId.trim()}
                onClick={addManual}
                type="button"
                variant="secondary"
              >
                Add
              </Button>
            </div>
          </label>
          {members.isError ? (
            <p className="m-0 text-xs text-text-secondary">
              Member list unavailable. Enter member IDs above; Gantry will
              verify them before saving.
            </p>
          ) : null}
          {save.error ? (
            <p className="m-0 text-xs text-danger" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={pending || unchanged || !selected.length}
            onClick={() => save.mutate()}
            type="button"
          >
            {pending ? 'Verifying and saving…' : 'Save approvers'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
