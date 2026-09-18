import type { OnboardingDraft } from '../onboarding-state';
import { OnboardingWorkspaceStep } from '../onboarding-workspace-flow';

export function ConnectWorkspaceStep({
  connected,
  draft,
  onChange,
  setConnected,
}: {
  connected: boolean;
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  setConnected: (value: boolean) => void;
}) {
  return (
    <OnboardingWorkspaceStep
      agentName={draft.name}
      channelId={draft.channel}
      connected={connected}
      onChannelChange={(channel) => {
        onChange({ channel: channel as OnboardingDraft['channel'] });
        setConnected(false);
      }}
      onConnect={() => setConnected(true)}
    />
  );
}
