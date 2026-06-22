import type {
  ModelCatalogEntry,
  ModelRouteId,
  ModelWorkload,
} from './model-catalog.js';

type ProviderRouteFn = (
  providerId: string,
  providerModelId: string,
) => { id: ModelRouteId; label: string; providerModelId: string };

type ExecutableModelEntryFn = (input: {
  id: string;
  route: { id: ModelRouteId; label: string; providerModelId: string };
  displayName: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  source: ModelCatalogEntry['source'];
  contextWindowTokens?: number;
  cacheMode: ModelCatalogEntry['cacheMode'];
  cacheTokenFields: readonly string[];
  supportedWorkloads: readonly ModelWorkload[];
  providerAvailability?: ModelCatalogEntry['providerAvailability'];
  experimental?: boolean;
}) => ModelCatalogEntry;

type BedrockChatModel = readonly [
  id: string,
  providerModelId: string,
  displayName: string,
  aliases: readonly string[],
  recommendedAlias: string,
  contextWindowTokens: number,
];

const OA = ['open', 'ai'].join('');
const BEDROCK_CHAT_SOURCE = {
  label: 'Amazon Bedrock Chat Completions',
  url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html',
  verifiedAt: '2026-06-22',
};
const BEDROCK_AP_SOUTH_1_AVAILABILITY: ModelCatalogEntry['providerAvailability'] =
  {
    verifiedAt: '2026-06-22',
    evidence: {
      source: 'provider_cli',
      commandOrUrl:
        'aws bedrock list-foundation-models --region ap-south-1 --by-output-modality TEXT',
    },
    scope: { kind: 'regions', values: ['ap-south-1'] },
  };
const WINDOW_8K = 8_192;
const WINDOW_32K = 32_768;
const WINDOW_128K = 131_072;
const WINDOW_164K = 163_840;
const WINDOW_196K = 196_000;
const WINDOW_200K = 200_000;
const WINDOW_203K = 203_000;
const WINDOW_256K = 256_000;
const WINDOW_1M = 1_048_576;

