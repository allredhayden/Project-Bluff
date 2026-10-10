const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const json = (value) => JSON.parse(JSON.stringify(value));

function loadController(saved = null, muted = false) {
  const nodes = new Map();
  function element() {
    return {
      attributes: {}, dataset: {}, style: {}, value: "", textContent: "",
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener() {},
      querySelector: node,
    };
  }
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  }
  const soundButtons = ["bells", "maleScream", "femaleScream"].map((sound) => {
    const button = element();
    button.dataset.daySound = sound;
    return button;
  });
  const stored = new Map();
  if (saved) stored.set("project-bluff-volume-settings-v1", JSON.stringify(saved));
  stored.set("project-bluff-local-muted-v1", String(muted));
  const timers = new Map();
  let timerId = 0;
  const browserWindow = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    window: browserWindow,
    document: {
      querySelector: node,
      querySelectorAll: (selector) => selector.includes("data-murder-sound") ? soundButtons : [],
      body: element(),
    },
    console,
    performance: { now: () => 0 },
  });
  // Load the actual state and handlers without starting audio downloads or server discovery.
  vm.runInContext(appSource.slice(0, appSource.lastIndexOf("\ninitializeMurderSoundUi();")), context);
  return {
    window: browserWindow, nodes, stored, timers, soundButtons,
    evaluate: (code) => vm.runInContext(code, context),
    apply(state) {
      context.incomingState = json(state);
      vm.runInContext("applySharedControlState(incomingState)", context);
    },
    snapshot() { return json(vm.runInContext("volumeSettings", context)); },
  };
}

function sharedBus() {
  const seed = loadController();
  let state = {
    sessionId: "test-server", revision: 0, cueRevision: 0, currentStage: null,
    settingsInitialized: true,
    settings: json(seed.evaluate("initialSavedSettings")),
  };
  const controllers = [];
  const requests = [];
  return {
    get state() { return json(state); },
    requests,
    connect(controller) {
      controllers.push(controller);
      controller.window.ProjectBluffLighting = {
        async updateSettings(changes, options = {}) {
          requests.push({ changes: json(changes), options: json(options) });
          if (!options.initializeOnly || !state.settingsInitialized) {
            state.settings = seed.evaluate("mergeSettingsChanges")(state.settings, json(changes));
            state.settingsInitialized = true;
            state.revision += 1;
          }
          controllers.forEach((target) => target.apply(state));
          return { state: json(state) };
        },
      };
      controller.evaluate("setControlServerAvailable(true)");
      controller.apply(state);
    },
  };
}

test("server values replace stale browser settings and update the controls without writes", () => {
  const controller = loadController({
    master: 0.99, tracks: { day: 0.99 }, showLoopProgress: true,
    defaultTrackVolumesVersion: 2,
  });
  const bus = sharedBus();
  bus.connect(controller);
  assert.equal(controller.snapshot().master, 0.8);
  assert.equal(controller.snapshot().tracks.day, 0.5);
  assert.equal(controller.nodes.get('[data-volume-slider="master"]').value, "80");
  assert.equal(controller.nodes.get('[data-track-volume="day"]').value, "50");
  assert.equal(controller.snapshot().showLoopProgress, false);
  assert.equal(bus.requests.length, 0);
  const cached = JSON.parse(controller.stored.get("project-bluff-volume-settings-v1"));
  assert.equal(cached.master, 0.8);
});

