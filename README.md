<p><img src="screenshots/icon.png" width="128" height="128" alt="Sidekick app icon"></p>

<h1>Sidekick</h1>

<p>Chat with AI about the page you're reading.<br>
A private floating chat. Not an AI browser, not a sidebar. Bring your own API key.</p>

<p>
  <img src="https://img.shields.io/badge/Brave%20%2B%20Chrome-4285f4" alt="Brave and Chrome">
  <img src="https://img.shields.io/badge/Manifest%20V3-4285f4" alt="Manifest V3">
  <img src="https://img.shields.io/badge/JavaScript-f7df1e" alt="JavaScript">
  <img src="https://img.shields.io/badge/BYO%20AI%20Key-c96442" alt="Bring your own AI key">
</p>

<p>
  <a href="https://chromewebstore.google.com/detail/sidekick/bniahajjmpkajkpeelflghnaapjgmcbn"><img src="https://developer.chrome.com/static/docs/webstore/branding/image/mPGKYBIR2uCP0ApchDXE.png" alt="Available in the Chrome Web Store" height="58"></a>
</p>

https://github.com/user-attachments/assets/7db58286-4408-4089-ad71-3491e354b1b4

Most AI browser integrations prioritize convenience over privacy. Some AI Chrome extensions are decent, but they usually just are sidebar chats. My use cases are simple: I'm reading something or watching a video, and I want to act on that content, either save it, summarize it, or run it through different commands/prompts. It doesn't need to proactively take screenshots of what I'm doing or read my content. I built Sidekick with all of this in mind.

It works as a floating chat that imports the content of the tab when it was triggered at the moment you send your first message but you can clear that context if it's irrelevant for your message. It also is able to take screenshots of the active tab if you need the context to be visual. You can import local files as well. Every conversation is optionally saved locally so summaries or specific workflows are never lost. You can even use your ElevenLabs API key if you want to listen to the answers instead of reading them, which is useful if what you want is to "listen to articles" like you do with services like Speechify.

The real strength comes with your custom commands, which are shortcuts for reusable prompts.

Sidekick is not for people who want an autonomous browsing agent. It's for those who want to power up their browsing experience without sacrificing privacy.

## Install

1. Clone or download this repository
2. Open `brave://extensions` in Brave or `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Click the extension icon on any page to open the chat
6. Click the gear icon, pick your provider (Anthropic, OpenAI, Fal.ai, Gemini, DeepSeek, or Local), and enter any required API key

## Keyboard shortcut

Sidekick doesn't ship a default shortcut. To assign one, go to `chrome://extensions/shortcuts` (or `brave://extensions/shortcuts` on Brave) and bind the Sidekick action to any key combination. Same path works on Edge and other Chromium-based browsers.

Typing in the floating chat stays inside Sidekick. The chat runs in a closed Shadow DOM and stops keyboard events once they reach the chat, so normal page shortcuts should not fire while you write. Extensions that intercept keys before the page sees them still need their own text-field guard.

## Features

### Automatic context extraction
Open Sidekick on any webpage and it reads the page content for you. Ask questions, get summaries, or analyze what you're reading. If you submit the first message while page or transcript extraction is still running, Sidekick keeps the message queued and shows a loading state before contacting the model.

The context banner shows the current tab name as soon as Sidekick opens, so you can discard page or video context before typing. It hides once you start a message. On YouTube, a download button appears beside discard once the transcript is ready, so you can save it as a source-named text file before starting the chat.

### Web search
Turn **Web search** on in Settings → Provider (it stays on by default when a Fal key is present). Sidekick then lets Claude, GPT-5, or Gemini 3 models on Fal search the live web. Fal and search fallback default to **Gemini 3.8 Flash**. Models that can't search (DeepSeek, Qwen, Local) are hidden from the chat's model picker while search is on. `/tldr`, `/podcast`, `/questions`, and `/contrarian` stay on the current tab. `/research` uses search when it is on. Search queries go to Fal/OpenRouter and add search cost to the Fal bill.

<p align="center">
  <img src="screenshots/youtube.png" width="100%" alt="Sidekick YouTube transcript summary with /tldr command">
</p>

### Screenshot capture
Click the camera button to capture the visible page and ask about what you see. Uses the same vision pipeline as drag-and-drop images.

<p align="center">
  <img src="screenshots/vision.png" width="100%" alt="Sidekick image recognition identifying a camera">
</p>

### Slash commands
Built-in: `/tldr`, `/podcast`, and `/questions` show as pills on the empty chat. `/contrarian` and `/research` are also built in, but stay off the empty chat until you turn their Settings switch on. Add text after any command to refine it. Example: `/tldr 3 bullet points`. All commands still work by typing `/name`.

Create your own in Settings. Edit or delete the built-ins if you don't like them. New commands stay off the empty chat until you turn their switch on.

Enable **Settings → Commands → Auto-submit command on start** to send a command automatically when you open an empty chat. It is off by default, with `/tldr` selected. Choose any built-in or custom command under **Default command**, including commands hidden from the empty-chat pills. Submission waits for page or transcript context. Existing conversations, drafts, attachments, and discarded context are left alone. Renaming the selected command keeps it selected; deleting it skips automatic submission until you choose an available command.

