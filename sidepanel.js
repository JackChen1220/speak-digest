/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for Speak Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptSource = "native";
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let digestGeneration = 0;
let activeDigestVideoId = null;
let analysisGeneration = 0;
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;
let explainSelectionAbortController = null;
let closeActiveExplanationModal = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let transcriptTextActionInProgress = false;
let currentOverviewMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let overviewTranslationGeneration = 0;
let overviewTranslationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let overviewTranslationErrors = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

// --- Library / vocabulary state ---
// Vocabulary is loaded globally because saved terms highlight every video,
// while the Library filter only changes which cards are visible.
let currentLibraryView = "notes";
let vocabularyPronunciationPlayer = null;
let showAllVocabulary = false;
let vocabularyEntries = [];
let vocabularyLoadGeneration = 0;
const vocabularySavePromises = new Map();
const VOCABULARY_MATCH_LIMITS = Object.freeze({
  maxEntries: 500,
  maxTermLength: 1_000,
  maxTextLength: 12_000,
});
const TRANSCRIPT_SEARCH_LIMITS = Object.freeze({
  maxQueryLength: 200,
  maxTextLength: 12_000,
  maxMatches: 1_000,
});
let transcriptSearchState = createTranscriptSearchState();

// --- Ask state ---
// Messages intentionally remain in memory. Only generated suggestions are
// copied into the per-video digest cache.
const ASK_QUESTION_MAX_LENGTH = 2_000;
let askMessageSequence = 0;

function createAskState(videoId = null) {
  return {
    messages: [],
    suggestions: [],
    loading: false,
    webEnabled: false,
    generation: 0,
    videoId: videoId || null,
    suggestionsLoading: false,
    suggestionsRequested: false,
    suggestionsError: "",
    suggestionsContextReduced: false,
    lastAnnouncementKey: "",
    statusSequence: 0,
  };
}

const askState = createAskState();

function normalizeAskUiSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  const normalized = [];
  const seen = new Set();
  for (const suggestion of suggestions) {
    const text = String(suggestion || "").trim().slice(0, 200);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
    if (normalized.length === 3) break;
  }
  return normalized;
}

function resetAskStateForVideo(state, videoId, cachedSuggestions = []) {
  const nextVideoId = videoId || null;
  if (state.videoId === nextVideoId) {
    if (!state.suggestions.length) {
      state.suggestions = normalizeAskUiSuggestions(cachedSuggestions);
      state.suggestionsRequested = state.suggestions.length > 0;
    }
    return state;
  }

  state.messages = [];
  state.suggestions = normalizeAskUiSuggestions(cachedSuggestions);
  state.loading = false;
  state.webEnabled = false;
  state.generation += 1;
  state.videoId = nextVideoId;
  state.suggestionsLoading = false;
  state.suggestionsRequested = state.suggestions.length > 0;
  state.suggestionsError = "";
  state.suggestionsContextReduced = false;
  state.lastAnnouncementKey = "";
  state.statusSequence = 0;
  return state;
}

function hydrateAskSuggestionsFromCache(state, cached) {
  if (!cached || state.suggestions.length) return;
  state.suggestions = normalizeAskUiSuggestions(cached.askSuggestions);
  state.suggestionsRequested = state.suggestions.length > 0;
  state.suggestionsContextReduced =
    cached.askSuggestionsContextReduced === true;
}

function shouldLoadAskSuggestions(state) {
  return Boolean(
    state.videoId &&
      !state.suggestions.length &&
      !state.suggestionsLoading &&
      !state.suggestionsRequested,
  );
}

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading-position state ---
// Session storage survives a side-panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
const TRANSCRIPT_VIEW_STATE_LIMIT = 20;
const TRANSCRIPT_VIEW_STATE_SAVE_DEBOUNCE_MS = 250;
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let lastTranscriptScrollTop = 0;
let transcriptViewStateMutationQueue = Promise.resolve();

/**
 * Reading position is intentionally session-only. Returning null instead of
 * falling back to local storage keeps the data-lifetime promise explicit.
 */
function getTranscriptViewStateStorage() {
  try {
    const storage = globalThis.chrome?.storage?.session;
    if (
      !storage ||
      typeof storage.get !== "function" ||
      typeof storage.set !== "function"
    ) {
      return null;
    }
    return storage;
  } catch (error) {
    return null;
  }
}

function isValidTranscriptViewStateVideoId(videoId) {
  return typeof videoId === "string" && videoId.trim().length > 0;
}

function normalizeTranscriptViewStateEntry(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const { scrollTop, updatedAt } = state;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return null;
  if (scrollTop < 0) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  if (updatedAt < 0) return null;
  return { scrollTop, updatedAt };
}

/**
 * Reads one video's last visible Transcript position without leaking another
 * video's state or allowing malformed session data into the UI lifecycle.
 */
async function loadTranscriptViewState(videoId) {
  if (!isValidTranscriptViewStateVideoId(videoId)) return null;
  const storage = getTranscriptViewStateStorage();
  if (!storage) return null;

  try {
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY];
    if (
      !states ||
      typeof states !== "object" ||
      Array.isArray(states) ||
      !Object.hasOwn(states, videoId)
    ) {
      return null;
    }
    const state = normalizeTranscriptViewStateEntry(states[videoId]);
    return state ? { videoId, scrollTop: state.scrollTop } : null;
  } catch (error) {
    return null;
  }
}

/**
 * Stores a newest-first, sanitized map for at most 20 videos. Rebuilding the
 * map also removes stale fields and malformed entries from prior writes.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!isValidTranscriptViewStateVideoId(videoId)) return;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return;
  if (scrollTop < 0) return;

  const storage = getTranscriptViewStateStorage();
  if (!storage) return;

  const mutation = transcriptViewStateMutationQueue.then(async () => {
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const storedStates = result?.[TRANSCRIPT_VIEW_STATE_KEY];
    const previousEntries =
      storedStates &&
      typeof storedStates === "object" &&
      !Array.isArray(storedStates)
        ? Object.entries(storedStates)
        : [];
    const now = Date.now();
    const entries = [
      [videoId, { scrollTop, updatedAt: now }],
      ...previousEntries
        .filter(([storedVideoId]) => storedVideoId !== videoId)
        .map(([storedVideoId, state]) => [
          storedVideoId,
          normalizeTranscriptViewStateEntry(state),
        ])
        .filter(
          ([storedVideoId, state]) =>
            isValidTranscriptViewStateVideoId(storedVideoId) && state,
        ),
    ];
    const recentStates = Object.fromEntries(
      entries
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, TRANSCRIPT_VIEW_STATE_LIMIT),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  });

  // Always recover the internal chain so one unavailable/failed session write
  // cannot prevent a later reading-position save from running.
  transcriptViewStateMutationQueue = mutation.catch(() => {});
  try {
    await mutation;
  } catch (error) {
    // Session storage can disappear while Chrome tears down the panel. The
    // visible Transcript remains usable; only position persistence is skipped.
  }
}

function transcriptTabIsActive() {
  return Boolean(
    document.querySelector('.tab.active[data-tab="transcript"]'),
  );
}

function isCurrentTranscriptViewSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.videoId === currentVideoId &&
      snapshot.videoId === activeDigestVideoId &&
      snapshot.generation === digestGeneration,
  );
}

function clearTranscriptViewStateSaveTimer() {
  if (transcriptViewStateSaveTimer !== null) {
    clearTimeout(transcriptViewStateSaveTimer);
    transcriptViewStateSaveTimer = null;
  }
}

function scheduleTranscriptViewStateSave(snapshot, scrollTop) {
  clearTranscriptViewStateSaveTimer();
  transcriptViewStateSaveTimer = setTimeout(() => {
    transcriptViewStateSaveTimer = null;
    if (
      isRestoringTranscriptView ||
      !transcriptTabIsActive() ||
      !isCurrentTranscriptViewSnapshot(snapshot)
    ) {
      return;
    }
    void saveTranscriptViewState(snapshot.videoId, scrollTop);
  }, TRANSCRIPT_VIEW_STATE_SAVE_DEBOUNCE_MS);
}

function captureTranscriptViewPosition({ immediate = false } = {}) {
  if (isRestoringTranscriptView || !transcriptTabIsActive()) return false;
  if (!isValidTranscriptViewStateVideoId(currentVideoId)) return false;
  if (currentVideoId !== activeDigestVideoId) return false;

  const contentArea = document.getElementById("contentArea");
  const scrollTop = contentArea?.scrollTop;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return false;
  if (scrollTop < 0) return false;

  const snapshot = {
    videoId: currentVideoId,
    generation: digestGeneration,
  };
  lastTranscriptScrollTop = scrollTop;
  pendingTranscriptViewState = {
    ...snapshot,
    scrollTop,
    hasSavedPosition: true,
  };

  if (immediate) {
    clearTranscriptViewStateSaveTimer();
    void saveTranscriptViewState(snapshot.videoId, scrollTop);
  } else {
    scheduleTranscriptViewStateSave(snapshot, scrollTop);
  }
  return true;
}

function captureTranscriptPositionBeforeVideoChange(nextVideoId) {
  if (nextVideoId === currentVideoId) return false;
  clearTranscriptViewStateSaveTimer();

  if (isValidTranscriptViewStateVideoId(currentVideoId)) {
    if (transcriptTabIsActive() && !isRestoringTranscriptView) {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop;
      if (
        typeof scrollTop === "number" &&
        Number.isFinite(scrollTop) &&
        scrollTop >= 0
      ) {
        lastTranscriptScrollTop = scrollTop;
      }
    }
    void saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
  }

  pendingTranscriptViewState = null;
  lastTranscriptScrollTop = 0;
  return true;
}

async function loadPendingTranscriptViewState(snapshot) {
  const savedState = await loadTranscriptViewState(snapshot?.videoId);
  if (!isCurrentTranscriptViewSnapshot(snapshot)) return false;

  pendingTranscriptViewState = {
    videoId: snapshot.videoId,
    generation: snapshot.generation,
    scrollTop: savedState?.scrollTop ?? 0,
    hasSavedPosition: Boolean(savedState),
  };
  lastTranscriptScrollTop = 0;
  return true;
}

function restorePendingTranscriptViewState(snapshot) {
  if (!transcriptTabIsActive()) return false;
  if (!isCurrentTranscriptViewSnapshot(snapshot)) return false;
  if (
    !pendingTranscriptViewState ||
    pendingTranscriptViewState.videoId !== snapshot.videoId ||
    pendingTranscriptViewState.generation !== snapshot.generation
  ) {
    return false;
  }

  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return false;
  const savedScrollTop = pendingTranscriptViewState.scrollTop;
  const scrollTop =
    typeof savedScrollTop === "number" &&
    Number.isFinite(savedScrollTop) &&
    savedScrollTop >= 0
      ? savedScrollTop
      : 0;
  const hasSavedPosition =
    pendingTranscriptViewState.hasSavedPosition === true;

  clearTranscriptViewStateSaveTimer();
  isRestoringTranscriptView = true;
  lastAutoScrollTime = Date.now();
  lastTranscriptScrollTop = scrollTop;
  contentArea.scrollTop = scrollTop;
  pendingTranscriptViewState = null;

  if (hasSavedPosition) {
    autoScrollEnabled = false;
    const followPlaybackButton = document.getElementById("followPlaybackBtn");
    if (followPlaybackButton) followPlaybackButton.style.display = "block";
  }

  setTimeout(() => {
    isRestoringTranscriptView = false;
  }, 0);
  return true;
}

function setupTranscriptViewStateListeners() {
  const contentArea = document.getElementById("contentArea");
  contentArea?.removeEventListener("scroll", onContentAreaScroll);
  contentArea?.addEventListener("scroll", onContentAreaScroll);
  window.addEventListener("pagehide", () => {
    captureTranscriptViewPosition({ immediate: true });
  });
}

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  if (message.action === "vocabularySaved") {
    refreshVocabularyEntries();
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  setupTranscriptViewStateListeners();

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  const transcriptSearchInput = document.getElementById("transcriptSearchInput");
  transcriptSearchInput?.addEventListener("input", () => {
    setTranscriptSearchQuery(transcriptSearchInput.value, { scroll: true });
  });
  transcriptSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearTranscriptSearch();
    }
  });
  document
    .getElementById("transcriptSearchClear")
    ?.addEventListener("click", clearTranscriptSearch);
  document
    .getElementById("transcriptSearchPrevious")
    ?.addEventListener("click", () => navigateTranscriptSearch(-1));
  document
    .getElementById("transcriptSearchNext")
    ?.addEventListener("click", () => navigateTranscriptSearch(1));
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    if (button.dataset.transcriptMode) {
      button.addEventListener("click", () => {
        handleTranscriptModeChange(button.dataset.transcriptMode);
      });
    }
    if (button.dataset.overviewMode) {
      button.addEventListener("click", () => {
        handleOverviewModeChange(button.dataset.overviewMode);
      });
    }
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });

  document.getElementById("libraryNotesTab")?.addEventListener("click", () => {
    switchLibraryView("notes");
  });
  document
    .getElementById("libraryVocabularyTab")
    ?.addEventListener("click", () => {
      switchLibraryView("vocabulary");
    });
  document
    .getElementById("vocabularyFilterThis")
    ?.addEventListener("click", () => {
      setVocabularyFilter(false);
      renderVocabularyForCurrentFilter();
    });
  document
    .getElementById("vocabularyFilterAll")
    ?.addEventListener("click", () => {
      setVocabularyFilter(true);
      renderVocabularyForCurrentFilter();
    });

  setupAskEventListeners();
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

function switchLibraryView(view) {
  if (!["notes", "vocabulary"].includes(view)) return;
  if (view !== "vocabulary") vocabularyPronunciationPlayer?.stop();
  currentLibraryView = view;
  const notesActive = view === "notes";
  const notesButton = document.getElementById("libraryNotesTab");
  const vocabularyButton = document.getElementById("libraryVocabularyTab");
  const notesView = document.getElementById("libraryNotesView");
  const vocabularyView = document.getElementById("libraryVocabularyView");

  notesButton?.classList.toggle("active", notesActive);
  notesButton?.setAttribute("aria-pressed", String(notesActive));
  vocabularyButton?.classList.toggle("active", !notesActive);
  vocabularyButton?.setAttribute("aria-pressed", String(!notesActive));
  if (notesView) notesView.hidden = !notesActive;
  if (vocabularyView) vocabularyView.hidden = notesActive;

  if (!notesActive) {
    renderVocabularyForCurrentFilter();
  }
}

function setVocabularyFilter(showAll) {
  showAllVocabulary = Boolean(showAll);
  const thisVideoButton = document.getElementById("vocabularyFilterThis");
  const allVocabularyButton = document.getElementById("vocabularyFilterAll");
  thisVideoButton?.classList.toggle("active", !showAllVocabulary);
  thisVideoButton?.setAttribute(
    "aria-pressed",
    String(!showAllVocabulary),
  );
  allVocabularyButton?.classList.toggle("active", showAllVocabulary);
  allVocabularyButton?.setAttribute(
    "aria-pressed",
    String(showAllVocabulary),
  );
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });

    debugLog("[Speak Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    if (!tab.url.startsWith("https://www.youtube.com")) {
      handleFrontTabUrl(tab.url);
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[Speak Digest Panel] getVideoInfo result:", result);
        if (result?.code === "CONTENT_SCRIPT_UNAVAILABLE") {
          showError("YouTube connection lost", result.error);
          document.getElementById("errorBtn").textContent = "Retry connection";
          errorAction = checkCurrentTab;
          return;
        }
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[Speak Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  if (videoId !== currentVideoId) vocabularyPronunciationPlayer?.stop();
  resetTranscriptSearchForVideo(videoId);
  setTranscriptActionStatus("");

  if (videoId !== askState.videoId) {
    resetAskStateForVideo(askState, videoId);
    renderAskUi();
  }

  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  captureTranscriptPositionBeforeVideoChange(videoId);

  const requestSnapshot = {
    generation: ++digestGeneration,
    videoId,
  };
  activeDigestVideoId = videoId;
  analysisGeneration += 1;
  isAnalysisLoading = false;

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    activeTranslationQueue?.cancel();
    activeTranslationQueue = null;
    closeActiveExplanationModal?.();
    translationGeneration += 1;
    overviewTranslationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptSource = "native";

  await loadPendingTranscriptViewState(requestSnapshot);
  if (!isCurrentDigestRequest(requestSnapshot)) return;

  // Check cache for this video
  const cached = await loadFromCache(videoId, requestSnapshot);
  if (!isCurrentDigestRequest(requestSnapshot)) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentAnalysis =
      typeof cached.analysis?.summary === "string" && cached.analysis.summary
        ? cached.analysis
        : null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    currentTranscriptSource = cached.transcriptSource || "native";
    hydrateAskSuggestionsFromCache(askState, cached);

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
      if (currentOverviewMode !== "original") translateOverview();
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(requestSnapshot);

    // Load notes for this video
    loadNotes(videoId, requestSnapshot);
    refreshVocabularyEntries(requestSnapshot);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    renderAskUi();
    return;
  }

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
    mode: "native",
  });
  if (!isCurrentDigestRequest(requestSnapshot)) return;

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in Speak Digest Settings.",
      );
      return;
    }
    if (transcriptResult.error === "NO_TRANSCRIPT") {
      showMissingTranscriptError(
        transcriptResult.message ||
          "No native subtitle track is available for this video.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  await completeTranscriptLoad(videoId, transcriptResult, requestSnapshot);
}

function isCurrentDigestRequest(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.generation === digestGeneration &&
      snapshot.videoId === activeDigestVideoId &&
      snapshot.videoId === currentVideoId,
  );
}

async function completeTranscriptLoad(videoId, transcriptResult, requestSnapshot) {
  if (
    videoId !== requestSnapshot?.videoId ||
    !isCurrentDigestRequest(requestSnapshot)
  ) {
    return false;
  }
  errorAction = null;
  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;
  currentTranscriptSource = transcriptResult.source || "native";

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  restorePendingTranscriptViewState(requestSnapshot);

  // Load notes for this video
  loadNotes(videoId, requestSnapshot);
  refreshVocabularyEntries(requestSnapshot);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();
  renderAskUi();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId, requestSnapshot);
  if (!isCurrentDigestRequest(requestSnapshot)) return false;

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
  return true;
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows the full-video summary, chapters, and key quotes.
 */
