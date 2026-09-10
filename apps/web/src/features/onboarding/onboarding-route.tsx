import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Check, ChevronRight, Copy, Moon, Sun } from 'lucide-react';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import { agentModelsQuery, type AgentModel } from '../agents/agents-queries';
import {
  channelConversationsQuery,
  channelProvidersQuery,
  createChannelAccount,
  discoverChannelConversations,
  installAgentConversation,
  replaceConversationApprovers,
  verifyConversationApprovers,
} from '../channel-accounts/channel-account-queries';
import type { ChannelConversation, ChannelProvider } from '../channel-accounts/channel-account-queries';
import { navigationSummaryQuery } from '../navigation/navigation-summary-query';
import { modelProviderQuery, type ModelProvider } from '../operations/operations-queries';
import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';
import { usePreferences } from '../../features/preferences/preferences-provider';

const STEPS = [
  ['Create Employee', 'Give it a name, say what it handles, and pick the model it thinks with.'],
  ['Connect Workspace', 'Install Gantry where your team already talks.'],
  ['Assign Work', 'Choose the channel it works in and who signs off on anything risky.'],
  ['Say Hello', 'Mention it once to confirm messages reach it and it replies.'],
] as const;

const DUTIES = ['Answer questions', 'Summarise threads', 'Search internal docs'];

