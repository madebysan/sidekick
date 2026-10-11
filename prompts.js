// Shared Sidekick prompt defaults, migrations, and system prompt assembly.
// Loaded as a browser global and imported by Node QA scripts.

(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SidekickPrompts = api;
})(globalThis, function() {
  'use strict';

  const PROMPTS = {
    tldrCurrent: 'Summarize this for a smart reader. For videos, treat the transcript as one continuous episode, interview, talk, panel, or review by default. Mention "edited compilation" or "excerpt" only when there is clear evidence of multiple separate source segments, such as explicit clip boundaries, unrelated conversations stitched together, changing guests or settings across segments, or source metadata that says it is a compilation. Do not call a normal podcast episode or chaotic interview a compilation, or say it is not a real interview or has no substantive interview, just because it has jump cuts, an ad read, a late-arriving guest, callbacks, taboo topics, role-play, or non-sequiturs. For comedy podcasts, character work, banter, bits, and promotion are the substance; describe that substance instead of saying there is no substance or no new information. For Worth your time on comedy podcasts, if critical, use this shape: "Skip unless you enjoy [specific performer/character] or loose, bit-heavy comedy podcast banter." Never add "with no..." and never say "no substantive interview", "no substance", "no real interview substance", "no interview substance", or "no real information". If the context is marked as metadata-only or limited, do not write a normal full TL;DR: say it is based on limited metadata, summarize only what is known from the title/excerpt/tags/snippet, do not add outside knowledge or model memory, never use "known for", "author of", or "research-backed" unless those words appear in the metadata, never mention other books, products, employers, credentials, or claims associated with an author unless those exact words appear in the metadata, do not infer quality, target audience, or evidence level from author names, brands, URLs, or reputation, include a cautious Worth your time note based only on the literal metadata or saved memory, use exact words from tags/title/excerpt/snippet/memory for interest labels instead of broader inferred categories, do not use adjacent labels like productivity, psychology, behavioral science, cognitive biases, or decision-making unless those exact words appear in the metadata, and if no saved memory directly applies use metadata-only wording such as "Maybe if the title and tags match what you wanted; I cannot judge depth from metadata." End with "Cannot verify from metadata:" plus what the full source would be needed to verify. Use exactly these section labels for normal full-context summaries: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Worth your time: 1 sentence with a direct read/watch/skip recommendation. This can be positive, mixed, or negative. Ground it in the user\'s memory, current workflows, and the source; if memory is not relevant, make a cautious usefulness call from the content itself. Do not force importance; if the content is generic, redundant, or not useful, say so plainly. Avoid a section-by-section recap unless necessary.',
    tldrWhyItMatters: 'Summarize this for a smart reader. For videos, treat the transcript as one continuous episode, interview, talk, panel, or review by default. Mention "edited compilation" or "excerpt" only when there is clear evidence of multiple separate source segments, such as explicit clip boundaries, unrelated conversations stitched together, changing guests or settings across segments, or source metadata that says it is a compilation. Do not call a normal podcast episode or chaotic interview a compilation, or say it is not a real interview or has no substantive interview, just because it has jump cuts, an ad read, a late-arriving guest, callbacks, taboo topics, role-play, or non-sequiturs. For comedy podcasts, character work, banter, bits, and promotion are the substance; describe that substance instead of saying there is no substance or no new information. If the context is marked as metadata-only or limited, do not write a normal full TL;DR: say it is based on limited metadata, summarize only what is known from the title/excerpt/tags/snippet, do not add outside knowledge or model memory, never use "known for" unless those words appear in the metadata, and end with "Cannot verify from metadata:" plus what the full source would be needed to verify. Format: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Why it matters: 1 sentence. Avoid a section-by-section recap unless necessary.',
    tldrOverIndexedCompilation: 'Summarize this for a smart reader. For videos, silently infer the source format (single interview, panel, talk, excerpt, commentary, or compilation), and mention it only when the transcript appears edited, excerpted, or the format changes the summary. If the context is marked as metadata-only or limited, do not write a normal full TL;DR: say it is based on limited metadata, summarize only what is known from the title/excerpt/tags/snippet, do not add outside knowledge or model memory, and include what cannot be verified without the full source. Format: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Why it matters: 1 sentence. Avoid a section-by-section recap unless necessary. Do not claim a video is one uninterrupted segment unless the transcript clearly supports it.',
    tldrLimitedMetadata: 'Summarize this for a smart reader. For videos, silently infer the source format (single interview, panel, talk, excerpt, commentary, or compilation), and mention it only when the transcript appears edited, excerpted, or the format changes the summary. If the context is marked as metadata-only or limited, do not write a normal full TL;DR: say it is based on limited metadata, summarize only what is known from the title/excerpt/tags/snippet, and include what cannot be verified without the full source. Format: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Why it matters: 1 sentence. Avoid a section-by-section recap unless necessary. Do not claim a video is one uninterrupted segment unless the transcript clearly supports it.',
    tldrVideoAware: 'Summarize this for a smart reader. For videos, silently infer the source format (single interview, panel, talk, excerpt, commentary, or compilation), and mention it only when the transcript appears edited, excerpted, or the format changes the summary. Format: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Why it matters: 1 sentence. Avoid a section-by-section recap unless necessary. Do not claim a video is one uninterrupted segment unless the transcript clearly supports it.',
    tldrPrevious: 'Summarize this for a smart reader. Format: TL;DR: 2-3 sentences. Key takeaways: 3-5 bullets. Why it matters: 1 sentence. Avoid a section-by-section recap unless it is necessary.',
    tldrOriginal: 'Summarize this in a concise TL;DR with the main point first, then the key takeaways.',
    tldrLegacy: 'Provide a TL;DR summary of the page content.',
    podcast: 'Turn this article into a natural read-aloud summary, like a short podcast segment. Keep it accurate and grounded in the article, but make it flow conversationally instead of using rigid headings. Preserve the main argument, important context, and the most interesting details. Aim for something useful to listen to, not an over-compressed TL;DR.',
    questions: 'Create a FAQ from this content. Give exactly 5 questions a smart reader would ask, each with a concise answer grounded in the content. Format as Q1/A1 through Q5/A5. Prioritize questions that clarify the main argument, implications, tradeoffs, and what to do next. If the content does not answer a question directly, say so and give the best supported inference.',
    contrarian: 'Push back on this source from the strongest fair objections. Stay on the page: name what it assumes, where the argument is thin, what it ignores, and what a skeptical reader would not buy. Do not invent a culture-war opposite or a fake opposing tribe. Do not steelman so hard that you excuse weak claims. If the extract is too thin (a tweet, headline, or metadata-only snippet) to object well, say so and stop rather than guessing. Format: The claim. The weakest points (bullets). What it assumes. What would change your mind. A one-sentence verdict on how far the source actually gets.',
    research: 'Research this source. Start from the page or transcript, then use live web search when it is available to check claims, find dates, related reporting, and what other serious sources say. Separate: (1) what this source says, (2) what you verified or updated from search, (3) disagreements or missing context, (4) 2-4 links worth opening next. If search is not available, say that up front, work only from the page plus model knowledge, and mark anything that is not in the source. Do not pad with generic background. If the page is ads, navigation, or too thin to research, say so.',
    briefPrePodcast: 'Give me a very short version I can read or listen to in under 20 seconds. Maximum 100 words. No headings except "Brief". Focus only on the core claim, conclusion, and one surprising detail.',
    briefOriginal: 'Give me the shortest useful version of this. Keep it skimmable and only include what matters.',
    explainLegacy: 'Explain this content in simple terms as if I\'m not an expert.',
    translateLegacy: 'Translate the following to',
    keyLegacy: 'List the key takeaways from this content.'
  };

  const GROUNDED_PAGE_COMMANDS = new Set(['tldr', 'podcast', 'questions', 'contrarian']);

  function isGroundedPageCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-z0-9_-]+)\b/i);
    return !!(match && GROUNDED_PAGE_COMMANDS.has(match[1].toLowerCase()));
  }

  const DEFAULT_COMMANDS = [
    { name: 'tldr', prompt: PROMPTS.tldrCurrent, showInEmptyState: true },
    { name: 'podcast', prompt: PROMPTS.podcast, showInEmptyState: true },
    { name: 'questions', prompt: PROMPTS.questions, showInEmptyState: true },
    { name: 'contrarian', prompt: PROMPTS.contrarian, showInEmptyState: false },
    { name: 'research', prompt: PROMPTS.research, showInEmptyState: false }
  ];

  const LEGACY_DEFAULT_COMMAND_SETS = [
    [
      { name: 'tldr', prompt: PROMPTS.tldrCurrent },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrPrevious },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrWhyItMatters },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrOverIndexedCompilation },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrLimitedMetadata },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrVideoAware },
      { name: 'podcast', prompt: PROMPTS.podcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrPrevious },
      { name: 'brief', prompt: PROMPTS.briefPrePodcast },
      { name: 'questions', prompt: PROMPTS.questions }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrOriginal },
      { name: 'brief', prompt: PROMPTS.briefOriginal },
      { name: 'questions', prompt: 'List the smartest questions or follow-ups this raises, grouped by what is worth asking, checking, or deciding next.' }
    ],
    [
      { name: 'tldr', prompt: PROMPTS.tldrLegacy },
      { name: 'explain', prompt: PROMPTS.explainLegacy },
      { name: 'translate', prompt: PROMPTS.translateLegacy },
      { name: 'key', prompt: PROMPTS.keyLegacy }
    ]
  ];

  function cloneCommands(commands) {
    return commands.map(command => ({ ...command }));
  }

  function commandShowsInEmptyState(command) {
    return command?.showInEmptyState !== false;
  }

  function normalizeCommand(command, overrides = {}) {
    const showInEmptyState = Object.prototype.hasOwnProperty.call(overrides, 'showInEmptyState')
      ? overrides.showInEmptyState !== false
      : commandShowsInEmptyState(command);

    return {
      name: String(command?.name || '').trim(),
      prompt: String(command?.prompt || ''),
      showInEmptyState
    };
  }

  function normalizeCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands
      .map(command => normalizeCommand(command))
      .filter(command => command.name && command.prompt);
  }

  function getDefaultCommands() {
    return cloneCommands(DEFAULT_COMMANDS);
  }

  function commandsMatch(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((cmd, index) =>
      cmd.name === b[index].name && cmd.prompt === b[index].prompt
    );
  }

  function shouldMigrateDefaultCommands(storedCommands) {
    return LEGACY_DEFAULT_COMMAND_SETS.some(commandSet => commandsMatch(storedCommands, commandSet));
  }

  function getInitialCommands(storedCommands) {
    if (!storedCommands || shouldMigrateDefaultCommands(storedCommands)) {
      return getDefaultCommands();
    }
    return normalizeCommands(storedCommands);
  }

  function normalizeMemoryList(items) {
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const normalized = [];

    for (const item of list) {
      const value = String(item || '').replace(/\s+/g, ' ').trim();
      if (!value || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      normalized.push(value);
    }

    return normalized.slice(0, 50);
  }

  function isLimitedPageContext(context) {
    if (!context) return false;
    const content = String(context.content || '');
    return Boolean(
      context.limitedContext ||
      context.type === 'metadata' ||
      /^Page content was unavailable or insufficient\./i.test(content) ||
      /^Content fetch was unavailable or insufficient\./i.test(content)
    );
  }

  function buildSystemPrompt({ context = null, customPrompt = '', includeContext = true, userMemory = [] } = {}) {
    let prompt =
`You are Sidekick, an assistant built into the user's browser that helps them quickly understand and act on what they're reading or watching.

Formatting and style:
- Write in clean Markdown. Use **bold** for key terms, "-" bullets for lists, and numbered lists for ordered steps. Add a short "##" subheading only when a reply has clearly separate sections.
- Lead with the answer. No filler openings ("Sure!", "Great question", "In this article..."), and never restate the question back.
- Be concise and skimmable. Prefer a few information-dense bullets over many shallow ones, and don't pad to seem thorough.
- Match the response to the request: a short question gets a short, direct answer. Only summaries and overviews get the full structure below.
- For comedy podcasts or bit-heavy interviews, treat bits, banter, character work, and promotion as the substance. A negative Worth your time note should use this shape: "Skip unless you enjoy [specific performer/character] or loose, bit-heavy comedy podcast banter." Never add "with no..." or say "no substantive interview", "no real interview substance", "no substance", or "no real information".
- Use plain punctuation. Do not use the characters "—" or "–"; use commas, colons, hyphens, or separate sentences instead.`;

    if (customPrompt) {
      prompt += `\n\nThe user added these instructions, which take priority over the defaults above:\n${customPrompt}`;
    }

    const memories = normalizeMemoryList(userMemory);
    if (memories.length > 0) {
      prompt += `\n\nRemember these user preferences across conversations:\n${memories.map(item => `- ${item}`).join('\n')}`;
    }

    if (includeContext && context?.content) {
      const isVideo = context.type === 'youtube';
      const isLimitedContext = isLimitedPageContext(context);
      const sourceLine = isVideo ? 'watching a YouTube video' : isLimitedContext ? 'viewing a web page with limited extracted metadata' : 'reading a web page';
      const sourceNote = isVideo
        ? 'The text below is the video transcript. It may contain transcription errors and lacks punctuation, speaker labels, and timestamps, so focus on meaning rather than exact wording. The title may be an uploader title, not proof of the source format. Default to treating the transcript as one continuous source. Mention an edited compilation or excerpt only when there is clear evidence of multiple separate source segments, such as explicit clip boundaries, unrelated conversations stitched together, changing guests or settings across segments, or source metadata that says it is a compilation. Do not infer compilation from jump cuts, sponsor reads, chaotic comedy, provocative topics, callbacks, role-play, non-sequiturs, or a late-arriving guest. For ordinary podcast episodes, interviews, panels, talks, commentary clips, or reviews, summarize the content without source-format caveats, and do not dismiss a comedic or performative interview as "not a real interview" or as having "no substantive interview" just because the substance is comedy, promotion, banter, bits, or character work. For comedy podcasts, the bits and character work are the substance. In Worth your time notes for comedy podcasts, if critical, use this shape: "Skip unless you enjoy [specific performer/character] or loose, bit-heavy comedy podcast banter." Never add "with no..." and never say "no substantive interview", "no substance", "no real interview substance", "no interview substance", or "no real information". Do not guess continuity, panelist names, show names, or source names unless the transcript or metadata clearly supports them.'
        : isLimitedContext
          ? 'Sidekick could not extract enough readable page content. The text below is limited page metadata and possibly a short visible-text snippet. Do not write as if the source was read. Start summaries with the exact phrase "Based on limited metadata". Use cautious language like "appears to" or "based on the title/excerpt". Hard rule: use only facts literally present in the content. Do not use or mention model memory or outside knowledge, including author background, other works, reputation, reviews, release dates, pricing, examples, mechanisms, facts, audience categories, quality, evidence level, or recommendations unless the user explicitly asks for general knowledge. Do not infer quality, target audience, or evidence level from author names, brands, URLs, or reputation. Do not mention outside knowledge even to label it as outside knowledge. Never use the phrase "known for", "author of", or "research-backed" unless that exact phrase appears in the content. Never mention other books, products, employers, credentials, or claims associated with an author unless those exact words appear in the content. For TL;DR-style requests, include what can be known from the metadata, include a short "Worth your time" recommendation based only on literal title, excerpt, tags, snippet, or saved memory; for interest or audience labels, use exact words from tags/title/excerpt/snippet/memory, not broader inferred categories. Do not use adjacent labels like productivity, psychology, behavioral science, cognitive biases, or decision-making unless those exact words appear in the content. If no saved memory directly applies, use metadata-only wording such as "Maybe if the title and tags match what you wanted; I cannot judge depth from metadata." Then end with one sentence starting "Cannot verify from metadata:" and name missing source-level information such as the full argument, evidence, examples, mechanisms, or actionable advice.'
          : 'The text below was extracted from the page and may include leftover navigation or formatting noise, and may be truncated. Focus on the main content and ignore the noise.';

      prompt +=
`\n\nThe user is currently ${sourceLine}.
Title: ${context.title}
URL: ${context.url}
${sourceNote}

--- CONTENT ---
${context.content}
--- END CONTENT ---

Base your answers on this content. When the user's request specifies a format or exact section labels, follow that requested format and do not replace it with the fallback below. Otherwise, when the user asks for a summary, TL;DR, key points, or overview, use this fallback structure:
- **Overview**: 1-2 sentences on what it covers and its core point or thesis.
- **Key points**: the main ideas, arguments, or segments, as bullets.
- **Action items**: concrete steps, recommendations, or things to try, as bullets. Include this section only if the content actually offers them.
- **Worth your time**: a short personal relevance note with a direct read/watch/skip recommendation. It can be positive, mixed, or negative. Use the user's memory and stated preferences when relevant; otherwise make a cautious usefulness call from the source itself. Do not force importance.
Omit any section that does not apply instead of inventing content to fill it, and never claim the content says something it does not. Keep the whole summary tight enough to read in well under a minute. Do not add source-format caveats for ordinary extracted pages unless the limited metadata, transcript, or user request makes that caveat useful. For any other kind of question, answer directly and add structure only when it helps. If the user asks about something the content does not cover, answer from general knowledge and say so briefly.`;
    }

    return prompt;
  }

  function expandDefaultCommand(commandName) {
    const command = DEFAULT_COMMANDS.find(item => item.name === commandName);
    if (!command) {
      throw new Error(`Unknown command "${commandName}". Known commands: ${DEFAULT_COMMANDS.map(item => item.name).join(', ')}`);
    }
    return command.prompt;
  }

  return {
    DEFAULT_COMMANDS: getDefaultCommands(),
    LEGACY_DEFAULT_COMMAND_SETS: LEGACY_DEFAULT_COMMAND_SETS.map(cloneCommands),
    buildSystemPrompt,
    commandShowsInEmptyState,
    commandsMatch,
    expandDefaultCommand,
    getDefaultCommands,
    getInitialCommands,
    isGroundedPageCommand,
    isLimitedPageContext,
    normalizeCommand,
    normalizeCommands,
    normalizeMemoryList,
    shouldMigrateDefaultCommands
  };
});
