// API streaming, message history, markdown rendering, and commands
// This file is loaded inside content.js scope (not a separate script)

const SIDEKICK_PROVIDER_DEFS = SidekickProviders.PROVIDERS;
const LOCAL_CONTEXT_CHAR_LIMIT = 60000;
const LOCAL_CONTEXT_RETRY_CHAR_LIMIT = 12000;

// Provider runtime config. Shared labels, storage keys, and fallback models
// live in providers.js so Settings, chat, and the background worker stay aligned.
const PROVIDERS = {
  anthropic: {
    label: SIDEKICK_PROVIDER_DEFS.anthropic.label,
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKeyStorageKey: SIDEKICK_PROVIDER_DEFS.anthropic.apiKeyStorageKey,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.anthropic.modelStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.anthropic.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.anthropic.models,
    requiresApiKey: true,
    supportsImages: true,
    bodyExtras: {},
    buildBody: buildAnthropicBody,
    readStreamEvent: readAnthropicStreamEvent,
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    })
  },
  openai: {
    label: SIDEKICK_PROVIDER_DEFS.openai.label,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKeyStorageKey: SIDEKICK_PROVIDER_DEFS.openai.apiKeyStorageKey,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.openai.modelStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.openai.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.openai.models,
    requiresApiKey: true,
    supportsImages: true,
    bodyExtras: {},
    maxTokensField: 'max_completion_tokens',
    buildBody: buildOpenAiBody,
    readStreamEvent: readOpenAiStreamEvent,
    useBackgroundStream: true,
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    })
  },
  fal: {
    label: SIDEKICK_PROVIDER_DEFS.fal.label,
    endpoint: 'https://fal.run/openrouter/router/openai/v1/chat/completions',
    apiKeyStorageKey: SIDEKICK_PROVIDER_DEFS.fal.apiKeyStorageKey,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.fal.modelStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.fal.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.fal.models,
    requiresApiKey: true,
    supportsImages: false,
    imageErrorMessage: 'This Fal/OpenRouter model is text-only. Switch to Claude Sonnet, GPT, or Gemini to analyze images.',
    buildBody: buildOpenAiBody,
    readStreamEvent: readOpenAiStreamEvent,
    useBackgroundStream: true,
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': `Key ${key}`
    })
  },
  gemini: {
    label: SIDEKICK_PROVIDER_DEFS.gemini.label,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyStorageKey: SIDEKICK_PROVIDER_DEFS.gemini.apiKeyStorageKey,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.gemini.modelStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.gemini.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.gemini.models,
    requiresApiKey: true,
    supportsImages: false,
    imageErrorMessage: 'Gemini is text-only in Sidekick for now. Switch to Claude, OpenAI, or Gemma 4 local vision to analyze images.',
    maxTokens: 2048,
    buildBody: buildGeminiBody,
    readStreamEvent: readGeminiStreamEvent,
    useBackgroundStream: true,
    buildEndpoint: (model) => {
      const modelName = String(model || '').startsWith('models/')
        ? String(model)
        : `models/${model}`;
      return `https://generativelanguage.googleapis.com/v1beta/${modelName}:streamGenerateContent?alt=sse`;
    },
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    })
  },
  deepseek: {
    label: SIDEKICK_PROVIDER_DEFS.deepseek.label,
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    apiKeyStorageKey: SIDEKICK_PROVIDER_DEFS.deepseek.apiKeyStorageKey,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.deepseek.modelStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.deepseek.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.deepseek.models,
    requiresApiKey: true,
    supportsImages: false,
    imageErrorMessage: 'DeepSeek models don’t support images. Switch to a Claude model in Settings to analyze images.',
    // DeepSeek V4 turns on chain-of-thought by default, which adds latency and
    // burns the token budget before any answer streams. Disable it for a snappy
    // chat; the answer arrives immediately as text_delta. Keep temperature low
    // because Sidekick is mostly used for source-grounded summaries.
    bodyExtras: { thinking: { type: 'disabled' }, temperature: 0.2 },
    buildBody: buildAnthropicBody,
    readStreamEvent: readAnthropicStreamEvent,
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    })
  },
  codex: {
    label: SIDEKICK_PROVIDER_DEFS.codex.label,
    endpoint: SidekickProviders.CODEX_DEFAULT_ENDPOINT,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.codex.modelStorageKey,
    endpointStorageKey: SIDEKICK_PROVIDER_DEFS.codex.endpointStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.codex.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.codex.models,
    requiresApiKey: false,
    supportsImages: false,
    imageErrorMessage: 'Codex (local) is text-only in this Sidekick prototype. Switch to Claude, OpenAI, or Gemma 4 local vision to analyze images.',
    requestTimeoutMs: 600000,
    timeoutErrorMessage: 'Codex did not finish within 10 minutes. Try a shorter transcript or restart the Sidekick Codex bridge.',
    buildBody: buildCodexBody,
    readStreamEvent: readOpenAiStreamEvent,
    useBackgroundStream: true,
    buildHeaders: () => ({
      'Content-Type': 'application/json',
      'X-Sidekick-Codex': '1'
    }),
    resolveEndpoint: (settings) => SidekickProviders.normalizeCodexEndpoint(settings.codexEndpoint)
  },
  local: {
    label: SIDEKICK_PROVIDER_DEFS.local.label,
    endpoint: SidekickProviders.LOCAL_DEFAULT_ENDPOINT,
    modelStorageKey: SIDEKICK_PROVIDER_DEFS.local.modelStorageKey,
    endpointStorageKey: SIDEKICK_PROVIDER_DEFS.local.endpointStorageKey,
    defaultModel: SIDEKICK_PROVIDER_DEFS.local.defaultModel,
    models: SIDEKICK_PROVIDER_DEFS.local.models,
    requiresApiKey: false,
    supportsImages: false,
    imageErrorMessage: 'The selected local model does not support images in Sidekick. Use Gemma 4 12B, Claude, or a compatible OpenAI vision model to analyze images.',
    requestTimeoutMs: 180000,
    maxTokens: 2048,
    bodyExtras: {},
    buildBody: buildLocalBody,
    readStreamEvent: readOpenAiStreamEvent,
    useBackgroundStream: true,
    buildHeaders: () => ({
      'Content-Type': 'application/json'
    }),
    resolveEndpoint: (settings) => SidekickProviders.normalizeLocalEndpoint(settings.localEndpoint)
  }
};

