const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(value),
    json: async () => value,
  };
}

function loadVocabularyHelpers({
  initialVocabulary = [],
  aiContent = JSON.stringify({
    meaningZh: "示例含义",
    explanationZh: "结合视频语境的简短解释。",
    phonetic: "/ˈsæmpəl/",
  }),
  failAi = false,
  aiGate = null,
} = {}) {
  const storage = {
    ytd_settings: {
      provider: "deepseek",
      aiApiKey: "test-ai-key",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    },
    ytd_vocabulary: structuredClone(initialVocabulary),
  };
  const calls = { ai: 0, prompt: 0, sets: [], listener: null };
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout: () => 0,
    clearTimeout() {},
    importScripts() {},
    fetch: async (url, options = {}) => {
      if (String(url).includes("prompts/vocabulary.md")) {
        calls.prompt += 1;
        return {
          ok: true,
          status: 200,
          text: async () => read("prompts/vocabulary.md"),
        };
      }
      calls.ai += 1;
      if (failAi) throw new Error("Provider unavailable");
      if (aiGate) {
        aiGate.started();
        await aiGate.promise;
      }
      assert.equal(options.method, "POST");
      return jsonResponse({
        choices: [{ message: { content: aiContent } }],
      });
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return structuredClone(storage);
            if (typeof key === "string") {
              return { [key]: structuredClone(storage[key]) };
            }
            return {};
          },
          set: async (value) => {
            calls.sets.push(structuredClone(value));
            Object.assign(storage, structuredClone(value));
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            calls.listener = listener;
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve(),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: () => "https://api.deepseek.com/chat/completions",
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return {
    helpers: sandbox.__YTD_VOCABULARY_TESTING__,
    calls,
    storage,
  };
}

function loadVocabularyUiHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
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
      createElement: () => {
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
      runtime: {
        onMessage: listeners,
        sendMessage: async () => ({ success: true }),
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_VOCABULARY_UI_TESTING__;
}

function deferredGate() {
  let release;
  let markStarted;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise((resolve) => {
    markStarted = resolve;
  });
  return {
    promise,
    release,
    started: markStarted,
    waitUntilStarted: () => startedPromise,
  };
}

function validSave(overrides = {}) {
  return {
    term: "  Compound   interest  ",
    sourceExcerpt: "Compound interest rewards consistency.",
    context: "The speaker explains why compound interest matters over time.",
    videoId: "AbC_dEf-123",
    videoTitle: "Finance basics",
    channelName: "Example Channel",
    timestamp: 65.9,
    ...overrides,
  };
}

function storedEntry(overrides = {}) {
  return {
    id: "vocab_1000_abc123",
    term: "Compound interest",
    normalizedTerm: "compound interest",
    sourceLanguage: "en",
    meaningZh: "复利",
    explanationZh: "利息继续产生利息。",
    sourceExcerpt: "Compound interest rewards consistency.",
    context: "The speaker explains compound interest.",
    videoId: "AbC_dEf-123",
    videoTitle: "Finance basics",
    channelName: "Example Channel",
    timestamp: "1:05",
    timestampSeconds: 65,
    timestampedUrl:
      "https://www.youtube.com/watch?v=AbC_dEf-123&t=65s",
    createdAt: 1000,
    ...overrides,
  };
}

test("normalizeVocabularyTerm uses NFKC, collapses whitespace, and rejects invalid size", () => {
  const { helpers } = loadVocabularyHelpers();
  const latin = helpers.normalizeVocabularyTerm("  Ｈｅｌｌｏ\n  WORLD  ");
  assert.equal(latin.term, "Hello WORLD");
  assert.equal(latin.normalizedTerm, "hello world");
  assert.equal(latin.sourceLanguage, "en");

  const cjk = helpers.normalizeVocabularyTerm("  模型\u3000伦理  ");
  assert.equal(cjk.term, "模型 伦理");
  assert.equal(cjk.normalizedTerm, "模型 伦理");
  assert.equal(cjk.sourceLanguage, "zh");

  assert.equal(helpers.normalizeVocabularyTerm("日本語の言葉").sourceLanguage, "ja");
  assert.equal(helpers.normalizeVocabularyTerm("한국어").sourceLanguage, "ko");
  assert.equal(helpers.normalizeVocabularyTerm("Привет").sourceLanguage, "other");
  assert.equal(
    helpers.normalizeVocabularyTerm("hello Привет").sourceLanguage,
    "other",
  );

  assert.throws(() => helpers.normalizeVocabularyTerm(" \n "), /required/i);
  assert.equal(helpers.normalizeVocabularyTerm("x".repeat(1000)).term.length, 1000);
  assert.throws(
    () => helpers.normalizeVocabularyTerm("x".repeat(1001)),
    /1,000/,
  );
});

test("validateVocabularyEnrichment rebuilds a bounded plain-text schema", () => {
  const { helpers } = loadVocabularyHelpers();
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        helpers.validateVocabularyEnrichment({
          meaningZh: "  复利  ",
          explanationZh: "  利息继续产生利息。  ",
          phonetic: "  /\u02c8kɒmpaʊnd \u02c8ɪntrəst/  ",
          injected: "must not persist",
        }),
      ),
    ),
    {
      meaningZh: "复利",
      explanationZh: "利息继续产生利息。",
      phonetic: "/ˈkɒmpaʊnd ˈɪntrəst/",
    },
  );

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        helpers.validateVocabularyEnrichment({
          meaningZh: "复利",
          explanationZh: "解释",
        }),
      ),
    ),
    { meaningZh: "复利", explanationZh: "解释", phonetic: "" },
  );

  assert.throws(
    () => helpers.validateVocabularyEnrichment({ meaningZh: "", explanationZh: "解释" }),
    /meaning/i,
  );
  assert.throws(
    () =>
      helpers.validateVocabularyEnrichment({
        meaningZh: "<img src=x onerror=alert(1)>",
        explanationZh: "解释",
      }),
    /HTML/i,
  );
  assert.throws(
    () =>
      helpers.validateVocabularyEnrichment({
        meaningZh: "含义",
        explanationZh: "x".repeat(2001),
      }),
    /2,000/,
  );
  assert.throws(
    () =>
      helpers.validateVocabularyEnrichment({
        meaningZh: "含义",
        explanationZh: "解释",
        phonetic: "<script>",
      }),
    /plain text|phonetic/i,
  );
  assert.throws(
    () =>
      helpers.validateVocabularyEnrichment({
        meaningZh: "含义",
        explanationZh: "解释",
        phonetic: "x".repeat(161),
      }),
    /160/,
  );
  assert.equal(
    helpers.validateVocabularyEnrichment(
      {
        meaningZh: "长句",
        explanationZh: "解释",
        phonetic: "/must-not-survive/",
      },
      "x".repeat(81),
    ).phonetic,
    "",
  );
  assert.equal(
    helpers.validateVocabularyEnrichment(
      { meaningZh: "复利", explanationZh: "解释", phonetic: "/ˈɪntrəst/" },
      "interest",
    ).phonetic,
    "/ˈɪntrəst/",
  );
  assert.equal(
    helpers.validateVocabularyEnrichment(
      { meaningZh: "复利", explanationZh: "解释", phonetic: "fù lì" },
      "复利",
    ).phonetic,
    "fù lì",
  );
  for (const unsupportedTerm of ["こんにちは", "한국어", "Привет", "مرحبا"]) {
    assert.equal(
      helpers.validateVocabularyEnrichment(
        {
          meaningZh: "含义",
          explanationZh: "解释",
          phonetic: "must be cleared",
        },
        unsupportedTerm,
      ).phonetic,
      "",
    );
  }
  assert.throws(
    () => helpers.validateVocabularyEnrichment("{"),
    /JSON/i,
  );
  assert.throws(
    () => helpers.validateVocabularyEnrichment("x".repeat(10_001)),
    /too large/i,
  );
});

