const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

function loadLightingModule() {
  const browserWindow = {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "lighting-control.js"), "utf8"),
    { window: browserWindow },
  );
  return browserWindow.ProjectBluffLighting;
}

function blankConfig() {
  const cues = {};
  ["setup", "day", "nominations", "night", "stopAll"].forEach((trigger) => {
    cues[trigger] = {
      fadeMs: 3000,
      profiles: {
        "shehds-par-7x18-rgbwauv-10ch": { values: {}, fade: [] },
        "shehds-par-18x18-rgbwauv-10ch": { values: {}, fade: [] },
      },
      fixtures: {},
    };
  });
  return {
    version: 3,
    outputMode: "artnet",
    artnet: {
      targetHost: "255.255.255.255",
      interfaceAddress: "",
      portAddressBase: 0,
      refreshHz: 30,
    },
    osc: {
      targetHost: "127.0.0.1",
      targetPort: 53000,
      messages: {
        setup: "", day: "", nominations: "", night: "", stopAll: "",
        bells: "", maleScream: "", femaleScream: "",
      },
    },
    fixtures: [],
    cues,
  };
}

const definition = {
  id: "shehds-par-18x18-rgbwauv-10ch",
  shortName: "18x18 PAR",
  footprint: 10,
  parameters: [
    ["dimmer", true], ["red", true], ["green", true], ["blue", true],
    ["white", true], ["amber", true], ["uv", true], ["strobe", true],
    ["autoProgram", false], ["autoSpeed", true],
  ].map(([key, fadeAllowed]) => ({ key, fadeAllowed })),
};

const miniDefinition = {
  ...definition,
  id: "shehds-par-7x18-rgbwauv-10ch",
  shortName: "7x18 PAR",
};

test("only the real local Bluff health response enables lighting", () => {
  const lighting = loadLightingModule();
  assert.equal(lighting.parseServerAvailability({ service: "project-bluff", lightingAvailable: true }), true);
  assert.equal(lighting.parseServerAvailability({ service: "github-pages", lightingAvailable: true }), false);
  assert.equal(lighting.parseServerAvailability({ service: "project-bluff", oscAvailable: true }), false);
  assert.equal(lighting.parseServerAvailability(null), false);
});

test("adding a fixture creates one blank override in every fixed trigger", () => {
  const lighting = loadLightingModule();
  const config = lighting.addFixtureToConfig(blankConfig(), definition, "fixture-one", "Town Square");
  assert.deepEqual(JSON.parse(JSON.stringify(config.fixtures)), [{
    id: "fixture-one",
    name: "Town Square",
    type: definition.id,
    universe: 1,
    address: 1,
  }]);
  Object.values(config.cues).forEach((cue) => {
    const state = cue.fixtures["fixture-one"];
    assert.deepEqual(JSON.parse(JSON.stringify(state)), { values: {}, fade: [] });
  });
});

test("automatic fixture patching finds the next non-overlapping 10-channel block", () => {
  const lighting = loadLightingModule();
  let config = lighting.addFixtureToConfig(blankConfig(), definition, "fixture-one");
  config = lighting.addFixtureToConfig(config, definition, "fixture-two");
  config = lighting.addFixtureToConfig(config, definition, "fixture-three");
  assert.deepEqual(Array.from(config.fixtures, (fixture) => fixture.address), [1, 11, 21]);
});

test("removing a fixture removes it from the patch and all trigger looks", () => {
  const lighting = loadLightingModule();
  let config = lighting.addFixtureToConfig(blankConfig(), definition, "fixture-one");
  config = lighting.addFixtureToConfig(config, definition, "fixture-two");
  config = lighting.removeFixtureFromConfig(config, "fixture-one");
  assert.deepEqual(Array.from(config.fixtures, (fixture) => fixture.id), ["fixture-two"]);
  Object.values(config.cues).forEach((cue) => {
    assert.equal(Object.hasOwn(cue.fixtures, "fixture-one"), false);
    assert.equal(Object.hasOwn(cue.fixtures, "fixture-two"), true);
  });
});

