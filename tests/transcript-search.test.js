const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);
const html = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.html"),
  "utf8",
);
const styles = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.css"),
  "utf8",
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadSearchHelpers({ forbidRegExpConstruction = false } = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    RegExp: forbidRegExpConstruction
      ? function ForbiddenDynamicRegExp() {
          throw new Error("dynamic RegExp construction is forbidden");
        }
      : RegExp,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
      createElement: () => ({
        addEventListener() {},
        appendChild() {},
        classList: { add() {}, remove() {}, toggle() {} },
        style: {},
      }),
    },
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage: async () => ({ success: true }),
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
      storage: { session: { get: async () => ({}), set: async () => {} } },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

test("literal Transcript search is case-insensitive for Latin text", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("Alpha beta ALPHA", "alpha")),
    [
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ],
  );
});

test("literal Transcript search treats punctuation and metacharacters literally", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("[a+b] and [A+B]", "[a+b]")),
    [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ],
  );
});

test("literal Transcript search finds Chinese text", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("学习中文，中文很有趣", "中文")),
    [
      { start: 2, end: 4 },
      { start: 5, end: 7 },
    ],
  );
});

test("literal Transcript search maps composed accents to complete source clusters", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("Cafe\u0301 noir", "caf\u00e9")),
    [{ start: 0, end: 5 }],
  );
  assert.deepEqual(
    plain(findLiteralTranscriptMatches("Caf\u00e9 noir", "cafe\u0301")),
    [{ start: 0, end: 4 }],
  );
  assert.deepEqual(
    plain(findLiteralTranscriptMatches("\ud83d\ude00\uff23afe\u0301", "caf\u00e9")),
    [{ start: 2, end: 7 }],
  );
});

test("literal Transcript search ignores blank input and trims meaningful queries", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(plain(findLiteralTranscriptMatches("alpha beta", "   ")), []);
  assert.deepEqual(
    plain(findLiteralTranscriptMatches("alpha beta", "  beta  ")),
    [{ start: 6, end: 10 }],
  );
});

test("literal Transcript search accepts 200 characters and rejects longer queries", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();
  const acceptedQuery = "a".repeat(200);

  assert.deepEqual(
    plain(findLiteralTranscriptMatches(acceptedQuery, acceptedQuery)),
    [{ start: 0, end: 200 }],
  );
  assert.deepEqual(
    plain(findLiteralTranscriptMatches("a".repeat(201), "a".repeat(201))),
    [],
  );
});

test("literal Transcript search returns non-overlapping matches", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("aaaa", "aa")),
    [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
  );
});

test("literal Transcript search bounds source work to one rendered segment", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers();
  const withinBound = `${"x".repeat(11_994)}needle`;
  const beyondBound = `${"x".repeat(12_000)}needle`;

  assert.deepEqual(
    plain(findLiteralTranscriptMatches(withinBound, "needle")),
    [{ start: 11_994, end: 12_000 }],
  );
  assert.deepEqual(
    plain(findLiteralTranscriptMatches(beyondBound, "needle")),
    [],
  );
});

test("literal Transcript search does not construct a RegExp from the query", () => {
  const { findLiteralTranscriptMatches } = loadSearchHelpers({
    forbidRegExpConstruction: true,
  });

  assert.deepEqual(
    plain(findLiteralTranscriptMatches("Use (a+b)* safely", "(a+b)*")),
    [{ start: 4, end: 10 }],
  );
});