test("buildVocabularyEntry bounds metadata and creates one canonical timestamp URL", () => {
  const { helpers } = loadVocabularyHelpers();
  const entry = helpers.buildVocabularyEntry(
    validSave({
      videoTitle: `  ${"V".repeat(600)}  `,
      channelName: " C ",
      sourceExcerpt: ` ${"S".repeat(3500)} `,
      context: ` ${"X".repeat(13_000)} `,
    }),
    {
      meaningZh: "复利",
      explanationZh: "语境解释",
      phonetic: " /\u02c8kɒmpaʊnd \u02c8ɪntrəst/ ",
    },
    1234,
    "fixed-id",
  );

  assert.equal(entry.id, "fixed-id");
  assert.equal(entry.createdAt, 1234);
  assert.equal(entry.term, "Compound interest");
  assert.equal(entry.normalizedTerm, "compound interest");
  assert.equal(entry.sourceLanguage, "en");
  assert.equal(entry.phonetic, "/ˈkɒmpaʊnd ˈɪntrəst/");
  assert.equal(entry.videoTitle.length, 500);
  assert.equal(entry.channelName, "C");
  assert.equal(entry.sourceExcerpt.length, 3000);
  assert.equal(entry.context.length, 12000);
  assert.equal(entry.timestampSeconds, 65);
  assert.equal(entry.timestamp, "1:05");
  assert.equal(
    entry.timestampedUrl,
    "https://www.youtube.com/watch?v=AbC_dEf-123&t=65s",
  );
  assert.throws(
    () =>
      helpers.buildVocabularyEntry(
        validSave({ videoId: "bad&id=attacker" }),
        { meaningZh: "含义", explanationZh: "解释" },
      ),
    /video ID/i,
  );

  const unsupportedEntry = helpers.buildVocabularyEntry(
    validSave({ term: "日本語の単語" }),
    { meaningZh: "日语", explanationZh: "解释", phonetic: "nihongo" },
    1235,
    "unsupported-script",
  );
  assert.equal(unsupportedEntry.sourceLanguage, "ja");
  assert.equal(unsupportedEntry.phonetic, "");
});

