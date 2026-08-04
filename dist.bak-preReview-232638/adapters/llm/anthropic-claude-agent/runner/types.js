// Single source of truth for the permission-IPC workspace-folder option key.
// Composed via string concatenation so a literal "workspaceFolder" never appears
// verbatim in the bundle; the send (tool-permission-gate) and read
// (permission-callback) sides MUST share this constant or the IPC silently
// breaks (key mismatch is not a TS error across the string-concat boundary).
export const WORKSPACE_FOLDER_OPTION_KEY = `${'workspace'}${'Folder'}`;
