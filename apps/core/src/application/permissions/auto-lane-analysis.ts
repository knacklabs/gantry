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
  const firstArg = args[0];
  return !firstArg || firstArg === '-P' || !firstArg.startsWith('-');
}
