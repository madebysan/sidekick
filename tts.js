// Text-to-Speech engine: local browser voices + ElevenLabs
// Loaded before content.js via manifest content_scripts order

/**
 * Create a TTS engine instance for a single tab
 * Same factory pattern as createChatEngine() in chat.js
 */
function createTTSEngine() {
  let currentBackend = null;   // 'local' or 'elevenlabs'
  let playingBubbleId = null;
  let isPaused = false;
  let localUtterance = null;
  let audioElement = null;
  let lastAudioBlob = null;
  let onStateChangeCb = null;

  // Cache ElevenLabs audio blobs per bubble ID to avoid duplicate API calls
  const audioCache = new Map();

  // ─── MARKDOWN STRIPPING ─────────────────────────────────────────────
  // Convert markdown to plain text for speech
  function stripMarkdown(text) {
    if (!text) return '';
    let plain = text;
    // Remove code blocks
    plain = plain.replace(/```[\s\S]*?```/g, '');
    // Remove inline code
    plain = plain.replace(/`([^`]+)`/g, '$1');
    // Remove headers (keep text)
    plain = plain.replace(/^#{1,6}\s+/gm, '');
    // Remove bold/italic markers
    plain = plain.replace(/\*\*(.+?)\*\*/g, '$1');
    plain = plain.replace(/\*(.+?)\*/g, '$1');
    // Convert links to just the text
    plain = plain.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Remove horizontal rules
    plain = plain.replace(/^---+$/gm, '');
    // Remove list markers
    plain = plain.replace(/^[\s]*[-*]\s+/gm, '');
    plain = plain.replace(/^[\s]*\d+\.\s+/gm, '');
    // Collapse whitespace
    plain = plain.replace(/\n{3,}/g, '\n\n');
    plain = plain.trim();
    return plain;
  }

  // ─── LOCAL TTS (Web Speech API) ─────────────────────────────────────
  function playLocal(text, voiceName, onStateChange) {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis) {
        reject(new Error('Speech synthesis not supported in this browser'));
        return;
      }

      // Cancel any ongoing speech
      speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      localUtterance = utterance;

      // Set voice if specified
      if (voiceName) {
        const voices = speechSynthesis.getVoices();
        const match = voices.find(v => v.name === voiceName);
        if (match) utterance.voice = match;
      }

      utterance.onstart = () => onStateChange('playing');
      utterance.onpause = () => onStateChange('paused');
      utterance.onresume = () => onStateChange('playing');
      utterance.onend = () => {
        localUtterance = null;
        onStateChange('ended');
        resolve();
      };
      utterance.onerror = (e) => {
        localUtterance = null;
        // 'canceled' is expected when we stop manually
        if (e.error === 'canceled') {
          resolve();
          return;
        }
        onStateChange('error');
        reject(new Error(e.error || 'Speech synthesis error'));
      };

      speechSynthesis.speak(utterance);
    });
  }

  // ─── ELEVENLABS TTS ─────────────────────────────────────────────────
  // ElevenLabs has a ~5000 char limit per request. Chunk long text.
  function chunkText(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Find a natural break point (sentence end, paragraph)
      let breakAt = remaining.lastIndexOf('. ', maxLen);
      if (breakAt < maxLen * 0.5) breakAt = remaining.lastIndexOf('\n', maxLen);
      if (breakAt < maxLen * 0.5) breakAt = remaining.lastIndexOf(' ', maxLen);
      if (breakAt < 1) breakAt = maxLen;
      chunks.push(remaining.slice(0, breakAt + 1));
      remaining = remaining.slice(breakAt + 1).trimStart();
    }
    return chunks;
  }

  async function fetchElevenLabsAudio(text, apiKey, voiceId) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2'
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail?.message || `ElevenLabs API error: ${response.status}`);
    }

    return await response.blob();
  }

  async function playElevenLabs(text, apiKey, voiceId, bubbleId, onStateChange) {
    // Check cache first
    if (audioCache.has(bubbleId)) {
      const cachedBlob = audioCache.get(bubbleId);
      lastAudioBlob = cachedBlob;
      return playAudioBlob(cachedBlob, onStateChange);
    }

    onStateChange('playing');

    // Chunk long text
    const chunks = chunkText(text, 4500);
    const blobs = [];

    for (const chunk of chunks) {
      const blob = await fetchElevenLabsAudio(chunk, apiKey, voiceId);
      blobs.push(blob);
    }

    // Combine blobs into a single MP3
    const combinedBlob = new Blob(blobs, { type: 'audio/mpeg' });
    audioCache.set(bubbleId, combinedBlob);
    lastAudioBlob = combinedBlob;

    return playAudioBlob(combinedBlob, onStateChange);
  }

  function playAudioBlob(blob, onStateChange) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      audioElement = new Audio(url);

      audioElement.onplay = () => onStateChange('playing');
      audioElement.onpause = () => {
        // Only report 'paused' if we actually paused (not ended)
        if (!audioElement.ended) onStateChange('paused');
      };
      audioElement.onended = () => {
        URL.revokeObjectURL(url);
        audioElement = null;
        onStateChange('ended');
        resolve();
      };
      audioElement.onerror = () => {
        URL.revokeObjectURL(url);
        audioElement = null;
        onStateChange('error');
        reject(new Error('Audio playback error'));
      };

      audioElement.play().catch(err => {
        URL.revokeObjectURL(url);
        audioElement = null;
        onStateChange('error');
        reject(err);
      });
    });
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────

  /**
   * Play text as speech
   * @param {string} text - Raw message text (markdown)
   * @param {string} bubbleId - Unique ID for caching
   * @param {object} settings - { ttsEngine, localTtsVoice, elevenLabsApiKey, elevenLabsVoice }
   * @param {function} onStateChange - Callback: 'playing' | 'paused' | 'ended' | 'error'
   */
  async function play(text, bubbleId, settings, onStateChange) {
    // Stop any current playback first
    stop();

    const plainText = stripMarkdown(text);
    if (!plainText) {
      onStateChange('ended');
      return;
    }

    playingBubbleId = bubbleId;
    isPaused = false;
    onStateChangeCb = onStateChange;
    currentBackend = settings.ttsEngine || 'local';

    // Wrap the callback to track our state
    const wrappedCallback = (state) => {
      if (state === 'ended' || state === 'error') {
        playingBubbleId = null;
        isPaused = false;
        currentBackend = null;
        onStateChangeCb = null;
      } else if (state === 'paused') {
        isPaused = true;
      } else if (state === 'playing') {
        isPaused = false;
      }
      onStateChange(state);
    };

    try {
      if (currentBackend === 'elevenlabs') {
        if (!settings.elevenLabsApiKey || !settings.elevenLabsVoice) {
          wrappedCallback('error');
          return;
        }
        await playElevenLabs(plainText, settings.elevenLabsApiKey, settings.elevenLabsVoice, bubbleId, wrappedCallback);
      } else {
        await playLocal(plainText, settings.localTtsVoice, wrappedCallback);
      }
    } catch (e) {
      console.error('Sidekick TTS error:', e);
      wrappedCallback('error');
    }
  }

  function pause() {
    if (currentBackend === 'local' && localUtterance) {
      speechSynthesis.pause();
    } else if (currentBackend === 'elevenlabs' && audioElement) {
      audioElement.pause();
    }
  }

  function resume() {
    if (currentBackend === 'local' && localUtterance) {
      speechSynthesis.resume();
    } else if (currentBackend === 'elevenlabs' && audioElement) {
      audioElement.play().catch(() => {}); // Ignore — user just clicked, gesture is valid
    }
  }

  function stop() {
    // Capture callback before clearing state to avoid double-fires from event handlers
    const cb = onStateChangeCb;
    const hadPlayback = !!playingBubbleId;

    // Clear state first so event handlers triggered by pause/cancel see null and bail out
    playingBubbleId = null;
    isPaused = false;
    currentBackend = null;
    onStateChangeCb = null;

    if (localUtterance) {
      speechSynthesis.cancel();
      localUtterance = null;
    }
    if (audioElement) {
      // Detach event handlers before stopping to prevent double-fire
      audioElement.onplay = null;
      audioElement.onpause = null;
      audioElement.onended = null;
      audioElement.onerror = null;
      audioElement.pause();
      audioElement.src = '';
      audioElement = null;
    }

    // Single clean callback to the UI
    if (hadPlayback && cb) {
      cb('ended');
    }
  }

  /**
   * Get available browser voices (async — waits for voiceschanged if needed)
   */
  function getLocalVoices() {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve(voices);
        return;
      }
      // Chrome loads voices asynchronously
      speechSynthesis.addEventListener('voiceschanged', () => {
        resolve(speechSynthesis.getVoices());
      }, { once: true });
    });
  }

  /**
   * Fetch ElevenLabs voices list
   */
  async function getElevenLabsVoices(apiKey) {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey }
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }
    const data = await response.json();
    return data.voices || [];
  }

  return {
    play,
    pause,
    resume,
    stop,
    getLocalVoices,
    getElevenLabsVoices,
    getLastAudioBlob: () => lastAudioBlob,
    getAllCachedAudio: () => audioCache,
    isPlaying: () => playingBubbleId !== null && !isPaused,
    isPaused: () => isPaused,
    getPlayingBubbleId: () => playingBubbleId
  };
}