function renderAnalysisResults(analysis) {
  const summary = document.getElementById("overviewSummary");
  if (summary) {
    summary.innerHTML = renderOverviewField(
      analysis.summary || "Summary unavailable.",
      "overview-summary",
    );
  }

  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter, index) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${renderOverviewField(chapter.title, `chapter-title-${index}`)}</span>
        <span class="chapter-summary">${renderOverviewField(chapter.summary || "", `chapter-summary-${index}`)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[Speak Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote, index) => {
    const quoteFieldId = `quote-${index}`;
    const quoteTranslationReady =
      currentOverviewMode === "original" ||
      Boolean(getOverviewTranslation(quoteFieldId));
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${renderOverviewField(quote.quote, quoteFieldId)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="${quoteTranslationReady ? "Save this quote as a note" : "Wait for the selected language to finish translating"}" ${quoteTranslationReady ? "" : "disabled"}>${quoteTranslationReady ? "📝 Note" : "Translating…"}</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[Speak Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(
          getOverviewFieldDisplayText(quote.quote, `quote-${index}`),
        );
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteFieldId, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, fieldId, btn) {
  if (!currentVideoId) return;

  const translatedText = getOverviewTranslation(fieldId);
  if (currentOverviewMode !== "original" && !translatedText) return;
  const noteText = getOverviewFieldDisplayText(quote.quote, fieldId);

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveOverviewNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      noteText,
      rawText: quote.quote,
      languageMode: currentOverviewMode,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[Speak Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[Speak Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function getDisplayedTranscriptRowText(row) {
  const originalOnly = row.querySelector(".transcript-text");
  if (originalOnly) {
    return String(originalOnly.textContent || "").replace(/\s+/g, " ").trim();
  }

  const parts = [];
  const original = row.querySelector(".transcript-original");
  const translation = row.querySelector(".transcript-translation");
  if (original?.textContent?.trim()) {
    parts.push(original.textContent.replace(/\s+/g, " ").trim());
  }
  if (
    translation?.textContent?.trim() &&
    !translation.classList.contains("translation-pending") &&
    !translation.classList.contains("translation-error")
  ) {
    parts.push(translation.textContent.replace(/\s+/g, " ").trim());
  }
  return parts.join("\n");
}

function getTranscriptRowActionMetadata(row, segment) {
  const displayedText = getDisplayedTranscriptRowText(row);
  if (!displayedText) return null;
  const metadata = buildVocabularySelectionMetadata(
    displayedText,
    row,
    getActiveTranscriptSegments(),
    currentTranscriptText || "",
    {
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    },
  );
  if (!metadata.sourceExcerpt && segment?.text) {
    metadata.sourceExcerpt = segment.text;
  }
  return metadata;
}

function bindTranscriptRowAction(button, row, segment, handler) {
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const metadata = getTranscriptRowActionMetadata(row, segment);
    if (!metadata?.term) return;
    await handler(metadata);
  });
}

function syncTranscriptRowActions(row) {
  const unavailable = !getDisplayedTranscriptRowText(row);
  row.querySelectorAll(".transcript-row-action").forEach((button) => {
    button.disabled = unavailable;
  });
}

function addTranscriptRowActions(row, segment) {
  const actions = document.createElement("div");
  actions.className = "transcript-row-actions";

  const explainButton = document.createElement("button");
  explainButton.className = "transcript-row-action transcript-row-explain";
  explainButton.type = "button";
  explainButton.textContent = "Explain";
  explainButton.setAttribute("aria-label", "Explain this transcript segment");
  bindTranscriptRowAction(explainButton, row, segment, async (metadata) => {
    await showExplanation(metadata.term, metadata.context, metadata, explainButton);
  });

  const saveButton = document.createElement("button");
  saveButton.className = "transcript-row-action transcript-row-save";
  saveButton.type = "button";
  saveButton.textContent = "Save";
  saveButton.setAttribute(
    "aria-label",
    "Save this transcript segment to Vocabulary",
  );
  bindTranscriptRowAction(saveButton, row, segment, async (metadata) => {
    await saveVocabularySelection(metadata, saveButton);
  });

  actions.append(explainButton, saveButton);
  row.appendChild(actions);
  syncTranscriptRowActions(row);
}

function renderTranscriptSourceBadge(languageLabel) {
  const generated = currentTranscriptSource === "generated";
  const sourceLabel = generated
    ? "AI-generated from video audio"
    : "From video subtitles";
  const dotClass = generated ? "source-dot--ai" : "source-dot--subs";
  return `<span class="source-dot ${dotClass}"></span> ${sourceLabel} · ${escapeHtml(languageLabel)}`;
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show whether text came from an existing subtitle track or opt-in audio
  // transcription, so users can judge the source before relying on it.
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = renderTranscriptSourceBadge(getOriginalTranscriptLabel());
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group, index) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;
    div.dataset.segmentId = group.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    addTranscriptRowActions(div, group);

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  refreshTranscriptHighlights(transcriptList);

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function buildTranscriptTextForMode(mode, originalText, segments, translations) {
  if (mode === "original") {
    return { text: originalText || "", missingCount: 0 };
  }

  let missingCount = 0;
  const blocks = segments.map((segment) => {
    const translated = translations.get(segment.id);
    if (typeof translated !== "string" || !translated.trim()) {
      missingCount += 1;
      return "";
    }
    return mode === "bilingual"
      ? `${segment.text}\n${translated.trim()}`
      : translated.trim();
  });
  return {
    text: missingCount ? "" : blocks.join("\n\n"),
    missingCount,
  };
}

function setTranscriptActionStatus(message) {
  const status = document.getElementById("transcriptActionStatus");
  if (status) status.textContent = message;
}

async function prepareSelectedTranscriptText(buttonId) {
  if (transcriptTextActionInProgress) return null;
  transcriptTextActionInProgress = true;
  const buttons = ["copyTranscriptBtn", "exportTranscriptBtn"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const activeButton = document.getElementById(buttonId);
  const originalLabel = activeButton?.textContent;
  buttons.forEach((button) => {
    button.disabled = true;
  });
  if (activeButton) activeButton.textContent = "Preparing…";
  setTranscriptActionStatus("");

  try {
    const videoId = currentVideoId;
    const mode = currentTranscriptMode;
    if (mode === "original") {
      return { mode, text: currentTranscriptText || "" };
    }

    setTranscriptActionStatus("Preparing the complete translated transcript…");
    if (
      !activeTranslationQueue ||
      activeTranslationQueue.videoId !== videoId ||
      activeTranslationQueue.mode !== mode
    ) {
      await translateTranscript();
    }
    const generation = translationGeneration;
    const queue = activeTranslationQueue;
    await queue?.completeMissing();
    if (
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode ||
      generation !== translationGeneration
    ) {
      return null;
    }

    const segments = getActiveTranscriptSegments();
    const translations = new Map(
      segments.map((segment) => [
        segment.id,
        transcriptParagraphCache.get(transcriptTranslationCacheKey(segment)),
      ]),
    );
    const result = buildTranscriptTextForMode(
      mode,
      currentTranscriptText,
      segments,
      translations,
    );
    if (result.missingCount) {
      setTranscriptActionStatus(
        "Some lines could not be translated. Try again to complete the transcript.",
      );
      return null;
    }
    setTranscriptActionStatus("");
    return { mode, text: result.text };
  } catch (error) {
    console.error("Transcript preparation failed:", error);
    setTranscriptActionStatus("Could not prepare the transcript. Try again.");
    return null;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    if (activeButton) activeButton.textContent = originalLabel;
    transcriptTextActionInProgress = false;
  }
}

async function copyTranscript() {
  const prepared = await prepareSelectedTranscriptText("copyTranscriptBtn");
  if (!prepared) return;
  await copyToClipboardWithFeedback(prepared.text, "copyTranscriptBtn");
}

async function exportTranscript() {
  const prepared = await prepareSelectedTranscriptText("exportTranscriptBtn");
  if (!prepared) return;
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  const languageLabel = {
    original: "Original",
    zh: "简体中文",
    bilingual: "Original + 简体中文",
  }[prepared.mode];
  exportText += `Language: ${languageLabel}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (prepared.mode === "original" && currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${prepared.text}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by Speak Digest\n`;

  const suffix = prepared.mode === "original" ? "" : `-${prepared.mode}`;
  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript${suffix}.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    closeActiveExplanationModal?.();
    document.getElementById("contentArea")?.classList.remove("ask-mode");
    stopPlaybackTracking();
  } else if (
    document.querySelector('.tab.active[data-tab="ask"]')
  ) {
    document.getElementById("contentArea")?.classList.add("ask-mode");
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function buildAudioTranscriptionConfirmation(durationSeconds) {
  const seconds = Number(durationSeconds) || 0;
  if (seconds <= 0) {
    return (
      "Supadata will generate a transcript from the video audio. " +
      "This uses approximately 2 credits per video minute and may take several minutes. Continue?"
    );
  }

  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const estimatedCredits = minutes * 2;
  return (
    `This video is approximately ${minutes} minute${minutes === 1 ? "" : "s"} long. ` +
    `AI transcription may use approximately ${estimatedCredits} Supadata credits ` +
    "and may take several minutes. Continue?"
  );
}

function showMissingTranscriptError(message) {
  showError("No transcript found", message);
  document.getElementById("errorBtn").textContent =
    "Generate transcript from audio";
  errorAction = generateTranscriptFromAudio;
}

async function generateTranscriptFromAudio() {
  if (!currentVideoId) return;
  const confirmed = window.confirm(
    buildAudioTranscriptionConfirmation(currentVideoDuration),
  );
  if (!confirmed) return;

  const videoId = currentVideoId;
  const requestSnapshot = {
    generation: digestGeneration,
    videoId,
  };
  errorAction = null;
  showState("loading");
  updateLoading(
    "Generating transcript from audio",
    "This may take several minutes. You can keep the side panel open.",
  );

  try {
    const transcriptResult = await chrome.runtime.sendMessage({
      action: "fetchTranscript",
      videoId,
      mode: "generate",
    });
    if (!isCurrentDigestRequest(requestSnapshot)) return;

    if (!transcriptResult.success) {
      showError(
        "Transcription failed",
        transcriptResult.message || transcriptResult.error,
      );
      document.getElementById("errorBtn").textContent = "Try generation again";
      errorAction = generateTranscriptFromAudio;
      return;
    }

    await completeTranscriptLoad(videoId, transcriptResult, requestSnapshot);
  } catch (error) {
    if (!isCurrentDigestRequest(requestSnapshot)) return;
    showError("Transcription failed", error.message || "Please try again.");
    document.getElementById("errorBtn").textContent = "Try generation again";
    errorAction = generateTranscriptFromAudio;
  }
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in Speak Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  if (tabName !== "library") vocabularyPronunciationPlayer?.stop();
  const contentArea = document.getElementById("contentArea");
  if (transcriptTabIsActive() && tabName !== "transcript") {
    captureTranscriptViewPosition({ immediate: true });
  }
  contentArea?.classList.toggle("ask-mode", tabName === "ask");
  if (tabName === "ask") {
    contentArea.scrollTop = 0;
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
    restorePendingTranscriptViewState({
      videoId: currentVideoId,
      generation: digestGeneration,
    });
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }

  if (tabName === "ask") {
    renderAskUi();
    ensureAskSuggestions();
  }

  if (tabName === "library") {
    if (currentLibraryView === "vocabulary") {
      renderVocabularyForCurrentFilter();
    } else {
      const showAll = document
        .getElementById("notesFilterAll")
        ?.classList.contains("active");
      loadNotes(showAll ? null : currentVideoId);
    }
  }
}

// ============================================================
// ASK
// ============================================================

function normalizeAskComposerQuestion(value) {
  if (typeof value !== "string") {
    throw new Error("Enter a question about this video.");
  }
  const question = value.trim();
  if (!question) throw new Error("Enter a question about this video.");
  if (question.length > ASK_QUESTION_MAX_LENGTH) {
    throw new Error("Questions are limited to 2,000 characters.");
  }
  return question;
}

function nextAskMessageId() {
  askMessageSequence += 1;
  return `ask-${Date.now()}-${askMessageSequence}`;
}

function getCompletedAskHistory(messages) {
  const history = [];
  const source = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const user = source[index];
    const assistant = source[index + 1];
    if (
      user?.role === "user" &&
      user.status === "complete" &&
      assistant?.role === "assistant" &&
      assistant.status === "complete"
    ) {
      history.push(
        { role: "user", content: String(user.content || "") },
        { role: "assistant", content: String(assistant.content || "") },
      );
      index += 1;
    }
  }
  return history;
}

function buildAskRequestPayload({
  question,
  messages = [],
  history,
  webEnabled,
  videoId,
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  overview,
}) {
  const completedHistory = Array.isArray(history)
    ? history.map((message) => ({
        role: message.role,
        content: String(message.content || ""),
      }))
    : getCompletedAskHistory(messages);
  return {
    action: "askVideo",
    question: normalizeAskComposerQuestion(question),
    history: completedHistory,
    videoId: videoId || null,
    transcriptText: String(transcriptText || ""),
    videoTitle: String(videoTitle || ""),
    channelName: String(channelName || ""),
    videoDescription: String(videoDescription || ""),
    videoDuration: Number(videoDuration) || 0,
    overview: overview && typeof overview === "object" ? overview : null,
    webEnabled: webEnabled === true,
  };
}

function safeAskExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function normalizeAskAssistantResult(result) {
  const sources = [];
  if (Array.isArray(result?.sources)) {
    for (const source of result.sources) {
      const url = safeAskExternalUrl(source?.url);
      if (!url) continue;
      sources.push({
        title: String(source?.title || "Source").trim().slice(0, 300) || "Source",
        url,
      });
      if (sources.length === 5) break;
    }
  }
  return {
    answer:
      String(result?.answer || "").trim().slice(0, 20_000) ||
      "No answer was returned.",
    sources,
    contextReduced: result?.contextReduced === true,
    webWarning: String(result?.webWarning || "").trim().slice(0, 1_000),
  };
}

function isCurrentAskSnapshot(state, snapshot) {
  return Boolean(
    snapshot &&
      state.videoId === snapshot.videoId &&
      state.generation === snapshot.generation,
  );
}

function beginAskRequest(state, question, { retryMessageId = null } = {}) {
  if (state.loading) return null;
  const normalizedQuestion = normalizeAskComposerQuestion(question);
  if (!state.videoId) throw new Error("Open a YouTube video before asking.");
  const history = getCompletedAskHistory(state.messages);

  if (retryMessageId) {
    const errorIndex = state.messages.findIndex(
      (message) =>
        message.id === retryMessageId && message.status === "error",
    );
    if (errorIndex < 0) throw new Error("This question can no longer be retried.");
    state.messages.splice(errorIndex, 1);
  } else {
    state.messages.push({
      id: nextAskMessageId(),
      role: "user",
      content: normalizedQuestion,
      status: "complete",
    });
  }

  state.loading = true;
  state.statusSequence += 1;
  return {
    question: normalizedQuestion,
    history,
    webEnabled: state.webEnabled === true,
    snapshot: {
      videoId: state.videoId,
      generation: state.generation,
    },
  };
}

function applyAskRequestResult(state, snapshot, result, question) {
  if (!isCurrentAskSnapshot(state, snapshot)) return false;

  if (result?.success === true) {
    const answer = normalizeAskAssistantResult(result);
    state.messages.push({
      id: nextAskMessageId(),
      role: "assistant",
      content: answer.answer,
      status: "complete",
      sources: answer.sources,
      contextReduced: answer.contextReduced,
      webWarning: answer.webWarning,
    });
  } else {
    state.messages.push({
      id: nextAskMessageId(),
      role: "assistant",
      content: String(
        result?.message || result?.error || "Could not answer this question.",
      )
        .trim()
        .slice(0, 1_000),
      status: "error",
      retryQuestion: question,
    });
  }

  state.loading = false;
  return true;
}

function resolveAskChipAction(question, currentWebEnabled, enableWeb) {
  return {
    question: normalizeAskComposerQuestion(question),
    webEnabled: enableWeb === true || currentWebEnabled === true,
  };
}

function setupAskEventListeners() {
  const form = document.getElementById("askForm");
  const input = document.getElementById("askInput");
  const webToggle = document.getElementById("askWebToggle");

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAskFromComposer();
  });
  input?.addEventListener("input", () => {
    setAskComposerError("");
    updateAskComposerUi();
  });
  input?.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      submitAskFromComposer();
    }
  });
  webToggle?.addEventListener("change", () => {
    askState.webEnabled = webToggle.checked === true;
  });

  document.querySelectorAll("[data-ask-question]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = resolveAskChipAction(
        button.dataset.askQuestion,
        askState.webEnabled,
        button.dataset.enableWeb === "true",
      );
      setAskWebEnabled(action.webEnabled);
      submitAskQuestion(action.question);
    });
  });
  updateAskComposerUi();
}

