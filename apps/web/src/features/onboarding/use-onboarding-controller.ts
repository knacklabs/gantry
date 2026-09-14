import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { agentModelsQuery } from '../agents/agents-queries';
import {
  channelConversationsQuery,
  channelProvidersQuery,
  createChannelAccount,
  discoverChannelConversations,
  installAgentConversation,
  loadConversationMembers,
  replaceConversationApprovers,
  selectOnboardingChannelProvider,
  verifyConversationApprovers,
} from '../channel-accounts/channel-account-queries';
import { navigationSummaryQuery } from '../navigation/navigation-summary-query';
import { modelProviderQuery } from '../operations/operations-queries';
import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';

const DEFAULT_STEP_ONE_DRAFT = {
  name: 'Atlas',
  title: 'General assistant',
  responsibilities: [
    'Answer questions in the channels it is invited to.',
    'Summarise long threads when someone asks.',
    'Draft replies for a person to approve before they go out.',
  ].join('\n'),
};

type VerificationStatus =
  | 'pending'
  | 'inbound_received'
  | 'satisfied'
  | 'projection_failed'
  | 'expired'
  | 'completed';

type OnboardingStatus = {
  firstRun: boolean;
  resume: {
    id: string;
    name: string;
    accountId: string | null;
    channelId: string | null;
    conversationId: string | null;
    approver: string | null;
    assignmentReady: boolean;
    verificationId: string | null;
    challenge: string | null;
    challengeText: string | null;
    hasWorkspace: boolean;
    step: 2 | 3 | 4;
  } | null;
};