test("saveVocabulary checks duplicates before prompt or provider work", async () => {
  const existing = storedEntry();
  const { helpers, calls, storage } = loadVocabularyHelpers({
    initialVocabulary: [existing],
  });

  const response = await helpers.saveVocabulary(
    validSave({ term: "ＣＯＭＰＯＵＮＤ   INTEREST" }),
  );
  assert.equal(response.success, true);
  assert.equal(response.alreadySaved, true);
  assert.equal(response.entry.id, existing.id);
  assert.equal(calls.ai, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(calls.sets.length, 0);
  assert.equal(storage.ytd_vocabulary.length, 1);
});

test("saveVocabulary rejects capacity before AI and never evicts entries", async () => {
  const entries = Array.from({ length: 500 }, (_, index) =>
    storedEntry({
      id: `vocab_${index}_id`,
      term: `term-${index}`,
      normalizedTerm: `term-${index}`,
      createdAt: index,
    }),
  );
  const { helpers, calls, storage } = loadVocabularyHelpers({
    initialVocabulary: entries,
  });

  const response = await helpers.saveVocabulary(validSave({ term: "new term" }));
  assert.equal(response.success, false);
  assert.equal(response.error, "VOCABULARY_CAPACITY");
  assert.match(response.message, /500/);
  assert.equal(calls.ai, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(calls.sets.length, 0);
  assert.equal(storage.ytd_vocabulary.length, 500);
});

test("successful saves preserve unknown stored rows and raw rows count toward capacity", async () => {
  const legacyRow = { id: "legacy-row", customLegacyField: "preserve me" };
  const { helpers, storage } = loadVocabularyHelpers({
    initialVocabulary: [storedEntry(), legacyRow],
  });

  const saved = await helpers.saveVocabulary(validSave({ term: "new term" }));
  assert.equal(saved.success, true);
  assert.deepEqual(
    storage.ytd_vocabulary.find((entry) => entry.id === "legacy-row"),
    legacyRow,
  );

  const capacityRows = Array.from({ length: 499 }, (_, index) =>
    storedEntry({
      id: `vocab_${index}_capacity`,
      term: `capacity-${index}`,
      normalizedTerm: `capacity-${index}`,
      createdAt: index,
    }),
  );
  capacityRows.push({ id: "unknown-capacity-row", oldSchema: true });
  const capacity = loadVocabularyHelpers({ initialVocabulary: capacityRows });
  const rejected = await capacity.helpers.saveVocabulary(
    validSave({ term: "would exceed raw capacity" }),
  );
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "VOCABULARY_CAPACITY");
  assert.equal(capacity.calls.ai, 0);
  assert.equal(capacity.calls.sets.length, 0);
  assert.equal(capacity.storage.ytd_vocabulary.length, 500);
});

test("save and delete share one mutation queue so an in-flight save cannot resurrect a deletion", async () => {
  const aiGate = deferredGate();
  const target = storedEntry({ id: "delete-me" });
  const keep = storedEntry({
    id: "keep-me",
    term: "another term",
    normalizedTerm: "another term",
  });
  const { helpers, storage } = loadVocabularyHelpers({
    initialVocabulary: [target, keep],
    aiGate,
  });

  const saving = helpers.saveVocabulary(validSave({ term: "new queued term" }));
  await aiGate.waitUntilStarted();
  let deleteResolved = false;
  const deleting = helpers.deleteVocabulary("delete-me").then((result) => {
    deleteResolved = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    deleteResolved,
    false,
    "delete must wait behind the in-flight save mutation",
  );

  aiGate.release();
  const [saveResult, deleteResult] = await Promise.all([saving, deleting]);
  assert.equal(saveResult.success, true);
  assert.equal(deleteResult.deleted, true);
  assert.equal(
    storage.ytd_vocabulary.some((entry) => entry.id === "delete-me"),
    false,
  );
  assert.equal(
    storage.ytd_vocabulary.some((entry) => entry.term === "new queued term"),
    true,
  );
});

test("saveVocabulary uses its JSON prompt and persists only a validated result", async () => {
  const { helpers, calls, storage } = loadVocabularyHelpers();
  const response = await helpers.saveVocabulary(validSave());

  assert.equal(response.success, true);
  assert.equal(response.alreadySaved, false);
  assert.equal(calls.prompt, 1);
  assert.equal(calls.ai, 1);
  assert.equal(calls.sets.length, 1);
  assert.equal(storage.ytd_vocabulary.length, 1);
  assert.equal(storage.ytd_vocabulary[0].meaningZh, "示例含义");
  assert.equal(storage.ytd_vocabulary[0].phonetic, "/ˈsæmpəl/");

  const { helpers: failing, calls: failureCalls, storage: failedStorage } =
    loadVocabularyHelpers({ aiContent: "not json" });
  const failed = await failing.saveVocabulary(validSave({ term: "different" }));
  assert.equal(failed.success, false);
  assert.equal(failed.error, "VOCABULARY_INVALID_RESPONSE");
  assert.match(failed.message, /JSON|Unexpected token/i);
  assert.equal(failureCalls.ai, 1);
  assert.equal(failureCalls.sets.length, 0);
  assert.deepEqual(failedStorage.ytd_vocabulary, []);
});

test("getVocabulary filters valid records and sorts newest first", async () => {
  const entries = [
    storedEntry({ id: "old", createdAt: 100, videoId: "video-a", timestampedUrl: "https://www.youtube.com/watch?v=video-a&t=65s" }),
    storedEntry({ id: "new", createdAt: 300, videoId: "video-a", timestampedUrl: "https://www.youtube.com/watch?v=video-a&t=65s" }),
    storedEntry({ id: "other", createdAt: 200, videoId: "video-b", timestampedUrl: "https://www.youtube.com/watch?v=video-b&t=65s" }),
    { id: "malicious", term: "<script>bad</script>" },
  ];
  const { helpers } = loadVocabularyHelpers({ initialVocabulary: entries });

  const all = await helpers.getVocabulary();
  assert.deepEqual(Array.from(all.vocabulary, (entry) => entry.id), ["new", "other", "old"]);
  const filtered = await helpers.getVocabulary("video-a");
  assert.deepEqual(Array.from(filtered.vocabulary, (entry) => entry.id), ["new", "old"]);
  assert.equal(filtered.vocabulary[0].phonetic, "");
});

test("stored Vocabulary preserves valid phonetics and upgrades legacy rows to an empty string", async () => {
  const { helpers } = loadVocabularyHelpers({
    initialVocabulary: [
      storedEntry({ id: "phonetic", phonetic: "  /\u02c8vəʊkæbjʊləri/  " }),
      storedEntry({ id: "legacy", createdAt: 999 }),
      storedEntry({
        id: "legacy-other",
        term: "Привет",
        normalizedTerm: "привет",
        sourceLanguage: "und",
        phonetic: "privet",
        createdAt: 998,
      }),
    ],
  });

  const result = await helpers.getVocabulary();
  const byId = Object.fromEntries(result.vocabulary.map((entry) => [entry.id, entry]));
  assert.equal(byId.phonetic.phonetic, "/ˈvəʊkæbjʊləri/");
  assert.equal(byId.legacy.phonetic, "");
  assert.equal(byId["legacy-other"].sourceLanguage, "other");
  assert.equal(byId["legacy-other"].phonetic, "");
});

test("Vocabulary prompt requires one optional IPA or pinyin field without a second call", () => {
  const prompt = read("prompts/vocabulary.md");

  assert.match(
    prompt,
    /\{"meaningZh":"\.\.\.","explanationZh":"\.\.\.","phonetic":"\.\.\."\}/,
  );
  assert.match(prompt, /IPA[\s\S]*short Latin(?:-script)? word or phrase/i);
  assert.match(prompt, /pinyin[\s\S]*short Chinese/i);
  assert.match(prompt, /phonetic[\s\S]*empty string[\s\S]*long(?:er)? (?:selection|sentence)/i);
  assert.match(
    prompt,
    /phonetic[\s\S]*empty string[\s\S]*Japanese[\s\S]*Korean[\s\S]*other/i,
  );
});

test("deleteVocabulary removes only the exact requested ID", async () => {
  const { helpers, storage } = loadVocabularyHelpers({
    initialVocabulary: [storedEntry({ id: "vocab-1" }), storedEntry({ id: "vocab-10" })],
  });
  const result = await helpers.deleteVocabulary("vocab-1");
  assert.equal(result.success, true);
  assert.equal(result.deleted, true);
  assert.deepEqual(Array.from(storage.ytd_vocabulary, (entry) => entry.id), ["vocab-10"]);
  const noMatch = await helpers.deleteVocabulary("vocab");
  assert.equal(noMatch.deleted, false);
  assert.deepEqual(Array.from(storage.ytd_vocabulary, (entry) => entry.id), ["vocab-10"]);
});

test("runtime message actions expose save, get, and exact delete", async () => {
  const { calls } = loadVocabularyHelpers();

  const invoke = (message) =>
    new Promise((resolve) => {
      const keepOpen = calls.listener(message, {}, resolve);
      assert.equal(keepOpen, true);
    });

  const saved = await invoke({ action: "saveVocabulary", ...validSave() });
  assert.equal(saved.success, true);
  const listed = await invoke({ action: "getVocabulary", videoId: "AbC_dEf-123" });
  assert.equal(listed.vocabulary.length, 1);
  const deleted = await invoke({
    action: "deleteVocabulary",
    vocabularyId: saved.entry.id,
  });
  assert.equal(deleted.deleted, true);
});

test("Library exposes Notes and Vocabulary with independent accessible filters", () => {
  const html = read("sidepanel.html");

  assert.match(html, /data-tab="library"[^>]*>Library<\/button>/);
  assert.match(html, /data-panel="library"/);
  assert.match(
    html,
    /id="libraryNotesTab"[^>]*aria-pressed="true"[^>]*>Notes<\/button>/,
  );
  assert.match(
    html,
    /id="libraryVocabularyTab"[^>]*aria-pressed="false"[^>]*>Vocabulary<\/button>/,
  );
  assert.match(html, /id="notesFilterThis"[\s\S]*?>[\s\S]*?This Video/);
  assert.match(html, /id="notesFilterAll"[\s\S]*?>[\s\S]*?All Notes/);
  assert.match(
    html,
    /id="vocabularyFilterThis"[^>]*aria-pressed="true"[\s\S]*?>[\s\S]*?This Video/,
  );
  assert.match(
    html,
    /id="vocabularyFilterAll"[^>]*aria-pressed="false"[\s\S]*?>[\s\S]*?All Vocabulary/,
  );
  assert.match(html, /id="vocabularyList"/);
  assert.match(html, /id="vocabularyIntro"/);
});

test("vocabulary selection builds the exact backend save contract", () => {
  const helpers = loadVocabularyUiHelpers();
  const metadata = helpers.buildVocabularySelectionMetadata(
    "displayed translation",
    { dataset: { segmentId: "segment-b", segmentIndex: "1", seconds: "65.9" } },
    [
      { id: "segment-a", start: 50, text: "Previous source sentence." },
      { id: "segment-b", start: 65.9, text: "Original source excerpt." },
      { id: "segment-c", start: 80, text: "Following source sentence." },
    ],
    "fallback transcript",
    {
      videoId: "AbC_dEf-123",
      videoTitle: "Video title",
      channelName: "Channel",
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), {
    term: "displayed translation",
    sourceExcerpt: "Original source excerpt.",
    context:
      "Previous source sentence. Original source excerpt. Following source sentence.",
    videoId: "AbC_dEf-123",
    videoTitle: "Video title",
    channelName: "Channel",
    timestamp: 65.9,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.buildVocabularySaveMessage(metadata))),
    { action: "saveVocabulary", ...metadata },
  );
});

test("planVocabularyMatches is literal, normalized, bounded, longest-first, and non-overlapping", () => {
  const { planVocabularyMatches } = loadVocabularyUiHelpers();
  const text =
    "ART artificial intelligence, C++ and [a-z]+. 模型\u3000伦理; cart.";
  const entries = [
    { id: "short", term: "art", normalizedTerm: "art" },
    {
      id: "long",
      term: "artificial intelligence",
      normalizedTerm: "artificial intelligence",
    },
    { id: "cpp", term: "C++", normalizedTerm: "c++" },
    { id: "regex", term: "[a-z]+", normalizedTerm: "[a-z]+" },
    { id: "cjk", term: "模型 伦理", normalizedTerm: "模型 伦理" },
  ];

  const matches = JSON.parse(
    JSON.stringify(planVocabularyMatches(text, entries)),
  );
  assert.deepEqual(
    matches.map(({ entryId, text: matchedText }) => [entryId, matchedText]),
    [
      ["short", "ART"],
      ["long", "artificial intelligence"],
      ["cpp", "C++"],
      ["regex", "[a-z]+"],
      ["cjk", "模型\u3000伦理"],
    ],
  );
  assert.equal(matches.some((match) => match.text === "art"), false);
  assert.equal(matches.some((match) => match.text === "cart"), false);

  const boundedEntries = Array.from({ length: 501 }, (_, index) => ({
    id: `entry-${index}`,
    term: index === 500 ? "needle" : `missing-${index}`,
    normalizedTerm: index === 500 ? "needle" : `missing-${index}`,
  }));
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(planVocabularyMatches("needle", boundedEntries)),
    ),
    [],
  );
});

