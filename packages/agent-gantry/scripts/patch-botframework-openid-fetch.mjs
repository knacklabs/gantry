import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const ORIGINAL_OPENID_FETCH = "const res = yield (0, node_fetch_1.default)(this.url, { agent: agent });";
const PATCHED_OPENID_FETCH =
  "const res = yield (0, node_fetch_1.default)(this.url, { agent: agent, headers: { 'accept-encoding': 'identity' } });";
const ORIGINAL_JWKS_FETCH =
  "const getKeyResponse = yield (0, node_fetch_1.default)(openIdConfig.jwks_uri, { agent: agent });";
const PATCHED_JWKS_FETCH =
  "const getKeyResponse = yield (0, node_fetch_1.default)(openIdConfig.jwks_uri, { agent: agent, headers: { 'accept-encoding': 'identity' } });";

const args = new Set(process.argv.slice(2));
const root = readOption("--root") ?? process.cwd();
const fallbackRoot = readOption("--fallback-root");
const verifyOnly = args.has("--verify");
const allowMissing = args.has("--allow-missing");

function readOption(name) {
  const prefix = `${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return null;
}

function fail(message) {
  process.stderr.write(`Bot Framework OpenID fetch patch failed: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function findOpenIdMetadataFiles(startPath) {
  const files = [];
  const stack = [resolve(startPath)];
  const ignoredDirectories = new Set([".git", ".turbo", "dist", "coverage"]);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) continue;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!path.endsWith(`${sep}botframework-connector${sep}lib${sep}auth${sep}openIdMetadata.js`)) continue;
      files.push(path);
    }
  }

  return files.sort();
}

function patchFile(path) {
  const before = readFileSync(path, "utf8");
  let after = before;
  after = after.replace(ORIGINAL_OPENID_FETCH, PATCHED_OPENID_FETCH);
  after = after.replace(ORIGINAL_JWKS_FETCH, PATCHED_JWKS_FETCH);

  if (!after.includes(PATCHED_OPENID_FETCH) || !after.includes(PATCHED_JWKS_FETCH)) {
    fail(`${path} does not contain the expected Bot Framework OpenID fetch calls.`);
  }

  if (after !== before) {
    writeFileSync(path, after);
    info(`Patched ${path}`);
  } else {
    info(`Already patched ${path}`);
  }
}

function verifyFile(path) {
  const content = readFileSync(path, "utf8");
  if (!content.includes(PATCHED_OPENID_FETCH) || !content.includes(PATCHED_JWKS_FETCH)) {
    fail(`${path} is missing accept-encoding: identity on Bot Framework OpenID/JWKS fetches.`);
  }
  info(`Verified ${path}`);
}

const resolvedRoot = resolve(root);
if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
  fail(`root is not a directory: ${resolvedRoot}`);
}

let files = findOpenIdMetadataFiles(resolvedRoot);
if (files.length === 0 && fallbackRoot) {
  files = findOpenIdMetadataFiles(resolve(fallbackRoot));
}
if (files.length === 0) {
  if (allowMissing) {
    info(`No botframework-connector openIdMetadata.js files found under ${resolvedRoot}.`);
    process.exit(0);
  }
  fail(`no botframework-connector openIdMetadata.js files found under ${resolvedRoot}`);
}

for (const file of files) {
  if (verifyOnly) {
    verifyFile(file);
  } else {
    patchFile(file);
    verifyFile(file);
  }
}
