import fs from 'fs';
import path from 'path';
import { resolveSelectedSkillProjection } from '../../../application/skills/selected-skill-projection.js';
import { sanitizeSkillDirectoryName, } from '../../../domain/skills/skill-action-permissions.js';
import { normalizeSkillAssetPath, readSkillFrontmatterName, readSkillMdAssetText, writeSkillAssets, } from '../../../shared/skill-artifact-helpers.js';
import { isClaudeNativeReservedSkillName } from './native-sdk-skills.js';
export const GANTRY_BUNDLED_SKILL_IDS = ['gantry-admin'];
export class BundledGantrySkillSource {
    packageRoot;
    constructor(packageRoot) {
        this.packageRoot = packageRoot;
    }
    async listSkills(input) {
        const skillsRoot = path.join(this.packageRoot, '.agents', 'skills');
        if (!fs.existsSync(skillsRoot))
            return [];
        const enabled = input?.enabledSkillIds
            ? new Set(input.enabledSkillIds)
            : undefined;
        return GANTRY_BUNDLED_SKILL_IDS.flatMap((skillId) => {
            const sourceDir = path.join(skillsRoot, skillId);
            if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
                return [];
            }
            return [
                {
                    id: skillId,
                    name: skillId,
                    sourceType: 'bundled',
                    sourceDir,
                    enabled: !enabled || enabled.has(skillId),
                },
            ];
        });
    }
}
export class ArtifactClaudeSkillSource {
    skills;
    artifacts;
    context;
    constructor(skills, artifacts, context) {
        this.skills = skills;
        this.artifacts = artifacts;
        this.context = context;
    }
    async listSkills(input) {
        const selectedSkillIds = uniqueSkillCatalogIds(input?.enabledSkillIds ?? []);
        const projection = await resolveSelectedSkillProjection({
            selectedSkillIds,
            skillRepository: this.skills,
            skillArtifactStore: this.artifacts,
            skillContext: this.context,
        });
        return (projection?.skills ?? []).map((skill) => ({
            id: skill.id,
            name: skill.name,
            sourceType: 'artifact',
            assets: skill.assets,
            contentHash: skill.contentHash,
            actionPermissions: skill.actionPermissions,
            enabled: true,
        }));
    }
}
export const RUNTIME_GANTRY_BROWSER_SKILL_ID = 'gantry-browser';
export const RUNTIME_GANTRY_BROWSER_SKILL_VERSION = 'gantry-runtime-v1';
const RUNTIME_GANTRY_BROWSER_SKILL = `---
name: gantry-browser
description: Use the Gantry-managed persistent browser profile for web tasks that require navigation, login state, cookies, or browser actions.
---

# Gantry Browser

Use this skill when a task needs a real browser session.

Gantry owns the persistent browser lifecycle and gives each agent conversation its own default profile:

- Use the compact Browser gateway: \`browser_status\`, \`browser_open\`, \`browser_inspect\`, \`browser_act\`, and \`browser_close\`.
- For scheduled jobs that declare Browser as required access, call \`browser_open\` early for the first task-relevant web destination so the host-managed browser is visibly launched.
- Search first when the destination is unknown. Use \`browser_open\` directly only when the user provided a URL or you have selected a search result.
- Inspect before acting. Use \`browser_inspect\` to understand the current page before each \`browser_act\` interaction.
- Use basic inspection by default. Request full inspection only with a concise reason when basic output is insufficient.
- Close the browser with \`browser_close\` after scheduled jobs or other unattended browser work completes.
- The Browser capability exposes only the Gantry gateway. Do not request private browser backends or alternate automation tools.
- Gantry launches the backing browser lazily when an action needs it; \`browser_status\` is read-only and does not launch Chrome.
- Do not install browser skills or edit user skill package paths.

If a site requires login, launch the headed browser and ask the user to complete authentication in that persistent profile. Do not scrape credentials or bypass normal site authentication.
`;
export class RuntimeInstalledGantryBrowserSkillSource {
    async listSkills(input) {
        const enabled = input?.enabledSkillIds
            ? input.enabledSkillIds.includes(RUNTIME_GANTRY_BROWSER_SKILL_ID)
            : true;
        return [
            {
                id: RUNTIME_GANTRY_BROWSER_SKILL_ID,
                name: RUNTIME_GANTRY_BROWSER_SKILL_ID,
                sourceType: 'runtime',
                enabled,
                assets: [
                    {
                        path: 'SKILL.md',
                        content: Buffer.from(RUNTIME_GANTRY_BROWSER_SKILL, 'utf-8'),
                    },
                    {
                        path: 'VERSION',
                        content: Buffer.from(`${RUNTIME_GANTRY_BROWSER_SKILL_VERSION}\n`, 'utf-8'),
                    },
                ],
            },
        ];
    }
}
export class CompositeSkillSource {
    sources;
    constructor(sources) {
        this.sources = sources;
    }
    async listSkills(input) {
        const skills = [];
        for (const source of this.sources) {
            skills.push(...(await source.listSkills(input)));
        }
        return skills;
    }
}
export async function materializeClaudeSkills(input) {
    const skills = await input.skillSource.listSkills({
        enabledSkillIds: input.enabledSkillIds,
    });
    fs.mkdirSync(input.skillsDir, { recursive: true, mode: 0o700 });
    const materialized = [];
    const targetDirs = new Set();
    for (const skill of skills) {
        if (!skill.enabled)
            continue;
        const targetName = sanitizeSkillDirectoryName(skill.name);
        if (isClaudeNativeReservedSkillName(skill.name) ||
            isClaudeNativeReservedSkillName(targetName)) {
            throw new Error(`Skill "${skill.name}" uses a Claude-native reserved skill name and cannot be materialized.`);
        }
        const normalizedTargetName = targetName.toLowerCase();
        if (targetDirs.has(normalizedTargetName)) {
            throw new Error(`Duplicate materialized skill directory ${targetName}; rename or unselect one of the colliding skills.`);
        }
        targetDirs.add(normalizedTargetName);
        const targetDir = path.join(input.skillsDir, targetName);
        fs.rmSync(targetDir, { recursive: true, force: true });
        if (skill.assets) {
            if (!isValidAssetSkill(skill.assets)) {
                continue;
            }
            assertSkillFileNameMatchesMaterializedName({
                skillName: skill.name,
                targetName,
                skillText: readSkillMdAssetText(skill.assets),
            });
            writeSkillAssets(skill.assets, targetDir);
        }
        else if (skill.sourceDir) {
            const sourceDir = path.resolve(skill.sourceDir);
            const skillFile = path.join(sourceDir, 'SKILL.md');
            if (!fs.existsSync(skillFile))
                continue;
            assertSkillFileNameMatchesMaterializedName({
                skillName: skill.name,
                targetName,
                skillText: fs.readFileSync(skillFile, 'utf-8'),
            });
            copyDirRecursive(sourceDir, targetDir);
        }
        else {
            continue;
        }
        materialized.push({ ...skill, materializedName: targetName });
    }
    return materialized;
}
function isValidAssetSkill(assets) {
    try {
        const paths = assets.map((asset) => normalizeSkillAssetPath(asset.path));
        return paths.includes('SKILL.md');
    }
    catch (error) {
        if (error instanceof Error &&
            error.message.startsWith('Invalid skill asset path:')) {
            return false;
        }
        throw error;
    }
}
function uniqueSkillCatalogIds(values) {
    return [
        ...new Set(values
            .map((value) => String(value))
            .filter((value) => value.startsWith('skill:'))),
    ];
}
function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            continue;
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        }
        else if (entry.isFile()) {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}
function assertSkillFileNameMatchesMaterializedName(input) {
    const frontmatterName = readSkillFrontmatterName(input.skillText);
    if (!frontmatterName)
        return;
    const frontmatterTargetName = sanitizeSkillDirectoryName(frontmatterName);
    if (isClaudeNativeReservedSkillName(frontmatterName)) {
        throw new Error(`Skill "${input.skillName}" declares Claude-native reserved skill name "${frontmatterName}" in SKILL.md and cannot be materialized.`);
    }
    if (frontmatterTargetName.toLowerCase() !== input.targetName.toLowerCase()) {
        throw new Error(`Skill "${input.skillName}" declares SDK skill name "${frontmatterName}" but materializes as "${input.targetName}". Keep the SKILL.md name aligned with the Gantry skill name.`);
    }
}
