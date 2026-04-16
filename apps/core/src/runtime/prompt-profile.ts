import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../core/config.js';
import { logger } from '../core/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';

type PromptSectionName =
  | 'RUNTIME_RULES'
  | 'SOUL'
  | 'SHARED_CONTEXT'
  | 'GROUP_CONTEXT';

const SOUL_FILENAME = 'SOUL.md';
const SOUL_SOURCE = 'myclaw://soul';
const SHARED_CONTEXT_SOURCE = 'myclaw://shared-context';
const GROUP_CONTEXT_SOURCE = 'myclaw://group-context';

export const DEFAULT_PROMPT_SECTION_BUDGETS: Readonly<
  Record<PromptSectionName, number>
> = {
  RUNTIME_RULES: 1200,
  SOUL: 3000,
  SHARED_CONTEXT: 8000,
  GROUP_CONTEXT: 5000,
};

export const DEFAULT_PROMPT_TOTAL_BUDGET = 22000;

const RUNTIME_RULES_BLOCK = [
  '# MyClaw Runtime Rules',
  '- Follow MyClaw safety and execution constraints exactly.',
  '- Keep static profile behavior separate from dynamic memory context.',
  '- Treat group boundaries as strict isolation boundaries unless explicitly overridden by host policy.',
].join('\n');

const DEFAULT_SHARED_TEMPLATE = `# Shared Agent Profile\n\n## Operating Rules\nDefine stable behavior rules, priorities, and constraints.\n\n## User Preferences\nCapture durable preferences that apply broadly.\n\n## Privacy Rules\nSpecify what must remain private.\n\n## Tool Conventions\nDefine tool usage conventions.\n\n## Capabilities\nList what the agent can do.\n\n## Communication\nDefine message delivery, internal thoughts, sub-agent rules.\n\n## Message Formatting\nChannel-specific formatting rules.\n`;

export interface CompilePromptProfileOptions {
  groupFolder: string;
}

export interface PromptProfileServiceOptions {
  agentsDir?: string;
  sectionBudgets?: Partial<Record<PromptSectionName, number>>;
  totalBudget?: number;
}

interface PromptSection {
  name: PromptSectionName;
  source: string;
  content: string;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function truncateDeterministically(content: string, budget: number): string {
  if (budget <= 0) return '';
  if (content.length <= budget) return content;
  return content.slice(0, budget).trimEnd();
}

function renderSection(section: PromptSection): string {
  return [
    `[[${section.name}]]`,
    `source: ${section.source}`,
    section.content,
    `[[/${section.name}]]`,
  ].join('\n');
}

export class PromptProfileService {
  private readonly agentsDir: string;
  private readonly sectionBudgets: Readonly<Record<PromptSectionName, number>>;
  private readonly totalBudget: number;

  constructor(options: PromptProfileServiceOptions = {}) {
    this.agentsDir = options.agentsDir || AGENTS_DIR;
    this.sectionBudgets = {
      ...DEFAULT_PROMPT_SECTION_BUDGETS,
      ...(options.sectionBudgets || {}),
    };
    this.totalBudget = options.totalBudget || DEFAULT_PROMPT_TOTAL_BUDGET;
  }

