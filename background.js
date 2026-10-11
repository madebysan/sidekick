// Service worker: handles icon click, settings page, model discovery, TTS downloads, and conversation auto-save

importScripts('edition.js', 'providers.js');

const MODEL_CATALOG_STORAGE_KEY = SidekickProviders.MODEL_CATALOG_STORAGE_KEY;
const MODEL_CATALOG_TTL_MS = SidekickProviders.MODEL_CATALOG_TTL_MS;
const PROVIDER_DEFS = SidekickProviders.PROVIDERS;
const localTtsRequests = new Map();

// When extension icon is clicked, toggle the chat panel
chrome.action.onClicked.addListener(async (tab) => {
  // Don't run on chrome:// or extension pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleChat' });
  } catch (e) {
    // Content script not yet injected — inject the same files, in order, as the manifest.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: chrome.runtime.getManifest().content_scripts[0].js
    });
    // Try again after injection
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggleChat' });
      } catch (err) {
        console.error('Sidekick: Failed to toggle chat', err);
      }
    }, 200);
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getModelCatalog') {
    getModelCatalog({ forceRefresh: !!message.forceRefresh })
      .then(catalog => sendResponse({ ok: true, catalog }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error.message || 'Failed to load model catalog',
          catalog: SidekickProviders.buildFallbackCatalog()
        });
      });
    return true;
  } else if (message.action === 'openSettings') {
    chrome.runtime.openOptionsPage();
    return false;
  } else if (message.action === 'getTabId') {
    sendResponse(sender.tab?.id || null);
    return false;
  } else if (message.action === 'downloadFile') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    }, downloadId => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message || 'Download failed' });
        return;
      }
      sendResponse({ ok: true, downloadId });
    });
    return true;
  } else if (message.action === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      sendResponse(dataUrl || null);
    });
    return true; // Keep the message channel open for async sendResponse
  } else if (message.action === 'localTtsSpeech') {
    fetchLocalTtsSpeech(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || 'Local speech request failed' }));
    return true;
  } else if (message.action === 'cancelLocalTtsSpeech') {
    cancelLocalTtsSpeech(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || 'Local speech cancellation failed' }));
    return true;
  } else if (message.action === 'localTtsConfig') {
    fetchLocalTtsConfig(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || 'Local speech config failed' }));
    return true;
  } else if (message.action === 'indexTtsStartJob') {
    startLocalTtsJob(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || 'IndexTTS job failed to start' }));
    return true;
  } else if (message.action === 'indexTtsJobStatus') {
    fetchLocalTtsJobStatus(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || 'IndexTTS job status failed' }));
    return true;
  }
});

function isAllowedLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch (error) {
    return false;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function localSpeechServiceName(value) {
  const name = String(value || 'local speech').trim();
  return name || 'local speech';
}

// Translate Chrome's opaque "Failed to fetch" into a message that names the server
function localTtsConnectionError(endpoint, serviceName) {
  let origin = endpoint;
  try { origin = new URL(endpoint).origin; } catch (e) { /* keep raw value */ }
  return new Error(`Can't reach the ${localSpeechServiceName(serviceName)} server at ${origin}. Make sure it's running, then try again.`);
}

async function fetchLocalTtsSpeech(message) {
  if (!isAllowedLocalUrl(message.endpoint)) {
    throw new Error('Local speech endpoint must use localhost or 127.0.0.1.');
  }

  const requestId = String(message.requestId || message.body?.requestId || '').trim();
  const controller = new AbortController();
  if (requestId) {
    localTtsRequests.set(requestId, {
      controller,
      endpoint: message.endpoint,
      serviceName: message.serviceName
    });
  }

  let response;
  try {
    response = await fetch(message.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.body || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Speech generation canceled.');
    }
    throw localTtsConnectionError(message.endpoint, message.serviceName);
  } finally {
    if (requestId) localTtsRequests.delete(requestId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Local speech server returned ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'audio/mpeg';
  const buffer = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  return {
    ok: true,
    dataUrl: `data:${contentType};base64,${base64}`
  };
}

function getLocalTtsCancelEndpoint(endpoint) {
  const url = new URL(endpoint);
  url.pathname = '/cancel';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function cancelLocalTtsSpeech(message) {
  const requestId = String(message.requestId || '').trim();
  if (!requestId) return { ok: true, canceled: false };

  const request = localTtsRequests.get(requestId);
  if (request) {
    request.controller.abort();
    localTtsRequests.delete(requestId);
  }

  const endpoint = message.endpoint || request?.endpoint || '';
  if (isAllowedLocalUrl(endpoint)) {
    const cancelEndpoint = getLocalTtsCancelEndpoint(endpoint);
    await fetch(cancelEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId })
    }).catch(() => {});
  }

  return { ok: true, canceled: !!request };
}

async function fetchLocalTtsConfig(message) {
  if (!isAllowedLocalUrl(message.endpoint)) {
    throw new Error('Local speech endpoint must use localhost or 127.0.0.1.');
  }

  let response;
  try {
    response = await fetch(message.endpoint, { cache: 'no-store' });
  } catch (error) {
    throw localTtsConnectionError(message.endpoint, message.serviceName);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Local speech server returned ${response.status}`);
  }

  return {
    ok: true,
    config: await response.json()
  };
}

async function startLocalTtsJob(message) {
  if (!isAllowedLocalUrl(message.endpoint)) {
    throw new Error('Local speech endpoint must use localhost or 127.0.0.1.');
  }

  let response;
  try {
    response = await fetch(message.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.body || {})
    });
  } catch (error) {
    throw localTtsConnectionError(message.endpoint, message.serviceName);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Local speech server returned ${response.status}`);
  }

  return await response.json();
}