test("two controllers share volumes, progress and arming, and a later load joins the mix", async () => {
  const bus = sharedBus();
  const computer = loadController();
  const phone = loadController(null, true);
  bus.connect(computer);
  bus.connect(phone);
  computer.evaluate("setMasterVolume(0.41); setTrackVolume('day', 0.23); setLoopProgressEnabled(true)");
  await computer.evaluate("flushSharedSettingsChanges()");
  assert.equal(phone.snapshot().master, 0.41);
  assert.equal(phone.snapshot().tracks.day, 0.23);
  assert.equal(phone.snapshot().showLoopProgress, true);
  phone.evaluate("setTrackVolume('nightLoop', 0.37); toggleDaySound('bells'); toggleDaySound('femaleScream')");
  await phone.evaluate("flushSharedSettingsChanges()");
  assert.equal(computer.snapshot().tracks.nightLoop, 0.37);
  assert.deepEqual(computer.snapshot().daySounds, {
    bells: false, maleScream: false, femaleScream: true,
  });
  assert.equal(computer.soundButtons[2].attributes["aria-pressed"], "true");
  assert.equal(phone.evaluate("localMuted"), true);
  assert.equal(computer.evaluate("localMuted"), false);
  const later = loadController({ master: 1, tracks: { nightLoop: 1 } });
  bus.connect(later);
  assert.equal(later.snapshot().master, 0.41);
  assert.equal(later.snapshot().tracks.nightLoop, 0.37);
  assert.deepEqual(later.snapshot().daySounds, computer.snapshot().daySounds);
  assert.equal(bus.requests.length, 2);
});

test("rapid local slider edits survive a remote update and patch only the edited fields", async () => {
  const bus = sharedBus();
  const computer = loadController();
  const phone = loadController();
  bus.connect(computer);
  bus.connect(phone);
  computer.evaluate("setMasterVolume(0.7); setMasterVolume(0.6); setMasterVolume(0.52)");
  phone.evaluate("setTrackVolume('day', 0.29)");
  await phone.evaluate("flushSharedSettingsChanges()");
  assert.equal(computer.snapshot().master, 0.52);
  assert.equal(computer.snapshot().tracks.day, 0.29);
  await computer.evaluate("flushSharedSettingsChanges()");
  assert.equal(bus.state.settings.master, 0.52);
  assert.equal(bus.state.settings.tracks.day, 0.29);
  assert.deepEqual(bus.requests[1].changes, { master: 0.52 });
});

test("an in-flight save does not pull a slider backwards or drop a newer local change", async () => {
  const controller = loadController();
  const bus = sharedBus();
  bus.connect(controller);
  let complete;
  controller.window.ProjectBluffLighting.updateSettings = () => new Promise((resolve) => { complete = resolve; });
  controller.evaluate("setMasterVolume(0.6)");
  const firstSave = controller.evaluate("flushSharedSettingsChanges()");
  controller.evaluate("setMasterVolume(0.35)");
  const pushed = bus.state;
  pushed.revision += 1;
  pushed.settings.master = 0.6;
  pushed.settings.tracks.day = 0.27;
  controller.apply(pushed);
  assert.equal(controller.snapshot().master, 0.35);
  assert.equal(controller.snapshot().tracks.day, 0.27);
  complete({ state: pushed });
  await firstSave;
  assert.equal(controller.snapshot().master, 0.35);
  assert.deepEqual(json(controller.evaluate("pendingSettingsChanges")), { master: 0.35 });
});

test("failed saves retain the newest local intent and schedule a retry", async () => {
  const controller = loadController();
  const bus = sharedBus();
  bus.connect(controller);
  controller.window.ProjectBluffLighting.updateSettings = async () => { throw new Error("offline"); };
  controller.evaluate("setMasterVolume(0.3); setTrackVolume('day', 0.21)");
  await assert.rejects(controller.evaluate("flushSharedSettingsChanges()"), /offline/);
  assert.deepEqual(json(controller.evaluate("pendingSettingsChanges")), {
    master: 0.3, tracks: { day: 0.21 },
  });
  assert.ok(controller.timers.size > 0);
  assert.match(controller.nodes.get("[data-status]").textContent, /Retrying/);
  controller.window.ProjectBluffLighting.updateSettings = async (changes) => {
    const restored = bus.state;
    restored.revision += 1;
    restored.settings.master = changes.master;
    restored.settings.tracks.day = changes.tracks.day;
    controller.apply(restored);
  };
  await controller.evaluate("flushSharedSettingsChanges()");
  assert.deepEqual(json(controller.evaluate("pendingSettingsChanges")), {});
  assert.equal(controller.nodes.get("[data-status]").textContent, "Settings synced.");
});

