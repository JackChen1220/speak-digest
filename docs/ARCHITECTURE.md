# Architecture and Product Boundaries

## Goals

1. Explain supports English, Simplified Chinese, and bilingual modes.
2. Ask provides transcript-grounded suggestions and session-only multi-turn conversation, with optional Tavily web search.
3. Library keeps Notes and Vocabulary separate while supporting reusable learning entries and cross-video highlighting.
4. Transcript supports safe literal search and session-only reading-position restore without changing playback or borrowing a background tab.

## Navigation and interaction

The top navigation contains four equal tabs: Transcript, Overview, Library, and Ask. Library contains a Notes/Vocabulary segmented control. Notes retains its current This Video/All Notes filter. Vocabulary has This Video/All Vocabulary filters.

Selecting text inside any rendered Transcript language mode opens a two-action selection control: Explain and Save. Explain opens the current modal with an English/中文/双语 control. English is the default. The selected excerpt remains in its original displayed language; only the explanation changes. The modal also offers Save to Vocabulary.

Ask opens with three fixed actions (Summarize video, Recommend related content, Quiz me), three AI-generated video-specific questions, a message history, and a sticky composer. A Web control is off by default. Recommend related content turns Web on automatically. Other questions use Tavily only when Web is visibly enabled.

Ask answers follow the language of the user's question. Conversation history exists only for the current panel session and video. Changing videos or closing the side panel clears it.

## Transcript search and reading position

Transcript search is local, literal, case-insensitive where appropriate, and bounded to a 200-character query. It navigates previous and next matches with wraparound, pauses auto-follow when the user moves to a match, and never seeks video playback. Search marks are separate from Vocabulary marks, so clearing or reapplying search preserves saved Vocabulary highlighting.

Transcript Copy and Export use the selected Original, Chinese, or bilingual mode. Chinese and bilingual output is built from the semantic segments and their cached translations in source order. On request, the existing translation queue finishes offscreen segments before output; missing translations prevent a partial copy or download. Changing the video or language cancels a pending output action. Original export keeps its previous plain-text body, while bilingual output pairs each original segment with its Chinese translation.

The side panel saves only `scrollTop` and an update time in Chrome `storage.session`, keyed by video ID. It retains at most 20 recent video positions and removes them automatically when the browser session ends. Restore happens only after the matching video's Transcript has rendered; stale video snapshots are ignored.

Both the background relay and the side panel resolve the active YouTube tab only. If that active tab is not a supported watch page, the panel closes or disables instead of selecting a background YouTube tab.

If the active YouTube tab has no content-script message receiver, the relay injects the existing `content.js` into that exact tab and retries once. It checks that the same URL and tab remain active before and after injection. If reconnection still fails, the panel asks the user to refresh the YouTube tab and offers a connection retry.

## Explain data flow

`explainSelection` continues to generate one concise English explanation from the selected text and its transcript context. The Explain prompt explicitly requires English so the source explanation is stable.

The modal keeps local state for the English result, optional Chinese translation, selected mode, and translation status. Switching to 中文 or 双语 lazily sends the English explanation through the existing structured translation path using a new `explainBatch` content type. The Chinese result is reused while the modal remains open. Bilingual mode renders escaped English above escaped Chinese with a divider.

If the user selected translated text, the side panel derives context from the containing transcript segment and adjacent source segments rather than searching for translated text in the original transcript string. Closing a modal invalidates late Explain or translation results.

If translation fails, the English explanation stays available and the Chinese area offers Retry. Retrying translation does not regenerate the English explanation.

## Ask architecture

The side panel owns session state: current video ID, message history, generated suggestions, loading state, and a generation counter. Only one Ask request may be active. Video changes increment the counter so old responses cannot render into a new video.

The background service worker exposes separate validated actions for generating suggested questions and answering a video question. Both reuse the existing DeepSeek request helper, timeouts, non-thinking mode, and key isolation.

Questions are limited to 2,000 characters. History is limited to the most recent six user/assistant rounds and 12,000 total characters. The background accepts only alternating user/assistant text roles and rebuilds the validated history rather than trusting the side-panel payload.

For normal-length videos, Ask sends the complete timestamped transcript. The request context is capped at 120,000 transcript characters. Above that limit, the context builder combines any cached Overview summary and chapters with question-relevant timestamped segments and evenly sampled beginning, middle, and ending segments. The UI marks answers based on a reduced transcript as using selected excerpts.

The Ask system prompt treats transcripts, video metadata, web snippets, and conversation text as untrusted reference data. It ignores instructions embedded in those sources, answers from available evidence, cites transcript timestamps such as `[12:34]` when useful, and says when the video does not contain an answer. Quiz me asks one question at a time and uses the validated recent history to evaluate the next reply.

Suggested questions are requested lazily on first opening Ask, validated as three short strings, and cached with the existing per-video digest cache. The three fixed actions remain available if suggestion generation fails.

## Tavily search

Settings adds an optional Tavily API Key under the existing bring-your-own-key model. It is stored in trusted Chrome local storage and never enters source files, prompts, logs, page scripts, or package artifacts. Missing Tavily configuration does not block Transcript, Overview, Explain, Notes, Vocabulary, or video-only Ask.

