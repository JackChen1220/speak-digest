const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);
const backgroundScript = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createBackgroundPanelHarness({
  close,
  queryResult = [],
  tab = { id: 7, windowId: 3, url: "https://example.com" },
} = {}) {
  const calls = {
    close: [],
    query: [],
    sendMessage: [],
    setOptions: [],
  };
  const listeners = {};
  const event = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    },
  });
  const sidePanel = {
    setPanelBehavior() {},
    async setOptions(options) {
      calls.setOptions.push(options);
    },
    async open() {},
  };
  if (close) {
    sidePanel.close = async (options) => {
      calls.close.push(options);
      return close(options);
    };
  }
  const sandbox = {
    console: { ...console, error() {}, warn() {} },
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async () => ({ ytd_settings: {} }),
        },
      },
      action: { onClicked: event("actionClicked") },
      sidePanel,
      runtime: {
        onInstalled: event("installed"),
        onMessage: event("message"),
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
        sendMessage: async () => {},
      },
      tabs: {
        onUpdated: event("updated"),
        onActivated: event("activated"),
        async get() {
          return tab;
        },
        async query(options) {
          calls.query.push(options);
          return queryResult;
        },
        async sendMessage(tabId, payload) {
          calls.sendMessage.push({ tabId, payload });
          return { ok: true };
        },
      },
      scripting: { executeScript: async () => [] },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value || {},
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
      chatCompletionsUrl: () =>
        "https://api.deepseek.com/chat/completions",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(backgroundScript, sandbox);
  return {
    calls,
    helpers: sandbox.__YTD_BACKGROUND_TESTING__,
    listeners,
  };
}

test("background navigation URL reconciliation covers url, loading, and complete", () => {
  const { helpers } = createBackgroundPanelHarness();
  assert.ok(helpers, "background lifecycle helpers must be exposed");
  assert.equal(
    helpers.getNavigationUrl(
      { url: "https://www.youtube.com/watch?v=one" },
      { pendingUrl: "https://example.com/pending" },
    ),
    "https://www.youtube.com/watch?v=one",
  );
  assert.equal(
    helpers.getNavigationUrl(
      { status: "loading" },
      {
        pendingUrl: "https://example.com/pending",
        url: "https://www.youtube.com/watch?v=old",
      },
    ),
    "https://example.com/pending",
  );
  assert.equal(
    helpers.getNavigationUrl(
      { status: "complete" },
      { url: "https://example.com/complete" },
    ),
    "https://example.com/complete",
  );
  assert.equal(
    helpers.getNavigationUrl({ status: "unloaded" }, { url: "https://example.com" }),
    "",
  );
});

test("non-YouTube panel closes by tab and then disables the tab", async () => {
  const { calls, helpers } = createBackgroundPanelHarness({
    close: async () => {},
  });
  await helpers.updatePanelForTab(7, "https://example.com", 3);
  assert.deepEqual(plain(calls.close), [{ tabId: 7 }]);
  assert.deepEqual(plain(calls.setOptions), [{ tabId: 7, enabled: false }]);
});

test("non-YouTube panel falls back to window close and disables after close failures", async () => {
  const { calls, helpers } = createBackgroundPanelHarness({
    close: async () => {
      throw new Error("panel already moved");
    },
  });
  await helpers.updatePanelForTab(7, "https://example.com", 3);
  assert.deepEqual(plain(calls.close), [{ tabId: 7 }, { windowId: 3 }]);
  assert.deepEqual(plain(calls.setOptions), [{ tabId: 7, enabled: false }]);
});

test("Chrome 116 compatibility disables a non-YouTube tab without sidePanel.close", async () => {
  const { calls, helpers } = createBackgroundPanelHarness();
  await helpers.updatePanelForTab(7, "https://example.com", 3);
  assert.deepEqual(calls.close, []);
  assert.deepEqual(plain(calls.setOptions), [{ tabId: 7, enabled: false }]);
});