test("Vocabulary rendering, deletion, and highlighting keep untrusted text out of HTML", () => {
  const source = read("sidepanel.js");
  const renderStart = source.indexOf("function renderVocabulary(");
  const renderEnd = source.indexOf("function deleteVocabularyEntry(", renderStart);
  const renderSource = source.slice(renderStart, renderEnd);
  const plannerStart = source.indexOf("function planVocabularyMatches(");
  const plannerEnd = source.indexOf("function clearVocabularyHighlights(", plannerStart);
  const plannerSource = source.slice(plannerStart, plannerEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.doesNotMatch(renderSource, /innerHTML\s*=/);
  assert.match(renderSource, /\.textContent\s*=/);
  assert.match(renderSource, /getSafeHttpUrl\(entry\.timestampedUrl\)/);
  assert.match(source, /action:\s*"deleteVocabulary"[\s\S]*?vocabularyId:\s*entryId/);
  assert.match(source, /action:\s*"getVocabulary"/);
  assert.match(source, /action:\s*"saveVocabulary"/);
  assert.match(source, /vocabularySavePromises/);
  assert.match(source, /Saving…/);
  assert.match(source, /Already saved/);
  assert.match(source, /Saved/);
  assert.match(source, /Could not save/);

  assert.ok(plannerStart >= 0 && plannerEnd > plannerStart);
  assert.doesNotMatch(plannerSource, /new RegExp|RegExp\(/);
  assert.match(plannerSource, /\.indexOf\(/);
  assert.match(source, /createTreeWalker\(/);
  assert.match(source, /NodeFilter\.SHOW_TEXT/);
  assert.match(source, /createDocumentFragment\(/);
  assert.match(source, /mark\.className = "vocabulary-highlight"/);
  assert.match(source, /closest\("\.vocabulary-highlight, \.transcript-time, button, a"\)/);
  assert.doesNotMatch(source, /<mark[^`]*\$\{/);
});

test("Vocabulary transcript highlights use the Speak Replay purple underline", () => {
  const css = read("sidepanel.css");
  const highlightBlock = css.match(/\.vocabulary-highlight\s*\{([^}]*)\}/)?.[1] || "";

  assert.match(css, /--vocabulary-highlight-bg:\s*transparent;/i);
  assert.match(css, /--vocabulary-highlight-ink:\s*#252333;/i);
  assert.match(css, /--vocabulary-highlight-edge:\s*#6447eb;/i);
  assert.match(highlightBlock, /background:\s*var\(--vocabulary-highlight-bg\);/);
  assert.match(highlightBlock, /color:\s*var\(--vocabulary-highlight-ink\);/);
  assert.match(highlightBlock, /box-shadow:\s*inset 0 -2px 0 var\(--vocabulary-highlight-edge\);/);
});

test("Vocabulary cards render phonetics as text and visibly explain unavailable pronunciation", () => {
  const source = read("sidepanel.js");
  const renderStart = source.indexOf("function renderVocabulary(");
  const renderEnd = source.indexOf("function deleteVocabularyEntry(", renderStart);
  const renderSource = source.slice(renderStart, renderEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.doesNotMatch(renderSource, /innerHTML\s*=/);
  assert.match(renderSource, /phoneticText\s*=\s*String\(entry\.phonetic\s*\|\|\s*""\)\.trim\(\)/);
  assert.match(renderSource, /if \(phoneticText\)[\s\S]*?phonetic\.textContent\s*=\s*phoneticText/);
  assert.match(renderSource, /className\s*=\s*"vocabulary-pronunciation"/);
  assert.match(renderSource, /setAttribute\("aria-label"/);
  assert.doesNotMatch(renderSource, /🔊/);
  assert.match(renderSource, /appendChild\(createVocabularySpeakerIcon\(\)\)/);
  assert.match(
    source,
    /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg",\s*"svg"\)/,
  );
  assert.match(source, /setAttribute\("width",\s*"16"\)/);
  assert.match(source, /setAttribute\("height",\s*"16"\)/);
  assert.match(source, /setAttribute\("stroke",\s*"currentColor"\)/);
  assert.match(source, /setAttribute\("fill",\s*"none"\)/);
  assert.match(source, /setAttribute\("aria-hidden",\s*"true"\)/);
  assert.match(renderSource, /className\s*=\s*"vocabulary-pronunciation-unavailable"/);
  assert.match(renderSource, /textContent\s*=\s*"Pronunciation unavailable"/);
  assert.doesNotMatch(renderSource, /pronunciationButton\.disabled\s*=\s*true/);
  assert.match(renderSource, /preventDefault\(\)/);
  assert.match(renderSource, /stopPropagation\(\)/);
  assert.match(renderSource, /pronunciationPlayer\.play\(/);
});

test("speakVocabularyTerm cancels prior speech and selects a local voice language", () => {
  const { speakVocabularyTerm } = loadVocabularyUiHelpers();
  const spoken = [];
  let cancelCount = 0;
  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
    }
  }
  const speechSynthesis = {
    cancel() {
      cancelCount += 1;
    },
    speak(utterance) {
      spoken.push(utterance);
    },
  };

  assert.equal(
    speakVocabularyTerm("compound interest", "en", speechSynthesis, Utterance),
    true,
  );
  assert.equal(cancelCount, 1);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "compound interest");
  assert.equal(spoken[0].lang, "en-US");

  assert.equal(
    speakVocabularyTerm("复利", "und", speechSynthesis, Utterance),
    true,
  );
  assert.equal(cancelCount, 2);
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].lang, "zh-CN");

  assert.equal(
    speakVocabularyTerm("日本語", "ja", speechSynthesis, Utterance),
    true,
  );
  assert.equal(spoken[2].lang, "ja-JP");

  assert.equal(
    speakVocabularyTerm("한국어", "ko", speechSynthesis, Utterance),
    true,
  );
  assert.equal(cancelCount, 4);
  assert.equal(spoken.length, 4);
  assert.equal(spoken[3].lang, "ko-KR");
});

test("selectPreferredSpeechVoice follows local system voice priority with language fallback", () => {
  const { selectPreferredSpeechVoice } = loadVocabularyUiHelpers();
  const defaultLocalExact = {
    name: "System English",
    lang: "en-US",
    default: true,
    localService: true,
  };
  const localExact = {
    name: "Local US",
    lang: "en_US",
    default: false,
    localService: true,
  };
  const localBase = {
    name: "Local UK",
    lang: "en-GB",
    default: false,
    localService: true,
  };
  const defaultRemote = {
    name: "Default remote",
    lang: "en-AU",
    default: true,
    localService: false,
  };
  const anyExact = {
    name: "Any US",
    lang: "en-US",
    default: false,
    localService: false,
  };

  assert.equal(
    selectPreferredSpeechVoice(
      [anyExact, localBase, localExact, defaultLocalExact],
      "en-US",
    ),
    defaultLocalExact,
  );
  assert.equal(
    selectPreferredSpeechVoice([localBase, localExact], "en-US"),
    localExact,
  );
  assert.equal(
    selectPreferredSpeechVoice([defaultRemote, localBase], "en-US"),
    localBase,
  );
  assert.equal(
    selectPreferredSpeechVoice([anyExact, defaultRemote], "en-US"),
    defaultRemote,
  );
  assert.equal(selectPreferredSpeechVoice([anyExact], "en-US"), anyExact);
  assert.equal(selectPreferredSpeechVoice([localBase], "zh-CN"), null);
  assert.equal(selectPreferredSpeechVoice([], "en-US"), null);
});

test("English speech automatically prefers local Samantha and otherwise keeps the existing fallback", () => {
  const { selectPreferredSpeechVoice } = loadVocabularyUiHelpers();
  const defaultEnglish = {
    voiceURI: "default-en",
    name: "System Default",
    lang: "en-US",
    default: true,
    localService: true,
  };
  const samantha = {
    voiceURI: "com.apple.voice.compact.en-US.Samantha",
    name: "sAmAnThA",
    lang: "en_US",
    default: false,
    localService: true,
  };
  const chinese = {
    voiceURI: "zh-local",
    name: "Chinese",
    lang: "zh-CN",
    default: true,
    localService: true,
  };

  assert.equal(
    selectPreferredSpeechVoice([defaultEnglish, samantha], "en-US"),
    samantha,
  );
  assert.equal(
    selectPreferredSpeechVoice([defaultEnglish], "en-US"),
    defaultEnglish,
  );
  assert.equal(
    selectPreferredSpeechVoice([defaultEnglish, samantha, chinese], "zh-CN"),
    chinese,
  );
  const google = { name: "Google US English", lang: "en-US", localService: false };
  const natural = { name: "Microsoft Aria Online (Natural)", lang: "en-US", localService: false };
  assert.equal(selectPreferredSpeechVoice([samantha, google], "en-US"), google);
  assert.equal(selectPreferredSpeechVoice([google, natural], "en-US"), natural);
});

test("speakVocabularyTerm uses the automatically selected local voice without changing rate or pitch", () => {
  const { speakVocabularyTerm } = loadVocabularyUiHelpers();
  const preferredVoice = {
    name: "Local British",
    lang: "en-GB",
    default: false,
    localService: true,
  };
  let spoken;
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const speechSynthesis = {
    getVoices: () => [preferredVoice],
    cancel() {},
    speak(utterance) {
      spoken = utterance;
    },
  };

  assert.equal(
    speakVocabularyTerm("vocabulary", "en", speechSynthesis, Utterance),
    true,
  );
  assert.equal(spoken.voice, preferredVoice);
  assert.equal(spoken.lang, "en-GB");
  assert.equal(Object.hasOwn(spoken, "rate"), false);
  assert.equal(Object.hasOwn(spoken, "pitch"), false);

  const source = read("sidepanel.js");
  const start = source.indexOf("function speakVocabularyTerm(");
  const end = source.indexOf("function getVocabularySpeechServices(", start);
  const speakSource = source.slice(start, end);
  assert.doesNotMatch(speakSource, /utterance\.(?:rate|pitch)\s*=/);
});

test("speakVocabularyTerm fails closed when local speech is unavailable or broken", () => {
  const { speakVocabularyTerm } = loadVocabularyUiHelpers();
  const speechSynthesis = { cancel() {}, speak() {} };
  class BrokenUtterance {
    constructor() {
      throw new Error("voice unavailable");
    }
  }

  assert.equal(speakVocabularyTerm("term", "en", null, BrokenUtterance), false);
  assert.equal(speakVocabularyTerm("term", "en", speechSynthesis, null), false);
  assert.equal(speakVocabularyTerm("", "en", speechSynthesis, BrokenUtterance), false);
  assert.doesNotThrow(() =>
    speakVocabularyTerm("term", "en", speechSynthesis, BrokenUtterance),
  );
  assert.equal(
    speakVocabularyTerm("term", "en", speechSynthesis, BrokenUtterance),
    false,
  );

  let cancelCount = 0;
  let speakCount = 0;
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const guardedSpeech = {
    cancel() {
      cancelCount += 1;
    },
    speak() {
      speakCount += 1;
    },
  };
  assert.equal(
    speakVocabularyTerm("Привет", "other", guardedSpeech, Utterance),
    false,
  );
  assert.equal(
    speakVocabularyTerm("Привет", "en", guardedSpeech, Utterance),
    false,
  );
  assert.equal(cancelCount, 0);
  assert.equal(speakCount, 0);
});

test("Youdao audio URL accepts bounded English terms and encodes phrases", () => {
  const { dictionaryAudioUrl } = loadVocabularyUiHelpers();
  assert.equal(
    dictionaryAudioUrl("  such   a mess ", "en"),
    "https://dict.youdao.com/dictvoice?audio=such%20a%20mess&type=2",
  );
  assert.equal(dictionaryAudioUrl("I’m ready", "en"),
    "https://dict.youdao.com/dictvoice?audio=I'm%20ready&type=2");
  for (const term of ["https://example.com", "<script>", "中文", "", "a".repeat(241)]) {
    assert.equal(dictionaryAudioUrl(term, "en"), null);
  }
  assert.equal(dictionaryAudioUrl("hello", "zh"), null);
});

test("dictionary pronunciation plays on click, cancels old audio, and falls back once", async () => {
  const { createVocabularyPronunciationPlayer } = loadVocabularyUiHelpers();
  const audios = [];
  const spoken = [];
  const timers = new Map();
  let nextTimer = 0;
  let canceled = 0;
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const speech = {
    cancel() { canceled += 1; },
    speak(utterance) { spoken.push(utterance); },
    getVoices: () => [],
  };
  const player = createVocabularyPronunciationPlayer(
    (url) => {
      const audio = {
        url,
        play() { return Promise.resolve(); },
        pause() { this.paused = true; },
        removeAttribute() {},
        load() {},
      };
      audios.push(audio);
      return audio;
    },
    speech,
    Utterance,
    (callback, ms) => {
      assert.equal(ms, 5000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    (id) => timers.delete(id),
  );
  const first = [];
  const second = [];
  let pausedVideo = 0;
  player.play("groceries", "en", "first", (state) => first.push(state), () => { pausedVideo += 1; });
  assert.equal(pausedVideo, 1);
  assert.equal(audios[0].url, "https://dict.youdao.com/dictvoice?audio=groceries&type=2");
  assert.equal(audios[0].preload, "none");
  assert.equal(audios[0].playbackRate, 1);
  assert.equal(spoken.length, 0);
  const staleEnd = audios[0].onended;

  player.play("such a mess", "en", "second", (state) => second.push(state));
  assert.equal(audios[0].paused, true);
  assert.deepEqual(first, ["playing", "idle"]);
  staleEnd();
  player.stop("first");
  assert.deepEqual(second, ["playing"]);

  const failed = audios[1].onerror;
  failed();
  failed();
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "such a mess");
  assert.equal(spoken[0].lang, "en-US");
  assert.equal(timers.size, 0);
  assert.equal(canceled, 1);
  player.stop("second");
  assert.ok(canceled > 1);
  assert.equal(second.at(-1), "idle");
  await Promise.resolve();
});

test("non-English pronunciation skips Youdao and unavailable audio reports failure", async () => {
  const { createVocabularyPronunciationPlayer } = loadVocabularyUiHelpers();
  const spoken = [];
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const speech = {
    cancel() {},
    speak(utterance) { spoken.push(utterance); },
  };
  let audioRequests = 0;
  const player = createVocabularyPronunciationPlayer(() => { audioRequests += 1; }, speech, Utterance);
  player.play("复利", "zh", "card", () => {});
  assert.equal(audioRequests, 0);
  assert.equal(spoken[0].lang, "zh-CN");

  const states = [];
  const failingPlayer = createVocabularyPronunciationPlayer(
    () => ({
      play: () => Promise.reject(new Error("audio unavailable")),
      pause() {},
      removeAttribute() {},
      load() {},
    }),
    null,
    null,
  );
  failingPlayer.play("hello", "en", "card", (state) => states.push(state));
  await new Promise(setImmediate);
  assert.deepEqual(states, ["playing", "error"]);
});

test("dictionary audio that never starts falls back after five seconds", () => {
  const { createVocabularyPronunciationPlayer } = loadVocabularyUiHelpers();
  const spoken = [];
  let timeout;
  class Utterance { constructor(text) { this.text = text; } }
  const player = createVocabularyPronunciationPlayer(
    () => ({ play: () => Promise.resolve(), pause() {}, removeAttribute() {}, load() {} }),
    { cancel() {}, speak(utterance) { spoken.push(utterance); } },
    Utterance,
    (callback, ms) => { assert.equal(ms, 5000); timeout = callback; return 1; },
    () => {},
  );
  player.play("hello", "en", "card", () => {});
  assert.equal(spoken.length, 0);
  timeout();
  timeout();
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "hello");
});

test("a rejected vocabulary save cleans its in-flight key without an unhandled finally chain", () => {
  const source = read("sidepanel.js");
  const start = source.indexOf("async function saveVocabularySelection(");
  const end = source.indexOf("async function refreshVocabularyEntries(", start);
  const saveSource = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(saveSource, /request\.finally\(/);
  assert.match(saveSource, /request\.then\(clearRequest, clearRequest\)/);
  assert.match(
    saveSource,
    /try \{\s*request = Promise\.resolve\(chrome\.runtime\.sendMessage\(message\)\);[\s\S]*?\} catch \(error\) \{\s*request = Promise\.reject\(error\);/,
  );
});
