import path from 'path';
function readRuntimeHomeArg(argv) {
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--runtime-home') {
            const next = argv[i + 1];
            return next && !next.startsWith('-') ? next : undefined;
        }
        if (arg?.startsWith('--runtime-home=')) {
            return arg.slice('--runtime-home='.length);
        }
    }
    return undefined;
}
const runtimeHomeArg = readRuntimeHomeArg(process.argv)?.trim();
if (runtimeHomeArg) {
    process.env.GANTRY_HOME = path.resolve(runtimeHomeArg);
}
