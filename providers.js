// Shared provider metadata and model-list helpers.
// Loaded by the content script, options page, and background service worker.

(function(root) {
  'use strict';

  const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:1234/v1/chat/completions';
  const CODEX_DEFAULT_ENDPOINT = 'http://127.0.0.1:8791/v1/chat/completions';
  const MODEL_CATALOG_STORAGE_KEY = 'sidekickModelCatalog';
  const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
  const UNSUPPORTED_LOCAL_CHAT_MODELS = [
    'qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive'
  ];

  const PROVIDERS = {
    anthropic: {
      label: 'Anthropic',
      settingsLabel: 'Anthropic (Claude)',
      apiKeyStorageKey: 'apiKey',
      modelStorageKey: 'model',
      keyPlaceholder: 'sk-ant-...',
      keyHintHtml: 'Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>',
      defaultModel: 'claude-sonnet-4-6',
      models: [
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
      ]
    },
    openai: {
      label: 'OpenAI',
      settingsLabel: 'OpenAI',
      apiKeyStorageKey: 'openaiApiKey',
      modelStorageKey: 'openaiModel',
      keyPlaceholder: 'sk-...',
      keyHintHtml: 'Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
      defaultModel: 'gpt-5.5',
      models: [
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'gpt-5.4', label: 'GPT-5.4' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
        { value: 'gpt-5.2', label: 'GPT-5.2' },
        { value: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest' }
      ]
    },
    fal: {
      label: 'Fal.ai',
      settingsLabel: 'Fal.ai (OpenRouter)',
      apiKeyStorageKey: 'falApiKey',
      modelStorageKey: 'falModel',
      keyPlaceholder: 'fal key...',
      keyHintHtml: 'Get your API key from <a href="https://fal.ai/dashboard/keys" target="_blank">fal.ai/dashboard/keys</a>',
      defaultModel: 'google/gemini-3.8-flash',
      modelListRequiresApiKey: false,
      models: [
        { value: 'google/gemini-3.8-flash', label: 'Google: Gemini 3.8 Flash' },
        { value: 'google/gemini-3.5-flash', label: 'Google: Gemini 3.5 Flash' },
        { value: 'anthropic/claude-haiku-4.5', label: 'Anthropic: Claude Haiku 4.5' },
        { value: 'anthropic/claude-sonnet-4.6', label: 'Anthropic: Claude Sonnet 4.6' },
        { value: 'anthropic/claude-opus-4.8', label: 'Anthropic: Claude Opus 4.8' },
        { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
        { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek: DeepSeek V4 Flash' },
        { value: 'deepseek/deepseek-v4-pro', label: 'DeepSeek: DeepSeek V4 Pro' },
        { value: 'qwen/qwen3.7-plus', label: 'Qwen: Qwen3.7 Plus' }
      ]
    },
    gemini: {
      label: 'Gemini',
      settingsLabel: 'Google Gemini',
      apiKeyStorageKey: 'geminiApiKey',
      modelStorageKey: 'geminiModel',
      keyPlaceholder: 'AIza...',
      keyHintHtml: 'Get your API key from <a href="https://aistudio.google.com/app/apikey" target="_blank">Google AI Studio</a>',
      defaultModel: 'gemini-3.8-flash',
      models: [
        { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
        { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
        { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
      ]
    },
    deepseek: {
      label: 'DeepSeek',
      settingsLabel: 'DeepSeek',
      apiKeyStorageKey: 'deepseekApiKey',
      modelStorageKey: 'deepseekModel',
      keyPlaceholder: 'sk-...',
      keyHintHtml: 'Get your API key from <a href="https://platform.deepseek.com/api_keys" target="_blank">platform.deepseek.com</a>',
      defaultModel: 'deepseek-v4-flash',
      models: [
        { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
        { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
      ]
    },
    codex: {
      label: 'Codex',
      settingsLabel: 'Codex (local)',
      modelStorageKey: 'codexModel',
      endpointStorageKey: 'codexEndpoint',
      keyPlaceholder: '',
      keyHintHtml: 'No API key needed. Sidekick uses your signed-in local Codex installation through the Sidekick Codex bridge.',
      defaultEndpoint: CODEX_DEFAULT_ENDPOINT,
      defaultModel: 'codex-default',
      modelCatalogStatic: true,
      models: [
        { value: 'codex-default', label: 'Codex default' }
      ]
    },
    local: {
      label: 'Local LM Studio',
      settingsLabel: 'Local (LM Studio)',
      modelStorageKey: 'localModel',
      endpointStorageKey: 'localEndpoint',
      keyPlaceholder: '',
      keyHintHtml: 'No API key needed. Start LM Studio and enable its local server.',
      defaultEndpoint: LOCAL_DEFAULT_ENDPOINT,
      defaultModel: 'gemma-4-12b-it',
      models: [
        { value: 'gemma-4-12b-it', label: 'Gemma 4 12B' },
        { value: 'qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B' }
      ]
    }
  };

  const EDITION = root.SIDEKICK_EDITION || {};

  function isProviderHidden(providerId) {
    return (EDITION.hiddenProviders || []).includes(providerId);
  }

  function isTtsEngineHidden(engine) {
    return (EDITION.hiddenTtsEngines || []).includes(engine);
  }

  function getProviderModelConfig(catalog) {
    return Object.entries(PROVIDERS).filter(([providerId]) => !isProviderHidden(providerId)).map(([providerId, provider]) => {
      const liveModels = normalizeModelOptions(catalog?.providers?.[providerId]?.models);
      const fallbackModels = normalizeModelOptions(provider.models);
      // The hard-coded list is only a fallback for when the provider's live list
      // can't load; merging it in kept stale models pinned above newer ones.
      const models = liveModels.length > 0 ? liveModels : fallbackModels;
      const defaultModel = models.some(model => model.value === provider.defaultModel)
        ? provider.defaultModel
        : (models[0]?.value || provider.defaultModel);

      return {
        providerId,
        label: provider.label,
        modelStorageKey: provider.modelStorageKey,
        defaultModel,
        models,
        source: liveModels.length > 0 ? (catalog?.providers?.[providerId]?.source || 'live') : 'fallback',
        error: catalog?.providers?.[providerId]?.error || ''
      };
    });
  }

  function getModelStorageKeys() {
    return Object.values(PROVIDERS)
      .map(provider => provider.modelStorageKey)
      .filter(Boolean);
  }

  function getApiKeyStorageKeys() {
    return Object.values(PROVIDERS)
      .map(provider => provider.apiKeyStorageKey)
      .filter(Boolean);
  }

  function normalizeModelOptions(models) {
    if (!Array.isArray(models)) return [];

    const seen = new Set();
    const normalized = [];

    for (const model of models) {
      const value = String(model?.value || model?.id || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      normalized.push({
        value,
        label: String(model?.label || model?.display_name || model?.displayName || value).trim()
      });
    }

    return normalized;
  }

  function createModelOption(providerId, id, displayName) {
    const value = String(id || '').trim();
    return {
      value,
      label: displayName || formatModelLabel(providerId, value)
    };
  }

  function formatModelLabel(providerId, id) {
    if (providerId === 'anthropic') return formatClaudeLabel(id);
    if (providerId === 'deepseek') return formatDeepSeekLabel(id);
    if (providerId === 'openai') return formatOpenAiLabel(id);
    if (providerId === 'fal') return formatFalLabel(id);
    if (providerId === 'gemini') return formatGeminiLabel(id);
    if (providerId === 'codex') return id === 'codex-default' ? 'Codex default' : id;
    if (providerId === 'local') return formatLocalLabel(id);
    return id;
  }

  function formatClaudeLabel(id) {
    const match = id.match(/^claude-(opus|sonnet|haiku)-(.+)$/);
    if (!match) return id;
    const family = capitalize(match[1]);
    const version = match[2]
      .replace(/-\d{8}$/, '')
      .replace(/-/g, '.');
    return `Claude ${family} ${version}`;
  }

  function formatDeepSeekLabel(id) {
    return id
      .replace(/^deepseek-/, 'DeepSeek ')
      .replace(/-/g, ' ')
      .replace(/\bv(\d+)\b/i, 'V$1')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function formatOpenAiLabel(id) {
    if (id.startsWith('gpt-')) {
      return id
        .replace(/^gpt-/, 'GPT-')
        .replace(/-chat-latest$/, ' Chat Latest')
        .replace(/-mini$/, ' mini')
        .replace(/-nano$/, ' nano')
        .replace(/-pro$/, ' pro')
        .replace(/-codex$/, ' Codex');
    }
    return id;
  }

  function formatFalLabel(id) {
    return id
      .split('/')
      .map(part => part
        .replace(/-/g, ' ')
        .replace(/\bv(\d+)\b/i, 'V$1')
      .replace(/\b\w/g, char => char.toUpperCase()))
      .join(': ');
  }

  function formatGeminiLabel(id) {
    return String(id || '')
      .replace(/^models\//, '')
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-/g, ' ')
      .replace(/\bpro\b/i, 'Pro')
      .replace(/\bflash\b/i, 'Flash')
      .replace(/\blite\b/i, 'Lite')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function formatLocalLabel(id) {
    const lastSegment = String(id || '').split('/').pop() || id;
    return lastSegment
      .replace(/[@_]/g, '-')
      .replace(/-/g, ' ')
      .replace(/\bqwen(\d)/i, 'Qwen$1')
      .replace(/\bgemma\b/i, 'Gemma')
      .replace(/\bmlx\b/i, 'MLX')
      .replace(/\bit\b/i, 'IT')
      .replace(/\ba3b\b/i, 'A3B')
      .replace(/\b(\d+)b\b/gi, '$1B')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function isOpenAiChatModelId(id) {
    const modelId = String(id || '').toLowerCase();
    if (!modelId) return false;

    const excluded = [
      'audio',
      'tts',
      'transcribe',
      'whisper',
      'realtime',
      'image',
      'dall-e',
      'embedding',
      'moderation',
      'search',
      'computer-use'
    ];
    if (excluded.some(term => modelId.includes(term))) return false;

    return (
      modelId.startsWith('gpt-') ||
      /^o\d/.test(modelId) ||
      modelId.startsWith('chatgpt-')
    );
  }

  function normalizeLocalEndpoint(value) {
    const rawEndpoint = (value || LOCAL_DEFAULT_ENDPOINT).trim();
    const endpoint = rawEndpoint.startsWith('http://') || rawEndpoint.startsWith('https://')
      ? rawEndpoint
      : `http://${rawEndpoint}`;
    let url;

    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('Local endpoint must be a valid URL. Use http://localhost:1234/v1/chat/completions.');
    }

    const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !isLocalHost) {
      throw new Error('Local endpoint must use http://localhost or http://127.0.0.1.');
    }

    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/v1/chat/completions';
    } else if (url.pathname === '/v1' || url.pathname === '/v1/') {
      url.pathname = '/v1/chat/completions';
    }

    return url.toString();
  }

  function normalizeCodexEndpoint(value) {
    const rawEndpoint = (value || CODEX_DEFAULT_ENDPOINT).trim();
    const endpoint = rawEndpoint.startsWith('http://') || rawEndpoint.startsWith('https://')
      ? rawEndpoint
      : `http://${rawEndpoint}`;
    let url;

    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('Codex endpoint must be a valid URL. Use http://127.0.0.1:8791/v1/chat/completions.');
    }

    const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !isLocalHost) {
      throw new Error('Codex endpoint must use http://localhost or http://127.0.0.1.');
    }

    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/v1/chat/completions';
    } else if (url.pathname === '/v1' || url.pathname === '/v1/') {
      url.pathname = '/v1/chat/completions';
    }

    return url.toString();
  }

  function isUnsupportedLocalChatModel(id) {
    return UNSUPPORTED_LOCAL_CHAT_MODELS.includes(String(id || '').toLowerCase());
  }

  const WEB_SEARCH_DEFAULT_PROVIDER = 'fal';
  const WEB_SEARCH_DEFAULT_MODEL = 'google/gemini-3.8-flash';
  const WEB_SEARCH_PREVIOUS_SELECTION_KEY = 'webSearchPreviousSelection';
  const OPENROUTER_WEB_SEARCH_TOOL = { type: 'openrouter:web_search' };

  function falModelSupportsWebSearch(model) {
    const modelId = String(model || '').toLowerCase();
    if (!modelId) return false;
    if (modelId.includes('deepseek') || modelId.includes('qwen') || modelId.includes('lite')) {
      return false;
    }

    return (
      modelId.startsWith('anthropic/claude-sonnet') ||
      modelId.startsWith('anthropic/claude-opus') ||
      modelId.startsWith('anthropic/claude-haiku') ||
      modelId.startsWith('openai/gpt-5') ||
      modelId.startsWith('google/gemini-3')
    );
  }

  function modelSupportsWebSearch(providerId, model) {
    return providerId === 'fal' && falModelSupportsWebSearch(model);
  }

  function falModelSupportsImages(model) {
    const modelId = String(model || '').toLowerCase();
    if (!modelId || modelId.includes('deepseek')) return false;

    return (
      modelId.startsWith('anthropic/') ||
      modelId.startsWith('openai/') ||
      modelId.startsWith('google/') ||
      modelId.includes('claude') ||
      modelId.includes('gpt-') ||
      modelId.includes('gemini') ||
      modelId.includes('-vl') ||
      modelId.includes('pixtral') ||
      modelId.includes('grok')
    );
  }

  function buildFallbackCatalog() {
    const providers = {};
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      providers[providerId] = {
        models: normalizeModelOptions(provider.models),
        source: providerId === 'local' ? 'static' : 'fallback',
        fetchedAt: 0
      };
    }
    return { fetchedAt: 0, providers };
  }

  function capitalize(value) {
    return value ? value[0].toUpperCase() + value.slice(1) : value;
  }

  root.SidekickProviders = {
    CODEX_DEFAULT_ENDPOINT,
    LOCAL_DEFAULT_ENDPOINT,
    MODEL_CATALOG_STORAGE_KEY,
    MODEL_CATALOG_TTL_MS,
    UNSUPPORTED_LOCAL_CHAT_MODELS,
    OPENROUTER_WEB_SEARCH_TOOL,
    PROVIDERS,
    WEB_SEARCH_DEFAULT_MODEL,
    WEB_SEARCH_DEFAULT_PROVIDER,
    WEB_SEARCH_PREVIOUS_SELECTION_KEY,
    buildFallbackCatalog,
    createModelOption,
    falModelSupportsImages,
    falModelSupportsWebSearch,
    getApiKeyStorageKeys,
    getModelStorageKeys,
    getProviderModelConfig,
    isOpenAiChatModelId,
    isProviderHidden,
    isTtsEngineHidden,
    isUnsupportedLocalChatModel,
    modelSupportsWebSearch,
    normalizeCodexEndpoint,
    normalizeLocalEndpoint,
    normalizeModelOptions
  };
})(globalThis);
