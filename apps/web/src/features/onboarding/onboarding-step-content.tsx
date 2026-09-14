import { Check, ChevronRight, Power } from 'lucide-react';

import type { AgentModel } from '../agents/agents-queries';
import type { ChannelConversation } from '../channel-accounts/channel-account-queries';
import type { ModelProvider } from '../operations/operations-queries';
import { CopyButton } from '../../ui/primitives/copy-button';
import { GantryMark } from './onboarding-mark';
import { OnboardingModelSetup } from './onboarding-model-setup';

export function EmployeeStep({
  name,
  title,
  providers,
  providerId,
  onProviderChange,
  model,
  onModelChange,
  models,
  credentialValidated,
  onCredentialValidated,
  onSave,
  busy,
  ready,
}: {
  name: string;
  title: string;
  providers: ModelProvider[];
  providerId: string;
  onProviderChange: (providerId: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  models: AgentModel[];
  credentialValidated: boolean;
  onCredentialValidated: (validated: boolean) => void;
  onSave: () => void;
  busy: boolean;
  ready: boolean;
}) {
  return (
    <>
      <Heading
        title="Onboard Your First Agent"
        body="Give it a model to think with. All of it can change later."
      />
      <article className="onboarding-card onboarding-model-card">
        <OnboardingModelSetup
          credentialValidated={credentialValidated}
          model={model}
          models={models}
          onCredentialValidated={onCredentialValidated}
          onModelChange={onModelChange}
          onProviderChange={onProviderChange}
          providerId={providerId}
          providers={providers}
        />
      </article>
      <div className="onboarding-provider-action">
        {ready ? (
          <span>
            <i>
              <Check size={10} />
            </i>
            Tested &amp; connected
          </span>
        ) : (
          <button
            className="onboarding-primary"
            onClick={onSave}
            disabled={
              busy ||
              !name.trim() ||
              !title.trim() ||
              !credentialValidated ||
              !model
            }
          >
            <Power size={13} />
            {busy ? 'Reaching provider…' : 'Save employee and test connection'}
          </button>
        )}
      </div>
    </>
  );
}

export function AssignStep({
  conversations,
  conversationId,
  setConversationId,
  approver,
  setApprover,
  members,
  supportsMemberList,
  directMessage,
  onSave,
  busy,
}: {
  conversations: ChannelConversation[];
  conversationId: string;
  setConversationId: (value: string) => void;
  approver: string;
  setApprover: (value: string) => void;
  members: string[];
  supportsMemberList: boolean;
  directMessage: boolean;
  onSave: () => void;
  busy: boolean;
}) {
  return (
    <>
      <Heading
        title="Put your agent to work"
        body="Give it one place to start and choose who approves riskier actions."
      />
      <article className="onboarding-card">
        <Field label="Give it one place to start">
          <select
            value={conversationId}
            onChange={(event) => {
              setConversationId(event.target.value);
              setApprover('');
            }}
          >
            <option value="">Select a discovered conversation</option>
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title ?? item.id}
              </option>
            ))}
          </select>
        </Field>
        {directMessage ? (
          <p className="onboarding-help">
            The direct-message counterpart will approve riskier actions.
          </p>
        ) : (
          <Field label="Who approves its riskier actions?">
            {supportsMemberList ? (
              <select
                value={approver}
                onChange={(event) => setApprover(event.target.value)}
                disabled={!conversationId || members.length === 0}
              >
                <option value="">
                  {conversationId && members.length === 0
                    ? 'No verified members found'
                    : 'Select a verified member'}
                </option>
                {members.map((memberId) => (
                  <option key={memberId} value={memberId}>
                    {memberId}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={approver}
                onChange={(event) => setApprover(event.target.value)}
                placeholder="Enter a verified member ID"
                disabled={!conversationId}
              />
            )}
          </Field>
        )}
        <small className="onboarding-help">
          Only members verified in this conversation can approve riskier
          actions.
        </small>
        <button
          className="onboarding-primary"
          onClick={onSave}
          disabled={busy || !conversationId || (!directMessage && !approver)}
        >
          {busy ? 'Saving…' : 'Continue'} <ChevronRight size={15} />
        </button>
      </article>
    </>
  );
}

export function HelloStep({
  handle,
  text,
  status,
  onProject,
  onRetry,
  busy,
}: {
  handle: string;
  text: string;
  status?:
    | 'pending'
    | 'inbound_received'
    | 'satisfied'
    | 'projection_failed'
    | 'expired'
    | 'completed';
  onProject: () => Promise<void>;
  onRetry: () => void;
  busy: boolean;
}) {
  const expired = status === 'expired';
  const received = status === 'inbound_received';
  const satisfied = status === 'satisfied' || status === 'projection_failed';
  const complete = status === 'completed';
  return (
    <>
      <Heading
        title={complete ? `${handle} is ready` : `Ping ${handle}`}
        body={
          complete
            ? 'Your agent received the message and delivered its reply.'
            : 'Open the selected workspace and mention it. Gantry waits here until the message lands.'
        }
      />
      <article className="onboarding-card onboarding-hello">
        <div className="onboarding-ping">
          <code>{text}</code>
          <CopyButton value={text} variant="ghost" size="xs" />
        </div>
        <GantryMark hero />
        <span className="onboarding-sweep">
          <i />
        </span>
        <p>
          {complete
            ? 'Connected and replying.'
            : expired
              ? 'This test code expired. Return to Assign Work to issue another.'
              : received
                ? 'Message received. Waiting for the agent’s reply…'
                : 'Waiting for your message and the agent’s reply…'}
        </p>
        <small className="onboarding-help">
          {complete
            ? 'Verification is complete.'
            : 'Success is only shown after the actual inbound message and correlated reply.'}
        </small>
        {satisfied ? (
          <button
            className="onboarding-primary"
            disabled={busy}
            onClick={() => void onProject()}
          >
            {busy ? 'Finishing setup…' : 'Finish setup'}
          </button>
        ) : null}
        {expired ? (
          <button className="onboarding-primary" onClick={onRetry}>
            Create a new test code
          </button>
        ) : null}
      </article>
    </>
  );
}

function Heading({ title, body }: { title: string; body: string }) {
  return (
    <header className="onboarding-heading">
      <h1>{title}</h1>
      <p>{body}</p>
    </header>
  );
}

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="onboarding-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