### Text-to-speech
Hover any assistant response and click **Speak** to hear it read aloud. Click the speaker button in the chat header to listen to the current article or YouTube transcript directly, without asking a model to rewrite it first. Header Listen defaults to ElevenLabs and streams, so sound starts within about a second.

Both use the same player strip under the header: play/pause, elapsed and total time, a seek bar, a speed button (1x, 1.1x, 1.25x, 1.5x, 2.5x), an MP3 download, and an X that stops and closes it. While ElevenLabs is still generating, total time is an estimate and you can seek only within audio made so far; once the full MP3 is ready, the whole file is seekable. The reply being read gets a thin outline. Free browser voices and a local Kokoro server are also available in Settings.

<p align="center">
  <img src="screenshots/settings.png" width="100%" alt="Sidekick settings page with TTS, custom commands, and font selection">
</p>

### Floating button
Enable a small Sidekick button that sits in the corner of every page so you can open the chat without hunting for the toolbar icon. Toggle it under **Settings → Appearance**.

### Also
Drag-and-drop images, streaming responses with a Stop that always works, markdown rendering, direct page listening, YouTube transcript download, optional auto-save on tab close, multiple models, custom system prompt, explicit local memory, dark mode, resizable window, font selection, conversation download, settings export/import, per-tab isolation, Shadow DOM isolation.

## Settings

Open via the gear icon in the chat header, or from `chrome://extensions` → Sidekick → Options.
In Brave, use `brave://extensions` instead.