function getSidekickProviderModelConfig(catalog) {
  return SidekickProviders.getProviderModelConfig(catalog);
}

function buildAnthropicBody({ model, messages, systemPrompt, provider }) {
  const body = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    ...provider.bodyExtras
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  return body;
}

function shouldAttachWebSearch(settings, providerId, model, userText) {
  if (settings.webSearchEnabled === false) return false;
  if (providerId !== 'fal') return false;
  if (!String(settings.falApiKey || '').trim()) return false;
  if (!SidekickProviders.falModelSupportsWebSearch(model)) return false;
  if (typeof SidekickPrompts === 'object' && SidekickPrompts.isGroundedPageCommand(userText)) {
    return false;
  }
  return true;
}

function buildOpenAiBody({ model, messages, systemPrompt, provider, webSearch = false }) {
  const requestMessages = [];

  if (systemPrompt) {
    requestMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    requestMessages.push({
      role: message.role,
      content: toOpenAiContent(message.content)
    });
  }

  const body = {
    model,
    stream: true,
    messages: requestMessages
  };

  body[provider.maxTokensField || 'max_tokens'] = provider.maxTokens || 4096;
  if (webSearch) {
    body.tools = [SidekickProviders.OPENROUTER_WEB_SEARCH_TOOL];
  }
  return body;
}

function buildLocalBody({ model, messages, systemPrompt, provider, pageContext }) {
  const localMessages = pageContext?.content
    ? withContextInLatestUserMessage(messages, pageContext, provider.localContextCharLimit || LOCAL_CONTEXT_CHAR_LIMIT)
    : messages;

  return buildOpenAiBody({
    model,
    messages: localMessages,
    systemPrompt,
    provider
  });
}

function buildCodexBody({ model, messages, systemPrompt, pageContext, conversationId }) {
  const codexMessages = pageContext?.content
    ? withContextInLatestUserMessage(messages, pageContext, LOCAL_CONTEXT_CHAR_LIMIT)
    : messages;
  const requestMessages = [];

  if (systemPrompt) {
    requestMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of codexMessages) {
    requestMessages.push({
      role: message.role,
      content: extractTextContent(message.content)
    });
  }

  return {
    model,
    stream: true,
    conversation_id: conversationId,
    messages: requestMessages
  };
}

