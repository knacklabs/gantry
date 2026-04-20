import { MemoryItem } from '../memory-types.js';

const CONSOLIDATE_SYSTEM_PROMPT = `Merge these duplicate memory facts into ONE canonical fact.

RULES
- Output value must only contain information present in the inputs.
- If inputs disagree, prefer the highest-confidence OR most recent; note the conflict in why.
- One human sentence, present tense, third-person.
- Preserve verbatim: names, IDs, paths, numbers, dates.

OUTPUT strict JSON: {key, value, why, confidence, retired_ids}`;

const FEW_SHOT_SECTION = [
  'Example 1',
  'input: id=a1 value="Ravi prefers concise answers." | id=a2 value="Keep responses concise and direct."',
  'output: {"key":"preference:concise-responses","value":"Ravi prefers concise and direct responses.","why":"Both inputs state concise response preference.","confidence":0.9,"retired_ids":["a1","a2"]}',
  '',
  'Example 2',
  'input: id=b1 value="Use apps/core/test/unit for unit tests." | id=b2 value="Unit tests live under apps/core/test/unit."',
  'output: {"key":"decision:unit-tests-path","value":"Unit tests live under apps/core/test/unit.","why":"Both facts specify the same unit-test path.","confidence":0.92,"retired_ids":["b1","b2"]}',
  '',
  'Example 3',
  'input: id=c1 value="No colocated *.test.ts under src." | id=c2 value="Tests should not live in src trees."',
  'output: {"key":"constraint:no-src-tests","value":"Tests must not be colocated under src trees.","why":"Both inputs prohibit tests inside src.","confidence":0.9,"retired_ids":["c1","c2"]}',
  '',
  'Example 4',
  'input: id=d1 value="IPC lock recovery reclaims dead PID locks only." | id=d2 value="Do not reclaim malformed lock metadata."',
  'output: {"key":"constraint:ipc-lock-recovery","value":"IPC lock recovery reclaims only locks whose owner PID is confirmed dead.","why":"d2 narrows d1 by excluding malformed-metadata reclaim.","confidence":0.88,"retired_ids":["d1","d2"]}',
  '',
  'Reject hallucination example A',
  'input: id=e1 value="Use SQLite memory provider."',
  'bad output: {"value":"Use PostgreSQL memory provider."} # invalid: introduces absent fact',
  '',
  'Reject hallucination example B',
  'input: id=f1 value="Project name is MyClaw."',
  'bad output: {"value":"Project version is 2.0."} # invalid: version absent in inputs',
].join('\n');

export function buildConsolidationPrompt(items: MemoryItem[]): string {
  const inputRows = items.map((item, idx) => {
    return `${idx + 1}. id=${item.id} key=${item.key} confidence=${item.confidence} updated_at=${item.updated_at} value=${item.value}`;
  });

  return [
    CONSOLIDATE_SYSTEM_PROMPT,
    '',
    FEW_SHOT_SECTION,
    '',
    'Facts:',
    ...inputRows,
  ].join('\n');
}
