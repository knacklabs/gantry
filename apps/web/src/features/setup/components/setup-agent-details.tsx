import { Button } from '../../../ui/primitives/button';
import { useCreateSetupAgent } from '../use-create-setup-agent';

export function SetupAgentDetails({
  connected,
  name,
  purpose,
  onChange,
}: {
  connected: boolean;
  name: string;
  purpose: string;
  onChange: (field: 'name' | 'purpose', value: string) => void;
}) {
  const createAgent = useCreateSetupAgent();
  const disabled =
    !connected ||
    !name.trim() ||
    !purpose.trim() ||
    createAgent.isPending ||
    Boolean(createAgent.data);

  return (
    <div className="grid gap-5">
      <SetupTextField
        label="Agent name"
        placeholder="e.g. Operations Assistant"
        value={name}
        onChange={(value) => onChange('name', value)}
      />
      <SetupTextField
        label="Purpose"
        placeholder="What should this agent help with?"
        value={purpose}
        onChange={(value) => onChange('purpose', value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={disabled}
          onClick={() => createAgent.mutate(name.trim())}
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
      {createAgent.data ? (
        <p className="m-0 text-sm text-status-ready">
          {createAgent.data.name} is created and ready for the remaining setup.
        </p>
      ) : null}
    </div>
  );
}

function SetupTextField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <input
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
