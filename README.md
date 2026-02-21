# Sidekick

A Chrome extension that adds a floating chat window to any webpage, letting you chat with AI about the page you're viewing. It automatically extracts the page content (or YouTube transcript) as context.

Uses your own API key. No server, no account, no data collection.

## Features

- **Page context** — Automatically extracts the current page's text content and sends it as context
- **YouTube transcripts** — On YouTube videos, extracts the full transcript with timestamps instead of page text
- **Screenshot capture** — Click the camera button to screenshot the visible page and ask Claude about it
- **Streaming responses** — Real-time token-by-token streaming from the API
- **Markdown rendering** — Responses render with proper formatting (bold, code blocks, headers, lists, links)
- **Image support** — Drag and drop images into the chat to ask about them
- **Text-to-Speech** — Listen to responses with browser voices (free) or ElevenLabs (premium). Play, pause, and resume controls on each message.
- **Copy responses** — Hover over any response to reveal copy and speak buttons
- **Auto-save conversations** — Conversations and ElevenLabs audio are automatically saved as markdown + MP3 files when a tab closes
- **Dark mode** — Auto (follows system), Light, or Dark theme
- **Custom system prompt** — Add persistent instructions to every conversation (e.g. "always respond in Spanish")
- **Multiple models** — Choose from Opus 4, Sonnet 4, Haiku 4.5, or Haiku 3.5
- **Slash commands** — Built-in commands like `/tldr` and `/explain`, plus create your own
- **Command pills** — Quick-access buttons on the welcome screen for all your commands
- **Command autocomplete** — Type `/` to see available commands with descriptions
- **Conversation download** — Export any conversation as a `.md` file
- **Resizable window** — Drag the left, top, or corner edges to resize; size is remembered
- **Full-height by default** — Opens at full viewport height for maximum reading space
- **Font selection** — Choose from 5 fonts (System, Inter, DM Sans, IBM Plex Sans, Source Sans 3)
- **Settings export/import** — Back up and restore your settings and custom commands
- **Per-tab isolation** — Each tab has its own independent conversation
- **Shadow DOM isolation** — The chat UI is fully isolated from the host page's styles