test("clearing Transcript search marks preserves vocabulary and inline markup", () => {
  const { clearTranscriptSearchHighlights } = loadSearchHelpers();
  const vocabularyMark = { className: "vocabulary-highlight", replaced: false };
  const inlineMarkup = { tagName: "EM", textContent: "kept" };
  let queriedSelector = "";
  let normalized = 0;
  const parent = { normalize: () => { normalized += 1; } };
  const searchMarks = ["first", "second"].map((textContent) => ({
    className: "transcript-search-highlight",
    textContent,
    parentNode: parent,
    replaceWith(node) {
      this.replacement = node;
    },
  }));
  const root = {
    children: [vocabularyMark, inlineMarkup, ...searchMarks],
    querySelectorAll(selector) {
      queriedSelector = selector;
      return this.children.filter(
        (child) =>
          child.className === "transcript-search-highlight" &&
          selector === "mark.transcript-search-highlight",
      );
    },
  };

  clearTranscriptSearchHighlights(root);

  assert.equal(queriedSelector, "mark.transcript-search-highlight");
  assert.equal(vocabularyMark.replaced, false);
  assert.equal(inlineMarkup.tagName, "EM");
  assert.deepEqual(
    searchMarks.map((mark) => mark.replacement?.textContent),
    ["first", "second"],
  );
  assert.equal(normalized, 2);
});

test("Transcript search exposes labelled bounded controls and live result count", () => {
  assert.match(
    html,
    /<label[^>]*for="transcriptSearchInput"[^>]*>\s*Search transcript\s*<\/label>/,
  );
  assert.match(
    html,
    /<input[^>]*id="transcriptSearchInput"[^>]*type="search"[^>]*maxlength="200"/,
  );
  assert.match(html, /id="transcriptSearchClear"[^>]*aria-label="Clear transcript search"/);
  assert.match(html, /id="transcriptSearchCount"[^>]*aria-live="polite"/);
  assert.match(html, /id="transcriptSearchPrevious"[^>]*aria-label="Previous search result"/);
  assert.match(html, /id="transcriptSearchNext"[^>]*aria-label="Next search result"/);
});

test("Transcript search hides Chrome's native cancel button behind the custom clear control", () => {
  assert.match(
    styles,
    /\.transcript-search-field input::\-webkit-search-cancel-button\s*\{[^}]*-webkit-appearance:\s*none;[^}]*appearance:\s*none;[^}]*display:\s*none;/,
  );
});

test("Transcript search state is video-scoped and navigation wraps", () => {
  const {
    createTranscriptSearchState,
    getNextTranscriptSearchIndex,
  } = loadSearchHelpers();
  const state = createTranscriptSearchState("video-A");

  assert.deepEqual(plain(state), {
    videoId: "video-A",
    query: "",
    matches: [],
    currentIndex: -1,
  });
  assert.equal(getNextTranscriptSearchIndex(-1, 3, 1), 0);
  assert.equal(getNextTranscriptSearchIndex(2, 3, 1), 0);
  assert.equal(getNextTranscriptSearchIndex(0, 3, -1), 2);
  assert.equal(getNextTranscriptSearchIndex(0, 0, 1), -1);
});

test("Transcript search only accepts displayed transcript copy nodes", () => {
  const { isTranscriptSearchTextNodeEligible } = loadSearchHelpers();
  const textNode = (matchedSelector) => ({
    nodeValue: "visible text",
    parentElement: {
      closest(selector) {
        if (selector === ".transcript-entry") return {};
        if (
          selector ===
          ".transcript-text, .transcript-original, .transcript-translation"
        ) {
          return matchedSelector === "copy" ? {} : null;
        }
        return selector.includes(matchedSelector) ? {} : null;
      },
    },
  });

  assert.equal(isTranscriptSearchTextNodeEligible(textNode("copy")), true);
  for (const excluded of [
    ".transcript-time",
    "button",
    "a",
    ".transcript-row-actions",
    ".translation-pending",
    ".translation-error",
    ".transcript-search-highlight",
  ]) {
    assert.equal(
      isTranscriptSearchTextNodeEligible(textNode(excluded)),
      false,
      `expected ${excluded} to be skipped`,
    );
  }
  assert.equal(
    isTranscriptSearchTextNodeEligible({ nodeValue: "", parentElement: null }),
    false,
  );
});