| Setting | Description |
|---------|-------------|
| **Provider** | Anthropic (Claude), OpenAI, Fal.ai (OpenRouter), Gemini, DeepSeek, or Local (LM Studio). Each keeps its own model setting, and cloud providers keep their own API key. |
| **API Key** | Key for the selected cloud provider. Anthropic keys start with `sk-ant-`; get an OpenAI key at [platform.openai.com](https://platform.openai.com/api-keys), a Fal key at [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys), or a DeepSeek key at [platform.deepseek.com](https://platform.deepseek.com/api_keys). Local does not need a provider API key. |
| **Local Endpoint** | LM Studio's server URL. You can paste `http://127.0.0.1:1234` or the full chat endpoint; Sidekick uses `/v1/chat/completions`. localhost and 127.0.0.1 endpoints are supported. |
| **Model** | Cloud model lists refresh from provider APIs. Fal.ai model choices refresh from OpenRouter's public model catalog because fal's `openrouter/router` endpoint accepts OpenRouter model IDs; the chat's model picker shows the newest few per main lab, and Settings lists everything. Local models refresh from LM Studio's `/v1/models` endpoint, with a small fallback list if LM Studio is not running. |
| **Custom System Prompt** | Added to every conversation (optional) |
| **Memory** | Explicit preferences Sidekick should remember, one per line. Type `remember ...` in chat or edit memory in Settings. |
| **Max Context** | Maximum characters of page content to send (default: 60,000) |
| **TTS Engine** | ElevenLabs (default), Kokoro (local server), or Browser (free) |
| **Browser Voice** | Select from available system voices, grouped by language |
| **Kokoro Endpoint** | Your local Kokoro server URL, defaulting to `http://localhost:8789`. The server needs `/config` and `/download` routes; none is included here. |
| **Kokoro Voice** | Choose from voices returned by your local Kokoro server |
| **ElevenLabs API Key** | Your ElevenLabs key for premium voice synthesis |
| **ElevenLabs Voice** | Choose from available ElevenLabs voices |
| **ElevenLabs Model** | Flash v2.5 (default: fastest start, half the credits) or Multilingual v2 (most natural). Audio streams, so playback starts after the first sentence or two |
| **Auto-Download Generated Audio** | Save each generated MP3 once it is fully generated (ElevenLabs keeps playing meanwhile) |
| **Save Generated Audio To** | Subfolder of Downloads for auto-downloaded and MP3-button audio. Empty means Downloads itself |
| **Auto-Save Conversations** | Download chat history and generated audio to `Downloads/Temp/sidekick-logs/` when a tab closes. Enabled by default. |
| **Floating Button** | Show a small Sidekick button on every page |
| **Theme** | Auto (follows system), Light, or Dark |
| **Chat style** | Glass (default, frosted overlay) or Classic (solid window). Switch anytime. |
| **Font** | System Default (no download) by default, plus DM Sans, IBM Plex Sans, and Source Sans 3 from Google Fonts |
| **Commands** | Add, edit, or delete custom slash commands. A switch on each command shows it as a pill on the empty chat; `/name` still works when the switch is off. |
| **Auto-submit command on start** | Off by default. Automatically sends the selected **Default command** (`/tldr` initially) with page context when you open an empty chat. Uses your selected provider. Included in settings export/import. |
| **Export/Import** | Back up settings, commands, and memory as JSON (API keys excluded for security) |

## Commands

| Command | What it does |
|---------|-------------|
| `/tldr` | Summarize the content with key takeaways and a Worth your time recommendation |
| `/podcast` | Turn an article into a natural, accurate read-aloud summary |
| `/questions` | Turn the content into a top-five FAQ with concise answers |
| `/contrarian` | Push back on the source from the strongest fair objections, without inventing an opposite tribe |
| `/research` | Start from the page, then use web search when it is on to check claims and gather related sources |

Add text after any command to refine it. Create your own in Settings.

## Privacy

There is no hosted Sidekick server. API keys, conversations, memory, and settings stay in `chrome.storage.local`. Chat and speech content leave the browser when you send a message, click **Speak**, click **Listen**, or open an empty chat with **Auto-submit command on start** enabled. Auto-submit sends the selected command and active page context through the same provider path as a manual message.

- Messages, page content, memory preferences, and any attached images go directly from your browser to the provider you pick: `api.anthropic.com` for Claude, `api.openai.com` for OpenAI, `fal.run` for Fal.ai, `generativelanguage.googleapis.com` for Gemini, `api.deepseek.com` for DeepSeek, or your configured local endpoint. Cloud providers see your IP address. Fal.ai can analyze images when the selected OpenRouter model supports vision (Claude, GPT, or Gemini). DeepSeek is text-only in Sidekick. Local image analysis is available when the selected LM Studio model is Gemma 4.
- TTS text goes to your local Kokoro server only when you choose that engine and click **Speak** or **Listen**. TTS text and the ElevenLabs key go to `api.elevenlabs.io` only when you enable ElevenLabs and click **Speak** or **Listen**.
- The default font is your system font and makes no network request. If you pick DM Sans, IBM Plex Sans, or Source Sans 3, it loads from `fonts.googleapis.com` when the chat opens, so Google sees your IP address and the site you are on. The Settings page also loads those three fonts from Google to preview them.
- No analytics, telemetry, tracking, or browsing-history collection. Settings exports exclude API keys.

## Requirements

- Brave, Chrome, or another Chromium-based browser
- An [Anthropic API key](https://console.anthropic.com/settings/keys) for Claude, an [OpenAI API key](https://platform.openai.com/api-keys), a [Fal API key](https://fal.ai/dashboard/keys), a [DeepSeek API key](https://platform.deepseek.com/api_keys) for DeepSeek V4, or LM Studio with the local server enabled for local models
- (Optional) An [ElevenLabs API key](https://elevenlabs.io) for the default Listen/Speak path, or your own Kokoro server at `http://localhost:8789`

## Known limitations

- **Page extraction is heuristic.** Chat context uses a cleaned DOM extraction path. Header Listen uses Readability.js first, then falls back to the cleaned DOM path. Sites with unusual DOM structures or heavy client-side rendering may return partial context. Bump **Max Context** in Settings if you're seeing truncated input.
- **Max Context defaults to 60,000 characters.** Very long articles or transcripts still get truncated. Raise the limit in Settings when working with longer local-context runs and a model loaded with enough context. If LM Studio rejects a local request because the model was loaded with a small context window, Sidekick retries with configured DeepSeek for text-only messages, or retries locally with shorter context.
- **Local vision is model-specific.** Gemma 4 in LM Studio can analyze screenshots and drag-and-drop images. Other local text models are blocked from image sends.
- **Fal vision is model-specific.** Claude, GPT, and Gemini on Fal can analyze screenshots. DeepSeek on Fal stays text-only.
- **ElevenLabs seeking catches up.** While a long page is still generating you can only jump within audio made so far. With Flash v2.5 a long article usually finishes in well under a minute.
- **Silent providers time out.** If a Fal, Gemini, or OpenAI stream sends nothing for two minutes, Sidekick shows an error instead of waiting. Stop works at any point.

## Tech stack

- Chromium Manifest V3. Vanilla JavaScript, no framework, no build step.
- Anthropic Messages API for Claude chat and vision, OpenAI Chat Completions, Fal.ai's `openrouter/router` endpoint, DeepSeek's Anthropic-compatible endpoint for DeepSeek V4, and LM Studio's OpenAI-compatible chat endpoint for local models. Provider model lists refresh through each provider's own Models API where available. Fal model choices refresh from OpenRouter's public model catalog and cache locally for fallback.
- [Readability.js](https://github.com/mozilla/readability) (Apache 2.0, bundled in `vendor/`) for direct article listening.
- Web Speech API, a local Kokoro server (`/config` + `/download`), and the ElevenLabs streaming API (played through MediaSource) for TTS.
- Closed Shadow DOM for UI isolation from the host page's CSS and JavaScript, with keyboard events kept inside the chat while typing.
- Zero npm dependencies.

## Development

There is no build step. Load the folder unpacked (see [Install](#install)), edit, then click **Reload** on the Sidekick card in `chrome://extensions` and refresh the page you're testing.

Run the provider adapter check after touching `chat.js`, `providers.js`, or `prompts.js`:

```bash
node scripts/test-provider-adapters.mjs
```

## Feedback

Found a bug or have a feature idea? [Open an issue](https://github.com/madebysan/sidekick/issues).

## License

[MIT](LICENSE)

---

Made by [santiagoalonso.com](https://santiagoalonso.com)
