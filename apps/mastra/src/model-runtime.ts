export const DEFAULT_CHAT_MODEL = 'google/gemini-2.5-flash';

type ChatRuntimeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Mirrors legacy `GEMINI_API_KEY` settings into Mastra Google provider env aliases.
 */
export function aliasLegacyGeminiApiKeys(env: NodeJS.ProcessEnv = process.env): void {
  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    return;
  }
  if (!env.GOOGLE_API_KEY?.trim()) {
    env.GOOGLE_API_KEY = geminiApiKey;
  }
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    env.GOOGLE_GENERATIVE_AI_API_KEY = geminiApiKey;
  }
}

/**
 * Resolves the Mastra model-router identifier shared by all Pufu Lens chat agents.
 *
 * `PUFU_LENS_CHAT_MODEL` accepts provider-qualified identifiers such as `openai/gpt-5-mini` or
 * `anthropic/claude-sonnet-4-5`. The legacy Gemini model setting remains compatible and is
 * normalized to the `google/<model>` router form.
 *
 * @param env - Runtime environment containing generic or legacy chat model settings
 * @returns A non-empty provider-qualified Mastra model identifier
 * @throws When the generic model is empty or lacks a provider prefix
 */
export function resolveChatModel(env: ChatRuntimeEnv = process.env): string {
  if (env.PUFU_LENS_CHAT_MODEL !== undefined) {
    const model = env.PUFU_LENS_CHAT_MODEL.trim();
    if (!model?.includes('/')) {
      throw new Error(
        'PUFU_LENS_CHAT_MODEL must be a provider-qualified model such as google/gemini-2.5-flash, openai/gpt-5-mini, or anthropic/claude-sonnet-4-5.',
      );
    }
    return model;
  }
  const legacyGeminiModel = env.GEMINI_CHAT_MODEL?.trim();
  if (legacyGeminiModel) {
    return legacyGeminiModel.startsWith('google/')
      ? legacyGeminiModel
      : `google/${legacyGeminiModel}`;
  }
  return DEFAULT_CHAT_MODEL;
}
