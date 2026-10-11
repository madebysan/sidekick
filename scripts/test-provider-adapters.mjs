import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const projectRoot = new URL('../', import.meta.url);
const providersSource = fs.readFileSync(new URL('providers.js', projectRoot), 'utf8');
const promptsSource = fs.readFileSync(new URL('prompts.js', projectRoot), 'utf8');
const chatSource = fs.readFileSync(new URL('chat.js', projectRoot), 'utf8');
const sandbox = {
  URL,
  console,
  setTimeout,
  clearTimeout,
  TextDecoder
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(providersSource, sandbox, { filename: 'providers.js' });
vm.runInContext(promptsSource, sandbox, { filename: 'prompts.js' });
vm.runInContext(`${chatSource}\n;globalThis.__sidekickProviderAdapters = { PROVIDERS };`, sandbox, {
  filename: 'chat.js'
});

const fal = sandbox.__sidekickProviderAdapters.PROVIDERS.fal;

assert.equal(
  fal.endpoint,
  'https://fal.run/openrouter/router/openai/v1/chat/completions',
  'Fal should use its OpenAI-compatible endpoint so OpenRouter model defaults remain intact'
);

const body = fal.buildBody({
  model: 'google/gemini-3.5-flash',
  messages: [{ role: 'user', content: 'Say OK' }],
  systemPrompt: 'Be concise.',
  provider: fal
});

assert.equal(body.model, 'google/gemini-3.5-flash');
assert.equal(body.stream, true);
assert.equal(body.messages[0].role, 'system');
assert.equal(body.messages[0].content, 'Be concise.');
assert.equal(body.messages[1].role, 'user');
assert.equal(body.messages[1].content, 'Say OK');
assert.equal(
  Object.hasOwn(body, 'reasoning'),
  false,
  'Fal requests should omit reasoning controls and let OpenRouter honor mandatory/default model metadata'
);

assert.equal(
  fal.defaultModel,
  'google/gemini-3.8-flash',
  'Fal should default to Gemini 3.8 Flash for cheaper search and vision'
);
assert.equal(
  sandbox.SidekickProviders.PROVIDERS.gemini.defaultModel,
  'gemini-3.8-flash',
  'Direct Gemini should default to 3.8 Flash'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsImages('google/gemini-3.8-flash'),
  true,
  'Gemini 3.8 Flash on Fal should accept images'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsImages('anthropic/claude-sonnet-4.6'),
  true,
  'Claude Sonnet on Fal should accept images'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsImages('deepseek/deepseek-v4-flash'),
  false,
  'DeepSeek on Fal should stay text-only'
);

const visionBody = fal.buildBody({
  model: 'anthropic/claude-sonnet-4.6',
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'text', text: 'What is this?' }
    ]
  }],
  systemPrompt: '',
  provider: fal
});
assert.equal(visionBody.messages[0].content[0].type, 'image_url');
assert.match(visionBody.messages[0].content[0].image_url.url, /^data:image\/png;base64,abc$/);

assert.equal(
  fal.readStreamEvent({ choices: [{ delta: { content: 'OK' } }] }).token,
  'OK',
  'Fal should parse OpenAI-compatible stream deltas'
);

assert.equal(
  sandbox.SidekickProviders.falModelSupportsWebSearch('anthropic/claude-sonnet-4.6'),
  true,
  'Claude Sonnet on Fal should support web search'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsWebSearch('google/gemini-3.8-flash'),
  true,
  'Gemini 3.8 Flash on Fal should support web search'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsWebSearch('google/gemini-3.5-flash'),
  true,
  'Gemini 3.5 Flash on Fal should support web search'
);
assert.equal(
  sandbox.SidekickProviders.falModelSupportsWebSearch('anthropic/claude-haiku-4.5'),
  true,
  'Claude Haiku 4.5 on Fal should support web search'
);
assert.equal(
  sandbox.SidekickProviders.WEB_SEARCH_DEFAULT_MODEL,
  'google/gemini-3.8-flash',
  'Search fallback should use Gemini 3.8 Flash'
);
assert.equal(
  sandbox.SidekickProviders.modelSupportsWebSearch('anthropic', 'claude-sonnet-4-6'),
  false,
  'Direct Anthropic should not use Fal web search'
);

const searchBody = fal.buildBody({
  model: 'anthropic/claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
  systemPrompt: '',
  provider: fal,
  webSearch: true
});
assert.equal(searchBody.tools?.length, 1);
assert.equal(searchBody.tools[0].type, 'openrouter:web_search');

assert.equal(
  sandbox.shouldAttachWebSearch(
    { webSearchEnabled: true, falApiKey: 'fal-key' },
    'fal',
    'anthropic/claude-sonnet-4.6',
    'whats the weather in nyc'
  ),
  true
);
assert.equal(
  sandbox.shouldAttachWebSearch(
    { webSearchEnabled: true, falApiKey: 'fal-key' },
    'fal',
    'anthropic/claude-sonnet-4.6',
    '/tldr'
  ),
  false,
  'Grounded page commands should omit web search'
);
assert.equal(
  sandbox.shouldAttachWebSearch(
    { webSearchEnabled: true, falApiKey: 'fal-key' },
    'fal',
    'anthropic/claude-sonnet-4.6',
    '/contrarian'
  ),
  false,
  '/contrarian should stay on the page'
);
assert.equal(
  sandbox.shouldAttachWebSearch(
    { webSearchEnabled: true, falApiKey: 'fal-key' },
    'fal',
    'anthropic/claude-sonnet-4.6',
    '/research'
  ),
  true,
  '/research should use web search when it is on'
);
assert.equal(
  sandbox.shouldAttachWebSearch(
    { webSearchEnabled: false, falApiKey: 'fal-key' },
    'fal',
    'anthropic/claude-sonnet-4.6',
    'whats the weather in nyc'
  ),
  false
);

const defaultCommands = sandbox.SidekickPrompts.getDefaultCommands();
assert.equal(
  defaultCommands.map(command => command.name).join(','),
  'tldr,podcast,questions,contrarian,research'
);
assert.equal(sandbox.SidekickPrompts.commandShowsInEmptyState(defaultCommands.find(command => command.name === 'tldr')), true);
assert.equal(sandbox.SidekickPrompts.commandShowsInEmptyState(defaultCommands.find(command => command.name === 'contrarian')), false);
assert.equal(sandbox.SidekickPrompts.commandShowsInEmptyState(defaultCommands.find(command => command.name === 'research')), false);
assert.equal(
  sandbox.SidekickPrompts.shouldMigrateDefaultCommands([
    { name: 'tldr', prompt: sandbox.SidekickPrompts.expandDefaultCommand('tldr') },
    { name: 'podcast', prompt: sandbox.SidekickPrompts.expandDefaultCommand('podcast') },
    { name: 'questions', prompt: sandbox.SidekickPrompts.expandDefaultCommand('questions') }
  ]),
  true,
  'Untouched three-command defaults should migrate in /contrarian and /research'
);
assert.equal(
  sandbox.SidekickPrompts.getInitialCommands([
    { name: 'tldr', prompt: sandbox.SidekickPrompts.expandDefaultCommand('tldr') },
    { name: 'podcast', prompt: sandbox.SidekickPrompts.expandDefaultCommand('podcast') },
    { name: 'questions', prompt: sandbox.SidekickPrompts.expandDefaultCommand('questions') },
    { name: 'mine', prompt: 'Custom prompt' }
  ]).some(command => command.name === 'research'),
  false,
  'Custom command lists should not be overwritten'
);

console.log('Provider adapter contract checks passed.');
