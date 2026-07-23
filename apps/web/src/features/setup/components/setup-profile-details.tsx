import { useEffect, useState } from 'react';

import { RuntimeApiError } from '../../../lib/api/runtime-transport';
import { Button } from '../../../ui/primitives/button';
import { useSaveSetupProfile, useSetupProfile } from '../use-setup-profile';

export function SetupProfileDetails({
  agentId,
  onDirty,
  onSaved,
}: {
  agentId?: string;
  onDirty: () => void;
  onSaved: () => void;
}) {
  const profile = useSetupProfile(agentId);
  const saveProfile = useSaveSetupProfile();
  const [content, setContent] = useState('');
  const profileMissing =
    profile.error instanceof RuntimeApiError && profile.error.status === 404;

  useEffect(() => {
    if (!profile.data) return;
    setContent(profile.data.content);
    onSaved();
  }, [onSaved, profile.data]);

  if (!agentId) {
    return (
      <p className="m-0 text-sm text-text-secondary">
        Create the agent first, then add its operating instructions here.
      </p>
    );
  }

  if (profile.isPending) {
    return <p className="m-0 text-sm text-text-secondary">Loading profile…</p>;
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Operating instructions
        <textarea
          className="min-h-56 rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal text-text placeholder:text-text-muted"
          placeholder="Describe the agent's role, priorities, tone, and boundaries."
          value={content}
          onChange={(event) => {
            onDirty();
            setContent(event.target.value);
          }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={saveProfile.isPending}
          onClick={() =>
            saveProfile.mutate(
              {
                agentId,
                content,
                expectedVersion: profile.data?.version,
              },
              { onSuccess: onSaved },
            )
          }
        >
          {saveProfile.isPending ? 'Saving profile…' : 'Save profile'}
        </Button>
        {saveProfile.data ? (
          <span className="text-sm text-status-ready">Profile saved.</span>
        ) : null}
      </div>
      {profileMissing ? (
        <p className="m-0 text-sm text-text-secondary">
          No profile exists yet. Add instructions and save to create one.
        </p>
      ) : null}
      {profile.isError && !profileMissing ? (
        <p className="m-0 text-sm text-danger">{profile.error.message}</p>
      ) : null}
      {saveProfile.isError ? (
        <p className="m-0 text-sm text-danger">{saveProfile.error.message}</p>
      ) : null}
    </div>
  );
}
