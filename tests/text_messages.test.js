const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "text-messages.js"), "utf8");

function loadMessages(storage = new Map()) {
  const elements = new Map();
  const document = { activeElement: null };
  function element(selector, dataset = {}) {
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    const node = {
      dataset, style: {}, value: "", textContent: "", hidden: false,
      selectionStart: 0, selectionEnd: 0, scrollTop: 0,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
      },
      setAttribute: (name, value) => attributes.set(name, value),
      addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) || []), listener]),
      emit(name, event = {}) { (listeners.get(name) || []).forEach((listener) => listener(event)); },
      focus() {
        document.activeElement?.blur();
        document.activeElement = node;
        node.emit("focus");
      },
      blur() {
        if (document.activeElement === node) {
          document.activeElement = null;
          node.emit("blur");
        }
      },
      select() { node.selectionStart = 0; node.selectionEnd = node.value.length; },
      setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
    };
    elements.set(selector, node);
    return node;
  }
  ["text-modal", "text-open", "text-close", "billboard-stage", "billboard-message", "billboard-empty",
    "billboard-editor", "billboard-edit", "conversation-editor", "conversation-done",
    "conversation-finish", "text-size", "text-smaller", "text-larger"].forEach((name) => element(`[data-${name}]`));
  const modes = ["billboard", "conversation"].map((mode) => element(`[data-text-mode="${mode}"]`, { textMode: mode }));
  const panels = ["billboard", "conversation"].map((mode) => element(`[data-text-panel="${mode}"]`, { textPanel: mode }));
  const clears = ["billboard", "conversation"].map((mode) => element(`[data-text-clear="${mode}"]`, { textClear: mode }));
  elements.get("[data-text-modal]").hidden = true;
  const controller = element("main.app");
  document.body = element("body");
  document.querySelector = (selector) => elements.get(selector);
  document.querySelectorAll = (selector) => ({
    "[data-text-mode]": modes,
    "[data-text-panel]": panels,
    "[data-text-clear]": clears,
  })[selector] || [];
  const network = () => { throw new Error("Silent messages must not access a network or shared state"); };
  const window = {
    innerHeight: 844,
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch: network,
    ProjectBluffLighting: new Proxy({}, { get: network }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
  };
  vm.runInNewContext(source, { document, window, fetch: network, WebSocket: network, EventSource: network, BroadcastChannel: network });
  return {
    controller,
    active: () => document.activeElement,
    get: (name) => elements.get(`[data-${name}]`),
    panel: (name) => panels.find((panel) => panel.dataset.textPanel === name),
    clear: (name) => clears.find((button) => button.dataset.textClear === name).emit("click"),
    mode: (name) => modes.find((button) => button.dataset.textMode === name).emit("click"),
    write(name, text) {
      const editor = elements.get(`[data-${name}]`);
      editor.value = text;
      editor.emit("input");
    },
  };
}

test("silent messages edit independently of shared controls and other devices", () => {
  const first = loadMessages();
  const second = loadMessages();
  first.get("text-open").emit("click");
  first.get("billboard-edit").emit("click");
  first.write("billboard-editor", "Choose a player.\nThen close your eyes.");
  first.get("billboard-edit").emit("click");
  first.mode("conversation");
  first.write("conversation-editor", "Who do you trust?\n\nI trust Sam.");
  first.get("text-larger").emit("click");
  first.get("text-close").emit("click");
  assert.equal(first.get("billboard-message").textContent, "Choose a player.\nThen close your eyes.");
  assert.equal(first.get("conversation-editor").value, "Who do you trust?\n\nI trust Sam.");
  assert.equal(first.get("conversation-editor").style.fontSize, "40px");
  assert.equal(second.get("billboard-editor").value, "");
  assert.equal(second.get("conversation-editor").value, "");
  assert.equal(second.get("conversation-editor").style.fontSize, "36px");
});

