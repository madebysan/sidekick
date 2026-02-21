// API streaming, message history, markdown rendering, and commands
// This file is loaded inside content.js scope (not a separate script)

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
    let prompt = 'You are a helpful assistant.';
    if (customPrompt) {
      prompt += `\n\n${customPrompt}`;
    }
    if (pageContext && pageContext.content) {
      prompt += `\n\nThe user is viewing a webpage and wants to discuss it with you.\n\nPage title: ${pageContext.title}\nPage URL: ${pageContext.url}\n\n--- PAGE CONTENT ---\n${pageContext.content}\n--- END PAGE CONTENT ---\n\nAnswer the user's questions based on the page content above. If the user asks something unrelated to the page, answer normally.`;
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
      chrome.storage.local.get(['apiKey', 'model', 'maxContext', 'customSystemPrompt'], resolve);
    });

    if (!settings.apiKey) {
      onError('No API key set. Click the gear icon to open settings.');
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
    const model = settings.model || 'claude-sonnet-4-20250514';
    const body = {
      model: model,
      max_tokens: 4096,
      stream: true,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    };

    const finalSystemPrompt = buildSystemPrompt(settings.customSystemPrompt || '');
    if (finalSystemPrompt) {
      body.system = finalSystemPrompt;
    }

    // Start streaming
    abortController = new AbortController();
    isStreaming = true;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
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

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

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
