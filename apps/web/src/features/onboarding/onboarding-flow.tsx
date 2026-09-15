import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Moon, Sun } from 'lucide-react';

import {
  gantryRailStepFour,
  gantryRailStepFourReduced,
  gantryRailStepOne,
  gantryRailStepOneReduced,
  gantryRailStepThree,
  gantryRailStepThreeReduced,
  gantryRailStepTwo,
  gantryRailStepTwoReduced,
  knacklabsMark,
} from '../../assets/onboarding';
import { usePreferences } from '../preferences/preferences-provider';
import { GantryMark } from './onboarding-mark';
import { OnboardingSplash } from './onboarding-splash';
import { AssignStep, EmployeeStep, HelloStep } from './onboarding-step-content';
import { OnboardingWorkspaceStep } from './onboarding-workspace-flow';
import { useOnboardingController } from './use-onboarding-controller';

const STEPS = [
  [
    'Create Employee',
    'Give it a model to think with. All of it can change later.',
  ],
  ['Connect Workspace', 'Install Gantry where your team already talks.'],
  [
    'Assign Work',
    'Choose the channel it works in and who signs off on anything risky.',
  ],
  ['Say Hello', 'Mention it once to confirm messages reach it and it replies.'],
] as const;

const RAIL_MARKS = [
  [gantryRailStepOne, gantryRailStepOneReduced],
  [gantryRailStepTwo, gantryRailStepTwoReduced],
  [gantryRailStepThree, gantryRailStepThreeReduced],
  [gantryRailStepFour, gantryRailStepFourReduced],
] as const;