function withContextInLatestUserMessage(messages, context, charLimit = LOCAL_CONTEXT_CHAR_LIMIT) {
  const nextMessages = [...messages];
  const lastIndex = nextMessages.length - 1;
  const lastMessage = nextMessages[lastIndex];

  if (!lastMessage || lastMessage.role !== 'user') return nextMessages;

  const isLimitedContext = SidekickPrompts.isLimitedPageContext(context);
  const contextLabel = isLimitedContext ? 'PAGE METADATA' : context.type === 'youtube' ? 'VIDEO TRANSCRIPT' : 'PAGE CONTEXT';
  const contextContent = limitContextForLocalModel(context.content, charLimit);
  const limitedContextInstruction = isLimitedContext
    ? '\nThis is limited metadata, not the full source. Start summaries with the exact phrase "Based on limited metadata". Hard rule: use only facts literally present in the content below. Do not use or mention model memory or outside knowledge, including author background, other works, reputation, reviews, release dates, pricing, examples, mechanisms, facts, audience categories, quality, evidence level, or recommendations unless the user explicitly asks for general knowledge. Do not infer quality, target audience, or evidence level from author names, brands, URLs, or reputation. Do not mention outside knowledge even to label it as outside knowledge. Never use the phrase "known for", "author of", or "research-backed" unless that exact phrase appears in the content. Never mention other books, products, employers, credentials, or claims associated with an author unless those exact words appear in the content. For TL;DR-style answers, include a short "Worth your time" recommendation only from literal title, excerpt, tags, snippet, or memory; for interest or audience labels, use exact words from tags/title/excerpt/snippet/memory, not broader inferred categories. Do not use adjacent labels like productivity, psychology, behavioral science, cognitive biases, or decision-making unless those exact words appear in the content. If no saved memory directly applies, use metadata-only wording such as "Maybe if the title and tags match what you wanted; I cannot judge depth from metadata." Then end with one sentence starting "Cannot verify from metadata:" and name missing source-level information such as the full argument, evidence, examples, mechanisms, or actionable advice.\n'
    : '';
  const contextText =
`Use this ${contextLabel.toLowerCase()} to answer the user's request.

Title: ${context.title}
URL: ${context.url}
${limitedContextInstruction}

--- ${contextLabel} ---
${contextContent}
--- END ${contextLabel} ---

User request:
${extractTextContent(lastMessage.content)}`;

  nextMessages[lastIndex] = {
    ...lastMessage,
    content: replaceTextContent(lastMessage.content, contextText)
  };

  return nextMessages;
}

function limitContextForLocalModel(content, charLimit = LOCAL_CONTEXT_CHAR_LIMIT) {
  const text = String(content || '');
  if (text.length <= charLimit) return text;

  return `${text.slice(0, charLimit)}\n\n[Context truncated for local model context window.]`;
}

function replaceTextContent(content, text) {
  if (typeof content === 'string') return text;
  if (!Array.isArray(content)) return text;

  let replaced = false;
  const nextContent = content.map(part => {
    if (part.type !== 'text' || replaced) return part;
    replaced = true;
    return { ...part, text };
  });

  return replaced ? nextContent : [{ type: 'text', text }, ...nextContent];
}

function buildGeminiBody({ messages, systemPrompt, provider }) {
  const contents = messages
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: extractTextContent(message.content) }]
    }))
    .filter(content => content.parts[0].text.trim());

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: provider.maxTokens || 2048,
      temperature: 0.2
    }
  };

  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  return body;
}

function readAnthropicStreamEvent(event) {
  if (event.type === 'content_block_delta') {
    return { token: event.delta?.text || '' };
  }
  if (event.type === 'message_stop') {
    return { done: true };
  }
  if (event.type === 'error') {
    return { error: event.error?.message || 'Stream error' };
  }
  return {};
}

function readOpenAiStreamEvent(event) {
  if (event.error) {
    return { error: event.error?.message || event.error || 'Stream error' };
  }

  const choice = event.choices?.[0];
  const token = choice?.delta?.content || choice?.message?.content || '';
  if (choice?.finish_reason) {
    return { token, done: true };
  }
  return { token };
}

function readGeminiStreamEvent(event) {
  if (event.error) {
    return { error: event.error.message || 'Gemini stream error' };
  }

  const candidate = event.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const token = parts
    .map(part => part.text || '')
    .join('');

  if (candidate?.finishReason) {
    return { token, done: true };
  }
  return { token };
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

function localModelSupportsImages(model) {
  return String(model || '').toLowerCase().includes('gemma-4');
}

function isLocalContextOverflowError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('n_keep') &&
    message.includes('n_ctx') &&
    message.includes('context length');
}