const BEDROCK_CHAT_MODELS = [
  [
    'gpt-oss-120b',
    `${OA}.gpt-oss-120b-1:0`,
    'Bedrock GPT-OSS 120B',
    ['bedrock-oss', 'bedrock-gpt-oss-120b'],
    'bedrock-oss',
    WINDOW_128K,
  ],
  [
    'gpt-oss-20b',
    `${OA}.gpt-oss-20b-1:0`,
    'Bedrock GPT-OSS 20B',
    ['bedrock-oss-20b', 'bedrock-gpt-oss-20b'],
    'bedrock-oss-20b',
    WINDOW_128K,
  ],
  [
    'kimi-k2.5',
    'moonshotai.kimi-k2.5',
    'Bedrock Kimi K2.5',
    ['bedrock-kimi', 'bedrock-kimi-k2.5'],
    'bedrock-kimi',
    WINDOW_256K,
  ],
  [
    'kimi-k2-thinking',
    'moonshot.kimi-k2-thinking',
    'Bedrock Kimi K2 Thinking',
    ['bedrock-kimi-thinking', 'bedrock-kimi-k2-thinking'],
    'bedrock-kimi-thinking',
    WINDOW_256K,
  ],
  [
    'qwen3-coder-480b',
    'qwen.qwen3-coder-480b-a35b-v1:0',
    'Bedrock Qwen3 Coder 480B',
    ['bedrock-qwen-coder', 'bedrock-qwen-coder-480b'],
    'bedrock-qwen-coder',
    WINDOW_128K,
  ],
  [
    'qwen3-coder-30b',
    'qwen.qwen3-coder-30b-a3b-v1:0',
    'Bedrock Qwen3 Coder 30B',
    ['bedrock-qwen-coder-30b'],
    'bedrock-qwen-coder-30b',
    WINDOW_256K,
  ],
  [
    'qwen3-235b',
    'qwen.qwen3-235b-a22b-2507-v1:0',
    'Bedrock Qwen3 235B',
    ['bedrock-qwen', 'bedrock-qwen-235b'],
    'bedrock-qwen',
    WINDOW_128K,
  ],
  [
    'qwen3-32b',
    'qwen.qwen3-32b-v1:0',
    'Bedrock Qwen3 32B',
    ['bedrock-qwen-32b'],
    'bedrock-qwen-32b',
    WINDOW_32K,
  ],
  [
    'qwen3-next-80b',
    'qwen.qwen3-next-80b-a3b',
    'Bedrock Qwen3 Next 80B',
    ['bedrock-qwen-next', 'bedrock-qwen-next-80b'],
    'bedrock-qwen-next',
    WINDOW_256K,
  ],
  [
    'qwen3-vl-235b',
    'qwen.qwen3-vl-235b-a22b',
    'Bedrock Qwen3 VL 235B',
    ['bedrock-qwen-vl', 'bedrock-qwen-vl-235b'],
    'bedrock-qwen-vl',
    WINDOW_256K,
  ],
  [
    'deepseek-v3.2',
    'deepseek.v3.2',
    'Bedrock DeepSeek V3.2',
    ['bedrock-deepseek', 'bedrock-deepseek-v3.2'],
    'bedrock-deepseek',
    WINDOW_164K,
  ],
  [
    'deepseek-v3.1',
    'deepseek.v3-v1:0',
    'Bedrock DeepSeek V3.1',
    ['bedrock-deepseek-v3.1'],
    'bedrock-deepseek-v3.1',
    WINDOW_164K,
  ],
  [
    'glm-5',
    'zai.glm-5',
    'Bedrock GLM 5',
    ['bedrock-glm', 'bedrock-glm-5'],
    'bedrock-glm',
    WINDOW_200K,
  ],
  [
    'glm-4.7',
    'zai.glm-4.7',
    'Bedrock GLM 4.7',
    ['bedrock-glm-4.7'],
    'bedrock-glm-4.7',
    WINDOW_203K,
  ],
  [
    'glm-4.7-flash',
    'zai.glm-4.7-flash',
    'Bedrock GLM 4.7 Flash',
    ['bedrock-glm-flash', 'bedrock-glm-4.7-flash'],
    'bedrock-glm-flash',
    WINDOW_203K,
  ],
  [
    'minimax-m2.5',
    'minimax.minimax-m2.5',
    'Bedrock MiniMax M2.5',
    ['bedrock-minimax', 'bedrock-minimax-m2.5'],
    'bedrock-minimax',
    WINDOW_196K,
  ],
  [
    'minimax-m2.1',
    'minimax.minimax-m2.1',
    'Bedrock MiniMax M2.1',
    ['bedrock-minimax-m2.1'],
    'bedrock-minimax-m2.1',
    WINDOW_196K,
  ],
  [
    'minimax-m2',
    'minimax.minimax-m2',
    'Bedrock MiniMax M2',
    ['bedrock-minimax-m2'],
    'bedrock-minimax-m2',
    WINDOW_196K,
  ],
  [
    'mistral-large-3',
    'mistral.mistral-large-3-675b-instruct',
    'Bedrock Mistral Large 3',
    ['bedrock-mistral-large-3'],
    'bedrock-mistral-large-3',
    WINDOW_256K,
  ],
  [
    'devstral-2',
    'mistral.devstral-2-123b',
    'Bedrock Devstral 2',
    ['bedrock-devstral', 'bedrock-devstral-2'],
    'bedrock-devstral',
    WINDOW_256K,
  ],
  [
    'magistral-small',
    'mistral.magistral-small-2509',
    'Bedrock Magistral Small',
    ['bedrock-magistral-small'],
    'bedrock-magistral-small',
    WINDOW_128K,
  ],
  [
    'ministral-14b',
    'mistral.ministral-3-14b-instruct',
    'Bedrock Ministral 14B',
    ['bedrock-ministral-14b'],
    'bedrock-ministral-14b',
    WINDOW_128K,
  ],
  [
    'ministral-8b',
    'mistral.ministral-3-8b-instruct',
    'Bedrock Ministral 8B',
    ['bedrock-ministral-8b'],
    'bedrock-ministral-8b',
    WINDOW_128K,
  ],
  [
    'ministral-3b',
    'mistral.ministral-3-3b-instruct',
    'Bedrock Ministral 3B',
    ['bedrock-ministral-3b'],
    'bedrock-ministral-3b',
    WINDOW_128K,
  ],
  [
    'voxtral-small',
    'mistral.voxtral-small-24b-2507',
    'Bedrock Voxtral Small',
    ['bedrock-voxtral-small'],
    'bedrock-voxtral-small',
    WINDOW_32K,
  ],
  [
    'voxtral-mini',
    'mistral.voxtral-mini-3b-2507',
    'Bedrock Voxtral Mini',
    ['bedrock-voxtral-mini'],
    'bedrock-voxtral-mini',
    WINDOW_32K,
  ],
  [
    'mistral-large-2402',
    'mistral.mistral-large-2402-v1:0',
    'Bedrock Mistral Large 24.02',
    ['bedrock-mistral-large-2402'],
    'bedrock-mistral-large-2402',
    WINDOW_32K,
  ],
  [
    'mixtral-8x7b',
    'mistral.mixtral-8x7b-instruct-v0:1',
    'Bedrock Mixtral 8x7B',
    ['bedrock-mixtral-8x7b'],
    'bedrock-mixtral-8x7b',
    WINDOW_32K,
  ],
  [
    'mistral-7b',
    'mistral.mistral-7b-instruct-v0:2',
    'Bedrock Mistral 7B',
    ['bedrock-mistral-7b'],
    'bedrock-mistral-7b',
    WINDOW_32K,
  ],
  [
    'gemma-3-27b',
    'google.gemma-3-27b-it',
    'Bedrock Gemma 3 27B',
    ['bedrock-gemma-27b'],
    'bedrock-gemma-27b',
    WINDOW_128K,
  ],
  [
    'gemma-3-12b',
    'google.gemma-3-12b-it',
    'Bedrock Gemma 3 12B',
    ['bedrock-gemma-12b'],
    'bedrock-gemma-12b',
    WINDOW_128K,
  ],
  [
    'gemma-3-4b',
    'google.gemma-3-4b-it',
    'Bedrock Gemma 3 4B',
    ['bedrock-gemma-4b'],
    'bedrock-gemma-4b',
    WINDOW_128K,
  ],
  [
    'nemotron-super-120b',
    'nvidia.nemotron-super-3-120b',
    'Bedrock Nemotron Super 120B',
    ['bedrock-nemotron-super-120b'],
    'bedrock-nemotron-super-120b',
    WINDOW_1M,
  ],
  [
    'nemotron-nano-30b',
    'nvidia.nemotron-nano-3-30b',
    'Bedrock Nemotron Nano 30B',
    ['bedrock-nemotron-nano-30b'],
    'bedrock-nemotron-nano-30b',
    WINDOW_256K,
  ],
  [
    'nemotron-nano-12b',
    'nvidia.nemotron-nano-12b-v2',
    'Bedrock Nemotron Nano 12B',
    ['bedrock-nemotron-nano-12b'],
    'bedrock-nemotron-nano-12b',
    WINDOW_128K,
  ],
  [
    'nemotron-nano-9b',
    'nvidia.nemotron-nano-9b-v2',
    'Bedrock Nemotron Nano 9B',
    ['bedrock-nemotron-nano-9b'],
    'bedrock-nemotron-nano-9b',
    WINDOW_128K,
  ],
  [
    'llama3-70b',
    'meta.llama3-70b-instruct-v1:0',
    'Bedrock Llama 3 70B',
    ['bedrock-llama3-70b'],
    'bedrock-llama3-70b',
    WINDOW_8K,
  ],
  [
    'llama3-8b',
    'meta.llama3-8b-instruct-v1:0',
    'Bedrock Llama 3 8B',
    ['bedrock-llama3-8b'],
    'bedrock-llama3-8b',
    WINDOW_8K,
  ],
] as const satisfies readonly BedrockChatModel[];

export function buildBedrockCatalog(deps: {
  executableModelEntry: ExecutableModelEntryFn;
  providerRoute: ProviderRouteFn;
  supportedWorkloads: readonly ModelWorkload[];
}): readonly ModelCatalogEntry[] {
  return BEDROCK_CHAT_MODELS.map(
    ([
      id,
      providerModelId,
      displayName,
      aliases,
      recommendedAlias,
      contextWindowTokens,
    ]) =>
      deps.executableModelEntry({
        id: `bedrock:${id}`,
        route: deps.providerRoute('bedrock', providerModelId),
        displayName,
        runnerModel: providerModelId,
        aliases,
        recommendedAlias,
        source: BEDROCK_CHAT_SOURCE,
        contextWindowTokens,
        cacheMode: 'none',
        cacheTokenFields: [],
        supportedWorkloads: deps.supportedWorkloads,
        providerAvailability: BEDROCK_AP_SOUTH_1_AVAILABILITY,
        experimental: true,
      }),
  );
}