function setAskWebEnabled(enabled) {
  askState.webEnabled = enabled === true;
  const toggle = document.getElementById("askWebToggle");
  if (toggle) toggle.checked = askState.webEnabled;
}

function setAskComposerError(message) {
  const error = document.getElementById("askComposerError");
  if (error) error.textContent = String(message || "");
}

function updateAskComposerUi() {
  const input = document.getElementById("askInput");
  const sendButton = document.getElementById("askSendBtn");
  const characterCount = document.getElementById("askCharacterCount");
  const webToggle = document.getElementById("askWebToggle");
  const value = String(input?.value || "");
  const canSend =
    value.trim().length > 0 &&
    value.length <= ASK_QUESTION_MAX_LENGTH &&
    !askState.loading;

  if (sendButton) sendButton.disabled = !canSend;
  if (characterCount) {
    characterCount.textContent = `${value.length} / ${ASK_QUESTION_MAX_LENGTH}`;
  }
  if (webToggle) {
    webToggle.checked = askState.webEnabled;
    webToggle.disabled = askState.loading;
  }
  document.querySelectorAll(".ask-chip").forEach((button) => {
    button.disabled = askState.loading;
  });
}

function submitAskFromComposer() {
  const input = document.getElementById("askInput");
  const question = String(input?.value || "");
  if (!submitAskQuestion(question)) return;
  if (input) input.value = "";
  updateAskComposerUi();
}

function submitAskQuestion(question, options = {}) {
  let request;
  try {
    request = beginAskRequest(askState, question, options);
  } catch (error) {
    setAskComposerError(error.message);
    return false;
  }
  if (!request) return false;

  setAskComposerError("");
  renderAskConversation();
  updateAskComposerUi();
  void deliverAskRequest(request);
  return true;
}

async function deliverAskRequest(request) {
  const payload = buildAskRequestPayload({
    question: request.question,
    history: request.history,
    webEnabled: request.webEnabled,
    videoId: request.snapshot.videoId,
    transcriptText: currentTranscriptTimestamped || currentTranscriptText,
    videoTitle: currentVideoTitle,
    channelName: currentChannelName,
    videoDescription: currentVideoDescription,
    videoDuration: currentVideoDuration,
    overview: currentAnalysis,
  });

  let result;
  try {
    result = await chrome.runtime.sendMessage(payload);
  } catch (error) {
    result = {
      success: false,
      message: error.message || "Could not answer this question.",
    };
  }

  if (
    !applyAskRequestResult(
      askState,
      request.snapshot,
      result,
      request.question,
    )
  ) {
    return;
  }
  renderAskConversation();
  updateAskComposerUi();
}

async function ensureAskSuggestions({ retry = false } = {}) {
  if (retry) {
    askState.suggestionsRequested = false;
    askState.suggestionsError = "";
  }
  if (!shouldLoadAskSuggestions(askState) || !currentTranscriptTimestamped) {
    renderAskSuggestions();
    return;
  }

  askState.suggestionsLoading = true;
  askState.suggestionsRequested = true;
  const snapshot = {
    videoId: askState.videoId,
    generation: askState.generation,
  };
  renderAskSuggestions();

  try {
    const result = await chrome.runtime.sendMessage({
      action: "suggestVideoQuestions",
      videoId: snapshot.videoId,
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
      overview: currentAnalysis,
    });
    if (!isCurrentAskSnapshot(askState, snapshot)) return;

    const suggestions = normalizeAskUiSuggestions(result?.suggestions);
    if (result?.success === true && suggestions.length === 3) {
      askState.suggestions = suggestions;
      askState.suggestionsContextReduced = result.contextReduced === true;
      askState.suggestionsError = "";
      await saveToCache(snapshot.videoId);
    } else {
      askState.suggestionsError = String(
        result?.message || result?.error || "Suggested questions are unavailable.",
      )
        .trim()
        .slice(0, 500);
    }
  } catch (error) {
    if (!isCurrentAskSnapshot(askState, snapshot)) return;
    askState.suggestionsError = String(
      error.message || "Suggested questions are unavailable.",
    )
      .trim()
      .slice(0, 500);
  } finally {
    if (isCurrentAskSnapshot(askState, snapshot)) {
      askState.suggestionsLoading = false;
      renderAskSuggestions();
      updateAskComposerUi();
    }
  }
}

