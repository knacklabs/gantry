import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import { awsSecretsManagerRuntimeSecretRef, envRuntimeSecretRef, gantryRuntimeSecretRef, } from '../domain/ports/runtime-secret-provider.js';
import { parseEnvContent } from '../shared/env-file.js';
import { hasValidEncryptionSecret } from '../shared/security-posture.js';
import { storeRuntimeSecretInput } from './credentials.js';
async function promptForValue(options) {
    const value = await p.text({
        message: options.message,
        defaultValue: options.defaultValue,
        validate: options.validate
            ? (value) => options.validate?.(value ?? '')
            : undefined,
    });
    if (typeof p.isCancel === 'function' && p.isCancel(value))
        return null;
    return String(value).trim();
}
export async function planRuntimeSecretInput(input) {
    const label = input.label ?? input.name;
    const gantryStorageAvailable = hasGantryRuntimeSecretStorage(input.runtimeHome);
    const sourceOptions = [
        ...(gantryStorageAvailable
            ? [
                {
                    value: 'gantry',
                    label: 'Store in Gantry',
                    hint: 'encrypted in runtime storage',
                },
            ]
            : []),
        {
            value: 'aws-sm',
            label: 'Use AWS Secrets Manager',
            hint: 'save an aws-sm ref',
        },
        {
            value: 'env',
            label: 'Use environment variable',
            hint: 'write runtime .env and save an env ref',
        },
    ];
    const initialValue = gantryStorageAvailable ? 'gantry' : 'env';
    const source = typeof p.select === 'function'
        ? await p.select({
            message: `Where should Gantry resolve ${label}?`,
            options: sourceOptions,
            initialValue,
        })
        : initialValue;
    if (typeof p.isCancel === 'function' && p.isCancel(source))
        return null;
    if (source === 'gantry' && !gantryStorageAvailable) {
        throw new Error('Gantry runtime secret storage requires SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON.');
    }
    if (source === 'env') {
        const envName = await promptForValue({
            message: `${label} environment variable`,
            defaultValue: input.name,
            validate: (value) => value?.trim() ? undefined : 'Environment variable is required.',
        });
        if (envName === null)
            return null;
        return {
            ref: envRuntimeSecretRef(envName),
            persist: async () => {
                writeRuntimeEnvValue(input.runtimeHome, envName, input.value);
            },
        };
    }
    if (source === 'aws-sm') {
        const secretName = await promptForValue({
            message: `${label} AWS Secrets Manager name or ARN`,
            defaultValue: input.name,
            validate: (value) => value?.trim()
                ? undefined
                : 'AWS Secrets Manager reference is required.',
        });
        if (secretName === null)
            return null;
        return {
            ref: awsSecretsManagerRuntimeSecretRef(secretName),
            persist: async () => { },
        };
    }
    return {
        ref: gantryRuntimeSecretRef(input.name),
        persist: async () => {
            await storeRuntimeSecretInput({
                runtimeHome: input.runtimeHome,
                name: input.name,
                value: input.value,
                actor: input.actor,
            });
        },
    };
}
function hasGantryRuntimeSecretStorage(runtimeHome) {
    const env = readRuntimeEnvFile(runtimeHome);
    return hasValidEncryptionSecret({
        SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY?.trim() ||
            env.SECRET_ENCRYPTION_KEY?.trim(),
        SECRET_ENCRYPTION_KEYRING_JSON: process.env.SECRET_ENCRYPTION_KEYRING_JSON?.trim() ||
            env.SECRET_ENCRYPTION_KEYRING_JSON?.trim(),
    });
}
function readRuntimeEnvFile(runtimeHome) {
    try {
        return parseEnvContent(fs.readFileSync(path.join(runtimeHome, '.env'), 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeRuntimeEnvValue(runtimeHome, name, value) {
    const env = readRuntimeEnvFile(runtimeHome);
    env[name.trim().toUpperCase()] = value;
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(runtimeHome, 0o700);
    }
    catch {
        // Best effort: some filesystems do not support POSIX modes.
    }
    const filePath = path.join(runtimeHome, '.env');
    fs.writeFileSync(filePath, `${Object.keys(env)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key}=${encodeRuntimeEnvValue(env[key] ?? '')}`)
        .join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // Best effort: some filesystems do not support POSIX modes.
    }
}
function encodeRuntimeEnvValue(value) {
    return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}
