import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import {
  agentCapabilitiesQuery,
  agentDetailQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentCapabilities,
  type AgentDirectoryItem,
  type AgentSource,
  type BrowserRole,
  type CapabilityCatalog,
} from '../agents-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import {
  channelAccountQueryKeys,
  channelAccountsQuery,
  channelConversationsQuery,
  channelProvidersQuery,
  conversationApproversQuery,
  createChannelAccount,
  discoverChannelConversations,
  installAgentConversation,
  replaceConversationApprovers,
} from '../../channel-accounts/channel-account-queries';
import { AgentRoleSelector } from '../components/agent-role-selector';
import { AgentModelSelect } from '../components/agent-model-select';
import { AgentSetupManager } from '../components/agent-setup-manager';
import {
  RoleEditorDialog,
  type RoleEditorTarget,
} from '../components/role-editor-dialog';

export function AgentCreateRoute() {
  const navigate = useNavigate({ from: '/agents/new' });
  return (
    <AgentCreateDialog
      onClose={() =>
        void navigate({
          to: '/agents',
          search: {
            tab: 'agents',
            kind: 'all',
            q: '',
            status: 'all',
            page: 1,
            pageSize: 25,
            role: 'all',
            sort: 'name',
            desc: false,
          },
          replace: true,
        })
      }
    />
  );
}

type AgentCreateDialogProps = {
  existingAgent?: AgentDirectoryItem;
  onClose: () => void;
  startAt?: 'base' | 'account';
};