## Install

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `sidekick` folder
5. Click the extension icon on any page to open the chat
6. Click the gear icon to open settings and enter your [API key](https://console.anthropic.com/settings/keys)

## Usage

**Open the chat** — Click the extension icon in the toolbar. The chat window appears in the bottom-right corner at full height.

**Ask about the page** — The page content is automatically loaded as context. Ask questions and it will reference it.

**Use commands** — Type `/tldr` to get a summary, `/explain` for a simple explanation, `/key` for key takeaways, or `/translate [language]` to translate. Or click any command pill on the welcome screen.

**Take a screenshot** — Click the camera icon in the header to capture the visible page. The screenshot appears as a preview — type a question about it and send.

**Send images** — Drag and drop an image into the chat window. It appears as a preview below the input. Send a message to analyze the image.

**Listen to responses** — Hover over any assistant message and click "Speak" to hear it read aloud. Click "Pause" to pause, "Resume" to continue. Configure the voice engine in Settings.

**Copy a response** — Hover over any assistant message and click the "Copy" button that appears below it.

**Download conversation** — Click the download icon in the header to save the conversation as a markdown file.

**Discard context** — Click the X on the context banner if you want to chat without page context.

**Close** — Click the X button to hide the chat. The conversation is preserved until you close or navigate away from the tab.

## Settings

Open settings via the gear icon in the chat header, or from `chrome://extensions` > Sidekick > Options.

| Setting | Description |
|---------|-------------|
| **API Key** | Your API key (starts with `sk-ant-`) |
| **Model** | Opus 4 (smartest), Sonnet 4 (recommended), Haiku 4.5 (fastest), Haiku 3.5 (budget) |
| **Custom System Prompt** | Instructions added to every conversation (optional) |
| **Max Context** | Maximum characters of page content to send (default: 10,000) |
| **TTS Engine** | Browser (free) or ElevenLabs (premium) |
| **Browser Voice** | Select from available system voices, grouped by language |
| **ElevenLabs API Key** | Your ElevenLabs key for premium voice synthesis |
| **ElevenLabs Voice** | Choose from available ElevenLabs voices |
| **Save Location** | Conversations auto-save to `Downloads/Temp/sidekick-logs/` on tab close |
| **Theme** | Auto (follows system), Light, or Dark |
| **Font** | Choose the chat font from 5 options |
| **Commands** | Add, edit, or delete custom slash commands |
| **Export/Import** | Back up settings and commands as JSON (API key excluded for security) |

## Built-in Commands

| Command | What it does |
|---------|-------------|
| `/tldr` | Summarize the page content |
| `/explain` | Explain the content in simple terms |
| `/key` | List key takeaways |
| `/translate [language]` | Translate content to a language |

Add any text after a command to refine it — e.g. `/tldr 3 bullet points` sends "Provide a TL;DR summary of the page content. 3 bullet points".

## File Structure

```
sidekick/
  manifest.json      Extension config (Manifest V3)
  background.js      Service worker (icon click, settings, screenshot capture, conversation auto-save)
  content.js         Content script (Shadow DOM UI, page extraction, resize, images, TTS controls)
  chat.js            API streaming, message history, markdown, commands
  tts.js             Text-to-Speech engine (browser voices + ElevenLabs)
  youtube.js         YouTube transcript extraction
  chat.css           Chat window styles (loaded inside Shadow DOM)
  options.html       Settings page
  options.js         Settings logic (including TTS configuration)
  options.css        Settings page styles
  icons/             Extension icons (16, 32, 48, 128px)
```

## How It Works

- Clicking the extension icon sends a message to the content script, which creates a Shadow DOM container on the page
- The Shadow DOM isolates the chat UI from the host page's CSS and JavaScript
- Page content is extracted by cloning the body, stripping non-content elements (nav, footer, scripts, ads), and taking the inner text
- On YouTube, the transcript is extracted using YouTube's internal transcript API, with a fallback method that intercepts caption network requests via PerformanceObserver
- Screenshots use `chrome.tabs.captureVisibleTab()` and are sent through the same vision pipeline as drag-and-drop images
- API calls go directly from the browser using the `anthropic-dangerous-direct-browser-access` header for CORS — no proxy server needed
- TTS uses the Web Speech API for free browser voices, or ElevenLabs REST API for premium voices with MP3 caching per message
- Conversations are synced to `chrome.storage.local` after each assistant response and auto-saved to disk when a tab closes

## Privacy

This extension is designed to keep your data local. Here's exactly what happens:

**What stays on your device:**
- Your API key (stored in `chrome.storage.local`, never transmitted anywhere except the API)
- Your ElevenLabs API key (same — only sent to ElevenLabs when TTS is used)
- Settings, custom commands, and UI preferences
- Saved conversations and audio files (in `Downloads/Temp/sidekick-logs/`)

**What gets sent to the API (`api.anthropic.com`):**
- Your messages and conversation history (for the current tab)
- Page content or YouTube transcript, if context is active
- Images and screenshots you attach (as base64)
- API calls go directly from your browser — the API provider can see your IP address

**What gets sent to ElevenLabs (`api.elevenlabs.io`) — only if you enable ElevenLabs TTS:**
- The text of assistant messages you click "Speak" on
- Your ElevenLabs API key for authentication

**What gets sent to Google (`fonts.googleapis.com`):**
- A font request only when you select a non-system font in settings. If you use "System Default" (the default), no request to Google is made.

**What is NOT collected:**
- No analytics, telemetry, or tracking of any kind
- No data sent to any server other than Anthropic (and optionally ElevenLabs and Google Fonts)
- No browsing history or page URLs are stored or transmitted (URLs are only included in the system prompt when context is active)
- Settings exports exclude your API keys

## Requirements

- Chrome (or Chromium-based browser)
- An [API key](https://console.anthropic.com/settings/keys) from Anthropic
- (Optional) An [ElevenLabs API key](https://elevenlabs.io) for premium text-to-speech

## License

[MIT](LICENSE)
