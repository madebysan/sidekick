// YouTube transcript extraction — runs before content.js
// Exposes window.__sidekick_getYouTubeTranscript for content.js to call

(function() {
  'use strict';

  // Only run on YouTube
  if (!location.hostname.includes('youtube.com')) return;

  /**
   * Format seconds to MM:SS or H:MM:SS
   */
  function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Chunk transcript segments into ~10-second groups for readability
   */
  function chunkSegments(segments, chunkDuration = 10) {
    if (!segments.length) return [];
    const chunks = [];
    let currentChunk = { start: segments[0].start, texts: [] };

    for (const seg of segments) {
      if (seg.start - currentChunk.start >= chunkDuration && currentChunk.texts.length > 0) {
        chunks.push({
          timestamp: formatTimestamp(currentChunk.start),
          text: currentChunk.texts.join(' ')
        });
        currentChunk = { start: seg.start, texts: [] };
      }
      if (seg.text.trim()) {
        currentChunk.texts.push(seg.text.trim());
      }
    }

    // Push the last chunk
    if (currentChunk.texts.length > 0) {
      chunks.push({
        timestamp: formatTimestamp(currentChunk.start),
        text: currentChunk.texts.join(' ')
      });
    }

    return chunks;
  }

  /**
   * PRIMARY METHOD: Extract transcript using YouTube's internal API
   * Parses ytInitialData from page scripts to find transcript endpoint params,
   * then calls YouTube's get_transcript API directly.
   */
  async function extractViaPrimaryMethod() {
    // Find ytInitialData in page scripts
    const scripts = document.querySelectorAll('script');
    let ytInitialData = null;

    for (const script of scripts) {
      const text = script.textContent;
      if (text.includes('ytInitialData')) {
        const match = text.match(/ytInitialData\s*=\s*({.+?});/s);
        if (match) {
          try {
            ytInitialData = JSON.parse(match[1]);
          } catch (e) {
            // Try alternative parsing
          }
        }
      }
    }

    // Also check for ytInitialPlayerResponse which may have engagement panels
    let ytPlayerResponse = null;
    for (const script of scripts) {
      const text = script.textContent;
      if (text.includes('ytInitialPlayerResponse')) {
        const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
        if (match) {
          try {
            ytPlayerResponse = JSON.parse(match[1]);
          } catch (e) {}
        }
      }
    }

    // Search for getTranscriptEndpoint params in ytInitialData
    let transcriptParams = null;

    function findTranscriptParams(obj) {
      if (!obj || typeof obj !== 'object' || transcriptParams) return;
      if (obj.getTranscriptEndpoint && obj.getTranscriptEndpoint.params) {
        transcriptParams = obj.getTranscriptEndpoint.params;
        return;
      }
      // Also look for serialized endpoint format
      if (obj.serializedShareEntity && obj.commands) {
        // This is a different format, skip
      }
      for (const key of Object.keys(obj)) {
        findTranscriptParams(obj[key]);
      }
    }

    if (ytInitialData) findTranscriptParams(ytInitialData);
    if (!transcriptParams && ytPlayerResponse) findTranscriptParams(ytPlayerResponse);

    if (!transcriptParams) {
      throw new Error('No transcript endpoint found in page data');
    }

    // Call YouTube's transcript API
    const response = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250926.00.00'
          }
        },
        params: transcriptParams
      })
    });

    if (!response.ok) {
      throw new Error(`Transcript API returned ${response.status}`);
    }

    const data = await response.json();

    // Parse transcript segments from the response
    // The response structure has actions > updateEngagementPanelAction > content > transcriptRenderer > body > transcriptBodyRenderer > cueGroups
    let cueGroups = null;

    function findCueGroups(obj) {
      if (!obj || typeof obj !== 'object' || cueGroups) return;
      if (Array.isArray(obj.cueGroups)) {
        cueGroups = obj.cueGroups;
        return;
      }
      // Also look for initialSegments format
      if (Array.isArray(obj.initialSegments)) {
        cueGroups = obj.initialSegments;
        return;
      }
      for (const key of Object.keys(obj)) {
        findCueGroups(obj[key]);
      }
    }

    findCueGroups(data);

    if (!cueGroups || cueGroups.length === 0) {
      throw new Error('No transcript cue groups found in response');
    }

    // Parse cue groups into segments
    const segments = [];
    for (const group of cueGroups) {
      // Handle cueGroup format
      const cue = group.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer
        || group.transcriptSectionHeaderRenderer;

      if (!cue) continue;

      const startMs = parseInt(cue.startOffsetMs || '0', 10);
      const durationMs = parseInt(cue.durationMs || '0', 10);
      const textRuns = cue.cue?.simpleText || cue.cue?.runs?.map(r => r.text).join('') || '';

      if (textRuns.trim()) {
        segments.push({
          text: textRuns.trim(),
          start: startMs / 1000,
          duration: durationMs / 1000
        });
      }
    }

    if (segments.length === 0) {
      throw new Error('Parsed zero segments from transcript response');
    }

    return chunkSegments(segments);
  }

  /**
   * FALLBACK METHOD: Intercept caption network requests via PerformanceObserver
   * Clicks the CC button to trigger a timedtext request, intercepts the URL,
   * fetches the JSON transcript, then turns CC back off.
   */
  async function extractViaFallbackMethod() {
    return new Promise((resolve, reject) => {
      let observer = null;
      let resolved = false;

      // Set up PerformanceObserver to watch for timedtext requests
      observer = new PerformanceObserver(async (list) => {
        for (const entry of list.getEntries()) {
          if (entry.name.includes('timedtext') && !resolved) {
            resolved = true;
            observer.disconnect();

            try {
              // Fetch the timedtext URL with json3 format
              let url = entry.name;
              if (!url.includes('fmt=json3')) {
                url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
              }

              const response = await fetch(url);
              const data = await response.json();

              if (!data || !data.events) {
                reject(new Error('Invalid timedtext response'));
                return;
              }

              // Parse events into segments
              const segments = [];
              for (const event of data.events) {
                if (!event.segs) continue;
                const text = event.segs.map(s => s.utf8 || '').join('').trim();
                if (text) {
                  segments.push({
                    text: text,
                    start: (event.tStartMs || 0) / 1000,
                    duration: (event.dDurationMs || 0) / 1000
                  });
                }
              }

              // Turn CC back off
              const ccButton = document.querySelector('.ytp-subtitles-button');
              if (ccButton && ccButton.getAttribute('aria-pressed') === 'true') {
                ccButton.click();
              }

              resolve(chunkSegments(segments));
            } catch (e) {
              reject(e);
            }
          }
        }
      });

      observer.observe({ entryTypes: ['resource'] });

      // Click the CC button to trigger caption loading
      const ccButton = document.querySelector('.ytp-subtitles-button');
      if (!ccButton) {
        observer.disconnect();
        reject(new Error('No CC button found — video may not have captions'));
        return;
      }

      // Only click if CC is currently off
      if (ccButton.getAttribute('aria-pressed') !== 'true') {
        ccButton.click();
      } else {
        // CC already on — turn off and back on to trigger a fresh request
        ccButton.click();
        setTimeout(() => ccButton.click(), 200);
      }

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!resolved) {
          observer.disconnect();
          // Turn CC back off if we turned it on
          const btn = document.querySelector('.ytp-subtitles-button');
          if (btn && btn.getAttribute('aria-pressed') === 'true') {
            btn.click();
          }
          reject(new Error('Timeout waiting for caption data'));
        }
      }, 5000);
    });
  }

  /**
   * Get video metadata from the page
   */
  function getVideoMeta() {
    const title = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent
      || document.querySelector('.ytp-title-link')?.textContent
      || document.title.replace(' - YouTube', '');

    const videoId = new URLSearchParams(location.search).get('v') || '';

    return { title: title.trim(), videoId };
  }

  /**
   * Main entry point — tries primary method, falls back to PerformanceObserver
   */
  async function getYouTubeTranscript() {
    const meta = getVideoMeta();

    try {
      const chunks = await extractViaPrimaryMethod();
      const formatted = chunks.map(c => `[${c.timestamp}] ${c.text}`).join('\n');
      return {
        success: true,
        transcript: formatted,
        title: meta.title,
        videoId: meta.videoId,
        method: 'primary'
      };
    } catch (primaryError) {
      console.log('Sidekick: Primary transcript method failed, trying fallback...', primaryError.message);

      try {
        const chunks = await extractViaFallbackMethod();
        const formatted = chunks.map(c => `[${c.timestamp}] ${c.text}`).join('\n');
        return {
          success: true,
          transcript: formatted,
          title: meta.title,
          videoId: meta.videoId,
          method: 'fallback'
        };
      } catch (fallbackError) {
        console.log('Sidekick: Fallback transcript method also failed', fallbackError.message);
        return {
          success: false,
          error: `Could not extract transcript: ${primaryError.message} / ${fallbackError.message}`,
          title: meta.title,
          videoId: meta.videoId
        };
      }
    }
  }

  // Expose for content.js to call
  window.__sidekick_getYouTubeTranscript = getYouTubeTranscript;
})();