test("profile programming is the baseline and individual values override it", () => {
  const lighting = loadLightingModule();
  let config = lighting.addFixtureToConfig(blankConfig(), definition, "eighteen-one");
  config = lighting.addFixtureToConfig(config, definition, "eighteen-two");
  config = lighting.addFixtureToConfig(config, miniDefinition, "seven-one");
  const cue = config.cues.setup;
  const eighteenProfile = cue.profiles[definition.id];
  lighting.setProgramValue(eighteenProfile, "red", 44, true);

  assert.equal(Object.keys(cue.fixtures["eighteen-one"].values).length, 0);
  assert.equal(lighting.effectiveParameterState(cue, config.fixtures[0], "red").value, 44);
  assert.equal(lighting.effectiveParameterState(cue, config.fixtures[0], "red").source, "profile");
  assert.equal(lighting.effectiveParameterState(cue, config.fixtures[2], "red").source, "home");

  lighting.setProgramValue(cue.fixtures["eighteen-two"], "red", 0, false);
  const overridden = lighting.effectiveParameterState(cue, config.fixtures[1], "red");
  assert.equal(overridden.value, 0);
  assert.equal(overridden.fade, false);
  assert.equal(overridden.source, "fixture");

  lighting.clearProgramState(cue.fixtures["eighteen-two"]);
  assert.equal(lighting.effectiveParameterState(cue, config.fixtures[1], "red").value, 44);
  lighting.clearProgramState(eighteenProfile);
  assert.equal(lighting.effectiveParameterState(cue, config.fixtures[0], "red").source, "home");
});

test("the editor follows each fixture profile's physical DMX channel order", () => {
  const lighting = loadLightingModule();
  const sevenParameters = [
    ["dimmer", 1], ["red", 2], ["green", 3], ["blue", 4], ["white", 5],
    ["amber", 6], ["uv", 7], ["strobe", 8], ["autoProgram", 9], ["autoSpeed", 10],
  ].map(([key, channel]) => ({ key, channel }));
  assert.deepEqual(
    Array.from(lighting.parametersForEditor({ parameters: sevenParameters }), (parameter) => parameter.key),
    ["dimmer", "red", "green", "blue", "white", "amber", "uv", "strobe", "autoProgram", "autoSpeed"],
  );
});

test("configuration comparison ignores object key order but detects cue edits", () => {
  const lighting = loadLightingModule();
  const first = lighting.addFixtureToConfig(blankConfig(), definition, "fixture-one");
  const copied = JSON.parse(JSON.stringify(first));
  const reordered = {
    cues: copied.cues,
    fixtures: copied.fixtures,
    artnet: copied.artnet,
    osc: copied.osc,
    outputMode: "artnet",
    version: 3,
  };
  assert.equal(lighting.configsEqual(first, reordered), true);
  reordered.cues.night.fixtures["fixture-one"].values.blue = 255;
  assert.equal(lighting.configsEqual(first, reordered), false);
});

test("a shared-config response cannot overwrite an edit or save that started after its request", () => {
  const lighting = loadLightingModule();
  assert.equal(lighting.canApplySharedConfig({
    requestRevision: 7,
    currentRevision: 7,
    isDirty: false,
    isSaving: false,
  }), true);
  assert.equal(lighting.canApplySharedConfig({
    requestRevision: 7,
    currentRevision: 8,
    isDirty: false,
    isSaving: false,
  }), false);
  assert.equal(lighting.canApplySharedConfig({
    requestRevision: 7,
    currentRevision: 7,
    isDirty: true,
    isSaving: false,
  }), false);
  assert.equal(lighting.canApplySharedConfig({
    requestRevision: 7,
    currentRevision: 7,
    isDirty: false,
    isSaving: true,
  }), false);
});

test("armed autosave preserves the cue object used by mounted input handlers", () => {
  const lighting = loadLightingModule();
  const local = lighting.addFixtureToConfig(blankConfig(), definition, "fixture-one");
  const normalized = JSON.parse(JSON.stringify(local));
  normalized.cues.setup.fadeMs = 9999;

  const autosaved = lighting.savedConfigForEditor(local, normalized, false);
  assert.equal(autosaved, local);
  assert.equal(autosaved.cues.setup.fadeMs, 3000);

  const manuallySaved = lighting.savedConfigForEditor(local, normalized, true);
  assert.notEqual(manuallySaved, local);
  assert.equal(manuallySaved.cues.setup.fadeMs, 9999);
});