function captureAskFocusedControl(container) {
  const active = document.activeElement;
  if (!active || !container?.contains(active)) return null;
  return { key: String(active.dataset?.askFocusKey || "") };
}

function restoreAskFocusedControl(snapshot) {
  if (!snapshot) return;
  const candidate = snapshot.key
    ? document.querySelector(
        `[data-ask-focus-key="${CSS.escape(snapshot.key)}"]`,
      )
    : null;
  if (candidate) {
    candidate.focus({ preventScroll: true });
    return;
  }
  document.getElementById("askInput")?.focus({ preventScroll: true });
}

function getAskStatusAnnouncement(state) {
  if (state.loading) {
    return {
      key: `loading:${state.statusSequence}`,
      text: "AI is thinking.",
    };
  }
  const latest = [...state.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!latest) return null;
  const prefix = latest.status === "error" ? "AI answer failed. " : "AI answer: ";
  return {
    key: `${latest.status}:${latest.id}`,
    text: `${prefix}${String(latest.content || "").slice(0, 2_000)}`,
  };
}

function announceAskStatus(state) {
  const status = document.getElementById("askStatus");
  if (!status) return;
  const announcement = getAskStatusAnnouncement(state);
  if (!announcement) {
    status.textContent = "";
    return;
  }
  if (state.lastAnnouncementKey === announcement.key) return;
  state.lastAnnouncementKey = announcement.key;
  status.textContent = announcement.text;
}

function renderAskSuggestions() {
  const container = document.getElementById("askGeneratedSuggestions");
  if (!container) return;
  const focusSnapshot = captureAskFocusedControl(container);
  container.replaceChildren();

  if (askState.suggestionsLoading) {
    const status = document.createElement("span");
    status.className = "ask-suggestions-status";
    status.textContent = "Generating video-specific questions...";
    container.appendChild(status);
    restoreAskFocusedControl(focusSnapshot);
    return;
  }

  if (askState.suggestions.length) {
    askState.suggestions.forEach((suggestion, index) => {
      const button = document.createElement("button");
      button.className = "ask-chip";
      button.type = "button";
      button.textContent = suggestion;
      button.dataset.askFocusKey = `suggestion:${index}`;
      button.addEventListener("click", () => {
        const action = resolveAskChipAction(
          suggestion,
          askState.webEnabled,
          false,
        );
        submitAskQuestion(action.question);
      });
      container.appendChild(button);
    });
    restoreAskFocusedControl(focusSnapshot);
    return;
  }

  if (askState.suggestionsError) {
    const status = document.createElement("span");
    status.className = "ask-suggestions-status";
    status.textContent = "Video-specific questions are unavailable.";
    const retryButton = document.createElement("button");
    retryButton.className = "ask-suggestions-retry";
    retryButton.type = "button";
    retryButton.textContent = "Retry";
    retryButton.dataset.askFocusKey = "suggestions-retry";
    retryButton.addEventListener("click", () =>
      ensureAskSuggestions({ retry: true }),
    );
    container.append(status, retryButton);
  }
  restoreAskFocusedControl(focusSnapshot);
}

function renderAskConversation() {
  const messagesContainer = document.getElementById("askMessages");
  if (!messagesContainer) return;
  const focusSnapshot = captureAskFocusedControl(messagesContainer);
  messagesContainer.replaceChildren();

  if (!askState.messages.length && !askState.loading) {
    const empty = document.createElement("div");
    empty.className = "ask-empty";
    empty.textContent =
      "Choose a suggested question or ask anything grounded in this video.";
    messagesContainer.appendChild(empty);
  }

  askState.messages.forEach((message) => {
    const messageElement = document.createElement("article");
    const visualRole = message.status === "error" ? "error" : message.role;
    messageElement.className = `ask-message ${visualRole}`;
    messageElement.dataset.messageId = message.id;
    messageElement.setAttribute(
      "aria-label",
      message.role === "user" ? "Your question" : "AI answer",
    );

    const messageBody = document.createElement("div");
    messageBody.className = "ask-message-body";
    messageBody.textContent = message.content;
    messageElement.appendChild(messageBody);

    if (message.status === "error") {
      const retryButton = document.createElement("button");
      retryButton.className = "ask-retry-btn";
      retryButton.type = "button";
      retryButton.textContent = "Retry";
      retryButton.dataset.askFocusKey = `retry:${message.id}`;
      retryButton.addEventListener("click", () => {
        submitAskQuestion(message.retryQuestion, {
          retryMessageId: message.id,
        });
      });
      messageElement.appendChild(retryButton);
    }

    if (message.contextReduced || message.webWarning) {
      const metadata = document.createElement("div");
      metadata.className = "ask-message-meta";
      if (message.contextReduced) {
        const contextLabel = document.createElement("span");
        contextLabel.className = "ask-context-label";
        contextLabel.textContent = "Selected transcript excerpts used";
        metadata.appendChild(contextLabel);
      }
      if (message.webWarning) {
        const warning = document.createElement("span");
        warning.className = "ask-web-warning";
        warning.textContent = message.webWarning;
        metadata.appendChild(warning);
      }
      messageElement.appendChild(metadata);
    }

    if (Array.isArray(message.sources) && message.sources.length) {
      const sources = document.createElement("div");
      sources.className = "ask-sources";
      const sourcesTitle = document.createElement("div");
      sourcesTitle.className = "ask-sources-title";
      sourcesTitle.textContent = "Web sources";
      sources.appendChild(sourcesTitle);
      message.sources.forEach((source, sourceIndex) => {
        const sourceLink = document.createElement("a");
        sourceLink.className = "ask-source-link";
        sourceLink.href = source.url;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        sourceLink.textContent = source.title;
        sourceLink.dataset.askFocusKey = `source:${message.id}:${sourceIndex}`;
        sources.appendChild(sourceLink);
      });
      messageElement.appendChild(sources);
    }

    messagesContainer.appendChild(messageElement);
  });

  if (askState.loading) {
    const thinkingMessage = document.createElement("div");
    thinkingMessage.className = "ask-message assistant";
    const thinking = document.createElement("div");
    thinking.className = "ask-message-body ask-thinking";
    thinking.textContent = "Thinking...";
    thinkingMessage.appendChild(thinking);
    messagesContainer.appendChild(thinkingMessage);
  }

  const askScrollRegion = document.getElementById("askScrollRegion");
  if (askScrollRegion) {
    askScrollRegion.scrollTop = askScrollRegion.scrollHeight;
  }
  restoreAskFocusedControl(focusSnapshot);
  announceAskStatus(askState);
}

function renderAskUi() {
  setAskWebEnabled(askState.webEnabled);
  renderAskSuggestions();
  renderAskConversation();
  updateAskComposerUi();
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  const requestSnapshot = {
    analysisGeneration: ++analysisGeneration,
    digestGeneration,
    videoId: currentVideoId,
    transcriptTimestamped: currentTranscriptTimestamped,
  };
  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  const summary = document.getElementById("overviewSummary");

  if (summary) summary.textContent = "Loading summary...";
  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });
    if (!isCurrentAnalysisRequest(requestSnapshot)) return;

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);
    if (currentOverviewMode !== "original") await translateOverview();
    if (!isCurrentAnalysisRequest(requestSnapshot)) return;

    // Save to cache now that we have analysis
    await saveToCache(requestSnapshot.videoId, requestSnapshot);
  } catch (error) {
    if (!isCurrentAnalysisRequest(requestSnapshot)) return;
    console.error("[Speak Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  } finally {
    if (isCurrentAnalysisRequest(requestSnapshot)) {
      isAnalysisLoading = false;
    }
  }
}

