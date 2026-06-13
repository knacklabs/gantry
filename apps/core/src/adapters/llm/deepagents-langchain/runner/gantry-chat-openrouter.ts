import { ChatOpenRouter } from '@langchain/openrouter';
import type { ChatOpenRouterInput } from '@langchain/openrouter';
import type { ModelProfile } from '@langchain/core/language_models/profile';

// Thin ChatOpenRouter subclass that lets the host inject a curated model profile
// (specifically `maxInputTokens`) for OpenRouter ids the library has no built-in
// profile for. The base `get profile()` is a hardcoded `PROFILES[this.model] ??
// {}` getter with NO override field, so DeepAgents summarization would fall back
// to its fixed 170k/6-message trigger (not the real window) and context-usage
// would read 0%. Overriding the getter to prefer the curated profile fixes both,
// while still deferring to the library profile (`super.profile`) when no
// override is supplied — so we never clobber a real library profile.
//
// The override is passed through the same fields object as `profileOverride`;
// the base constructor only reads the known ChatOpenRouter fields and ignores
// this extra key, so passing it is safe.
export interface GantryChatOpenRouterFields extends ChatOpenRouterInput {
  profileOverride?: ModelProfile;
}

export class GantryChatOpenRouter extends ChatOpenRouter {
  readonly #profileOverride: ModelProfile | undefined;

  constructor(fields: GantryChatOpenRouterFields) {
    super(fields);
    this.#profileOverride = fields.profileOverride;
  }

  override get profile(): ModelProfile {
    return this.#profileOverride ?? super.profile;
  }
}
