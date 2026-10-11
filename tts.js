// Text-to-Speech engine: browser voices + ElevenLabs + local speech servers
// Loaded before content.js via manifest content_scripts order

/**
 * Create a TTS engine instance for a single tab
 * Same factory pattern as createChatEngine() in chat.js
 */
function createTTSEngine() {
  let currentBackend = null;   // 'local', 'elevenlabs', 'kokoro', 'chatterbox', or 'voicebox-lab'
  let playingBubbleId = null;
  let isPaused = false;
  let localUtterance = null;
  let audioElement = null;
  let lastAudioBlob = null;
  let onStateChangeCb = null;
  let playbackToken = 0;
  let activeRemoteSpeechController = null;
  let activeLocalSpeechRequest = null;
  let cancelGenerationRequested = false;
  let activeStream = null;      // ElevenLabs stream still generating behind audioElement
  let playbackRate = 1;

  // Voicebox is the default local engine. It rides the local bridge at the
  // legacy indexTtsEndpoint setting.
  const DEFAULT_TTS_ENGINE = 'elevenlabs';
  const KOKORO_DEFAULT_ENDPOINT = 'http://localhost:8789';
  const KOKORO_DEFAULT_VOICE = 'af_heart';
  const INDEXTTS_DEFAULT_ENDPOINT = 'http://localhost:8790';
  const CHATTERBOX_DEFAULT_VOICE = 'default';
  const VOICEBOX_LAB_ENGINE = 'voicebox-lab';
  const CHATTERBOX_FALLBACK_VOICES = [
    { id: 'default', name: 'Chatterbox', group: 'Default', articleSafe: true, quality: 'benchmarked' }
  ];
  const INDEXTTS_LONG_MESSAGE_JOB_CHARS = 400;
  const TTS_DIAGNOSTIC_STORAGE_KEY = 'sidekickTtsDiagnostics';
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

  // Cache generated audio blobs per bubble ID to avoid duplicate API calls
  const audioCache = new Map();
  const autoDownloadedAudioKeys = new Set();

  function recordTtsDiagnostic(event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      backend: currentBackend,
      bubbleId: playingBubbleId,
      ...details
    };
    console.warn('Sidekick TTS diagnostic', entry);
    try {
      chrome.storage.local.get([TTS_DIAGNOSTIC_STORAGE_KEY], result => {
        const previous = Array.isArray(result[TTS_DIAGNOSTIC_STORAGE_KEY])
          ? result[TTS_DIAGNOSTIC_STORAGE_KEY]
          : [];
        chrome.storage.local.set({
          [TTS_DIAGNOSTIC_STORAGE_KEY]: [...previous, entry].slice(-25)
        });
      });
    } catch (error) {
      // Diagnostics must never break speech playback.
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || '');
      reader.onerror = () => reject(new Error('Could not prepare generated audio download.'));
      reader.readAsDataURL(blob);
    });
  }

  function fallbackGeneratedAudioFilename(kind = 'audio') {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `sidekick-${kind}-${timestamp}.mp3`;
  }

  function normalizeGeneratedAudioFilename(filename, kind) {
    const value = String(filename || '').trim();
    if (!value) return fallbackGeneratedAudioFilename(kind);
    return value.toLowerCase().endsWith('.mp3') ? value : `${value}.mp3`;
  }

  // chrome.downloads only writes inside Downloads, so the folder is a relative
  // subfolder. Strips a leading "Downloads/", ".." segments and illegal characters.
  function normalizeDownloadFolder(folder) {
    return String(folder || '')
      .replace(/\\/g, '/')
      .split('/')
      .map(part => part.trim().replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^(\.+|~)$/, ''))
      .filter(Boolean)
      .filter((part, index) => !(index === 0 && /^downloads$/i.test(part)))
      .join('/');
  }

  function buildGeneratedAudioPath(filename, folder) {
    const safeFolder = normalizeDownloadFolder(folder);
    return safeFolder ? `${safeFolder}/${filename}` : filename;
  }

  async function autoDownloadGeneratedAudio(blob, settings, cacheKey, kind = 'audio') {
    if (settings.autoDownloadGeneratedAudio === false) return false;
    if (autoDownloadedAudioKeys.has(cacheKey)) return true;

    const filename = buildGeneratedAudioPath(
      normalizeGeneratedAudioFilename(settings.generatedAudioFilename, kind),
      settings.generatedAudioFolder
    );
    try {
      const dataUrl = await blobToDataUrl(blob);
      const response = await chrome.runtime.sendMessage({
        action: 'downloadFile',
        url: dataUrl,
        filename
      });
      if (!response?.ok) throw new Error(response?.error || 'Download failed');
      autoDownloadedAudioKeys.add(cacheKey);
      recordTtsDiagnostic('generated-audio-downloaded', {
        filename,
        bytes: blob?.size || 0
      });
      return true;
    } catch (error) {
      recordTtsDiagnostic('generated-audio-download-failed', {
        filename,
        error: error.message || 'Download failed'
      });
      return false;
    }
  }

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
  // Streams audio so playback starts after the first sentence or two. A tiny
  // first chunk gets sound out fast; the rest is generated at full speed so the
  // finished MP3 (fully seekable, cached, auto-downloaded) is ready early.
  const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
  const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
  const ELEVENLABS_OUTPUT_KBPS = 128;
  const ELEVENLABS_FIRST_CHUNK_CHARS = 280;
  const ELEVENLABS_CHUNK_CHARS = 1800;
  const ELEVENLABS_CONTEXT_CHARS = 300;
  const ELEVENLABS_KEEP_BEHIND_SECONDS = 10;
  const ELEVENLABS_STALL_TIMEOUT_MS = 20000;

  function mp3BytesToSeconds(bytes) {
    return bytes * 8 / (ELEVENLABS_OUTPUT_KBPS * 1000);
  }

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
      let breakAt = Math.max(
        remaining.lastIndexOf('. ', maxLen),
        remaining.lastIndexOf('? ', maxLen),
        remaining.lastIndexOf('! ', maxLen)
      );
      if (breakAt < maxLen * 0.5) breakAt = remaining.lastIndexOf('\n', maxLen);
      if (breakAt < maxLen * 0.5) breakAt = remaining.lastIndexOf(' ', maxLen);
      if (breakAt < 1) breakAt = maxLen;
      chunks.push(remaining.slice(0, breakAt + 1));
      remaining = remaining.slice(breakAt + 1).trimStart();
    }
    return chunks;
  }

  function planElevenLabsChunks(text) {
    const [first] = chunkText(text, ELEVENLABS_FIRST_CHUNK_CHARS);
    const rest = text.slice(first.length).trimStart();
    return rest ? [first, ...chunkText(rest, ELEVENLABS_CHUNK_CHARS)] : [first];
  }

  // Neighboring text keeps intonation continuous across chunk boundaries.
  function elevenLabsChunkContext(chunks, index) {
    const previousText = chunks.slice(0, index).join(' ').slice(-ELEVENLABS_CONTEXT_CHARS);
    const nextText = chunks.slice(index + 1).join(' ').slice(0, ELEVENLABS_CONTEXT_CHARS);
    return { previousText, nextText };
  }

  async function* streamElevenLabsAudio(text, voice, context, signal) {
    if (signal.aborted) throw createCanceledError();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    signal.addEventListener('abort', abortFromParent, { once: true });
    let timedOut = false;
    let stallTimer = null;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ELEVENLABS_STALL_TIMEOUT_MS);
    };

    try {
      armStallTimer();
      const body = { text, model_id: voice.modelId };
      if (context.previousText) body.previous_text = context.previousText;
      if (context.nextText) body.next_text = context.nextText;
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': voice.apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail?.message || `ElevenLabs API error: ${response.status}`);
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        // Pause the stall timer while the consumer buffers this piece.
        clearTimeout(stallTimer);
        yield value;
        armStallTimer();
      }
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new Error('ElevenLabs stopped responding. Try again in a moment.');
      }
      throw error;
    } finally {
      clearTimeout(stallTimer);
      signal.removeEventListener('abort', abortFromParent);
      // Closes the request if the consumer stopped reading early.
      controller.abort();
    }
  }

  async function fetchElevenLabsAudio(text, voice, context, signal) {
    const parts = [];
    for await (const bytes of streamElevenLabsAudio(text, voice, context, signal)) {
      parts.push(bytes);
    }
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  function canStreamMp3() {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
  }

  function runSourceBufferOp(sourceBuffer, op) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        sourceBuffer.removeEventListener('updateend', done);
        sourceBuffer.removeEventListener('error', fail);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('Browser could not buffer the streamed audio.'));
      };
      sourceBuffer.addEventListener('updateend', done);
      sourceBuffer.addEventListener('error', fail);
      try {
        op();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function evictPlayedAudio(sourceBuffer, audio) {
    const ranges = sourceBuffer.buffered;
    const keepFrom = audio.currentTime - ELEVENLABS_KEEP_BEHIND_SECONDS;
    if (!ranges.length || keepFrom - ranges.start(0) < ELEVENLABS_KEEP_BEHIND_SECONDS) return false;
    await runSourceBufferOp(sourceBuffer, () => sourceBuffer.remove(0, keepFrom));
    return true;
  }

  function streamElevenLabsPlayback(chunks, voice, cacheKey, settings, signal, onStateChange) {
    return new Promise((resolve, reject) => {
      const mediaSource = new MediaSource();
      const objectUrls = [URL.createObjectURL(mediaSource)];
      const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const parts = [];
      let audio = new Audio();
      applyPlaybackRate(audio);
      let settled = false;
      let appendedCount = 0;
      let evicted = false;
      let fetchDone = false;
      let fetchedBytes = 0;
      let completedBytes = 0;
      let completedChars = 0;
      let wake = null;
      const notify = () => {
        const resolveWake = wake;
        wake = null;
        resolveWake?.();
      };
      const waitForParts = () => new Promise(resolveWait => { wake = resolveWait; });

      const stream = {
        generating: true,
        generatedSeconds: () => mp3BytesToSeconds(fetchedBytes),
        // Calibrates from finished chunks; falls back to ~15 spoken chars per second.
        estimatedDuration: () => {
          const estimate = completedChars
            ? mp3BytesToSeconds(completedBytes) / completedChars * totalChars
            : totalChars / 15;
          return Math.max(estimate, mp3BytesToSeconds(fetchedBytes));
        }
      };
      activeStream = stream;

      const detachHandlers = (element) => {
        element.onplaying = null;
        element.onpause = null;
        element.onended = null;
        element.onerror = null;
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        notify();
        detachHandlers(audio);
        if (activeStream === stream) activeStream = null;
        if (audioElement === audio) audioElement = null;
        if (error) {
          audio.pause();
          audio.removeAttribute('src');
        }
        objectUrls.forEach(url => URL.revokeObjectURL(url));
        if (error) reject(error);
        else resolve();
      };
      const attachHandlers = (element) => {
        // 'playing' (not 'play') fires once audio is actually audible, so the UI
        // stays on Generating until the first chunk arrives.
        element.onplaying = () => onStateChange('playing');
        element.onpause = () => {
          if (!element.ended) onStateChange('paused');
        };
        element.onended = () => {
          settle();
          onStateChange('ended');
        };
        element.onerror = () => {
          const code = element.error?.code;
          recordTtsDiagnostic('elevenlabs-stream-playback-error', { code: code || 0 });
          settle(new Error(code === 3
            ? 'Audio playback failed: browser could not decode the streamed MP3.'
            : 'Audio playback failed while streaming.'));
        };
      };

      signal.addEventListener('abort', () => settle(createCanceledError()), { once: true });
      attachHandlers(audio);
      audioElement = audio;

      async function fetchAllChunks() {
        for (let index = 0; index < chunks.length; index += 1) {
          const context = elevenLabsChunkContext(chunks, index);
          for await (const bytes of streamElevenLabsAudio(chunks[index], voice, context, signal)) {
            parts.push(bytes);
            fetchedBytes += bytes.byteLength;
            notify();
          }
          completedChars += chunks[index].length;
          completedBytes = fetchedBytes;
        }
        fetchDone = true;
        notify();
      }

      // Feeds the MediaSource as bytes arrive. If the browser's buffer fills up,
      // played audio is evicted; the full file replaces the stream at the end.
      async function appendAllParts(sourceBuffer) {
        while (!settled) {
          if (appendedCount < parts.length) {
            try {
              await runSourceBufferOp(sourceBuffer, () => sourceBuffer.appendBuffer(parts[appendedCount]));
              appendedCount += 1;
            } catch (error) {
              if (error?.name !== 'QuotaExceededError') throw error;
              if (fetchDone) return;
              evicted = await evictPlayedAudio(sourceBuffer, audio) || evicted;
              await delay(1000);
            }
            continue;
          }
          if (fetchDone) return;
          await waitForParts();
        }
      }

      // Hands playback to the complete MP3 so the whole file is seekable.
      async function swapToFullAudio(blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const next = new Audio(url);
        next.preload = 'auto';
        await new Promise((resolveReady, rejectReady) => {
          next.oncanplay = resolveReady;
          next.onerror = () => rejectReady(new Error('Could not load the finished MP3.'));
        });
        next.oncanplay = null;
        if (settled) return;
        const previous = audio;
        const wasPlaying = !previous.paused;
        detachHandlers(previous);
        next.currentTime = previous.currentTime;
        applyPlaybackRate(next);
        attachHandlers(next);
        audio = next;
        audioElement = next;
        previous.pause();
        previous.removeAttribute('src');
        if (wasPlaying) await next.play().catch(() => onStateChange('paused'));
      }

      mediaSource.addEventListener('sourceopen', async () => {
        try {
          const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          sourceBuffer.mode = 'sequence';

          audio.play().catch(error => {
            if (settled) return;
            if (error?.name === 'NotAllowedError') {
              onStateChange('paused', 'Audio is ready. Click Resume to play.');
              return;
            }
            settle(error);
          });

          await Promise.all([fetchAllChunks(), appendAllParts(sourceBuffer)]);
          if (settled) return;

          const combinedBlob = new Blob(parts, { type: 'audio/mpeg' });
          audioCache.set(cacheKey, combinedBlob);
          lastAudioBlob = combinedBlob;
          stream.generating = false;
          autoDownloadGeneratedAudio(combinedBlob, settings, cacheKey, 'page-audio');

          if (!evicted && appendedCount === parts.length) {
            if (mediaSource.readyState === 'open') mediaSource.endOfStream();
          } else {
            await swapToFullAudio(combinedBlob);
          }
        } catch (error) {
          settle(signal.aborted ? createCanceledError() : error);
        }
      }, { once: true });

      audio.src = objectUrls[0];
    });
  }

  async function playElevenLabs(text, settings, bubbleId, onStateChange) {
    const voice = {
      apiKey: settings.elevenLabsApiKey,
      voiceId: settings.elevenLabsVoice,
      modelId: settings.elevenLabsModel || ELEVENLABS_DEFAULT_MODEL
    };
    const cacheKey = `${bubbleId}:elevenlabs:${voice.modelId}:${voice.voiceId}`;
    if (audioCache.has(cacheKey)) {
      const cachedBlob = audioCache.get(cacheKey);
      lastAudioBlob = cachedBlob;
      const downloaded = await autoDownloadGeneratedAudio(cachedBlob, settings, cacheKey, 'page-audio');
      return playAudioBlob(cachedBlob, onStateChange, { downloaded });
    }

    onStateChange('loading');

    const chunks = planElevenLabsChunks(text);
    const controller = new AbortController();
    activeRemoteSpeechController = controller;

    try {
      if (canStreamMp3()) {
        return await streamElevenLabsPlayback(chunks, voice, cacheKey, settings, controller.signal, onStateChange);
      }

      // No MediaSource MP3 support: generate everything, then play.
      const blobs = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const context = elevenLabsChunkContext(chunks, index);
        blobs.push(await fetchElevenLabsAudio(chunks[index], voice, context, controller.signal));
      }
      const combinedBlob = new Blob(blobs, { type: 'audio/mpeg' });
      audioCache.set(cacheKey, combinedBlob);
      lastAudioBlob = combinedBlob;
      const downloaded = await autoDownloadGeneratedAudio(combinedBlob, settings, cacheKey, 'page-audio');
      return await playAudioBlob(combinedBlob, onStateChange, { downloaded });
    } finally {
      if (activeRemoteSpeechController === controller) {
        activeRemoteSpeechController = null;
      }
    }
  }

  // ─── LOCAL SPEECH SERVER HELPERS ────────────────────────────────────────
  function normalizeLocalSpeechServerUrl(endpoint, defaultEndpoint) {
    const raw = (endpoint || defaultEndpoint).trim().replace(/\/+$/, '');
    if (!raw) return defaultEndpoint;
    return raw
      .replace(/\/config$/, '')
      .replace(/\/download$/, '')
      .replace(/\/stream$/, '');
  }

  function normalizeKokoroServerUrl(endpoint) {
    return normalizeLocalSpeechServerUrl(endpoint, KOKORO_DEFAULT_ENDPOINT);
  }

  function normalizeIndexTtsServerUrl(endpoint) {
    return normalizeLocalSpeechServerUrl(endpoint, INDEXTTS_DEFAULT_ENDPOINT);
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

  function createSpeechRequestId(serviceName) {
    const prefix = String(serviceName || 'tts').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createCanceledError() {
    const error = new Error('Speech generation canceled');
    error.name = 'AbortError';
    return error;
  }

  async function requestLocalSpeech({ endpoint, serviceName, body }) {
    if (cancelGenerationRequested) throw createCanceledError();

    const requestId = createSpeechRequestId(serviceName);
    activeLocalSpeechRequest = { requestId, endpoint, serviceName };
    recordTtsDiagnostic('local-speech-start', {
      serviceName,
      endpoint,
      requestId,
      mode: body?.mode || 'message',
      voice: body?.voice || '',
      fast: body?.fast === true,
      chars: String(body?.text || '').length
    });

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsSpeech',
        endpoint,
        serviceName,
        requestId,
        body: {
          ...body,
          requestId
        }
      });

      if (cancelGenerationRequested) throw createCanceledError();
      if (!response?.ok) {
        recordTtsDiagnostic('local-speech-failed', {
          serviceName,
          endpoint,
          requestId,
          error: response?.error || `Local ${serviceName || 'speech'} failed`
        });
        throw new Error(response?.error || `Local ${serviceName || 'speech'} failed`);
      }

      const blobResponse = await fetch(response.dataUrl);
      const blob = await blobResponse.blob();
      recordTtsDiagnostic('local-speech-complete', {
        serviceName,
        endpoint,
        requestId,
        bytes: blob.size
      });
      return blob;
    } finally {
      if (activeLocalSpeechRequest?.requestId === requestId) {
        activeLocalSpeechRequest = null;
      }
    }
  }

  function cancelActiveLocalSpeechRequest() {
    const request = activeLocalSpeechRequest;
    if (!request?.requestId) return;
    activeLocalSpeechRequest = null;
    chrome.runtime.sendMessage({
      action: 'cancelLocalTtsSpeech',
      requestId: request.requestId,
      endpoint: request.endpoint,
      serviceName: request.serviceName
    }).catch(() => {});
  }

  function formatBridgeVoiceLabel(id) {
    return String(id || '')
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Voice';
  }

  function normalizeBridgeVoiceEntry(entry) {
    if (typeof entry === 'string') {
      const group = entry === CHATTERBOX_DEFAULT_VOICE ? 'Default' : 'Cloned voices';
      return {
        id: entry,
        name: formatBridgeVoiceLabel(entry),
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
      name: entry.name || entry.display_name || entry.label || formatBridgeVoiceLabel(id),
      group,
      articleSafe,
      articleOk: typeof entry.article_ok === 'boolean' ? entry.article_ok : articleSafe,
      shortClipOk: typeof entry.short_clip_ok === 'boolean' ? entry.short_clip_ok : true,
      maxArticleChars: Number.isInteger(entry.max_article_chars) ? entry.max_article_chars : null,
      quality: entry.quality || (articleSafe ? 'benchmarked' : 'experimental'),
      benchmarkDate: entry.benchmark_date || '',
      notes: entry.notes || ''
    };
  }

  // ─── LOCAL KOKORO TTS ──────────────────────────────────────────────────

  async function fetchKokoroAudio(text, settings) {
    const serverUrl = normalizeKokoroServerUrl(settings.kokoroEndpoint);
    const voice = (settings.kokoroVoice || KOKORO_DEFAULT_VOICE).trim() || KOKORO_DEFAULT_VOICE;

    return await requestLocalSpeech({
      endpoint: `${serverUrl}/download`,
      serviceName: 'Kokoro',
      body: {
        text,
        voice,
        title: 'Sidekick message'
      }
    });
  }

  async function playKokoro(text, settings, bubbleId, onStateChange) {
    const cacheKey = `${bubbleId}:kokoro:${settings.kokoroVoice || KOKORO_DEFAULT_VOICE}`;
    if (audioCache.has(cacheKey)) {
      const cachedBlob = audioCache.get(cacheKey);
      lastAudioBlob = cachedBlob;
      return playAudioBlob(cachedBlob, onStateChange);
    }

    onStateChange('loading');

    const chunks = chunkText(text, 2500);
    const blobs = [];

    for (const chunk of chunks) {
      if (cancelGenerationRequested) throw createCanceledError();
      const blob = await fetchKokoroAudio(chunk, settings);
      blobs.push(blob);
    }

    const combinedBlob = new Blob(blobs, { type: 'audio/mpeg' });
    audioCache.set(cacheKey, combinedBlob);
    lastAudioBlob = combinedBlob;

    return playAudioBlob(combinedBlob, onStateChange);
  }

  async function getKokoroVoices(serverUrl = KOKORO_DEFAULT_ENDPOINT) {
    const endpoint = `${normalizeKokoroServerUrl(serverUrl)}/config`;
    const response = await chrome.runtime.sendMessage({
      action: 'localTtsConfig',
      endpoint,
      serviceName: 'Kokoro'
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to load Kokoro voices');
    }
    const voices = Array.isArray(response.config?.voices) ? response.config.voices : [];
    return voices.map(voice => ({
      id: voice,
      name: formatKokoroVoiceLabel(voice),
      language: kokoroVoiceLanguage(voice)
    }));
  }

  // ─── LOCAL CHATTERBOX TTS (via the local bridge) ──────────────────────
  function isLocalBridgeEngine(engine) {
    return engine === 'chatterbox' || engine === VOICEBOX_LAB_ENGINE;
  }

  function localBridgeEngine(settings) {
    return settings.ttsEngine === 'chatterbox' ? 'chatterbox' : VOICEBOX_LAB_ENGINE;
  }

  function localBridgeServiceName(engine) {
    return engine === VOICEBOX_LAB_ENGINE ? 'Voicebox' : 'Chatterbox';
  }

  function localBridgeVoice(settings) {
    return (settings.chatterboxVoice || CHATTERBOX_DEFAULT_VOICE).trim() || CHATTERBOX_DEFAULT_VOICE;
  }

  async function fetchChatterboxAudio(text, settings, engine = 'chatterbox') {
    const serverUrl = normalizeIndexTtsServerUrl(settings.indexTtsEndpoint);

    return await requestLocalSpeech({
      endpoint: `${serverUrl}/download`,
      serviceName: localBridgeServiceName(engine),
      body: {
        text,
        engine,
        voice: localBridgeVoice(settings),
        title: 'Sidekick message',
        mode: 'message',
        fast: settings.fastLocalTts === true
      }
    });
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchChatterboxJobAudio(text, settings, requestId, article, onStateChange, mode = 'article', engine = 'chatterbox') {
    const serverUrl = normalizeIndexTtsServerUrl(settings.indexTtsEndpoint);
    const jobsEndpoint = `${serverUrl}/jobs`;
    const serviceName = localBridgeServiceName(engine);
    activeLocalSpeechRequest = {
      requestId,
      endpoint: jobsEndpoint,
      serviceName
    };

    try {
      const startResponse = await chrome.runtime.sendMessage({
        action: 'indexTtsStartJob',
        endpoint: jobsEndpoint,
        serviceName,
        body: {
          requestId,
          mode,
          text,
          engine,
          voice: localBridgeVoice(settings),
          title: article?.title || 'Sidekick article',
          url: article?.url || '',
          sourceType: article?.type || 'page',
          allowExperimentalArticleVoice: settings.allowExperimentalIndexTtsArticleVoice === true,
          fast: settings.fastLocalTts === true
        }
      });

      if (!startResponse?.ok) {
        throw new Error(startResponse?.error || `Failed to start ${serviceName} job`);
      }

      while (true) {
        if (cancelGenerationRequested) throw createCanceledError();

        const statusResponse = await chrome.runtime.sendMessage({
          action: 'indexTtsJobStatus',
          endpoint: `${serverUrl}/jobs/${encodeURIComponent(requestId)}`,
          serviceName
        });

        if (!statusResponse?.ok) {
          throw new Error(statusResponse?.error || `Failed to read ${serviceName} job status`);
        }

        const job = statusResponse.job;
        if (!job) throw new Error(`${serviceName} job disappeared.`);

        if (job.status === 'queued' || job.status === 'running') {
          const label = job.progress?.label || (job.status === 'queued' ? 'Queued' : 'Generating...');
          onStateChange?.('loading', label);
          await delay(1000);
          continue;
        }

        if (job.status === 'canceled') throw createCanceledError();
        if (job.status === 'failed') {
          throw new Error(job.error || `${serviceName} generation failed`);
        }
        if (job.status === 'complete') {
          if (!job.audio_url) throw new Error(`${serviceName} job audio is missing.`);
          const audioResponse = await fetch(job.audio_url, { cache: 'no-store' });
          if (!audioResponse.ok) {
            throw new Error(`${serviceName} audio download failed: ${audioResponse.status}`);
          }
          return await audioResponse.blob();
        }

        throw new Error(`${serviceName} job ended in an unknown state: ${job.status}`);
      }
    } finally {
      if (activeLocalSpeechRequest?.requestId === requestId) {
        activeLocalSpeechRequest = null;
      }
    }
  }

  async function playChatterbox(text, settings, bubbleId, onStateChange) {
    const endpoint = normalizeIndexTtsServerUrl(settings.indexTtsEndpoint);
    const engine = localBridgeEngine(settings);
    const voice = localBridgeVoice(settings);
    const cacheKey = `${bubbleId}:${engine}:${endpoint}:${voice}`;
    if (audioCache.has(cacheKey)) {
      const cachedBlob = audioCache.get(cacheKey);
      lastAudioBlob = cachedBlob;
      const downloaded = await autoDownloadGeneratedAudio(cachedBlob, settings, cacheKey, 'audio');
      return playAudioBlob(cachedBlob, onStateChange, { downloaded });
    }

    onStateChange('loading');

    const combinedBlob = text.length > INDEXTTS_LONG_MESSAGE_JOB_CHARS
      ? await fetchChatterboxJobAudio(text, settings, createSpeechRequestId(localBridgeServiceName(engine)), {
        title: 'Sidekick message',
        type: 'message'
      }, onStateChange, 'message', engine)
      : await fetchChatterboxAudio(text, settings, engine);
    audioCache.set(cacheKey, combinedBlob);
    lastAudioBlob = combinedBlob;
    const downloaded = await autoDownloadGeneratedAudio(combinedBlob, settings, cacheKey, 'audio');

    return playAudioBlob(combinedBlob, onStateChange, { downloaded });
  }

  async function playChatterboxArticle(text, settings, bubbleId, onStateChange, article) {
    const endpoint = normalizeIndexTtsServerUrl(settings.indexTtsEndpoint);
    const engine = localBridgeEngine(settings);
    const serviceName = localBridgeServiceName(engine);
    const voice = localBridgeVoice(settings);
    const speedMode = settings.fastLocalTts === true ? 'fast' : 'quality';
    const cacheKey = `${bubbleId}:${engine}-article:${speedMode}:${endpoint}:${voice}`;
    if (audioCache.has(cacheKey)) {
      const cachedBlob = audioCache.get(cacheKey);
      lastAudioBlob = cachedBlob;
      const downloaded = await autoDownloadGeneratedAudio(cachedBlob, settings, cacheKey, 'page-audio');
      return playAudioBlob(cachedBlob, onStateChange, { downloaded });
    }

    onStateChange('loading', `Starting ${settings.fastLocalTts === true ? 'fast ' : ''}${serviceName} article job...`);

    const requestId = createSpeechRequestId(serviceName);
    const combinedBlob = await fetchChatterboxJobAudio(text, settings, requestId, article, onStateChange, 'article', engine);
    audioCache.set(cacheKey, combinedBlob);
    lastAudioBlob = combinedBlob;
    const downloaded = await autoDownloadGeneratedAudio(combinedBlob, settings, cacheKey, 'page-audio');

    return playAudioBlob(combinedBlob, onStateChange, { downloaded });
  }

  async function getBridgeVoices(serverUrl = INDEXTTS_DEFAULT_ENDPOINT, engine = 'chatterbox') {
    const endpoint = `${normalizeIndexTtsServerUrl(serverUrl)}/config`;
    const configKey = engine === VOICEBOX_LAB_ENGINE ? 'voicebox' : 'chatterbox';
    const serviceName = localBridgeServiceName(engine);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'localTtsConfig',
        endpoint,
        serviceName
      });
      if (!response?.ok) {
        throw new Error(response?.error || `Failed to load ${serviceName} voices`);
      }
      const engineConfig = response.config?.[configKey] || (configKey === 'voicebox' ? response.config?.voicebox_lab : null);
      const voices = Array.isArray(engineConfig?.voices)
        ? engineConfig.voices
        : [];
      const normalized = voices.map(normalizeBridgeVoiceEntry).filter(Boolean);
      return normalized.length ? normalized : CHATTERBOX_FALLBACK_VOICES;
    } catch (error) {
      console.warn(`Sidekick: using fallback ${serviceName} voices`, error);
      return CHATTERBOX_FALLBACK_VOICES;
    }
  }

  async function getChatterboxVoices(serverUrl = INDEXTTS_DEFAULT_ENDPOINT) {
    return getBridgeVoices(serverUrl, 'chatterbox');
  }

  async function getVoiceboxLabVoices(serverUrl = INDEXTTS_DEFAULT_ENDPOINT) {
    return getBridgeVoices(serverUrl, VOICEBOX_LAB_ENGINE);
  }

  function playAudioBlob(blob, onStateChange, { downloaded = false } = {}) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      audioElement = new Audio(url);
      applyPlaybackRate(audioElement);

      const cleanupAudio = () => {
        URL.revokeObjectURL(url);
        audioElement = null;
      };
      const playbackErrorMessage = (error) => {
        const mediaError = audioElement?.error;
        if (mediaError?.code) {
          const labels = {
            1: 'playback was aborted',
            2: 'network error while loading audio',
            3: 'browser could not decode the generated MP3',
            4: 'browser does not support the generated audio source'
          };
          return `Audio playback failed: ${labels[mediaError.code] || `media error ${mediaError.code}`}.`;
        }
        return error?.message || 'Audio playback failed.';
      };
      const isUserActivationError = (error) => {
        const message = String(error?.message || '');
        return error?.name === 'NotAllowedError' ||
          /user activation|user didn't interact|interact with the document|play\(\) failed/i.test(message);
      };

      audioElement.onplay = () => onStateChange('playing');
      audioElement.onpause = () => {
        // Only report 'paused' if we actually paused (not ended)
        if (!audioElement.ended) onStateChange('paused');
      };
      audioElement.onended = () => {
        cleanupAudio();
        onStateChange('ended');
        resolve();
      };
      audioElement.onerror = () => {
        const message = playbackErrorMessage();
        const finalMessage = downloaded ? `${message} MP3 was saved.` : message;
        recordTtsDiagnostic('audio-playback-error', { error: message, bytes: blob?.size || 0 });
        cleanupAudio();
        onStateChange('error', finalMessage);
        reject(new Error(finalMessage));
      };

      audioElement.play().catch(err => {
        const message = playbackErrorMessage(err);
        recordTtsDiagnostic('audio-play-rejected', {
          error: message,
          name: err?.name || '',
          bytes: blob?.size || 0
        });
        if (isUserActivationError(err)) {
          const readyMessage = downloaded
            ? 'Audio is ready and MP3 was saved. Click Resume to play.'
            : 'Audio is ready. Click Resume to play.';
          onStateChange('paused', readyMessage);
          resolve();
          return;
        }
        const finalMessage = downloaded ? `${message} MP3 was saved.` : message;
        cleanupAudio();
        onStateChange('error', finalMessage);
        reject(new Error(finalMessage));
      });
    });
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────

  /**
   * Play text as speech
   * @param {string} text - Raw message text (markdown)
   * @param {string} bubbleId - Unique ID for caching
   * @param {object} settings - { ttsEngine, localTtsVoice, elevenLabsApiKey, elevenLabsVoice, elevenLabsModel, kokoroEndpoint, kokoroVoice, indexTtsEndpoint, chatterboxVoice }
   * @param {function} onStateChange - Callback: 'loading' | 'playing' | 'paused' | 'ended' | 'error'
   */
  async function playPrepared(text, bubbleId, settings, onStateChange, options = {}) {
    // Stop any current playback first
    stop();
    cancelGenerationRequested = false;
    const token = playbackToken + 1;
    playbackToken = token;

    const plainText = options.preserveText ? String(text || '').trim() : stripMarkdown(text);
    if (!plainText) {
      onStateChange('ended');
      return;
    }

    playingBubbleId = bubbleId;
    isPaused = false;
    onStateChangeCb = onStateChange;
    currentBackend = settings.ttsEngine || DEFAULT_TTS_ENGINE;

    // Wrap the callback to track our state. Error states carry a human-readable
    // message as a second argument so the UI can show what actually went wrong.
    const wrappedCallback = (state, errorMessage) => {
      if (token !== playbackToken) return;
      if (state === 'ended' || state === 'error') {
        playingBubbleId = null;
        isPaused = false;
        currentBackend = null;
        onStateChangeCb = null;
      } else if (state === 'loading') {
        isPaused = false;
      } else if (state === 'paused') {
        isPaused = true;
      } else if (state === 'playing') {
        isPaused = false;
      }
      onStateChange(state, errorMessage);
    };

    try {
      if (currentBackend === 'elevenlabs') {
        if (!settings.elevenLabsApiKey || !settings.elevenLabsVoice) {
          wrappedCallback('error', 'Add an ElevenLabs API key and pick a voice in Settings first.');
          return;
        }
        await playElevenLabs(plainText, settings, bubbleId, wrappedCallback);
      } else if (currentBackend === 'kokoro') {
        await playKokoro(plainText, settings, bubbleId, wrappedCallback);
      } else if (isLocalBridgeEngine(currentBackend)) {
        if (options.mode === 'article') {
          await playChatterboxArticle(plainText, settings, bubbleId, wrappedCallback, options.article || {});
        } else {
          await playChatterbox(plainText, settings, bubbleId, wrappedCallback);
        }
      } else {
        await playLocal(plainText, settings.localTtsVoice, wrappedCallback);
      }
    } catch (e) {
      if (token !== playbackToken || cancelGenerationRequested || e.name === 'AbortError') return;
      console.error('Sidekick TTS error:', e);
      wrappedCallback('error', e.message || 'Speech generation failed');
    }
  }

  async function play(text, bubbleId, settings, onStateChange) {
    return playPrepared(text, bubbleId, settings, onStateChange, { mode: 'message' });
  }

  async function playArticle(article, bubbleId, settings, onStateChange) {
    return playPrepared(article?.content || article?.text || '', bubbleId, settings, onStateChange, {
      mode: 'article',
      preserveText: true,
      article
    });
  }

  function pause() {
    if (currentBackend === 'local' && localUtterance) {
      speechSynthesis.pause();
    } else if ((currentBackend === 'elevenlabs' || currentBackend === 'kokoro' || isLocalBridgeEngine(currentBackend)) && audioElement) {
      audioElement.pause();
    }
  }

  function resume() {
    if (currentBackend === 'local' && localUtterance) {
      speechSynthesis.resume();
    } else if ((currentBackend === 'elevenlabs' || currentBackend === 'kokoro' || isLocalBridgeEngine(currentBackend)) && audioElement) {
      audioElement.play().catch(() => {}); // Ignore — user just clicked, gesture is valid
    }
  }

  function stop() {
    // Capture callback before clearing state to avoid double-fires from event handlers
    const cb = onStateChangeCb;
    const hadPlayback = !!playingBubbleId || !!activeLocalSpeechRequest || !!activeRemoteSpeechController;
    playbackToken += 1;
    cancelGenerationRequested = true;
    activeStream = null;
    if (activeRemoteSpeechController) {
      activeRemoteSpeechController.abort();
      activeRemoteSpeechController = null;
    }
    cancelActiveLocalSpeechRequest();

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
      cb('canceled');
    }
  }

  /**
   * Playback position for the progress bar. While ElevenLabs is still
   * generating, duration is an estimate and seeking is limited to buffered audio.
   */
  function getPlaybackProgress() {
    const audio = audioElement;
    if (!audio) return null;
    const generating = !!activeStream?.generating;
    const ranges = audio.buffered;
    const bufferedStart = ranges.length ? ranges.start(0) : 0;
    const bufferedEnd = ranges.length ? ranges.end(ranges.length - 1) : 0;
    const duration = generating
      ? activeStream.estimatedDuration()
      : (Number.isFinite(audio.duration) ? audio.duration : bufferedEnd);
    if (!duration) return null;
    return {
      currentTime: audio.currentTime,
      duration,
      seekableStart: generating ? bufferedStart : 0,
      seekableEnd: generating ? Math.min(bufferedEnd, duration) : duration,
      generatedEnd: generating ? Math.min(activeStream.generatedSeconds(), duration) : duration,
      generating
    };
  }

  // The media load algorithm resets playbackRate to defaultPlaybackRate, so set both.
  function applyPlaybackRate(element) {
    if (!element) return;
    element.defaultPlaybackRate = playbackRate;
    element.playbackRate = playbackRate;
  }

  function setPlaybackRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return;
    playbackRate = value;
    applyPlaybackRate(audioElement);
  }

  function seek(seconds) {
    const audio = audioElement;
    const progress = getPlaybackProgress();
    if (!audio || !progress || !Number.isFinite(seconds)) return;
    // Stay a hair inside the buffered edge so a streaming seek doesn't stall.
    const maxTime = progress.generating ? Math.max(progress.seekableStart, progress.seekableEnd - 0.25) : progress.seekableEnd;
    audio.currentTime = Math.min(Math.max(seconds, progress.seekableStart), maxTime);
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

  function getCachedAudioBlob(bubbleId) {
    if (audioCache.has(bubbleId)) return audioCache.get(bubbleId);
    for (const [key, blob] of audioCache) {
      if (String(key).startsWith(`${bubbleId}:`)) return blob;
    }
    return null;
  }

  function getCachedAudioDataUrl(bubbleId) {
    const blob = getCachedAudioBlob(bubbleId);
    if (!blob) return Promise.resolve('');
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  }

  return {
    play,
    playArticle,
    pause,
    resume,
    stop,
    seek,
    setPlaybackRate,
    getPlaybackRate: () => playbackRate,
    getPlaybackProgress,
    buildGeneratedAudioPath,
    getLocalVoices,
    getElevenLabsVoices,
    getKokoroVoices,
    getChatterboxVoices,
    getVoiceboxLabVoices,
    getLastAudioBlob: () => lastAudioBlob,
    getAllCachedAudio: () => audioCache,
    getCachedAudioDataUrl,
    hasCachedAudio: (bubbleId) => !!getCachedAudioBlob(bubbleId),
    isPlaying: () => playingBubbleId !== null && !isPaused,
    isPaused: () => isPaused,
    getPlayingBubbleId: () => playingBubbleId
  };
}
