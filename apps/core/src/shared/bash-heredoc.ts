export interface HeredocRedirect {
  redirect: {
    operator: string;
    target: string;
    destructive: boolean;
    heredoc?: string;
  };
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

type HeredocOperatorParseResult =
  | {
      ok: true;
      redirect: {
        operator: string;
        target: string;
        destructive: boolean;
      };
      nextIndex: number;
      heredoc: HeredocRedirect;
    }
  | { ok: false; reason: string };

type HeredocBodiesParseResult =
  | { ok: true; nextIndex: number }
  | { ok: false; reason: string };

export function parseHeredocOperator(
  command: string,
  cursor: number,
  operatorPrefix: string,
): HeredocOperatorParseResult {
  let operator = `${operatorPrefix}<`;
  let delimiterStart = cursor + 1;
  const stripTabs = command[delimiterStart] === '-';
  if (stripTabs) {
    operator += '-';
    delimiterStart += 1;
  }
  while (command[delimiterStart] === ' ' || command[delimiterStart] === '\t') {
    delimiterStart += 1;
  }
  const delimiter = parseHeredocDelimiter(command, delimiterStart);
  if (!delimiter.ok) return delimiter;
  const redirect = {
    operator,
    target: delimiter.target,
    destructive: false,
  };
  return {
    ok: true,
    redirect,
    nextIndex: delimiter.nextIndex - 1,
    heredoc: {
      redirect,
      delimiter: delimiter.target,
      quoted: delimiter.quoted,
      stripTabs,
    },
  };
}

export function parseHeredocBodies(
  command: string,
  startIndex: number,
  heredocs: HeredocRedirect[],
): HeredocBodiesParseResult {
  let cursor = startIndex;
  for (const heredoc of heredocs) {
    const body: string[] = [];
    for (;;) {
      const newlineIndex = command.indexOf('\n', cursor);
      const line = command
        .slice(cursor, newlineIndex === -1 ? command.length : newlineIndex)
        .replace(/\r$/, '');
      const delimiterLine = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (delimiterLine === heredoc.delimiter) {
        heredoc.redirect.heredoc = body.join('');
        cursor = newlineIndex === -1 ? command.length : newlineIndex + 1;
        break;
      }
      if (newlineIndex === -1) {
        return { ok: false, reason: 'Bash heredoc delimiter not terminated.' };
      }
      body.push(
        heredoc.stripTabs
          ? command.slice(cursor, newlineIndex + 1).replace(/^\t+/, '')
          : command.slice(cursor, newlineIndex + 1),
      );
      cursor = newlineIndex + 1;
    }
    if (!heredoc.quoted && /[$`]/.test(heredoc.redirect.heredoc)) {
      return {
        ok: false,
        reason: 'Bash heredoc body uses unsupported expansion.',
      };
    }
  }
  return { ok: true, nextIndex: cursor };
}

export function parseHeredocDelimiter(
  command: string,
  startIndex: number,
):
  | { ok: true; target: string; quoted: boolean; nextIndex: number }
  | { ok: false; reason: string } {
  const first = command[startIndex];
  if (!first || /\s/.test(first)) {
    return { ok: false, reason: 'Bash redirection target missing.' };
  }
  if (first === "'" || first === '"') {
    const end = command.indexOf(first, startIndex + 1);
    if (end === -1) {
      return { ok: false, reason: 'Bash command has unmatched quotes.' };
    }
    const target = command.slice(startIndex + 1, end);
    return target
      ? { ok: true, target, quoted: true, nextIndex: end + 1 }
      : { ok: false, reason: 'Bash redirection target missing.' };
  }
  let cursor = startIndex;
  while (
    cursor < command.length &&
    !/\s/.test(command[cursor]) &&
    !['&', '|', ';', '(', ')', '<', '>'].includes(command[cursor])
  ) {
    cursor += 1;
  }
  const target = command.slice(startIndex, cursor);
  if (!target) {
    return { ok: false, reason: 'Bash redirection target missing.' };
  }
  if (target.includes('$') || target.includes('`')) {
    return {
      ok: false,
      reason: 'Bash redirection target uses unsupported expansion.',
    };
  }
  return { ok: true, target, quoted: false, nextIndex: cursor };
}
