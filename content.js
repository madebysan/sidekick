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
  let shadowRoot = null;
  let pendingImages = [];  // Array of {base64, mediaType, name}
  let currentFont = 'system-ui';
  let bubbleCounter = 0;   // For unique bubble IDs
  let currentTabId = null;  // Cached tab ID for conversation sync

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

  // Get and cache the tab ID for conversation syncing
  function getTabId() {
    return new Promise((resolve) => {
      if (currentTabId) {
        resolve(currentTabId);
        return;
      }
      chrome.runtime.sendMessage({ action: 'getTabId' }, (tabId) => {
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

    // Apply saved size, font, and theme
    chrome.storage.local.get(['chatWidth', 'chatHeight', 'fontFamily', 'theme'], (result) => {
      if (result.chatWidth) container.style.width = result.chatWidth + 'px';
      if (result.chatHeight) container.style.height = result.chatHeight + 'px';
      if (result.fontFamily) {
        currentFont = result.fontFamily;
        container.style.setProperty('--chat-font', currentFont);
        loadGoogleFont(currentFont);
      }
      applyTheme(container, result.theme || 'auto');
    });

    // Listen for setting changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.fontFamily) {
        currentFont = changes.fontFamily.newValue || 'system-ui';
        container.style.setProperty('--chat-font', currentFont);
        loadGoogleFont(currentFont);
      }
      if (changes.theme) {
        applyTheme(container, changes.theme.newValue || 'auto');
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
        <div class="chat-title">Sidekick</div>
        <div class="chat-actions">
          <button class="action-btn" data-action="settings" title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="action-btn" data-action="screenshot" title="Screenshot visible page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
          <button class="action-btn" data-action="download" title="Download conversation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
<button class="action-btn" data-action="close" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- Context banner -->
      <div class="context-banner" style="display:none;">
        <div class="context-info">
          <span class="context-icon">📄</span>
          <span class="context-text"></span>
        </div>
        <button class="context-discard" title="Discard context">✕</button>
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
        <div class="drop-overlay" style="display:none;">Drop image here</div>
        <textarea class="chat-input" placeholder="Type a message or /command..." rows="1"></textarea>
        <button class="send-btn" title="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    `;
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
          chrome.runtime.sendMessage({ action: 'openSettings' });
        } else if (action === 'download') {
          downloadConversation();
        } else if (action === 'screenshot') {
          captureScreenshot(container);
        }
      });
    });

    // Context discard
    container.querySelector('.context-discard').addEventListener('click', () => {
      if (chatEngine) chatEngine.discardContext();
      container.querySelector('.context-banner').style.display = 'none';
    });

    // Send message
    sendBtn.addEventListener('click', () => handleSend(container));

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

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';

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

    const input = container.querySelector('.chat-input');
    const text = input.value.trim();
    if (!text && pendingImages.length === 0) return;

    if (chatEngine.isStreaming) {
      chatEngine.stopStreaming();
      updateSendButton(container, false);
      return;
    }

    const messagesArea = container.querySelector('.chat-messages');

    // Remove welcome message
    const welcome = messagesArea.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Display user message
    const displayText = text || '(image)';
    addMessageBubble(messagesArea, 'user', displayText, pendingImages);

    // Clear input and images
    input.value = '';
    input.style.height = 'auto';
    const images = [...pendingImages];
    pendingImages = [];
    updateImagePreview(container);

    // Hide autocomplete
    container.querySelector('.command-autocomplete').style.display = 'none';

    // Create assistant bubble for streaming
    const assistantBubble = addMessageBubble(messagesArea, 'assistant', '', null, true);
    const contentEl = assistantBubble.querySelector('.message-content');
    let fullText = '';

    // Switch send button to stop button
    updateSendButton(container, true);

    chatEngine.sendMessage(
      text,
      images.map(img => ({ base64: img.base64, mediaType: img.mediaType })),
      // onToken — no auto-scroll, user scrolls manually
      (token) => {
        fullText += token;
        contentEl.innerHTML = renderMarkdown(fullText);
      },
      // onDone
      (finalText) => {
        if (finalText) {
          contentEl.innerHTML = renderMarkdown(finalText);
        } else if (fullText) {
          contentEl.innerHTML = renderMarkdown(fullText);
        }
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
        contentEl.innerHTML = `<div class="error-message">${escapeHtml(error)}</div>`;
        updateSendButton(container, false);
        assistantBubble.querySelector('.streaming-cursor')?.remove();
      }
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
        </div>`
      : '';

    bubble.innerHTML = `
      ${imagesHTML}
      <div class="message-content">${text ? renderMarkdown(text) : ''}</div>
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

  // ─── TTS SPEAK BUTTON ──────────────────────────────────────────────
  // SVG icons for speak button states
  const SPEAK_ICONS = {
    idle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    playing: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    paused: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
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
        ['useDefaultVoice', 'ttsEngine', 'localTtsVoice', 'elevenLabsApiKey', 'elevenLabsVoice'],
        (settings) => {
          if (settings.useDefaultVoice) {
            // Auto-play with saved default voice
            resetAllSpeakButtons();
            const playSettings = {
              ttsEngine: settings.ttsEngine || 'local',
              localTtsVoice: settings.localTtsVoice || '',
              elevenLabsApiKey: settings.elevenLabsApiKey || '',
              elevenLabsVoice: settings.elevenLabsVoice || ''
            };
            const text = bubble.querySelector('.message-content').innerText;
            const bubbleId = bubble.dataset.bubbleId;
            ttsEngine.play(text, bubbleId, playSettings, (newState) => {
              updateSpeakButton(btn, newState);
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

  function updateSpeakButton(btn, state) {
    if (state === 'playing') {
      btn.dataset.state = 'playing';
      btn.innerHTML = `${SPEAK_ICONS.playing} Pause`;
      btn.classList.add('speaking');
    } else if (state === 'paused') {
      btn.dataset.state = 'paused';
      btn.innerHTML = `${SPEAK_ICONS.paused} Resume`;
      btn.classList.add('speaking');
    } else if (state === 'error') {
      // Show error briefly, then reset to idle
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Failed`;
      btn.classList.remove('speaking');
      btn.classList.add('speak-error');
      setTimeout(() => {
        btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
        btn.classList.remove('speak-error');
      }, 2500);
    } else {
      // 'ended' — reset to idle
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.classList.remove('speaking');
    }
  }

  function resetAllSpeakButtons() {
    if (!shadowRoot) return;
    hideVoicePicker();
    shadowRoot.querySelectorAll('.message-speak-btn').forEach(btn => {
      btn.dataset.state = 'idle';
      btn.innerHTML = `${SPEAK_ICONS.idle} Speak`;
      btn.classList.remove('speaking');
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
    chrome.storage.local.get(['ttsEngine', 'localTtsVoice', 'elevenLabsApiKey', 'elevenLabsVoice'], (settings) => {
      const currentEngine = settings.ttsEngine || 'local';
      const hasElevenLabs = !!settings.elevenLabsApiKey;

      // Only show engine tabs if both engines are available
      let tabsHTML = '';
      if (hasElevenLabs) {
        tabsHTML = `<div class="voice-picker-tabs">
          <button class="voice-picker-tab ${currentEngine === 'local' ? 'active' : ''}" data-engine="local">Browser</button>
          <button class="voice-picker-tab ${currentEngine === 'elevenlabs' ? 'active' : ''}" data-engine="elevenlabs">ElevenLabs</button>
        </div>`;
      }

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

          // Build a settings object for this specific playback
          const playSettings = {
            ttsEngine: selectedEngine,
            localTtsVoice: selectedEngine === 'local' ? voiceId : '',
            elevenLabsApiKey: settings.elevenLabsApiKey || '',
            elevenLabsVoice: selectedEngine === 'elevenlabs' ? voiceId : ''
          };

          const text = bubble.querySelector('.message-content').innerText;
          const bubbleId = bubble.dataset.bubbleId;

          ttsEngine.play(text, bubbleId, playSettings, (newState) => {
            updateSpeakButton(btn, newState);
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
  async function extractPageContext() {
    const maxContext = await new Promise(resolve => {
      chrome.storage.local.get('maxContext', (r) => resolve(r.maxContext || 10000));
    });

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
              type: 'youtube'
            };
          }
        } catch (e) {
          console.log('Sidekick: YouTube transcript extraction failed, falling back to page text');
        }
      }
    }

    // Regular page text extraction
    const clone = document.body.cloneNode(true);

    // Remove non-content elements
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

    let text = clone.innerText || clone.textContent || '';
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    // Cap at max length
    text = text.slice(0, maxContext);

    return { title, url, content: text, type: 'page' };
  }

  // ─── CONVERSATION ACTIONS ───────────────────────────────────────────
  function downloadConversation() {
    if (!chatEngine) return;
    const md = chatEngine.exportMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sidekick-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── SCREENSHOT CAPTURE ────────────────────────────────────────────
  function captureScreenshot(container) {
    // Flash the button to show it's working
    const btn = container.querySelector('[data-action="screenshot"]');
    btn.classList.add('capturing');

    chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (dataUrl) => {
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

      // Collect all cached ElevenLabs audio blobs
      const audioFiles = [];
      if (ttsEngine) {
        const cache = ttsEngine.getAllCachedAudio();
        for (const [bubbleId, blob] of cache) {
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
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Save size
        chrome.storage.local.set({
          chatWidth: container.offsetWidth,
          chatHeight: container.offsetHeight
        });
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    container.querySelector('.resize-left').addEventListener('mousedown', (e) => startResize(e, ['left']));
    container.querySelector('.resize-top').addEventListener('mousedown', (e) => startResize(e, ['top']));
    container.querySelector('.resize-corner').addEventListener('mousedown', (e) => startResize(e, ['left', 'top']));
  }

  // ─── IMAGE DRAG & DROP ──────────────────────────────────────────────
  function setupImageDrop(container) {
    const inputArea = container.querySelector('.chat-input-area');
    const messagesArea = container.querySelector('.chat-messages');
    const dropOverlay = container.querySelector('.drop-overlay');

    const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB warning threshold

    function handleDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.style.display = 'flex';
    }

    function handleDragLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      // Only hide if we're leaving the container entirely
      if (!container.contains(e.relatedTarget)) {
        dropOverlay.style.display = 'none';
      }
    }

    function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.style.display = 'none';

      const files = Array.from(e.dataTransfer?.files || []);
      for (const file of files) {
        if (!ACCEPTED_TYPES.includes(file.type)) continue;

        if (file.size > MAX_SIZE) {
          console.warn(`Sidekick: Image ${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB — large images may slow things down`);
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          const base64 = dataUrl.split(',')[1];
          const mediaType = file.type;
          pendingImages.push({ base64, mediaType, name: file.name });
          updateImagePreview(container);
        };
        reader.readAsDataURL(file);
      }
    }

    // Listen on both messages area and input area
    [messagesArea, inputArea].forEach(el => {
      el.addEventListener('dragover', handleDragOver);
      el.addEventListener('dragleave', handleDragLeave);
      el.addEventListener('drop', handleDrop);
    });
  }

  function updateImagePreview(container) {
    const previewArea = container.querySelector('.image-preview-area');
    if (pendingImages.length === 0) {
      previewArea.style.display = 'none';
      previewArea.innerHTML = '';
      return;
    }

    previewArea.style.display = 'flex';
    previewArea.innerHTML = pendingImages.map((img, i) =>
      `<div class="image-preview-item">
        <img src="data:${img.mediaType};base64,${img.base64}" alt="${escapeHtml(img.name)}">
        <button class="image-remove" data-index="${i}">✕</button>
        <span class="image-name">${escapeHtml(img.name)}</span>
      </div>`
    ).join('');

    previewArea.querySelectorAll('.image-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingImages.splice(parseInt(btn.dataset.index), 1);
        updateImagePreview(container);
      });
    });
  }

  // ─── COMMAND PILLS (welcome screen) ────────────────────────────────
  function populateCommandPills(container) {
    const pillsContainer = container.querySelector('.command-pills');
    if (!pillsContainer) return;

    chrome.storage.local.get('commands', (result) => {
      const commands = result.commands || [
        { name: 'tldr', prompt: 'Provide a TL;DR summary of the page content.' },
        { name: 'explain', prompt: 'Explain this content in simple terms as if I\'m not an expert.' },
        { name: 'translate', prompt: 'Translate the following to' },
        { name: 'key', prompt: 'List the key takeaways from this content.' }
      ];

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
    });
  }

  // ─── TOGGLE CHAT ────────────────────────────────────────────────────
  let chatContainer = null;

  async function toggleChat(forceState) {
    const show = forceState !== undefined ? forceState : !chatVisible;

    if (!chatContainer) {
      chatContainer = createChatUI();
      chatEngine = loadChatEngine();
      ttsEngine = loadTTSEngine();
      populateCommandPills(chatContainer);

      if (chatEngine) {
        // Extract page context on first open
        try {
          const context = await extractPageContext();
          if (context && context.content) {
            chatEngine.setContext(context);
            // Show context banner
            const banner = chatContainer.querySelector('.context-banner');
            const icon = context.type === 'youtube' ? '🎬' : '📄';
            const label = context.type === 'youtube' ? 'Video' : 'Page';
            banner.querySelector('.context-icon').textContent = icon;
            banner.querySelector('.context-text').textContent = `${label}: "${context.title.slice(0, 60)}${context.title.length > 60 ? '...' : ''}"`;
            banner.style.display = 'flex';
          }
        } catch (e) {
          console.log('Sidekick: Page context extraction failed', e);
        }
      }
    }

    chatVisible = show;
    const host = document.getElementById('sidekick-host');
    if (host) {
      host.style.display = show ? 'block' : 'none';
    }

    if (show && chatContainer) {
      chatContainer.querySelector('.chat-input').focus();
    }
  }

  // ─── GOOGLE FONTS (privacy-aware: only loads when non-system font selected)
  const loadedFonts = new Set();
  function loadGoogleFont(fontValue) {
    // Don't load anything for system font
    if (!fontValue || fontValue === 'system-ui') return;
    // Extract font family name from CSS value like "'Inter', sans-serif"
    const match = fontValue.match(/'([^']+)'/);
    if (!match) return;
    const fontName = match[1];
    if (loadedFonts.has(fontName)) return;
    loadedFonts.add(fontName);
    // Load only the specific font needed — @font-face must be in the main document
    const encodedName = fontName.replace(/ /g, '+');
    const url = `https://fonts.googleapis.com/css2?family=${encodedName}:wght@400;500;600&display=swap`;
    if (!document.querySelector(`link[href="${url}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
    }
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
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── MESSAGE LISTENER ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'toggleChat') {
      toggleChat();
    }
  });
})();