type OnboardingStatus = { firstRun: boolean; resume: { id: string; name: string; hasWorkspace: boolean } | null };
const onboardingStatusQuery = queryOptions({
  queryKey: ['onboarding-status'],
  queryFn: async (): Promise<OnboardingStatus> => {
    const response = await browserFetch('/ui/api/onboarding/status', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Onboarding status could not be loaded.');
    return response.json() as Promise<OnboardingStatus>;
  },
});
function onboardingVerificationQuery(id: string) {
  return queryOptions({
    queryKey: ['onboarding-verification', id],
    enabled: Boolean(id),
    refetchInterval: 2_000,
    queryFn: async (): Promise<{ verification: { status: 'pending' | 'expired' | 'completed'; expiresAt: string; completedAt: string | null } }> => {
      const response = await browserFetch(`/ui/api/onboarding/verifications/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Verification status could not be loaded.');
      return response.json() as Promise<{ verification: { status: 'pending' | 'expired' | 'completed'; expiresAt: string; completedAt: string | null } }>;
    },
  });
}

export function OnboardingRoute() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { effectiveTheme, setTheme } = usePreferences();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(1);
  const [identity, setIdentity] = useState(true);
  const [name, setName] = useState(() => localStorage.getItem('gantry.onboarding.name') ?? '');
  const [title, setTitle] = useState(() => localStorage.getItem('gantry.onboarding.title') ?? '');
  const [responsibilities, setResponsibilities] = useState(() => localStorage.getItem('gantry.onboarding.responsibilities') ?? '');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [providerValues, setProviderValues] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channelValues, setChannelValues] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [approver, setApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState(() => `GY-${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
  const [verificationId, setVerificationId] = useState('');

  const providers = useQuery(modelProviderQuery);
  const models = useQuery(agentModelsQuery);
  const channelProviders = useQuery(channelProvidersQuery());
  const conversations = useQuery(channelConversationsQuery());
  const status = useQuery(onboardingStatusQuery);
  const selectedProvider = providers.data?.find((item) => item.providerId === providerId) ?? providers.data?.[0];
  const selectedMode = selectedProvider?.credentialModes[0];
  const selectedChannel = channelProviders.data?.providers.find((item) => item.id === channelId) ?? channelProviders.data?.providers[0];
  const effectiveProviderId = providerId || selectedProvider?.providerId || '';
  const availableModels = useMemo(
    () => (models.data?.models ?? []).filter((item) => !effectiveProviderId || item.providerId === effectiveProviderId),
    [models.data?.models, effectiveProviderId],
  );
  const code = challenge;
  const handle = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';

  useEffect(() => {
    if (!started || !status.data?.resume || agentId) return;
    setAgentId(status.data.resume.id);
    setName((current) => current || status.data.resume!.name);
    setStep(2);
  }, [agentId, started, status.data]);

  function saveDraft(next: { name?: string; title?: string; responsibilities?: string }) {
    if (next.name !== undefined) localStorage.setItem('gantry.onboarding.name', next.name);
    if (next.title !== undefined) localStorage.setItem('gantry.onboarding.title', next.title);
    if (next.responsibilities !== undefined) localStorage.setItem('gantry.onboarding.responsibilities', next.responsibilities);
  }

  async function createEmployee() {
    if (!selectedProvider || !selectedMode || !name.trim() || !model) return;
    setBusy(true); setError(null);
    const payload = Object.fromEntries(selectedMode.fields.map((field) => [field.name, providerValues[field.name] ?? '']));
    try {
      const credential = await browserFetch(`/ui/api/model-providers/${encodeURIComponent(selectedProvider.providerId)}`, {
        method: selectedProvider.configured ? 'PATCH' : 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify(selectedProvider.configured ? { payload } : { authMode: selectedMode.id, payload }),
      });
      if (!credential.ok) throw new Error('Credential could not be saved.');
      const verify = await browserFetch(`/ui/api/model-providers/${encodeURIComponent(selectedProvider.providerId)}/verify`, { method: 'POST', credentials: 'same-origin', headers: browserCsrfHeader() });
      if (!verify.ok) throw new Error('Gantry could not verify that model connection.');
      const lines = responsibilities.split('\n').map((line) => line.trim()).filter(Boolean);
      const response = await browserFetch('/ui/api/agents', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ name: name.trim(), modelAlias: model, customRole: { name: `${name.trim()} — ${title.trim() || 'Employee'}`, prompt: [`You are the organisation's ${title.trim() || 'AI employee'}.`, '', 'Responsibilities:', ...lines.map((line) => `- ${line}`)].join('\n') } }),
      });
      if (!response.ok) throw new Error('The AI employee could not be created.');
      const body = await response.json() as { agent: { id: string } };
      setAgentId(body.agent.id); setStep(2); setIdentity(false);
      await client.invalidateQueries({ queryKey: navigationSummaryQuery.queryKey });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Setup could not be saved.'); }
    finally { setBusy(false); }
  }

  async function connectWorkspace() {
    if (!agentId || !selectedChannel || selectedChannel.status !== 'available') return;
    setBusy(true); setError(null);
    try {
      const account = await createChannelAccount({ agentId, providerId: selectedChannel.id, label: `${name.trim()} workspace`, credentials: Object.fromEntries(selectedChannel.credentialKeys.map((key) => [key, channelValues[key] ?? ''])) });
      setAccountId(account.account.id);
      await discoverChannelConversations(account.account.id);
      await client.invalidateQueries({ queryKey: ['channel-accounts'] });
      setStep(3);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Workspace could not be connected.'); }
    finally { setBusy(false); }
  }

  async function assignWork() {
    if (!agentId || !accountId || !conversationId || !approver.trim()) return;
    setBusy(true); setError(null);
    try {
      const verification = await verifyConversationApprovers(conversationId, [approver.trim()]);
      if (verification.verification.invalidUserIds.length > 0) {
        throw new Error('Choose a verified member from this conversation.');
      }
      await installAgentConversation({ agentId, conversationId, providerAccountId: accountId, memoryScope: 'conversation' });
      await replaceConversationApprovers(conversationId, [approver.trim()]);
      const response = await browserFetch('/ui/api/onboarding/verifications', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ agentId, conversationId, challenge: code }),
      });
      if (!response.ok) throw new Error('The test message could not be prepared.');
      const body = await response.json() as { verification: { id: string; challenge: string } };
      setVerificationId(body.verification.id); setChallenge(body.verification.challenge); setStep(4);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Work assignment could not be saved.'); }
    finally { setBusy(false); }
  }

  function skip() { void navigate({ to: '/overview' }); }
  if (!started) return <Splash resume={status.data?.resume} onStart={() => setStarted(true)} />;
  return <div className="onboarding-page">
    <header className="onboarding-header"><Link to="/overview" className="onboarding-brand"><GantryMark /><strong>Gantry</strong></Link><span className="onboarding-rule" /><button className="onboarding-theme" onClick={() => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">{effectiveTheme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}</button></header>
    <div className="onboarding-grid"><aside className="onboarding-rail"><GantryMark large /> <div className="onboarding-steps">{STEPS.map(([label, blurb], index) => { const number = index + 1; const active = step === number; const complete = step > number; return <button key={label} disabled={number > step} onClick={() => setStep(number)} className="onboarding-step"><span className={`onboarding-node ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}>{complete ? <Check size={13} /> : number}</span><span><b>{label}</b><small>{blurb}</small></span></button>; })}</div><span className="onboarding-powered">KnackLabs</span></aside>
      <main className="onboarding-main"><section className="onboarding-content">
        {step === 1 && <EmployeeStep identity={identity} setIdentity={setIdentity} name={name} title={title} responsibilities={responsibilities} onName={(value: string) => { setName(value); saveDraft({ name: value }); }} onTitle={(value: string) => { setTitle(value); saveDraft({ title: value }); }} onResponsibilities={(value: string) => { setResponsibilities(value); saveDraft({ responsibilities: value }); }} provider={selectedProvider} providers={providers.data ?? []} providerId={providerId || selectedProvider?.providerId || ''} setProviderId={setProviderId} model={model} setModel={setModel} models={availableModels} values={providerValues} setValues={setProviderValues} onSave={createEmployee} busy={busy} />}
        {step === 2 && <WorkspaceStep channel={selectedChannel} channels={channelProviders.data?.providers ?? []} channelId={channelId || selectedChannel?.id || ''} setChannelId={setChannelId} values={channelValues} setValues={setChannelValues} onConnect={connectWorkspace} busy={busy} />}
        {step === 3 && <AssignStep conversations={conversations.data?.conversations ?? []} conversationId={conversationId} setConversationId={setConversationId} approver={approver} setApprover={setApprover} onSave={assignWork} busy={busy} />}
        {step === 4 && <HelloStep handle={handle} code={code} verificationId={verificationId} />}
        {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      </section><footer className="onboarding-actions"><div><button onClick={() => step > 1 && setStep(step - 1)} className="onboarding-secondary">Back</button><button onClick={skip} className="onboarding-skip">Skip for now</button></div>{step === 4 ? <button onClick={skip} className="onboarding-primary">Open the console <ChevronRight size={15} /></button> : null}</footer></main>
    </div></div>;
}

function Splash({ onStart, resume }: { onStart: () => void; resume?: OnboardingStatus['resume'] }) { return <main className="onboarding-splash"><div><GantryMark hero /><h1>Gantry</h1><h2>{resume ? `Finish setting up ${resume.name}` : 'Set Up Your First Agent'}</h2><p>Your organisation’s new <strong>AI employee</strong></p><p>Hire one, tell it what it should handle, and it starts working where your team already talks. Takes about three minutes.</p><button onClick={onStart}>{resume ? 'Resume setup' : 'Hire your first employee'} <ChevronRight size={16} /></button></div><small>Powered by KnackLabs</small></main>; }

function GantryMark({ large, hero }: { large?: boolean; hero?: boolean }) { return <span className={`gantry-mark ${large ? 'gantry-mark-large' : ''} ${hero ? 'gantry-mark-hero' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>; }

type EmployeeStepProps = { identity: boolean; setIdentity: Dispatch<SetStateAction<boolean>>; name: string; title: string; responsibilities: string; onName: (value: string) => void; onTitle: (value: string) => void; onResponsibilities: (value: string) => void; provider?: ModelProvider; providers: ModelProvider[]; providerId: string; setProviderId: Dispatch<SetStateAction<string>>; model: string; setModel: Dispatch<SetStateAction<string>>; models: AgentModel[]; values: Record<string, string>; setValues: Dispatch<SetStateAction<Record<string, string>>>; onSave: () => void; busy: boolean };
function EmployeeStep(props: EmployeeStepProps) { const { identity, setIdentity, name, title, responsibilities, onName, onTitle, onResponsibilities, provider, providers, providerId, setProviderId, model, setModel, models, values, setValues, onSave, busy } = props; return <><Heading title="Onboard Your First Agent" body="Name it, say what it does, and give it a model to think with. All of it can change later." />{identity ? <article className="onboarding-card"><label className="onboarding-name"><GantryMark /><span>Give it a name<input value={name} onChange={(e) => onName(e.target.value)} placeholder="Name it" /></span></label><Field label="Job title"><input value={title} onChange={(e) => onTitle(e.target.value)} placeholder="e.g. HR assistant" /></Field><Field label={`What should it handle? · ${responsibilities.split('\n').filter(Boolean).length} responsibilities`}><textarea rows={4} value={responsibilities} onChange={(e) => onResponsibilities(e.target.value)} placeholder="One line per responsibility." /></Field><div className="onboarding-chips">{DUTIES.map((duty) => <button key={duty} onClick={() => onResponsibilities(responsibilities.includes(duty) ? responsibilities : `${responsibilities}${responsibilities ? '\n' : ''}${duty}`)}>+ {duty}</button>)}</div><div className="onboarding-card-action"><button className="onboarding-primary" onClick={() => setIdentity(false)} disabled={!name.trim()}>Next <ChevronRight size={15} /></button></div></article> : <article className="onboarding-card"><div className="onboarding-summary">{name} · {title || 'AI employee'}<button onClick={() => setIdentity(true)}>Edit details</button></div><Field label="Which model should it think with?"><select value={providerId} onChange={(e) => setProviderId(e.target.value)}>{providers.map((item) => <option key={item.providerId} value={item.providerId}>{item.label}</option>)}</select></Field><Field label="Which one should it use?"><select value={model} onChange={(e) => setModel(e.target.value)}><option value="">Select a model</option>{models.map((item) => <option key={item.alias} value={item.alias}>{item.displayName}</option>)}</select></Field>{provider?.credentialModes?.[0]?.fields.map((field) => <Field key={field.name} label={field.label}><input type={field.secret ? 'password' : 'text'} value={values[field.name] ?? ''} onChange={(e) => setValues({ ...values, [field.name]: e.target.value })} /></Field>)}<small className="onboarding-help">Kept in the credential broker — never shown again.</small><div className="onboarding-card-action"><button className="onboarding-primary" onClick={onSave} disabled={busy || !model}>{busy ? 'Reaching provider…' : 'Save employee and test connection'} <ChevronRight size={15} /></button></div></article>}</>; }
type WorkspaceStepProps = { channel?: ChannelProvider; channels: ChannelProvider[]; channelId: string; setChannelId: Dispatch<SetStateAction<string>>; values: Record<string, string>; setValues: Dispatch<SetStateAction<Record<string, string>>>; onConnect: () => void; busy: boolean };
function WorkspaceStep(props: WorkspaceStepProps) { const { channel, channels, channelId, setChannelId, values, setValues, onConnect, busy } = props; return <><Heading title="Give your agent a place to work" body="Install Gantry where your team already talks." /><div className="onboarding-pills">{channels.map((item) => <button key={item.id} className={channelId === item.id ? 'is-selected' : ''} onClick={() => setChannelId(item.id)}>{item.displayName}</button>)}</div><article className="onboarding-card"><h3>1. Connect {channel?.displayName ?? 'workspace'}</h3><p>Use the provider’s configured credentials. Gantry stores them write-only and discovers conversations after connection.</p>{channel?.status !== 'available' ? <p className="onboarding-error">This provider is {channel?.status === 'setup_only' ? 'setup only' : 'not available'} in this runtime.</p> : channel?.credentialKeys.map((key) => <Field key={key} label={key}><input type="password" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></Field>)}<button className="onboarding-primary" onClick={onConnect} disabled={busy || channel?.status !== 'available'}>{busy ? 'Connecting…' : 'Connect workspace'} <ChevronRight size={15} /></button></article></>; }
type AssignStepProps = { conversations: ChannelConversation[]; conversationId: string; setConversationId: Dispatch<SetStateAction<string>>; approver: string; setApprover: Dispatch<SetStateAction<string>>; onSave: () => void; busy: boolean };
function AssignStep({ conversations, conversationId, setConversationId, approver, setApprover, onSave, busy }: AssignStepProps) { return <><Heading title="Put your agent to work" body="Give it one place to start and choose who approves riskier actions." /><article className="onboarding-card"><Field label="Give it one place to start"><select value={conversationId} onChange={(e) => setConversationId(e.target.value)}><option value="">Select a discovered conversation</option>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></Field><Field label="Who approves its riskier actions?"><input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="Verified member ID" /></Field><small className="onboarding-help">Anything it cannot do alone waits for the selected approver.</small><button className="onboarding-primary" onClick={onSave} disabled={busy || !conversationId || !approver}>{busy ? 'Saving…' : 'Continue'} <ChevronRight size={15} /></button></article></>; }
function HelloStep({ handle, code, verificationId }: { handle: string; code: string; verificationId: string }) { const text = `@${handle} are you there? · ${code}`; const verification = useQuery(onboardingVerificationQuery(verificationId)).data?.verification; const expired = verification?.status === 'expired'; const complete = verification?.status === 'completed'; return <><Heading title={complete ? `${handle} is ready` : `Ping ${handle}`} body={complete ? 'Your agent received the message and delivered its reply.' : 'Open the selected workspace and mention it. Gantry waits here until the message lands.'} /><article className="onboarding-card onboarding-hello"><div className="onboarding-ping"><code>{text}</code><button onClick={() => navigator.clipboard?.writeText(text)}><Copy size={13} /> Copy</button></div><GantryMark hero /><span className="onboarding-sweep"><i /></span><p>{complete ? 'Connected and replying.' : expired ? 'This test code expired. Return to Assign Work to issue another.' : 'Waiting for your message and the agent’s reply…'}</p><small className="onboarding-help">{complete ? 'Verification is complete.' : 'Success is only shown after the actual inbound message and correlated reply.'}</small></article></>; }
function Heading({ title, body }: { title: string; body: string }) { return <header className="onboarding-heading"><h1>{title}</h1><p>{body}</p></header>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="onboarding-field"><span>{label}</span>{children}</label>; }
