// Settings page logic: API key, model, font, commands, export/import

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_COMMANDS = [
    { name: 'tldr', prompt: 'Provide a TL;DR summary of the page content.' },
    { name: 'explain', prompt: 'Explain this content in simple terms as if I\'m not an expert.' },
    { name: 'translate', prompt: 'Translate the following to' },
    { name: 'key', prompt: 'List the key takeaways from this content.' }
  ];

  // ─── DOM refs ───────────────────────────────────────────────────────
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const modelSelect = document.getElementById('model');
  const maxContextInput = document.getElementById('maxContext');
  const customSystemPromptInput = document.getElementById('customSystemPrompt');
  const themeRadios = document.querySelectorAll('input[name="theme"]');
  const fontRadios = document.querySelectorAll('input[name="fontFamily"]');
  const commandsList = document.getElementById('commandsList');
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
  const elevenLabsTtsSettings = document.getElementById('elevenLabsTtsSettings');
  const localTtsVoiceSelect = document.getElementById('localTtsVoice');
  const testLocalVoiceBtn = document.getElementById('testLocalVoice');
  const elevenLabsApiKeyInput = document.getElementById('elevenLabsApiKey');
  const toggleElevenLabsKeyBtn = document.getElementById('toggleElevenLabsKey');
  const elevenLabsVoiceSelect = document.getElementById('elevenLabsVoice');
  const refreshElevenLabsBtn = document.getElementById('refreshElevenLabsVoices');
  const testElevenLabsBtn = document.getElementById('testElevenLabsVoice');
  const useDefaultVoiceCheckbox = document.getElementById('useDefaultVoice');
  const showFloatingButtonCheckbox = document.getElementById('showFloatingButton');

  let commands = [];
  let editingIndex = -1; // -1 = creating new, >= 0 = editing

  // ─── Load saved settings ────────────────────────────────────────────
  chrome.storage.local.get(
    ['apiKey', 'model', 'maxContext', 'fontFamily', 'commands', 'theme', 'customSystemPrompt',
     'ttsEngine', 'localTtsVoice', 'elevenLabsApiKey', 'elevenLabsVoice', 'useDefaultVoice',
     'showFloatingButton'],
    (result) => {
      if (result.apiKey) apiKeyInput.value = result.apiKey;
      if (result.model) modelSelect.value = result.model;
      if (result.maxContext) maxContextInput.value = result.maxContext;
      if (result.customSystemPrompt) customSystemPromptInput.value = result.customSystemPrompt;
      if (result.theme) {
        const radio = document.querySelector(`input[name="theme"][value="${result.theme}"]`);
        if (radio) radio.checked = true;
      }
      if (result.fontFamily) {
        const radio = document.querySelector(`input[name="fontFamily"][value="${result.fontFamily}"]`);
        if (radio) radio.checked = true;
      }
      commands = result.commands || [...DEFAULT_COMMANDS];
      renderCommands();

      // Default voice toggle
      useDefaultVoiceCheckbox.checked = !!result.useDefaultVoice;

      // Floating button toggle
      showFloatingButtonCheckbox.checked = !!result.showFloatingButton;

      // TTS settings
      if (result.ttsEngine) ttsEngineSelect.value = result.ttsEngine;
      if (result.elevenLabsApiKey) elevenLabsApiKeyInput.value = result.elevenLabsApiKey;
      updateTtsVisibility();
      populateLocalVoices(result.localTtsVoice || '');
      if (result.elevenLabsApiKey) {
        loadElevenLabsVoices(result.elevenLabsApiKey, result.elevenLabsVoice || '');
      }
    }
  );


  // ─── Auto-save on change ────────────────────────────────────────────
  function save(key, value) {
    chrome.storage.local.set({ [key]: value }, () => {
      showStatus('Saved');
    });
  }

  apiKeyInput.addEventListener('change', () => save('apiKey', apiKeyInput.value.trim()));
  modelSelect.addEventListener('change', () => save('model', modelSelect.value));
  maxContextInput.addEventListener('change', () => save('maxContext', parseInt(maxContextInput.value) || 10000));
  customSystemPromptInput.addEventListener('change', () => save('customSystemPrompt', customSystemPromptInput.value.trim()));

  themeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) save('theme', radio.value);
    });
  });

  fontRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) save('fontFamily', radio.value);
    });
  });

  useDefaultVoiceCheckbox.addEventListener('change', () => save('useDefaultVoice', useDefaultVoiceCheckbox.checked));
  showFloatingButtonCheckbox.addEventListener('change', () => save('showFloatingButton', showFloatingButtonCheckbox.checked));

  // ─── API key visibility toggle ──────────────────────────────────────
  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.querySelector('.eye-icon').style.display = isPassword ? 'none' : 'block';
    toggleApiKeyBtn.querySelector('.eye-off-icon').style.display = isPassword ? 'block' : 'none';
  });

  // ─── Commands ───────────────────────────────────────────────────────
  function renderCommands() {
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
  }

  function saveCommands() {
    chrome.storage.local.set({ commands }, () => showStatus('Saved'));
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
      commands[editingIndex] = { name, prompt };
    } else {
      // Check for duplicate name
      const existing = commands.findIndex(c => c.name.toLowerCase() === name);
      if (existing >= 0) {
        commands[existing] = { name, prompt };
      } else {
        commands.push({ name, prompt });
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
  });

  function updateTtsVisibility() {
    const engine = ttsEngineSelect.value;
    localTtsSettings.style.display = engine === 'local' ? 'block' : 'none';
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
          model_id: 'eleven_multilingual_v2'
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
    chrome.storage.local.get(['fontFamily', 'maxContext', 'model', 'commands', 'theme', 'customSystemPrompt', 'showFloatingButton'], (result) => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: {
          fontFamily: result.fontFamily || 'system-ui',
          maxContext: result.maxContext || 10000,
          model: result.model || 'claude-sonnet-4-20250514',
          theme: result.theme || 'auto',
          customSystemPrompt: result.customSystemPrompt || '',
          showFloatingButton: !!result.showFloatingButton
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
      showStatus('Settings exported (API key excluded)');
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
        if (data.settings.fontFamily) updates.fontFamily = data.settings.fontFamily;
        if (data.settings.maxContext) updates.maxContext = data.settings.maxContext;
        if (data.settings.model) updates.model = data.settings.model;
        if (data.settings.theme) updates.theme = data.settings.theme;
        if (data.settings.customSystemPrompt !== undefined) updates.customSystemPrompt = data.settings.customSystemPrompt;
        if (data.settings.showFloatingButton !== undefined) updates.showFloatingButton = data.settings.showFloatingButton;

        // Merge commands (add new, update existing by name)
        if (data.commands && Array.isArray(data.commands)) {
          for (const imported of data.commands) {
            const existing = commands.findIndex(c => c.name === imported.name);
            if (existing >= 0) {
              commands[existing] = imported;
            } else {
              commands.push(imported);
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
          if (updates.fontFamily) {
            const radio = document.querySelector(`input[name="fontFamily"][value="${updates.fontFamily}"]`);
            if (radio) radio.checked = true;
          }
          if (updates.maxContext) maxContextInput.value = updates.maxContext;
          if (updates.model) modelSelect.value = updates.model;
          if (updates.customSystemPrompt !== undefined) customSystemPromptInput.value = updates.customSystemPrompt;
          if (updates.showFloatingButton !== undefined) showFloatingButtonCheckbox.checked = updates.showFloatingButton;
          renderCommands();
          showStatus('Settings imported (API key not included in imports)');
        });
      } catch (err) {
        showStatus('Error reading settings file');
      }
    };
    reader.readAsText(file);
    importFile.value = ''; // Reset for re-import
  });

  // ─── Status toast ───────────────────────────────────────────────────
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
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