test("YouTube panel enables without attempting a close", async () => {
  const { calls, helpers } = createBackgroundPanelHarness({
    close: async () => {},
  });
  await helpers.updatePanelForTab(
    7,
    "https://www.youtube.com/watch?v=video",
    3,
  );
  assert.deepEqual(calls.close, []);
  assert.deepEqual(plain(calls.setOptions), [
    { tabId: 7, path: "sidepanel.html", enabled: true },
  ]);
});

test("stale non-YouTube reconciliation cannot disable a newer YouTube state", async () => {
  const delayedTabClose = deferred();
  const { calls, helpers } = createBackgroundPanelHarness({
    close: async (options) => {
      if (options.tabId === 7) return delayedTabClose.promise;
    },
  });

  const staleNonYouTube = helpers.updatePanelForTab(
    7,
    "https://example.com/old",
    3,
  );
  await Promise.resolve();
  assert.deepEqual(plain(calls.close), [{ tabId: 7 }]);

  // Another tab must reconcile independently while tab 7's close is pending.
  await helpers.updatePanelForTab(
    8,
    "https://www.youtube.com/watch?v=other",
    4,
  );
  await helpers.updatePanelForTab(
    7,
    "https://www.youtube.com/watch?v=current",
    3,
  );
  delayedTabClose.reject(new Error("stale tab close"));
  await staleNonYouTube;

  assert.deepEqual(plain(calls.close), [{ tabId: 7 }]);
  assert.deepEqual(plain(calls.setOptions), [
    { tabId: 8, path: "sidepanel.html", enabled: true },
    { tabId: 7, path: "sidepanel.html", enabled: true },
  ]);
  assert.equal(helpers.getPanelReconciliationCount(), 0);
});

