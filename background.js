// Service worker: handles icon click, settings page, TTS downloads, and conversation auto-save

// When extension icon is clicked, toggle the chat panel
chrome.action.onClicked.addListener(async (tab) => {
  // Don't run on chrome:// or extension pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleChat' });
  } catch (e) {
    // Content script not yet injected — inject it manually
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['youtube.js', 'chat.js', 'tts.js', 'content.js']
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
  if (message.action === 'openSettings') {
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
    });
    return false;
  } else if (message.action === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      sendResponse(dataUrl || null);
    });
    return true; // Keep the message channel open for async sendResponse
  }
});

// ─── AUTO-SAVE CONVERSATION ON TAB CLOSE ────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storageKey = `conversation_${tabId}`;

  try {
    const result = await chrome.storage.local.get(storageKey);
    const conversation = result[storageKey];

    if (!conversation || !conversation.messages || conversation.messages.length === 0) {
      return; // No conversation to save
    }

    // Build markdown export
    const markdown = buildConversationMarkdown(conversation);

    // Build a safe folder name from the tab title
    const safeTitle = sanitizeFilename(conversation.tabTitle || 'Untitled');
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

function formatDateForFilename(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}`;
}