function buildResponseMeta(providerId, model, note = '') {
  const modelLabel = SidekickProviders.createModelOption(providerId, model).label;
  return {
    providerId,
    model,
    label: note ? `${modelLabel}, ${note}` : modelLabel
  };
}

function normalizeMemoryItem(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMemoryList(items) {
  return SidekickPrompts.normalizeMemoryList(items);
}

function parseMemoryCommand(text) {
  const input = String(text || '').trim();
  const rememberMatch = input.match(/^\/?remember(?:\s*:|\s+to\b|\s+)(.+)$/i);
  if (rememberMatch) {
    return { action: 'remember', text: normalizeMemoryItem(rememberMatch[1]) };
  }

  const forgetMatch = input.match(/^\/?forget(?:\s*:|\s+)(.+)$/i);
  if (forgetMatch) {
    return { action: 'forget', text: normalizeMemoryItem(forgetMatch[1]) };
  }

  return null;
}

async function applyMemoryCommand(command, currentMemory) {
  const memories = normalizeMemoryList(currentMemory);

  if (!command.text) {
    return command.action === 'forget'
      ? 'Tell me what to forget. Example: `forget do not use the word XYZ`.'
      : 'Tell me what to remember. Example: `remember do not use the word XYZ`.';
  }

  if (command.action === 'forget') {
    const query = command.text.toLowerCase();
    const nextMemory = memories.filter(item => !item.toLowerCase().includes(query));
    await chrome.storage.local.set({ userMemory: nextMemory });
    const removedCount = memories.length - nextMemory.length;
    return removedCount > 0
      ? `Forgot ${removedCount} memory item${removedCount === 1 ? '' : 's'}.`
      : 'I did not find a matching memory item to forget.';
  }

  const exists = memories.some(item => item.toLowerCase() === command.text.toLowerCase());
  const nextMemory = exists ? memories : [...memories, command.text];
  await chrome.storage.local.set({ userMemory: nextMemory });
  return exists ? `I already remembered: ${command.text}` : `Remembered: ${command.text}`;
}

function toOpenAiContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  return content
    .map(part => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text || '' };
      }
      if (part.type === 'image' && part.source) {
        return {
          type: 'image_url',
          image_url: {
            url: `data:${part.source.media_type};base64,${part.source.data}`
          }
        };
      }
      return null;
    })
    .filter(Boolean);
}

