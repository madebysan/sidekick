// API streaming, message history, markdown rendering, and commands
// This file is loaded inside content.js scope (not a separate script)

// Provider config. DeepSeek exposes an Anthropic-compatible Messages API, so
// the request body and SSE response shape are identical to Anthropic's — only
// the endpoint, auth headers, and image support differ. Keep this the single
// source of truth for both. (Must stay in sync with PROVIDERS in options.js.)
const PROVIDERS = {
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-20250514',
    supportsImages: true,
    bodyExtras: {},
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    })
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    defaultModel: 'deepseek-v4-flash',
    supportsImages: false,
    // DeepSeek V4 turns on chain-of-thought by default, which adds latency and
    // burns the token budget before any answer streams. Disable it for a snappy
    // chat; the answer arrives immediately as text_delta.
    bodyExtras: { thinking: { type: 'disabled' } },
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    })
  }
};

/**
 * Create a ChatEngine instance for a single tab
 */
function createChatEngine() {
  let messages = [];       // Array of {role: 'user'|'assistant', content: string|array}
  let systemPrompt = '';   // Page context injected here
  let pageContext = null;   // {title, url, content, type} — kept for export
  let abortController = null;
  let isStreaming = false;
  let commands = [];

  // Load commands from storage
  chrome.storage.local.get('commands', (result) => {
    commands = result.commands || [
      { name: 'tldr', prompt: 'Provide a TL;DR summary of the page content.' },
      { name: 'explain', prompt: 'Explain this content in simple terms as if I\'m not an expert.' },
      { name: 'translate', prompt: 'Translate the following to' },
      { name: 'key', prompt: 'List the key takeaways from this content.' }
    ];
  });

  // Listen for command updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.commands) {
      commands = changes.commands.newValue || [];
    }
  });

  /**
   * Build the system prompt from custom prompt + page context
   */
  function buildSystemPrompt(customPrompt) {
    let prompt =
`You are Sidekick, an assistant built into the user's browser that helps them quickly understand and act on what they're reading or watching.

Formatting and style:
- Write in clean Markdown. Use **bold** for key terms, "-" bullets for lists, and numbered lists for ordered steps. Add a short "##" subheading only when a reply has clearly separate sections.
- Lead with the answer. No filler openings ("Sure!", "Great question", "In this article..."), and never restate the question back.
- Be concise and skimmable. Prefer a few information-dense bullets over many shallow ones, and don't pad to seem thorough.
- Match the response to the request: a short question gets a short, direct answer. Only summaries and overviews get the full structure below.
- Use plain punctuation. Do not use em-dashes; use commas, colons, or separate sentences instead.`;

    if (customPrompt) {
      prompt += `\n\nThe user added these instructions, which take priority over the defaults above:\n${customPrompt}`;
    }

    if (pageContext && pageContext.content) {
      const isVideo = pageContext.type === 'youtube';
      const sourceLine = isVideo ? 'watching a YouTube video' : 'reading a web page';
      const sourceNote = isVideo
        ? 'The text below is the video transcript. It may contain transcription errors and lacks punctuation, speaker labels, and timestamps, so focus on meaning rather than exact wording.'
        : 'The text below was extracted from the page and may include leftover navigation or formatting noise, and may be truncated. Focus on the main content and ignore the noise.';

      prompt +=
`\n\nThe user is currently ${sourceLine}.
Title: ${pageContext.title}
URL: ${pageContext.url}
${sourceNote}

--- CONTENT ---
${pageContext.content}
--- END CONTENT ---

Base your answers on this content. When the user asks for a summary, TL;DR, key points, or overview, use this structure:
- **Overview**: 1-2 sentences on what it covers and its core point or thesis.
- **Key points**: the main ideas, arguments, or segments, as bullets.
- **Action items**: concrete steps, recommendations, or things to try, as bullets. Include this section only if the content actually offers them.
- **Bottom line**: one sentence with the single most useful takeaway.
Omit any section that does not apply instead of inventing content to fill it, and never claim the content says something it does not. Keep the whole summary tight enough to read in well under a minute. For any other kind of question, answer directly and add structure only when it helps. If the user asks about something the content does not cover, answer from general knowledge and say so briefly.`;
    }

    return prompt;
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

  /**
   * Send a message and stream the response
   * @param {string} userText - The user's message
   * @param {Array} images - Array of {base64, mediaType} objects
   * @param {Function} onToken - Called with each text token as it arrives
   * @param {Function} onDone - Called when streaming is complete
   * @param {Function} onError - Called on error
   */
  async function sendMessage(userText, images, onToken, onDone, onError) {
    // Get settings
    const settings = await new Promise(resolve => {
      chrome.storage.local.get(
        ['provider', 'apiKey', 'model', 'deepseekApiKey', 'deepseekModel', 'maxContext', 'customSystemPrompt'],
        resolve
      );
    });

    // Resolve the active provider, key, and model
    const providerId = settings.provider === 'deepseek' ? 'deepseek' : 'anthropic';
    const provider = PROVIDERS[providerId];
    const apiKey = providerId === 'deepseek' ? settings.deepseekApiKey : settings.apiKey;
    const model = (providerId === 'deepseek' ? settings.deepseekModel : settings.model) || provider.defaultModel;

    if (!apiKey) {
      onError('No API key set. Click the gear icon to open settings.');
      return;
    }

    // DeepSeek has no vision — block image sends with a clear message instead of a raw API error
    if (images && images.length > 0 && !provider.supportsImages) {
      onError('DeepSeek models don’t support images. Switch to a Claude model in Settings to analyze images.');
      return;
    }

    // Expand commands
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

    // Build API request
    const body = {
      model: model,
      max_tokens: 4096,
      stream: true,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      ...provider.bodyExtras
    };

    const finalSystemPrompt = buildSystemPrompt(settings.customSystemPrompt || '');
    if (finalSystemPrompt) {
      body.system = finalSystemPrompt;
    }

    // Start streaming
    abortController = new AbortController();
    isStreaming = true;

    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers: provider.buildHeaders(apiKey),
        body: JSON.stringify(body),
        signal: abortController.signal
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error?.message || `API error: ${response.status}`;
        messages.pop(); // Remove the user message since it failed
        onError(errorMsg);
        isStreaming = false;
        return;
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_delta') {
              const text = event.delta?.text || '';
              if (text) {
                fullResponse += text;
                onToken(text);
              }
            } else if (event.type === 'message_stop') {
              break;
            } else if (event.type === 'error') {
              onError(event.error?.message || 'Stream error');
              isStreaming = false;
              return;
            }
          } catch (e) {
            // Skip malformed JSON lines
          }
        }
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: fullResponse });
      isStreaming = false;
      onDone(fullResponse);

    } catch (e) {
      isStreaming = false;
      if (e.name === 'AbortError') {
        // User stopped the response — save partial text to history so Claude has context
        if (fullResponse) {
          messages.push({ role: 'assistant', content: fullResponse });
        }
        onDone(fullResponse || '');
        return;
      }
      messages.pop(); // Remove failed user message
      onError(e.message || 'Network error');
    }
  }

  /**
   * Stop the current streaming response
   */
  function stopStreaming() {
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

/**
 * Lightweight Markdown renderer
 * Handles: bold, italic, inline code, code blocks, headers, lists, links, paragraphs
 */
function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML
  let html = text
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
