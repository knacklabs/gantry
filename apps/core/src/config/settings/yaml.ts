function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
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
  // Integers only: decimal-looking scalars (channel thread timestamps like
  // 171.222, version strings) must stay strings; number fields that accept
  // decimals coerce locally in their strict parsers.
  if (/^-?[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('[') && value.endsWith(']')) {
    return parseStringArray(value);
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
  const stack: Array<{
    indent: number;
    value: Record<string, unknown> | unknown[];
    parent?: Record<string, unknown>;
    key?: string;
  }> = [{ indent: -1, value: root }];

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

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parentEntry = stack[stack.length - 1];
    let parent = parentEntry?.value;
    if (!parentEntry || !parent) {
      throw new Error(`invalid indentation nesting (line ${lineNo + 1})`);
    }

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        if (
          parentEntry.parent &&
          parentEntry.key &&
          !Array.isArray(parent) &&
          Object.keys(parent).length === 0
        ) {
          const list: unknown[] = [];
          parentEntry.parent[parentEntry.key] = list;
          parentEntry.value = list;
          parent = list;
        } else {
          throw new Error(`unexpected list item (line ${lineNo + 1})`);
        }
      }
      const itemRaw = trimmed.slice(2).trim();
      if (!itemRaw) {
        const child: Record<string, unknown> = {};
        parent.push(child);
        stack.push({ indent, value: child });
        continue;
      }
      if (itemRaw.includes(':')) {
        const { key, rest } = splitKeyValue(itemRaw, lineNo);
        const child: Record<string, unknown> = {};
        parent.push(child);
        if (!rest) {
          const nested: Record<string, unknown> = {};
          setMappingValue(child, key, nested, lineNo);
          stack.push({ indent, value: child });
          stack.push({ indent: indent + 2, value: nested, parent: child, key });
          continue;
        }
        setMappingValue(child, key, parseScalar(rest), lineNo);
        stack.push({ indent, value: child });
        continue;
      }
      parent.push(parseScalar(itemRaw));
      continue;
    }

    if (Array.isArray(parent)) {
      throw new Error(`expected list item (line ${lineNo + 1})`);
    }

    const { key, rest } = splitKeyValue(trimmed, lineNo);
    if (!rest) {
      const child: Record<string, unknown> = {};
      setMappingValue(parent, key, child, lineNo);
      stack.push({ indent, value: child, parent, key });
      continue;
    }

    setMappingValue(parent, key, parseScalar(rest), lineNo);
  }

  return root;
}

function setMappingValue(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
  lineNo: number,
): void {
  if (Object.hasOwn(parent, key)) {
    throw new Error(`duplicate key "${key}" (line ${lineNo + 1})`);
  }
  parent[key] = value;
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
