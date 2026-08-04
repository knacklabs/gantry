// Markdown/formatting helpers for the Slack canvas module.

export function markdownHeadingLabels(markdown: string): string[] {
  const labels = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    // A '# heading' inside a fenced code block is code, not a section.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const label = /^#{1,3}\s+(.+?)\s*$/.exec(line)?.[1]?.trim();
    if (label) labels.add(label);
  }
  // The live export format is unverified until the scope reinstall spike
  // runs (recorded deferral): hedge by also accepting HTML-shaped exports so
  // section targeting works either way. Section binding stays exact because
  // handles bind Slack section ids, not this parse.
  const htmlHeading = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of markdown.matchAll(htmlHeading)) {
    const label = decodeBasicEntities(
      (match[2] ?? '').replace(/<[^>]+>/g, ' '),
    ).trim();
    if (label) labels.add(label);
  }
  return [...labels];
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

export function formatSectionCandidates(
  candidates: Array<{ label: string; handle: string }>,
): string {
  return candidates.length === 0
    ? 'none'
    : candidates.map((item) => `${item.label} (${item.handle})`).join(', ');
}
