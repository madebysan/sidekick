// Content script: Shadow DOM chat UI, page extraction, resize, image drop
// Runs on every page — one instance per tab = independent conversations

(function() {
  'use strict';

  // Prevent double-injection
  if (window.__sidekickInjected) return;
  window.__sidekickInjected = true;

  // ─── STATE ──────────────────────────────────────────────────────────
  let chatVisible = false;
  let chatEngine = null;
  let ttsEngine = null;
  let activeSend = null;        // { stopped } for the reply currently streaming
  let shadowRoot = null;
  let pendingImages = [];  // Array of {base64, mediaType, name}
  let pendingFiles = [];   // Array of {name, text}
  let bubbleCounter = 0;   // For unique bubble IDs
  let currentTabId = null;  // Cached tab ID for conversation sync
  let floatingBtn = null;   // Floating button element
  let floatingBtnEnabled = false;
  let selectedChatProvider = null;
  let selectedChatModel = null;
  let pageContextPromise = null;
  let pageContextLoading = false;
  let contextSendPending = false;
  let contextDiscarded = false;
  const LISTEN_CONTEXT_CHAR_LIMIT = 200000;
  // ElevenLabs is the default listen/speak engine. Local engines stay in Settings.
  const DEFAULT_TTS_ENGINE = 'elevenlabs';
  const DEFAULT_CHATTERBOX_VOICE = 'default';
  const DEFAULT_INDEXTTS_ENDPOINT = 'http://localhost:8790';
  const AUDIO_DEFAULTS_VERSION = 'elevenlabs-default-20260909';
  const FAL_DEFAULTS_VERSION = 'fal-gemini-3.8-flash-default-20260909';
  const PREVIOUS_FAL_DEFAULT_MODELS = [
    'deepseek/deepseek-v4-flash',
    'anthropic/claude-sonnet-4.6'
  ];
  const DEFAULT_FONT_FAMILY = 'system-ui';
  // Matches the font choices in options.html; anything else (e.g. a hand-edited import) falls back.
  const ALLOWED_FONT_FAMILIES = [
    'system-ui',
    "'DM Sans', sans-serif",
    "'IBM Plex Sans', sans-serif",
    "'Source Sans 3', sans-serif"
  ];
  const CONTEXT_ICONS = {
    page: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    youtube: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>'
  };
  const ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  let currentFont = DEFAULT_FONT_FAMILY;
  let audioDefaultsMigrationPromise = null;
  let falDefaultsMigrationPromise = null;

  // ─── LOAD ENGINES ─────────────────────────────────────────────────
  // chat.js and tts.js are loaded before content.js via manifest content_scripts order

  function loadChatEngine() {
    if (typeof createChatEngine === 'function') {
      return createChatEngine();
    }
    console.error('Sidekick: chat.js not loaded');
    return null;
  }

  function loadTTSEngine() {
    if (typeof createTTSEngine === 'function') {
      return createTTSEngine();
    }
    console.error('Sidekick: tts.js not loaded');
    return null;
  }

  function ensureAudioDefaultsMigrated() {
    if (audioDefaultsMigrationPromise) return audioDefaultsMigrationPromise;
    audioDefaultsMigrationPromise = new Promise(resolve => {
      chrome.storage.local.get(
        ['sidekickAudioDefaultsVersion', 'indexTtsEndpoint', 'chatterboxVoice'],
        result => {
          if (result.sidekickAudioDefaultsVersion === AUDIO_DEFAULTS_VERSION) {
            resolve();
            return;
          }

          const updates = {
            sidekickAudioDefaultsVersion: AUDIO_DEFAULTS_VERSION,
            ttsEngine: DEFAULT_TTS_ENGINE
          };
          if (!result.chatterboxVoice) updates.chatterboxVoice = DEFAULT_CHATTERBOX_VOICE;
          if (!result.indexTtsEndpoint) updates.indexTtsEndpoint = DEFAULT_INDEXTTS_ENDPOINT;
          chrome.storage.local.set(updates, resolve);
        }
      );
    });
    return audioDefaultsMigrationPromise;
  }

  function ensureFalDefaultsMigrated() {
    if (falDefaultsMigrationPromise) return falDefaultsMigrationPromise;
    falDefaultsMigrationPromise = new Promise(resolve => {
      chrome.storage.local.get(
        ['sidekickFalDefaultsVersion', 'falModel'],
        result => {
          if (result.sidekickFalDefaultsVersion === FAL_DEFAULTS_VERSION) {
            resolve();
            return;
          }

          const updates = {
            sidekickFalDefaultsVersion: FAL_DEFAULTS_VERSION
          };
          if (!result.falModel || PREVIOUS_FAL_DEFAULT_MODELS.includes(result.falModel)) {
            updates.falModel = SidekickProviders.PROVIDERS.fal.defaultModel;
          }
          chrome.storage.local.set(updates, resolve);
        }
      );
    });
    return falDefaultsMigrationPromise;
  }

  // Get and cache the tab ID for conversation syncing
  function getTabId() {
    return new Promise((resolve) => {
      if (currentTabId) {
        resolve(currentTabId);
        return;
      }
      safeSendMessage({ action: 'getTabId' }, (tabId) => {
        currentTabId = tabId;
        resolve(tabId);
      });
    });
  }

  // ─── CREATE SHADOW DOM ──────────────────────────────────────────────
  function createChatUI() {
    // Host element
    const host = document.createElement('div');
    host.id = 'sidekick-host';
    host.style.cssText = 'all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;font-family:system-ui;';
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'closed' });

    // Load CSS
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = chrome.runtime.getURL('chat.css');
    shadowRoot.appendChild(cssLink);

    // Chat container
    const container = document.createElement('div');
    container.className = 'sidekick-container';
    container.innerHTML = buildChatHTML();
    shadowRoot.appendChild(container);

    // Apply saved size, font, theme, and chat appearance
    chrome.storage.local.get(['chatWidth', 'chatHeight', 'fontFamily', 'theme', 'chatAppearance'], (result) => {
      if (result.chatWidth) container.style.width = result.chatWidth + 'px';
      if (result.chatHeight) container.style.height = result.chatHeight + 'px';
      applyFont(result.fontFamily || DEFAULT_FONT_FAMILY);
      applyTheme(container, result.theme || 'auto');
      applyAppearance(container, result.chatAppearance || 'glass');
    });

    // Listen for setting changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.fontFamily) {
        applyFont(changes.fontFamily.newValue || DEFAULT_FONT_FAMILY);
      }
      if (changes.theme) {
        applyTheme(container, changes.theme.newValue || 'auto');
      }
      if (changes.chatAppearance) {
        applyAppearance(container, changes.chatAppearance.newValue || 'glass');
      }
    });

    // Stop keyboard/mouse events from leaking to the host page
    const stopPropagationEvents = [
      'keydown', 'keyup', 'keypress', 'input',
      'mousedown', 'mouseup', 'click',
      'focus', 'blur', 'focusin', 'focusout'
    ];
    stopPropagationEvents.forEach(eventType => {
      container.addEventListener(eventType, (e) => {
        e.stopPropagation();
      });
    });

    setupEventListeners(container);
    setupModelPicker(container);
    setupResize(container);
    setupImageDrop(container);

    return container;
  }

  function buildChatHTML() {
    return `
      <!-- Resize handles -->
      <div class="resize-handle resize-left"></div>
      <div class="resize-handle resize-top"></div>
      <div class="resize-handle resize-corner"></div>

      <!-- Header -->
      <div class="chat-header">
        <div class="chat-header-main">
          <select class="chat-model-select" title="Model"></select>
        </div>
        <div class="chat-actions">
          <button class="action-btn" data-action="settings" title="Settings" aria-label="Open settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="action-btn" data-action="listen-page" data-state="idle" title="Listen to page" aria-label="Listen to page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          </button>
          <button class="action-btn" data-action="download" title="Download conversation" aria-label="Download conversation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="action-btn" data-action="close" title="Close" aria-label="Close Sidekick">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Context banner -->
      <div class="context-banner" style="display:none;">
        <div class="context-info">
          <span class="context-icon" aria-hidden="true"></span>
          <span class="context-text"></span>
        </div>
        <div class="context-actions">
          <button class="context-download" title="Download transcript" aria-label="Download YouTube transcript" hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="context-discard" title="Discard context" aria-label="Discard page context">${ICON_X}</button>
        </div>
      </div>

      <!-- Listen status -->
      <div class="listen-bar" hidden>
        <button type="button" class="listen-toggle-btn" hidden aria-label="Pause audio"></button>
        <span class="listen-indicator" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="listen-status"></span>
        <div class="listen-progress" hidden>
          <span class="listen-time listen-elapsed">0:00</span>
          <input type="range" class="listen-seek" min="0" max="1000" step="1" value="0" aria-label="Seek page audio">
          <span class="listen-time listen-total">0:00</span>
          <button type="button" class="listen-speed-btn" title="Playback speed" aria-label="Playback speed 1x">1x</button>
        </div>
        <button class="listen-download-btn" hidden title="Download audio">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          MP3
        </button>
        <button type="button" class="listen-close-btn" title="Stop and close player" aria-label="Stop and close player">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <!-- Messages area -->
      <div class="chat-messages">
        <div class="welcome-message">
          <p><strong>Ask anything about this page.</strong></p>
          <div class="command-pills"></div>
        </div>
      </div>

      <!-- Scroll to bottom button -->
      <button class="scroll-bottom-btn" style="display:none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      <!-- Image preview area -->
      <div class="image-preview-area" style="display:none;"></div>

      <!-- Command autocomplete -->
      <div class="command-autocomplete" style="display:none;"></div>

      <!-- Input area -->
      <div class="chat-input-area">
        <div class="drop-overlay" style="display:none;">Drop images or files here</div>
        <textarea class="chat-input" placeholder="Type a message or /command..." rows="1"></textarea>
        <input class="chat-file-input" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,.txt,.md,.markdown,.json,.csv,.html,.css,.js,.ts,.tsx,.jsx,.py,.xml,.yml,.yaml,.log" hidden>
        <button class="composer-btn" data-action="attach" title="Attach images or files" aria-label="Attach images or files">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button class="composer-btn" data-action="screenshot" title="Screenshot visible page" aria-label="Screenshot visible page">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
        </button>
        <button class="send-btn" title="Send message" aria-label="Send message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
        </button>
      </div>
    `;
  }

  function resizeChatInput(input) {
    const maxHeight = 120;
    const minHeight = parseFloat(getComputedStyle(input).minHeight) || 36;
    input.style.height = `${minHeight}px`;
    const nextHeight = Math.min(Math.max(input.scrollHeight, minHeight), maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function isYouTubeWatchPage() {
    return location.hostname.includes('youtube.com') && location.pathname === '/watch';
  }

  function formatContextLabel(context) {
    const rawTitle = String(context?.title || document.title || 'This page');
    const title = rawTitle.length > 60 ? `${rawTitle.slice(0, 60)}...` : rawTitle;
    if (context?.error) {
      return `Context: "${title}" · transcript unavailable`;
    }
    return `Context: "${title}"`;
  }

  function applyContextBanner(container, context) {
    const banner = container.querySelector('.context-banner');
    if (!banner || !context) return;
    const icon = context.type === 'youtube' ? CONTEXT_ICONS.youtube : CONTEXT_ICONS.page;
    banner.querySelector('.context-icon').innerHTML = icon;
    banner.querySelector('.context-download').hidden =
      context.type !== 'youtube' || !!context.error || !context.transcript;
    banner.querySelector('.context-text').textContent = formatContextLabel(context);
    banner.dataset.ready = 'true';
  }

  function conversationHasMessages(container) {
    return !!container.querySelector('.chat-messages .message');
  }

  function composerHasDraft(container) {
    const input = container.querySelector('.chat-input');
    return Boolean(input?.value.trim() || pendingImages.length || pendingFiles.length);
  }

  function syncContextBanner(container) {
    const banner = container.querySelector('.context-banner');
    if (!banner) return;
    const show = banner.dataset.ready === 'true'
      && !contextDiscarded
      && !conversationHasMessages(container)
      && !composerHasDraft(container);
    banner.style.display = show ? 'flex' : 'none';
  }

  // ─── EVENT LISTENERS ────────────────────────────────────────────────
  function setupEventListeners(container) {
    const messagesArea = container.querySelector('.chat-messages');
    const input = container.querySelector('.chat-input');
    const sendBtn = container.querySelector('.send-btn');
    const scrollBtn = container.querySelector('.scroll-bottom-btn');
    const autocomplete = container.querySelector('.command-autocomplete');

    // Action buttons (header)
    container.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        if (action === 'close') {
          toggleChat(false);
        } else if (action === 'settings') {
          safeSendMessage({ action: 'openSettings' });
        } else if (action === 'download') {
          downloadConversation();
        } else if (action === 'listen-page') {
          handleListenPageClick(container, btn);
        }
      });
    });

    // Context actions
    container.querySelector('.context-download').addEventListener('click', downloadTranscript);

    container.querySelector('.context-discard').addEventListener('click', () => {
      contextDiscarded = true;
      if (chatEngine) chatEngine.discardContext();
      const banner = container.querySelector('.context-banner');
      if (banner) delete banner.dataset.ready;
      syncContextBanner(container);
    });

    container.querySelector('.listen-download-btn').addEventListener('click', downloadPageAudio);
    container.querySelector('.listen-close-btn').addEventListener('click', closeListenPlayer);
    setupListenSeek(container);

    // Send message
    sendBtn.addEventListener('click', () => handleSend(container));

    const fileInput = container.querySelector('.chat-file-input');
    container.querySelector('[data-action="attach"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      ingestFiles(fileInput.files, container);
      fileInput.value = '';
    });
    container.querySelector('[data-action="screenshot"]').addEventListener('click', () => captureScreenshot(container));

    // Enter to send, Shift+Enter for newline
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(container);
      }
      // Escape to close autocomplete
      if (e.key === 'Escape') {
        autocomplete.style.display = 'none';
      }
      // Arrow keys for autocomplete navigation
      if (autocomplete.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          navigateAutocomplete(autocomplete, e.key === 'ArrowDown' ? 1 : -1);
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && autocomplete.querySelector('.active'))) {
          if (autocomplete.querySelector('.active')) {
            e.preventDefault();
            selectAutocompleteItem(container, autocomplete);
          }
        }
      }
    });

    // Grow the textarea only after the text wraps past one line
    input.addEventListener('input', () => {
      resizeChatInput(input);
      syncContextBanner(container);

      // Command autocomplete
      const text = input.value;
      if (text.startsWith('/') && !text.includes(' ') && chatEngine) {
        const matches = chatEngine.getCommandMatches(text);
        if (matches.length > 0) {
          showAutocomplete(autocomplete, matches);
        } else {
          autocomplete.style.display = 'none';
        }
      } else {
        autocomplete.style.display = 'none';
      }
    });

    // Scroll-to-bottom button: show when user has scrolled up
    messagesArea.addEventListener('scroll', () => {
      const atBottom = messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < 50;
      scrollBtn.style.display = atBottom ? 'none' : 'flex';
    });

    scrollBtn.addEventListener('click', () => {
      messagesArea.scrollTo({ top: messagesArea.scrollHeight, behavior: 'smooth' });
      scrollBtn.style.display = 'none';
    });
  }

  // ─── MODEL PICKER ──────────────────────────────────────────────────
  function setupModelPicker(container) {
    const select = container.querySelector('.chat-model-select');
    if (!select || typeof getSidekickProviderModelConfig !== 'function') {
      if (select) select.style.display = 'none';
      return;
    }

    let providerConfigs = getSidekickProviderModelConfig();
    renderAndApplyModelOptions();
    loadChatModelCatalog(false);

    select.addEventListener('change', () => {
      const selection = parseModelSelection(select.value);
      if (!selection) return;
      applyChatModelSelection(select, selection);
      saveChatModelDefault(providerConfigs, selection);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const modelKeys = getModelSelectionStorageKeys();
      const apiKeyChanged = getProviderApiKeyStorageKeys().some(key => changes[key]);
      const modelSelectionChanged = modelKeys.some(key => changes[key]);

      if (apiKeyChanged) {
        loadChatModelCatalog(true);
        return;
      }

      if (modelSelectionChanged || changes.webSearchEnabled) {
        renderAndApplyModelOptions();
      }
    });

    function renderAndApplyModelOptions() {
      chrome.storage.local.get(getModelPickerStorageKeys(), (settings) => {
        const visibleProviderConfigs = getConfiguredProviderConfigs(providerConfigs, settings);
        if (!visibleProviderConfigs.length) {
          selectedChatProvider = null;
          selectedChatModel = null;
          select.style.display = 'none';
          select.textContent = '';
          return;
        }

        select.style.display = '';
        const searchOn = isWebSearchActive(settings);
        const headerProviderConfigs = visibleProviderConfigs.map(provider => trimHeaderModels(provider, settings));
        renderModelOptions(select, headerProviderConfigs, searchOn);
        const selection = resolveModelSelection(headerProviderConfigs, settings);
        applyChatModelSelection(select, selection);
        persistWebSearchModelSwitch(settings, selection);
      });
    }

    function loadChatModelCatalog(forceRefresh) {
      safeSendMessage({ action: 'getModelCatalog', forceRefresh }, (response) => {
        if (!response?.catalog) return;
        providerConfigs = getSidekickProviderModelConfig(response.catalog);
        renderAndApplyModelOptions();
      });
    }
  }

  function getModelSelectionStorageKeys() {
    const keys = typeof SidekickProviders === 'object'
      ? SidekickProviders.getModelStorageKeys()
      : ['model', 'openaiModel', 'falModel', 'geminiModel', 'deepseekModel', 'localModel'];
    return ['provider', ...keys];
  }

  function getProviderApiKeyStorageKeys() {
    return typeof SidekickProviders === 'object'
      ? SidekickProviders.getApiKeyStorageKeys()
      : ['apiKey', 'openaiApiKey', 'falApiKey', 'geminiApiKey', 'deepseekApiKey'];
  }

  function getModelPickerStorageKeys() {
    return [...new Set([
      ...getModelSelectionStorageKeys(),
      ...getProviderApiKeyStorageKeys(),
      'webSearchEnabled',
      SidekickProviders.WEB_SEARCH_PREVIOUS_SELECTION_KEY
    ])];
  }

  function getConfiguredProviderConfigs(providerConfigs, settings) {
    const providerDefs = typeof SidekickProviders === 'object' ? SidekickProviders.PROVIDERS : {};

    return providerConfigs.filter(provider => {
      const definition = providerDefs[provider.providerId];
      if (!definition?.apiKeyStorageKey) {
        return true;
      }
      return !!String(settings[definition.apiKeyStorageKey] || '').trim();
    });
  }

  // Fal routes to OpenRouter's whole catalog, so the header keeps only the newest
  // few models per main lab. Settings still lists everything.
  const HEADER_MODEL_LABS = ['google', 'anthropic', 'openai', 'deepseek', 'qwen'];
  const HEADER_MODELS_PER_LAB = 3;
  const HEADER_MODEL_EXCLUDE = /batch|preview|free|\bexp\b|experimental|beta|latest|image|audio|tts|embed|nano banana/i;

  function trimHeaderModels(provider, settings) {
    if (provider.providerId !== 'fal') return provider;
    const keep = new Set([
      settings[provider.modelStorageKey],
      provider.defaultModel,
      SidekickProviders.WEB_SEARCH_DEFAULT_MODEL
    ].filter(Boolean));
    const perLab = new Map();
    const labOf = model => String(model.value).split('/')[0].toLowerCase();
    // Catalog order is newest first, so the first matches per lab are the latest.
    const models = provider.models.filter(model => {
      if (keep.has(model.value)) return true;
      const lab = labOf(model);
      if (!HEADER_MODEL_LABS.includes(lab)) return false;
      if (HEADER_MODEL_EXCLUDE.test(`${model.value} ${model.label}`)) return false;
      // Dated snapshots ("-0813", "-2026-09-02") duplicate the plain release.
      if (/-\d{4}(-\d{2}){0,2}$/.test(model.value)) return false;
      const count = perLab.get(lab) || 0;
      if (count >= HEADER_MODELS_PER_LAB) return false;
      perLab.set(lab, count + 1);
      return true;
    });
    const labRank = model => {
      const index = HEADER_MODEL_LABS.indexOf(labOf(model));
      return index === -1 ? HEADER_MODEL_LABS.length : index;
    };
    const ordered = models
      .map((model, index) => ({ model, index }))
      .sort((a, b) => labRank(a.model) - labRank(b.model) || a.index - b.index)
      .map(entry => entry.model);
    return { ...provider, models: ordered };
  }

  function renderModelOptions(select, providerConfigs, searchOn = false) {
    select.textContent = '';

    for (const provider of providerConfigs) {
      const group = document.createElement('optgroup');
      group.label = provider.label;

      for (const model of provider.models) {
        // With web search on, models that can't search are hidden rather than listed as disabled.
        if (searchOn && !SidekickProviders.modelSupportsWebSearch(provider.providerId, model.value)) continue;
        const option = document.createElement('option');
        option.value = encodeModelSelection(provider.providerId, model.value);
        // The header shows the bare model name ("Gemini 3.8 Flash", not "Google: Gemini 3.8 Flash").
        option.textContent = String(model.label || model.value).replace(/^[^:]{1,40}:\s+/, '');
        group.appendChild(option);
      }

      if (group.children.length) select.appendChild(group);
    }
  }

  function resolveModelSelection(providerConfigs, settings) {
    const provider = providerConfigs.find(cfg => cfg.providerId === settings.provider) || providerConfigs[0];
    const savedModel = settings[provider.modelStorageKey] || provider.defaultModel;
    const modelExists = provider.models.some(model => model.value === savedModel);
    let selection = {
      providerId: provider.providerId,
      model: modelExists ? savedModel : provider.defaultModel
    };

    if (!isWebSearchActive(settings)) return selection;
    if (SidekickProviders.modelSupportsWebSearch(selection.providerId, selection.model)) {
      return selection;
    }

    const fal = providerConfigs.find(cfg => cfg.providerId === 'fal');
    const fallbackModel = SidekickProviders.WEB_SEARCH_DEFAULT_MODEL;
    if (fal?.models.some(model => model.value === fallbackModel)) {
      return { providerId: 'fal', model: fallbackModel };
    }
    const searchable = fal?.models.find(model => SidekickProviders.falModelSupportsWebSearch(model.value));
    if (searchable) return { providerId: 'fal', model: searchable.value };
    return selection;
  }

  function applyChatModelSelection(select, selection) {
    selectedChatProvider = selection.providerId;
    selectedChatModel = selection.model;
    select.value = encodeModelSelection(selection.providerId, selection.model);
  }

  function saveChatModelDefault(providerConfigs, selection) {
    const provider = providerConfigs.find(cfg => cfg.providerId === selection.providerId);
    if (!provider) return;

    chrome.storage.local.set({
      provider: selection.providerId,
      [provider.modelStorageKey]: selection.model
    });
  }

  function getChatModelOverride() {
    if (!selectedChatProvider || !selectedChatModel) return null;
    return {
      providerId: selectedChatProvider,
      model: selectedChatModel
    };
  }

  function encodeModelSelection(providerId, model) {
    return JSON.stringify([providerId, model]);
  }

  function parseModelSelection(value) {
    try {
      const [providerId, model] = JSON.parse(value);
      if (!providerId || !model) return null;
      return { providerId, model };
    } catch {
      return null;
    }
  }

  function isWebSearchActive(settings) {
    return settings.webSearchEnabled !== false && !!String(settings.falApiKey || '').trim();
  }

  function persistWebSearchModelSwitch(settings, selection) {
    if (!isWebSearchActive(settings)) return;
    if (settings.provider === selection.providerId && settings[SidekickProviders.PROVIDERS[selection.providerId]?.modelStorageKey] === selection.model) {
      return;
    }

    const previousKey = SidekickProviders.WEB_SEARCH_PREVIOUS_SELECTION_KEY;
    const currentModelKey = SidekickProviders.PROVIDERS[settings.provider]?.modelStorageKey;
    const alreadySelected = settings.provider === selection.providerId
      && currentModelKey
      && settings[currentModelKey] === selection.model;
    if (alreadySelected) return;

    const updates = {
      provider: selection.providerId,
      [SidekickProviders.PROVIDERS[selection.providerId].modelStorageKey]: selection.model
    };
    if (!settings[previousKey] && settings.provider && currentModelKey) {
      updates[previousKey] = {
        providerId: settings.provider,
        model: settings[currentModelKey] || ''
      };
    }
    chrome.storage.local.set(updates);
  }

  // ─── AUTOCOMPLETE ───────────────────────────────────────────────────
  function showAutocomplete(autocomplete, commands) {
    autocomplete.innerHTML = commands.map((cmd, i) =>
      `<div class="autocomplete-item ${i === 0 ? 'active' : ''}" data-name="${escapeHtml(cmd.name)}">
        <span class="autocomplete-cmd">/${escapeHtml(cmd.name)}</span>
        <span class="autocomplete-desc">${escapeHtml(cmd.prompt.slice(0, 50))}${cmd.prompt.length > 50 ? '...' : ''}</span>
      </div>`
    ).join('');
    autocomplete.style.display = 'block';

    autocomplete.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        const input = autocomplete.parentElement.querySelector('.chat-input');
        input.value = `/${item.dataset.name} `;
        input.focus();
        autocomplete.style.display = 'none';
      });
    });
  }

  function navigateAutocomplete(autocomplete, direction) {
    const items = autocomplete.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    let activeIndex = -1;
    items.forEach((item, i) => {
      if (item.classList.contains('active')) activeIndex = i;
      item.classList.remove('active');
    });
    activeIndex += direction;
    if (activeIndex < 0) activeIndex = items.length - 1;
    if (activeIndex >= items.length) activeIndex = 0;
    items[activeIndex].classList.add('active');
  }

  function selectAutocompleteItem(container, autocomplete) {
    const active = autocomplete.querySelector('.active');
    if (!active) return;
    const input = container.querySelector('.chat-input');
    input.value = `/${active.dataset.name} `;
    input.focus();
    autocomplete.style.display = 'none';
  }

  // ─── SEND MESSAGE ───────────────────────────────────────────────────
  async function handleSend(container) {
    if (!chatEngine) return;
    if (contextSendPending) return;

    // Stop must work with an empty composer, so check streaming before the empty-input guard.
    if (chatEngine.isStreaming) {
      if (activeSend) activeSend.stopped = true;
      chatEngine.stopStreaming();
      updateSendButton(container, false);
      return;
    }

    const input = container.querySelector('.chat-input');
    const text = input.value.trim();
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;

    const messagesArea = container.querySelector('.chat-messages');

    // Remove welcome message
    const welcome = messagesArea.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Display user message
    const files = [...pendingFiles];
    pendingFiles = [];
    const displayParts = [];
    if (text) displayParts.push(text);
    if (files.length) displayParts.push(files.map(file => `Attached: ${file.name}`).join('\n'));
    const displayText = displayParts.join('\n') || '(image)';
    addMessageBubble(messagesArea, 'user', displayText, pendingImages);

    // Clear input and attachments
    input.value = '';
    input.style.height = '';
    input.style.overflowY = 'hidden';
    const images = [...pendingImages];
    pendingImages = [];
    updateImagePreview(container);

    syncContextBanner(container);

    // Hide autocomplete
    container.querySelector('.command-autocomplete').style.display = 'none';

    // Create assistant bubble for streaming
    const assistantBubble = addMessageBubble(messagesArea, 'assistant', '', null, true);
    const contentEl = assistantBubble.querySelector('.message-content');
    assistantBubble.classList.add('is-thinking');
    let fullText = '';

    // The chat UI is available while first-open context extraction runs. Keep
    // the submitted message visible, but do not build the provider request
    // until the page or YouTube transcript has finished loading.
    if (pageContextLoading && pageContextPromise) {
      const loadingLabel = isYouTubeWatchPage()
        ? 'Loading transcript...'
        : 'Loading page...';
      const sendBtn = container.querySelector('.send-btn');
      contextSendPending = true;
      sendBtn.disabled = true;
      contentEl.innerHTML = `<span class="thinking-message"><span class="thinking-dot"></span>${loadingLabel}</span>`;
      try {
        await pageContextPromise;
      } finally {
        contextSendPending = false;
        sendBtn.disabled = false;
      }
    }

    contentEl.innerHTML = '<span class="thinking-message"><span class="thinking-dot"></span>Thinking...<span class="thinking-elapsed"></span></span>';

    // After 10s, count seconds so a slow model is distinguishable from a stuck one.
    const sendState = { stopped: false };
    activeSend = sendState;
    const thinkingStart = Date.now();
    const thinkingTimer = setInterval(() => {
      const elapsedEl = contentEl.querySelector('.thinking-elapsed');
      if (!elapsedEl) {
        clearInterval(thinkingTimer);
        return;
      }
      const seconds = Math.floor((Date.now() - thinkingStart) / 1000);
      if (seconds >= 10) elapsedEl.textContent = ` ${seconds}s`;
    }, 1000);
    const finishSend = () => {
      clearInterval(thinkingTimer);
      if (activeSend === sendState) activeSend = null;
    };

    // Switch send button to stop button
    updateSendButton(container, true);

    chatEngine.sendMessage(
      composeUserText(text, files),
      images.map(img => ({ base64: img.base64, mediaType: img.mediaType })),
      // onToken — no auto-scroll, user scrolls manually
      (token) => {
        fullText += token;
        assistantBubble.classList.remove('is-thinking');
        contentEl.innerHTML = renderMarkdown(fullText);
      },
      // onDone
      (finalText, responseMeta) => {
        finishSend();
        if (finalText) {
          assistantBubble.classList.remove('is-thinking');
          contentEl.innerHTML = renderMarkdown(finalText);
        } else if (fullText) {
          assistantBubble.classList.remove('is-thinking');
          contentEl.innerHTML = renderMarkdown(fullText);
        } else if (sendState.stopped) {
          assistantBubble.classList.remove('is-thinking');
          contentEl.innerHTML = '<div class="stopped-message">Stopped.</div>';
        } else {
          assistantBubble.classList.remove('is-thinking');
          contentEl.innerHTML = '<div class="error-message">The model finished without visible text. Try Gemma 4 12B or Qwen3 Coder 30B.</div>';
        }
        updateResponseProviderBadge(assistantBubble, responseMeta);
        updateSendButton(container, false);
        assistantBubble.querySelector('.streaming-cursor')?.remove();
        // Enable speak button and set estimated listen duration
        const speakBtn = assistantBubble.querySelector('.message-speak-btn');
        if (speakBtn) {
          speakBtn.disabled = false;
          // Calculate duration from raw response text
          const rawText = finalText || fullText || '';
          const duration = estimateAudioDuration(rawText);
          if (duration) {
            // Store as data attribute — CSS ::after displays it automatically
            speakBtn.dataset.duration = duration;
          }
        }
        // Sync conversation to storage for auto-save on tab close
        syncConversation();
      },
      // onError
      (error) => {
        finishSend();
        assistantBubble.classList.remove('is-thinking');
        contentEl.innerHTML = `<div class="error-message">${escapeHtml(error)}</div>`;
        updateSendButton(container, false);
        assistantBubble.querySelector('.streaming-cursor')?.remove();
      },
      getChatModelOverride()
    );
  }

  function addMessageBubble(messagesArea, role, text, images, streaming = false) {
    const bubble = document.createElement('div');
    bubble.className = `message message-${role}`;

    // Assign unique bubble ID for TTS caching
    const bubbleId = `bubble-${++bubbleCounter}`;
    bubble.dataset.bubbleId = bubbleId;

    let imagesHTML = '';
    if (images && images.length > 0) {
      imagesHTML = `<div class="message-images">${images.map(img =>
        `<img src="data:${img.mediaType};base64,${img.base64}" alt="${escapeHtml(img.name)}" class="message-image-thumb">`
      ).join('')}</div>`;
    }

    // Action buttons for assistant messages: copy + speak
    const actionsHTML = role === 'assistant'
      ? `<div class="message-actions">
          <button class="message-copy-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
          <button class="message-speak-btn" data-state="idle" ${streaming ? 'disabled' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> Speak</button>
        </div>
        <div class="message-speak-error-text" hidden role="status" aria-live="polite"></div>`
      : '';

    bubble.innerHTML = `
      ${imagesHTML}
      ${role === 'assistant' ? '<div class="message-meta"><span class="message-provider-badge" hidden></span></div>' : ''}
      <div class="message-content">${text ? renderMarkdown(text, { normalizeAssistantProse: role === 'assistant' }) : ''}</div>
      ${streaming ? '<span class="streaming-cursor"></span>' : ''}
      ${actionsHTML}
    `;

    // Wire up copy button
    const copyBtn = bubble.querySelector('.message-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const content = bubble.querySelector('.message-content');
        navigator.clipboard.writeText(content.innerText).then(() => {
          copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
            copyBtn.classList.remove('copied');
          }, 1500);
        });
      });
    }

    // Wire up speak button
    const speakBtn = bubble.querySelector('.message-speak-btn');
    if (speakBtn) {
      speakBtn.addEventListener('click', () => handleSpeakClick(bubble, speakBtn));
    }

    messagesArea.appendChild(bubble);
    messagesArea.scrollTop = messagesArea.scrollHeight;
    return bubble;
  }

  function updateResponseProviderBadge(bubble, responseMeta) {
    const badge = bubble?.querySelector('.message-provider-badge');
    if (!badge || !responseMeta?.label) return;
    badge.textContent = responseMeta.label;
    badge.hidden = false;
  }

  // ─── TTS SPEAK BUTTON ──────────────────────────────────────────────
  // SVG icons for speak button states
  const SPEAK_ICONS = {
    idle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    loading: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    playing: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    paused: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
  };
  const HEADER_LISTEN_ICONS = {
    idle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    loading: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cancel: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    playing: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    paused: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
  };
  // Estimate audio duration from word count
  // Average human reading-aloud rate: ~150 words per minute
  function estimateAudioDuration(text) {
    if (!text) return '';
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    const minutes = words.length / 150;
    if (minutes < 1) return '<1 min';
    return `~${Math.round(minutes)} min`;
  }

  function handleSpeakClick(bubble, btn) {
    if (!ttsEngine) return;
    const state = btn.dataset.state;

    if (state === 'idle') {
      // Check if user wants to auto-play with their default voice
      chrome.storage.local.get(
        ['useDefaultVoice', 'ttsEngine', 'localTtsVoice', 'kokoroEndpoint', 'kokoroVoice', 'indexTtsEndpoint', 'chatterboxVoice', 'allowExperimentalIndexTtsArticleVoice', 'autoDownloadGeneratedAudio', 'generatedAudioFolder', 'elevenLabsApiKey', 'elevenLabsVoice', 'elevenLabsModel'],
        (settings) => {
          if (settings.useDefaultVoice) {
            // Auto-play with saved default voice
            resetAllSpeakButtons();
            resetListenPageButton();
            const playSettings = {
              ttsEngine: settings.ttsEngine || DEFAULT_TTS_ENGINE,
              localTtsVoice: settings.localTtsVoice || '',
              kokoroEndpoint: settings.kokoroEndpoint || '',
              kokoroVoice: settings.kokoroVoice || '',
              indexTtsEndpoint: settings.indexTtsEndpoint || '',
              chatterboxVoice: settings.chatterboxVoice || DEFAULT_CHATTERBOX_VOICE,
              allowExperimentalIndexTtsArticleVoice: settings.allowExperimentalIndexTtsArticleVoice === true,
              autoDownloadGeneratedAudio: settings.autoDownloadGeneratedAudio !== false,
              generatedAudioFolder: settings.generatedAudioFolder || '',
              generatedAudioFilename: `${buildSourceFilename('audio')}.mp3`,
              elevenLabsApiKey: settings.elevenLabsApiKey || '',
              elevenLabsVoice: settings.elevenLabsVoice || '',
              elevenLabsModel: settings.elevenLabsModel || ''
            };
            const text = bubble.querySelector('.message-content').innerText;
            const bubbleId = bubble.dataset.bubbleId;
            ttsEngine.play(text, bubbleId, playSettings, (newState, errorMessage) => {
              updateSpeakButton(btn, newState, errorMessage);
              if (newState === 'ended') syncConversation();
            });
          } else {
            // Show voice picker so the user can choose
            showVoicePicker(bubble, btn);
          }
        }
      );
    } else if (state === 'playing') {
      ttsEngine.pause();
    } else if (state === 'paused') {
      ttsEngine.resume();
    }
  }

  function isFastListenButton() {
    return false;
  }

  function listenIdleIcon() {
    return HEADER_LISTEN_ICONS.idle;
  }

  function listenIdleTitle() {
    return 'Listen to page';
  }

  function listenIdleAriaLabel() {
    return 'Listen to page';
  }

  function listenStatusPrefix() {
    return '';
  }

  function getListenPageButtons() {
    return Array.from(shadowRoot?.querySelectorAll('[data-action="listen-page"]') || []);
  }

  function getActiveListenPageButton() {
    return getListenPageButtons().find(btn => {
      const state = btn.dataset.state;
      return state === 'loading' || state === 'playing' || state === 'paused' || !!btn.dataset.listenId;
    }) || null;
  }

  async function handleListenPageClick(container, btn, options = {}) {
    if (!ttsEngine) return;
    const fastMode = options.fast === true || isFastListenButton(btn);
    const state = btn.dataset.state;

    if (state === 'playing') {
      ttsEngine.pause();
      return;
    }
    if (state === 'paused') {
      ttsEngine.resume();
      return;
    }
    if (state === 'loading') {
      cancelPageAudio(btn);
      return;
    }

    const activeListenBtn = getActiveListenPageButton();
    if (activeListenBtn && activeListenBtn !== btn) {
      if (ttsEngine) ttsEngine.stop();
      updateListenPageButton(activeListenBtn, 'idle');
    }

    btn.disabled = true;
    btn.classList.add('listening');
    btn.title = fastMode ? 'Preparing fast page audio...' : 'Preparing page audio...';
    updateListenBar(btn, fastMode ? 'Preparing fast read...' : 'Preparing...', false, false);

    try {
      const context = await extractSpeechContext({ maxContextOverride: LISTEN_CONTEXT_CHAR_LIMIT });
      if (!context?.content || context.error) {
        throw new Error(context?.error || 'Could not extract readable page text.');
      }

      const duration = estimateAudioDuration(context.content);
      btn.dataset.duration = duration;
      const settings = await new Promise(resolve => {
        chrome.storage.local.get([
          'ttsEngine',
          'localTtsVoice',
          'kokoroEndpoint',
          'kokoroVoice',
          'indexTtsEndpoint',
          'chatterboxVoice',
          'allowExperimentalIndexTtsArticleVoice',
          'autoDownloadGeneratedAudio',
          'generatedAudioFolder',
          'elevenLabsApiKey',
          'elevenLabsVoice',
          'elevenLabsModel'
        ], resolve);
      });
      const playSettings = {
        ttsEngine: settings.ttsEngine || DEFAULT_TTS_ENGINE,
        localTtsVoice: settings.localTtsVoice || '',
        kokoroEndpoint: settings.kokoroEndpoint || '',
        kokoroVoice: settings.kokoroVoice || '',
        indexTtsEndpoint: settings.indexTtsEndpoint || '',
        chatterboxVoice: settings.chatterboxVoice || DEFAULT_CHATTERBOX_VOICE,
        allowExperimentalIndexTtsArticleVoice: settings.allowExperimentalIndexTtsArticleVoice === true,
        fastLocalTts: fastMode,
        autoDownloadGeneratedAudio: settings.autoDownloadGeneratedAudio !== false,
        generatedAudioFolder: settings.generatedAudioFolder || '',
        generatedAudioFilename: `${buildSourceFilename(fastMode ? 'page-audio-fast' : 'page-audio')}.mp3`,
        elevenLabsApiKey: settings.elevenLabsApiKey || '',
        elevenLabsVoice: settings.elevenLabsVoice || '',
        elevenLabsModel: settings.elevenLabsModel || ''
      };
      const listenId = `page-listen:${fastMode ? 'fast' : 'quality'}:${context.url}:${context.title}`;
      btn.dataset.listenId = listenId;
      btn.dataset.fastMode = fastMode ? '1' : '0';

      resetAllSpeakButtons();
      resetListenPageButton(btn);
      const playPageAudio = ttsEngine.playArticle || ((article, id, settings, callback) => {
        return ttsEngine.play(article.content, id, settings, callback);
      });
      playPageAudio(context, listenId, playSettings, (newState, errorMessage) => {
        updateListenPageButton(btn, newState, errorMessage);
      });
    } catch (error) {
      console.error('Sidekick: Listen page failed', error);
      btn.title = error.message || 'Listen failed';
      updateListenPageButton(btn, 'error');
    }
  }

  function updateListenPageButton(btn, state, errorMessage) {
    const duration = btn.dataset.duration || '';
    if (state === 'loading') {
      const loadingLabel = errorMessage || (duration ? `${listenStatusPrefix(btn)}Generating ${duration}` : `${listenStatusPrefix(btn)}Generating...`);
      btn.dataset.state = 'loading';
      btn.innerHTML = HEADER_LISTEN_ICONS.cancel;
      btn.title = duration ? `Cancel ${listenStatusPrefix(btn).toLowerCase()}page audio generation (${duration})` : `Cancel ${listenStatusPrefix(btn).toLowerCase()}page audio generation`;
      btn.setAttribute('aria-label', `Cancel ${listenStatusPrefix(btn).toLowerCase()}page audio generation`);
      btn.disabled = false;
      btn.classList.add('listening');
      btn.classList.remove('generating');
      updateListenBar(btn, loadingLabel, false, false, true);
    } else if (state === 'playing') {
      btn.dataset.state = 'playing';
      btn.innerHTML = HEADER_LISTEN_ICONS.playing;
      btn.title = duration ? `Pause ${listenStatusPrefix(btn).toLowerCase()}page audio (${duration})` : `Pause ${listenStatusPrefix(btn).toLowerCase()}page audio`;
      btn.setAttribute('aria-label', `Pause ${listenStatusPrefix(btn).toLowerCase()}page audio`);
      btn.disabled = false;
      btn.classList.add('listening');
      btn.classList.remove('generating');
      updateListenBar(btn, duration ? `${listenStatusPrefix(btn)}Playing ${duration}` : `${listenStatusPrefix(btn)}Playing`, false, true);
    } else if (state === 'paused') {
      btn.dataset.state = 'paused';
      btn.innerHTML = HEADER_LISTEN_ICONS.paused;
      btn.title = duration ? `Resume ${listenStatusPrefix(btn).toLowerCase()}page audio (${duration})` : `Resume ${listenStatusPrefix(btn).toLowerCase()}page audio`;
      btn.setAttribute('aria-label', `Resume ${listenStatusPrefix(btn).toLowerCase()}page audio`);
      btn.disabled = false;
      btn.classList.add('listening');
      btn.classList.remove('generating');
      updateListenBar(btn, duration ? `${listenStatusPrefix(btn)}Paused ${duration}` : `${listenStatusPrefix(btn)}Paused`, false, true);
    } else if (state === 'error') {
      btn.dataset.state = 'idle';
      btn.innerHTML = listenIdleIcon(btn);
      btn.disabled = false;
      btn.classList.remove('listening', 'generating');
      const message = errorMessage || 'Listen failed';
      btn.title = message;
      btn.setAttribute('aria-label', listenIdleAriaLabel(btn));
      updateListenBar(btn, message, true, false);
      // Specific messages stay up longer so there's time to read them
      setTimeout(() => {
        btn.title = listenIdleTitle(btn);
        btn.setAttribute('aria-label', listenIdleAriaLabel(btn));
        updateListenBar(btn, '', false, false);
      }, errorMessage ? 8000 : 2500);
    } else if (state === 'canceled') {
      btn.dataset.state = 'idle';
      btn.innerHTML = listenIdleIcon(btn);
      btn.title = listenIdleTitle(btn);
      btn.setAttribute('aria-label', listenIdleAriaLabel(btn));
      btn.disabled = false;
      btn.classList.remove('listening', 'generating');
      delete btn.dataset.duration;
      delete btn.dataset.listenId;
      delete btn.dataset.fastMode;
      updateListenBar(btn, 'Canceled', false, false);
      setTimeout(() => updateListenBar(btn, '', false, false), 1800);
    } else if (state === 'ended') {
      btn.dataset.state = 'idle';
      btn.innerHTML = listenIdleIcon(btn);
      btn.title = listenIdleTitle(btn);
      btn.setAttribute('aria-label', listenIdleAriaLabel(btn));
      btn.disabled = false;
      btn.classList.remove('listening', 'generating');
      if (btn.dataset.listenId && ttsEngine?.hasCachedAudio?.(btn.dataset.listenId)) {
        updateListenBar(btn, duration ? `${listenStatusPrefix(btn)}Ready ${duration}` : `${listenStatusPrefix(btn)}Ready`, false, true);
      } else {
        delete btn.dataset.duration;
        delete btn.dataset.listenId;
        delete btn.dataset.fastMode;
        updateListenBar(btn, '', false, false);
      }
    } else {
      btn.dataset.state = 'idle';
      btn.innerHTML = listenIdleIcon(btn);
      btn.title = listenIdleTitle(btn);
      btn.setAttribute('aria-label', listenIdleAriaLabel(btn));
      btn.disabled = false;
      btn.classList.remove('listening', 'generating');
      delete btn.dataset.duration;
      delete btn.dataset.listenId;
      delete btn.dataset.fastMode;
      updateListenBar(btn, '', false, false);
    }
  }

  function updateListenBar(btn, text, isError, canDownload, canCancel = false) {
    const container = btn.closest('.sidekick-container');
    const bar = container?.querySelector('.listen-bar');
    const status = bar?.querySelector('.listen-status');
    const downloadBtn = bar?.querySelector('.listen-download-btn');
    if (!bar || !status || !downloadBtn) return;
    // A spoken reply owns the strip; only an active page listen may take it back.
    const pageActive = ['loading', 'playing', 'paused'].includes(btn.dataset.state);
    if (bar.dataset.source === 'message' && !pageActive) return;
    const hasDownload = canDownload && !!btn.dataset.listenId && !!ttsEngine?.hasCachedAudio?.(btn.dataset.listenId);

    status.textContent = text;
    status.classList.toggle('error', !!isError);
    downloadBtn.hidden = !hasDownload;
    bar.hidden = !text && !hasDownload && !canCancel;
    bar.classList.toggle('error', !!isError);
    bar.dataset.state = isError ? 'error' : (btn.dataset.state || 'idle');
    bar.dataset.source = 'page';
    bar.dataset.audioId = btn.dataset.listenId || '';
    markPlayerBubble(null);

    if (bar.dataset.state === 'playing' || bar.dataset.state === 'paused') {
      startListenProgress(bar);
    } else {
      stopListenProgress(bar);
    }
  }

  // ─── Listen progress bar ───────────────────────────────────
  let listenProgressTimer = null;
  let listenSeekDragging = false;

  function formatAudioClock(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  }

  function renderListenProgress(bar) {
    const wrap = bar.querySelector('.listen-progress');
    const status = bar.querySelector('.listen-status');
    const seekInput = bar.querySelector('.listen-seek');
    const progress = ttsEngine?.getPlaybackProgress?.();
    if (!progress) {
      wrap.hidden = true;
      status.hidden = false;
      return;
    }
    wrap.hidden = false;
    status.hidden = true;
    bar.querySelector('.listen-indicator').hidden = true;
    const toggleBtn = bar.querySelector('.listen-toggle-btn');
    toggleBtn.hidden = false;
    const isPlaying = bar.dataset.state === 'playing';
    if (toggleBtn.dataset.icon !== String(isPlaying)) {
      toggleBtn.dataset.icon = String(isPlaying);
      toggleBtn.innerHTML = isPlaying ? SPEAK_ICONS.playing : SPEAK_ICONS.paused;
      toggleBtn.setAttribute('aria-label', isPlaying ? 'Pause audio' : 'Play audio');
      toggleBtn.title = isPlaying ? 'Pause' : 'Play';
    }
    // The MP3 appears as soon as generation finishes, not only on the next state change.
    const audioId = bar.dataset.audioId;
    bar.querySelector('.listen-download-btn').hidden = !(audioId && ttsEngine.hasCachedAudio?.(audioId));

    const fraction = value => Math.min(1, Math.max(0, value / progress.duration));
    if (!listenSeekDragging) seekInput.value = String(Math.round(fraction(progress.currentTime) * 1000));
    const shownTime = Number(seekInput.value) / 1000 * progress.duration;
    const totalLabel = `${progress.generating ? '~' : ''}${formatAudioClock(progress.duration)}`;
    seekInput.style.setProperty('--played', `${(Number(seekInput.value) / 10).toFixed(2)}%`);
    seekInput.style.setProperty('--available', `${(fraction(progress.generatedEnd) * 100).toFixed(2)}%`);
    bar.querySelector('.listen-elapsed').textContent = formatAudioClock(shownTime);
    bar.querySelector('.listen-total').textContent = totalLabel;
    seekInput.setAttribute('aria-valuetext', `${formatAudioClock(shownTime)} of ${totalLabel}`);
    seekInput.title = progress.generating ? 'Still generating. You can jump within the audio made so far.' : '';
  }

  function startListenProgress(bar) {
    renderListenProgress(bar);
    if (listenProgressTimer) return;
    listenProgressTimer = setInterval(() => {
      if (bar.hidden || !bar.isConnected) {
        stopListenProgress(bar);
        return;
      }
      renderListenProgress(bar);
    }, 250);
  }

  function stopListenProgress(bar) {
    clearInterval(listenProgressTimer);
    listenProgressTimer = null;
    listenSeekDragging = false;
    const wrap = bar?.querySelector('.listen-progress');
    const status = bar?.querySelector('.listen-status');
    if (wrap) wrap.hidden = true;
    if (status) status.hidden = false;
    const toggleBtn = bar?.querySelector('.listen-toggle-btn');
    const indicator = bar?.querySelector('.listen-indicator');
    if (toggleBtn) toggleBtn.hidden = true;
    if (indicator) indicator.hidden = false;
  }

  // Speaking a reply reuses the page player strip for seek, speed and MP3.
  function syncMessagePlayer(speakBtn, state) {
    const bar = speakBtn.closest('.sidekick-container')?.querySelector('.listen-bar');
    const bubble = speakBtn.closest('.message-assistant');
    if (!bar || !bubble) return;
    if (state === 'playing' || state === 'paused') {
      bar.dataset.source = 'message';
      bar.dataset.audioId = bubble.dataset.bubbleId || '';
      bar.dataset.state = state;
      bar.classList.remove('error');
      bar.querySelector('.listen-status').textContent = state === 'playing' ? 'Playing reply' : 'Paused reply';
      bar.querySelector('.listen-status').classList.remove('error');
      bar.hidden = false;
      markPlayerBubble(bubble);
      startListenProgress(bar);
    } else if (state !== 'loading' && bar.dataset.source === 'message' && bar.dataset.audioId === (bubble.dataset.bubbleId || '')) {
      stopListenProgress(bar);
      // A finished reply stays as "ready" so its MP3 can still be saved; X closes it.
      if (state === 'ended' && ttsEngine?.hasCachedAudio?.(bar.dataset.audioId)) {
        bar.dataset.state = 'idle';
        bar.querySelector('.listen-status').textContent = 'Reply ready';
        bar.querySelector('.listen-download-btn').hidden = false;
        return;
      }
      hideListenBar(bar);
    }
  }

  // Outlines the reply the player strip belongs to; null clears it.
  function markPlayerBubble(bubble) {
    shadowRoot?.querySelectorAll('.message-assistant.in-player').forEach(el => {
      if (el !== bubble) el.classList.remove('in-player');
    });
    bubble?.classList.add('in-player');
  }

  function hideListenBar(bar) {
    markPlayerBubble(null);
    stopListenProgress(bar);
    bar.hidden = true;
    delete bar.dataset.source;
    delete bar.dataset.audioId;
    bar.dataset.state = 'idle';
  }

  // X on the strip: stop whatever it is playing and close it (the chat stays open).
  function closeListenPlayer() {
    const bar = shadowRoot?.querySelector('.listen-bar');
    if (!bar) return;
    if (bar.dataset.source === 'message') {
      if (ttsEngine?.getPlayingBubbleId?.() === bar.dataset.audioId) ttsEngine.stop();
      hideListenBar(bar);
      return;
    }
    const listenBtn = getActiveListenPageButton();
    if (listenBtn && ttsEngine) ttsEngine.stop();
    resetListenPageButton();
    hideListenBar(bar);
  }

  const LISTEN_SPEEDS = [1, 1.1, 1.25, 1.5, 2.5];
  let listenSpeed = 1;

  function renderListenSpeed(bar) {
    const speedBtn = bar?.querySelector('.listen-speed-btn');
    if (!speedBtn) return;
    speedBtn.textContent = `${listenSpeed}x`;
    speedBtn.setAttribute('aria-label', `Playback speed ${listenSpeed}x. Press to change.`);
    speedBtn.classList.toggle('is-changed', listenSpeed !== 1);
  }

  function applySavedListenSpeed() {
    chrome.storage.local.get(['listenPlaybackRate'], ({ listenPlaybackRate }) => {
      if (LISTEN_SPEEDS.includes(listenPlaybackRate)) listenSpeed = listenPlaybackRate;
      ttsEngine?.setPlaybackRate?.(listenSpeed);
      renderListenSpeed(chatContainer?.querySelector('.listen-bar'));
    });
  }

  function setupListenSeek(container) {
    const bar = container.querySelector('.listen-bar');
    const seekInput = bar.querySelector('.listen-seek');
    bar.querySelector('.listen-toggle-btn').addEventListener('click', () => {
      if (bar.dataset.state === 'playing') ttsEngine?.pause();
      else ttsEngine?.resume();
    });
    bar.querySelector('.listen-speed-btn').addEventListener('click', () => {
      const index = LISTEN_SPEEDS.indexOf(listenSpeed);
      listenSpeed = LISTEN_SPEEDS[(index + 1) % LISTEN_SPEEDS.length];
      ttsEngine?.setPlaybackRate?.(listenSpeed);
      chrome.storage.local.set({ listenPlaybackRate: listenSpeed });
      renderListenSpeed(bar);
    });
    seekInput.addEventListener('input', () => {
      listenSeekDragging = true;
      renderListenProgress(bar);
    });
    seekInput.addEventListener('change', () => {
      const progress = ttsEngine?.getPlaybackProgress?.();
      if (progress) ttsEngine.seek(Number(seekInput.value) / 1000 * progress.duration);
      listenSeekDragging = false;
      renderListenProgress(bar);
    });
  }

  function cancelPageAudio(btn = null) {
    const listenBtn = btn || getActiveListenPageButton() || shadowRoot?.querySelector('[data-action="listen-page"]');
    if (!listenBtn) return;
    if (ttsEngine) ttsEngine.stop();
    updateListenPageButton(listenBtn, 'canceled');
  }

  async function downloadPageAudio() {
    const bar = shadowRoot?.querySelector('.listen-bar');
    if (bar?.dataset.source === 'message') {
      const bubble = Array.from(shadowRoot.querySelectorAll('.message-assistant'))
        .find(el => el.dataset.bubbleId === bar.dataset.audioId);
      if (bubble) downloadMessageAudio(bubble);
      return;
    }
    const listenBtn = getActiveListenPageButton() || shadowRoot?.querySelector('[data-action="listen-page"]');
    const listenId = listenBtn?.dataset.listenId;
    if (!listenId || !ttsEngine?.getCachedAudioDataUrl) return;
    const dataUrl = await ttsEngine.getCachedAudioDataUrl(listenId);
    if (!dataUrl) {
      updateListenBar(listenBtn, 'Audio file not ready yet', true, false);
      return;
    }
    const { generatedAudioFolder } = await chrome.storage.local.get(['generatedAudioFolder']);
    const filename = `${buildSourceFilename('page-audio')}.mp3`;
    safeSendMessage({
      action: 'downloadFile',
      url: dataUrl,
      filename: ttsEngine.buildGeneratedAudioPath ? ttsEngine.buildGeneratedAudioPath(filename, generatedAudioFolder) : filename
    });
  }

  function resetListenPageButton(exceptBtn = null) {
    getListenPageButtons().forEach(listenBtn => {
      if (listenBtn === exceptBtn) return;
      delete listenBtn.dataset.duration;
      delete listenBtn.dataset.listenId;
      delete listenBtn.dataset.fastMode;
      updateListenPageButton(listenBtn, 'idle');
    });
  }

  function updateSpeakButton(btn, state, errorMessage) {
    const bubble = btn.closest('.message-assistant');
    syncMessagePlayer(btn, state);
    if (state === 'loading') {
      clearSpeakErrorMessage(bubble);
      btn.dataset.state = 'loading';
      btn.innerHTML = `${SPEAK_ICONS.loading} Generating...`;
      btn.disabled = true;
      btn.classList.add('speaking', 'generating');
    } else if (state === 'playing') {
      clearSpeakErrorMessage(bubble);
      btn.dataset.state = 'playing';
      // The player strip shows pause and time; the button just stays lit.
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.title = 'Playing in the player above. Click to pause.';
      btn.disabled = false;
      btn.classList.add('speaking');
      btn.classList.remove('generating');
    } else if (state === 'paused') {
      btn.dataset.state = 'paused';
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.title = errorMessage || 'Paused. Click to resume.';
      btn.disabled = false;
      btn.classList.add('speaking');
      btn.classList.remove('generating');
    } else if (state === 'error') {
      showSpeakErrorMessage(bubble, errorMessage);
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Failed`;
      btn.disabled = false;
      btn.classList.remove('speaking', 'generating');
      btn.classList.add('speak-error');
      if (errorMessage) btn.title = errorMessage;
      setTimeout(() => {
        btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
        btn.title = '';
        btn.classList.remove('speak-error');
      }, errorMessage ? 8000 : 2500);
    } else {
      clearSpeakErrorMessage(bubble);
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.title = '';
      btn.disabled = false;
      btn.classList.remove('speaking', 'generating');
    }
  }

  function showSpeakErrorMessage(bubble, errorMessage) {
    const errorEl = bubble?.querySelector('.message-speak-error-text');
    if (!errorEl) return;
    const message = String(errorMessage || 'Speech generation failed. Try again.').trim();
    const errorId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorEl.dataset.errorId = errorId;
    setTimeout(() => {
      if (errorEl.dataset.errorId !== errorId) return;
      clearSpeakErrorMessage(bubble);
    }, 15000);
  }

  function clearSpeakErrorMessage(bubble) {
    const errorEl = bubble?.querySelector('.message-speak-error-text');
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
    delete errorEl.dataset.errorId;
  }

  async function downloadMessageAudio(bubble) {
    if (!ttsEngine?.getCachedAudioDataUrl) return;
    const dataUrl = await ttsEngine.getCachedAudioDataUrl(bubble.dataset.bubbleId);
    if (!dataUrl) return;
    const { generatedAudioFolder } = await chrome.storage.local.get(['generatedAudioFolder']);
    const filename = `${buildSourceFilename('audio')}.mp3`;
    safeSendMessage({
      action: 'downloadFile',
      url: dataUrl,
      filename: ttsEngine.buildGeneratedAudioPath ? ttsEngine.buildGeneratedAudioPath(filename, generatedAudioFolder) : filename
    });
  }

  function buildSourceFilename(kind) {
    const source = chatEngine?.pageContext || {};
    const sourceUrl = source.url || window.location.href;
    const sourceTitle = source.title || document.title || 'Untitled';
    const domain = getFilenameDomain(sourceUrl);
    const title = sanitizeFilenamePart(sourceTitle).slice(0, 72) || 'untitled';
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `sidekick-${kind}-${domain}-${title}-${timestamp}`;
  }

  function getFilenameDomain(url) {
    try {
      const parsed = new URL(url);
      return sanitizeFilenamePart(parsed.hostname.replace(/^www\./, '')) || 'page';
    } catch {
      return 'page';
    }
  }

  function sanitizeFilenamePart(value) {
    return String(value || '')
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resetAllSpeakButtons() {
    if (!shadowRoot) return;
    hideVoicePicker();
    shadowRoot.querySelectorAll('.message-speak-btn').forEach(btn => {
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.disabled = false;
      btn.classList.remove('speaking', 'generating');
    });
  }

  // ─── VOICE PICKER ──────────────────────────────────────────────
  function showVoicePicker(bubble, btn) {
    hideVoicePicker();

    const container = shadowRoot.querySelector('.sidekick-container');

    // Transparent backdrop to catch outside clicks and close the picker
    const backdrop = document.createElement('div');
    backdrop.className = 'voice-picker-backdrop';
    backdrop.addEventListener('click', hideVoicePicker);
    container.appendChild(backdrop);

    // Picker element — positioned above the speak button, full panel width
    const picker = document.createElement('div');
    picker.className = 'voice-picker';
    const btnRect = btn.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    picker.style.bottom = (containerRect.bottom - btnRect.top + 4) + 'px';
    picker.style.left = '8px';
    picker.style.right = '8px';

    // Load settings to build the picker UI
    chrome.storage.local.get(['ttsEngine', 'localTtsVoice', 'kokoroEndpoint', 'kokoroVoice', 'indexTtsEndpoint', 'chatterboxVoice', 'allowExperimentalIndexTtsArticleVoice', 'autoDownloadGeneratedAudio', 'generatedAudioFolder', 'elevenLabsApiKey', 'elevenLabsVoice', 'elevenLabsModel'], (settings) => {
      const isHidden = engine => !!SidekickProviders.isTtsEngineHidden?.(engine);
      const savedEngine = settings.ttsEngine || DEFAULT_TTS_ENGINE;
      const currentEngine = isHidden(savedEngine) ? DEFAULT_TTS_ENGINE : savedEngine;
      const engineTabs = [
        ['local', 'Browser'],
        ['kokoro', 'Kokoro'],
        ['chatterbox', 'Chatterbox'],
        ['voicebox-lab', 'Voicebox'],
        ['elevenlabs', 'ElevenLabs']
      ].filter(([engine]) => !isHidden(engine));
      const tabsHTML = `<div class="voice-picker-tabs">
          ${engineTabs.map(([engine, label]) => `<button class="voice-picker-tab ${currentEngine === engine ? 'active' : ''}" data-engine="${engine}">${label}</button>`).join('')}
        </div>`;

      picker.innerHTML = `${tabsHTML}<div class="voice-picker-list"><div class="voice-picker-loading">Loading voices...</div></div>`;
      container.appendChild(picker);

      // Load voices for the active engine
      populateVoiceList(picker, currentEngine, settings, bubble, btn);

      // Tab switching
      picker.querySelectorAll('.voice-picker-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          picker.querySelectorAll('.voice-picker-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          picker.querySelector('.voice-picker-list').innerHTML = '<div class="voice-picker-loading">Loading voices...</div>';
          populateVoiceList(picker, tab.dataset.engine, settings, bubble, btn);
        });
      });
    });
  }

  function hideVoicePicker() {
    if (!shadowRoot) return;
    const container = shadowRoot.querySelector('.sidekick-container');
    if (!container) return;
    const backdrop = container.querySelector('.voice-picker-backdrop');
    const picker = container.querySelector('.voice-picker');
    if (backdrop) backdrop.remove();
    if (picker) picker.remove();
  }

  async function populateVoiceList(picker, engine, settings, bubble, btn) {
    const list = picker.querySelector('.voice-picker-list');

    try {
      if (engine === 'local') {
        const voices = await ttsEngine.getLocalVoices();
        const english = voices.filter(v => v.lang.startsWith('en'));
        const other = voices.filter(v => !v.lang.startsWith('en'));
        const savedVoice = settings.localTtsVoice || '';

        let html = '';
        if (english.length > 0) {
          html += '<div class="voice-picker-group">English</div>';
          english.forEach(v => {
            const isSaved = v.name === savedVoice;
            html += `<button class="voice-picker-item ${isSaved ? 'saved' : ''}" data-engine="local" data-voice-id="${escapeHtml(v.name)}">
              <span class="voice-item-name">${escapeHtml(v.name)}</span>
              <span class="voice-item-lang">${escapeHtml(v.lang)}</span>
              ${isSaved ? '<span class="voice-item-badge">default</span>' : ''}
            </button>`;
          });
        }
        if (other.length > 0) {
          html += '<div class="voice-picker-group">Other Languages</div>';
          other.forEach(v => {
            const isSaved = v.name === savedVoice;
            html += `<button class="voice-picker-item ${isSaved ? 'saved' : ''}" data-engine="local" data-voice-id="${escapeHtml(v.name)}">
              <span class="voice-item-name">${escapeHtml(v.name)}</span>
              <span class="voice-item-lang">${escapeHtml(v.lang)}</span>
              ${isSaved ? '<span class="voice-item-badge">default</span>' : ''}
            </button>`;
          });
        }
        list.innerHTML = html || '<div class="voice-picker-empty">No voices available</div>';

      } else if (engine === 'kokoro') {
        const voices = await ttsEngine.getKokoroVoices(settings.kokoroEndpoint);
        const savedVoice = settings.kokoroVoice || 'af_heart';
        const groups = new Map();
        voices.forEach(v => {
          const label = v.language || 'Other';
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push(v);
        });

        let html = '';
        for (const [label, list] of groups) {
          html += `<div class="voice-picker-group">${escapeHtml(label)}</div>`;
          list.forEach(v => {
            const isSaved = v.id === savedVoice;
            html += `<button class="voice-picker-item ${isSaved ? 'saved' : ''}" data-engine="kokoro" data-voice-id="${escapeHtml(v.id)}">
              <span class="voice-item-name">${escapeHtml(v.name)}</span>
              <span class="voice-item-lang">${escapeHtml(v.id)}</span>
              ${isSaved ? '<span class="voice-item-badge">default</span>' : ''}
            </button>`;
          });
        }
        list.innerHTML = html;

      } else if (engine === 'chatterbox' || engine === 'voicebox-lab') {
        // Built-in voice plus reference-clip clones from the local bridge.
        const voices = engine === 'voicebox-lab'
          ? await ttsEngine.getVoiceboxLabVoices(settings.indexTtsEndpoint)
          : await ttsEngine.getChatterboxVoices(settings.indexTtsEndpoint);
        const savedVoice = settings.chatterboxVoice || 'default';
        const engineLabel = engine === 'voicebox-lab' ? 'Voicebox' : 'Chatterbox';
        const groups = new Map();
        voices.forEach(v => {
          const label = v.group || 'Cloned voices';
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push(v);
        });

        let html = '';
        for (const [label, groupVoices] of groups) {
          html += `<div class="voice-picker-group">${escapeHtml(label)}</div>`;
          groupVoices.forEach(v => {
            const isSaved = v.id === savedVoice;
            const badge = isSaved ? 'default' : (!v.articleSafe ? 'experimental' : '');
            html += `<button class="voice-picker-item ${isSaved ? 'saved' : ''}" data-engine="${escapeHtml(engine)}" data-voice-id="${escapeHtml(v.id)}">
              <span class="voice-item-name">${escapeHtml(v.name)}</span>
              <span class="voice-item-lang">${escapeHtml(v.articleSafe ? `${engineLabel} · ${v.id}` : `${engineLabel} · ${v.id} · experimental`)}</span>
              ${badge ? `<span class="voice-item-badge">${escapeHtml(badge)}</span>` : ''}
            </button>`;
          });
        }
        list.innerHTML = html || '<div class="voice-picker-empty">No voices found</div>';

      } else if (engine === 'elevenlabs') {
        if (!settings.elevenLabsApiKey) {
          list.innerHTML = '<div class="voice-picker-empty">No API key configured.<br>Set it in Settings.</div>';
          return;
        }
        const voices = await ttsEngine.getElevenLabsVoices(settings.elevenLabsApiKey);
        const savedVoice = settings.elevenLabsVoice || '';

        let html = '';
        voices.forEach(v => {
          const isSaved = v.voice_id === savedVoice;
          const labels = v.labels ? Object.values(v.labels).join(', ') : '';
          html += `<button class="voice-picker-item ${isSaved ? 'saved' : ''}" data-engine="elevenlabs" data-voice-id="${escapeHtml(v.voice_id)}">
            <span class="voice-item-name">${escapeHtml(v.name)}</span>
            ${labels ? `<span class="voice-item-lang">${escapeHtml(labels)}</span>` : ''}
            ${isSaved ? '<span class="voice-item-badge">default</span>' : ''}
          </button>`;
        });
        list.innerHTML = html || '<div class="voice-picker-empty">No voices found</div>';
      }

      // Wire up voice item clicks — selecting a voice starts playback
      list.querySelectorAll('.voice-picker-item').forEach(item => {
        item.addEventListener('click', () => {
          const selectedEngine = item.dataset.engine;
          const voiceId = item.dataset.voiceId;

          hideVoicePicker();
          resetAllSpeakButtons();
          resetListenPageButton();

          // Build a settings object for this specific playback
          const playSettings = {
            ttsEngine: selectedEngine,
            localTtsVoice: selectedEngine === 'local' ? voiceId : '',
            kokoroEndpoint: settings.kokoroEndpoint || '',
            kokoroVoice: selectedEngine === 'kokoro' ? voiceId : (settings.kokoroVoice || ''),
            indexTtsEndpoint: settings.indexTtsEndpoint || '',
            chatterboxVoice: (selectedEngine === 'chatterbox' || selectedEngine === 'voicebox-lab') ? voiceId : (settings.chatterboxVoice || DEFAULT_CHATTERBOX_VOICE),
            allowExperimentalIndexTtsArticleVoice: settings.allowExperimentalIndexTtsArticleVoice === true,
            autoDownloadGeneratedAudio: settings.autoDownloadGeneratedAudio !== false,
            generatedAudioFolder: settings.generatedAudioFolder || '',
            generatedAudioFilename: `${buildSourceFilename('audio')}.mp3`,
            elevenLabsApiKey: settings.elevenLabsApiKey || '',
            elevenLabsVoice: selectedEngine === 'elevenlabs' ? voiceId : '',
            elevenLabsModel: settings.elevenLabsModel || ''
          };

          const text = bubble.querySelector('.message-content').innerText;
          const bubbleId = bubble.dataset.bubbleId;

          ttsEngine.play(text, bubbleId, playSettings, (newState, errorMessage) => {
            updateSpeakButton(btn, newState, errorMessage);
            if (newState === 'ended') syncConversation();
          });
        });
      });

      // Scroll the saved/default voice into view
      const savedItem = list.querySelector('.voice-picker-item.saved');
      if (savedItem) savedItem.scrollIntoView({ block: 'center', behavior: 'instant' });

    } catch (e) {
      list.innerHTML = '<div class="voice-picker-empty">Failed to load voices</div>';
      console.error('Sidekick: Voice picker error', e);
    }
  }

  function updateSendButton(container, streaming) {
    const btn = container.querySelector('.send-btn');
    const modelSelect = container.querySelector('.chat-model-select');
    if (modelSelect) modelSelect.disabled = streaming;

    if (streaming) {
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      btn.title = 'Stop';
      btn.classList.add('stop-btn');
    } else {
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      btn.title = 'Send message';
      btn.classList.remove('stop-btn');
    }
  }

  // ─── PAGE CONTEXT EXTRACTION ────────────────────────────────────────
  function shouldPreferReadabilityForPage() {
    const hostname = location.hostname.toLowerCase();
    const appHosts = [
      'docs.google.com',
      'mail.google.com',
      'drive.google.com',
      'notion.so'
    ];

    if (appHosts.some(host => hostname === host || hostname.endsWith(`.${host}`))) {
      return false;
    }

    const ogType = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() || '';
    if (ogType.includes('article')) return true;

    return !!document.querySelector('article, main, [itemtype*="Article"], [itemtype*="NewsArticle"], [role="article"]');
  }

  const MIN_PAGE_TEXT_CHARS = 400;

  function normalizeExtractedText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeSpeechText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function collectSpeechSegments(root) {
    if (!root) return [];
    const nodes = root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote');
    const segments = [];
    nodes.forEach(node => {
      const text = normalizeExtractedText(node.innerText || node.textContent || '');
      if (!text) return;
      if (text.length < 2) return;
      if (segments[segments.length - 1] === text) return;
      segments.push(text);
    });
    return segments;
  }

  function removeChromeFromClone(clone) {
    const removeSelectors = [
      'script', 'style', 'noscript', 'iframe', 'svg',
      'nav', 'footer', 'header',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.sidebar', '.menu', '.nav', '.footer', '.header', '.ad', '.advertisement',
      '#sidekick-host'
    ];
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getFirstMetaContent(selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.content?.trim();
      if (value) return value;
    }
    return '';
  }

  function getPageMetadataContext(url, title, visibleText = '', maxContext = 60000) {
    const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href?.trim() || '';
    const description = getFirstMetaContent([
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]'
    ]);
    const ogTitle = getFirstMetaContent([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]'
    ]);
    const siteName = getFirstMetaContent([
      'meta[property="og:site_name"]'
    ]);
    const author = getFirstMetaContent([
      'meta[name="author"]',
      'meta[property="article:author"]'
    ]);
    const publishedAt = getFirstMetaContent([
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]'
    ]);
    const tags = Array.from(document.querySelectorAll('meta[property="article:tag"]'))
      .map(meta => meta.content?.trim())
      .filter(Boolean);
    const snippet = normalizeExtractedText(visibleText).slice(0, 800);
    const metadataTitle = ogTitle || title;
    const lines = [
      'Page content was unavailable or insufficient. Use page metadata only.',
      metadataTitle ? `Page title: ${metadataTitle}` : '',
      description ? `Description: ${description}` : '',
      siteName ? `Site: ${siteName}` : '',
      author ? `Author: ${author}` : '',
      publishedAt ? `Published: ${publishedAt}` : '',
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
      canonicalUrl && canonicalUrl !== url ? `Canonical URL: ${canonicalUrl}` : '',
      `URL: ${url}`,
      snippet.length >= 80 ? `Visible text snippet, possibly incomplete: ${snippet}` : ''
    ].filter(Boolean);

    return {
      title: metadataTitle || title,
      url,
      content: lines.join('\n').slice(0, maxContext),
      type: 'metadata',
      limitedContext: true
    };
  }

  function looksLikePageChrome(text) {
    const normalized = normalizeExtractedText(text).toLowerCase();
    if (normalized.length < 2000) return false;

    const firstChunk = normalized.slice(0, 5000);
    const chromeSignals = [
      'skip to main content',
      'keyboard shortcuts',
      'account & lists',
      'returns & orders',
      'add to cart',
      'buy now',
      'list price',
      'free delivery',
      'quantity:',
      'shipping cost',
      'payment secure transaction',
      'wish lists',
      'search amazon',
      'shop by interest'
    ];
    const hitCount = chromeSignals.reduce((count, signal) => count + (firstChunk.includes(signal) ? 1 : 0), 0);
    return hitCount >= 5;
  }

  async function getContextLimit(options = {}) {
    if (options.maxContextOverride) return options.maxContextOverride;
    return await new Promise(resolve => {
      chrome.storage.local.get(['provider', 'maxContext'], (r) => {
        const savedMaxContext = parseInt(r.maxContext, 10);
        const isOldLocalDefault = r.provider === 'local' && (!savedMaxContext || savedMaxContext === 10000);
        resolve(isOldLocalDefault ? 60000 : (savedMaxContext || 60000));
      });
    });
  }

  async function extractSpeechContext(options = {}) {
    const maxContext = await getContextLimit(options);
    const url = location.href;
    const title = document.title;

    if (location.hostname.includes('youtube.com') && location.pathname === '/watch') {
      const context = await extractPageContext({ maxContextOverride: maxContext, preferReadability: true });
      return {
        ...context,
        content: normalizeSpeechText(context.content).slice(0, maxContext)
      };
    }

    if (typeof Readability === 'function') {
      try {
        const article = new Readability(document.cloneNode(true)).parse();
        const articleRoot = document.createElement('div');
        articleRoot.innerHTML = article?.content || '';
        const segments = collectSpeechSegments(articleRoot);
        const articleText = normalizeSpeechText(
          segments.length ? segments.join('\n\n') : article?.textContent
        );
        if (articleText.length >= MIN_PAGE_TEXT_CHARS) {
          return {
            title: article.title || title,
            url,
            content: articleText.slice(0, maxContext),
            type: 'page',
            speech: true,
            paragraphCount: segments.length
          };
        }
      } catch (e) {
        console.log('Sidekick: speech Readability extraction failed, falling back to page text');
      }
    }

    const clone = document.body.cloneNode(true);
    removeChromeFromClone(clone);
    const segments = collectSpeechSegments(clone);
    const speechText = normalizeSpeechText(
      segments.length ? segments.join('\n\n') : (clone.innerText || clone.textContent || '')
    );

    if (speechText.length < MIN_PAGE_TEXT_CHARS || looksLikePageChrome(speechText)) {
      return getPageMetadataContext(url, title, speechText, maxContext);
    }

    return {
      title,
      url,
      content: speechText.slice(0, maxContext),
      type: 'page',
      speech: true,
      paragraphCount: segments.length
    };
  }

  async function extractPageContext(options = {}) {
    const maxContext = await getContextLimit(options);

    const url = location.href;
    const title = document.title;

    // YouTube?
    if (location.hostname.includes('youtube.com') && location.pathname === '/watch') {
      if (typeof window.__sidekick_getYouTubeTranscript === 'function') {
        try {
          const result = await window.__sidekick_getYouTubeTranscript();
          if (result.success) {
            const content = result.transcript.slice(0, maxContext);
            return {
              title: result.title || title,
              url,
              content,
              transcript: result.transcript,
              type: 'youtube'
            };
          }
          return {
            title: result.title || title,
            url,
            content: `Transcript unavailable for this YouTube video. ${result.error || 'YouTube did not expose captions to Sidekick.'}`,
            type: 'youtube',
            error: result.error || 'Transcript unavailable'
          };
        } catch (e) {
          console.log('Sidekick: YouTube transcript extraction failed, falling back to page text');
          return {
            title,
            url,
            content: `Transcript unavailable for this YouTube video. ${e.message || 'YouTube did not expose captions to Sidekick.'}`,
            type: 'youtube',
            error: e.message || 'Transcript unavailable'
          };
        }
      }
    }

    // Regular page text extraction
    if (options.preferReadability && typeof Readability === 'function') {
      try {
        const article = new Readability(document.cloneNode(true)).parse();
        const articleText = normalizeExtractedText(article?.textContent);
        if (articleText.length >= MIN_PAGE_TEXT_CHARS) {
          return {
            title: article.title || title,
            url,
            content: articleText.slice(0, maxContext),
            type: 'page'
          };
        }
      } catch (e) {
        console.log('Sidekick: Readability extraction failed, falling back to page text');
      }
    }

    const clone = document.body.cloneNode(true);

    // Remove non-content elements
    removeChromeFromClone(clone);

    let text = normalizeExtractedText(clone.innerText || clone.textContent || '');

    if (text.length < MIN_PAGE_TEXT_CHARS || looksLikePageChrome(text)) {
      return getPageMetadataContext(url, title, text, maxContext);
    }

    text = text.slice(0, maxContext);

    return { title, url, content: text, type: 'page' };
  }

  // ─── CONVERSATION ACTIONS ───────────────────────────────────────────
  function downloadTranscript() {
    const context = chatEngine?.pageContext;
    if (!context || context.type !== 'youtube' || context.error || !context.transcript) return;

    const transcript = `${context.title}\n${context.url}\n\n${context.transcript.trim()}\n`;
    const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${buildSourceFilename('transcript')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadConversation() {
    if (!chatEngine) return;
    const md = chatEngine.exportMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${buildSourceFilename('conversation')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── SCREENSHOT CAPTURE ────────────────────────────────────────────
  function captureScreenshot(container) {
    // Flash the button to show it's working
    const btn = container.querySelector('[data-action="screenshot"]');
    btn.classList.add('capturing');

    const host = document.getElementById('sidekick-host');
    const previousDisplay = host ? host.style.display : '';
    let restored = false;
    const restoreSidekick = () => {
      if (restored) return;
      restored = true;
      if (host) host.style.display = previousDisplay;
    };

    if (host) host.style.display = 'none';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        safeSendMessage({ action: 'captureScreenshot' }, (dataUrl) => {
          restoreSidekick();
          btn.classList.remove('capturing');

          if (!dataUrl) {
            console.error('Sidekick: Screenshot capture failed');
            return;
          }

          // Extract base64 from data URL (format: "data:image/png;base64,...")
          const base64 = dataUrl.split(',')[1];
          const mediaType = 'image/png';
          const name = `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;

          // Add to pending images (same pipeline as drag-and-drop)
          pendingImages.push({ base64, mediaType, name });
          updateImagePreview(container);

          // Focus the input so the user can type a question about the screenshot
          container.querySelector('.chat-input').focus();
        });
        setTimeout(() => {
          restoreSidekick();
          btn.classList.remove('capturing');
        }, 2000);
      });
    });
  }

  // ─── CONVERSATION SYNC (for auto-save on tab close) ───────────────
  async function syncConversation() {
    if (!chatEngine || chatEngine.messages.length === 0) return;
    try {
      const tabId = await getTabId();
      if (!tabId) return;

      // Build conversation data
      const messages = chatEngine.messages.map(msg => {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type === 'text');
          text = textParts.map(p => p.text).join('\n');
        }
        return { role: msg.role, text };
      });

      // Collect all cached generated audio blobs
      const audioFiles = [];
      if (ttsEngine) {
        const cache = ttsEngine.getAllCachedAudio();
        for (const [bubbleId, blob] of cache) {
          if (String(bubbleId).startsWith('page-listen:')) continue;
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          audioFiles.push({ bubbleId, dataUrl });
        }
      }

      const conversationData = {
        tabId,
        tabTitle: document.title,
        url: location.href,
        timestamp: new Date().toISOString(),
        messages,
        audioFiles
      };

      chrome.storage.local.set({ [`conversation_${tabId}`]: conversationData });
    } catch (e) {
      console.log('Sidekick: Failed to sync conversation', e);
    }
  }

  // Stop TTS on page unload
  window.addEventListener('beforeunload', () => {
    if (ttsEngine) ttsEngine.stop();
  });


  // ─── RESIZE ─────────────────────────────────────────────────────────
  function setupResize(container) {
    const MIN_W = 320, MAX_W = 800, MIN_H = 300;

    function startResize(e, edges) {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = container.offsetWidth;
      const startH = container.offsetHeight;
      const maxH = window.innerHeight - 40;

      function onMouseMove(e) {
        let newW = startW;
        let newH = startH;

        if (edges.includes('left')) {
          newW = startW - (e.clientX - startX);
        }
        if (edges.includes('top')) {
          newH = startH - (e.clientY - startY);
        }

        newW = Math.max(MIN_W, Math.min(MAX_W, newW));
        newH = Math.max(MIN_H, Math.min(maxH, newH));

        container.style.width = newW + 'px';
        container.style.height = newH + 'px';
      }

      function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);
        // Save size
        chrome.storage.local.set({
          chatWidth: container.offsetWidth,
          chatHeight: container.offsetHeight
        });
      }

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
    }

    container.querySelector('.resize-left').addEventListener('mousedown', (e) => startResize(e, ['left']));
    container.querySelector('.resize-top').addEventListener('mousedown', (e) => startResize(e, ['top']));
    container.querySelector('.resize-corner').addEventListener('mousedown', (e) => startResize(e, ['left', 'top']));
  }

  function composeUserText(text, files) {
    if (!files.length) return text;
    const attached = files.map(file => `---\nAttached file: ${file.name}\n\n${file.text}`).join('\n\n');
    return text ? `${text}\n\n${attached}` : attached;
  }

  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const TEXT_FILE = /\.(txt|md|markdown|json|csv|html|css|js|ts|tsx|jsx|py|xml|yml|yaml|log|sh|svg)$/i;

  function ingestFiles(fileList, container) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      const isImage = IMAGE_TYPES.includes(file.type) || file.type.startsWith('image/');
      const isText = TEXT_FILE.test(file.name) || file.type.startsWith('text/') || file.type === 'application/json';
      if (!isImage && !isText) {
        console.warn(`Sidekick: Skipping unsupported file ${file.name}`);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        console.warn(`Sidekick: ${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB — large files may slow things down`);
      }
      const reader = new FileReader();
      if (isImage) {
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          pendingImages.push({
            base64: String(dataUrl).split(',')[1],
            mediaType: file.type || 'image/png',
            name: file.name
          });
          updateImagePreview(container);
        };
        reader.readAsDataURL(file);
      } else {
        reader.onload = (ev) => {
          pendingFiles.push({ name: file.name, text: String(ev.target.result || '') });
          updateImagePreview(container);
        };
        reader.readAsText(file);
      }
    }
  }

  function setupImageDrop(container) {
    const inputArea = container.querySelector('.chat-input-area');
    const messagesArea = container.querySelector('.chat-messages');
    const dropOverlay = container.querySelector('.drop-overlay');

    function handleDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.style.display = 'flex';
    }

    function handleDragLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!container.contains(e.relatedTarget)) {
        dropOverlay.style.display = 'none';
      }
    }

    function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.style.display = 'none';
      ingestFiles(e.dataTransfer?.files, container);
    }

    [messagesArea, inputArea].forEach(el => {
      el.addEventListener('dragover', handleDragOver);
      el.addEventListener('dragleave', handleDragLeave);
      el.addEventListener('drop', handleDrop);
    });
  }

  function updateImagePreview(container) {
    const previewArea = container.querySelector('.image-preview-area');
    if (pendingImages.length === 0 && pendingFiles.length === 0) {
      previewArea.style.display = 'none';
      previewArea.innerHTML = '';
      syncContextBanner(container);
      return;
    }

    const fileChips = pendingFiles.map((file, i) =>
      `<div class="file-preview-item">
        ${CONTEXT_ICONS.page}
        <span class="image-name">${escapeHtml(file.name)}</span>
        <button class="image-remove" data-kind="file" data-index="${i}" aria-label="Remove ${escapeHtml(file.name)}">${ICON_X}</button>
      </div>`
    ).join('');
    const imageChips = pendingImages.map((img, i) =>
      `<div class="image-preview-item">
        <img src="data:${img.mediaType};base64,${img.base64}" alt="${escapeHtml(img.name)}">
        <button class="image-remove" data-kind="image" data-index="${i}" aria-label="Remove ${escapeHtml(img.name)}">${ICON_X}</button>
        <span class="image-name">${escapeHtml(img.name)}</span>
      </div>`
    ).join('');

    previewArea.style.display = 'flex';
    previewArea.innerHTML = fileChips + imageChips;

    syncContextBanner(container);

    previewArea.querySelectorAll('.image-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index, 10);
        if (btn.dataset.kind === 'file') pendingFiles.splice(index, 1);
        else pendingImages.splice(index, 1);
        updateImagePreview(container);
      });
    });
  }

  // ─── COMMAND PILLS (welcome screen) ────────────────────────────────
  function getInitialCommands(storedCommands) {
    const nextCommands = SidekickPrompts.getInitialCommands(storedCommands);
    if (storedCommands && SidekickPrompts.shouldMigrateDefaultCommands(storedCommands)) {
      chrome.storage.local.set({ commands: nextCommands });
    }
    return nextCommands;
  }

  function populateCommandPills(container) {
    const pillsContainer = container.querySelector('.command-pills');
    if (!pillsContainer) return;

    function renderPills(storedCommands) {
      const commands = getInitialCommands(storedCommands)
        .filter(cmd => SidekickPrompts.commandShowsInEmptyState(cmd));

      pillsContainer.innerHTML = commands.map(cmd =>
        `<button class="command-pill" data-command="/${escapeHtml(cmd.name)}" title="${escapeHtml(cmd.prompt)}">/${escapeHtml(cmd.name)}</button>`
      ).join('');

      pillsContainer.querySelectorAll('.command-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          const input = container.querySelector('.chat-input');
          input.value = pill.dataset.command;
          handleSend(container);
        });
      });
    }

    chrome.storage.local.get('commands', (result) => renderPills(result.commands));
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.commands) renderPills(changes.commands.newValue);
    });
  }

  // ─── FLOATING BUTTON ──────────────────────────────────────────────
  function createFloatingButton() {
    if (floatingBtn) return floatingBtn;

    const btn = document.createElement('div');
    btn.id = 'sidekick-fab';
    btn.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483646;';

    const fabShadow = btn.attachShadow({ mode: 'closed' });

    // Load chat.css for theme variables, then add fab-specific styles
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = chrome.runtime.getURL('chat.css');
    fabShadow.appendChild(cssLink);

    const fabEl = document.createElement('button');
    fabEl.className = 'sidekick-fab-btn';

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon32.png');
    img.width = 20;
    img.height = 20;
    img.alt = 'Sidekick';
    img.style.cssText = 'display:block;border-radius:4px;';
    fabEl.appendChild(img);

    fabEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChat(true);
    });

    fabShadow.appendChild(fabEl);
    document.body.appendChild(btn);
    floatingBtn = btn;
    return btn;
  }

  function showFloatingBtn() {
    if (!floatingBtnEnabled) return;
    if (!floatingBtn) createFloatingButton();
    floatingBtn.style.display = 'block';
  }

  function hideFloatingBtn() {
    if (floatingBtn) floatingBtn.style.display = 'none';
  }

  // Check setting and create button if enabled
  chrome.storage.local.get('showFloatingButton', (result) => {
    floatingBtnEnabled = !!result.showFloatingButton;
    if (floatingBtnEnabled) showFloatingBtn();
  });

  // React to setting changes in real-time
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.showFloatingButton) {
      floatingBtnEnabled = !!changes.showFloatingButton.newValue;
      if (floatingBtnEnabled && !chatVisible) {
        showFloatingBtn();
      } else if (!floatingBtnEnabled) {
        hideFloatingBtn();
      }
    }
  });

  // ─── TOGGLE CHAT ────────────────────────────────────────────────────
  let chatContainer = null;
  let chatOpenSequence = 0;

  async function submitStartupCommand(container, openSequence) {
    if (!chatEngine) return;
    const [settings] = await Promise.all([
      chrome.storage.local.get(['autoSubmitCommandOnStart', 'startupCommand']),
      chatEngine.commandsReady
    ]);
    if (settings.autoSubmitCommandOnStart !== true || !chatVisible || openSequence !== chatOpenSequence) return;
    const input = container.querySelector('.chat-input');
    if (input.value || pendingImages.length || pendingFiles.length || contextDiscarded) return;
    if (contextSendPending || chatEngine.isStreaming || chatEngine.messages.length) return;
    // The welcome state also excludes a manual send still loading its settings
    // or an earlier failed submission that hasn't entered engine history.
    if (!container.querySelector('.welcome-message')) return;
    const name = typeof settings.startupCommand === 'string' ? settings.startupCommand : 'tldr';
    const command = chatEngine.commands.find(command => command.name === name);
    if (!command) return;
    input.value = `/${command.name}`;
    await handleSend(container);
  }

  async function toggleChat(forceState) {
    await ensureAudioDefaultsMigrated();
    await ensureFalDefaultsMigrated();
    const show = forceState !== undefined ? forceState : !chatVisible;
    const wasVisible = chatVisible;
    const openSequence = ++chatOpenSequence;

    if (!chatContainer) {
      chatContainer = createChatUI();
      chatEngine = loadChatEngine();
      ttsEngine = loadTTSEngine();
      applySavedListenSpeed();
      populateCommandPills(chatContainer);

      if (chatEngine) {
        applyContextBanner(chatContainer, {
          title: document.title,
          type: isYouTubeWatchPage() ? 'youtube' : 'page'
        });
        syncContextBanner(chatContainer);

        // Extract page context in the background so the tab name is visible
        // before the user types. The send path still waits if needed.
        pageContextLoading = true;
        pageContextPromise = (async () => {
          try {
            const context = await extractPageContext({ preferReadability: shouldPreferReadabilityForPage() });
            if (contextDiscarded) return;
            if (context && context.content) {
              chatEngine.setContext(context);
              applyContextBanner(chatContainer, context);
            } else {
              const banner = chatContainer.querySelector('.context-banner');
              if (banner) delete banner.dataset.ready;
            }
          } catch (e) {
            console.log('Sidekick: Page context extraction failed', e);
            const banner = chatContainer.querySelector('.context-banner');
            if (banner && !chatEngine.pageContext) delete banner.dataset.ready;
          } finally {
            pageContextLoading = false;
            if (chatContainer) syncContextBanner(chatContainer);
          }
        })();
      }
    }

    chatVisible = show;
    const host = document.getElementById('sidekick-host');
    if (host) {
      host.style.display = show ? 'block' : 'none';
    }

    // Toggle floating button visibility
    if (show) {
      hideFloatingBtn();
    } else {
      showFloatingBtn();
    }

    if (show && chatContainer) {
      chatContainer.querySelector('.chat-input').focus();
      if (!wasVisible) {
        try {
          await submitStartupCommand(chatContainer, openSequence);
        } catch (error) {
          console.error('Sidekick: Could not auto-submit the startup command', error);
        }
      }
    }
  }

  // ─── FONT APPLICATION ──────────────────────────────────────────────
  // Uses a <style> element in the shadow root to override the --chat-font
  // variable. More reliable than inline style.setProperty for CSS custom
  // properties in Shadow DOM contexts.
  const loadedFonts = new Set();

  function applyFont(fontValue) {
    currentFont = ALLOWED_FONT_FAMILIES.includes(fontValue) ? fontValue : DEFAULT_FONT_FAMILY;
    if (!shadowRoot) return;

    // Override --chat-font via a <style> element (appears after the <link>
    // in DOM order, so same-specificity rules here win over chat.css)
    let fontStyle = shadowRoot.getElementById('sidekick-font-override');
    if (!fontStyle) {
      fontStyle = document.createElement('style');
      fontStyle.id = 'sidekick-font-override';
      shadowRoot.appendChild(fontStyle);
    }
    fontStyle.textContent = `.sidekick-container { --chat-font: ${currentFont}; }`;

    // Load the Google Font into the shadow root
    if (!currentFont || currentFont === 'system-ui') return;
    const match = currentFont.match(/'([^']+)'/);
    if (!match) return;
    const fontName = match[1];
    if (loadedFonts.has(fontName)) return;
    loadedFonts.add(fontName);
    const encodedName = fontName.replace(/ /g, '+');
    const url = `https://fonts.googleapis.com/css2?family=${encodedName}:wght@400;500;600&display=swap`;
    if (!shadowRoot.querySelector(`link[href="${url}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      shadowRoot.appendChild(link);
    }
  }

  // ─── APPEARANCE ────────────────────────────────────────────────────
  function applyAppearance(container, appearance) {
    container.classList.toggle('appearance-glass', appearance !== 'classic');
  }

  // ─── THEME ─────────────────────────────────────────────────────────
  let themeMediaListener = null;
  function applyTheme(container, theme) {
    container.classList.remove('theme-dark');
    if (theme === 'dark') {
      container.classList.add('theme-dark');
    } else if (theme === 'auto') {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        container.classList.add('theme-dark');
      }
    }
    // Listen for system theme changes when set to auto (only one listener)
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (themeMediaListener) mq.removeEventListener('change', themeMediaListener);
    themeMediaListener = (e) => {
      chrome.storage.local.get('theme', (result) => {
        if ((result.theme || 'auto') === 'auto') {
          container.classList.toggle('theme-dark', e.matches);
        }
      });
    };
    mq.addEventListener('change', themeMediaListener);
  }

  // ─── HELPERS ────────────────────────────────────────────────────────
  // Safe for text and quoted attributes: textContent alone leaves quotes unescaped.
  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Safe wrapper for chrome.runtime.sendMessage — catches "Extension context
  // invalidated" errors that happen when the extension is reloaded but the
  // page still has the old content script running.
  function safeSendMessage(msg, callback) {
    try {
      chrome.runtime.sendMessage(msg, callback);
    } catch (e) {
      console.log('Sidekick: Extension was reloaded — please refresh the page.');
    }
  }

  // ─── MESSAGE LISTENER ──────────────────────────────────────────────
  ensureAudioDefaultsMigrated();
  ensureFalDefaultsMigrated();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'toggleChat') {
      toggleChat();
    }
  });
})();
