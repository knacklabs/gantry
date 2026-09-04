import {
  PermissionLane,
  type PermissionLane as PermissionLaneValue,
} from '../../domain/permission-lane.js';
import {
  bashExecutableName,
  parseBashCommandForHardBoundaryAnalysis,
} from '../../shared/bash-command-parser.js';
import {
  type AutoLaneAnalysis,
  type AutoLaneAnalysisInput,
  isSensitivePathShape,
} from './auto-lane-analysis-types.js';

const WRITE_CAPABLE_FIND_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
]);
const LINK_FOLLOWING_FIND_OPTIONS = new Set(['-H', '-L', '-follow']);
const INDIRECT_FIND_ROOT_OPTIONS = new Set([
  '-f',
  '-files0-from',
  '--files0-from',
]);
const READ_ONLY_FIND_ARGUMENT_ARITY = new Map<string, 0 | 1>([
  ['!', 0],
  ['-a', 0],
  ['-and', 0],
  ['-daystart', 0],
  ['-depth', 0],
  ['-empty', 0],
  ['-executable', 0],
  ['-false', 0],
  ['-ignore_readdir_race', 0],
  ['-ls', 0],
  ['-mount', 0],
  ['-noignore_readdir_race', 0],
  ['-nogroup', 0],
  ['-noleaf', 0],
  ['-not', 0],
  ['-nouser', 0],
  ['-nowarn', 0],
  ['-o', 0],
  ['-or', 0],
  ['-print', 0],
  ['-print0', 0],
  ['-prune', 0],
  ['-quit', 0],
  ['-readable', 0],
  ['-true', 0],
  ['-warn', 0],
  ['-writable', 0],
  ['-xdev', 0],
  ['-amin', 1],
  ['-anewer', 1],
  ['-atime', 1],
  ['-cmin', 1],
  ['-cnewer', 1],
  ['-context', 1],
  ['-ctime', 1],
  ['-fstype', 1],
  ['-gid', 1],
  ['-group', 1],
  ['-ilname', 1],
  ['-iname', 1],
  ['-inum', 1],
  ['-ipath', 1],
  ['-iregex', 1],
  ['-iwholename', 1],
  ['-links', 1],
  ['-lname', 1],
  ['-maxdepth', 1],
  ['-mindepth', 1],
  ['-mmin', 1],
  ['-mtime', 1],
  ['-name', 1],
  ['-newer', 1],
  ['-path', 1],
  ['-perm', 1],
  ['-printf', 1],
  ['-regex', 1],
  ['-regextype', 1],
  ['-samefile', 1],
  ['-size', 1],
  ['-type', 1],
  ['-uid', 1],
  ['-used', 1],
  ['-user', 1],
  ['-wholename', 1],
  ['-xtype', 1],
]);

export function deriveAutoLaneAnalysis(
  input: AutoLaneAnalysisInput,
): AutoLaneAnalysis {
  return Object.freeze({
    lane: permissionLane(input.permissionMode, input.hostJobId),
    readOnlyMetaExecutor: isReadOnlyFind(input.command),
  });
}

function permissionLane(
  permissionMode: AutoLaneAnalysisInput['permissionMode'],
  hostJobId: string | undefined,
): PermissionLaneValue {
  if (hostJobId) return PermissionLane.Autonomous;
  if (permissionMode === 'auto') return PermissionLane.InteractiveAuto;
  if (permissionMode === 'auto_strict') return PermissionLane.AutoStrict;
  return PermissionLane.Ask;
}

function isReadOnlyFind(command: string | undefined): boolean {
  if (!command || /[()]/.test(command)) return false;
  const parsed = parseBashCommandForHardBoundaryAnalysis(command);
  if (
    !parsed.ok ||
    parsed.piped ||
    parsed.leaves.length !== 1 ||
    parsed.leaves[0]!.redirects.length > 0
  ) {
    return false;
  }
  const argv = parsed.leaves[0]!.argv;
  if (bashExecutableName(argv[0] ?? '') !== 'find') return false;
  const args = argv.slice(1);
  if (
    args.some(
      (arg) =>
        WRITE_CAPABLE_FIND_ACTIONS.has(arg) ||
        LINK_FOLLOWING_FIND_OPTIONS.has(arg) ||
        INDIRECT_FIND_ROOT_OPTIONS.has(arg) ||
        [...INDIRECT_FIND_ROOT_OPTIONS].some((option) =>
          arg.startsWith(`${option}=`),
        ) ||
        isSensitivePathShape(arg),
    )
  ) {
    return false;
  }
  return hasOnlyRecognizedReadOnlyFindArguments(args);
}

function hasOnlyRecognizedReadOnlyFindArguments(
  args: readonly string[],
): boolean {
  let pathSeen = false;
  let expressionStarted = false;
  let expectsValue = false;
  for (const arg of args) {
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    if (arg === '-P' && !pathSeen && !expressionStarted) continue;
    const arity = READ_ONLY_FIND_ARGUMENT_ARITY.get(arg);
    if (arity !== undefined) {
      expressionStarted = true;
      expectsValue = arity === 1;
      continue;
    }
    if (arg.startsWith('-') || expressionStarted) return false;
    pathSeen = true;
  }
  return !expectsValue;
}