When Web is enabled, the background builds a concise search query from the video title, the user question, and available Overview topics. It is capped below Tavily's 400-character query guidance. The background calls `POST https://api.tavily.com/search` with Bearer authentication, `search_depth: "basic"`, at most five results, `include_answer: false`, and no raw page content. This path therefore uses one Tavily search credit under the current documented pricing.

Tavily output is untrusted. The background keeps only bounded titles, HTTP(S) URLs, content snippets, and finite relevance scores. DeepSeek synthesizes the final answer from the video context and validated search results. The UI renders escaped answer text followed by explicit, clickable source cards.

If Tavily fails, the request continues with video-only context where possible and clearly reports that web search was unavailable. It never invents source links. Every README cost statement must be dated and linked to current official Tavily documentation.

## Vocabulary architecture

Vocabulary uses a separate `ytd_vocabulary` storage collection rather than overloading the note schema. Each validated entry contains an ID, selected term, normalized term, detected source language, Chinese meaning and explanation, optional phonetic notation, source excerpt, transcript context, video ID, title, channel, timestamp, timestamped URL, and creation time.

Saving a new selection performs a duplicate check before any AI call. Latin text is normalized with Unicode normalization, collapsed whitespace, and lowercase comparison. CJK text uses Unicode normalization and collapsed whitespace. An existing normalized term returns an Already saved result without creating a duplicate or consuming another AI request.

A new background action uses a dedicated structured prompt to produce a concise Chinese meaning, contextual explanation, and optional phonetic notation. Short Latin words and phrases use IPA; short Chinese entries use pinyin. Longer sentences omit phonetic notation rather than displaying an unreadable transcription. Provider JSON is validated and length-bounded before storage. Existing records without phonetic notation remain valid. The collection accepts at most 500 entries and returns a clear capacity error instead of silently deleting learning data.

Vocabulary cards show the saved text, optional phonetic notation, a pronunciation button, Chinese meaning/explanation, source excerpt, video and timestamp link, and delete action. This Video filters by current video ID; All Vocabulary shows the global collection. For English/Latin entries, pronunciation requests `https://dict.youdao.com/dictvoice` American audio only after a click. A load or playback failure falls back once to browser `speechSynthesis`, preferring American Natural, Google, then local Samantha voices. Non-English entries use browser speech directly. Starting another pronunciation, changing cards or video, leaving Library, or closing the panel cancels the current readout. The selected English term is sent to Youdao; no audio is prefetched or stored. Browser speech voices may be online. If neither playback path is available, the control shows a clear unavailable label.

The side panel loads normalized vocabulary terms before rendering Transcript. It reapplies highlighting after original or translated transcript content is rendered. Latin single words match whole words case-insensitively. Latin phrases, sentences, and CJK entries use normalized exact matching inside a displayed semantic segment. No stemming, fuzzy matching, or cross-segment matching is performed in this version.

Highlighting operates on rendered text nodes after all provider content has been escaped, preserves allowlisted subtitle formatting, applies longer terms first, and never builds executable HTML or regular expressions from saved text. Saved matches use a purple underline; Transcript search matches use yellow for distinction.

## Security, privacy, and failure behavior

- API keys remain background-only and are read from trusted extension storage.
- Tavily requires the minimum new host permission, `https://api.tavily.com/*`.
- User questions, history, provider responses, URLs, and saved vocabulary fields are validated and bounded again in the background.
- Model output, web snippets, and vocabulary text are escaped before rendering.
- Link rendering accepts only `http:` and `https:` URLs and uses safe external navigation.
- Transcript and search-result prompt injection is isolated as untrusted data and cannot change system instructions.
- Ask disables duplicate sends while a request is active and rejects stale video responses.
- Explain translation failures preserve the English result. Vocabulary generation failures save nothing. Tavily failures degrade to a labelled video-only answer.
- README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, prompt documentation, release allowlists, and tests are updated with the new provider and data flows.

## Testing and adversarial review

Release tests cover:

- Explain modes, lazy one-time translation, escaped bilingual rendering, retry, and translated-selection context.
- Four top tabs, Library subviews, Ask composer behavior, current-video session reset, and stale-response suppression.
- Ask question/history limits, role validation, long-transcript context reduction, timestamp grounding, suggestion JSON validation, and fallback behavior.
- Tavily request shape, optional configuration, result and URL validation, no calls when Web is off, and labelled degradation when search fails.
- Vocabulary normalization, global duplicate prevention before AI calls, schema validation, capacity behavior, filters, deletion, and exact safe highlighting.
- Phonetic validation, backward compatibility for older entries, and Youdao audio URL, fallback, cancellation, and browser speech behavior.
- Prompt files, host permissions, privacy copy, release allowlist, secret scanning, and packaging.

No automated test may call DeepSeek, Supadata, or Tavily with a live key.

Adversarial review targets prompt injection through transcripts and Tavily snippets, HTML/script injection through model fields, unsafe URL schemes, regex denial of service through vocabulary entries, oversized inputs, duplicate and Unicode edge cases, stale cross-video responses, key leakage, accidental Tavily calls with Web disabled, and silent paid-call behavior.

Manual Chrome verification remains separate: reload the unpacked extension, test all Explain modes, exercise video-only and Web-enabled Ask on multiple videos, save vocabulary from original and translated modes, and confirm highlights reappear on another video.
