import { Button } from '../../../ui/primitives/button';
import { useSetSetupAgentModel } from '../use-set-setup-agent-model';

export function SetupModelSave({
  agentId,
  modelAlias,
  onSaved,
}: {
  agentId?: string;
  modelAlias: string;
  onSaved: (modelAlias: string) => void;
}) {
  const saveModel = useSetSetupAgentModel();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={!agentId || !modelAlias || saveModel.isPending}
        onClick={() => {
          if (!agentId || !modelAlias) return;
          saveModel.mutate(
            { agentId, modelAlias },
            { onSuccess: () => onSaved(modelAlias) },
          );
        }}
      >
        {saveModel.isPending ? 'Saving model…' : 'Save model'}
      </Button>
      {!agentId ? (
        <span className="text-sm text-text-muted">
          Create the agent before selecting its model.
        </span>
      ) : null}
      {saveModel.isError ? (
        <span className="text-sm text-danger">{saveModel.error.message}</span>
      ) : null}
      {saveModel.data ? (
        <span className="text-sm text-status-ready">Model saved.</span>
      ) : null}
    </div>
  );
}
