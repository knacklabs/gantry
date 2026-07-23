import { Button } from '../../../ui/primitives/button';
import { useCreateSetupAgent } from '../use-create-setup-agent';
import { useSaveSetupProfile } from '../use-setup-profile';

export function SetupAgentDetails({
  connected,
  name,
  purpose,
  onChange,
  onCreated,
  onProfileSaved,
  showValidation,
}: {
  connected: boolean;
  name: string;
  purpose: string;
  onChange: (field: 'name' | 'purpose', value: string) => void;
  onCreated: (agentId: string) => void;
  onProfileSaved: () => void;
  showValidation: boolean;
}) {
  const createAgent = useCreateSetupAgent();
  const saveProfile = useSaveSetupProfile();
  const disabled =
    !connected ||
    !name.trim() ||
    !purpose.trim() ||
    createAgent.isPending ||
    saveProfile.isPending ||
    Boolean(createAgent.data);

  return (
    <div className="grid gap-5">
      <SetupTextField
        label="Agent name"
        placeholder="e.g. Operations Assistant"
        value={name}
        invalid={showValidation && !name.trim()}
        onChange={(value) => onChange('name', value)}
      />
      <SetupTextField
        label="Purpose"
        placeholder="What should this agent help with?"
        value={purpose}
        invalid={showValidation && !purpose.trim()}
        onChange={(value) => onChange('purpose', value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={disabled}
          onClick={() =>
            createAgent.mutate(name.trim(), {
              onSuccess: (agent) => {
                onCreated(agent.id);
                saveProfile.mutate(
                  {
                    agentId: agent.id,
                    content: profileFromPurpose(purpose),
                  },
                  { onSuccess: onProfileSaved },
                );
              },
            })
          }
        >
          {createAgent.data
            ? 'Agent created'
            : createAgent.isPending
              ? 'Creating agent…'
              : 'Create agent'}
        </Button>
        {!connected ? (
          <span className="text-sm text-text-muted">
            Connect Gantry to create the agent.
          </span>
        ) : null}
      </div>
      {createAgent.isError ? (
        <p className="m-0 text-sm text-danger">{createAgent.error.message}</p>
      ) : null}
      {saveProfile.isError ? (
        <p className="m-0 text-sm text-danger">
          The agent was created, but its purpose could not be saved. Add it in
          the Profile stage before finishing setup.
        </p>
      ) : null}
      {createAgent.data ? (
        <p className="m-0 text-sm text-status-ready">
          {createAgent.data.name} is created and ready for the remaining setup.
        </p>
      ) : null}
    </div>
  );
}

function profileFromPurpose(purpose: string): string {
  return `# Operating instructions\n\n## Purpose\n\n${purpose.trim()}\n`;
}

function SetupTextField({
  label,
  placeholder,
  value,
  invalid,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <input
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? (
        <span className="font-normal text-danger">
          Enter a {label.toLowerCase()} to continue.
        </span>
      ) : null}
    </label>
  );
}