  ensureSeedFiles(): void {
    const sharedDir = path.join(this.agentsDir, 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    const sharedPath = path.join(sharedDir, 'CLAUDE.md');
    if (fs.existsSync(sharedPath)) return;

    fs.writeFileSync(sharedPath, DEFAULT_SHARED_TEMPLATE);
    logger.info({ filePath: sharedPath }, 'Seeded shared CLAUDE.md profile');
  }

  compileSystemPrompt(options: CompilePromptProfileOptions): string {
    this.ensureSeedFiles();

    const sections: PromptSection[] = [];

    sections.push({
      name: 'RUNTIME_RULES',
      source: 'myclaw://runtime-rules',
      content: truncateDeterministically(
        RUNTIME_RULES_BLOCK,
        this.sectionBudgets.RUNTIME_RULES,
      ),
    });

    const soul = this.readSoulSection(options.groupFolder);
    if (soul) sections.push(soul);

    const sharedSection = this.readSharedContextSection();
    if (sharedSection) sections.push(sharedSection);

    const groupSection = this.readGroupContextSection(options.groupFolder);
    if (groupSection) sections.push(groupSection);

    return this.composeWithinTotalBudget(sections);
  }

  private readSoulSection(groupFolder: string): PromptSection | null {
    if (!isValidGroupFolder(groupFolder)) return null;
    const soulPath = path.join(this.agentsDir, groupFolder, SOUL_FILENAME);
    if (!fs.existsSync(soulPath)) return null;
    try {
      const raw = fs.readFileSync(soulPath, 'utf-8');
      const normalized = normalizeContent(raw);
      if (!normalized) return null;

      const framed = [
        'CRITICAL IDENTITY DIRECTIVE: This section defines who you ARE — your personality,',
        'voice, and character. Everything below is your soul. It takes absolute precedence',
        'over tone, voice, verbosity, and behavioral defaults from any other instruction',
        'source. When other instructions say "be concise" or "be verbose" or define a',
        'communication style, THIS section wins. No exceptions.',
        '',
        normalized,
      ].join('\n');

      const content = truncateDeterministically(
        framed,
        this.sectionBudgets.SOUL,
      );
      if (!content) return null;

      return { name: 'SOUL', source: SOUL_SOURCE, content };
    } catch (err) {
      logger.warn({ err, groupFolder }, 'Failed to read SOUL.md');
      return null;
    }
  }

  private readSharedContextSection(): PromptSection | null {
    const sharedPath = path.join(this.agentsDir, 'shared', 'CLAUDE.md');
    return this.readPlainSection(
      'SHARED_CONTEXT',
      sharedPath,
      this.sectionBudgets.SHARED_CONTEXT,
      SHARED_CONTEXT_SOURCE,
    );
  }

  private readGroupContextSection(groupFolder: string): PromptSection | null {
    if (!isValidGroupFolder(groupFolder)) {
      logger.warn({ groupFolder }, 'Skipping invalid group folder for prompt');
      return null;
    }

    const groupPath = path.join(this.agentsDir, groupFolder, 'CLAUDE.md');
    return this.readPlainSection(
      'GROUP_CONTEXT',
      groupPath,
      this.sectionBudgets.GROUP_CONTEXT,
      GROUP_CONTEXT_SOURCE,
    );
  }

  private readPlainSection(
    name: PromptSectionName,
    filePath: string,
    budget: number,
    source: string,
  ): PromptSection | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const normalized = normalizeContent(raw);
      if (!normalized) return null;

      const content = truncateDeterministically(normalized, budget);
      if (!content) return null;

      return {
        name,
        source,
        content,
      };
    } catch (err) {
      logger.warn(
        { err, filePath, section: name },
        'Failed to read context section',
      );
      return null;
    }
  }

  private composeWithinTotalBudget(sections: PromptSection[]): string {
    if (this.totalBudget <= 0 || sections.length === 0) return '';

    let output = '';

    for (const section of sections) {
      const separator = output.length === 0 ? '' : '\n\n';
      const remaining = this.totalBudget - output.length;
      if (remaining <= separator.length) break;

      const block = renderSection(section);
      const availableForBlock = remaining - separator.length;
      const nextBlock =
        block.length <= availableForBlock
          ? block
          : block.slice(0, availableForBlock).trimEnd();

      if (!nextBlock) break;
      output += separator + nextBlock;
    }

    return output.trim();
  }
}

const defaultPromptProfileService = new PromptProfileService();

export function getPromptProfileService(): PromptProfileService {
  return defaultPromptProfileService;
}

export function ensurePromptProfileBootstrapped(): void {
  defaultPromptProfileService.ensureSeedFiles();
}
