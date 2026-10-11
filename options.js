// Settings page logic: API key, model, font, commands, export/import

document.addEventListener('DOMContentLoaded', () => {
  const LOCAL_DEFAULT_ENDPOINT = SidekickProviders.LOCAL_DEFAULT_ENDPOINT;
  const CODEX_DEFAULT_ENDPOINT = SidekickProviders.CODEX_DEFAULT_ENDPOINT;
  const KOKORO_DEFAULT_ENDPOINT = 'http://localhost:8789';
  const KOKORO_DEFAULT_VOICE = 'af_heart';
  const INDEXTTS_DEFAULT_ENDPOINT = 'http://localhost:8790';
  const CHATTERBOX_DEFAULT_VOICE = 'default';
  const VOICEBOX_LAB_ENGINE = 'voicebox-lab';
  const DEFAULT_TTS_ENGINE = 'elevenlabs';
  const CHATTERBOX_FALLBACK_VOICES = [
    { id: 'default', name: 'Chatterbox', group: 'Default', articleSafe: true, quality: 'benchmarked' }
  ];
  const AUDIO_DEFAULTS_VERSION = 'elevenlabs-default-20260909';
  const FAL_DEFAULTS_VERSION = 'fal-gemini-3.8-flash-default-20260909';
  const PREVIOUS_FAL_DEFAULT_MODELS = [
    'deepseek/deepseek-v4-flash',
    'anthropic/claude-sonnet-4.6'
  ];
  const KOKORO_LANG = {
    a: 'American English',
    b: 'British English',
    e: 'Spanish',
    f: 'French',
    h: 'Hindi',
    i: 'Italian',
    j: 'Japanese',
    p: 'Portuguese',
    z: 'Mandarin Chinese'
  };
  const DEFAULT_COMMANDS = SidekickPrompts.getDefaultCommands();

  // Shared provider config. Endpoint/header behavior lives in chat.js.
  const PROVIDERS = SidekickProviders.PROVIDERS;
  let providerModelConfigs = SidekickProviders.getProviderModelConfig();

  // ─── DOM refs ───────────────────────────────────────────────────────
  const providerSelect = document.getElementById('provider');
  // Edition switches (edition.js) can hide providers and voice engines whose local helpers aren't shipped.
  providerSelect.querySelectorAll('option').forEach(option => {
    if (SidekickProviders.isProviderHidden(option.value)) option.remove();
  });
  document.getElementById('ttsEngine').querySelectorAll('option').forEach(option => {
    if (SidekickProviders.isTtsEngineHidden(option.value)) option.remove();
  });
  const isVisibleProvider = id => !!PROVIDERS[id] && !SidekickProviders.isProviderHidden(id);
  const visibleTtsEngine = engine => (engine && !SidekickProviders.isTtsEngineHidden(engine) ? engine : DEFAULT_TTS_ENGINE);
  const apiKeyGroup = document.getElementById('apiKeyGroup');
  const apiKeyInput = document.getElementById('apiKey');
  const apiKeyHint = document.getElementById('apiKeyHint');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const localEndpointGroup = document.getElementById('localEndpointGroup');
  const localEndpointLabel = document.getElementById('localEndpointLabel');
  const localEndpointInput = document.getElementById('localEndpoint');
  const localEndpointHint = document.getElementById('localEndpointHint');
  const modelSelect = document.getElementById('model');
  const modelHint = document.getElementById('modelHint');
  const refreshModelsBtn = document.getElementById('refreshModels');
  const maxContextInput = document.getElementById('maxContext');
  const customSystemPromptInput = document.getElementById('customSystemPrompt');
  const userMemoryInput = document.getElementById('userMemory');
  const themeRadios = document.querySelectorAll('input[name="theme"]');
  const chatAppearanceRadios = document.querySelectorAll('input[name="chatAppearance"]');
  const fontRadios = document.querySelectorAll('input[name="fontFamily"]');
  const commandsList = document.getElementById('commandsList');
  const autoSubmitCommandCheckbox = document.getElementById('autoSubmitCommandOnStart');
  const startupCommandSelect = document.getElementById('startupCommand');
  let startupCommand = 'tldr';
  const commandForm = document.getElementById('commandForm');
  const commandNameInput = document.getElementById('commandName');
  const commandPromptInput = document.getElementById('commandPrompt');
  const saveCommandBtn = document.getElementById('saveCommand');
  const cancelCommandBtn = document.getElementById('cancelCommand');
  const addCommandBtn = document.getElementById('addCommand');
  const exportBtn = document.getElementById('exportSettings');
  const importBtn = document.getElementById('importSettings');
  const importFile = document.getElementById('importFile');
  const saveStatus = document.getElementById('saveStatus');

  // TTS DOM refs
  const ttsEngineSelect = document.getElementById('ttsEngine');
  const localTtsSettings = document.getElementById('localTtsSettings');
  const kokoroTtsSettings = document.getElementById('kokoroTtsSettings');
  const elevenLabsTtsSettings = document.getElementById('elevenLabsTtsSettings');
  const localTtsVoiceSelect = document.getElementById('localTtsVoice');
  const testLocalVoiceBtn = document.getElementById('testLocalVoice');
  const kokoroEndpointInput = document.getElementById('kokoroEndpoint');
  const kokoroVoiceSelect = document.getElementById('kokoroVoice');
  const refreshKokoroBtn = document.getElementById('refreshKokoroVoices');
  const testKokoroBtn = document.getElementById('testKokoroVoice');
  const chatterboxTtsSettings = document.getElementById('chatterboxTtsSettings');
  const chatterboxVoiceSelect = document.getElementById('chatterboxVoice');
  const refreshChatterboxBtn = document.getElementById('refreshChatterboxVoices');
  const testChatterboxBtn = document.getElementById('testChatterboxVoice');
  const indexTtsEndpointInput = document.getElementById('indexTtsEndpoint');
  const allowExperimentalIndexTtsArticleVoiceCheckbox = document.getElementById('allowExperimentalIndexTtsArticleVoice');
  const elevenLabsApiKeyInput = document.getElementById('elevenLabsApiKey');
  const toggleElevenLabsKeyBtn = document.getElementById('toggleElevenLabsKey');
  const elevenLabsVoiceSelect = document.getElementById('elevenLabsVoice');
  const refreshElevenLabsBtn = document.getElementById('refreshElevenLabsVoices');
  const testElevenLabsBtn = document.getElementById('testElevenLabsVoice');
  const elevenLabsModelSelect = document.getElementById('elevenLabsModel');
  const useDefaultVoiceCheckbox = document.getElementById('useDefaultVoice');
  const autoDownloadGeneratedAudioCheckbox = document.getElementById('autoDownloadGeneratedAudio');
  const generatedAudioFolderInput = document.getElementById('generatedAudioFolder');
  const generatedAudioFolderGroup = document.getElementById('generatedAudioFolderGroup');
  const autoSaveConversationsCheckbox = document.getElementById('autoSaveConversations');
  const showFloatingButtonCheckbox = document.getElementById('showFloatingButton');
  const webSearchEnabledCheckbox = document.getElementById('webSearchEnabled');
  const webSearchHint = document.getElementById('webSearchHint');

  let commands = [];
  let editingIndex = -1; // -1 = creating new, >= 0 = editing

  // Per-provider key/model cache so switching providers restores the right values
  let currentProvider = 'anthropic';
  const savedKeys = {};
  const savedModels = {};
  const savedEndpoints = {};

  function isSettingsWebSearchOn() {
    return !!webSearchEnabledCheckbox?.checked;
  }

  function hasStoredFalKey() {
    return !!String(savedKeys.fal || '').trim();
  }

  function syncWebSearchToggle(enabled) {
    const hasKey = hasStoredFalKey();
    webSearchEnabledCheckbox.disabled = !hasKey;
    webSearchEnabledCheckbox.checked = hasKey && enabled !== false;
    webSearchHint.textContent = hasKey
      ? 'On by default with a Fal key. Cheaper search models: Gemini 3.5 Flash or Claude Haiku 4.5. Sonnet and GPT-5 also search. /tldr and /contrarian stay on the tab; /research uses search.'
      : 'Add a Fal.ai key to use web search.';
  }

  // Swap the key field, hint, and model dropdown to match the active provider
  function applyProvider(providerId) {
    currentProvider = PROVIDERS[providerId] ? providerId : 'anthropic';
    const cfg = PROVIDERS[currentProvider];
    const modelCfg = getProviderModelConfig(currentProvider);
    const models = modelCfg.models.length ? modelCfg.models : cfg.models;
    const savedModel = savedModels[currentProvider] || modelCfg.defaultModel || cfg.defaultModel;
    const selectedModel = models.some(model => model.value === savedModel)
      ? savedModel
      : (models[0]?.value || cfg.defaultModel);

    modelSelect.innerHTML = models
      .map(m => {
        const supportsSearch = SidekickProviders.modelSupportsWebSearch(currentProvider, m.value);
        const searchOn = isSettingsWebSearchOn();
        const label = searchOn && !supportsSearch ? `${m.label} — No web search` : m.label;
        const disabled = searchOn && !supportsSearch ? ' disabled' : '';
        return `<option value="${escapeHtml(m.value)}"${disabled}>${escapeHtml(label)}</option>`;
      })
      .join('');
    modelSelect.value = selectedModel;
    updateModelHint(modelCfg);

    const usesApiKey = !!cfg.apiKeyStorageKey;
    apiKeyGroup.style.display = usesApiKey ? 'block' : 'none';
    if (usesApiKey) {
      apiKeyInput.value = savedKeys[currentProvider] || '';
      apiKeyInput.placeholder = cfg.keyPlaceholder;
      apiKeyHint.innerHTML = cfg.keyHintHtml;
    }

    const usesEndpoint = !!cfg.endpointStorageKey;
    localEndpointGroup.style.display = usesEndpoint ? 'block' : 'none';
    if (usesEndpoint) {
      localEndpointInput.value = savedEndpoints[currentProvider] || cfg.defaultEndpoint || '';
      const isCodex = currentProvider === 'codex';
      localEndpointLabel.textContent = isCodex ? 'Codex Bridge Endpoint' : 'Local Endpoint';
      localEndpointHint.textContent = isCodex
        ? 'Start the bridge with node scripts/codex-server.mjs. Only localhost or 127.0.0.1 endpoints are supported.'
        : "Paste LM Studio's base URL or full chat URL. Sidekick will use /v1/chat/completions. Only localhost or 127.0.0.1 endpoints are supported.";
    }

    refreshModelsBtn.disabled = currentProvider === 'codex';
  }

  function getProviderModelConfig(providerId) {
    return providerModelConfigs.find(provider => provider.providerId === providerId) || {
      providerId,
      label: PROVIDERS[providerId]?.label || providerId,
      modelStorageKey: PROVIDERS[providerId]?.modelStorageKey || 'model',
      defaultModel: PROVIDERS[providerId]?.defaultModel || '',
      models: PROVIDERS[providerId]?.models || [],
      source: 'fallback',
      error: ''
    };
  }

  function updateModelHint(modelCfg) {
    if (!modelHint) return;

    if (currentProvider === 'codex') {
      modelHint.textContent = 'Uses the model and preferences configured in your signed-in local Codex installation.';
      return;
    }

    if (currentProvider === 'local') {
      if (modelCfg.source === 'live') {
        modelHint.textContent = 'Loaded from LM Studio.';
      } else if (modelCfg.source === 'cache') {
        modelHint.textContent = modelCfg.error
          ? `Using cached LM Studio models. ${modelCfg.error}`
          : 'Using cached LM Studio models from the last successful refresh.';
      } else {
        modelHint.textContent = modelCfg.error
          ? `Using fallback local models. ${modelCfg.error}`
          : 'Using fallback local models until LM Studio can be refreshed.';
      }
      return;
    }

    if (currentProvider === 'fal' && (modelCfg.source === 'live' || modelCfg.source === 'cache')) {
      modelHint.textContent = modelCfg.source === 'live'
        ? 'Loaded from OpenRouter, which powers Fal.ai OpenRouter model IDs.'
        : 'Using cached OpenRouter models for Fal.ai.';
      return;
    }

    if (modelCfg.source === 'live') {
      modelHint.textContent = 'Loaded from the provider API.';
    } else if (modelCfg.source === 'cache') {
      modelHint.textContent = modelCfg.error
        ? `Using cached models. ${modelCfg.error}`
        : 'Using cached models from the last successful refresh.';
    } else {
      modelHint.textContent = modelCfg.error
        ? `Using fallback models. ${modelCfg.error}`
        : 'Using fallback models until this provider can be refreshed.';
    }
  }

  function applyAudioDefaultsMigration(result) {
    if (result.sidekickAudioDefaultsVersion === AUDIO_DEFAULTS_VERSION) return result;

    const updates = {
      sidekickAudioDefaultsVersion: AUDIO_DEFAULTS_VERSION,
      ttsEngine: DEFAULT_TTS_ENGINE
    };
    if (!result.chatterboxVoice) updates.chatterboxVoice = CHATTERBOX_DEFAULT_VOICE;
    if (!result.indexTtsEndpoint) updates.indexTtsEndpoint = INDEXTTS_DEFAULT_ENDPOINT;
    chrome.storage.local.set(updates);
    return { ...result, ...updates };
  }

  function applyFalDefaultsMigration(result) {
    if (result.sidekickFalDefaultsVersion === FAL_DEFAULTS_VERSION) return result;

    const updates = {
      sidekickFalDefaultsVersion: FAL_DEFAULTS_VERSION
    };
    if (!result.falModel || PREVIOUS_FAL_DEFAULT_MODELS.includes(result.falModel)) {
      updates.falModel = PROVIDERS.fal.defaultModel;
    }
    chrome.storage.local.set(updates);
    return { ...result, ...updates };
  }

  // ─── Load saved settings ────────────────────────────────────────────
  chrome.storage.local.get(
    ['provider', 'apiKey', 'model', 'openaiApiKey', 'openaiModel', 'falApiKey', 'falModel', 'geminiApiKey', 'geminiModel', 'deepseekApiKey', 'deepseekModel', 'codexModel', 'codexEndpoint', 'localModel', 'localEndpoint',
     'maxContext', 'fontFamily', 'commands', 'theme', 'chatAppearance', 'customSystemPrompt', 'userMemory',
     'ttsEngine', 'localTtsVoice', 'kokoroEndpoint', 'kokoroVoice', 'indexTtsEndpoint', 'chatterboxVoice', 'allowExperimentalIndexTtsArticleVoice', 'elevenLabsApiKey', 'elevenLabsVoice', 'elevenLabsModel', 'useDefaultVoice', 'sidekickAudioDefaultsVersion',
     'autoDownloadGeneratedAudio', 'generatedAudioFolder', 'autoSubmitCommandOnStart', 'startupCommand',
     'autoSaveConversations', 'showFloatingButton', 'sidekickFalDefaultsVersion', 'webSearchEnabled', 'webSearchPreviousSelection'],
    (storedResult) => {
      const result = applyFalDefaultsMigration(applyAudioDefaultsMigration(storedResult));
      savedKeys.anthropic = result.apiKey || '';
      savedKeys.openai = result.openaiApiKey || '';
      savedKeys.fal = result.falApiKey || '';
      savedKeys.gemini = result.geminiApiKey || '';
      savedKeys.deepseek = result.deepseekApiKey || '';
      savedModels.anthropic = result.model || '';
      savedModels.openai = result.openaiModel || '';
      savedModels.fal = result.falModel || '';
      savedModels.gemini = result.geminiModel || '';
      savedModels.deepseek = result.deepseekModel || '';
      savedModels.codex = result.codexModel || '';
      savedModels.local = result.localModel || '';
      savedEndpoints.codex = result.codexEndpoint || CODEX_DEFAULT_ENDPOINT;
      savedEndpoints.local = result.localEndpoint || LOCAL_DEFAULT_ENDPOINT;
      providerSelect.value = isVisibleProvider(result.provider) ? result.provider : 'anthropic';
      applyProvider(providerSelect.value);
      refreshModelCatalog(false);
      if (result.maxContext) maxContextInput.value = result.maxContext;
      if (result.customSystemPrompt) customSystemPromptInput.value = result.customSystemPrompt;
      if (Array.isArray(result.userMemory)) userMemoryInput.value = result.userMemory.join('\n');
      if (result.theme) {
        const radio = document.querySelector(`input[name="theme"][value="${result.theme}"]`);
        if (radio) radio.checked = true;
      }
      const appearanceRadio = document.querySelector(`input[name="chatAppearance"][value="${result.chatAppearance || 'glass'}"]`);
      if (appearanceRadio) appearanceRadio.checked = true;
      if (result.fontFamily) {
        const radio = document.querySelector(`input[name="fontFamily"][value="${result.fontFamily}"]`);
        if (radio) radio.checked = true;
      }
      commands = getInitialCommands(result.commands);
      autoSubmitCommandCheckbox.checked = result.autoSubmitCommandOnStart === true;
      startupCommand = typeof result.startupCommand === 'string' ? result.startupCommand : 'tldr';
      renderCommands();

      // Default voice toggle
      useDefaultVoiceCheckbox.checked = !!result.useDefaultVoice;

      // Keep generated local audio by default unless disabled.
      autoDownloadGeneratedAudioCheckbox.checked = result.autoDownloadGeneratedAudio !== false;
      generatedAudioFolderInput.value = result.generatedAudioFolder || '';
      syncGeneratedAudioFolder();
      allowExperimentalIndexTtsArticleVoiceCheckbox.checked = result.allowExperimentalIndexTtsArticleVoice === true;

      // Keep existing installs on the previous auto-save behavior unless disabled.
      autoSaveConversationsCheckbox.checked = result.autoSaveConversations !== false;

      // Floating button toggle
      showFloatingButtonCheckbox.checked = !!result.showFloatingButton;
      syncWebSearchToggle(result.webSearchEnabled);
      applyProvider(providerSelect.value);

      // TTS settings
      ttsEngineSelect.value = visibleTtsEngine(result.ttsEngine);
      kokoroEndpointInput.value = result.kokoroEndpoint || KOKORO_DEFAULT_ENDPOINT;
      kokoroVoiceSelect.value = result.kokoroVoice || KOKORO_DEFAULT_VOICE;
      indexTtsEndpointInput.value = result.indexTtsEndpoint || INDEXTTS_DEFAULT_ENDPOINT;
      renderChatterboxVoiceOptions(CHATTERBOX_FALLBACK_VOICES, result.chatterboxVoice || CHATTERBOX_DEFAULT_VOICE);
      if (result.elevenLabsApiKey) elevenLabsApiKeyInput.value = result.elevenLabsApiKey;
      if (result.elevenLabsModel) elevenLabsModelSelect.value = result.elevenLabsModel;
      updateTtsVisibility();
      populateLocalVoices(result.localTtsVoice || '');
      loadKokoroVoices(kokoroEndpointInput.value, result.kokoroVoice || KOKORO_DEFAULT_VOICE);
      if (ttsEngineSelect.value === 'chatterbox' || ttsEngineSelect.value === VOICEBOX_LAB_ENGINE) {
        loadChatterboxVoices(indexTtsEndpointInput.value, result.chatterboxVoice || CHATTERBOX_DEFAULT_VOICE, true);
      }
      if (result.elevenLabsApiKey) {
        loadElevenLabsVoices(result.elevenLabsApiKey, result.elevenLabsVoice || '');
      }
    }
  );


  // ─── Auto-save on change ────────────────────────────────────────────
  function save(key, value, onSaved) {
    chrome.storage.local.set({ [key]: value }, () => {
      showStatus('Saved');
      if (onSaved) onSaved();
    });
  }

  providerSelect.addEventListener('change', () => {
    save('provider', providerSelect.value);
    applyProvider(providerSelect.value);
    refreshModelCatalog(false);
    if (webSearchEnabledCheckbox.checked && !SidekickProviders.modelSupportsWebSearch(providerSelect.value, modelSelect.value)) {
      webSearchEnabledCheckbox.checked = false;
      save('webSearchEnabled', false);
      applyProvider(providerSelect.value);
    }
  });

  apiKeyInput.addEventListener('change', () => {
    if (!PROVIDERS[currentProvider].apiKeyStorageKey) return;
    const value = apiKeyInput.value.trim();
    savedKeys[currentProvider] = value;
    save(PROVIDERS[currentProvider].apiKeyStorageKey, value, () => {
      refreshModelCatalog(true);
      chrome.storage.local.get(['webSearchEnabled'], (result) => {
        syncWebSearchToggle(result.webSearchEnabled);
        applyProvider(currentProvider);
      });
    });
  });

  localEndpointInput.addEventListener('change', () => {
    if (!PROVIDERS[currentProvider].endpointStorageKey) return;
    const value = localEndpointInput.value.trim() || PROVIDERS[currentProvider].defaultEndpoint || LOCAL_DEFAULT_ENDPOINT;
    savedEndpoints[currentProvider] = value;
    localEndpointInput.value = value;
    save(PROVIDERS[currentProvider].endpointStorageKey, value, () => refreshModelCatalog(true));
  });

  modelSelect.addEventListener('change', () => {
    savedModels[currentProvider] = modelSelect.value;
    save(PROVIDERS[currentProvider].modelStorageKey, modelSelect.value);
  });

  refreshModelsBtn.addEventListener('click', () => refreshModelCatalog(true));

  function refreshModelCatalog(forceRefresh) {
    if (!refreshModelsBtn || typeof chrome === 'undefined') return;

    refreshModelsBtn.disabled = true;
    refreshModelsBtn.textContent = 'Refreshing...';

    chrome.runtime.sendMessage({ action: 'getModelCatalog', forceRefresh }, (response) => {
      refreshModelsBtn.disabled = currentProvider === 'codex';
      refreshModelsBtn.textContent = 'Refresh';

      if (chrome.runtime.lastError) {
        showStatus('Model refresh failed');
        updateModelHint(getProviderModelConfig(currentProvider));
        return;
      }

      if (response?.catalog) {
        providerModelConfigs = SidekickProviders.getProviderModelConfig(response.catalog);
        applyProvider(currentProvider);
        if (forceRefresh) showStatus(response.ok ? 'Models refreshed' : 'Using fallback models');
      } else if (forceRefresh) {
        showStatus('Model refresh failed');
      }
    });
  }
  maxContextInput.addEventListener('change', () => save('maxContext', parseInt(maxContextInput.value) || 60000));
  customSystemPromptInput.addEventListener('change', () => save('customSystemPrompt', customSystemPromptInput.value.trim()));
  userMemoryInput.addEventListener('change', () => save('userMemory', parseMemoryLines(userMemoryInput.value)));

  themeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) save('theme', radio.value);
    });
  });

  chatAppearanceRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) save('chatAppearance', radio.value);
    });
  });

  fontRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) save('fontFamily', radio.value);
    });
  });

  useDefaultVoiceCheckbox.addEventListener('change', () => save('useDefaultVoice', useDefaultVoiceCheckbox.checked));
  autoDownloadGeneratedAudioCheckbox.addEventListener('change', () => {
    save('autoDownloadGeneratedAudio', autoDownloadGeneratedAudioCheckbox.checked);
    syncGeneratedAudioFolder();
  });

  function syncGeneratedAudioFolder() {
    generatedAudioFolderGroup.classList.toggle('is-muted', !autoDownloadGeneratedAudioCheckbox.checked);
  }

  // Mirrors normalizeDownloadFolder() in tts.js so the field shows the path that will be used.
  function normalizeDownloadFolder(folder) {
    return String(folder || '')
      .replace(/\\/g, '/')
      .split('/')
      .map(part => part.trim().replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^(\.+|~)$/, ''))
      .filter(Boolean)
      .filter((part, index) => !(index === 0 && /^downloads$/i.test(part)))
      .join('/');
  }

  generatedAudioFolderInput.addEventListener('change', () => {
    const folder = normalizeDownloadFolder(generatedAudioFolderInput.value);
    generatedAudioFolderInput.value = folder;
    save('generatedAudioFolder', folder);
  });
  allowExperimentalIndexTtsArticleVoiceCheckbox.addEventListener('change', () => save('allowExperimentalIndexTtsArticleVoice', allowExperimentalIndexTtsArticleVoiceCheckbox.checked));
  autoSaveConversationsCheckbox.addEventListener('change', () => save('autoSaveConversations', autoSaveConversationsCheckbox.checked));
  showFloatingButtonCheckbox.addEventListener('change', () => save('showFloatingButton', showFloatingButtonCheckbox.checked));
  autoSubmitCommandCheckbox.addEventListener('change', () => {
    save('autoSubmitCommandOnStart', autoSubmitCommandCheckbox.checked);
    renderStartupCommand();
  });
  startupCommandSelect.addEventListener('change', () => {
    startupCommand = startupCommandSelect.value;
    save('startupCommand', startupCommand);
  });
  webSearchEnabledCheckbox.addEventListener('change', () => {
    if (webSearchEnabledCheckbox.checked && !hasStoredFalKey()) {
      webSearchEnabledCheckbox.checked = false;
      showStatus('Add a Fal.ai key to use web search');
      return;
    }

    const turningOn = webSearchEnabledCheckbox.checked;
    const updates = { webSearchEnabled: turningOn };
    const previousKey = SidekickProviders.WEB_SEARCH_PREVIOUS_SELECTION_KEY;

    if (turningOn && !SidekickProviders.modelSupportsWebSearch(currentProvider, modelSelect.value)) {
      updates[previousKey] = {
        providerId: currentProvider,
        model: modelSelect.value
      };
      updates.provider = SidekickProviders.WEB_SEARCH_DEFAULT_PROVIDER;
      updates.falModel = SidekickProviders.WEB_SEARCH_DEFAULT_MODEL;
      savedModels.fal = updates.falModel;
      providerSelect.value = updates.provider;
    } else if (!turningOn) {
      chrome.storage.local.get([previousKey], (stored) => {
        const previous = stored[previousKey];
        const restore = { webSearchEnabled: false, [previousKey]: null };
        if (previous?.providerId && previous?.model && PROVIDERS[previous.providerId]) {
          restore.provider = previous.providerId;
          restore[PROVIDERS[previous.providerId].modelStorageKey] = previous.model;
          savedModels[previous.providerId] = previous.model;
          providerSelect.value = previous.providerId;
        }
        chrome.storage.local.set(restore, () => {
          showStatus('Saved');
          applyProvider(providerSelect.value);
        });
      });
      return;
    }

    chrome.storage.local.set(updates, () => {
      showStatus('Saved');
      applyProvider(providerSelect.value);
    });
  });

  // ─── API key visibility toggle ──────────────────────────────────────
  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.querySelector('.eye-icon').style.display = isPassword ? 'none' : 'block';
    toggleApiKeyBtn.querySelector('.eye-off-icon').style.display = isPassword ? 'block' : 'none';
  });

  // ─── Commands ───────────────────────────────────────────────────────
  function getInitialCommands(storedCommands) {
    const nextCommands = SidekickPrompts.getInitialCommands(storedCommands);
    if (storedCommands && SidekickPrompts.shouldMigrateDefaultCommands(storedCommands)) {
      chrome.storage.local.set({ commands: nextCommands });
    }
    return nextCommands;
  }

  function renderStartupCommand() {
    startupCommandSelect.replaceChildren();
    if (!commands.some(command => command.name === startupCommand)) {
      const missing = new Option(`/${startupCommand} (unavailable — choose a command)`, startupCommand);
      missing.disabled = true;
      startupCommandSelect.add(missing);
    }
    for (const command of commands) {
      startupCommandSelect.add(new Option(`/${command.name}`, command.name));
    }
    startupCommandSelect.value = startupCommand;
    startupCommandSelect.disabled = !autoSubmitCommandCheckbox.checked || commands.length === 0;
  }

  function renderCommands() {
    renderStartupCommand();
    if (commands.length === 0) {
      commandsList.innerHTML = '<p style="color:#6b6b6b;font-size:13px;">No commands yet. Add one to get started.</p>';
      return;
    }

    commandsList.innerHTML = commands.map((cmd, i) => `
      <div class="command-item">
        <div class="command-info">
          <div class="command-name">/${escapeHtml(cmd.name)}</div>
          <div class="command-prompt">${escapeHtml(cmd.prompt)}</div>
        </div>
        <div class="command-actions">
          <label class="toggle-switch" title="Show on empty chat">
            <input type="checkbox" class="welcome-cmd" data-index="${i}" ${cmd.showInEmptyState !== false ? 'checked' : ''} aria-label="Show /${escapeHtml(cmd.name)} on empty chat">
            <span class="toggle-slider"></span>
          </label>
          <button class="edit-cmd" data-index="${i}">Edit</button>
          <button class="delete-cmd" data-index="${i}">Delete</button>
        </div>
      </div>
    `).join('');

    // Edit buttons
    commandsList.querySelectorAll('.edit-cmd').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        editingIndex = idx;
        commandNameInput.value = commands[idx].name;
        commandPromptInput.value = commands[idx].prompt;
        commandForm.style.display = 'block';
        addCommandBtn.style.display = 'none';
        commandNameInput.focus();
      });
    });

    // Delete buttons
    commandsList.querySelectorAll('.delete-cmd').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        commands.splice(idx, 1);
        saveCommands();
        renderCommands();
      });
    });

    commandsList.querySelectorAll('.welcome-cmd').forEach(input => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.index);
        commands[idx] = SidekickPrompts.normalizeCommand(commands[idx], {
          showInEmptyState: input.checked
        });
        saveCommands();
      });
    });
  }

  function saveCommands() {
    chrome.storage.local.set({ commands, startupCommand }, () => showStatus('Saved'));
  }

  addCommandBtn.addEventListener('click', () => {
    editingIndex = -1;
    commandNameInput.value = '';
    commandPromptInput.value = '';
    commandForm.style.display = 'block';
    addCommandBtn.style.display = 'none';
    commandNameInput.focus();
  });

  saveCommandBtn.addEventListener('click', () => {
    const name = commandNameInput.value.trim().replace(/^\//, '').toLowerCase();
    const prompt = commandPromptInput.value.trim();

    if (!name || !prompt) return;

    if (editingIndex >= 0) {
      if (commands[editingIndex].name === startupCommand) startupCommand = name;
      commands[editingIndex] = SidekickPrompts.normalizeCommand({
        name,
        prompt,
        showInEmptyState: commands[editingIndex].showInEmptyState
      });
    } else {
      // Check for duplicate name
      const existing = commands.findIndex(c => c.name.toLowerCase() === name);
      if (existing >= 0) {
        commands[existing] = SidekickPrompts.normalizeCommand({
          name,
          prompt,
          showInEmptyState: commands[existing].showInEmptyState
        });
      } else {
        commands.push(SidekickPrompts.normalizeCommand({ name, prompt }, { showInEmptyState: false }));
      }
    }

    saveCommands();
    renderCommands();
    commandForm.style.display = 'none';
    addCommandBtn.style.display = 'inline-flex';
  });

  cancelCommandBtn.addEventListener('click', () => {
    commandForm.style.display = 'none';
    addCommandBtn.style.display = 'inline-flex';
  });

  // ─── TTS Settings ─────────────────────────────────────────────────
  ttsEngineSelect.addEventListener('change', () => {
    save('ttsEngine', ttsEngineSelect.value);
    updateTtsVisibility();
    if (ttsEngineSelect.value === 'chatterbox' || ttsEngineSelect.value === VOICEBOX_LAB_ENGINE) {
      loadChatterboxVoices(indexTtsEndpointInput.value, chatterboxVoiceSelect.value || CHATTERBOX_DEFAULT_VOICE, false);
    }
  });

  function updateTtsVisibility() {
    const engine = ttsEngineSelect.value;
    localTtsSettings.style.display = engine === 'local' ? 'block' : 'none';
    kokoroTtsSettings.style.display = engine === 'kokoro' ? 'block' : 'none';
    chatterboxTtsSettings.style.display = (engine === 'chatterbox' || engine === VOICEBOX_LAB_ENGINE) ? 'block' : 'none';
    elevenLabsTtsSettings.style.display = engine === 'elevenlabs' ? 'block' : 'none';
  }

  // Populate browser voices (grouped by language, English first)
  function populateLocalVoices(selectedVoice) {
    if (!window.speechSynthesis) {
      localTtsVoiceSelect.innerHTML = '<option value="">Not supported in this browser</option>';
      return;
    }

    function fillVoices() {
      const voices = speechSynthesis.getVoices();
      if (voices.length === 0) return;

      // Group by language
      const english = voices.filter(v => v.lang.startsWith('en'));
      const other = voices.filter(v => !v.lang.startsWith('en'));

      let html = '<option value="">System Default</option>';
      if (english.length > 0) {
        html += '<optgroup label="English">';
        english.forEach(v => {
          const selected = v.name === selectedVoice ? ' selected' : '';
          html += `<option value="${escapeHtml(v.name)}"${selected}>${escapeHtml(v.name)} (${v.lang})</option>`;
        });
        html += '</optgroup>';
      }
      if (other.length > 0) {
        html += '<optgroup label="Other Languages">';
        other.forEach(v => {
          const selected = v.name === selectedVoice ? ' selected' : '';
          html += `<option value="${escapeHtml(v.name)}"${selected}>${escapeHtml(v.name)} (${v.lang})</option>`;
        });
        html += '</optgroup>';
      }
      localTtsVoiceSelect.innerHTML = html;
    }

    // Chrome loads voices async
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      fillVoices();
    } else {
      speechSynthesis.addEventListener('voiceschanged', fillVoices, { once: true });
    }
  }

  localTtsVoiceSelect.addEventListener('change', () => {
    save('localTtsVoice', localTtsVoiceSelect.value);
  });

  function normalizeLocalSpeechEndpoint(endpoint, defaultEndpoint) {
    const raw = (endpoint || defaultEndpoint).trim().replace(/\/+$/, '');
    if (!raw) return defaultEndpoint;
    return raw
      .replace(/\/config$/, '')
      .replace(/\/download$/, '')
      .replace(/\/stream$/, '');
  }

  function normalizeKokoroEndpoint(endpoint) {
    return normalizeLocalSpeechEndpoint(endpoint, KOKORO_DEFAULT_ENDPOINT);
  }

  function normalizeIndexTtsEndpoint(endpoint) {
    return normalizeLocalSpeechEndpoint(endpoint, INDEXTTS_DEFAULT_ENDPOINT);
  }

  function formatKokoroVoiceLabel(voice) {
    const parts = voice.split('_');
    if (parts.length === 2 && parts[1]) {
      return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }
    return voice;
  }

  function kokoroVoiceLanguage(voice) {
    return KOKORO_LANG[voice[0]] || 'Other';
  }

  function formatIndexTtsVoiceLabel(id) {
    return String(id || '')
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'IndexTTS Voice';
  }

  function normalizeIndexTtsVoiceEntry(entry) {
    if (typeof entry === 'string') {
      const group = entry === CHATTERBOX_DEFAULT_VOICE ? 'Default' : 'Cloned voices';
      return {
        id: entry,
        name: formatIndexTtsVoiceLabel(entry),
        group,
        articleSafe: group === 'Default',
        quality: group === 'Default' ? 'benchmarked' : 'clone'
      };
    }
    const id = entry?.id || entry?.voice || entry?.value;
    if (!id) return null;
    const group = entry.group || entry.status || (id === CHATTERBOX_DEFAULT_VOICE ? 'Default' : 'Cloned voices');
    const articleSafe = typeof entry.article_ok === 'boolean'
      ? entry.article_ok
      : (typeof entry.article_safe === 'boolean'
        ? entry.article_safe
        : (typeof entry.articleSafe === 'boolean' ? entry.articleSafe : group === 'Default'));
    return {
      id,
      name: entry.name || entry.display_name || entry.label || formatIndexTtsVoiceLabel(id),
      group,
      articleSafe,
      articleOk: articleSafe,
      shortClipOk: typeof entry.short_clip_ok === 'boolean' ? entry.short_clip_ok : true,
      maxArticleChars: Number.isInteger(entry.max_article_chars) ? entry.max_article_chars : null,
      quality: entry.quality || (articleSafe ? 'article-tested' : 'experimental'),
      benchmarkDate: entry.benchmark_date || '',
      notes: entry.notes || ''
    };
  }

  async function loadKokoroVoices(serverUrl, selectedVoice) {
    kokoroVoiceSelect.innerHTML = '<option value="">Loading voices...</option>';
    const endpoint = normalizeKokoroEndpoint(serverUrl);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsConfig',
        endpoint: `${endpoint}/config`
      });
      if (!response?.ok) throw new Error(response?.error || 'Failed to load voices');
      const voices = Array.isArray(response.config?.voices) ? response.config.voices : [];
      if (!voices.length) throw new Error('No voices returned');

      const groups = new Map();
      for (const voice of [...voices].sort()) {
        const lang = kokoroVoiceLanguage(voice);
        if (!groups.has(lang)) groups.set(lang, []);
        groups.get(lang).push(voice);
      }

      let html = '';
      for (const [label, list] of groups) {
        html += `<optgroup label="${escapeHtml(label)}">`;
        list.forEach(voice => {
          const selected = voice === selectedVoice ? ' selected' : '';
          html += `<option value="${escapeHtml(voice)}"${selected}>${escapeHtml(formatKokoroVoiceLabel(voice))}</option>`;
        });
        html += '</optgroup>';
      }
      kokoroVoiceSelect.innerHTML = html;
    } catch (e) {
      const selected = selectedVoice || KOKORO_DEFAULT_VOICE;
      kokoroVoiceSelect.innerHTML = `<option value="${escapeHtml(selected)}">${escapeHtml(formatKokoroVoiceLabel(selected))}</option>`;
      console.error('Kokoro voice fetch error:', e);
      showStatus(e.message || 'Could not load Kokoro voices');
    }
  }

  kokoroEndpointInput.addEventListener('change', () => {
    const endpoint = normalizeKokoroEndpoint(kokoroEndpointInput.value);
    kokoroEndpointInput.value = endpoint;
    save('kokoroEndpoint', endpoint);
    loadKokoroVoices(endpoint, kokoroVoiceSelect.value || KOKORO_DEFAULT_VOICE);
  });

  kokoroVoiceSelect.addEventListener('change', () => {
    save('kokoroVoice', kokoroVoiceSelect.value);
  });

  refreshKokoroBtn.addEventListener('click', () => {
    loadKokoroVoices(kokoroEndpointInput.value, kokoroVoiceSelect.value || KOKORO_DEFAULT_VOICE);
  });

  indexTtsEndpointInput.addEventListener('change', () => {
    const endpoint = normalizeIndexTtsEndpoint(indexTtsEndpointInput.value);
    indexTtsEndpointInput.value = endpoint;
    save('indexTtsEndpoint', endpoint);
    loadChatterboxVoices(endpoint, chatterboxVoiceSelect.value || CHATTERBOX_DEFAULT_VOICE, true);
  });

  function renderChatterboxVoiceOptions(voices, selectedVoice) {
    const normalized = voices.map(normalizeIndexTtsVoiceEntry).filter(Boolean);
    const groups = new Map();
    for (const voice of normalized) {
      const label = voice.group || 'Cloned voices';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(voice);
    }

    let html = '';
    for (const [label, list] of groups) {
      html += `<optgroup label="${escapeHtml(label)}">`;
      list.forEach(voice => {
        const selected = voice.id === selectedVoice ? ' selected' : '';
        const suffix = voice.articleSafe ? '' : ' - experimental';
        const idLabel = voice.id === 'default' ? '' : ` (${voice.id})`;
        html += `<option value="${escapeHtml(voice.id)}"${selected}>${escapeHtml(`${voice.name}${idLabel}${suffix}`)}</option>`;
      });
      html += '</optgroup>';
    }
    chatterboxVoiceSelect.innerHTML = html || `<option value="${CHATTERBOX_DEFAULT_VOICE}">Chatterbox</option>`;
  }

  async function loadChatterboxVoices(serverUrl, selectedVoice, showErrors = false) {
    chatterboxVoiceSelect.innerHTML = '<option value="">Loading voices...</option>';
    const endpoint = normalizeIndexTtsEndpoint(serverUrl);
    try {
      const configKey = ttsEngineSelect.value === VOICEBOX_LAB_ENGINE ? 'voicebox' : 'chatterbox';
      const serviceName = ttsEngineSelect.value === VOICEBOX_LAB_ENGINE ? 'Voicebox' : 'Chatterbox';
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsConfig',
        endpoint: `${endpoint}/config`,
        serviceName
      });
      if (!response?.ok) throw new Error(response?.error || `Failed to load ${serviceName} voices`);
      const engineConfig = response.config?.[configKey] || (configKey === 'voicebox' ? response.config?.voicebox_lab : null);
      const voices = Array.isArray(engineConfig?.voices) ? engineConfig.voices : [];
      if (!voices.length) throw new Error(`No ${serviceName} voices returned`);
      renderChatterboxVoiceOptions(voices, selectedVoice || engineConfig?.default_voice || CHATTERBOX_DEFAULT_VOICE);
    } catch (e) {
      renderChatterboxVoiceOptions(CHATTERBOX_FALLBACK_VOICES, selectedVoice || CHATTERBOX_DEFAULT_VOICE);
      console.error('Bridge voice fetch error:', e);
      if (showErrors) showStatus(e.message || 'Could not load bridge voices');
    }
  }

  chatterboxVoiceSelect.addEventListener('change', () => {
    save('chatterboxVoice', chatterboxVoiceSelect.value);
  });

  refreshChatterboxBtn.addEventListener('click', () => {
    loadChatterboxVoices(indexTtsEndpointInput.value, chatterboxVoiceSelect.value || CHATTERBOX_DEFAULT_VOICE, true);
  });

  // Test local voice
  testLocalVoiceBtn.addEventListener('click', () => {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance('Hello! This is a test of the selected voice.');
    const voiceName = localTtsVoiceSelect.value;
    if (voiceName) {
      const voices = speechSynthesis.getVoices();
      const match = voices.find(v => v.name === voiceName);
      if (match) utterance.voice = match;
    }
    speechSynthesis.speak(utterance);
  });

  testKokoroBtn.addEventListener('click', async () => {
    const endpoint = normalizeKokoroEndpoint(kokoroEndpointInput.value);
    kokoroEndpointInput.value = endpoint;
    const voice = kokoroVoiceSelect.value || KOKORO_DEFAULT_VOICE;

    testKokoroBtn.textContent = 'Testing...';
    testKokoroBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsSpeech',
        endpoint: `${endpoint}/download`,
        body: {
          text: 'Hello! This is a test of the selected Kokoro voice.',
          voice,
          title: 'Sidekick voice test'
        }
      });
      if (!response?.ok) throw new Error(response?.error || 'Local Kokoro speech failed');
      await chrome.storage.local.set({
        kokoroEndpoint: endpoint,
        kokoroVoice: voice
      });
      const audio = new Audio(response.dataUrl);
      audio.play();
      showStatus('Kokoro voice test started');
    } catch (e) {
      showStatus('Kokoro test failed: ' + e.message);
    } finally {
      testKokoroBtn.textContent = 'Test';
      testKokoroBtn.disabled = false;
    }
  });

  testChatterboxBtn.addEventListener('click', async () => {
    const endpoint = normalizeIndexTtsEndpoint(indexTtsEndpointInput.value);
    indexTtsEndpointInput.value = endpoint;
    const voice = chatterboxVoiceSelect.value || CHATTERBOX_DEFAULT_VOICE;
    const engine = ttsEngineSelect.value === VOICEBOX_LAB_ENGINE ? VOICEBOX_LAB_ENGINE : 'chatterbox';
    const serviceName = engine === VOICEBOX_LAB_ENGINE ? 'Voicebox' : 'Chatterbox';

    testChatterboxBtn.textContent = 'Testing...';
    testChatterboxBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsSpeech',
        endpoint: `${endpoint}/download`,
        serviceName,
        body: {
          text: 'A useful assistant should keep the original page in view, make the structure easier to hear, and avoid skipping important ideas.',
          engine,
          voice,
          title: 'Sidekick voice test'
        }
      });
      if (!response?.ok) throw new Error(response?.error || `Local ${serviceName} speech failed`);
      await chrome.storage.local.set({
        indexTtsEndpoint: endpoint,
        chatterboxVoice: voice
      });
      const audio = new Audio(response.dataUrl);
      audio.play();
      showStatus(`${serviceName} voice test started`);
    } catch (e) {
      showStatus(`${serviceName} test failed: ` + e.message);
    } finally {
      testChatterboxBtn.textContent = 'Test';
      testChatterboxBtn.disabled = false;
    }
  });

  // ElevenLabs API key
  elevenLabsApiKeyInput.addEventListener('change', () => {
    const key = elevenLabsApiKeyInput.value.trim();
    save('elevenLabsApiKey', key);
    if (key) loadElevenLabsVoices(key, '');
  });

  // Toggle ElevenLabs key visibility
  toggleElevenLabsKeyBtn.addEventListener('click', () => {
    const isPassword = elevenLabsApiKeyInput.type === 'password';
    elevenLabsApiKeyInput.type = isPassword ? 'text' : 'password';
    toggleElevenLabsKeyBtn.querySelector('.eye-icon').style.display = isPassword ? 'none' : 'block';
    toggleElevenLabsKeyBtn.querySelector('.eye-off-icon').style.display = isPassword ? 'block' : 'none';
  });

  // Load ElevenLabs voices from API
  async function loadElevenLabsVoices(apiKey, selectedVoice) {
    elevenLabsVoiceSelect.innerHTML = '<option value="">Loading voices...</option>';
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey }
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      const voices = data.voices || [];

      if (voices.length === 0) {
        elevenLabsVoiceSelect.innerHTML = '<option value="">No voices found</option>';
        return;
      }

      let html = '<option value="">Select a voice</option>';
      voices.forEach(v => {
        const selected = v.voice_id === selectedVoice ? ' selected' : '';
        const labels = v.labels ? Object.values(v.labels).join(', ') : '';
        html += `<option value="${v.voice_id}"${selected}>${escapeHtml(v.name)}${labels ? ' (' + escapeHtml(labels) + ')' : ''}</option>`;
      });
      elevenLabsVoiceSelect.innerHTML = html;
    } catch (e) {
      elevenLabsVoiceSelect.innerHTML = '<option value="">Failed to load voices</option>';
      console.error('ElevenLabs voice fetch error:', e);
    }
  }

  elevenLabsVoiceSelect.addEventListener('change', () => {
    save('elevenLabsVoice', elevenLabsVoiceSelect.value);
  });

  elevenLabsModelSelect.addEventListener('change', () => {
    save('elevenLabsModel', elevenLabsModelSelect.value);
  });

  refreshElevenLabsBtn.addEventListener('click', () => {
    const key = elevenLabsApiKeyInput.value.trim();
    if (key) loadElevenLabsVoices(key, elevenLabsVoiceSelect.value);
  });

  // Test ElevenLabs voice
  testElevenLabsBtn.addEventListener('click', async () => {
    const apiKey = elevenLabsApiKeyInput.value.trim();
    const voiceId = elevenLabsVoiceSelect.value;
    if (!apiKey || !voiceId) {
      showStatus('Enter API key and select a voice first');
      return;
    }
    testElevenLabsBtn.textContent = 'Testing...';
    testElevenLabsBtn.disabled = true;
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({
          text: 'Hello! This is a test of the selected voice.',
          model_id: elevenLabsModelSelect.value || 'eleven_flash_v2_5'
        })
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    } catch (e) {
      showStatus('Voice test failed: ' + e.message);
    } finally {
      testElevenLabsBtn.textContent = 'Test';
      testElevenLabsBtn.disabled = false;
    }
  });

  // ─── Export / Import ────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['provider', 'fontFamily', 'maxContext', 'model', 'openaiModel', 'falModel', 'geminiModel', 'deepseekModel', 'codexModel', 'codexEndpoint', 'localModel', 'localEndpoint', 'ttsEngine', 'localTtsVoice', 'kokoroEndpoint', 'kokoroVoice', 'indexTtsEndpoint', 'chatterboxVoice', 'allowExperimentalIndexTtsArticleVoice', 'autoDownloadGeneratedAudio', 'generatedAudioFolder', 'elevenLabsModel', 'autoSaveConversations', 'commands', 'theme', 'chatAppearance', 'customSystemPrompt', 'userMemory', 'showFloatingButton', 'webSearchEnabled', 'autoSubmitCommandOnStart', 'startupCommand'], (result) => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: {
          provider: result.provider || 'anthropic',
          fontFamily: result.fontFamily || 'system-ui',
          maxContext: result.maxContext || 60000,
          model: result.model || PROVIDERS.anthropic.defaultModel,
          openaiModel: result.openaiModel || PROVIDERS.openai.defaultModel,
          falModel: result.falModel || PROVIDERS.fal.defaultModel,
          geminiModel: result.geminiModel || PROVIDERS.gemini.defaultModel,
          deepseekModel: result.deepseekModel || PROVIDERS.deepseek.defaultModel,
          codexModel: result.codexModel || PROVIDERS.codex.defaultModel,
          codexEndpoint: result.codexEndpoint || CODEX_DEFAULT_ENDPOINT,
          localModel: result.localModel || PROVIDERS.local.defaultModel,
          localEndpoint: result.localEndpoint || LOCAL_DEFAULT_ENDPOINT,
          ttsEngine: result.ttsEngine || DEFAULT_TTS_ENGINE,
          localTtsVoice: result.localTtsVoice || '',
          kokoroEndpoint: result.kokoroEndpoint || KOKORO_DEFAULT_ENDPOINT,
          kokoroVoice: result.kokoroVoice || KOKORO_DEFAULT_VOICE,
          indexTtsEndpoint: result.indexTtsEndpoint || INDEXTTS_DEFAULT_ENDPOINT,
          chatterboxVoice: result.chatterboxVoice || CHATTERBOX_DEFAULT_VOICE,
          allowExperimentalIndexTtsArticleVoice: result.allowExperimentalIndexTtsArticleVoice === true,
          autoDownloadGeneratedAudio: result.autoDownloadGeneratedAudio !== false,
          generatedAudioFolder: result.generatedAudioFolder || '',
          elevenLabsModel: result.elevenLabsModel || 'eleven_flash_v2_5',
          autoSaveConversations: result.autoSaveConversations !== false,
          autoSubmitCommandOnStart: result.autoSubmitCommandOnStart === true,
          startupCommand: typeof result.startupCommand === 'string' ? result.startupCommand : 'tldr',
          theme: result.theme || 'auto',
          chatAppearance: result.chatAppearance || 'glass',
          customSystemPrompt: result.customSystemPrompt || '',
          userMemory: Array.isArray(result.userMemory) ? result.userMemory : [],
          showFloatingButton: !!result.showFloatingButton,
          webSearchEnabled: result.webSearchEnabled !== false
        },
        commands: result.commands || []
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sidekick-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('Settings exported (API keys excluded)');
    });
  });

  importBtn.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);

        if (!data.version || !data.settings) {
          showStatus('Invalid settings file');
          return;
        }

        // Apply settings
        const updates = {};
        if (data.settings.provider) updates.provider = data.settings.provider;
        // Only the fonts offered in Settings; the value is written into a stylesheet.
        const allowedFonts = [...document.querySelectorAll('input[name="fontFamily"]')].map(input => input.value);
        if (allowedFonts.includes(data.settings.fontFamily)) updates.fontFamily = data.settings.fontFamily;
        if (data.settings.maxContext) updates.maxContext = data.settings.maxContext;
        if (data.settings.model) updates.model = data.settings.model;
        if (data.settings.openaiModel) updates.openaiModel = data.settings.openaiModel;
        if (data.settings.falModel) updates.falModel = data.settings.falModel;
        if (data.settings.geminiModel) updates.geminiModel = data.settings.geminiModel;
        if (data.settings.deepseekModel) updates.deepseekModel = data.settings.deepseekModel;
        if (data.settings.codexModel) updates.codexModel = data.settings.codexModel;
        if (data.settings.codexEndpoint) updates.codexEndpoint = data.settings.codexEndpoint;
        if (data.settings.localModel) updates.localModel = data.settings.localModel;
        if (data.settings.localEndpoint) updates.localEndpoint = data.settings.localEndpoint;
        if (data.settings.ttsEngine) updates.ttsEngine = data.settings.ttsEngine;
        if (data.settings.localTtsVoice !== undefined) updates.localTtsVoice = data.settings.localTtsVoice;
        if (data.settings.kokoroEndpoint) updates.kokoroEndpoint = data.settings.kokoroEndpoint;
        if (data.settings.kokoroVoice) updates.kokoroVoice = data.settings.kokoroVoice;
        if (data.settings.indexTtsEndpoint) updates.indexTtsEndpoint = data.settings.indexTtsEndpoint;
        if (data.settings.chatterboxVoice) updates.chatterboxVoice = data.settings.chatterboxVoice;
        if (data.settings.allowExperimentalIndexTtsArticleVoice !== undefined) updates.allowExperimentalIndexTtsArticleVoice = data.settings.allowExperimentalIndexTtsArticleVoice === true;
        if (data.settings.autoDownloadGeneratedAudio !== undefined) updates.autoDownloadGeneratedAudio = data.settings.autoDownloadGeneratedAudio;
        if (data.settings.autoSaveConversations !== undefined) updates.autoSaveConversations = data.settings.autoSaveConversations;
        if (data.settings.theme) updates.theme = data.settings.theme;
        if (data.settings.chatAppearance === 'classic' || data.settings.chatAppearance === 'glass') {
          updates.chatAppearance = data.settings.chatAppearance;
        }
        if (data.settings.customSystemPrompt !== undefined) updates.customSystemPrompt = data.settings.customSystemPrompt;
        if (Array.isArray(data.settings.userMemory)) updates.userMemory = normalizeMemoryList(data.settings.userMemory);
        if (data.settings.showFloatingButton !== undefined) updates.showFloatingButton = data.settings.showFloatingButton;
        if (data.settings.webSearchEnabled !== undefined) updates.webSearchEnabled = data.settings.webSearchEnabled !== false;

        if (typeof data.settings.autoSubmitCommandOnStart === 'boolean') updates.autoSubmitCommandOnStart = data.settings.autoSubmitCommandOnStart;
        if (typeof data.settings.startupCommand === 'string') updates.startupCommand = data.settings.startupCommand;
        if (typeof data.settings.generatedAudioFolder === 'string') updates.generatedAudioFolder = normalizeDownloadFolder(data.settings.generatedAudioFolder);
        if (data.settings.elevenLabsModel === 'eleven_flash_v2_5' || data.settings.elevenLabsModel === 'eleven_multilingual_v2') updates.elevenLabsModel = data.settings.elevenLabsModel;

        // Merge commands (add new, update existing by name)
        if (data.commands && Array.isArray(data.commands)) {
          for (const imported of data.commands) {
            const existing = commands.findIndex(c => c.name === imported.name);
            const nextCommand = SidekickPrompts.normalizeCommand(imported);
            if (existing >= 0) {
              commands[existing] = nextCommand;
            } else {
              commands.push(nextCommand);
            }
          }
          updates.commands = commands;
        }

        chrome.storage.local.set(updates, () => {
          // Refresh UI
          if (updates.theme) {
            const radio = document.querySelector(`input[name="theme"][value="${updates.theme}"]`);
            if (radio) radio.checked = true;
          }
          if (updates.chatAppearance) {
            const radio = document.querySelector(`input[name="chatAppearance"][value="${updates.chatAppearance}"]`);
            if (radio) radio.checked = true;
          }
          if (updates.fontFamily) {
            const radio = document.querySelector(`input[name="fontFamily"][value="${updates.fontFamily}"]`);
            if (radio) radio.checked = true;
          }
          if (updates.maxContext) maxContextInput.value = updates.maxContext;
          // Provider-aware refresh: update caches, then re-apply the active provider
          if (updates.model !== undefined) savedModels.anthropic = updates.model;
          if (updates.openaiModel !== undefined) savedModels.openai = updates.openaiModel;
          if (updates.falModel !== undefined) savedModels.fal = updates.falModel;
          if (updates.geminiModel !== undefined) savedModels.gemini = updates.geminiModel;
          if (updates.deepseekModel !== undefined) savedModels.deepseek = updates.deepseekModel;
          if (updates.codexModel !== undefined) savedModels.codex = updates.codexModel;
          if (updates.codexEndpoint !== undefined) savedEndpoints.codex = updates.codexEndpoint;
          if (updates.localModel !== undefined) savedModels.local = updates.localModel;
          if (updates.localEndpoint !== undefined) savedEndpoints.local = updates.localEndpoint;
          if (updates.ttsEngine) ttsEngineSelect.value = visibleTtsEngine(updates.ttsEngine);
          if (updates.localTtsVoice !== undefined) localTtsVoiceSelect.value = updates.localTtsVoice;
          if (updates.kokoroEndpoint) kokoroEndpointInput.value = updates.kokoroEndpoint;
          if (updates.kokoroVoice) kokoroVoiceSelect.value = updates.kokoroVoice;
          if (updates.indexTtsEndpoint) indexTtsEndpointInput.value = updates.indexTtsEndpoint;
          if (updates.chatterboxVoice) {
            renderChatterboxVoiceOptions(CHATTERBOX_FALLBACK_VOICES, updates.chatterboxVoice);
          }
          if (updates.allowExperimentalIndexTtsArticleVoice !== undefined) allowExperimentalIndexTtsArticleVoiceCheckbox.checked = updates.allowExperimentalIndexTtsArticleVoice;
          if (updates.provider && PROVIDERS[updates.provider]) providerSelect.value = updates.provider;
          if (updates.webSearchEnabled !== undefined) syncWebSearchToggle(updates.webSearchEnabled);
          applyProvider(providerSelect.value);
          updateTtsVisibility();
          if (updates.customSystemPrompt !== undefined) customSystemPromptInput.value = updates.customSystemPrompt;
          if (updates.userMemory !== undefined) userMemoryInput.value = updates.userMemory.join('\n');
          if (updates.autoDownloadGeneratedAudio !== undefined) autoDownloadGeneratedAudioCheckbox.checked = updates.autoDownloadGeneratedAudio;
          if (updates.generatedAudioFolder !== undefined) generatedAudioFolderInput.value = updates.generatedAudioFolder;
          if (updates.elevenLabsModel !== undefined) elevenLabsModelSelect.value = updates.elevenLabsModel;
          syncGeneratedAudioFolder();
          if (updates.autoSaveConversations !== undefined) autoSaveConversationsCheckbox.checked = updates.autoSaveConversations;
          if (updates.showFloatingButton !== undefined) showFloatingButtonCheckbox.checked = updates.showFloatingButton;
          if (updates.autoSubmitCommandOnStart !== undefined) autoSubmitCommandCheckbox.checked = updates.autoSubmitCommandOnStart;
          if (updates.startupCommand !== undefined) startupCommand = updates.startupCommand;
          renderCommands();
          showStatus('Settings imported (API keys not included in imports)');
        });
      } catch (err) {
        showStatus('Error reading settings file');
      }
    };
    reader.readAsText(file);
    importFile.value = ''; // Reset for re-import
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.webSearchEnabled) return;
    syncWebSearchToggle(changes.webSearchEnabled.newValue);
    applyProvider(currentProvider);
  });

  function parseMemoryLines(value) {
    return normalizeMemoryList(String(value || '').split('\n'));
  }

  function normalizeMemoryList(items) {
    return SidekickPrompts.normalizeMemoryList(items);
  }

  let statusTimeout = null;
  function showStatus(message) {
    saveStatus.textContent = message;
    saveStatus.classList.add('visible');
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      saveStatus.classList.remove('visible');
    }, 2000);
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  // Safe for text and quoted attributes: textContent alone leaves quotes unescaped.
  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const railLinks = [...document.querySelectorAll('.settings-rail a')];
  const railSections = railLinks
    .map(link => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);

  function setCurrentRail(id) {
    railLinks.forEach(link => {
      const current = link.getAttribute('href') === `#${id}`;
      if (current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  if (railSections.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.id) setCurrentRail(visible.target.id);
    }, { rootMargin: '-20% 0px -60% 0px', threshold: [0.1, 0.25, 0.5] });
    railSections.forEach(section => observer.observe(section));
    setCurrentRail(railSections[0].id);
  }

  railLinks.forEach(link => {
    link.addEventListener('click', () => {
      const id = link.getAttribute('href')?.slice(1);
      if (id) setCurrentRail(id);
    });
  });
});