test("Transcript search creates marks with textContent and a DocumentFragment", () => {
  const { replaceTranscriptSearchTextNode } = loadSearchHelpers();
  const calls = [];
  const fragment = {
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
  };
  const ownerDocument = {
    createDocumentFragment() {
      calls.push("fragment");
      return fragment;
    },
    createTextNode(text) {
      calls.push(["text", text]);
      return { nodeType: 3, textContent: String(text) };
    },
    createElement(tagName) {
      calls.push(["element", tagName]);
      return { tagName: tagName.toUpperCase(), className: "", textContent: "" };
    },
  };
  const textNode = {
    nodeValue: "alpha beta alpha",
    ownerDocument,
    replaceWith(value) {
      this.replacement = value;
    },
  };

  const marks = replaceTranscriptSearchTextNode(textNode, [
    { start: 0, end: 5 },
    { start: 11, end: 16 },
  ]);

  assert.equal(textNode.replacement, fragment);
  assert.deepEqual(plain(marks.map((mark) => mark.textContent)), ["alpha", "alpha"]);
  assert.ok(marks.every((mark) => mark.className === "transcript-search-highlight"));
  assert.equal(calls.filter((call) => call === "fragment").length, 1);
  assert.equal(calls.some((call) => call[0] === "element" && call[1] === "mark"), true);
});

test("Transcript search wires typing, Enter navigation, Shift+Enter, and Escape", () => {
  assert.match(source, /transcriptSearchInput[\s\S]*addEventListener\("input"/);
  assert.match(source, /event\.key === "Enter"[\s\S]*event\.shiftKey/);
  assert.match(source, /event\.key === "Escape"[\s\S]*clearTranscriptSearch/);
  assert.match(source, /transcriptSearchPrevious[\s\S]*navigateTranscriptSearch\(-1\)/);
  assert.match(source, /transcriptSearchNext[\s\S]*navigateTranscriptSearch\(1\)/);
});

test("Transcript search centers the current result and pauses playback follow", () => {
  assert.match(
    source,
    /autoScrollEnabled\s*=\s*false;[\s\S]*followPlaybackBtn[\s\S]*display\s*=\s*"block"/,
  );
  assert.match(
    source,
    /scrollIntoView\(\{\s*behavior:\s*"smooth",\s*block:\s*"center"\s*\}\)/,
  );
  assert.match(styles, /\.transcript-search-highlight\.current-search-result/);
  assert.match(
    source,
    /function startPlaybackTracking\([\s\S]*transcriptSearchState\.query\.trim\(\)[\s\S]*autoScrollEnabled\s*=\s*false/,
  );
});

test("Transcript rerenders rebuild vocabulary first and then active search", () => {
  assert.match(
    source,
    /function refreshTranscriptHighlights[\s\S]*clearTranscriptSearchHighlights[\s\S]*applyVocabularyHighlights[\s\S]*applyTranscriptSearchHighlights/,
  );
  assert.match(source, /function renderTranscript\([\s\S]*refreshTranscriptHighlights\(transcriptList\)/);
  assert.match(source, /function renderTranscriptModeRows[\s\S]*refreshTranscriptHighlights\(transcriptList\)/);
  assert.match(source, /function updateTranslatedRow[\s\S]*refreshTranscriptHighlights\(transcriptList\)/);
  assert.match(source, /function refreshVocabularyEntries[\s\S]*refreshTranscriptHighlights\(\)/);
});

test("Transcript search resets on video changes and never seeks or calls a provider", () => {
  assert.match(
    source,
    /function startDigest\(videoId, videoUrl\)[\s\S]*resetTranscriptSearchForVideo\(videoId\)/,
  );
  const searchBlock = source.slice(
    source.indexOf("function createTranscriptSearchState"),
    source.indexOf("// ============================================================\n// CACHING"),
  );
  assert.doesNotMatch(searchBlock, /seekTo\(|sendMessage\(/);
});

test("Transcript search highlight visually wins inside Vocabulary highlight", () => {
  assert.match(styles, /\.transcript-search-highlight\s*\{[^}]*background:\s*#ffd34e;/);
  assert.match(
    styles,
    /\.vocabulary-highlight \.transcript-search-highlight\s*\{[^}]*background:\s*#ffd34e;/,
  );
});