const onboardingStatusQuery = queryOptions({
  queryKey: ['onboarding-status'],
  queryFn: async (): Promise<OnboardingStatus> => {
    const response = await browserFetch('/ui/api/onboarding/status', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Onboarding status could not be loaded.');
    return response.json() as Promise<OnboardingStatus>;
  },
});

function onboardingVerificationQuery(id: string) {
  return queryOptions({
    queryKey: ['onboarding-verification', id],
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.verification.status;
      return status === 'pending' || status === 'inbound_received'
        ? 2_000
        : false;
    },
    queryFn: async (): Promise<{
      verification: {
        status: VerificationStatus;
        expiresAt: string;
        completedAt: string | null;
      };
    }> => {
      const response = await browserFetch(
        `/ui/api/onboarding/verifications/${encodeURIComponent(id)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Verification status could not be loaded.');
      return response.json();
    },
  });
}

export function useOnboardingController() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState(
    () =>
      sessionStorage.getItem('gantry.onboarding.name') ??
      DEFAULT_STEP_ONE_DRAFT.name,
  );
  const [title, setTitle] = useState(
    () =>
      sessionStorage.getItem('gantry.onboarding.title') ??
      DEFAULT_STEP_ONE_DRAFT.title,
  );
  const [responsibilities] = useState(
    () =>
      sessionStorage.getItem('gantry.onboarding.responsibilities') ??
      DEFAULT_STEP_ONE_DRAFT.responsibilities,
  );
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [agentId, setAgentId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channelValues, setChannelValues] = useState<Record<string, string>>(
    {},
  );
  const [accountId, setAccountId] = useState('');
  const [workspaceConnected, setWorkspaceConnected] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [approver, setApprover] = useState('');
  const [assignmentReady, setAssignmentReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const [stepOneReady, setStepOneReady] = useState(false);
  const [credentialValidated, setCredentialValidated] = useState(false);
  const [setupIdempotencyKey, setSetupIdempotencyKey] = useState(() => {
    const key = sessionStorage.getItem('gantry.onboarding.idempotency');
    if (key) return key;
    const created = crypto.randomUUID();
    sessionStorage.setItem('gantry.onboarding.idempotency', created);
    return created;
  });

  const providers = useQuery(modelProviderQuery);
  const models = useQuery(agentModelsQuery);
  const channelProviders = useQuery(channelProvidersQuery());
  const conversations = useQuery(channelConversationsQuery());
  const selectedConversation = conversations.data?.conversations.find(
    (item) => item.id === conversationId,
  );
  const conversationMembers = useQuery({
    queryKey: ['channel-accounts', 'members', conversationId],
    enabled: Boolean(
      conversationId &&
      channelId === 'slack' &&
      selectedConversation?.kind !== 'direct',
    ),
    queryFn: () => loadConversationMembers(conversationId),
  });
  const status = useQuery(onboardingStatusQuery);
  const selectedProvider =
    providers.data?.find((item) => item.providerId === providerId) ??
    providers.data?.[0];
  const selectedChannel =
    channelProviders.data?.providers.find((item) => item.id === channelId) ??
    selectOnboardingChannelProvider(channelProviders.data?.providers ?? []);
  const verification = useQuery(onboardingVerificationQuery(verificationId));
  const effectiveProviderId = providerId || selectedProvider?.providerId || '';
  const availableModels = useMemo(
    () =>
      (models.data?.models ?? []).filter(
        (item) =>
          !effectiveProviderId || item.providerId === effectiveProviderId,
      ),
    [models.data?.models, effectiveProviderId],
  );
  const handle =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent';

  useEffect(() => {
    if (!started || !status.data?.resume || agentId) return;
    const resume = status.data.resume;
    setAgentId(resume.id);
    setAccountId(resume.accountId ?? '');
    setChannelId(resume.channelId ?? '');
    setWorkspaceConnected(resume.hasWorkspace);
    setConversationId(resume.conversationId ?? '');
    setApprover(resume.approver ?? '');
    setAssignmentReady(resume.assignmentReady);
    setVerificationId(resume.verificationId ?? '');
    setChallenge(resume.challengeText ?? '');
    setName(resume.name);
    setStepOneReady(true);
    setStep(resume.step);
  }, [agentId, started, status.data]);

  useEffect(() => {
    if (step !== 2 || channelId || !channelProviders.data) return;
    const provider = selectOnboardingChannelProvider(
      channelProviders.data.providers,
    );
    if (provider) setChannelId(provider.id);
  }, [channelId, channelProviders.data, step]);

  useEffect(() => {
    if (
      !status.isPending &&
      status.data &&
      !status.data.firstRun &&
      !status.data.resume
    ) {
      void navigate({ to: '/overview', replace: true });
    }
  }, [navigate, status.data, status.isPending]);

  function updateDraft(field: 'name' | 'title', value: string) {
    sessionStorage.setItem(`gantry.onboarding.${field}`, value);
    if (field === 'name') setName(value);
    else setTitle(value);
  }

  async function createEmployee() {
    if (!name.trim() || !title.trim() || !model || !credentialValidated) return;
    setBusy(true);
    setError(null);
    try {
      const response = await browserFetch('/ui/api/onboarding/setups', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': setupIdempotencyKey,
          ...browserCsrfHeader(),
        },
        body: JSON.stringify({
          name: name.trim(),
          title: title.trim(),
          responsibilities: responsibilities
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          modelAlias: model,
          agentHarness: 'auto',
        }),
      });
      if (!response.ok)
        throw new Error('The AI employee could not be created.');
      const body = (await response.json()) as { agent: { id: string } };
      setAgentId(body.agent.id);
      setStepOneReady(true);
      const nextIdempotencyKey = crypto.randomUUID();
      setSetupIdempotencyKey(nextIdempotencyKey);
      sessionStorage.setItem(
        'gantry.onboarding.idempotency',
        nextIdempotencyKey,
      );
      for (const key of [
        'gantry.onboarding.name',
        'gantry.onboarding.title',
        'gantry.onboarding.responsibilities',
      ]) {
        sessionStorage.removeItem(key);
      }
      await client.invalidateQueries({
        queryKey: navigationSummaryQuery.queryKey,
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Setup could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function connectWorkspace() {
    if (!agentId || !selectedChannel || selectedChannel.status !== 'available')
      return;
    setBusy(true);
    setError(null);
    try {
      const account = accountId
        ? { id: accountId }
        : await createChannelAccount({
            agentId,
            providerId: selectedChannel.id,
            label: `${name.trim()} workspace`,
            credentials: Object.fromEntries(
              selectedChannel.credentialKeys.map((key) => [
                key,
                channelValues[key] ?? '',
              ]),
            ),
          }).then(({ account: created }) => ({ id: created.id }));
      if (!accountId) {
        setAccountId(account.id);
        setChannelValues({});
      }
      await discoverChannelConversations(account.id);
      await client.invalidateQueries({ queryKey: ['channel-accounts'] });
      setWorkspaceConnected(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Workspace could not be connected.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function assignWork() {
    if (
      !agentId ||
      !accountId ||
      !conversationId ||
      (selectedConversation?.kind !== 'direct' && !approver.trim())
    )
      return;
    setBusy(true);
    setError(null);
    try {
      if (!assignmentReady) {
        if (selectedConversation?.kind !== 'direct') {
          const result = await verifyConversationApprovers(conversationId, [
            approver.trim(),
          ]);
          if (result.verification.invalidUserIds.length > 0) {
            throw new Error('Choose a verified member from this conversation.');
          }
        }
        await installAgentConversation({
          agentId,
          conversationId,
          providerAccountId: accountId,
          memoryScope: 'conversation',
        });
        if (selectedConversation?.kind !== 'direct') {
          await replaceConversationApprovers(conversationId, [approver.trim()]);
        }
        setAssignmentReady(true);
      }
      const response = await browserFetch('/ui/api/onboarding/verifications', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ agentId, conversationId }),
      });
      if (!response.ok)
        throw new Error('The test message could not be prepared.');
      const body = (await response.json()) as {
        verification: { id: string; challengeText: string };
      };
      setVerificationId(body.verification.id);
      setChallenge(body.verification.challengeText);
      setStep(4);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Work assignment could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function projectVerifiedSetup() {
    if (!verificationId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await browserFetch(
        `/ui/api/onboarding/verifications/${encodeURIComponent(verificationId)}/project`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: browserCsrfHeader(),
        },
      );
      if (!response.ok) throw new Error('Verified setup projection failed.');
      await verification.refetch();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Verified setup projection failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    accountId,
    agentId,
    approver,
    assignmentReady,
    availableModels,
    busy,
    challenge,
    channelId,
    channelProviders,
    channelValues,
    connectWorkspace,
    conversationId,
    conversationMembers,
    conversations,
    createEmployee,
    credentialValidated,
    error,
    handle,
    model,
    openConsole: () => {
      if (verification.data?.verification.status === 'completed')
        void navigate({ to: '/overview' });
    },
    projectVerifiedSetup,
    providerId,
    providers,
    selectedChannel,
    selectedConversation,
    setAccountId,
    setApprover,
    setAssignmentReady,
    setChannelId,
    setChannelValues,
    setConversationId,
    setCredentialValidated,
    setModel,
    setProviderId,
    setStarted,
    setStep,
    setStepOneReady,
    started,
    status,
    step,
    stepOneReady,
    title,
    updateDraft,
    verification,
    workspaceConnected,
    setWorkspaceConnected,
    assignWork,
    name,
  };
}