test("refreshing the same tab restores separate drafts and the selected size", () => {
  const storage = new Map();
  const before = loadMessages(storage);
  before.get("text-open").emit("click");
  before.get("billboard-edit").emit("click");
  before.write("billboard-editor", "<b>This is plain text.</b>");
  before.mode("conversation");
  before.write("conversation-editor", "One shared paragraph.\nA manual line break.");
  before.get("text-smaller").emit("click");
  const after = loadMessages(storage);
  after.get("text-open").emit("click");
  assert.equal(after.get("billboard-message").textContent, "<b>This is plain text.</b>");
  assert.equal(after.get("conversation-editor").value, "One shared paragraph.\nA manual line break.");
  assert.equal(after.get("conversation-editor").style.fontSize, "32px");
  assert.equal(after.panel("conversation").hidden, false);
  assert.equal(after.panel("billboard").hidden, true);
});

test("restricted browser storage does not block writing or showing messages", () => {
  const unavailable = { get() { throw new Error("Storage denied"); }, set() { throw new Error("Storage denied"); } };
  const messages = loadMessages(unavailable);
  messages.get("text-open").emit("click");
  messages.get("billboard-edit").emit("click");
  messages.write("billboard-editor", "Wake up.");
  messages.get("billboard-edit").emit("click");
  assert.equal(messages.get("billboard-message").textContent, "Wake up.");
  messages.mode("conversation");
  messages.write("conversation-editor", "What did you learn?");
  messages.get("text-larger").emit("click");
  assert.equal(messages.get("conversation-editor").value, "What did you learn?");
  assert.equal(messages.get("conversation-editor").style.fontSize, "40px");
});

test("the controller cannot activate while either text mode is open", () => {
  const messages = loadMessages();
  function inputWasBlocked(type) {
    let prevented = false;
    let stopped = false;
    messages.controller.emit(type, {
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    return prevented && stopped;
  }
  assert.equal(inputWasBlocked("click"), false);
  messages.get("text-open").emit("click");
  messages.get("billboard-edit").emit("click");
  for (const mode of ["billboard", "conversation"]) {
    messages.mode(mode);
    assert.equal(messages.controller.inert, true);
    for (const type of ["click", "pointerdown", "keydown"]) {
      assert.equal(inputWasBlocked(type), true);
    }
  }
  messages.get("text-close").emit("click");
  assert.equal(messages.controller.inert, false);
  assert.equal(inputWasBlocked("click"), false);
});

test("Clear removes only the chosen draft, persists after reload, and preserves conversation size", () => {
  const storage = new Map();
  const messages = loadMessages(storage);
  messages.get("text-open").emit("click");
  messages.get("billboard-edit").emit("click");
  messages.write("billboard-editor", "Choose a player.");
  messages.mode("conversation");
  messages.write("conversation-editor", "Who do you trust?");
  messages.get("text-larger").emit("click");
  messages.get("conversation-editor").focus();
  messages.clear("conversation");
  assert.equal(messages.get("conversation-editor").value, "");
  assert.equal(messages.get("conversation-editor").style.fontSize, "40px");
  assert.equal(messages.active(), messages.get("conversation-editor"));
  assert.equal(messages.get("billboard-message").textContent, "Choose a player.");
  const refreshed = loadMessages(storage);
  assert.equal(refreshed.get("conversation-editor").value, "");
  assert.equal(refreshed.get("billboard-editor").value, "Choose a player.");
  messages.write("conversation-editor", "I trust Sam.");
  messages.mode("billboard");
  messages.clear("billboard");
  assert.equal(messages.get("billboard-message").textContent, "");
  assert.equal(messages.get("billboard-editor").value, "");
  assert.equal(messages.get("billboard-empty").hidden, false);
  assert.equal(messages.get("conversation-editor").value, "I trust Sam.");
  const cleared = loadMessages(storage);
  assert.equal(cleared.get("billboard-editor").value, "");
  assert.equal(cleared.get("conversation-editor").value, "I trust Sam.");
});

test("Clear while composing a Billboard keeps its editor ready for the next message", () => {
  const messages = loadMessages();
  messages.get("text-open").emit("click");
  messages.get("billboard-edit").emit("click");
  messages.write("billboard-editor", "Wake up.");
  messages.clear("billboard");
  assert.equal(messages.get("billboard-editor").value, "");
  assert.equal(messages.get("billboard-editor").hidden, false);
  assert.equal(messages.get("billboard-edit").textContent, "Done");
  assert.equal(messages.active(), messages.get("billboard-editor"));
});
