// Edition switches, loaded before providers.js everywhere.
// Public release: the Codex bridge and the Voicebox/Chatterbox voice bridge are
// local helper programs that are not part of this repository, so their options
// are hidden.
globalThis.SIDEKICK_EDITION = {
  name: 'public',
  hiddenProviders: ['codex'],
  hiddenTtsEngines: ['chatterbox', 'voicebox-lab']
};