async function fetchLocalTtsJobStatus(message) {
  if (!isAllowedLocalUrl(message.endpoint)) {
    throw new Error('Local speech endpoint must use localhost or 127.0.0.1.');
  }

  let response;
  try {
    response = await fetch(message.endpoint, { cache: 'no-store' });
  } catch (error) {
    throw localTtsConnectionError(message.endpoint, message.serviceName);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Local speech server returned ${response.status}`);
  }

  return await response.json();
}

async function getModelCatalog({ forceRefresh = false } = {}) {
  const storageKeys = [
    MODEL_CATALOG_STORAGE_KEY,
    PROVIDER_DEFS.local.endpointStorageKey,
    ...SidekickProviders.getApiKeyStorageKeys()
  ];
  const settings = await chrome.storage.local.get(storageKeys);
  const cached = settings[MODEL_CATALOG_STORAGE_KEY] || null;
  const providers = {};

  for (const providerId of Object.keys(PROVIDER_DEFS)) {
    providers[providerId] = await getProviderCatalogEntry(providerId, settings, cached, forceRefresh);
  }

  const catalog = {
    fetchedAt: Date.now(),
    providers
  };

  await chrome.storage.local.set({ [MODEL_CATALOG_STORAGE_KEY]: catalog });
  return catalog;
}

async function getProviderCatalogEntry(providerId, settings, cached, forceRefresh) {
  const provider = PROVIDER_DEFS[providerId];
  const cachedEntry = cached?.providers?.[providerId] || null;
  const fallbackEntry = {
    models: SidekickProviders.normalizeModelOptions(provider.models),
    source: 'fallback',
    fetchedAt: 0
  };

  if (provider.modelCatalogStatic) {
    return {
      ...fallbackEntry,
      source: 'static'
    };
  }

  const key = provider.apiKeyStorageKey ? settings[provider.apiKeyStorageKey] : '';
  if (!key && provider.modelListRequiresApiKey !== false) {
    if (cachedEntry?.models?.length && (cachedEntry.source === 'live' || cachedEntry.source === 'cache')) {
      return {
        ...cachedEntry,
        source: 'cache',
        error: 'Add an API key in Settings to refresh this provider.'
      };
    }
    return {
      ...fallbackEntry,
      error: 'Add an API key in Settings to refresh this provider.'
    };
  }

  const hasFreshLiveCache = providerId !== 'local' &&
    (cachedEntry?.source === 'live' || cachedEntry?.source === 'cache') &&
    cachedEntry?.fetchedAt &&
    Date.now() - cachedEntry.fetchedAt < MODEL_CATALOG_TTL_MS;

  if (!forceRefresh && hasFreshLiveCache) {
    return { ...cachedEntry, source: 'cache' };
  }

  try {
    const models = await fetchProviderModels(providerId, key, settings);
    if (!models.length) throw new Error('Provider returned no compatible chat models.');
    return {
      models,
      source: 'live',
      fetchedAt: Date.now()
    };
  } catch (error) {
    if (cachedEntry?.models?.length) {
      return {
        ...cachedEntry,
        source: 'cache',
        error: error.message || 'Model refresh failed.'
      };
    }
    return {
      ...fallbackEntry,
      error: error.message || 'Model refresh failed.'
    };
  }
}

async function fetchProviderModels(providerId, key, settings = {}) {
  if (providerId === 'anthropic') return fetchAnthropicModels(key);
  if (providerId === 'openai') return fetchOpenAiModels(key);
  if (providerId === 'fal') return fetchFalModels();
  if (providerId === 'gemini') return fetchGeminiModels(key);
  if (providerId === 'deepseek') return fetchDeepSeekModels(key);
  if (providerId === 'local') return fetchLocalModels(settings);
  return [];
}

async function fetchAnthropicModels(key) {
  const data = await fetchJsonWithTimeout('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    }
  });

  return (data.data || [])
    .filter(model => model?.id)
    .map(model => SidekickProviders.createModelOption('anthropic', model.id, model.display_name));
}

async function fetchOpenAiModels(key) {
  const data = await fetchJsonWithTimeout('https://api.openai.com/v1/models', {
    headers: {
      'Authorization': `Bearer ${key}`
    }
  });

  return (data.data || [])
    .filter(model => SidekickProviders.isOpenAiChatModelId(model?.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(model => SidekickProviders.createModelOption('openai', model.id));
}

async function fetchDeepSeekModels(key) {
  const data = await fetchJsonWithTimeout('https://api.deepseek.com/models', {
    headers: {
      'Authorization': `Bearer ${key}`
    }
  });

  return (data.data || [])
    .filter(model => model?.id)
    .map(model => SidekickProviders.createModelOption('deepseek', model.id));
}

async function fetchFalModels() {
  const data = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/models');

  return (data.data || [])
    .filter(model => model?.id && isFalTextModel(model))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(model => SidekickProviders.createModelOption('fal', model.id, model.name));
}

async function fetchGeminiModels(key) {
  const data = await fetchJsonWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: {
      'x-goog-api-key': key
    }
  });

  return (data.models || [])
    .filter(model => isGeminiTextModel(model))
    .map(model => SidekickProviders.createModelOption(
      'gemini',
      String(model.name || '').replace(/^models\//, ''),
      model.displayName
    ));
}

async function fetchLocalModels(settings) {
  const endpoint = SidekickProviders.normalizeLocalEndpoint(settings.localEndpoint || PROVIDER_DEFS.local.defaultEndpoint);
  const modelsUrl = new URL(endpoint);
  modelsUrl.pathname = '/v1/models';
  modelsUrl.search = '';
  modelsUrl.hash = '';

  const data = await fetchJsonWithTimeout(modelsUrl.toString());
  return (data.data || [])
    .filter(model => isLocalChatModel(model?.id))
    .map(model => SidekickProviders.createModelOption('local', model.id));
}

function isLocalChatModel(id) {
  const modelId = String(id || '').toLowerCase();
  if (!modelId) return false;
  if (SidekickProviders.isUnsupportedLocalChatModel(modelId)) return false;

  const excluded = ['embedding', 'embed', 'rerank', 'moderation', 'audio', 'tts', 'whisper'];
  return !excluded.some(term => modelId.includes(term));
}

function isGeminiTextModel(model) {
  const methods = model.supportedGenerationMethods || [];
  const name = String(model.name || '').toLowerCase();
  const displayName = String(model.displayName || '').toLowerCase();
  const excluded = ['embedding', 'imagen', 'veo', 'tts', 'audio', 'live', 'translate', 'robotics'];
  return methods.includes('generateContent') &&
    !excluded.some(term => name.includes(term) || displayName.includes(term));
}

function isFalTextModel(model) {
  const outputModalities = model.architecture?.output_modalities || [];
  if (outputModalities.length && !outputModalities.includes('text')) return false;

  const inputModalities = model.architecture?.input_modalities || [];
  if (inputModalities.length && !inputModalities.includes('text')) return false;

  const id = String(model.id || '').toLowerCase();
  const name = String(model.name || '').toLowerCase();
  const excluded = ['embedding', 'moderation', 'content-safety', 'image', 'audio', 'tts', 'transcribe'];
  return !excluded.some(term => id.includes(term) || name.includes(term));
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(getErrorMessage(errorData, response.status));
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getErrorMessage(errorData, status) {
  if (typeof errorData.detail === 'string') return errorData.detail;
  if (typeof errorData.error === 'string') return errorData.error;
  if (typeof errorData.message === 'string') return errorData.message;
  if (typeof errorData.error?.message === 'string') return errorData.error.message;
  return `API error: ${status}`;
}

// Stream provider requests from the extension service worker. Content scripts
// can be blocked by page-origin CORS when calling localhost or some APIs.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidekickProviderStream' && port.name !== 'sidekickLocalStream') return;

  let abortController = null;
  let isPortOpen = true;
  let timeoutId = null;
  let timedOut = false;
  let stalled = false;
  let stallId = null;
  let userAborted = false;

  function postToPort(message) {
    if (!isPortOpen) return;
    try {
      port.postMessage(message);
    } catch {
      isPortOpen = false;
    }
  }

  function disconnectPort() {
    if (!isPortOpen) return;
    try {
      port.disconnect();
    } catch {
      // Port may already be closed by the content script.
    }
    isPortOpen = false;
  }

  function finishStream(message) {
    postToPort(message);
    setTimeout(disconnectPort, 50);
  }

  port.onMessage.addListener(async (message) => {
    if (message.type === 'abort') {
      userAborted = true;
      if (abortController) abortController.abort();
      return;
    }

    if (message.type !== 'start') return;

    abortController = new AbortController();
    timedOut = false;
    stalled = false;
    userAborted = false;

    // Aborts when no bytes arrive for stallTimeoutMs (reset on every chunk).
    const armStallTimer = () => {
      if (!(message.stallTimeoutMs > 0)) return;
      clearTimeout(stallId);
      stallId = setTimeout(() => {
        stalled = true;
        if (abortController) abortController.abort();
      }, message.stallTimeoutMs);
    };
    armStallTimer();

    if (message.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        if (abortController) abortController.abort();
      }, message.timeoutMs);
    }

    try {
      const response = await fetch(message.endpoint, {
        method: 'POST',
        headers: message.headers,
        body: JSON.stringify(message.body),
        signal: abortController.signal
      });

      if (!response.ok) {
        finishStream({
          type: 'error',
          error: await getResponseErrorMessage(response)
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armStallTimer();
        postToPort({
          type: 'chunk',
          text: decoder.decode(value, { stream: true })
        });
      }

      const remaining = decoder.decode();
      if (remaining) {
        postToPort({ type: 'chunk', text: remaining });
      }

      finishStream({ type: 'done' });
    } catch (e) {
      if (e.name === 'AbortError' && userAborted) {
        finishStream({ type: 'done' });
      } else if (e.name === 'AbortError' && stalled) {
        finishStream({
          type: 'error',
          error: message.stallError || 'The model stopped sending data. Try again or pick another model.'
        });
      } else if (e.name === 'AbortError' && timedOut) {
        finishStream({
          type: 'error',
          error: message.timeoutError || 'The local model was still processing the prompt and did not stream text before Sidekick timed out. Try a shorter transcript, reduce Max Context, or load the model with a larger context window in LM Studio.'
        });
      } else {
        finishStream({
          type: 'error',
          error: e.message || 'Provider request failed'
        });
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      clearTimeout(stallId);
      stallId = null;
    }
  });

  port.onDisconnect.addListener(() => {
    isPortOpen = false;
    if (timeoutId) clearTimeout(timeoutId);
    clearTimeout(stallId);
    if (abortController) abortController.abort();
  });
});

async function getResponseErrorMessage(response) {
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      return getErrorMessage(JSON.parse(text), response.status);
    } catch {
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return plain || `API error: ${response.status}`;
    }
  }
  return `API error: ${response.status}`;
}

// ─── AUTO-SAVE CONVERSATION ON TAB CLOSE ────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storageKey = `conversation_${tabId}`;

  try {
    const result = await chrome.storage.local.get([storageKey, 'autoSaveConversations']);
    const shouldAutoSave = result.autoSaveConversations !== false;
    const conversation = result[storageKey];

    if (!conversation || !conversation.messages || conversation.messages.length === 0) {
      return; // No conversation to save
    }

    if (!shouldAutoSave) {
      await chrome.storage.local.remove(storageKey);
      return;
    }

    // Build markdown export
    const markdown = buildConversationMarkdown(conversation);

    // Build a safe folder name from the tab source
    const safeTitle = getSourceFilenameBase(conversation);
    const dateStr = formatDateForFilename(conversation.timestamp);
    const folderName = `Temp/sidekick-logs/${safeTitle} - ${dateStr}`;

    // Save markdown via chrome.downloads (using data URL — no Blob/createObjectURL in service workers)
    const mdDataUrl = 'data:text/markdown;base64,' + btoa(unescape(encodeURIComponent(markdown)));
    chrome.downloads.download({
      url: mdDataUrl,
      filename: `${folderName}/${safeTitle} - ${dateStr}.md`,
      saveAs: false
    });

    // Save any audio files
    if (conversation.audioFiles && conversation.audioFiles.length > 0) {
      conversation.audioFiles.forEach((audio, i) => {
        if (audio.dataUrl) {
          const paddedIndex = String(i + 1).padStart(3, '0');
          chrome.downloads.download({
            url: audio.dataUrl,
            filename: `${folderName}/${safeTitle} - ${dateStr} - audio-${paddedIndex}.mp3`,
            saveAs: false
          });
        }
      });
    }

    // Clean up: remove the conversation from storage
    chrome.storage.local.remove(storageKey);
  } catch (e) {
    console.error('Sidekick: Failed to save conversation on tab close', e);
  }
});

// ─── HELPERS ────────────────────────────────────────────────────────

function buildConversationMarkdown(conversation) {
  const date = conversation.timestamp
    ? new Date(conversation.timestamp).toLocaleString()
    : new Date().toLocaleString();

  let md = `# Sidekick Conversation\n`;
  md += `**Page:** [${conversation.tabTitle || 'Untitled'}](${conversation.url || ''})\n`;
  md += `**Date:** ${date}\n\n---\n\n`;

  let audioIndex = 0;
  for (const msg of conversation.messages) {
    const heading = msg.role === 'user' ? 'User' : 'Assistant';
    md += `## ${heading}\n${msg.text}\n`;

    // Check if this assistant message has an associated audio file
    if (msg.role === 'assistant' && conversation.audioFiles && audioIndex < conversation.audioFiles.length) {
      const paddedIndex = String(audioIndex + 1).padStart(3, '0');
      md += `\n[Audio: audio-${paddedIndex}.mp3]\n`;
      audioIndex++;
    }

    md += '\n';
  }

  return md;
}

function sanitizeFilename(name) {
  // Remove characters not allowed in filenames
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80); // Cap length
}

function getSourceFilenameBase(conversation) {
  const domain = getFilenameDomain(conversation.url);
  const title = sanitizeFilename(conversation.tabTitle || 'Untitled');
  return `${domain} - ${title}`.slice(0, 100);
}

function getFilenameDomain(url) {
  try {
    const parsed = new URL(url);
    return sanitizeFilename(parsed.hostname.replace(/^www\./, '')) || 'page';
  } catch {
    return 'page';
  }
}

function formatDateForFilename(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}`;
}
