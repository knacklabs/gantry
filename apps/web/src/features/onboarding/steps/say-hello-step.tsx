import { CopyButton } from '../../../ui/primitives/copy-button';
import { GantryMark } from '../components/onboarding-shell';
import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

export function SayHelloStep({ draft }: { draft: OnboardingDraft }) {
  const handle = `@${
    draft.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') || 'your-agent'
  }`;
  const text = `${handle} are you there?`;

  return (
    <>
      <Heading
        body="Open the selected workspace and mention it. This preview does not send a message."
        title={`Ping ${handle}`}
      />
      <article className="onboarding-card onboarding-hello">
        <div className="onboarding-ping">
          <code>{text}</code>
          <CopyButton
            label="Copy mention"
            size="xs"
            value={text}
            variant="ghost"
          />
        </div>
        <GantryMark hero />
        <span className="onboarding-sweep">
          <i />
        </span>
        <p>Waiting for your message and the agent’s reply…</p>
        <small className="onboarding-help">
          No message or agent is created in this preview.
        </small>
      </article>
    </>
  );
}
