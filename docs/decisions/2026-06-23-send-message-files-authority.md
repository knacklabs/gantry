# Send Message Files Authority

## Context

`send_message` is a first-party Gantry MCP tool. File artifacts are owned by
`appId` and source agent identity, and channel delivery adapters differ in
whether they can upload files.

## Decision

`send_message` may reference only FileArtifact records owned by the requesting
agent's current app and source folder. The parent runtime must resolve artifact
metadata before delivery and pass only channel-safe descriptors to adapters.
Channel adapters may attach files only when the provider path is verified and
authorized; otherwise they must degrade to concise text that names the artifact
without exposing storage refs or local paths.

## Alternatives considered

- Let agents pass arbitrary local paths to `send_message`. Rejected because it
  bypasses FileArtifact ownership and sandbox boundaries.
- Put provider-specific upload inputs directly in the MCP schema. Rejected
  because `send_message` is a provider-neutral facade.

## Consequences

File delivery changes must preserve FileArtifact ownership checks and same-agent
target routing. Unsupported providers return delivery warnings or visible
degrade copy rather than failing with raw storage details.

## Rollback or migration notes

Artifact attachment support can be removed from adapters while keeping
`send_message` text delivery unchanged.