function consumeSseChunk(chunk, provider, state, onToken) {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') {
      state.done = true;
      return;
    }

    try {
      const event = JSON.parse(data);
      const streamEvent = provider.readStreamEvent(event, state);

      if (streamEvent.error) {
        throw new Error(streamEvent.error);
      }

      if (streamEvent.token) {
        const token = String(streamEvent.token);
        state.fullResponse += token;
        onToken(token);
      }

      if (streamEvent.done) {
        state.done = true;
        return;
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
}

async function streamWithFetch({ endpoint, headers, body, provider, signal, onToken }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `API error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { buffer: '', done: false, fullResponse: '' };

  while (!state.done) {
    const { done, value } = await reader.read();
    if (done) break;
    consumeSseChunk(decoder.decode(value, { stream: true }), provider, state, onToken);
  }

  return state.fullResponse;
}

const CLOUD_STREAM_STALL_TIMEOUT_MS = 120000;

function createBackgroundAbort() {
  return {
    aborted: false,
    port: null,
    finish: null,
    abort() {
      this.aborted = true;
      if (this.port) {
        try {
          this.port.postMessage({ type: 'abort' });
          this.port.disconnect();
        } catch {
          // The background port may already be closed.
        }
      }
      this.finish?.();
    }
  };
}

function streamWithBackground({ endpoint, headers, body, provider, onToken, abortControl }) {
  return new Promise((resolve, reject) => {
    const state = { buffer: '', done: false, fullResponse: '' };
    let settled = false;
    const port = chrome.runtime.connect({ name: 'sidekickProviderStream' });
    abortControl.port = port;
    // onDisconnect never fires on the side that calls disconnect(), so a user
    // Stop has to settle the stream here or the reply waits forever.
    abortControl.finish = () => {
      if (settled) return;
      settled = true;
      resolve(state.fullResponse);
    };

    port.onMessage.addListener((message) => {
      if (settled) return;
      try {
        if (message.type === 'chunk') {
          consumeSseChunk(message.text || '', provider, state, onToken);
          return;
        }

        if (message.type === 'done') {
          settled = true;
          state.done = true;
          resolve(state.fullResponse);
          return;
        }

        if (message.type === 'error') {
          settled = true;
          state.done = true;
          reject(new Error(message.error || 'Provider model stream failed'));
        }
      } catch (e) {
        settled = true;
        reject(e);
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;

      if (abortControl.aborted) {
        resolve(state.fullResponse);
        return;
      }

      if (!state.done) {
        reject(new Error('Sidekick lost the local model stream before it finished. Reload the page and extension, then try again with a shorter prompt if it repeats.'));
      }
    });

    port.postMessage({
      type: 'start',
      endpoint,
      headers,
      body,
      timeoutMs: provider.requestTimeoutMs || 0,
      timeoutError: provider.timeoutErrorMessage || '',
      // Cloud providers get a no-data watchdog; local and Codex already have long request timeouts.
      stallTimeoutMs: provider.stallTimeoutMs ?? (provider.requestTimeoutMs ? 0 : CLOUD_STREAM_STALL_TIMEOUT_MS),
      stallError: `${provider.label || 'The model'} stopped sending data for ${Math.round(CLOUD_STREAM_STALL_TIMEOUT_MS / 1000)} seconds. Try again or pick another model.`
    });
  });
}

/**
 * Create a ChatEngine instance for a single tab
 */
function createChatEngine() {
  let messages = [];       // Array of {role: 'user'|'assistant', content: string|array}
  let pageContext = null;   // {title, url, content, type} — kept for export
  const conversationId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `sidekick-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let abortController = null;
  let isStreaming = false;
  let stopRequested = false;
  let commands = [];
  function getInitialCommands(storedCommands) {
    const nextCommands = SidekickPrompts.getInitialCommands(storedCommands);
    if (storedCommands && SidekickPrompts.shouldMigrateDefaultCommands(storedCommands)) {
      chrome.storage.local.set({ commands: nextCommands });
    }
    return nextCommands;
  }

  // Load commands from storage
  const commandsReady = new Promise(resolve => {
    chrome.storage.local.get('commands', (result) => {
      commands = getInitialCommands(result.commands);
      resolve();
    });
  });

  // Listen for command updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.commands) {
      commands = getInitialCommands(changes.commands.newValue);
    }
  });

  /**
   * Build the system prompt from custom prompt + page context
   */
  function buildSystemPrompt(customPrompt, includeContext = true, userMemory = []) {
    return SidekickPrompts.buildSystemPrompt({
      context: pageContext,
      customPrompt,
      includeContext,
      userMemory
    });
  }

  /**
   * Set page context as system prompt
   */
  function setContext(context) {
    pageContext = context;
  }

  /**
   * Discard page context
   */
  function discardContext() {
    pageContext = null;
  }

  /**
   * Expand slash commands in user input
   * Returns the expanded text, or the original text if no command matched
   */
  function expandCommand(text) {
    if (!text.startsWith('/')) return text;
    const parts = text.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const rest = parts.slice(1).join(' ');
    const cmd = commands.find(c => c.name.toLowerCase() === cmdName);
    if (cmd) {
      return rest ? `${cmd.prompt} ${rest}` : cmd.prompt;
    }
    return text; // No matching command, send as-is
  }

  /**
   * Get matching commands for autocomplete
   */
  function getCommandMatches(partial) {
    if (!partial.startsWith('/')) return [];
    const query = partial.slice(1).toLowerCase();
    if (!query) return commands;
    return commands.filter(c => c.name.toLowerCase().startsWith(query));
  }

  async function retryAfterLocalContextOverflow({ settings, userContent, images, onToken, onDone, onError }) {
    if (!images?.length && settings.deepseekApiKey) {
      onToken('Local context window was too small for Gemma, retrying with DeepSeek...\n\n');
      return retryWithProvider({
        providerId: 'deepseek',
        provider: PROVIDERS.deepseek,
        apiKey: settings.deepseekApiKey,
        model: settings.deepseekModel || PROVIDERS.deepseek.defaultModel,
        endpoint: PROVIDERS.deepseek.endpoint,
        systemPrompt: buildSystemPrompt(settings.customSystemPrompt || '', true, settings.userMemory),
        userContent,
        onDone,
        onError,
        onToken,
        responseMeta: buildResponseMeta('deepseek', settings.deepseekModel || PROVIDERS.deepseek.defaultModel, 'fallback'),
        errorPrefix: 'Local context was too large, and DeepSeek fallback failed'
      });
    }

    onToken('Local context window was too small for Gemma, retrying with shorter page context...\n\n');
    let endpoint;
    try {
      endpoint = PROVIDERS.local.resolveEndpoint(settings);
    } catch (e) {
      onError(e.message);
      return true;
    }

    return retryWithProvider({
      providerId: 'local',
      provider: {
        ...PROVIDERS.local,
        localContextCharLimit: LOCAL_CONTEXT_RETRY_CHAR_LIMIT,
        maxTokens: 1024
      },
      apiKey: '',
      model: settings.localModel || PROVIDERS.local.defaultModel,
      endpoint,
      systemPrompt: buildSystemPrompt(settings.customSystemPrompt || '', false, settings.userMemory),
      userContent,
      onDone,
      onError,
      onToken,
      responseMeta: buildResponseMeta('local', settings.localModel || PROVIDERS.local.defaultModel, 'shortened context'),
      errorPrefix: 'The local model was loaded with too small a context window, and the shorter local retry also failed'
    });
  }

  async function retryWithProvider({ providerId, provider, apiKey, model, endpoint, systemPrompt, userContent, onToken, onDone, onError, responseMeta, errorPrefix }) {
    messages.push({ role: 'user', content: userContent });
    const body = provider.buildBody({
      model,
      messages,
      systemPrompt,
      provider,
      pageContext
    });

    const headers = provider.buildHeaders(apiKey);
    let fullResponse = '';

    try {
      isStreaming = true;
      const backgroundAbort = createBackgroundAbort();
      abortController = backgroundAbort;
      fullResponse = await streamWithBackground({
        endpoint,
        headers,
        body,
        provider,
        onToken,
        abortControl: backgroundAbort
      });
      messages.push({ role: 'assistant', content: fullResponse });
      isStreaming = false;
      onDone(fullResponse, responseMeta || buildResponseMeta(providerId, model));
      return true;
    } catch (e) {
      isStreaming = false;
      messages.pop();
      const fallbackLabel = providerId === 'deepseek' ? 'DeepSeek' : 'local';
      onError(`${errorPrefix}: ${e.message || `${fallbackLabel} request failed`}`);
      return true;
    }
  }

  /**
   * Send a message and stream the response
   * @param {string} userText - The user's message
   * @param {Array} images - Array of {base64, mediaType} objects
   * @param {Function} onToken - Called with each text token as it arrives
   * @param {Function} onDone - Called when streaming is complete
   * @param {Function} onError - Called on error
   */
  // Marks the engine busy from the first await so Stop works while settings
  // and commands load, before the provider request exists.
  async function sendMessage(...args) {
    isStreaming = true;
    stopRequested = false;
    try {
      await sendMessageNow(...args);
    } finally {
      isStreaming = false;
      abortController = null;
    }
  }

  async function sendMessageNow(userText, images, onToken, onDone, onError, modelOverride = null) {
    // Get settings
    const settings = await new Promise(resolve => {
      chrome.storage.local.get(
        ['provider', 'apiKey', 'model', 'openaiApiKey', 'openaiModel', 'falApiKey', 'falModel', 'geminiApiKey', 'geminiModel', 'deepseekApiKey', 'deepseekModel', 'codexModel', 'codexEndpoint', 'localModel', 'localEndpoint', 'maxContext', 'customSystemPrompt', 'userMemory', 'webSearchEnabled'],
        resolve
      );
    });

    const memoryCommand = images?.length ? null : parseMemoryCommand(userText);
    if (memoryCommand) {
      const response = await applyMemoryCommand(memoryCommand, settings.userMemory);
      messages.push({ role: 'user', content: userText });
      messages.push({ role: 'assistant', content: response });
      onToken(response);
      onDone(response);
      return;
    }

    // Resolve the active provider, key, model, and endpoint
    const overrideProviderId = modelOverride?.providerId && PROVIDERS[modelOverride.providerId]
      ? modelOverride.providerId
      : null;
    const providerId = overrideProviderId || (PROVIDERS[settings.provider] ? settings.provider : 'anthropic');
    const provider = PROVIDERS[providerId];
    const apiKey = provider.apiKeyStorageKey ? settings[provider.apiKeyStorageKey] : '';
    const model = modelOverride?.model && overrideProviderId === providerId
      ? modelOverride.model
      : ((provider.modelStorageKey ? settings[provider.modelStorageKey] : '') || provider.defaultModel);
    let endpoint;

    try {
      endpoint = provider.buildEndpoint
        ? provider.buildEndpoint(model, settings)
        : provider.resolveEndpoint ? provider.resolveEndpoint(settings) : provider.endpoint;
    } catch (e) {
      onError(e.message);
      return;
    }

    if (provider.requiresApiKey && !apiKey) {
      onError(`No ${provider.label} API key set. Click the gear icon to open settings.`);
      return;
    }

    if (providerId === 'local' && SidekickProviders.isUnsupportedLocalChatModel(model)) {
      onError('That local model is loaded in LM Studio, but it does not stream visible chat text correctly in Sidekick. Use Gemma 4 12B or Qwen3 Coder 30B.');
      return;
    }

    const supportsImages = provider.supportsImages ||
      (providerId === 'local' && localModelSupportsImages(model)) ||
      (providerId === 'fal' && SidekickProviders.falModelSupportsImages(model));

    // Block unsupported image sends with a clear message instead of a raw API error.
    if (images && images.length > 0 && !supportsImages) {
      onError(provider.imageErrorMessage || `${provider.label} does not support images in Sidekick yet.`);
      return;
    }

    // Expand commands
    await commandsReady;
    const expandedText = expandCommand(userText);

    // Build user message content
    let userContent;
    if (images && images.length > 0) {
      userContent = [];
      for (const img of images) {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64
          }
        });
      }
      userContent.push({ type: 'text', text: expandedText });
    } else {
      userContent = expandedText;
    }

    // Add user message to history
    messages.push({ role: 'user', content: userContent });

    const includeContextInSystemPrompt = providerId !== 'local' && providerId !== 'codex';
    const finalSystemPrompt = buildSystemPrompt(settings.customSystemPrompt || '', includeContextInSystemPrompt, settings.userMemory);
    const webSearch = shouldAttachWebSearch(settings, providerId, model, userText);
    const body = provider.buildBody({
      model,
      messages,
      systemPrompt: finalSystemPrompt,
      provider,
      pageContext,
      conversationId,
      webSearch
    });

    if (stopRequested) {
      messages.pop();
      onDone('', buildResponseMeta(providerId, model));
      return;
    }

    // Start streaming
    isStreaming = true;
    const headers = provider.buildHeaders(apiKey);
    let fullResponse = '';

    try {
      if (provider.useBackgroundStream) {
        const backgroundAbort = createBackgroundAbort();
        abortController = backgroundAbort;
        fullResponse = await streamWithBackground({
          endpoint,
          headers,
          body,
          provider,
          onToken,
          abortControl: backgroundAbort
        });
      } else {
        abortController = new AbortController();
        fullResponse = await streamWithFetch({
          endpoint,
          headers,
          body,
          provider,
          signal: abortController.signal,
          onToken
        });
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: fullResponse });
      isStreaming = false;
      onDone(fullResponse, buildResponseMeta(providerId, model));

    } catch (e) {
      isStreaming = false;
      if (e.name === 'AbortError') {
        // User stopped the response — save partial text to history so Claude has context
        if (fullResponse) {
          messages.push({ role: 'assistant', content: fullResponse });
        }
        onDone(fullResponse || '', buildResponseMeta(providerId, model));
        return;
      }
      messages.pop(); // Remove failed user message
      if (providerId === 'local' && isLocalContextOverflowError(e)) {
        await retryAfterLocalContextOverflow({
          settings,
          userContent,
          images,
          onToken,
          onDone,
          onError
        });
        return;
      }
      if (providerId === 'local') {
        onError(e.message || 'Local model request failed before Sidekick received a response. Check LM Studio logs for prompt processing, timeout, or model errors.');
      } else {
        onError(e.message || 'Network error');
      }
    }
  }

  /**
   * Stop the current streaming response
   */
  function stopStreaming() {
    stopRequested = true;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isStreaming = false;
  }

  /**
   * Clear conversation history
   */
  function clearHistory() {
    messages = [];
  }

  /**
   * Export conversation as markdown
   */
  function exportMarkdown() {
    const date = new Date().toISOString().split('T')[0];
    let md = `# Sidekick Export\n`;

    if (pageContext) {
      md += `**Page:** ${pageContext.title}\n`;
      md += `**URL:** ${pageContext.url}\n`;
    }
    md += `**Date:** ${date}\n\n---\n`;

    if (pageContext && pageContext.content) {
      md += `\n## Page Context\n\n${pageContext.content}\n\n---\n`;
    }

    md += `\n## Conversation\n\n`;

    for (const msg of messages) {
      const role = msg.role === 'user' ? 'You' : 'Assistant';
      // Extract text from content (could be string or array)
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(p => p.type === 'text');
        text = textParts.map(p => p.text).join('\n');
        const imageParts = msg.content.filter(p => p.type === 'image');
        if (imageParts.length > 0) {
          text = `[${imageParts.length} image(s) attached]\n\n${text}`;
        }
      }
      md += `**${role}:** ${text}\n\n`;
    }

    return md;
  }

  return {
    commandsReady,
    setContext,
    discardContext,
    sendMessage,
    stopStreaming,
    clearHistory,
    exportMarkdown,
    expandCommand,
    getCommandMatches,
    get messages() { return messages; },
    get isStreaming() { return isStreaming; },
    get pageContext() { return pageContext; },
    get commands() { return commands; }
  };
}

