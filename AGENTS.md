# Project Guide

Speak Digest is a Manifest V3 Chrome extension built with plain HTML, CSS, and JavaScript. There is no compile or bundle step.

## Source map

- `manifest.json`: permissions, entry points, and release version.
- `background.js`: Supadata, DeepSeek, and optional Tavily requests, schema validation, caching, notes, vocabulary, and Ask.
- `content.js`: YouTube page integration and playback control.
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`: panel UI and interactions.
- `settings.*`: API-key setup and provider guidance.
- `prompts/`: human-readable copies of production prompt contracts.
- `tests/`: Node tests for behavior and release policy.
- `docs/ARCHITECTURE.md`: current feature boundaries, data flow, and trust model.

## Product boundaries

- Always request Supadata `mode=native` first. Never generate a transcript automatically.
- Offer audio transcription only after a native `NO_TRANSCRIPT` result, and send `mode=generate` only after explicit user confirmation.
- Do not make paid live-provider calls during automated tests.
- Overview quote notes must save the language currently displayed through the dedicated `saveOverviewNote` path; do not route them through transcript note cleanup.
- Ask Web search is explicit opt-in, remains off by default, and uses an optional bring-your-own Tavily key. Without Web, do not contact Tavily; search failure must degrade to video-only Ask.
- Keep Ask conversation history in panel memory only and never persist it. Clear it when the active video changes or the panel closes; cache only the three generated suggestions.
- Keep the Vocabulary schema separate from notes and enforce the 500-entry cap. Global transcript highlight matching must remain safe and bounded.
- Keep Transcript search literal and bounded. Clearing or refreshing search must preserve Vocabulary highlights and must not seek video playback.
- Store Transcript reading position only in `chrome.storage.session`, keep at most 20 recent videos, and never restore a stale position into another video.
- Resolve panel content from the active YouTube tab only. Never fall back to a background YouTube tab.
- Vocabulary pronunciation requests Youdao dictionary audio only after a user clicks an English term, then falls back to browser speech on failure. Non-English terms use browser speech. Keep the Youdao host permission, privacy disclosure, docs, and tests aligned; do not prefetch or store audio.
- Treat provider output as untrusted: validate expected JSON shapes and escape rendered text.
- Validate Tavily source URLs and bound transcript, Ask history, web result, storage, and rendered-content sizes.
- Keep the bring-your-own-key model. Never add real secrets to source, fixtures, prompts, logs, or packages.
- Keep `README.md`, `README.zh-CN.md`, `PRIVACY.md`, and matching files in `prompts/` synchronized when behavior or data flow changes.

## Verification

Run `npm test`, `npm run check`, and `npm run package`. Reload the unpacked extension and perform real-video checks separately; automated checks do not prove YouTube or provider availability.