function isCurrentAnalysisRequest(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.analysisGeneration === analysisGeneration &&
      snapshot.digestGeneration === digestGeneration &&
      snapshot.videoId === currentVideoId &&
      snapshot.transcriptTimestamped === currentTranscriptTimestamped,
  );
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[Speak Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[Speak Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[Speak Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[Speak Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[Speak Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[Speak Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows Explain and vocabulary Save actions.
 */
function setupExplainFeature() {
  explainSelectionAbortController?.abort();
  explainSelectionAbortController = null;
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;
  explainSelectionAbortController = new AbortController();

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the selection actions.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn" type="button">💡 Explain</button><button class="vocabulary-save-btn" type="button">Save</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  let selectedContext = "";
  let selectedVocabularyMetadata = null;

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    (e) => {
      const selection = window.getSelection();
      const text = selection.toString().trim();

      // Only show if selecting within transcript
      const isInTranscript = transcriptList.contains(selection.anchorNode);

      // Allow any selection length (removed 10+ char requirement)
      if (text.length > 0 && isInTranscript) {
        selectedText = text;
        const selectedTranscriptEntry = getSelectionTranscriptEntry(
          selection,
          transcriptList,
        );
        selectedContext = buildExplainContextFromSelection(
          selectedText,
          selectedTranscriptEntry,
          getActiveTranscriptSegments(),
          currentTranscriptText || "",
        );
        selectedVocabularyMetadata = buildVocabularySelectionMetadata(
          selectedText,
          selectedTranscriptEntry,
          getActiveTranscriptSegments(),
          currentTranscriptText || "",
          {
            videoId: currentVideoId,
            videoTitle: currentVideoTitle,
            channelName: currentChannelName,
          },
        );

        // Position the tooltip near the selection
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        tooltip.style.display = "block";
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: explainSelectionAbortController.signal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!tooltip.contains(e.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: explainSelectionAbortController.signal },
  );

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      await showExplanation(
        selectedText,
        selectedContext,
        selectedVocabularyMetadata,
        event.currentTarget,
      );
    });

  tooltip
    .querySelector(".vocabulary-save-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedVocabularyMetadata) return;
      await saveVocabularySelection(
        selectedVocabularyMetadata,
        event.currentTarget,
      );
    });
}

/**
 * Finds the semantic transcript row containing either end of the selection.
 */
function getSelectionTranscriptEntry(selection, transcriptList) {
  for (const node of [selection?.anchorNode, selection?.focusNode]) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const entry = element?.closest?.(".transcript-entry");
    if (entry && transcriptList.contains(entry)) return entry;
  }
  return null;
}

/**
 * Uses stable row metadata to recover original source context even when the
 * visible selection came from a Chinese translation. String lookup remains a
 * fallback for legacy rows or selections without semantic metadata.
 */
function buildExplainContextFromSelection(
  selectedText,
  transcriptEntry,
  sourceSegments,
  fullText,
) {
  const segments = Array.isArray(sourceSegments) ? sourceSegments : [];
  const segmentId = transcriptEntry?.dataset?.segmentId || "";
  let index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    const datasetIndex = Number(transcriptEntry?.dataset?.segmentIndex);
    if (Number.isInteger(datasetIndex) && segments[datasetIndex]) {
      index = datasetIndex;
    }
  }

  if (index >= 0) {
    return segments
      .slice(Math.max(0, index - 1), Math.min(segments.length, index + 2))
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(" ");
  }

  return getTranscriptContext(selectedText, fullText);
}

function renderExplanationText(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function renderExplanationContent(mode, english, chinese, translationError) {
  const normalizedMode = ["english", "zh", "bilingual"].includes(mode)
    ? mode
    : "english";
  const source = `<section class="explain-text explain-source" lang="en">${renderExplanationText(english)}</section>`;
  const translation = chinese
    ? `<section class="explain-text explain-translation" lang="zh-CN">${renderExplanationText(chinese)}</section>`
    : translationError
      ? `<div class="explain-translation-error"><span>${escapeHtml(translationError)}</span><button class="explain-retry-btn" type="button">Retry</button></div>`
      : `<div class="explain-loading explain-translation-loading"><div class="loading-bar"></div><span>Translating...</span></div>`;

  if (normalizedMode === "english") return source;
  if (normalizedMode === "zh" && chinese) return translation;
  if (normalizedMode === "zh" && translationError) {
    return `${source}${translation}`;
  }
  if (normalizedMode === "zh") return translation;
  return `${source}<div class="explain-bilingual-divider" role="separator"></div>${translation}`;
}

function createExplanationTranslationState(
  english = "",
  videoId = null,
  videoTitle = "",
) {
  return {
    mode: "english",
    english: String(english || ""),
    videoId,
    videoTitle: String(videoTitle || ""),
    chinese: "",
    translationError: "",
    translationPromise: null,
    translationGeneration: 0,
  };
}

/**
 * Lazily translates one English explanation. The state belongs to one modal,
 * so duplicate language switches share a request and late detached-modal
 * replies cannot mutate the current UI.
 */
function ensureExplanationTranslation(
  state,
  {
    sendMessage = sendTranslationMessage,
    videoTitle = state.videoTitle,
    isCurrent = () => true,
    retry = false,
  } = {},
) {
  if (state.chinese) return Promise.resolve(state.chinese);
  if (state.translationPromise) return state.translationPromise;
  if (state.translationError && !retry) return Promise.resolve("");
  if (!state.english) return Promise.resolve("");

  const generation = ++state.translationGeneration;
  state.translationError = "";
  let responsePromise;
  try {
    responsePromise = sendMessage({
      action: "translateContent",
      content: {
        segments: [{ id: "explain-0", text: state.english }],
      },
      contentType: "explainBatch",
      targetLanguage: "zh",
      videoTitle,
    });
  } catch (error) {
    responsePromise = Promise.reject(error);
  }
  state.translationPromise = Promise.resolve(responsePromise)
    .then((result) => {
      if (!isCurrent() || generation !== state.translationGeneration) return "";
      if (!result?.success) {
        throw new Error(result?.error || "Translation failed.");
      }
      const translated = result.translatedContent?.segments?.find(
        (segment) => segment.id === "explain-0",
      )?.text;
      if (!translated?.trim()) throw new Error("Translation returned no text.");
      state.chinese = translated.trim();
      return state.chinese;
    })
    .catch((error) => {
      if (isCurrent() && generation === state.translationGeneration) {
        state.translationError = error.message || "Translation failed.";
      }
      return "";
    })
    .finally(() => {
      if (generation === state.translationGeneration) {
        state.translationPromise = null;
      }
    });
  return state.translationPromise;
}

/**
 * Shows the explanation modal and fetches one concise English explanation.
 */
function getModalFocusableElements(modal) {
  return Array.from(
    modal.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

async function showExplanation(
  selectedText,
  transcriptContext,
  vocabularySelection = null,
  invoker = null,
) {
  const modalVideoId = currentVideoId;
  const modalVideoTitle = currentVideoTitle;
  const modalInvoker = invoker || document.activeElement;
  const modalVocabularySelection = vocabularySelection || {
    term: selectedText,
    sourceExcerpt: selectedText,
    context: transcriptContext,
    videoId: modalVideoId,
    videoTitle: String(modalVideoTitle || ""),
    channelName: currentChannelName,
    timestamp: 0,
  };
  const previousModal = document.getElementById("explainModal");
  if (closeActiveExplanationModal) {
    closeActiveExplanationModal();
  } else if (previousModal) {
    previousModal.remove();
  }

  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal" role="dialog" aria-modal="true" aria-labelledby="explainModalTitle">
      <div class="explain-modal-header">
        <div class="explain-modal-title" id="explainModalTitle">Explain</div>
        <button class="explain-modal-close" id="closeExplain" type="button" aria-label="Close explanation">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-language-controls" role="group" aria-label="Explanation language">
        <button class="explain-language-btn active" type="button" data-explain-mode="english" aria-pressed="true">English</button>
        <button class="explain-language-btn" type="button" data-explain-mode="zh" aria-pressed="false">中文</button>
        <button class="explain-language-btn" type="button" data-explain-mode="bilingual" aria-pressed="false">双语</button>
      </div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
      <div class="explain-modal-actions">
        <button class="explain-save-vocabulary" type="button">Save to Vocabulary</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const state = createExplanationTranslationState(
    "",
    modalVideoId,
    modalVideoTitle,
  );
  const contentDiv = modal.querySelector("#explanationContent");
  const modeButtons = modal.querySelectorAll("[data-explain-mode]");
  const closeButton = modal.querySelector("#closeExplain");
  const saveVocabularyButton = modal.querySelector(
    ".explain-save-vocabulary",
  );
  const isCurrent = () =>
    modal.isConnected &&
    currentVideoId === modalVideoId &&
    document.getElementById("explainModal") === modal;
  const render = () => {
    if (!isCurrent()) return;
    if (!state.english) return;
    contentDiv.innerHTML = renderExplanationContent(
      state.mode,
      state.english,
      state.chinese,
      state.translationError,
    );
  };
  const requestChinese = async () => {
    if (!state.english || state.mode === "english") return;
    render();
    await ensureExplanationTranslation(state, {
      videoTitle: modalVideoTitle,
      isCurrent,
    });
    render();
  };
  let closed = false;
  const closeModal = () => {
    if (closed) return;
    closed = true;
    state.translationGeneration += 1;
    modal.remove();
    if (closeActiveExplanationModal === closeModal) {
      closeActiveExplanationModal = null;
    }
    if (modalInvoker?.isConnected && typeof modalInvoker.focus === "function") {
      modalInvoker.focus({ preventScroll: true });
    }
  };
  closeActiveExplanationModal = closeModal;

  // Close handlers
  closeButton.addEventListener("click", closeModal);
  saveVocabularyButton.addEventListener("click", () =>
    saveVocabularySelection(modalVocabularySelection, saveVocabularyButton),
  );
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      const focusable = getModalFocusableElements(modal);
      if (!focusable.length) {
        event.preventDefault();
        closeButton.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !modal.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !modal.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  });
  closeButton.focus({ preventScroll: true });
  modeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      state.mode = button.dataset.explainMode;
      modeButtons.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      render();
      await requestChinese();
    });
  });
  contentDiv.addEventListener("click", async (event) => {
    if (!event.target.closest(".explain-retry-btn")) return;
    const retryPromise = ensureExplanationTranslation(state, {
      videoTitle: modalVideoTitle,
      isCurrent,
      retry: true,
    });
    render();
    await retryPromise;
    render();
  });

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: modalVideoTitle,
    });

    if (!isCurrent()) return;
    if (result.success) {
      state.english = String(result.explanation || "").trim();
      if (!state.english) {
        contentDiv.innerHTML = `<div class="explain-error">The explanation was empty. Please try again.</div>`;
        return;
      }
      render();
      await requestChinese();
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    if (!isCurrent()) return;
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText, transcriptText = currentTranscriptText || "") {
  const fullText = transcriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// LIBRARY / VOCABULARY
// ============================================================

/**
 * Captures the displayed selection while recovering its original subtitle
 * excerpt and context from stable row metadata.
 */
function buildVocabularySelectionMetadata(
  selectedText,
  transcriptEntry,
  sourceSegments,
  fullText,
  videoMetadata = {},
) {
  const segments = Array.isArray(sourceSegments) ? sourceSegments : [];
  const segmentId = transcriptEntry?.dataset?.segmentId || "";
  let index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    const datasetIndex = Number(transcriptEntry?.dataset?.segmentIndex);
    if (Number.isInteger(datasetIndex) && segments[datasetIndex]) {
      index = datasetIndex;
    }
  }

  const sourceExcerpt = index >= 0
    ? String(segments[index]?.text || "")
    : String(selectedText || "");
  const context = index >= 0
    ? segments
        .slice(Math.max(0, index - 1), Math.min(segments.length, index + 2))
        .map((segment) => segment.text)
        .filter(Boolean)
        .join(" ")
    : getTranscriptContext(selectedText, fullText);
  const rowSeconds = Number(transcriptEntry?.dataset?.seconds);
  const segmentSeconds = Number(segments[index]?.start);
  const timestamp = Number.isFinite(rowSeconds)
    ? rowSeconds
    : Number.isFinite(segmentSeconds)
      ? segmentSeconds
      : 0;

  return {
    term: String(selectedText || "").trim(),
    sourceExcerpt,
    context,
    videoId: String(videoMetadata.videoId || ""),
    videoTitle: String(videoMetadata.videoTitle || ""),
    channelName: String(videoMetadata.channelName || ""),
    timestamp,
  };
}

function buildVocabularySaveMessage(selection) {
  return {
    action: "saveVocabulary",
    term: String(selection?.term || ""),
    sourceExcerpt: String(selection?.sourceExcerpt || ""),
    context: String(selection?.context || ""),
    videoId: String(selection?.videoId || ""),
    videoTitle: String(selection?.videoTitle || ""),
    channelName: String(selection?.channelName || ""),
    timestamp: Number(selection?.timestamp) || 0,
  };
}

function vocabularySaveKey(selection) {
  const term = String(selection?.term || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  return `${term}\u0000${selection?.videoId || ""}\u0000${Number(selection?.timestamp) || 0}`;
}

function setVocabularySaveFeedback(button, label, disabled) {
  if (!button) return;
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent || "Save";
  }
  button.textContent = label;
  button.disabled = disabled;
}

async function saveVocabularySelection(selection, button) {
  const message = buildVocabularySaveMessage(selection);
  if (!message.term || !message.videoId) {
    setVocabularySaveFeedback(button, "Could not save", false);
    return { success: false };
  }

  const key = vocabularySaveKey(selection);
  setVocabularySaveFeedback(button, "Saving…", true);
  let request = vocabularySavePromises.get(key);
  if (!request) {
    try {
      request = Promise.resolve(chrome.runtime.sendMessage(message));
    } catch (error) {
      request = Promise.reject(error);
    }
    vocabularySavePromises.set(key, request);
    const clearRequest = () => {
      if (vocabularySavePromises.get(key) === request) {
        vocabularySavePromises.delete(key);
      }
    };
    request.then(clearRequest, clearRequest);
  }

  try {
    const result = await request;
    if (!result?.success) {
      throw new Error(result?.message || result?.error || "Could not save");
    }
    setVocabularySaveFeedback(
      button,
      result.alreadySaved ? "Already saved" : "Saved",
      true,
    );
    await refreshVocabularyEntries();
    setTimeout(() => {
      if (!button?.isConnected) return;
      setVocabularySaveFeedback(button, button.dataset.defaultLabel, false);
    }, 1800);
    return result;
  } catch (error) {
    console.error("[Speak Digest Panel] Save vocabulary error:", error);
    setVocabularySaveFeedback(button, "Could not save", false);
    return { success: false, error: error.message };
  }
}

async function refreshVocabularyEntries(requestSnapshot = null) {
  const generation = ++vocabularyLoadGeneration;
  try {
    const result = await chrome.runtime.sendMessage({ action: "getVocabulary" });
    if (
      generation !== vocabularyLoadGeneration ||
      (requestSnapshot && !isCurrentDigestRequest(requestSnapshot))
    ) {
      return;
    }
    vocabularyEntries = result?.success && Array.isArray(result.vocabulary)
      ? result.vocabulary
      : [];
    refreshTranscriptHighlights();
    if (currentLibraryView === "vocabulary") {
      renderVocabularyForCurrentFilter();
    }
  } catch (error) {
    if (generation !== vocabularyLoadGeneration) return;
    console.error("[Speak Digest Panel] Load vocabulary error:", error);
  }
}

function renderVocabularyForCurrentFilter() {
  const entries = showAllVocabulary
    ? vocabularyEntries
    : vocabularyEntries.filter((entry) => entry.videoId === currentVideoId);
  renderVocabulary(entries, showAllVocabulary ? null : currentVideoId);
}

function getSafeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function resolveVocabularySpeechLanguage(term, sourceLanguage) {
  const spokenTerm = typeof term === "string" ? term.trim() : "";
  if (!spokenTerm) return "";

  if (sourceLanguage === "zh") return "zh-CN";
  if (sourceLanguage === "ja") return "ja-JP";
  if (sourceLanguage === "ko") return "ko-KR";
  if (/[\u3040-\u30ff]/u.test(spokenTerm)) return "ja-JP";
  if (/[\uac00-\ud7af]/u.test(spokenTerm)) return "ko-KR";
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(spokenTerm)) {
    return "zh-CN";
  }

  const letters = Array.from(spokenTerm).filter((character) =>
    /\p{L}/u.test(character),
  );
  const isLatin =
    letters.length > 0 &&
    letters.every((character) => /\p{Script=Latin}/u.test(character));
  return isLatin ? "en-US" : "";
}

function selectPreferredSpeechVoice(voices, targetLanguage) {
  const normalizeLanguage = (value) =>
    typeof value === "string"
      ? value.trim().replaceAll("_", "-").toLocaleLowerCase("en-US")
      : "";
  const target = normalizeLanguage(targetLanguage);
  if (!target || !Array.isArray(voices)) return null;
  const targetBase = target.split("-")[0];
  const candidates = voices.filter(
    (voice) => voice && normalizeLanguage(voice.lang),
  );
  const exact = (voice) => normalizeLanguage(voice.lang) === target;
  const baseMatch = (voice) =>
    normalizeLanguage(voice.lang).split("-")[0] === targetBase;
  if (targetBase === "en") {
    const naturalVoice = candidates.find(
      (voice) =>
        normalizeLanguage(voice.lang) === "en-us" &&
        /online.*natural/i.test(String(voice.name || "")),
    );
    if (naturalVoice) return naturalVoice;
    const googleVoice = candidates.find(
      (voice) =>
        normalizeLanguage(voice.lang) === "en-us" &&
        /google us english/i.test(String(voice.name || "")),
    );
    if (googleVoice) return googleVoice;
    const samanthaVoice = candidates.find(
      (voice) =>
        voice.localService === true &&
        normalizeLanguage(voice.lang) === "en-us" &&
        String(voice.name || "").trim().toLocaleLowerCase("en-US") ===
          "samantha",
    );
    if (samanthaVoice) return samanthaVoice;
  }

  return (
    candidates.find(
      (voice) => voice.default && voice.localService && exact(voice),
    ) ||
    candidates.find((voice) => voice.localService && exact(voice)) ||
    candidates.find((voice) => voice.localService && baseMatch(voice)) ||
    candidates.find(
      (voice) => voice.default && (exact(voice) || baseMatch(voice)),
    ) ||
    candidates.find(exact) ||
    candidates.find(baseMatch) ||
    null
  );
}