export function AgentCreateDialog({
  existingAgent,
  onClose,
  startAt = 'base',
}: AgentCreateDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(existingAgent?.name ?? '');
  const [modelAlias, setModelAlias] = useState<string | null>(
    existingAgent?.modelAlias ?? null,
  );
  const [selectedRole, setSelectedRole] = useState<BrowserRole>();
  const [baseErrors, setBaseErrors] = useState<{
    name?: string;
    role?: string;
  }>({});
  const [roleEditor, setRoleEditor] = useState<RoleEditorTarget>();
  const [agentId, setAgentId] = useState<string | undefined>(existingAgent?.id);
  const [setupPending, setSetupPending] = useState(false);
  const [step, setStep] = useState<
    | 'base'
    | 'sources'
    | 'capabilities'
    | 'account'
    | 'conversation'
    | 'approvals'
    | 'review'
  >(startAt);
  const [channelDeferred, setChannelDeferred] = useState(false);
  const [skippedSteps, setSkippedSteps] = useState<
    Set<'sources' | 'capabilities'>
  >(() => new Set());
  const [providerAccountId, setProviderAccountId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [conversationId, setConversationId] = useState('');
  const [memoryScope, setMemoryScope] = useState<
    'conversation' | 'agent' | 'app'
  >('conversation');
  const [approverIds, setApproverIds] = useState('');
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const conversations = useQuery(channelConversationsQuery());
  const approvers = useQuery(conversationApproversQuery(conversationId));
  const savedAgent = useQuery({
    ...agentDetailQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const savedSources = useQuery({
    ...agentSourcesQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const savedCapabilities = useQuery({
    ...agentCapabilitiesQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const saveAgent = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        agentId
          ? `/ui/api/agents/${encodeURIComponent(agentId)}`
          : '/ui/api/agents',
        {
          method: agentId ? 'PATCH' : 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ name, roleId: selectedRole?.id, modelAlias }),
        },
      );
      if (!response.ok)
        throw new Error(
          agentId
            ? 'AI employee changes could not be saved.'
            : 'The AI employee could not be created.',
        );
      return response.json() as Promise<{ agent: { id: string } }>;
    },
    onSuccess: ({ agent }) => {
      void queryClient.invalidateQueries({
        queryKey: navigationSummaryQuery.queryKey,
      });
      setAgentId(agent.id);
      setStep('sources');
    },
  });
  const saveAccount = useMutation({
    mutationFn: () =>
      createChannelAccount({
        agentId: agentId!,
        providerId,
        label: accountLabel,
        credentials,
      }),
    onSuccess: ({ account }) => {
      void queryClient.invalidateQueries({
        queryKey: channelAccountQueryKeys.all,
      });
      setProviderAccountId(account.id);
      setConversationId('');
      setStep('conversation');
    },
  });
  const discoverConversations = useMutation({
    mutationFn: () => discoverChannelConversations(providerAccountId),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: channelAccountQueryKeys.all,
      }),
  });
  const finishSetup = useMutation({
    mutationFn: async () => {
      if (!agentId || !providerAccountId || !conversationId) {
        throw new Error('Choose an account and conversation before finishing.');
      }
      const userIds = (approverIds || approvers.data?.approvers.join(',') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (!userIds.length) throw new Error('Enter at least one approver ID.');
      await replaceConversationApprovers(conversationId, userIds);
      return await installAgentConversation({
        agentId,
        conversationId,
        providerAccountId,
        memoryScope,
      });
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
        queryClient.invalidateQueries({
          queryKey: channelAccountQueryKeys.all,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
      ]);
      if (agentId) {
        void navigate({
          to: '/agents/$agentId',
          params: { agentId },
          search: { tab: 'overview' },
        });
      }
      if (existingAgent) onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = {
      name: name.trim() ? undefined : 'Enter an AI employee name.',
      role: selectedRole ? undefined : 'Select a role.',
    };
    setBaseErrors(errors);
    if (!errors.name && !errors.role) saveAgent.mutate();
  }

  const ownedAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => account.agentId === agentId,
  );
  const selectedAccount = ownedAccounts.find(
    (account) => account.id === providerAccountId,
  );
  const selectedProvider = (providers.data?.providers ?? []).find(
    (provider) => provider.id === providerId,
  );
  const selectedAccountProvider = (providers.data?.providers ?? []).find(
    (provider) => provider.id === selectedAccount?.providerId,
  );
  const accountConversations = (conversations.data?.conversations ?? []).filter(
    (conversation) => conversation.providerAccountId === providerAccountId,
  );
  const stepOrder = [
    'base',
    'sources',
    'capabilities',
    'account',
    'conversation',
    'approvals',
    'review',
  ] as const;
  const stepNumber = stepOrder.indexOf(step) + 1;

  function skipStep(item: 'sources' | 'capabilities') {
    setSkippedSteps((current) => new Set(current).add(item));
    setStep(item === 'sources' ? 'capabilities' : 'account');
  }

  function continueFromStep(
    item: 'sources' | 'capabilities',
    next: 'capabilities' | 'account',
  ) {
    setSkippedSteps((current) => {
      const nextSteps = new Set(current);
      nextSteps.delete(item);
      return nextSteps;
    });
    setStep(next);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={`w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border border-border bg-surface p-0 shadow-popover sm:max-w-none ${
          step === 'base'
            ? 'max-h-[calc(100dvh-46px)]'
            : 'h-[calc(100dvh-46px)] max-h-[900px]'
        }`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              Onboard an AI employee
            </DialogTitle>
            <DialogDescription className="text-sm text-text-secondary">
              {agentId
                ? `${name || existingAgent?.name || 'AI employee'} · employee saved`
                : 'Create the identity, configure access and connect a conversation.'}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close onboarding"
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <ol
          className="grid grid-cols-7 overflow-x-auto border-b border-border bg-surface-muted text-[11px] font-semibold text-text-secondary"
          aria-label="Onboarding steps"
        >
          {([
            ['base', 'Employee'],
            ['sources', 'Sources', 'optional'],
            ['capabilities', 'Capabilities', 'optional'],
            ['account', 'Channel account'],
            ['conversation', 'Conversation'],
            ['approvals', 'Approvals'],
            ['review', 'Review'],
          ] as const).map(([item, label, optional], index) => (
            <li
              aria-current={item === step ? 'step' : undefined}
              className={
                item === step
                  ? 'min-w-28 border-r border-border bg-surface px-3 py-[11px] text-text last:border-r-0'
                  : 'min-w-28 border-r border-border px-3 py-[11px] last:border-r-0'
              }
              key={item}
            >
              <span className="block font-mono text-[10px] text-text-secondary">
                {String(index + 1).padStart(2, '0')}
                {skippedSteps.has(item as 'sources' | 'capabilities')
                  ? ' · skipped'
                  : optional
                    ? ' · optional'
                    : channelDeferred &&
                        ['account', 'conversation', 'approvals'].includes(item)
                      ? ' · deferred'
                      : ''}
              </span>
              <span className="mt-1 block">{label}</span>
            </li>
          ))}
        </ol>
        <div className="min-h-0 overflow-y-auto p-5">
          {step === 'sources' && agentId ? (
            <section className="grid min-h-0 gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="m-0 text-lg font-semibold">
                    Sources{' '}
                    <span className="text-sm font-normal text-text-secondary">
                      Optional
                    </span>
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-text-secondary">
                    Attach instructions and integrations. Choose allowed actions
                    in the next step.
                  </p>
                </div>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => skipStep('sources')}
                >
                  Skip for now
                </Button>
              </div>
              <AgentSetupManager
                agentId={agentId}
                formId="agent-sources-form"
                kind="sources"
                onSaved={() => continueFromStep('sources', 'capabilities')}
                onSavingChange={setSetupPending}
              />
            </section>
          ) : null}
          {step === 'capabilities' && agentId ? (
            <section className="grid gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="m-0 text-lg font-semibold">
                    Capabilities{' '}
                    <span className="text-sm font-normal text-text-secondary">
                      Optional
                    </span>
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-text-secondary">
                    Choose explicit actions this employee may request.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => skipStep('capabilities')}
                >
                  Skip for now
                </Button>
              </div>
              <AgentSetupManager
                agentId={agentId}
                formId="agent-capabilities-form"
                kind="capabilities"
                onSaved={() => continueFromStep('capabilities', 'account')}
                onSavingChange={setSetupPending}
              />
            </section>
          ) : null}
          {step === 'account' && agentId ? (
            <section className="grid gap-5">
              <div>
                <h2 className="m-0 text-lg font-semibold">Channel account</h2>
                <p className="mt-1 mb-0 text-sm text-text-secondary">
                  This identity will belong to {name || 'this AI employee'}.
                  Choose a provider and enter its connection details.
                </p>
              </div>
              {ownedAccounts.length ? (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="m-0 text-sm font-semibold">
                      Existing accounts
                    </h3>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setProviderAccountId('');
                        setConversationId('');
                        setProviderId('');
                        setAccountLabel('');
                        setCredentials({});
                      }}
                    >
                      Add another account
                    </Button>
                  </div>
                  {ownedAccounts.map((account) => (
                    <button
                      className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                        providerAccountId === account.id
                          ? 'border-text bg-surface-muted shadow-[inset_0_0_0_1px_var(--text)]'
                          : 'border-border bg-surface hover:bg-surface-muted'
                      }`}
                      key={account.id}
                      type="button"
                      onClick={() => {
                        setProviderAccountId(account.id);
                        setConversationId('');
                      }}
                    >
                      <span className="grid size-8 place-items-center rounded-md bg-surface-strong font-mono text-[10px] font-semibold text-text-secondary">
                        {account.providerId.slice(0, 2).toUpperCase()}
                      </span>
                      <span>
                        <strong className="block text-sm">
                          {account.label}
                        </strong>
                        <span className="block text-xs text-text-secondary">
                          {account.providerId} · {account.status}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-text-muted">
                        {account.credentialKeys.length} fields
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {!providerAccountId ? (
                <div className="grid gap-3 rounded-lg border border-border bg-surface-muted p-4">
                  <div>
                    <h3 className="m-0 text-sm font-semibold">
                      Add a channel account
                    </h3>
                    <p className="mt-1 mb-0 text-xs text-text-secondary">
                      The account is owned by {name || 'this AI employee'}.
                    </p>
                  </div>
                  <label className="grid gap-1.5 text-xs font-semibold text-text">
                    Provider
                    <select
                      className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-text"
                      value={providerId}
                      onChange={(event) => {
                        setProviderId(event.target.value);
                        setCredentials({});
                      }}
                    >
                      <option value="">Choose a provider</option>
                      {(providers.data?.providers ?? []).map((provider) => (
                        <option
                          disabled={provider.status === 'unavailable'}
                          key={provider.id}
                          value={provider.id}
                        >
                          {provider.displayName}
                          {provider.status === 'setup_only'
                            ? ' · setup only'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TextField
                    id="channel-account-label"
                    label="Account label"
                    placeholder="Acme Slack · Support bot"
                    value={accountLabel}
                    onChange={(event) => setAccountLabel(event.target.value)}
                  />
                  {selectedProvider?.credentialKeys.map((key) => (
                    <TextField
                      id={`channel-credential-${key}`}
                      key={key}
                      label={formatCredentialLabel(key)}
                      placeholder="Enter value"
                      type="password"
                      value={credentials[key] ?? ''}
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  ))}
                  {selectedProvider?.status === 'setup_only' ? (
                    <p className="m-0 rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-xs text-status-attention">
                      This provider supports setup and discovery only. It cannot
                      activate a conversation yet.
                    </p>
                  ) : null}
                  <Button
                    disabled={
                      saveAccount.isPending ||
                      !providerId ||
                      !accountLabel.trim() ||
                      (selectedProvider?.credentialKeys ?? []).some(
                        (key) => !credentials[key]?.trim(),
                      )
                    }
                    type="button"
                    variant="secondary"
                    onClick={() => saveAccount.mutate()}
                  >
                    {saveAccount.isPending ? 'Saving account…' : 'Save account'}
                  </Button>
                  {saveAccount.isError ? (
                    <p className="m-0 text-xs text-danger" role="alert">
                      {saveAccount.error.message}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="m-0 rounded-[7px] border border-border bg-surface-muted p-[13px] text-xs leading-[1.45] text-text-secondary">
                  <strong className="block text-text">
                    Saved account selected
                  </strong>
                  {selectedAccount?.label} · {selectedAccount?.providerId} ·
                  owned by {name || 'this AI employee'}
                </p>
              )}
              <p className="m-0 text-xs text-text-secondary">
                Credential values are write-only. Invite the bot to the
                destination conversation before discovery.
              </p>
            </section>
          ) : null}
          {step === 'conversation' && agentId ? (
            <section className="grid gap-5">
              <div>
                <h2 className="m-0 text-lg font-semibold">Conversation</h2>
                <p className="mt-1 mb-0 text-sm text-text-secondary">
                  Select a discovered conversation for this account. An AI
                  employee can be installed in more than one conversation.
                </p>
              </div>
              {!selectedAccount ? (
                <p className="m-0 rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-sm text-status-attention">
                  Choose a channel account first.
                </p>
              ) : selectedAccount.status !== 'active' ||
                selectedAccountProvider?.status !== 'available' ? (
                <p className="m-0 rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-sm text-status-attention">
                  This account is configured for setup only and cannot activate
                  a conversation.
                </p>
              ) : (
                <>
                  <Button
                    disabled={discoverConversations.isPending}
                    type="button"
                    variant="secondary"
                    onClick={() => discoverConversations.mutate()}
                  >
                    {discoverConversations.isPending
                      ? 'Discovering conversations…'
                      : 'Discover conversations'}
                  </Button>
                  {discoverConversations.isError ? (
                    <p className="m-0 text-xs text-danger" role="alert">
                      {discoverConversations.error.message}
                    </p>
                  ) : null}
                  <div className="grid gap-2">
                    {accountConversations.length ? (
                      accountConversations.map((conversation) => (
                        <button
                          className={`grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                            conversationId === conversation.id
                              ? 'border-text bg-surface-muted shadow-[inset_0_0_0_1px_var(--text)]'
                              : 'border-border bg-surface hover:bg-surface-muted'
                          }`}
                          key={conversation.id}
                          type="button"
                          onClick={() => setConversationId(conversation.id)}
                        >
                          <span>
                            <strong className="block text-sm">
                              {conversation.title ?? conversation.id}
                            </strong>
                            <span className="block text-xs text-text-secondary">
                              {conversation.kind}
                            </span>
                          </span>
                          <span className="font-mono text-[10px] text-text-muted">
                            {conversation.status}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="m-0 rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
                        No conversations are stored for this account. Invite the
                        bot to a channel, then discover again.
                      </p>
                    )}
                  </div>
                  <label className="grid gap-1.5 text-xs font-semibold text-text">
                    Memory scope
                    <select
                      className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-text"
                      value={memoryScope}
                      onChange={(event) =>
                        setMemoryScope(
                          event.target.value as
                            | 'conversation'
                            | 'agent'
                            | 'app',
                        )
                      }
                    >
                      <option value="conversation">Conversation</option>
                      <option value="agent">AI employee</option>
                      <option value="app">Workspace</option>
                    </select>
                  </label>
                </>
              )}
            </section>
          ) : null}
          {step === 'approvals' ? (
            <section className="grid gap-4">
              <div>
                <h2 className="m-0 text-lg font-semibold">Approvals</h2>
                <p className="mt-1 mb-0 text-sm text-text-secondary">
                  Enter provider member IDs for people who can approve risky
                  actions in this conversation. Gantry verifies membership when
                  the installation is saved.
                </p>
              </div>
              <TextField
                id="conversation-approver-ids"
                hint={
                  approvers.data?.approvers.length
                    ? `Current approvers: ${approvers.data.approvers.join(', ')}`
                    : 'Separate member IDs with commas.'
                }
                label="Provider member IDs"
                placeholder="U0123ABC, U0456DEF"
                value={approverIds}
                onChange={(event) => setApproverIds(event.target.value)}
              />
              <p className="m-0 rounded-md border border-border bg-surface-muted p-3 text-xs text-text-secondary">
                Directory recognition does not grant approval authority.
                Approval authority is checked per conversation.
              </p>
            </section>
          ) : null}
          {step === 'review' && agentId ? (
            <section className="grid gap-4 rounded-lg border border-border bg-surface p-6">
              <div>
                <h2 className="font-semibold">Review setup</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  These are the saved settings that will apply on the AI
                  employee’s next run.
                </p>
              </div>
              {savedAgent.data &&
              savedSources.data &&
              savedCapabilities.data ? (
                <ReviewSummary
                  agent={savedAgent.data.agent}
                  capabilities={savedCapabilities.data}
                  sources={savedSources.data}
                  channelDeferred={channelDeferred}
                  conversation={accountConversations.find(
                    (conversation) => conversation.id === conversationId,
                  )}
                  providerAccount={selectedAccount}
                />
              ) : (
                <p className="text-sm text-text-secondary">
                  Loading saved setup…
                </p>
              )}
            </section>
          ) : null}
          {step === 'base' ? (
            <form id="agent-base-form" className="grid gap-4" onSubmit={submit}>
              <div>
                <h2 className="m-0 text-lg font-semibold">Employee</h2>
                <p className="mt-1 mb-0 text-sm text-text-secondary">
                  Give this employee a name, role and model.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-[1.2fr_.8fr]">
                <TextField
                  id="agent-name"
                  aria-required="true"
                  label={
                    <>
                      AI employee name{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </>
                  }
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setBaseErrors((errors) => ({ ...errors, name: undefined }));
                  }}
                  error={
                    baseErrors.name ??
                    (saveAgent.isError ? saveAgent.error.message : undefined)
                  }
                  placeholder="Customer research"
                  autoFocus
                />
                <AgentModelSelect
                  value={modelAlias}
                  onValueChange={setModelAlias}
                />
              </div>
              <AgentRoleSelector
                error={baseErrors.role}
                value={selectedRole}
                onChange={(role) => {
                  setSelectedRole(role);
                  setBaseErrors((errors) => ({ ...errors, role: undefined }));
                }}
                onCreateCustom={() => setRoleEditor({ mode: 'create' })}
              />
              <p className="m-0 rounded-[7px] border border-border bg-surface-muted p-[13px] text-xs leading-[1.45] text-text-secondary">
                <strong className="block text-text">Saved on Continue</strong>
                The employee identity is saved before account and conversation
                setup, matching Gantry’s current creation flow.
              </p>
            </form>
          ) : null}
          <RoleEditorDialog
            target={roleEditor}
            onOpenChange={(open) => !open && setRoleEditor(undefined)}
            onSaved={setSelectedRole}
          />
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <span className="text-xs leading-5 text-text-secondary">
            Step {stepNumber} of 7
            <br />
            {agentId ? 'Close to save and resume later' : 'No employee saved yet'}
          </span>
          {step === 'base' ? (
            <Button
              disabled={saveAgent.isPending || !name.trim() || !selectedRole}
              form="agent-base-form"
              type="submit"
            >
              {saveAgent.isPending
                ? 'Saving…'
                : 'Continue & save'}
            </Button>
          ) : null}
          {step === 'sources' ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('base')}
              >
                Back
              </Button>
              <Button
                disabled={setupPending}
                form="agent-sources-form"
                type="submit"
              >
                {setupPending ? 'Saving…' : 'Continue'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => skipStep('sources')}
              >
                Skip for now
              </Button>
            </div>
          ) : null}
          {step === 'capabilities' ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('sources')}
              >
                Back
              </Button>
              <Button
                disabled={setupPending}
                form="agent-capabilities-form"
                type="submit"
              >
                {setupPending ? 'Saving…' : 'Continue'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => skipStep('capabilities')}
              >
                Skip for now
              </Button>
            </div>
          ) : null}
          {step === 'account' ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('capabilities')}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setChannelDeferred(true);
                  setStep('review');
                }}
              >
                Set up channels later
              </Button>
              <Button
                disabled={
                  !selectedAccount ||
                  selectedAccount.status !== 'active' ||
                  selectedAccountProvider?.status !== 'available'
                }
                type="button"
                onClick={() => {
                  setChannelDeferred(false);
                  setStep('conversation');
                }}
              >
                Continue <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {step === 'conversation' ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('account')}
              >
                Back
              </Button>
              <Button
                disabled={!conversationId}
                type="button"
                onClick={() => setStep('approvals')}
              >
                Continue <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {step === 'approvals' ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('conversation')}
              >
                Back
              </Button>
              <Button
                disabled={
                  !approverIds.trim() && !approvers.data?.approvers.length
                }
                type="button"
                onClick={() => setStep('review')}
              >
                Continue <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {step === 'review' && agentId ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setStep(channelDeferred ? 'account' : 'approvals')
                }
              >
                Back
              </Button>
              <Button
                disabled={finishSetup.isPending}
                onClick={() => {
                  if (channelDeferred) {
                    void navigate({
                      to: '/agents/$agentId',
                      params: { agentId },
                      search: { tab: 'overview' },
                    });
                    return;
                  }
                  finishSetup.mutate();
                }}
              >
                {finishSetup.isPending
                  ? 'Saving installation…'
                  : channelDeferred
                    ? 'Finish setup'
                    : 'Save installation'}{' '}
                <ArrowRight size={16} aria-hidden="true" />
              </Button>
              {finishSetup.isError ? (
                <span className="text-xs text-danger" role="alert">
                  {finishSetup.error.message}
                </span>
              ) : null}
            </div>
          ) : null}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ReviewSummary({
  agent,
  capabilities,
  channelDeferred,
  conversation,
  providerAccount,
  sources,
}: {
  agent: AgentDirectoryItem;
  capabilities: { capabilities: AgentCapabilities; catalog: CapabilityCatalog };
  channelDeferred: boolean;
  conversation?: { title: string | null; kind: string };
  providerAccount?: { label: string; providerId: string };
  sources: { sources: { sources: AgentSource } };
}) {
  const skills = sources.sources.sources.skills;
  const mcpServers = sources.sources.sources.mcpServers;
  const selectedCapabilities = capabilities.capabilities.capabilities;
  const capabilityLabels = new Map<string, string>(
    (capabilities.catalog.capabilities ?? []).map(
      (capability) =>
        [`${capability.id}:${capability.version}`, capability.label] as const,
    ),
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ReviewCard
        title="Identity & behavior"
        lines={[
          ['Name', agent.name],
          ['Role snapshot', agent.roleName ?? 'No role selected'],
          ['Model', agent.modelAlias ?? 'Deployment default'],
          ['Instructions', 'Not configured'],
        ]}
      />
      <ReviewCard
        title="Sources"
        lines={[
          [
            'Skills',
            skills.length
              ? skills.map((item) => item.name ?? item.id).join(', ')
              : 'None selected',
          ],
          [
            'MCP servers',
            mcpServers.length
              ? mcpServers.map((item) => item.name ?? item.id).join(', ')
              : 'None selected',
          ],
        ]}
      />
      <ReviewCard
        title="Allowed capabilities"
        lines={
          selectedCapabilities.length
            ? selectedCapabilities.map((capability) => [
                capabilityLabels.get(
                  `${capability.id}:${capability.version}`,
                ) ?? capability.id,
                capability.id.includes('write') ? 'Write' : 'Read',
              ])
            : [['Access', 'None selected']]
        }
      />
      <ReviewCard
        title="Channel deployment"
        lines={
          channelDeferred
            ? [['Channel setup', 'Deferred · add from this AI employee later']]
            : [
                ['Channel account', providerAccount?.label ?? 'Not selected'],
                [
                  'Conversation',
                  conversation
                    ? `${conversation.title ?? 'Untitled'} · ${conversation.kind}`
                    : 'Not selected',
                ],
              ]
        }
      />
      <section className="rounded-lg border border-border p-4">
        <h3 className="m-0 text-sm font-semibold">Activation</h3>
        <p className="mt-3 mb-0 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-sm">
          {channelDeferred ? (
            <>
              Source and capability changes are{' '}
              <strong>available next run</strong>. No conversation is installed
              yet.
            </>
          ) : (
            <>
              Saving installs this AI employee in the selected conversation.
              Send a real message afterward to verify a reply.
            </>
          )}
        </p>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 rounded-lg border border-border bg-surface-muted p-3 text-center text-xs">
          <span>
            <strong className="block">{agent.roleName ?? 'None'}</strong>
            <small className="text-text-secondary">Role snapshot</small>
          </span>
          <span>→</span>
          <span>
            <strong className="block">
              {skills.length + mcpServers.length} selected
            </strong>
            <small className="text-text-secondary">Sources</small>
          </span>
          <span>→</span>
          <span>
            <strong className="block">
              {selectedCapabilities.length} allowed
            </strong>
            <small className="text-text-secondary">Capabilities</small>
          </span>
        </div>
      </section>
    </div>
  );
}

function formatCredentialLabel(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function ReviewCard({
  title,
  lines,
}: {
  title: string;
  lines: [string, string][];
}) {
  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <dl className="mt-3">
        {lines.map(([label, value]) => (
          <div
            className="flex min-h-8 items-center justify-between gap-4 border-t border-border py-2 text-sm first:border-t-0 first:pt-0"
            key={label}
          >
            <dt>{label}</dt>
            <dd className="m-0 text-right font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