export function OnboardingFlow() {
  const flow = useOnboardingController();
  const { effectiveTheme, preferences, setTheme } = usePreferences();
  if (!flow.started) {
    return (
      <OnboardingSplash
        name={flow.name}
        onName={(value) => flow.updateDraft('name', value)}
        onStart={() => flow.setStarted(true)}
        onTitle={(value) => flow.updateDraft('title', value)}
        resume={flow.status.data?.resume}
        title={flow.title}
      />
    );
  }

  const verificationStatus = flow.verification.data?.verification.status;
  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <div className="onboarding-header-controls">
          <Link to="/overview" className="onboarding-brand">
            <GantryMark />
            <strong>Gantry</strong>
          </Link>
          <span className="onboarding-rule" />
        </div>
        <button
          className="onboarding-theme"
          onClick={() => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          <span className={effectiveTheme === 'dark' ? 'is-dark' : ''}>
            {effectiveTheme === 'dark' ? <Moon size={11} /> : <Sun size={12} />}
          </span>
        </button>
      </header>
      <div className="onboarding-grid">
        <aside className="onboarding-rail">
          <div className="onboarding-rail-mark">
            <img
              src={RAIL_MARKS[flow.step - 1][preferences.reduceMotion ? 1 : 0]}
              alt=""
              aria-hidden="true"
            />
          </div>
          <div className="onboarding-steps">
            {STEPS.map(([label, blurb], index) => {
              const number = index + 1;
              const active = flow.step === number;
              const complete = flow.step > number;
              return (
                <button
                  key={label}
                  disabled={number > flow.step}
                  onClick={() => flow.setStep(number)}
                  className="onboarding-step"
                >
                  <span
                    className={`onboarding-node ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}
                  >
                    {complete ? <Check size={13} /> : number}
                  </span>
                  <span>
                    <b>{label}</b>
                    <small>{blurb}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <a
            className="onboarding-powered"
            href="https://www.knacklabs.ai"
            target="_blank"
            rel="noreferrer"
          >
            <img src={knacklabsMark} alt="" aria-hidden="true" />
            <strong>KnackLabs</strong>
          </a>
        </aside>
        <main
          className={`onboarding-main ${flow.step === 2 ? '!overflow-hidden' : ''}`}
        >
          <section
            className={`onboarding-content ${flow.step === 2 ? 'md:!m-0 md:!mx-auto md:h-full md:min-h-0 md:!content-start' : ''}`}
          >
            {flow.step === 1 ? (
              <EmployeeStep
                name={flow.name}
                title={flow.title}
                providers={flow.providers.data ?? []}
                providerId={
                  flow.providerId || flow.providers.data?.[0]?.providerId || ''
                }
                onProviderChange={(value) => {
                  flow.setProviderId(value);
                  flow.setModel('');
                  flow.setCredentialValidated(false);
                  flow.setStepOneReady(false);
                }}
                model={flow.model}
                onModelChange={(value) => {
                  if (value !== flow.model) flow.setStepOneReady(false);
                  flow.setModel(value);
                }}
                models={flow.availableModels}
                credentialValidated={flow.credentialValidated}
                onCredentialValidated={flow.setCredentialValidated}
                onSave={flow.createEmployee}
                busy={flow.busy}
                ready={flow.stepOneReady}
              />
            ) : null}
            {flow.step === 2 ? (
              <OnboardingWorkspaceStep
                agentName={flow.name}
                channel={flow.selectedChannel}
                channels={flow.channelProviders.data?.providers ?? []}
                channelId={flow.channelId || flow.selectedChannel?.id || ''}
                hasStoredAccount={Boolean(flow.accountId)}
                values={flow.channelValues}
                setValues={flow.setChannelValues}
                connected={flow.workspaceConnected}
                onConnect={flow.connectWorkspace}
                onChannelChange={(value) => {
                  flow.setChannelId(value);
                  flow.setChannelValues({});
                  flow.setAccountId('');
                  flow.setWorkspaceConnected(false);
                  flow.setConversationId('');
                  flow.setApprover('');
                  flow.setAssignmentReady(false);
                }}
                busy={flow.busy}
              />
            ) : null}
            {flow.step === 3 ? (
              <AssignStep
                conversations={flow.conversations.data?.conversations ?? []}
                conversationId={flow.conversationId}
                setConversationId={(value) => {
                  flow.setConversationId(value);
                  flow.setAssignmentReady(false);
                }}
                approver={flow.approver}
                setApprover={(value) => {
                  flow.setApprover(value);
                  flow.setAssignmentReady(false);
                }}
                members={flow.conversationMembers.data?.memberIds ?? []}
                supportsMemberList={flow.channelId === 'slack'}
                directMessage={flow.selectedConversation?.kind === 'direct'}
                onSave={flow.assignWork}
                busy={flow.busy}
              />
            ) : null}
            {flow.step === 4 ? (
              <HelloStep
                handle={flow.handle}
                text={flow.challenge}
                status={verificationStatus}
                onProject={flow.projectVerifiedSetup}
                onRetry={() => flow.setStep(3)}
                busy={flow.busy}
              />
            ) : null}
            {flow.error ? (
              <p className="onboarding-error" role="alert">
                {flow.error}
              </p>
            ) : null}
          </section>
          <footer className="onboarding-actions">
            <button
              onClick={() =>
                flow.step === 1
                  ? flow.setStarted(false)
                  : flow.setStep(flow.step - 1)
              }
              className="onboarding-secondary"
            >
              Back
            </button>
            {flow.step === 1 || flow.step === 2 ? (
              <button
                className="onboarding-primary"
                onClick={() => {
                  if (flow.step === 1 && flow.stepOneReady) flow.setStep(2);
                  if (flow.step === 2 && flow.workspaceConnected)
                    flow.setStep(3);
                }}
                disabled={
                  flow.step === 1
                    ? !flow.stepOneReady
                    : !flow.workspaceConnected
                }
              >
                Continue <ChevronRight size={15} />
              </button>
            ) : flow.step === 4 ? (
              <button
                onClick={flow.openConsole}
                className="onboarding-primary"
                disabled={verificationStatus !== 'completed'}
              >
                Open the console <ChevronRight size={15} />
              </button>
            ) : null}
          </footer>
        </main>
      </div>
    </div>
  );
}