test("a failed first-time migration retries without requiring another server revision", async () => {
  const controller = loadController({ master: 0.34, defaultTrackVolumesVersion: 2 });
  const state = sharedBus().state;
  state.settingsInitialized = false;
  let attempts = 0;
  controller.window.ProjectBluffLighting = {
    async updateSettings(changes, options) {
      attempts += 1;
      assert.equal(options.initializeOnly, true);
      if (attempts === 1) throw new Error("offline");
      state.settingsInitialized = true;
      state.settings = json(changes);
      state.revision += 1;
      controller.apply(state);
    },
  };
  controller.apply(state);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.timers.size, 1);
  [...controller.timers.values()][0].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(controller.snapshot().master, 0.34);
  assert.equal(controller.nodes.get("[data-status]").textContent, "Saved settings synced.");
});

test("existing browser settings seed an empty server once and empty browsers do not", async () => {
  const controller = loadController({ master: 0.34, tracks: { day: 0.22 }, defaultTrackVolumesVersion: 2 });
  const seed = json(controller.evaluate("initialSavedSettings"));
  const bus = sharedBus();
  const state = bus.state;
  state.settingsInitialized = false;
  const requests = [];
  controller.window.ProjectBluffLighting = {
    async updateSettings(changes, options) { requests.push({ changes: json(changes), options }); },
  };
  controller.apply(state);
  controller.apply(state);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].changes, seed);
  assert.equal(requests[0].options.initializeOnly, true);
  // Do not replace the original cache with defaults while its migration is pending.
  assert.equal(JSON.parse(controller.stored.get("project-bluff-volume-settings-v1")).master, 0.34);
  const empty = loadController();
  empty.apply(state);
  assert.equal(empty.stored.has("project-bluff-volume-settings-v1"), false);
});

test("remote volume changes update live gains and preserve a fade's ending time", () => {
  const controller = loadController(null, true);
  const bus = sharedBus();
  bus.connect(controller);
  controller.evaluate(`
    audioContext = { currentTime: 5 };
    masterGain = { gain: { cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; } } };
    activeLoops.set('day', {
      id: 'day', fileKey: 'day',
      gainRamp: { startTime: 0, startValue: 0, endTime: 10, endValue: 0.5 },
      gain: { gain: {
        cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; },
        linearRampToValueAtTime(value, endTime) { this.target = value; this.endTime = endTime; },
      } },
    });
  `);
  const state = bus.state;
  state.revision += 1;
  state.settings.master = 0.37;
  state.settings.tracks.day = 0.32;
  controller.apply(state);
  assert.equal(controller.evaluate("masterGain.gain.value"), 0);
  assert.equal(controller.evaluate("activeLoops.get('day').gain.gain.target"), 0.32);
  assert.equal(controller.evaluate("activeLoops.get('day').gain.gain.endTime"), 10);
  assert.equal(controller.evaluate("activeLoops.get('day').gainRamp.startValue"), 0.25);
  controller.evaluate("setLocalMuted(false)");
  assert.equal(controller.evaluate("masterGain.gain.value"), 0.37);
  assert.equal(bus.requests.length, 0);
});

test("static audio-only pages keep saving settings locally", () => {
  const controller = loadController();
  controller.evaluate("setMasterVolume(0.25); setTrackVolume('day', 0.12); toggleDaySound('maleScream')");
  const saved = JSON.parse(controller.stored.get("project-bluff-volume-settings-v1"));
  assert.equal(saved.master, 0.25);
  assert.equal(saved.tracks.day, 0.12);
  assert.equal(saved.daySounds.maleScream, true);
  assert.deepEqual(json(controller.evaluate("pendingSettingsChanges")), {});
});