function speakVocabularyTerm(
  term,
  sourceLanguage,
  speechSynthesis,
  UtteranceCtor,
  onEnd,
) {
  const spokenTerm = typeof term === "string" ? term.trim() : "";
  const speechLanguage = resolveVocabularySpeechLanguage(
    spokenTerm,
    sourceLanguage,
  );
  if (
    !spokenTerm ||
    !speechLanguage ||
    !speechSynthesis ||
    typeof speechSynthesis.cancel !== "function" ||
    typeof speechSynthesis.speak !== "function" ||
    typeof UtteranceCtor !== "function"
  ) {
    return false;
  }

  try {
    const utterance = new UtteranceCtor(spokenTerm);
    let voices = [];
    if (typeof speechSynthesis.getVoices === "function") {
      try {
        voices = speechSynthesis.getVoices();
      } catch {
        voices = [];
      }
    }
    const preferredVoice = selectPreferredSpeechVoice(voices, speechLanguage);
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang;
    } else {
      utterance.lang = speechLanguage;
    }
    if (typeof onEnd === "function") {
      utterance.onend = () => onEnd("idle");
      utterance.onerror = (event) =>
        onEnd(
          ["canceled", "interrupted"].includes(event?.error) ? "idle" : "error",
        );
    }
    speechSynthesis.cancel();
    speechSynthesis.resume?.();
    speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

function dictionaryAudioUrl(term, sourceLanguage) {
  if (typeof term !== "string") return null;
  if (resolveVocabularySpeechLanguage(term, sourceLanguage) !== "en-US") {
    return null;
  }
  const text = term
    .normalize("NFKC")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !text ||
    text.length > 240 ||
    !/[a-z]/i.test(text) ||
    !/^[a-z0-9 '.,!?()\/-]+$/i.test(text)
  ) {
    return null;
  }
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`;
}

// One player serves every Vocabulary card. English uses dictionary audio first;
// other languages, or failed dictionary playback, use browser speech.
function createVocabularyPronunciationPlayer(
  createAudio,
  speechSynthesis,
  UtteranceCtor,
  schedule = setTimeout,
  clear = clearTimeout,
) {
  let active = null;
  const speechAvailable = Boolean(
    speechSynthesis &&
      typeof speechSynthesis.cancel === "function" &&
      typeof speechSynthesis.speak === "function" &&
      typeof UtteranceCtor === "function",
  );
  const audioAvailable = typeof createAudio === "function";

  function clearAudio(current) {
    if (current.timer !== null) {
      clear(current.timer);
      current.timer = null;
    }
    if (!current.audio) return;
    const audio = current.audio;
    current.audio = null;
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
      audio.removeAttribute?.("src");
      audio.load?.();
    } catch {
      // The audio element may already be detached during panel teardown.
    }
  }

  function finish(current, state) {
    if (active !== current) return;
    active = null;
    clearAudio(current);
    current.onState(state);
  }

  function stop(owner) {
    if (!active || (owner !== undefined && active.owner !== owner)) return;
    const current = active;
    active = null;
    clearAudio(current);
    if (current.mode === "speech") {
      try {
        speechSynthesis?.cancel?.();
      } catch {
        // Playback may already have ended.
      }
    }
    current.onState("idle");
  }

  function useFallback(current) {
    if (active !== current || current.mode === "speech") return;
    current.mode = "speech";
    clearAudio(current);
    if (!speechAvailable) {
      finish(current, "error");
      return;
    }
    const started = speakVocabularyTerm(
      current.term,
      current.sourceLanguage,
      speechSynthesis,
      UtteranceCtor,
      (state) => finish(current, state),
    );
    if (!started) finish(current, "error");
    else if (active === current) current.onState("playing");
  }

  function play(term, sourceLanguage, owner, onState, beforePlay) {
    stop();
    const spokenTerm = typeof term === "string" ? term.trim() : "";
    const language = resolveVocabularySpeechLanguage(spokenTerm, sourceLanguage);
    const url = dictionaryAudioUrl(spokenTerm, sourceLanguage);
    if (
      !spokenTerm ||
      spokenTerm.length > 1000 ||
      !language ||
      (!speechAvailable && !(audioAvailable && url))
    ) {
      onState("error");
      return false;
    }

    const current = {
      term: spokenTerm,
      sourceLanguage,
      owner,
      onState,
      mode: "audio",
      audio: null,
      timer: null,
    };
    active = current;
    try {
      beforePlay?.();
    } catch {
      // A missing YouTube receiver should not block pronunciation.
    }

    if (!url || !audioAvailable) {
      useFallback(current);
      return true;
    }

    try {
      const audio = createAudio(url);
      if (!audio || typeof audio.play !== "function") {
        useFallback(current);
        return true;
      }
      current.audio = audio;
      audio.preload = "none";
      audio.playbackRate = 1;
      audio.onplaying = () => {
        if (active === current && current.timer !== null) {
          clear(current.timer);
          current.timer = null;
        }
      };
      audio.onended = () => finish(current, "idle");
      audio.onerror = () => useFallback(current);
      current.onState("playing");
      current.timer = schedule(() => useFallback(current), 5000);
      Promise.resolve(audio.play()).catch(() => useFallback(current));
      return true;
    } catch {
      useFallback(current);
      return true;
    }
  }

  return { play, stop, audioAvailable, speechAvailable };
}

function getVocabularySpeechServices() {
  if (vocabularyPronunciationPlayer) return vocabularyPronunciationPlayer;
  const browserWindow = typeof window !== "undefined" ? window : null;
  const UtteranceCtor =
    typeof SpeechSynthesisUtterance === "function"
      ? SpeechSynthesisUtterance
      : browserWindow?.SpeechSynthesisUtterance;
  vocabularyPronunciationPlayer = createVocabularyPronunciationPlayer(
    typeof browserWindow?.Audio === "function"
      ? (url) => new browserWindow.Audio(url)
      : null,
    browserWindow?.speechSynthesis,
    UtteranceCtor,
  );
  browserWindow?.addEventListener?.("pagehide", () => {
    vocabularyPronunciationPlayer?.stop();
  });
  return vocabularyPronunciationPlayer;
}

function pauseYouTubePlaybackForPronunciation() {
  try {
    const request = chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "pauseVideo" },
    });
    request?.catch?.(() => {});
  } catch {
    // Audio can still play if the active YouTube tab has disconnected.
  }
}

function createVocabularySpeakerIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("vocabulary-speaker-icon");

  const speaker = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  speaker.setAttribute("d", "M11 5 6.5 9H3v6h3.5l4.5 4V5Z");
  const wave = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  wave.setAttribute("d", "M15.5 8.5a5 5 0 0 1 0 7");
  svg.append(speaker, wave);
  return svg;
}

function openVocabularyTimestamp(entry, safeUrl) {
  if (!safeUrl) return;
  if (entry.videoId === currentVideoId) {
    seekTo(Number(entry.timestampSeconds) || 0);
    return;
  }
  chrome.tabs.create({ url: safeUrl });
}

function renderVocabulary(entries, filteredVideoId) {
  vocabularyPronunciationPlayer?.stop();
  const vocabularyList = document.getElementById("vocabularyList");
  const vocabularyIntro = document.getElementById("vocabularyIntro");
  if (!vocabularyList || !vocabularyIntro) return;
  vocabularyList.replaceChildren();

  if (!Array.isArray(entries) || entries.length === 0) {
    vocabularyIntro.hidden = false;
    vocabularyIntro.textContent = filteredVideoId
      ? "No vocabulary saved from this video yet. Select transcript text and choose Save."
      : "No vocabulary saved yet. Select transcript text and choose Save.";
    return;
  }

  vocabularyIntro.hidden = true;
  const pronunciationPlayer = getVocabularySpeechServices();
  entries.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "vocabulary-item";

    const header = document.createElement("div");
    header.className = "vocabulary-item-header";
    const termBlock = document.createElement("div");
    termBlock.className = "vocabulary-term-block";
    const term = document.createElement("div");
    term.className = "vocabulary-term";
    term.textContent = String(entry.term || "");
    termBlock.appendChild(term);
    const phoneticText = String(entry.phonetic || "").trim();
    if (phoneticText) {
      const phonetic = document.createElement("div");
      phonetic.className = "vocabulary-phonetic";
      phonetic.textContent = phoneticText;
      termBlock.appendChild(phonetic);
    }

    const headerActions = document.createElement("div");
    headerActions.className = "vocabulary-item-actions";
    const termLabel = String(entry.term || "vocabulary");
    const speechLanguage = resolveVocabularySpeechLanguage(
      termLabel,
      String(entry.sourceLanguage || ""),
    );
    let pronunciationControl;
    const canPlay = Boolean(
      speechLanguage &&
        (pronunciationPlayer.speechAvailable ||
          (pronunciationPlayer.audioAvailable &&
            dictionaryAudioUrl(termLabel, String(entry.sourceLanguage || "")))),
    );
    if (canPlay) {
      const pronunciationButton = document.createElement("button");
      pronunciationButton.className = "vocabulary-pronunciation";
      pronunciationButton.type = "button";
      pronunciationButton.appendChild(createVocabularySpeakerIcon());
      pronunciationButton.title = `Pronounce ${termLabel}`;
      pronunciationButton.setAttribute("aria-label", `Pronounce ${termLabel}`);
      const feedback = document.createElement("span");
      feedback.className = "vocabulary-pronunciation-error";
      feedback.setAttribute("role", "status");
      feedback.hidden = true;
      termBlock.appendChild(feedback);
      pronunciationButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pronunciationPlayer.play(
          termLabel,
          String(entry.sourceLanguage || ""),
          pronunciationButton,
          (state) => {
            pronunciationButton.classList.toggle("is-playing", state === "playing");
            feedback.hidden = state !== "error";
            feedback.textContent =
              state === "error" ? "Pronunciation unavailable. Try again." : "";
          },
          pauseYouTubePlaybackForPronunciation,
        );
      });
      pronunciationControl = pronunciationButton;
    } else {
      const unavailable = document.createElement("span");
      unavailable.className = "vocabulary-pronunciation-unavailable";
      unavailable.textContent = "Pronunciation unavailable";
      unavailable.setAttribute("role", "note");
      unavailable.setAttribute(
        "aria-label",
        `Pronunciation unavailable for ${termLabel}`,
      );
      pronunciationControl = unavailable;
    }
    const deleteButton = document.createElement("button");
    deleteButton.className = "vocabulary-delete";
    deleteButton.type = "button";
    deleteButton.title = "Delete vocabulary";
    deleteButton.setAttribute("aria-label", `Delete ${String(entry.term || "vocabulary")}`);
    deleteButton.textContent = "✕";
    deleteButton.addEventListener("click", () =>
      deleteVocabularyEntry(String(entry.id || "")),
    );
    headerActions.append(pronunciationControl, deleteButton);
    header.append(termBlock, headerActions);

    const meaning = document.createElement("div");
    meaning.className = "vocabulary-meaning";
    meaning.textContent = String(entry.meaningZh || "");
    const explanation = document.createElement("div");
    explanation.className = "vocabulary-explanation";
    explanation.textContent = String(entry.explanationZh || "");
    const excerpt = document.createElement("blockquote");
    excerpt.className = "vocabulary-excerpt";
    excerpt.textContent = String(entry.sourceExcerpt || "");

    const footer = document.createElement("div");
    footer.className = "vocabulary-item-footer";
    const safeUrl = getSafeHttpUrl(entry.timestampedUrl);
    const timestampButton = document.createElement("button");
    timestampButton.className = "vocabulary-timestamp";
    timestampButton.type = "button";
    timestampButton.textContent = String(entry.timestamp || "0:00");
    if (safeUrl) {
      timestampButton.addEventListener("click", () =>
        openVocabularyTimestamp(entry, safeUrl),
      );
    } else {
      timestampButton.disabled = true;
      timestampButton.title = "Timestamp unavailable";
    }
    footer.appendChild(timestampButton);

    if (!filteredVideoId) {
      const videoTitle = document.createElement("span");
      videoTitle.className = "vocabulary-video-title";
      videoTitle.textContent = String(entry.videoTitle || "Untitled video");
      footer.appendChild(videoTitle);
    }

    card.append(header, meaning, explanation, excerpt, footer);
    vocabularyList.appendChild(card);
  });
}

async function deleteVocabularyEntry(entryId) {
  if (!entryId) return;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "deleteVocabulary",
      vocabularyId: entryId,
    });
    if (!result?.success) {
      throw new Error(result?.message || result?.error || "Delete failed");
    }
    await refreshVocabularyEntries();
  } catch (error) {
    console.error("[Speak Digest Panel] Delete vocabulary error:", error);
  }
}

function buildNormalizedVocabularyText(value, maxLength) {
  const source = String(value || "").slice(0, maxLength);
  let text = "";
  const starts = [];
  const ends = [];
  let pendingWhitespace = null;

  for (let sourceIndex = 0; sourceIndex < source.length;) {
    const codePoint = source.codePointAt(sourceIndex);
    let sourceCluster = String.fromCodePoint(codePoint);
    let sourceEnd = sourceIndex + sourceCluster.length;
    while (sourceEnd < source.length) {
      const nextCodePoint = source.codePointAt(sourceEnd);
      const nextCharacter = String.fromCodePoint(nextCodePoint);
      if (!/^\p{M}$/u.test(nextCharacter)) break;
      sourceCluster += nextCharacter;
      sourceEnd += nextCharacter.length;
    }
    const normalizedPiece = sourceCluster.normalize("NFKC").toLocaleLowerCase();

    for (const character of normalizedPiece) {
      if (/\s/u.test(character)) {
        if (text && !pendingWhitespace) {
          pendingWhitespace = { start: sourceIndex, end: sourceEnd };
        } else if (pendingWhitespace) {
          pendingWhitespace.end = sourceEnd;
        }
        continue;
      }

      if (pendingWhitespace) {
        text += " ";
        starts.push(pendingWhitespace.start);
        ends.push(pendingWhitespace.end);
        pendingWhitespace = null;
      }
      for (let index = 0; index < character.length; index += 1) {
        text += character[index];
        starts.push(sourceIndex);
        ends.push(sourceEnd);
      }
    }
    sourceIndex = sourceEnd;
  }

  return { source, text, starts, ends };
}

function isLatinWordCharacter(character) {
  return Boolean(character && /[a-z0-9_]/i.test(character));
}

function createTranscriptSearchState(videoId = null) {
  return {
    videoId: videoId || null,
    query: "",
    matches: [],
    currentIndex: -1,
  };
}

function getNextTranscriptSearchIndex(currentIndex, matchCount, direction) {
  if (!Number.isInteger(matchCount) || matchCount <= 0) return -1;
  const step = direction < 0 ? -1 : 1;
  const start = Number.isInteger(currentIndex) ? currentIndex : -1;
  return (start + step + matchCount) % matchCount;
}

function isTranscriptSearchTextNodeEligible(node) {
  const parent = node?.parentElement;
  if (!parent || !String(node.nodeValue || "").trim()) return false;
  if (
    parent.closest(
      ".transcript-search-highlight, .transcript-time, button, a, .transcript-row-actions, .translation-pending, .translation-error",
    )
  ) {
    return false;
  }
  if (!parent.closest(".transcript-entry")) return false;
  return Boolean(
    parent.closest(
      ".transcript-text, .transcript-original, .transcript-translation",
    ),
  );
}

function replaceTranscriptSearchTextNode(textNode, matches) {
  if (!textNode || !Array.isArray(matches) || !matches.length) return [];
  const sourceText = String(textNode.nodeValue || "");
  const ownerDocument = textNode.ownerDocument || document;
  const fragment = ownerDocument.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  matches.forEach((match) => {
    const start = Number(match?.start);
    const end = Number(match?.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < cursor ||
      end <= start ||
      end > sourceText.length
    ) {
      return;
    }
    if (start > cursor) {
      fragment.appendChild(ownerDocument.createTextNode(sourceText.slice(cursor, start)));
    }
    const mark = ownerDocument.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = sourceText.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (!marks.length) return [];
  if (cursor < sourceText.length) {
    fragment.appendChild(ownerDocument.createTextNode(sourceText.slice(cursor)));
  }
  textNode.replaceWith(fragment);
  return marks;
}

function updateTranscriptSearchControls() {
  const matchCount = transcriptSearchState.matches.length;
  const currentNumber = matchCount ? transcriptSearchState.currentIndex + 1 : 0;
  const count = document.getElementById("transcriptSearchCount");
  const clear = document.getElementById("transcriptSearchClear");
  const previous = document.getElementById("transcriptSearchPrevious");
  const next = document.getElementById("transcriptSearchNext");
  if (count) count.textContent = `${currentNumber} / ${matchCount}`;
  if (clear) clear.disabled = !transcriptSearchState.query.trim();
  if (previous) previous.disabled = matchCount === 0;
  if (next) next.disabled = matchCount === 0;
}

function pauseTranscriptAutoFollowForSearch() {
  autoScrollEnabled = false;
  const followPlaybackBtn = document.getElementById("followPlaybackBtn");
  if (followPlaybackBtn) followPlaybackBtn.style.display = "block";
}

function selectTranscriptSearchResult(index, { scroll = false } = {}) {
  const matches = transcriptSearchState.matches;
  if (!matches.length) {
    transcriptSearchState.currentIndex = -1;
    updateTranscriptSearchControls();
    return false;
  }

  const boundedIndex = Math.min(Math.max(Number(index) || 0, 0), matches.length - 1);
  transcriptSearchState.currentIndex = boundedIndex;
  matches.forEach((mark, markIndex) => {
    const current = markIndex === boundedIndex;
    mark.classList?.toggle("current-search-result", current);
    if (current) mark.setAttribute?.("aria-current", "true");
    else mark.removeAttribute?.("aria-current");
  });
  updateTranscriptSearchControls();

  const currentMark = matches[boundedIndex];
  if (scroll && currentMark?.scrollIntoView) {
    pauseTranscriptAutoFollowForSearch();
    lastAutoScrollTime = Date.now();
    currentMark.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return true;
}

function applyTranscriptSearchHighlights(
  root = document.getElementById("transcriptList"),
  { scrollCurrent = false } = {},
) {
  if (!root) return [];
  const previousIndex = transcriptSearchState.currentIndex;
  clearTranscriptSearchHighlights(root);
  transcriptSearchState.matches = [];

  if (
    transcriptSearchState.videoId !== currentVideoId ||
    !transcriptSearchState.query.trim()
  ) {
    transcriptSearchState.currentIndex = -1;
    updateTranscriptSearchControls();
    return [];
  }

  const ownerDocument = root.ownerDocument || document;
  const walker = ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return isTranscriptSearchTextNodeEligible(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const textNode of textNodes) {
    const remaining =
      TRANSCRIPT_SEARCH_LIMITS.maxMatches - transcriptSearchState.matches.length;
    if (remaining <= 0) break;
    const matches = findLiteralTranscriptMatches(
      textNode.nodeValue || "",
      transcriptSearchState.query,
    ).slice(0, remaining);
    transcriptSearchState.matches.push(
      ...replaceTranscriptSearchTextNode(textNode, matches),
    );
  }

  transcriptSearchState.currentIndex = transcriptSearchState.matches.length
    ? Math.min(Math.max(previousIndex, 0), transcriptSearchState.matches.length - 1)
    : -1;
  selectTranscriptSearchResult(transcriptSearchState.currentIndex, {
    scroll: scrollCurrent,
  });
  return transcriptSearchState.matches;
}

function refreshTranscriptHighlights(
  root = document.getElementById("transcriptList"),
) {
  if (!root) return;
  clearTranscriptSearchHighlights(root);
  applyVocabularyHighlights(root);
  applyTranscriptSearchHighlights(root);
}

function setTranscriptSearchQuery(value, { scroll = false } = {}) {
  const query = String(value || "").slice(
    0,
    TRANSCRIPT_SEARCH_LIMITS.maxQueryLength,
  );
  transcriptSearchState.query = query;
  transcriptSearchState.currentIndex = query.trim() ? 0 : -1;
  applyTranscriptSearchHighlights(document.getElementById("transcriptList"), {
    scrollCurrent: scroll && Boolean(query.trim()),
  });
}

function navigateTranscriptSearch(direction) {
  const nextIndex = getNextTranscriptSearchIndex(
    transcriptSearchState.currentIndex,
    transcriptSearchState.matches.length,
    direction,
  );
  return selectTranscriptSearchResult(nextIndex, { scroll: true });
}

function clearTranscriptSearch() {
  clearTranscriptSearchHighlights();
  transcriptSearchState = createTranscriptSearchState(currentVideoId);
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  updateTranscriptSearchControls();
}

function resetTranscriptSearchForVideo(videoId) {
  if (transcriptSearchState.videoId === (videoId || null)) return;
  clearTranscriptSearchHighlights();
  transcriptSearchState = createTranscriptSearchState(videoId);
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  updateTranscriptSearchControls();
}

/**
 * Finds bounded, non-overlapping literal matches in one rendered Transcript
 * segment. Normalization keeps source offsets while indexOf avoids treating
 * user input as a regular expression.
 */
function findLiteralTranscriptMatches(text, query) {
  const trimmedQuery = String(query || "").trim();
  if (
    !trimmedQuery ||
    trimmedQuery.length > TRANSCRIPT_SEARCH_LIMITS.maxQueryLength
  ) {
    return [];
  }

  const normalizedText = buildNormalizedVocabularyText(
    text,
    TRANSCRIPT_SEARCH_LIMITS.maxTextLength,
  );
  const normalizedQuery = buildNormalizedVocabularyText(
    trimmedQuery,
    TRANSCRIPT_SEARCH_LIMITS.maxQueryLength,
  ).text;
  if (!normalizedText.text || !normalizedQuery) return [];

  const matches = [];
  let fromIndex = 0;
  while (
    fromIndex <= normalizedText.text.length - normalizedQuery.length &&
    matches.length < TRANSCRIPT_SEARCH_LIMITS.maxMatches
  ) {
    const matchIndex = normalizedText.text.indexOf(normalizedQuery, fromIndex);
    if (matchIndex < 0) break;
    const normalizedEnd = matchIndex + normalizedQuery.length;
    const start = normalizedText.starts[matchIndex];
    const end = normalizedText.ends[normalizedEnd - 1];
    if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
      matches.push({ start, end });
    }
    fromIndex = normalizedEnd;
  }
  return matches;
}

function clearTranscriptSearchHighlights(
  root = document.getElementById("transcriptList"),
) {
  if (!root) return;
  const ownerDocument = root.ownerDocument || document;
  root
    .querySelectorAll("mark.transcript-search-highlight")
    .forEach((mark) => {
      const textNode = ownerDocument.createTextNode(mark.textContent || "");
      const parent = mark.parentNode;
      mark.replaceWith(textNode);
      parent?.normalize();
    });
}

/**
 * Plans literal text matches without constructing a RegExp from saved input.
 * Longer terms claim overlaps first; all work is bounded by fixed limits.
 */
function planVocabularyMatches(text, entries) {
  const normalizedText = buildNormalizedVocabularyText(
    text,
    VOCABULARY_MATCH_LIMITS.maxTextLength,
  );
  if (!normalizedText.text || !Array.isArray(entries)) return [];

  const seenTerms = new Set();
  const terms = entries
    .slice(0, VOCABULARY_MATCH_LIMITS.maxEntries)
    .map((entry, order) => ({
      entry,
      order,
      term: buildNormalizedVocabularyText(
        entry?.normalizedTerm || entry?.term,
        VOCABULARY_MATCH_LIMITS.maxTermLength,
      ).text,
    }))
    .filter((candidate) => {
      if (!candidate.term || seenTerms.has(candidate.term)) return false;
      seenTerms.add(candidate.term);
      return true;
    })
    .sort((left, right) =>
      right.term.length - left.term.length || left.order - right.order,
    );

  const accepted = [];
  let candidateCount = 0;
  for (const candidate of terms) {
    let fromIndex = 0;
    let occurrenceCount = 0;
    const hasLatinWord = /[a-z0-9]/i.test(candidate.term);
    while (
      fromIndex <= normalizedText.text.length - candidate.term.length &&
      candidateCount < 2_000 &&
      occurrenceCount < 1_000
    ) {
      const matchIndex = normalizedText.text.indexOf(candidate.term, fromIndex);
      if (matchIndex < 0) break;
      const normalizedEnd = matchIndex + candidate.term.length;
      fromIndex = matchIndex + Math.max(1, candidate.term.length);
      occurrenceCount += 1;
      candidateCount += 1;

      if (
        hasLatinWord &&
        (isLatinWordCharacter(normalizedText.text[matchIndex - 1]) ||
          isLatinWordCharacter(normalizedText.text[normalizedEnd]))
      ) {
        continue;
      }

      const start = normalizedText.starts[matchIndex];
      const end = normalizedText.ends[normalizedEnd - 1];
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        continue;
      }
      const overlaps = accepted.some(
        (match) => start < match.end && end > match.start,
      );
      if (overlaps) continue;
      accepted.push({
        start,
        end,
        entryId: String(candidate.entry?.id || ""),
        term: String(candidate.entry?.term || candidate.term),
        text: normalizedText.source.slice(start, end),
      });
    }
    if (candidateCount >= 2_000) break;
  }

  return accepted.sort((left, right) => left.start - right.start);
}

function clearVocabularyHighlights(root = document.getElementById("transcriptList")) {
  if (!root) return;
  root.querySelectorAll("mark.vocabulary-highlight").forEach((mark) => {
    const textNode = document.createTextNode(mark.textContent || "");
    const parent = mark.parentNode;
    mark.replaceWith(textNode);
    parent?.normalize();
  });
}

function applyVocabularyHighlights(root = document.getElementById("transcriptList")) {
  if (!root) return;
  clearVocabularyHighlights(root);
  if (!vocabularyEntries.length) return;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".vocabulary-highlight, .transcript-time, button, a")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(".translation-pending, .translation-error")) {
          return NodeFilter.FILTER_REJECT;
        }
        return parent.closest(".transcript-entry")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach((textNode) => {
    const sourceText = textNode.nodeValue || "";
    const matches = planVocabularyMatches(sourceText, vocabularyEntries);
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      if (match.start > cursor) {
        fragment.appendChild(
          document.createTextNode(sourceText.slice(cursor, match.start)),
        );
      }
      const mark = document.createElement("mark");
      mark.className = "vocabulary-highlight";
      mark.dataset.vocabularyId = match.entryId;
      mark.textContent = sourceText.slice(match.start, match.end);
      fragment.appendChild(mark);
      cursor = match.end;
    });
    if (cursor < sourceText.length) {
      fragment.appendChild(document.createTextNode(sourceText.slice(cursor)));
    }
    textNode.replaceWith(fragment);
  });
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
function isCurrentCacheRequest(requestSnapshot) {
  if (!requestSnapshot) return true;
  return "analysisGeneration" in requestSnapshot
    ? isCurrentAnalysisRequest(requestSnapshot)
    : isCurrentDigestRequest(requestSnapshot);
}

async function saveToCache(videoId, requestSnapshot = null) {
  if (
    !videoId ||
    videoId !== currentVideoId ||
    !currentTranscript ||
    !isCurrentCacheRequest(requestSnapshot)
  ) {
    return;
  }

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSource: currentTranscriptSource,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      askSuggestions:
        askState.videoId === videoId ? [...askState.suggestions] : [],
      askSuggestionsContextReduced:
        askState.videoId === videoId &&
        askState.suggestionsContextReduced === true,
      timestamp: Date.now(),
    };

    if (!isCurrentCacheRequest(requestSnapshot)) return;
    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    if (!isCurrentCacheRequest(requestSnapshot)) return;
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[Speak Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId, requestSnapshot = null) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    if (requestSnapshot && !isCurrentDigestRequest(requestSnapshot)) return null;
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId, requestSnapshot = null) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (requestSnapshot && !isCurrentDigestRequest(requestSnapshot)) return;

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[Speak Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[Speak Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const followPlaybackBtn = document.getElementById("followPlaybackBtn");
  if (transcriptSearchState.query.trim()) {
    autoScrollEnabled = false;
    if (followPlaybackBtn) followPlaybackBtn.style.display = "block";
  } else {
    autoScrollEnabled = true;
    if (followPlaybackBtn) followPlaybackBtn.style.display = "none";
  }

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  if (!transcriptTabIsActive()) return;
  if (isRestoringTranscriptView) return;

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }

  captureTranscriptViewPosition();
}

// ============================================================
// OVERVIEW MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function overviewTranslationCacheKey(fieldId) {
  return `${currentVideoId}:zh:overview:${fieldId}`;
}

function getOverviewTranslation(fieldId) {
  return transcriptParagraphCache.get(overviewTranslationCacheKey(fieldId)) || "";
}

function getOverviewFieldDisplayText(sourceText, fieldId) {
  const source = String(sourceText || "").trim();
  const translated = getOverviewTranslation(fieldId);
  if (currentOverviewMode === "zh") return translated || source;
  if (currentOverviewMode === "bilingual" && translated) {
    return `${source}\n\n${translated}`;
  }
  return source;
}

function renderOverviewField(sourceText, fieldId) {
  const source = String(sourceText || "").trim();
  if (currentOverviewMode === "original") return escapeHtml(source);

  const translated = getOverviewTranslation(fieldId);
  const error = overviewTranslationErrors.get(overviewTranslationCacheKey(fieldId));
  const translatedText = translated || error || "Waiting for translation…";
  const stateClass = translated
    ? ""
    : error
      ? "translation-error"
      : "translation-pending";
  const translationHtml = `<span class="overview-translation ${stateClass}">${escapeHtml(translatedText)}</span>`;

  if (currentOverviewMode === "bilingual") {
    return `<span class="overview-original">${escapeHtml(source)}</span>${translationHtml}`;
  }
  return translationHtml;
}

function getOverviewTranslationSegments(analysis) {
  const segments = [];
  const add = (id, text) => {
    const normalized = String(text || "").trim();
    if (normalized) segments.push({ id, text: normalized });
  };

  add("overview-summary", analysis?.summary);
  (analysis?.chapters || []).forEach((chapter, index) => {
    add(`chapter-title-${index}`, chapter.title);
    add(`chapter-summary-${index}`, chapter.summary);
  });
  (analysis?.keyQuotes || []).forEach((quote, index) => {
    add(`quote-${index}`, quote.quote);
  });
  return segments;
}

function setOverviewModeButtons(mode) {
  document.querySelectorAll("[data-overview-mode]").forEach((button) => {
    const active = button.dataset.overviewMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setOverviewTranslatingSpinner(show) {
  if (show) overviewTranslationWorkCount += 1;
  else overviewTranslationWorkCount = Math.max(0, overviewTranslationWorkCount - 1);
  document
    .getElementById("overviewLangSpinner")
    ?.classList.toggle("visible", overviewTranslationWorkCount > 0);
}

async function handleOverviewModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentOverviewMode) return;

  currentOverviewMode = mode;
  overviewTranslationGeneration += 1;
  overviewTranslationWorkCount = 0;
  setOverviewTranslatingSpinner(false);
  setOverviewModeButtons(mode);
  if (currentAnalysis) renderAnalysisResults(currentAnalysis);
  if (mode !== "original") await translateOverview();
}

async function translateOverview() {
  if (!currentAnalysis || currentOverviewMode === "original") return;

  overviewTranslationGeneration += 1;
  const generation = overviewTranslationGeneration;
  const videoId = currentVideoId;
  const segments = getOverviewTranslationSegments(currentAnalysis).filter(
    (segment) => !getOverviewTranslation(segment.id),
  );
  if (!segments.length) {
    renderAnalysisResults(currentAnalysis);
    return;
  }

  setOverviewTranslatingSpinner(true);
  try {
    for (let index = 0; index < segments.length; index += 4) {
      const batch = segments.slice(index, index + 4);
      const result = await sendTranslationMessage({
        action: "translateContent",
        content: { segments: batch },
        contentType: "overviewBatch",
        targetLanguage: "zh",
        videoTitle: currentVideoTitle,
      });
      if (
        generation !== overviewTranslationGeneration ||
        videoId !== currentVideoId ||
        currentOverviewMode === "original"
      ) {
        return;
      }

      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item) => {
        const key = overviewTranslationCacheKey(item.id);
        if (item.text) {
          transcriptParagraphCache.set(key, item.text);
          overviewTranslationErrors.delete(key);
        } else {
          overviewTranslationErrors.set(
            key,
            result?.error || item.error || "Translation unavailable.",
          );
        }
      });
      renderAnalysisResults(currentAnalysis);
    }
    await updateCache();
  } catch (error) {
    if (generation !== overviewTranslationGeneration) return;
    segments.forEach((segment) => {
      overviewTranslationErrors.set(
        overviewTranslationCacheKey(segment.id),
        error.message || "Translation failed.",
      );
    });
    renderAnalysisResults(currentAnalysis);
  } finally {
    setOverviewTranslatingSpinner(false);
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll("[data-transcript-mode]").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  activeTranslationQueue?.cancel();
  activeTranslationQueue = null;
  currentTranscriptMode = mode;
  setTranscriptActionStatus("");
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = renderTranscriptSourceBadge(modeLabel);
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    addTranscriptRowActions(div, segment);
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  refreshTranscriptHighlights(transcriptList);
  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }

  const transcriptList = document.getElementById("transcriptList");
  refreshTranscriptHighlights(transcriptList);
  syncTranscriptRowActions(row);
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
    syncTranscriptRowActions(row);
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  activeTranslationQueue?.cancel();
  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  const inFlight = new Set();
  const idleWaiters = [];
  let processing = false;
  let canceled = false;

  const settleIdleWaiters = () => {
    if (!canceled && (processing || queue.length)) return;
    idleWaiters.splice(0).forEach((resolve) => resolve());
  };

  const processNext = async () => {
    if (processing || canceled || generation !== translationGeneration) {
      settleIdleWaiters();
      return;
    }
    if (!queue.length) {
      settleIdleWaiters();
      return;
    }
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => {
      queued.delete(index);
      inFlight.add(index);
    });
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      indices.forEach((index) => inFlight.delete(index));
      processing = false;
      if (queue.length && !canceled && generation === translationGeneration) {
        void processNext();
      } else {
        settleIdleWaiters();
      }
    }
  };

  const enqueue = (index, force = false) => {
    if (canceled || !Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index) || inFlight.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  const completeMissing = () => {
    segments.forEach((segment, index) => enqueue(index));
    if (!processing && !queue.length) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  };
  const cancel = () => {
    canceled = true;
    queue.length = 0;
    queued.clear();
    settleIdleWaiters();
  };
  activeTranslationQueue = { enqueue, completeMissing, cancel, videoId, mode };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  loadTranscriptViewState,
  saveTranscriptViewState,
  transcriptTabIsActive,
  setupTranscriptViewStateListeners,
  captureTranscriptViewPosition,
  loadPendingTranscriptViewState,
  restorePendingTranscriptViewState,
  onContentAreaScroll,
  setTranscriptReadingPositionTestState(state = {}) {
    if (Object.hasOwn(state, "videoId")) currentVideoId = state.videoId;
    if (Object.hasOwn(state, "activeVideoId")) {
      activeDigestVideoId = state.activeVideoId;
    }
    if (Object.hasOwn(state, "generation")) {
      digestGeneration = state.generation;
    }
    if (Object.hasOwn(state, "pending")) {
      pendingTranscriptViewState = state.pending;
    }
    if (Object.hasOwn(state, "autoScrollEnabled")) {
      autoScrollEnabled = state.autoScrollEnabled;
    }
  },
  getTranscriptReadingPositionTestState: () => ({
    pending: pendingTranscriptViewState,
    lastTranscriptScrollTop,
    isRestoringTranscriptView,
    autoScrollEnabled,
    lastAutoScrollTime,
  }),
  sendTranslationMessage,
  createExplanationTranslationState,
  ensureExplanationTranslation,
  renderExplanationContent,
  buildExplainContextFromSelection,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  buildTranscriptTextForMode,
  prepareSelectedTranscriptText,
  exportTranscript,
  setTranscriptExportTestState(state) {
    currentVideoId = state.videoId;
    currentTranscript = state.transcript;
    currentTranscriptText = state.originalText;
    currentTranscriptMode = state.mode;
    currentVideoTitle = state.videoTitle || "";
    currentChannelName = state.channelName || "";
    currentVideoDescription = state.description || "";
    translationGeneration = state.generation || 0;
    transcriptParagraphCache = state.translationCache || new Map();
    activeTranslationQueue = state.queue || null;
  },
  createTranscriptSearchState,
  getNextTranscriptSearchIndex,
  isTranscriptSearchTextNodeEligible,
  replaceTranscriptSearchTextNode,
  findLiteralTranscriptMatches,
  clearTranscriptSearchHighlights,
  getOverviewTranslationSegments,
  buildAudioTranscriptionConfirmation,
};

globalThis.__YTD_ASK_UI_TESTING__ = {
  createAskState,
  resetAskStateForVideo,
  shouldLoadAskSuggestions,
  beginAskRequest,
  applyAskRequestResult,
  buildAskRequestPayload,
  resolveAskChipAction,
  isCurrentAskSnapshot,
  normalizeAskAssistantResult,
};

globalThis.__YTD_VOCABULARY_UI_TESTING__ = {
  buildVocabularySelectionMetadata,
  buildVocabularySaveMessage,
  planVocabularyMatches,
  getSafeHttpUrl,
  resolveVocabularySpeechLanguage,
  selectPreferredSpeechVoice,
  speakVocabularyTerm,
  dictionaryAudioUrl,
  createVocabularyPronunciationPlayer,
};

globalThis.__YTD_RACE_TESTING__ = {
  checkCurrentTab,
  startDigest,
  triggerAnalysis,
  getRaceState: () => ({
    currentVideoId,
    currentVideoUrl,
    currentVideoTitle,
    currentTranscriptText,
    currentAnalysis,
    isAnalysisLoading,
    digestGeneration,
    analysisGeneration,
    youtubeTabId,
    askVideoId: askState.videoId,
  }),
};