test("lighting editor output mode defaults to Live and Blind follows the game", () => {
  const lighting = loadLightingModule();
  assert.equal(lighting.normalizeOutputMode(undefined), "live");
  assert.equal(lighting.normalizeOutputMode("live"), "live");
  assert.equal(lighting.normalizeOutputMode("blind"), "blind");
  assert.equal(lighting.outputTriggerForMode("live", "night", "day"), "night");
  assert.equal(lighting.outputTriggerForMode("blind", "night", "day"), "day");
});

test("lighting engine defaults to Art-Net and DAY events preserve actual playback order", () => {
  const lighting = loadLightingModule();
  assert.equal(lighting.normalizeLightingEngine(undefined), "artnet");
  assert.equal(lighting.normalizeLightingEngine("osc"), "osc");
  assert.deepEqual(Array.from(lighting.buildStageTriggers("night")), ["night"]);
  assert.deepEqual(Array.from(lighting.buildStageTriggers("day", {
    bells: true,
    maleScream: false,
    femaleScream: true,
  })), ["day", "bells", "femaleScream"]);
});

test("cue edits recall only the output-driving look for each mode", () => {
  const lighting = loadLightingModule();
  assert.equal(lighting.shouldRecallEditedTrigger("live", "night", "night", "day"), true);
  assert.equal(lighting.shouldRecallEditedTrigger("live", "day", "night", "day"), false);
  assert.equal(lighting.shouldRecallEditedTrigger("blind", "day", "night", "day"), true);
  assert.equal(lighting.shouldRecallEditedTrigger("blind", "night", "night", "day"), false);
});

test("service worker bypasses lighting API requests before any cache response", () => {
  const listeners = {};
  const self = {
    location: { origin: "https://bluff.test" },
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
  };
  const caches = {
    open: async () => ({
      match: async () => null,
      put: async () => undefined,
    }),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8"),
    { URL, caches, fetch: async () => ({ ok: false }), self },
  );
  let responded = false;
  listeners.fetch({
    request: { method: "GET", url: "https://bluff.test/api/lighting/config" },
    respondWith() {
      responded = true;
    },
  });
  assert.equal(responded, false);
});

test("service worker cache version and dual lighting asset match the application", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert.match(appSource, /AUDIO_CACHE_NAME = "botc-soundtrack-v18"/);
  assert.match(workerSource, /CACHE_NAME = "botc-soundtrack-v18"/);
  assert.match(workerSource, /"\.\/lighting-control\.js"/);
  assert.doesNotMatch(workerSource, /osc-control/);
});

test("service worker activation deletes old caches and preserves v18", async () => {
  const listeners = {};
  const deleted = [];
  const self = {
    clients: { claim: async () => undefined },
    location: { origin: "https://bluff.test" },
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
  };
  const caches = {
    delete: async (name) => {
      deleted.push(name);
      return true;
    },
    keys: async () => ["botc-soundtrack-v17", "botc-soundtrack-v18", "unrelated-old-cache"],
    open: async () => ({ addAll: async () => undefined }),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8"),
    { URL, caches, fetch: async () => ({ ok: false }), self },
  );
  let activation = null;
  listeners.activate({ waitUntil(promise) { activation = promise; } });
  await activation;
  assert.deepEqual(deleted.sort(), ["botc-soundtrack-v17", "unrelated-old-cache"]);
});

test("primary stages dispatch actual auxiliary sounds while Stop All remains singular", () => {
  const source = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
  assert.match(source, /buildStageTriggers\(stage/);
  assert.match(source, /dispatchLightingTrigger\(stage, lightingTriggers\.slice\(1\)\)/);
  assert.match(source, /dispatchLightingTrigger\("stopAll"\)/);
  assert.doesNotMatch(source, /ProjectBluffOsc/);
});

test("operator UI offers mutually exclusive Art-Net and OSC controls", () => {
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const server = fs.readFileSync(path.join(projectRoot, "server.py"), "utf8");
  assert.match(html, /Lighting/);
  assert.match(html, /Add Fixture/);
  assert.match(html, /data-lighting-mode="live"/);
  assert.match(html, /data-lighting-mode="blind"/);
  assert.match(html, /data-lighting-engine="artnet"/);
  assert.match(html, /data-lighting-engine="osc"/);
  assert.match(html, /data-lighting-osc-message-list/);
  assert.match(fs.readFileSync(path.join(projectRoot, "lighting-control.js"), "utf8"), /lighting-cue-profile-group/);
  assert.doesNotMatch(html, /Grimoire/);
  assert.match(server, /OSC/);
});