function replaceAssistantDashCharacters(text) {
  return String(text || '').replace(/\s*[—–]\s*/g, ' - ');
}

function readMarkdownLink(source, index) {
  if (source[index] !== '[') return null;

  const labelEnd = source.indexOf(']', index + 1);
  if (labelEnd === -1 || source[labelEnd + 1] !== '(') return null;

  const targetEnd = source.indexOf(')', labelEnd + 2);
  if (targetEnd === -1) return null;

  return {
    label: source.slice(index + 1, labelEnd),
    target: source.slice(labelEnd + 2, targetEnd),
    end: targetEnd + 1
  };
}

function normalizeAssistantMarkdownProse(text) {
  const source = String(text || '');
  let result = '';
  let prose = '';
  let index = 0;

  const flushProse = () => {
    if (!prose) return;
    result += replaceAssistantDashCharacters(prose);
    prose = '';
  };

  while (index < source.length) {
    if (source.startsWith('```', index)) {
      flushProse();
      const fenceEnd = source.indexOf('```', index + 3);
      if (fenceEnd === -1) {
        result += source.slice(index);
        break;
      }
      result += source.slice(index, fenceEnd + 3);
      index = fenceEnd + 3;
      continue;
    }

    if (source[index] === '`') {
      const inlineEnd = source.indexOf('`', index + 1);
      if (inlineEnd !== -1 && !source.slice(index + 1, inlineEnd).includes('\n')) {
        flushProse();
        result += source.slice(index, inlineEnd + 1);
        index = inlineEnd + 1;
        continue;
      }
    }

    const link = readMarkdownLink(source, index);
    if (link) {
      flushProse();
      result += `[${normalizeAssistantMarkdownProse(link.label)}](${link.target})`;
      index = link.end;
      continue;
    }

    prose += source[index];
    index += 1;
  }

  flushProse();
  return result;
}