test("tab update and activation listeners reconcile navigation with window context", async () => {
  const { calls, listeners } = createBackgroundPanelHarness({
    close: async ({ tabId }) => {
      if (tabId) throw new Error("use window close");
    },
    tab: { id: 7, windowId: 9, url: "https://example.com/activated" },
  });
  listeners.updated(
    7,
    { url: "https://example.com/url-change" },
    { url: "https://www.youtube.com/watch?v=old", windowId: 3 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  listeners.updated(
    7,
    { status: "loading" },
    {
      pendingUrl: "https://example.com/loading",
      url: "https://www.youtube.com/watch?v=old",
      windowId: 3,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  listeners.updated(
    7,
    { status: "complete" },
    { url: "https://example.com/complete", windowId: 3 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await listeners.activated({ tabId: 7, windowId: 9 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(plain(calls.close), [
    { tabId: 7 },
    { windowId: 3 },
    { tabId: 7 },
    { windowId: 3 },
    { tabId: 7 },
    { windowId: 3 },
    { tabId: 7 },
    { windowId: 9 },
  ]);
  assert.equal(calls.setOptions.length, 4);
  assert.ok(
    calls.setOptions.every(
      (options) => options.tabId === 7 && options.enabled === false,
    ),
  );
});

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
  }

  get firstChild() {
    return this.children[0] || null;
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];

    for (const child of this.children) {
      if (
        selector === "#top-level-buttons-computed" &&
        child.id === selector.slice(1)
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

function createHarness({
  reload = () => {},
  sendMessage = async () => ({ success: true }),
} = {}) {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const observers = [];
  const timers = new Map();
  let nextTimerId = 1;

  const document = {
    readyState: "loading",
    body: new FakeElement(),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console,
    document,
    window: {
      location: { pathname: "/watch", reload },
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
        };
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage,
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  });

  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    windowListeners,
    observers,
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function createActionRow({ width, height }) {
  const row = new FakeElement({
    id: "actions-inner",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  const buttonGroup = new FakeElement({
    id: "top-level-buttons-computed",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  row.appendChild(buttonGroup);
  return { row, buttonGroup };
}

test("Digest button skips a hidden responsive toolbar", () => {
  const harness = createHarness();
  const { row: hiddenRow, buttonGroup: hiddenGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 389,
    height: 36,
  });
  const nativeButton = new FakeElement();
  visibleGroup.appendChild(nativeButton);
  harness.actionRows.push(hiddenRow, visibleRow);

  assert.equal(harness.context.findDigestButtonHost(), visibleGroup);
  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(hiddenGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(visibleGroup.children[1], nativeButton);
  assert.match(visibleGroup.children[0].style.cssText, /flex:\s*0 0 auto/);
  assert.match(visibleGroup.children[0].style.cssText, /width:\s*max-content/);
});

test("invalidated extension context turns Digest into an explicit page refresh", async () => {
  let reloadCount = 0;
  let sendCount = 0;
  const harness = createHarness({
    reload() {
      reloadCount += 1;
    },
    async sendMessage() {
      sendCount += 1;
      throw new Error("Extension context invalidated.");
    },
  });
  const { row, buttonGroup } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  const button = buttonGroup.children[0];
  const event = { preventDefault() {}, stopPropagation() {} };

  await button.listeners.click(event);

  assert.equal(sendCount, 1);
  assert.equal(reloadCount, 0);
  assert.equal(button["aria-label"], "Refresh YouTube to reconnect Speak Digest");
  assert.match(button.innerHTML, /Refresh page/);

  await button.listeners.click(event);

  assert.equal(sendCount, 1, "the stale runtime must not be called a second time");
  assert.equal(reloadCount, 1);
});

test("Digest button replaces stale instances and removes duplicates", () => {
  const harness = createHarness();
  const { row: staleRow, buttonGroup: staleGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  harness.actionRows.push(staleRow, visibleRow);

  const staleButton = new FakeElement();
  staleButton.id = "ytd-digest-button";
  const duplicateButton = new FakeElement();
  duplicateButton.id = "ytd-digest-button";
  harness.elements.push(staleButton, duplicateButton);
  staleGroup.appendChild(staleButton);
  staleGroup.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children.length, 1);
  assert.notEqual(visibleGroup.children[0], staleButton);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(staleButton.isConnected, false);
  assert.equal(duplicateButton.isConnected, false);
});

test("resize reconciliation follows YouTube to the newly visible toolbar", () => {
  const harness = createHarness();
  const { row: firstRow, buttonGroup: firstGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: secondRow, buttonGroup: secondGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(firstRow, secondRow);

  harness.context.injectDigestButton();
  harness.context.setupDigestButtonResizeListener();
  firstRow.width = 0;
  firstRow.height = 0;
  firstGroup.width = 0;
  firstGroup.height = 0;
  secondRow.width = 389;
  secondRow.height = 36;
  secondGroup.width = 389;
  secondGroup.height = 36;

  harness.windowListeners.resize();
  harness.flushTimers();

  assert.equal(firstGroup.children.length, 0);
  assert.equal(secondRow.children.length, 1);
  assert.equal(secondGroup.children.length, 1);
  assert.equal(secondGroup.children[0].id, "ytd-digest-button");
});

test("DOM mutation reconciliation repairs a replaced toolbar", () => {
  const harness = createHarness();
  const { row: oldRow, buttonGroup: oldGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: newRow, buttonGroup: newGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(oldRow, newRow);

  harness.context.injectDigestButton();
  harness.context.setupButtonObserver();
  oldRow.width = 0;
  oldRow.height = 0;
  oldGroup.width = 0;
  oldGroup.height = 0;
  newRow.width = 500;
  newRow.height = 36;
  newGroup.width = 500;
  newGroup.height = 36;

  harness.observers[0].callback([]);
  harness.flushTimers();

  assert.equal(oldGroup.children.length, 0);
  assert.equal(newRow.children.length, 1);
  assert.equal(newGroup.children.length, 1);
});
