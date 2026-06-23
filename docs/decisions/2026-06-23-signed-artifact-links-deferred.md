# Signed Artifact Links Deferred

## Context

Some channels cannot upload files directly. A host-served signed artifact link
could provide fallback access, but that introduces a new HTTP surface, expiry
policy, audit requirements, and access-control boundary.

## Decision

Do not add signed artifact download links in the current agent communication UX
slice. Unsupported file delivery should degrade to concise artifact names and
instructions that the artifact is available through Gantry-managed file
surfaces, without exposing storage refs or local filesystem paths.

## Alternatives considered

- Add a quick signed download endpoint. Rejected because link signing,
  revocation, expiry, and authorization need their own threat model.
- Expose local file paths in channel messages. Rejected because channels are not
  trusted filesystem authorities.

## Consequences

The file-delivery slice must stay inside existing FileArtifact and channel
delivery boundaries. A future signed-link feature needs a separate plan,
security review, and tests.

## Rollback or migration notes

No migration is required because no signed URL state is introduced.
