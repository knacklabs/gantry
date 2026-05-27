# Interakt Channel

## Customer-Facing Output

- Interakt outbound text is customer-visible WhatsApp copy; do not expose internal tool names, access-control names, signed-header mechanics, back-office instructions, bypass language, or diagnostic identifiers.
- If a customer asks for data that does not match the phone number they are messaging from, use a plain mismatch explanation instead of internal policy or support-tool details.
- Keep provider-specific webhook payload parsing and outbound API details inside this adapter boundary.