/**
 * Lightweight Markdown renderer
 * Handles: bold, italic, inline code, code blocks, headers, lists, links, paragraphs
 */
function renderMarkdown(text, options = {}) {
  if (!text) return '';

  const { normalizeAssistantProse = true } = options;
  const markdown = normalizeAssistantProse
    ? normalizeAssistantMarkdownProse(text)
    : String(text);

  // Escape HTML
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers (# ... ######)
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, text) => {
    const level = hashes.length;
    return `<h${level}>${text}</h${level}>`;
  });

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (*...*)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links [text](url) — whitelist safe schemes only to block javascript:, data:, file:, etc.
  const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    const trimmed = url.trim();
    let safe = false;
    try {
      const parsed = new URL(trimmed, 'https://invalid.local');
      safe = SAFE_SCHEMES.includes(parsed.protocol) ||
             (parsed.origin === 'https://invalid.local' && trimmed.startsWith('/'));
    } catch { safe = false; }
    if (!safe) return text;
    return `<a href="${trimmed.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Unordered lists (- item or * item)
  html = html.replace(/^(\s*)[*-]\s+(.+)$/gm, '$1<li>$2</li>');

  // Ordered lists (1. item)
  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> elements in <ul> or <ol>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');

  // Paragraphs — wrap remaining non-empty lines that aren't already wrapped
  const lines = html.split('\n');
  const result = [];
  let inParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isBlock = /^<(h[1-6]|pre|ul|ol|li|hr|blockquote)/.test(line)
      || /^<\/(pre|ul|ol)>/.test(line);

    if (!line) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
    } else if (isBlock) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(line);
    } else {
      if (!inParagraph) {
        result.push('<p>');
        inParagraph = true;
      }
      result.push(line);
    }
  }
  if (inParagraph) result.push('</p>');

  return result.join('\n');
}
