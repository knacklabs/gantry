function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string' && item.trim())
    ) {
      return parsed.map((item) => item.trim());
    }
  } catch {
    // Fallback parser below.
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(',')
    .map((item) => unquote(item))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '{}') return {};
  if (/^-?[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fallback parser below supports unquoted string arrays.
    }
    return parseStringArray(value);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Keep treating non-JSON inline objects as strings.
    }
  }
  return unquote(value);
}

function splitKeyValue(
  trimmedLine: string,
  lineNo: number,
): { key: string; rest: string } {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmedLine.length; i += 1) {
    const ch = trimmedLine[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === ':' && !inSingle && !inDouble) {
      const keyRaw = trimmedLine.slice(0, i).trim();
      const rest = trimmedLine.slice(i + 1).trim();
      if (!keyRaw) {
        throw new Error(`missing key before ':' (line ${lineNo + 1})`);
      }
      return { key: unquote(keyRaw), rest };
    }
  }

  throw new Error(`expected "key: value" mapping (line ${lineNo + 1})`);
}

export function parseSimpleYamlObject(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];

  const lines = raw.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) {
      throw new Error(`tabs are not supported (line ${lineNo + 1})`);
    }

    const indent = line.match(/^ */)?.[0].length || 0;
    if (indent % 2 !== 0) {
      throw new Error(
        `indentation must be 2-space aligned (line ${lineNo + 1})`,
      );
    }

    const trimmed = line.trim();
    const { key, rest } = splitKeyValue(trimmed, lineNo);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.value;
    if (!parent) {
      throw new Error(`invalid indentation nesting (line ${lineNo + 1})`);
    }

    if (!rest) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseScalar(rest);
  }

  return root;
}

export function quoteYamlString(value: string): string {
  if (
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    !/^(true|false|null)$/i.test(value) &&
    !/^-?[0-9]+$/.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}
