# Privacy

Effective: October 5, 2026

Speak Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no Speak Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, Speak Digest handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- vocabulary you save, including selected text, Chinese meaning and explanation, optional AI-generated phonetic text, context, video title, and timestamp;
- questions you ask, recent in-memory Ask conversation context, and generated suggested questions;
- an optional web search query and validated result metadata when Ask Web is on;
- Supadata, DeepSeek, and optional Tavily configuration, including API keys;
- cached transcript, digest, translation, vocabulary, and suggestion results, including an optional generated transcript after you explicitly confirm audio transcription; and
- session-only Transcript reading positions for up to 20 recent videos.

## Where data goes

### Supadata

Speak Digest sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key. It first requests an existing native transcript. If none exists, the extension offers an optional AI transcription action and shows an estimated credit cost. Only after you click that action and confirm does Supadata fetch and process the video's audio to generate a transcript. Canceling the confirmation sends no generation request. A Supadata key is required for both transcript paths.

### DeepSeek

The published version sends AI feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- transcript, relevant video metadata, and bounded recent Ask history for a current-video answer;
- selected text plus nearby transcript context for an explanation;
- selected text plus nearby context and video metadata for Vocabulary enrichment;
- small semantic transcript batches currently needed for progressive Chinese
  translation, including remaining segments when you copy or export the Chinese
  or bilingual transcript, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. AI-generated IPA or pinyin may be imperfect and is omitted for longer selections. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

### Tavily

Tavily is an optional bring-your-own-key provider at `https://api.tavily.com` for Ask web search. The **Web** toggle is off by default, and no Tavily request is sent while it remains off. When you enable Web, Speak Digest derives a search query from the current video title, your question, and available overview, then sends it directly to Tavily with your Tavily API key. It requests basic search with at most five results, no Tavily-generated answer, and no raw page content. Only validated result titles, URLs, and short content are supplied to DeepSeek and rendered as sources. If the key is missing or search fails, Ask continues with video-only evidence. Tavily processes searches under its [privacy policy](https://tavily.com/privacy).

### Youdao dictionary audio

When you click pronunciation for an English Vocabulary term, the side panel requests American audio directly from `https://dict.youdao.com/dictvoice`. Only the selected term is placed in the request URL, alongside ordinary network metadata; the request does not include the video transcript, saved notes, or API keys. The extension does not prefetch or store this audio. Browser speech is used if dictionary playback fails or the term is not English. A browser voice may be an online service, depending on the device and browser.

API requests go directly from the extension to Supadata, DeepSeek, or optional Tavily with the keys you supply. Youdao audio requests go directly to Youdao without an API key. Speak Digest's developer does not proxy or receive these requests.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it. Tavily's current API and credit information is available from its [API introduction](https://docs.tavily.com/documentation/api-reference/introduction) and [credit documentation](https://docs.tavily.com/documentation/api-credits).

## Local storage and retention

Speak Digest uses Chrome's local extension storage, not a Speak Digest cloud service.

- Supadata, DeepSeek, and optional Tavily API key settings remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Vocabulary is limited to 500 entries and is saved locally until you delete entries or clear extension data.
- Exactly three generated suggested questions per video are stored locally with cached video data.
- Ask conversation history is held only in panel memory and is not persisted. It clears when you switch videos or when the panel closes.
- Chrome `storage.session` stores Transcript reading positions for up to 20 recent videos. Only `scrollTop` and an update time are kept, and they are removed when the browser session ends.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes and Vocabulary entries in Speak Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, vocabulary, and cache entries; and
- revoke keys in the Supadata, DeepSeek, or Tavily dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by Supadata, DeepSeek, or Tavily. Use each service's controls for service-side requests.

## Permissions

Speak Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the Speak Digest interface beside YouTube.
- `storage`: store settings, keys, notes, vocabulary, suggestions, cached results, and session-only Transcript reading positions.
- `tabs`: identify and interact with the active YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls and reconnect the existing page script in the active YouTube tab when its message receiver is missing.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Supadata host access: retrieve transcripts and perform user-confirmed audio transcription.
- DeepSeek host access: provide AI overviews, Ask, explanations, translation, Vocabulary enrichment, and note polishing through DeepSeek V4 Flash.
- Tavily host access: perform optional Ask web search only when Web is enabled.
- Youdao dictionary host access: request American audio only when you click pronunciation for an English Vocabulary term.

Speak Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

Speak Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
