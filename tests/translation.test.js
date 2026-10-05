const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  captureDownload = null,
} = {}) {
  const listeners = { addListener() {} };
  const testURL = class extends URL {};
  testURL.createObjectURL = (blob) => {
    if (captureDownload) captureDownload.blob = blob;
    return "blob:test";
  };
  testURL.revokeObjectURL = () => {};
  const buttons = new Map();
  const sandbox = {
    console,
    URL: captureDownload ? testURL : URL,
    Blob,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: (id) => {
        if (!captureDownload) return null;
        if (!buttons.has(id)) buttons.set(id, { textContent: id, disabled: false });
        return buttons.get(id);
      },
      createElement: (tagName) => {
        if (tagName === "a" && captureDownload) {
          return {
            click() {
              captureDownload.filename = this.download;
            },
          };
        }
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async () => ({ ytd_settings: settings }),
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Transcript header exposes and wires Original, Chinese, and bilingual modes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /Original \(\$\{language\}\)/);
});

test("Overview adds a full summary, matching language modes, and sticky controls", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");
  const analysisPrompt = read("prompts/analysis.md");

  assert.match(html, /id="overviewSummary"/);
  assert.match(html, /data-overview-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-overview-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-overview-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(
    html,
    /class="sticky-control-row transcript-control-row"[\s\S]*?id="transcriptModeControl"[\s\S]*?id="copyTranscriptBtn"[\s\S]*?id="exportTranscriptBtn"/,
  );
  assert.match(css, /\.sticky-control-row\s*\{[\s\S]*?position: sticky;[\s\S]*?top: -24px;/);
  assert.match(js, /contentType: "overviewBatch"/);
  assert.match(js, /handleOverviewModeChange\(button\.dataset\.overviewMode\)/);
  assert.match(analysisPrompt, /"summary": "A concise summary of the entire video"/);
});

test("Overview analysis validates summary text and exposes translatable fields", () => {
  const { validateAndFixTimestamps } = loadBackgroundHelpers();
  const analysis = validateAndFixTimestamps(
    {
      summary: "  Whole video summary.  ",
      chapters: [
        {
          title: "Opening",
          summary: "Chapter detail",
          timestampSeconds: 0,
        },
      ],
      keyQuotes: [
        { quote: "A useful quote", timestampSeconds: 5 },
      ],
    },
    60,
  );
  assert.equal(analysis.summary, "Whole video summary.");

  const { getOverviewTranslationSegments } = loadSidepanelHelpers();
  assert.deepEqual(
    JSON.parse(JSON.stringify(getOverviewTranslationSegments(analysis))),
    [
      { id: "overview-summary", text: "Whole video summary." },
      { id: "chapter-title-0", text: "Opening" },
      { id: "chapter-summary-0", text: "Chapter detail" },
      { id: "quote-0", text: "A useful quote" },
    ],
  );
});

test("Overview notes save the currently displayed language", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");
  const styles = read("sidepanel.css");

  assert.match(
    panel,
    /const noteText = getOverviewFieldDisplayText\(quote\.quote, fieldId\)/,
  );
  assert.match(
    panel,
    /action: "saveOverviewNote"[\s\S]*?noteText,[\s\S]*?rawText: quote\.quote,[\s\S]*?languageMode: currentOverviewMode/,
  );
  assert.match(
    panel,
    /currentOverviewMode !== "original" && !translatedText/,
  );
  assert.match(
    panel,
    /quoteTranslationReady[\s\S]*?disabled[\s\S]*?Translating…/,
  );
  assert.match(background, /message\.action === "saveOverviewNote"/);
  assert.doesNotMatch(
    background,
    /handleAnalyzeTranscript\([\s\S]{0,240}message\.noteText/,
  );
  assert.match(styles, /\.note-text\s*\{[\s\S]*?white-space: pre-wrap;/);

  const { buildOverviewQuoteNote } = loadBackgroundHelpers();
  const chineseNote = buildOverviewQuoteNote(
    {
      videoId: "video-id",
      videoTitle: "Video",
      channelName: "Channel",
      timestamp: 65,
      noteText: "这是中文引用。",
      rawText: "This is the original quote.",
      languageMode: "zh",
    },
    "https://www.youtube.com/watch?v=video-id&t=65s",
    1234,
  );
  assert.equal(chineseNote.text, "这是中文引用。");
  assert.equal(chineseNote.rawText, "This is the original quote.");
  assert.equal(chineseNote.languageMode, "zh");
  assert.equal(chineseNote.timestamp, "1:05");

  const bilingualNote = buildOverviewQuoteNote(
    {
      noteText: "Original quote.\n\n双语引用。",
      languageMode: "bilingual",
    },
    "https://www.youtube.com/watch?v=video-id&t=0s",
    1235,
  );
  assert.equal(bilingualNote.text, "Original quote.\n\n双语引用。");
  assert.equal(bilingualNote.languageMode, "bilingual");
});

test("audio transcription stays native by default and requires explicit generation", () => {
  const panelSource = read("sidepanel.js");
  const backgroundSource = read("background.js");
  const { normalizeTranscriptMode } = loadBackgroundHelpers();
  const { buildAudioTranscriptionConfirmation } = loadSidepanelHelpers();

  assert.equal(normalizeTranscriptMode(), "native");
  assert.equal(normalizeTranscriptMode("auto"), "native");
  assert.equal(normalizeTranscriptMode("generate"), "generate");
  assert.match(
    backgroundSource,
    /apiUrl\.searchParams\.set\("mode", transcriptMode\)/,
  );
  assert.match(
    panelSource,
    /error === "NO_TRANSCRIPT"[\s\S]*?showMissingTranscriptError/,
  );
  assert.match(
    panelSource,
    /const confirmed = window\.confirm\([\s\S]*?if \(!confirmed\) return;[\s\S]*?mode: "generate"/,
  );
  assert.match(
    buildAudioTranscriptionConfirmation(30 * 60),
    /30 minutes[\s\S]*60 Supadata credits/,
  );
  assert.match(
    buildAudioTranscriptionConfirmation(0),
    /2 credits per video minute/,
  );
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("Transcript text output follows the selected language and keeps bilingual pairs aligned", () => {
  const { buildTranscriptTextForMode } = loadSidepanelHelpers();
  const segments = [
    { id: "first", text: "First English sentence." },
    { id: "second", text: "Second English sentence." },
  ];
  const translations = new Map([
    ["first", "第一句中文。"],
    ["second", "第二句中文。"],
  ]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(buildTranscriptTextForMode("original", "Original raw transcript", segments, translations))),
    { text: "Original raw transcript", missingCount: 0 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildTranscriptTextForMode("zh", "Original raw transcript", segments, translations))),
    { text: "第一句中文。\n\n第二句中文。", missingCount: 0 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildTranscriptTextForMode("bilingual", "Original raw transcript", segments, translations))),
    {
      text: "First English sentence.\n第一句中文。\n\nSecond English sentence.\n第二句中文。",
      missingCount: 0,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildTranscriptTextForMode("zh", "Original raw transcript", segments, new Map([["first", "第一句中文。"]])))),
    { text: "", missingCount: 1 },
  );
});

test("Transcript export preparation waits for offscreen translations and rejects incomplete text", async () => {
  const helpers = loadSidepanelHelpers();
  const transcript = [
    { start: 0, text: "First complete English sentence for transcript export is deliberately long enough to form its own segment." },
    { start: 5, text: "Second complete English sentence for transcript export is also long enough to form its own segment." },
  ];
  const segments = helpers.groupTranscriptEntries(transcript);
  assert.equal(segments.length, 2);
  const translationCache = new Map();
  let finishTranslation;
  helpers.setTranscriptExportTestState({
    videoId: "video-1",
    transcript,
    originalText: "First complete English sentence for transcript export. Second complete English sentence for transcript export.",
    mode: "zh",
    translationCache,
    queue: {
      videoId: "video-1",
      mode: "zh",
      completeMissing: () => new Promise((resolve) => {
        finishTranslation = () => {
          translationCache.set(`video-1:zh:semantic:${segments[0].id}`, "第一句中文。");
          translationCache.set(`video-1:zh:semantic:${segments[1].id}`, "第二句中文。");
          resolve();
        };
      }),
    },
  });

  const preparedPromise = helpers.prepareSelectedTranscriptText("exportTranscriptBtn");
  assert.equal(typeof finishTranslation, "function");
  finishTranslation();
  const prepared = await preparedPromise;
  assert.equal(prepared.mode, "zh");
  assert.equal(prepared.text, "第一句中文。\n\n第二句中文。");

  translationCache.delete(`video-1:zh:semantic:${segments[1].id}`);
  helpers.setTranscriptExportTestState({
    videoId: "video-1",
    transcript,
    originalText: "Original raw transcript",
    mode: "bilingual",
    translationCache,
    queue: { videoId: "video-1", mode: "bilingual", completeMissing: async () => {} },
  });
  assert.equal(await helpers.prepareSelectedTranscriptText("exportTranscriptBtn"), null);
});

test("Transcript Export downloads the selected language and never downloads partial translation", async () => {
  const captureDownload = {};
  const helpers = loadSidepanelHelpers({ captureDownload });
  const transcript = [
    { start: 0, text: "First complete English sentence for transcript export is deliberately long enough to form its own segment." },
    { start: 5, text: "Second complete English sentence for transcript export is also long enough to form its own segment." },
  ];
  const segments = helpers.groupTranscriptEntries(transcript);
  const translationCache = new Map([
    [`video-1:zh:semantic:${segments[0].id}`, "第一句中文。"],
    [`video-1:zh:semantic:${segments[1].id}`, "第二句中文。"],
  ]);
  const setMode = (mode) => helpers.setTranscriptExportTestState({
    videoId: "video-1",
    transcript,
    originalText: "Original raw transcript",
    mode,
    videoTitle: "Demo Video",
    description: "Original description",
    translationCache,
    queue: { videoId: "video-1", mode, completeMissing: async () => {} },
  });

  setMode("zh");
  await helpers.exportTranscript();
  let file = await captureDownload.blob.text();
  assert.equal(captureDownload.filename, "demo-video-transcript-zh.txt");
  assert.match(file, /Language: 简体中文/);
  assert.match(file, /TRANSCRIPT:\n\n第一句中文。\n\n第二句中文。\n/);
  assert.doesNotMatch(file, /First complete English sentence|Original description/);

  setMode("bilingual");
  await helpers.exportTranscript();
  file = await captureDownload.blob.text();
  assert.equal(captureDownload.filename, "demo-video-transcript-bilingual.txt");
  assert.match(file, /First complete English sentence[^\n]*\n第一句中文。/);
  assert.match(file, /Second complete English sentence[^\n]*\n第二句中文。/);

  setMode("original");
  await helpers.exportTranscript();
  file = await captureDownload.blob.text();
  assert.equal(captureDownload.filename, "demo-video-transcript.txt");
  assert.match(file, /TRANSCRIPT:\n\nOriginal raw transcript\n/);
  assert.match(file, /Original description/);

  translationCache.delete(`video-1:zh:semantic:${segments[1].id}`);
  setMode("zh");
  captureDownload.blob = null;
  await helpers.exportTranscript();
  assert.equal(captureDownload.blob, null);
});

test("Explain exposes English, Chinese, and bilingual display helpers", () => {
  const html = read("sidepanel.js");
  const prompt = read("prompts/explain.md");
  const translationPrompt = read("prompts/translation.md");
  const {
    renderExplanationContent,
    buildExplainContextFromSelection,
  } = loadSidepanelHelpers();

  assert.match(html, /data-explain-mode="english"[\s\S]*?>English</);
  assert.match(html, /data-explain-mode="zh"[\s\S]*?>中文</);
  assert.match(html, /data-explain-mode="bilingual"[\s\S]*?>双语</);
  assert.match(html, /contentType: "explainBatch"/);
  assert.match(prompt, /Respond in concise English only\./);
  assert.match(translationPrompt, /^## Explanation translation$/m);

  const english = renderExplanationContent(
    "english",
    "Explain <b>this</b> briefly.",
    "用中文解释",
    "",
  );
  const chinese = renderExplanationContent(
    "zh",
    "Explain <b>this</b> briefly.",
    "用中文解释",
    "",
  );
  const bilingual = renderExplanationContent(
    "bilingual",
    "Explain <b>this</b> briefly.",
    "用中文解释",
    "",
  );
  const failedChinese = renderExplanationContent(
    "zh",
    "English fallback",
    "",
    "Translation failed.",
  );

  assert.match(english, /Explain &lt;b&gt;this&lt;\/b&gt; briefly\./);
  assert.doesNotMatch(english, /用中文解释/);
  assert.match(chinese, /用中文解释/);
  assert.doesNotMatch(chinese, /Explain &lt;b&gt;this&lt;\/b&gt; briefly\./);
  assert.match(bilingual, /explain-source/);
  assert.match(bilingual, /explain-translation/);
  assert.match(bilingual, /Explain &lt;b&gt;this&lt;\/b&gt; briefly\./);
  assert.match(bilingual, /用中文解释/);
  assert.match(failedChinese, /Translation failed\./);
  assert.match(failedChinese, />Retry</);

  const context = buildExplainContextFromSelection(
    "中文片段",
    { dataset: { segmentId: "segment-1-5000", segmentIndex: "1" } },
    [
      { id: "segment-0-0", text: "First source sentence." },
      { id: "segment-1-5000", text: "Second source sentence." },
      { id: "segment-2-9000", text: "Third source sentence." },
    ],
    "First source sentence. Second source sentence. Third source sentence.",
  );
  assert.match(context, /First source sentence\./);
  assert.match(context, /Second source sentence\./);
  assert.match(context, /Third source sentence\./);
  assert.doesNotMatch(context, /中文片段/);

  const fallbackContext = buildExplainContextFromSelection(
    "selected phrase",
    null,
    [],
    "Before selected phrase after.",
  );
  assert.equal(fallbackContext, "Before selected phrase after.");
});

test("Explain translation is lazy, cached, retryable, and ignores late replies", async () => {
  const {
    createExplanationTranslationState,
    ensureExplanationTranslation,
    renderExplanationContent,
  } = loadSidepanelHelpers();

  let resolveTranslation;
  let requestCount = 0;
  const state = createExplanationTranslationState("English explanation.");
  const sendMessage = (message) => {
    requestCount += 1;
    assert.equal(message.action, "translateContent");
    assert.equal(message.contentType, "explainBatch");
    assert.deepEqual(JSON.parse(JSON.stringify(message.content.segments)), [
      { id: "explain-0", text: "English explanation." },
    ]);
    return new Promise((resolve) => {
      resolveTranslation = resolve;
    });
  };

  const first = ensureExplanationTranslation(state, {
    sendMessage,
    videoTitle: "Video",
    isCurrent: () => true,
  });
  const duplicate = ensureExplanationTranslation(state, {
    sendMessage,
    videoTitle: "Video",
    isCurrent: () => true,
  });
  assert.strictEqual(duplicate, first);
  assert.equal(requestCount, 1);

  resolveTranslation({
    success: true,
    translatedContent: {
      segments: [{ id: "explain-0", text: "中文解释。" }],
    },
  });
  await first;
  assert.equal(state.chinese, "中文解释。");
  await ensureExplanationTranslation(state, {
    sendMessage,
    videoTitle: "Video",
    isCurrent: () => true,
  });
  assert.equal(requestCount, 1, "cached Chinese must not make another request");

  let attempt = 0;
  const retryState = createExplanationTranslationState("Keep this English.");
  const retrySend = async () => {
    attempt += 1;
    return attempt === 1
      ? { success: false, error: "Temporary failure." }
      : {
          success: true,
          translatedContent: {
            segments: [{ id: "explain-0", text: "重试成功。" }],
          },
        };
  };
  await ensureExplanationTranslation(retryState, {
    sendMessage: retrySend,
    isCurrent: () => true,
  });
  assert.equal(retryState.english, "Keep this English.");
  assert.equal(retryState.translationError, "Temporary failure.");
  const failed = renderExplanationContent(
    "zh",
    retryState.english,
    retryState.chinese,
    retryState.translationError,
  );
  assert.match(failed, /Keep this English\./);
  assert.match(failed, />Retry</);
  await ensureExplanationTranslation(retryState, {
    sendMessage: retrySend,
    isCurrent: () => true,
  });
  assert.equal(attempt, 1, "language switching alone must not retry a failure");
  await ensureExplanationTranslation(retryState, {
    sendMessage: retrySend,
    isCurrent: () => true,
    retry: true,
  });
  assert.equal(attempt, 2);
  assert.equal(retryState.chinese, "重试成功。");

  let active = true;
  let resolveLate;
  const lateState = createExplanationTranslationState("Do not replace me.");
  const late = ensureExplanationTranslation(lateState, {
    sendMessage: () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
    isCurrent: () => active,
  });
  active = false;
  resolveLate({
    success: true,
    translatedContent: {
      segments: [{ id: "explain-0", text: "迟到翻译。" }],
    },
  });
  await late;
  assert.equal(lateState.chinese, "", "detached or replaced modal ignores late data");
});

test("Explain translation stays bound to the video that opened the modal", async () => {
  const {
    createExplanationTranslationState,
    ensureExplanationTranslation,
  } = loadSidepanelHelpers();
  let activeVideoId = "video-a";
  let resolveTranslation;
  let requestTitle = "";
  const state = createExplanationTranslationState(
    "English explanation.",
    "video-a",
    "Video A title",
  );

  const pending = ensureExplanationTranslation(state, {
    sendMessage: (message) => {
      requestTitle = message.videoTitle;
      return new Promise((resolve) => {
        resolveTranslation = resolve;
      });
    },
    isCurrent: () => activeVideoId === state.videoId,
  });
  assert.equal(requestTitle, "Video A title");

  activeVideoId = "video-b";
  resolveTranslation({
    success: true,
    translatedContent: {
      segments: [{ id: "explain-0", text: "旧视频翻译。" }],
    },
  });
  await pending;
  assert.equal(state.chinese, "", "a new active video invalidates the old modal");
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background accepts explanation batches and rejects unknown translation types", async () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );

  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (String(url).startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"segments":[{"id":"explain-0","text":"简短中文解释。"}]}',
              },
            },
          ],
        }),
      };
    },
  });
  const accepted = await helpers.handleTranslateContent(
    {
      segments: [{ id: "explain-0", text: "Explain this in Chinese." }],
    },
    "explainBatch",
    "zh",
    "Video",
  );
  assert.equal(accepted.success, true);
  assert.equal(accepted.translatedContent.segments[0].text, "简短中文解释。");

  const rejected = await helpers.handleTranslateContent(
    { segments: [{ id: "unknown-0", text: "Text" }] },
    "unknownBatch",
    "zh",
    "Video",
  );
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /Unsupported translation content type/);
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    7,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "handleSuggestVideoQuestions",
    "handleAskVideo",
    "saveVocabularyMutation",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});
