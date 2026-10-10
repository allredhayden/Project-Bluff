(function initializeProjectBluffLightingModule(global) {
  "use strict";

  const API_TIMEOUT_MS = 3000;
  const CONFIG_POLL_MS = 3000;
  const CONTROL_POLL_MS = 750;
  const STATUS_POLL_MS = 1000;
  const CUE_SYNC_DEBOUNCE_MS = 180;
  const DEFAULT_FADE_KEYS = new Set(["dimmer", "red", "green", "blue", "white", "amber", "uv"]);

  let dom = null;
  let available = false;
  let dirty = false;
  let saving = false;
  let armed = false;
  let definitions = [];
  let triggers = [];
  let oscTriggers = [];
  let config = null;
  let selectedTrigger = "setup";
  let outputMode = "live";
  let activeGameTrigger = "stopAll";
  let configRevision = 0;
  let cueSyncTimerId = null;
  let cueSyncPromise = null;
  const pendingCueTriggers = new Set();
  let lastControlRevision = -1;
  let controlSessionId = null;
  let onControlState = null;
  let onAvailabilityChange = null;
  let configPollId = null;
  let controlPollId = null;
  let statusPollId = null;
  let controlEventSource = null;

  class ApiError extends Error {
    constructor(message, response = null, payload = null) {
      super(message);
      this.response = response;
      this.payload = payload;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function configsEqual(first, second) {
    return Boolean(first && second && canonicalJson(first) === canonicalJson(second));
  }

  function canApplySharedConfig({ requestRevision, currentRevision, isDirty, isSaving }) {
    return !isDirty && !isSaving && requestRevision === currentRevision;
  }

  function savedConfigForEditor(currentConfig, serverConfig, renderOnSuccess) {
    return renderOnSuccess ? cloneJson(serverConfig) : currentConfig;
  }

  function hasProgrammedValue(state, parameterKey) {
    return Boolean(state && Object.prototype.hasOwnProperty.call(state.values, parameterKey));
  }

  function programStateHasValues(state) {
    return Boolean(state && Object.keys(state.values).length > 0);
  }

  function setProgramFade(state, parameterKey, enabled) {
    if (!hasProgrammedValue(state, parameterKey)) {
      return;
    }
    if (enabled && !state.fade.includes(parameterKey)) {
      state.fade.push(parameterKey);
    } else if (!enabled) {
      state.fade = state.fade.filter((key) => key !== parameterKey);
    }
  }

  function setProgramValue(state, parameterKey, value, fadeByDefault = false) {
    const wasProgrammed = hasProgrammedValue(state, parameterKey);
    state.values[parameterKey] = value;
    if (!wasProgrammed) {
      setProgramFade(state, parameterKey, fadeByDefault);
    }
  }

  function clearProgramValue(state, parameterKey) {
    delete state.values[parameterKey];
    state.fade = state.fade.filter((key) => key !== parameterKey);
  }

  function clearProgramState(state) {
    Object.keys(state.values).forEach((parameterKey) => {
      delete state.values[parameterKey];
    });
    state.fade.splice(0, state.fade.length);
  }

  function effectiveParameterState(cue, fixture, parameterKey) {
    const fixtureState = cue.fixtures[fixture.id];
    if (hasProgrammedValue(fixtureState, parameterKey)) {
      return {
        value: fixtureState.values[parameterKey],
        fade: fixtureState.fade.includes(parameterKey),
        source: "fixture",
      };
    }
    const profileState = cue.profiles[fixture.type];
    if (hasProgrammedValue(profileState, parameterKey)) {
      return {
        value: profileState.values[parameterKey],
        fade: profileState.fade.includes(parameterKey),
        source: "profile",
      };
    }
    return {
      value: 0,
      fade: DEFAULT_FADE_KEYS.has(parameterKey),
      source: "home",
    };
  }

  function parametersForEditor(definition) {
    return [...definition.parameters].sort((first, second) => {
      const firstChannel = Number(first.channel);
      const secondChannel = Number(second.channel);
      if (!Number.isFinite(firstChannel) || !Number.isFinite(secondChannel)) {
        return 0;
      }
      return firstChannel - secondChannel;
    });
  }

  function parseServerAvailability(payload) {
    return Boolean(payload && payload.service === "project-bluff" && payload.lightingAvailable === true);
  }

  function normalizeLightingEngine(value) {
    return value === "osc" ? "osc" : "artnet";
  }

  function buildStageTriggers(stage, sounds = {}) {
    const stageTriggers = [stage];
    if (stage === "day") {
      if (sounds.bells === true) stageTriggers.push("bells");
      if (sounds.maleScream === true) stageTriggers.push("maleScream");
      if (sounds.femaleScream === true) stageTriggers.push("femaleScream");
    }
    return stageTriggers;
  }

  function buildControlTriggerPayload(trigger, auxiliaryTriggers = [], options = {}) {
    const payload = auxiliaryTriggers.length > 0
      ? { trigger, auxiliaryTriggers: [...auxiliaryTriggers] }
      : { trigger };
    if (trigger === "day" && Number.isFinite(options.loopOffset)) {
      payload.loopOffset = Math.max(0, options.loopOffset);
    }
    return payload;
  }

  function nominationMixEnvelope(elapsedSeconds, targetGain = 1) {
    const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    const target = Number.isFinite(targetGain) ? Math.max(0, targetGain) : 1;

    if (elapsed < 4) {
      return {
        gain: target * (1 - elapsed / 4),
        rampEndGain: 0,
        rampSeconds: 4 - elapsed,
        nextChangeSeconds: 10 - elapsed,
      };
    }
    if (elapsed < 10) {
      return {
        gain: 0,
        rampEndGain: null,
        rampSeconds: 0,
        nextChangeSeconds: 10 - elapsed,
      };
    }
    if (elapsed < 20) {
      return {
        gain: target * ((elapsed - 10) / 10),
        rampEndGain: target,
        rampSeconds: 20 - elapsed,
        nextChangeSeconds: null,
      };
    }
    return {
      gain: target,
      rampEndGain: null,
      rampSeconds: 0,
      nextChangeSeconds: null,
    };
  }

  function normalizeOutputMode(value) {
    return value === "blind" ? "blind" : "live";
  }

  function outputTriggerForMode(mode, editorTrigger, gameTrigger) {
    return normalizeOutputMode(mode) === "blind" ? gameTrigger : editorTrigger;
  }

  function shouldRecallEditedTrigger(mode, editedTrigger, editorTrigger, gameTrigger) {
    return editedTrigger === outputTriggerForMode(mode, editorTrigger, gameTrigger);
  }

  function nextFixturePatch(fixtures, footprint = 10) {
    let universe = 1;
    while (universe <= 32768) {
      const occupied = new Set();
      fixtures.filter((fixture) => fixture.universe === universe).forEach((fixture) => {
        for (let slot = fixture.address; slot < fixture.address + footprint; slot += 1) {
          occupied.add(slot);
        }
      });
      for (let address = 1; address <= 513 - footprint; address += 1) {
        let clear = true;
        for (let slot = address; slot < address + footprint; slot += 1) {
          if (occupied.has(slot)) {
            clear = false;
            break;
          }
        }
        if (clear) {
          return { universe, address };
        }
      }
      universe += 1;
    }
    return { universe: 1, address: 1 };
  }

  function blankCueState() {
    return { values: {}, fade: [] };
  }

  function addFixtureToConfig(sourceConfig, definition, id, name = null) {
    const nextConfig = cloneJson(sourceConfig);
    const patch = nextFixturePatch(nextConfig.fixtures, definition.footprint);
    const fixture = {
      id,
      name: name || `Light ${nextConfig.fixtures.length + 1}`,
      type: definition.id,
      universe: patch.universe,
      address: patch.address,
    };
    nextConfig.fixtures.push(fixture);
    Object.values(nextConfig.cues).forEach((cue) => {
      cue.fixtures[id] = blankCueState();
    });
    return nextConfig;
  }

  function removeFixtureFromConfig(sourceConfig, fixtureId) {
    const nextConfig = cloneJson(sourceConfig);
    nextConfig.fixtures = nextConfig.fixtures.filter((fixture) => fixture.id !== fixtureId);
    Object.values(nextConfig.cues).forEach((cue) => {
      delete cue.fixtures[fixtureId];
    });
    return nextConfig;
  }

  function queryDom() {
    return {
      fieldset: document.querySelector("[data-lighting-fieldset]"),
      status: document.querySelector("[data-lighting-status]"),
      engineButtons: Array.from(document.querySelectorAll("[data-lighting-engine]")),
      artnetPanel: document.querySelector("[data-lighting-artnet-panel]"),
      oscPanel: document.querySelector("[data-lighting-osc-panel]"),
      target: document.querySelector("[data-lighting-target]"),
      interfaceAddress: document.querySelector("[data-lighting-interface]"),
      portAddressBase: document.querySelector("[data-lighting-base]"),
      refreshHz: document.querySelector("[data-lighting-refresh]"),
      oscTarget: document.querySelector("[data-lighting-osc-target]"),
      oscPort: document.querySelector("[data-lighting-osc-port]"),
      oscMessageList: document.querySelector("[data-lighting-osc-message-list]"),
      arm: document.querySelector("[data-lighting-arm]"),
      disarm: document.querySelector("[data-lighting-disarm]"),
      addFixture: document.querySelector("[data-lighting-add-fixture]"),
      empty: document.querySelector("[data-lighting-empty]"),
      fixtureList: document.querySelector("[data-lighting-fixture-list]"),
      cueSection: document.querySelector("[data-lighting-cue-section]"),
      triggerTabs: document.querySelector("[data-lighting-trigger-tabs]"),
      fadeTime: document.querySelector("[data-lighting-fade-time]"),
      cueFixtures: document.querySelector("[data-lighting-cue-fixtures]"),
      modeButtons: Array.from(document.querySelectorAll("[data-lighting-mode]")),
      modeStatus: document.querySelector("[data-lighting-mode-status]"),
      save: document.querySelector("[data-lighting-save]"),
      errorSummary: document.querySelector("[data-lighting-error-summary]"),
    };
  }

  function setStatus(message, tone = "neutral") {
    if (!dom || !dom.status) {
      return;
    }
    dom.status.textContent = message;
    dom.status.dataset.tone = tone;
  }

  function setAvailable(isAvailable) {
    available = isAvailable === true;
    if (dom && dom.fieldset) {
      dom.fieldset.disabled = !available;
    }
    if (!available) {
      setStatus("LIGHTING REQUIRES THE LOCAL BLUFF SERVER", "warning");
    }
    updateControlAvailability();
    if (typeof onAvailabilityChange === "function") {
      onAvailabilityChange(available);
    }
  }

  async function requestJson(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ApiError("The local Bluff server returned an unreadable response.", response);
      }
      if (!response.ok) {
        throw new ApiError(payload.error || `Request failed with status ${response.status}.`, response, payload);
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ApiError("The local Bluff server did not respond in time.");
      }
      throw error;
    } finally {
      global.clearTimeout(timeoutId);
    }
  }

  function clearErrors() {
    dom.errorSummary.textContent = "";
    document.querySelectorAll(".lighting-invalid").forEach((node) => {
      node.classList.remove("lighting-invalid");
      node.removeAttribute("aria-invalid");
    });
  }

  function showErrors(fieldErrors = {}, fallback = "Lighting configuration could not be saved.") {
    clearErrors();
    const entries = Object.entries(fieldErrors);
    dom.errorSummary.textContent = entries.length
      ? entries.slice(0, 4).map(([, message]) => message).join(" ")
      : fallback;
    const firstField = entries[0] && entries[0][0];
    const input = firstField && document.querySelector(`[data-lighting-field="${firstField}"]`);
    if (input) {
      input.classList.add("lighting-invalid");
      input.setAttribute("aria-invalid", "true");
      input.focus({ preventScroll: true });
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function markDirty() {
    if (!available) {
      return;
    }
    dirty = true;
    configRevision += 1;
    clearErrors();
    setStatus("UNSAVED LIGHTING CHANGES", "warning");
    updateControlAvailability();
  }

  function markCueDirty(trigger) {
    markDirty();
    if (armed) {
      scheduleCueSync(trigger);
    }
  }

  function definitionFor(type) {
    return definitions.find((definition) => definition.id === type) || definitions[0];
  }

  function renderOutputMode() {
    if (!dom) {
      return;
    }
    dom.modeButtons.forEach((button) => {
      const pressed = button.dataset.lightingMode === outputMode;
      button.setAttribute("aria-pressed", String(pressed));
      button.disabled = !available;
    });
    if (!dom.modeStatus) {
      return;
    }
    const selectedLabel = (triggers.find((trigger) => trigger.id === selectedTrigger) || {}).label
      || selectedTrigger.toUpperCase();
    const gameLabel = (triggers.find((trigger) => trigger.id === activeGameTrigger) || {}).label
      || activeGameTrigger.toUpperCase();
    dom.modeStatus.dataset.mode = outputMode;
    if (outputMode === "live") {
      dom.modeStatus.textContent = armed
        ? `LIVE EDITOR OUTPUT: ${selectedLabel}`
        : `LIVE EDITOR: ${selectedLabel} - ARM TO OUTPUT`;
    } else {
      dom.modeStatus.textContent = `BLIND - OUTPUT FOLLOWS GAME: ${gameLabel}`;
    }
  }

  function renderLightingEngine() {
    if (!dom || !config) {
      return;
    }
    const engine = normalizeLightingEngine(config.outputMode);
    dom.engineButtons.forEach((button) => {
      const pressed = button.dataset.lightingEngine === engine;
      button.setAttribute("aria-pressed", String(pressed));
      button.disabled = !available || armed;
    });
    dom.artnetPanel.hidden = engine !== "artnet";
    dom.oscPanel.hidden = engine !== "osc";
    dom.arm.textContent = engine === "artnet" ? "Arm Art-Net" : "Arm OSC";
    dom.disarm.textContent = engine === "artnet" ? "Disarm + Blackout" : "Disarm OSC";
  }

  function hasMappedOscMessage() {
    return Boolean(
      config
      && config.osc
      && Object.values(config.osc.messages).some((message) => message.trim() !== ""),
    );
  }

  function renderOscMessages() {
    if (!dom.oscMessageList || !config || !config.osc) {
      return;
    }
    dom.oscMessageList.textContent = "";
    oscTriggers.forEach((trigger) => {
      const row = document.createElement("div");
      const label = document.createElement("label");
      const labelText = document.createElement("span");
      const input = document.createElement("input");
      const test = document.createElement("button");
      row.className = "lighting-osc-message-row";
      label.className = "lighting-field lighting-osc-message-field";
      labelText.className = "lighting-field-label";
      labelText.textContent = trigger.label;
      input.className = "lighting-input lighting-osc-message-input";
      input.type = "text";
      input.value = config.osc.messages[trigger.id];
      input.placeholder = trigger.id === "day" ? "/cue/DAY/start" : "Blank - no OSC sent";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.dataset.lightingCueControl = "";
      input.dataset.lightingField = `osc.messages.${trigger.id}`;
      input.addEventListener("input", () => {
        config.osc.messages[trigger.id] = input.value;
        markDirty();
      });
      label.append(labelText, input);
      test.className = "lighting-preview-button lighting-osc-test-button";
      test.type = "button";
      test.textContent = "SEND TEST";
      test.dataset.lightingOscTest = trigger.id;
      test.addEventListener("click", () => previewTrigger(trigger.id));
      row.append(label, test);
      dom.oscMessageList.append(row);
    });
  }

  function createField(labelText, value, options = {}) {
    const label = document.createElement("label");
    const labelNode = document.createElement("span");
    const input = document.createElement(options.select ? "select" : "input");
    label.className = "lighting-field";
    labelNode.className = "lighting-field-label";
    labelNode.textContent = labelText;
    input.className = "lighting-input";
    input.dataset.lightingConfigControl = "";
    if (options.field) {
      input.dataset.lightingField = options.field;
    }
    if (options.select) {
      options.select.forEach((optionData) => {
        const option = document.createElement("option");
        option.value = optionData.value;
        option.textContent = optionData.label;
        input.append(option);
      });
    } else {
      input.type = options.type || "text";
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      if (options.step !== undefined) input.step = String(options.step);
      if (input.type === "number") input.inputMode = "numeric";
    }
    input.value = String(value);
    label.append(labelNode, input);
    return { label, input };
  }

  function renderFixtures() {
    dom.fixtureList.textContent = "";
    dom.empty.hidden = config.fixtures.length > 0;
    dom.cueSection.hidden = config.fixtures.length === 0;
    config.fixtures.forEach((fixture, index) => {
      const card = document.createElement("article");
      const header = document.createElement("div");
      const title = document.createElement("h5");
      const remove = document.createElement("button");
      const grid = document.createElement("div");
      card.className = "lighting-fixture-card";
      header.className = "lighting-fixture-card-header";
      title.className = "lighting-fixture-card-title";
      title.textContent = fixture.name;
      remove.className = "lighting-remove-button";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.dataset.lightingConfigControl = "";
      remove.addEventListener("click", () => {
        config = removeFixtureFromConfig(config, fixture.id);
        markDirty();
        renderAll();
      });
      header.append(title, remove);
      grid.className = "lighting-fixture-grid";

      const nameField = createField("Name", fixture.name, { field: `fixtures.${fixture.id}.name` });
      nameField.input.maxLength = 64;
      nameField.input.addEventListener("input", () => {
        config.fixtures[index].name = nameField.input.value;
        title.textContent = nameField.input.value || "Unnamed Light";
        markDirty();
      });
      nameField.input.addEventListener("change", renderCue);
      const typeField = createField("Type", fixture.type, {
        select: definitions.map((definition) => ({ value: definition.id, label: definition.shortName })),
        field: `fixtures.${fixture.id}.type`,
      });
      typeField.input.addEventListener("change", () => {
        config.fixtures[index].type = typeField.input.value;
        markDirty();
        renderCue();
      });
      const universeField = createField("Universe", fixture.universe, {
        type: "number", min: 1, max: 32768, field: `fixtures.${fixture.id}.universe`,
      });
      universeField.input.addEventListener("input", () => {
        config.fixtures[index].universe = Number(universeField.input.value);
        markDirty();
      });
      const addressField = createField("Address", fixture.address, {
        type: "number", min: 1, max: 503, field: `fixtures.${fixture.id}.address`,
      });
      addressField.input.addEventListener("input", () => {
        config.fixtures[index].address = Number(addressField.input.value);
        markDirty();
      });
      grid.append(nameField.label, typeField.label, universeField.label, addressField.label);
      card.append(header, grid);
      dom.fixtureList.append(card);
    });
  }

  function renderTriggerTabs() {
    dom.triggerTabs.textContent = "";
    triggers.forEach((trigger) => {
      const button = document.createElement("button");
      button.className = "lighting-trigger-tab";
      button.type = "button";
      button.role = "tab";
      button.textContent = trigger.label;
      button.dataset.trigger = trigger.id;
      button.setAttribute("aria-selected", String(trigger.id === selectedTrigger));
      button.dataset.gameActive = String(trigger.id === activeGameTrigger);
      if (trigger.id === activeGameTrigger) {
        button.setAttribute("aria-label", `${trigger.label}, active in game`);
      }
      button.addEventListener("click", () => {
        selectedTrigger = trigger.id;
        renderCue();
        if (outputMode === "live") {
          recallTriggerAfterSync(selectedTrigger);
        }
      });
      dom.triggerTabs.append(button);
    });
  }

  function createCueCard(titleText, metaText, options = {}) {
    const card = document.createElement("article");
    const header = document.createElement("div");
    const title = document.createElement("h5");
    const meta = document.createElement("span");
    const grid = document.createElement("div");
    card.className = "lighting-cue-fixture";
    if (options.profileGroup) {
      card.classList.add("lighting-cue-profile-group");
    }
    header.className = "lighting-cue-fixture-header";
    title.className = "lighting-cue-fixture-title";
    title.textContent = titleText;
    meta.className = "lighting-field-label";
    meta.textContent = metaText;
    header.append(title, meta);
    if (typeof options.onClear === "function") {
      const clearButton = document.createElement("button");
      clearButton.className = "lighting-clear-button";
      clearButton.type = "button";
      clearButton.textContent = "Clear";
      clearButton.dataset.lightingCueControl = "";
      clearButton.dataset.lightingProgrammingDisabled = String(options.clearDisabled === true);
      clearButton.disabled = !available || options.clearDisabled === true;
      clearButton.addEventListener("click", options.onClear);
      header.append(clearButton);
      header.classList.add("has-action");
    }
    grid.className = "lighting-parameter-grid";
    ["Parameter", "Value", "Timing"].forEach((text) => {
      const heading = document.createElement("span");
      heading.className = "lighting-parameter-header";
      heading.textContent = text;
      grid.append(heading);
    });
    card.append(header, grid);
    return { card, grid };
  }

  function updateCardClearAvailability(card, state) {
    const clearButton = card.querySelector(".lighting-clear-button");
    if (!clearButton) {
      return;
    }
    const isBlank = !programStateHasValues(state);
    clearButton.dataset.lightingProgrammingDisabled = String(isBlank);
    clearButton.disabled = !available || isBlank;
  }

  function setProgramInputDisplay(input, state, parameterKey, blankPlaceholder) {
    if (hasProgrammedValue(state, parameterKey)) {
      input.value = String(state.values[parameterKey]);
      input.placeholder = "";
    } else {
      input.value = "";
      input.placeholder = blankPlaceholder;
    }
  }

  function setFadeControlDisplay(
    checkbox,
    text,
    state,
    parameterKey,
    blankText,
    inheritedFade = false,
  ) {
    const programmed = hasProgrammedValue(state, parameterKey);
    checkbox.checked = programmed ? state.fade.includes(parameterKey) : inheritedFade;
    checkbox.dataset.lightingProgrammingDisabled = String(!programmed);
    checkbox.disabled = !available || !programmed;
    checkbox.setAttribute("aria-checked", String(checkbox.checked));
    text.textContent = programmed ? "Fade" : blankText;
  }

  function syncInheritedProfileMembers(profileType, parameterKey, cue) {
    const memberFades = Array.from(document.querySelectorAll("[data-lighting-profile-member-fade]"));
    document.querySelectorAll("[data-lighting-profile-member-value]").forEach((input) => {
      if (input.dataset.profileType !== profileType || input.dataset.parameterKey !== parameterKey) {
        return;
      }
      const fixture = config.fixtures.find((candidate) => candidate.id === input.dataset.fixtureId);
      const fixtureState = fixture && cue.fixtures[fixture.id];
      if (!fixture || hasProgrammedValue(fixtureState, parameterKey)) {
        return;
      }
      const effective = effectiveParameterState(cue, fixture, parameterKey);
      input.placeholder = effective.source === "profile" ? `Inherit ${effective.value}` : "Home 0";
      const checkbox = memberFades.find((candidate) => (
        candidate.dataset.fixtureId === fixture.id
        && candidate.dataset.parameterKey === parameterKey
      ));
      if (checkbox) {
        setFadeControlDisplay(
          checkbox,
          checkbox.parentElement.querySelector("span"),
          fixtureState,
          parameterKey,
          effective.source === "profile" ? "Inherit" : "Home",
          effective.fade,
        );
      }
    });
  }

  function renderProfileCueCard(definition, fixtures, cue, editedTrigger) {
    const state = cue.profiles[definition.id];
    const countLabel = `${fixtures.length} LIGHT${fixtures.length === 1 ? "" : "S"}`;
    const { card, grid } = createCueCard(`ALL ${definition.shortName} LIGHTS`, countLabel, {
      profileGroup: true,
      clearDisabled: !programStateHasValues(state),
      onClear: () => {
        clearProgramState(state);
        markCueDirty(editedTrigger);
        renderCue();
      },
    });
    card.dataset.lightingProfileGroup = definition.id;
    parametersForEditor(definition).forEach((parameter) => {
      const label = document.createElement("span");
      const input = document.createElement("input");
      const fadeLabel = document.createElement("label");
      label.className = "lighting-parameter-label";
      label.textContent = parameter.label;
      input.className = "lighting-input lighting-parameter-input";
      input.type = "number";
      input.min = "0";
      input.max = "255";
      input.step = "1";
      input.inputMode = "numeric";
      input.dataset.lightingCueControl = "";
      input.dataset.profileType = definition.id;
      input.dataset.parameterKey = parameter.key;
      input.setAttribute("aria-label", `All ${definition.shortName} lights ${parameter.label} DMX value`);
      setProgramInputDisplay(input, state, parameter.key, "Blank");
      fadeLabel.className = "lighting-fade-label";
      if (parameter.fadeAllowed) {
        const checkbox = document.createElement("input");
        const text = document.createElement("span");
        checkbox.className = "lighting-fade-toggle";
        checkbox.type = "checkbox";
        checkbox.dataset.lightingCueControl = "";
        checkbox.dataset.profileType = definition.id;
        checkbox.dataset.parameterKey = parameter.key;
        checkbox.setAttribute("aria-label", `All ${definition.shortName} lights ${parameter.label} fade`);
        setFadeControlDisplay(checkbox, text, state, parameter.key, "Blank");
        checkbox.addEventListener("change", () => {
          setProgramFade(state, parameter.key, checkbox.checked);
          checkbox.setAttribute("aria-checked", String(checkbox.checked));
          syncInheritedProfileMembers(definition.id, parameter.key, cue);
          markCueDirty(editedTrigger);
        });
        fadeLabel.append(checkbox, text);
        input.addEventListener("input", () => {
          if (input.value === "") {
            clearProgramValue(state, parameter.key);
          } else {
            setProgramValue(
              state,
              parameter.key,
              Number(input.value),
              DEFAULT_FADE_KEYS.has(parameter.key),
            );
          }
          setProgramInputDisplay(input, state, parameter.key, "Blank");
          setFadeControlDisplay(checkbox, text, state, parameter.key, "Blank");
          syncInheritedProfileMembers(definition.id, parameter.key, cue);
          updateCardClearAvailability(card, state);
          markCueDirty(editedTrigger);
        });
      } else {
        fadeLabel.classList.add("is-snap-only");
        fadeLabel.textContent = "Snap";
        input.addEventListener("input", () => {
          if (input.value === "") {
            clearProgramValue(state, parameter.key);
          } else {
            setProgramValue(state, parameter.key, Number(input.value), false);
          }
          setProgramInputDisplay(input, state, parameter.key, "Blank");
          syncInheritedProfileMembers(definition.id, parameter.key, cue);
          updateCardClearAvailability(card, state);
          markCueDirty(editedTrigger);
        });
      }
      grid.append(label, input, fadeLabel);
    });
    dom.cueFixtures.append(card);
  }

  function renderFixtureCueCard(fixture, definition, cue, editedTrigger) {
    const state = cue.fixtures[fixture.id];
    const { card, grid } = createCueCard(fixture.name, definition.shortName, {
      clearDisabled: !programStateHasValues(state),
      onClear: () => {
        clearProgramState(state);
        markCueDirty(editedTrigger);
        renderCue();
      },
    });
    parametersForEditor(definition).forEach((parameter) => {
      const label = document.createElement("span");
      const input = document.createElement("input");
      const fadeLabel = document.createElement("label");
      label.className = "lighting-parameter-label";
      label.textContent = parameter.label;
      input.className = "lighting-input lighting-parameter-input";
      input.type = "number";
      input.min = "0";
      input.max = "255";
      input.step = "1";
      input.inputMode = "numeric";
      const effective = effectiveParameterState(cue, fixture, parameter.key);
      setProgramInputDisplay(
        input,
        state,
        parameter.key,
        effective.source === "profile" ? `Inherit ${effective.value}` : "Home 0",
      );
      input.setAttribute("aria-label", `${fixture.name} ${parameter.label} DMX value`);
      input.dataset.lightingCueControl = "";
      input.dataset.lightingProfileMemberValue = "";
      input.dataset.profileType = fixture.type;
      input.dataset.fixtureId = fixture.id;
      input.dataset.parameterKey = parameter.key;
      input.dataset.lightingField = `cues.${editedTrigger}.fixtures.${fixture.id}.values.${parameter.key}`;
      fadeLabel.className = "lighting-fade-label";
      if (parameter.fadeAllowed) {
        const checkbox = document.createElement("input");
        const text = document.createElement("span");
        checkbox.className = "lighting-fade-toggle";
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", `${fixture.name} ${parameter.label} fade`);
        checkbox.dataset.lightingCueControl = "";
        checkbox.dataset.lightingProfileMemberFade = "";
        checkbox.dataset.profileType = fixture.type;
        checkbox.dataset.fixtureId = fixture.id;
        checkbox.dataset.parameterKey = parameter.key;
        setFadeControlDisplay(
          checkbox,
          text,
          state,
          parameter.key,
          effective.source === "profile" ? "Inherit" : "Home",
          effective.fade,
        );
        checkbox.addEventListener("change", () => {
          setProgramFade(state, parameter.key, checkbox.checked);
          checkbox.setAttribute("aria-checked", String(checkbox.checked));
          markCueDirty(editedTrigger);
        });
        fadeLabel.append(checkbox, text);
        input.addEventListener("input", () => {
          const inherited = effectiveParameterState(cue, fixture, parameter.key);
          if (input.value === "") {
            clearProgramValue(state, parameter.key);
          } else {
            setProgramValue(state, parameter.key, Number(input.value), inherited.fade);
          }
          const nextEffective = effectiveParameterState(cue, fixture, parameter.key);
          setProgramInputDisplay(
            input,
            state,
            parameter.key,
            nextEffective.source === "profile" ? `Inherit ${nextEffective.value}` : "Home 0",
          );
          setFadeControlDisplay(
            checkbox,
            text,
            state,
            parameter.key,
            nextEffective.source === "profile" ? "Inherit" : "Home",
            nextEffective.fade,
          );
          updateCardClearAvailability(card, state);
          markCueDirty(editedTrigger);
        });
      } else {
        fadeLabel.classList.add("is-snap-only");
        fadeLabel.textContent = "Snap";
        input.addEventListener("input", () => {
          if (input.value === "") {
            clearProgramValue(state, parameter.key);
          } else {
            setProgramValue(state, parameter.key, Number(input.value), false);
          }
          const nextEffective = effectiveParameterState(cue, fixture, parameter.key);
          setProgramInputDisplay(
            input,
            state,
            parameter.key,
            nextEffective.source === "profile" ? `Inherit ${nextEffective.value}` : "Home 0",
          );
          updateCardClearAvailability(card, state);
          markCueDirty(editedTrigger);
        });
      }
      grid.append(label, input, fadeLabel);
    });
    dom.cueFixtures.append(card);
  }

  function renderCue() {
    if (!config || config.fixtures.length === 0) {
      return;
    }
    renderTriggerTabs();
    const editedTrigger = selectedTrigger;
    const cue = config.cues[editedTrigger];
    dom.fadeTime.value = String(cue.fadeMs / 1000);
    dom.fadeTime.dataset.lightingField = `cues.${editedTrigger}.fadeMs`;
    dom.fadeTime.dataset.lightingCueControl = "";
    dom.cueFixtures.textContent = "";
    const fixtureTypeOrder = Array.from(new Set(config.fixtures.map((fixture) => fixture.type)));
    const orderedDefinitions = [...definitions].sort((first, second) => {
      const firstIndex = fixtureTypeOrder.indexOf(first.id);
      const secondIndex = fixtureTypeOrder.indexOf(second.id);
      return (firstIndex === -1 ? definitions.length : firstIndex)
        - (secondIndex === -1 ? definitions.length : secondIndex);
    });
    orderedDefinitions.forEach((definition) => {
      const fixtures = config.fixtures.filter((candidate) => candidate.type === definition.id);
      renderProfileCueCard(definition, fixtures, cue, editedTrigger);
    });
    config.fixtures.forEach((fixture) => {
      renderFixtureCueCard(fixture, definitionFor(fixture.type), cue, editedTrigger);
    });
    updateControlAvailability();
  }

  function renderAll() {
    saving = true;
    dom.target.value = config.artnet.targetHost;
    dom.interfaceAddress.value = config.artnet.interfaceAddress;
    dom.portAddressBase.value = String(config.artnet.portAddressBase);
    dom.refreshHz.value = String(config.artnet.refreshHz);
    dom.oscTarget.value = config.osc.targetHost;
    dom.oscPort.value = String(config.osc.targetPort);
    renderFixtures();
    renderCue();
    renderOscMessages();
    saving = false;
    renderLightingEngine();
    renderOutputMode();
    updateControlAvailability();
  }

  function applyConfig(nextConfig, statusMessage = "LIGHTING LOADED") {
    config = cloneJson(nextConfig);
    dirty = false;
    configRevision += 1;
    pendingCueTriggers.clear();
    if (cueSyncTimerId !== null) {
      global.clearTimeout(cueSyncTimerId);
      cueSyncTimerId = null;
    }
    clearErrors();
    renderAll();
    setStatus(statusMessage, "success");
  }

  function updateControlAvailability() {
    if (!dom) {
      return;
    }
    document.querySelectorAll("[data-lighting-config-control]").forEach((node) => {
      node.disabled = !available || armed;
    });
    document.querySelectorAll("[data-lighting-cue-control]").forEach((node) => {
      node.disabled = !available || node.dataset.lightingProgrammingDisabled === "true";
    });
    [
      dom.target,
      dom.interfaceAddress,
      dom.portAddressBase,
      dom.refreshHz,
      dom.oscTarget,
      dom.oscPort,
    ].forEach((node) => {
      if (node) node.disabled = !available || armed;
    });
    dom.addFixture.disabled = !available || armed;
    dom.engineButtons.forEach((button) => {
      button.disabled = !available || armed;
    });
    const engineLabel = config && config.outputMode === "osc" ? "OSC" : "Lighting";
    dom.save.textContent = saving
      ? `Saving ${engineLabel}`
      : (dirty ? `Save ${engineLabel}` : `${engineLabel} Saved`);
    dom.save.disabled = !available || saving || !dirty;
    const canArmConfiguredEngine = Boolean(
      config
      && (
        (config.outputMode === "artnet" && config.fixtures.length > 0)
        || (config.outputMode === "osc" && hasMappedOscMessage())
      )
    );
    dom.arm.disabled = !available || armed || dirty || !canArmConfiguredEngine;
    dom.disarm.disabled = !available || !armed;
    document.querySelectorAll("[data-lighting-osc-test]").forEach((button) => {
      const trigger = button.dataset.lightingOscTest;
      button.disabled = (
        !available
        || !armed
        || dirty
        || saving
        || !config
        || config.outputMode !== "osc"
        || !config.osc.messages[trigger]
      );
    });
    renderLightingEngine();
    renderOutputMode();
  }

  function readStaticFields() {
    config.artnet.targetHost = dom.target.value;
    config.artnet.interfaceAddress = dom.interfaceAddress.value;
    config.artnet.portAddressBase = Number(dom.portAddressBase.value);
    config.artnet.refreshHz = Number(dom.refreshHz.value);
    config.osc.targetHost = dom.oscTarget.value;
    config.osc.targetPort = Number(dom.oscPort.value);
    config.cues[selectedTrigger].fadeMs = Math.round(Number(dom.fadeTime.value) * 1000);
  }

  async function loadDefinitionsAndConfig() {
    const [definitionPayload, nextConfig] = await Promise.all([
      requestJson("api/lighting/definitions"),
      requestJson("api/lighting/config"),
    ]);
    definitions = definitionPayload.fixtures;
    triggers = definitionPayload.triggers;
    oscTriggers = definitionPayload.oscTriggers;
    applyConfig(nextConfig);
  }

  async function persistConfig({ renderOnSuccess = true, statusMessage = null } = {}) {
    if (!available || !config) {
      return { saved: false, current: false };
    }
    readStaticFields();
    const snapshot = cloneJson(config);
    const snapshotRevision = configRevision;
    saving = true;
    setStatus("SAVING LIGHTING", "warning");
    updateControlAvailability();
    try {
      const payload = await requestJson("api/lighting/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const isCurrent = snapshotRevision === configRevision;
      if (isCurrent) {
        config = savedConfigForEditor(config, payload.config, renderOnSuccess);
        dirty = false;
        clearErrors();
        if (renderOnSuccess) {
          renderAll();
        }
        setStatus(
          statusMessage || (
            config.outputMode === "osc"
              ? (armed ? "OSC MESSAGES SAVED" : "OSC SAVED - READY TO ARM")
              : (armed ? "LIVE LIGHTING CHANGE SAVED" : "LIGHTING SAVED - READY TO ARM")
          ),
          "success",
        );
      }
      return { saved: true, current: isCurrent };
    } catch (error) {
      showErrors(error.payload && error.payload.fieldErrors, error.message);
      setStatus("LIGHTING SAVE FAILED", "error");
      return { saved: false, current: false };
    } finally {
      saving = false;
      updateControlAvailability();
    }
  }

  async function saveConfig() {
    if (!available || !config) {
      return;
    }
    if (armed && config.outputMode === "artnet") {
      pendingCueTriggers.add(selectedTrigger);
      await flushCueSync();
      return;
    }
    await persistConfig({ renderOnSuccess: true });
  }

  function applyRuntimeStatus(status) {
    armed = status && status.armed === true;
    if (!dirty) {
      if (status && status.lastError) {
        setStatus(status.lastError.toUpperCase(), "error");
      } else if (armed) {
        if (status.outputMode === "osc") {
          const cue = status.activeTrigger ? ` - ${status.activeTrigger.toUpperCase()}` : "";
          setStatus(`OSC ARMED${cue}`, "success");
        } else {
          const cue = status.activeTrigger ? ` - ${status.activeTrigger.toUpperCase()}` : " - HOME";
          setStatus(`ART-NET ARMED${cue}`, "success");
        }
      } else {
        setStatus("LIGHTING DISARMED", "warning");
      }
    }
    updateControlAvailability();
  }

  async function setArmed(nextArmed) {
    if (!available || dirty) {
      return;
    }
    const isOsc = config && config.outputMode === "osc";
    setStatus(
      nextArmed
        ? `ARMING ${isOsc ? "OSC" : "ART-NET"}`
        : (isOsc ? "DISARMING OSC" : "DISARMING AND BLACKING OUT"),
      "warning",
    );
    try {
      const payload = await requestJson("api/lighting/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ armed: nextArmed }),
      });
      applyRuntimeStatus(payload.status);
    } catch (error) {
      setStatus(error.message || "LIGHTING OUTPUT FAILED", "error");
    }
  }

  async function previewTrigger(trigger) {
    const knownEvent = config && (
      Object.hasOwn(config.cues, trigger)
      || Object.hasOwn(config.osc.messages, trigger)
    );
    if (!available || !armed || dirty || !knownEvent) {
      return false;
    }
    try {
      const payload = await requestJson("api/lighting/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger }),
      });
      applyRuntimeStatus(payload.lighting.runtime);
      return true;
    } catch (error) {
      setStatus(error.message || "LIGHTING PREVIEW FAILED", "error");
      return false;
    }
  }

  async function runPendingCueSync() {
    if (cueSyncPromise) {
      return cueSyncPromise;
    }
    cueSyncPromise = (async () => {
      while (pendingCueTriggers.size > 0) {
        const editedTriggers = new Set(pendingCueTriggers);
        pendingCueTriggers.clear();
        const result = await persistConfig({
          renderOnSuccess: false,
          statusMessage: outputMode === "blind"
            ? "BLIND LIGHTING CHANGE SAVED"
            : "LIVE LIGHTING CHANGE SAVED",
        });
        if (!result.saved) {
          break;
        }
        if (!result.current) {
          continue;
        }
        const outputTrigger = outputTriggerForMode(outputMode, selectedTrigger, activeGameTrigger);
        const shouldRecall = Array.from(editedTriggers).some((trigger) => (
          shouldRecallEditedTrigger(
            outputMode,
            trigger,
            selectedTrigger,
            activeGameTrigger,
          )
        ));
        if (armed && shouldRecall) {
          await previewTrigger(outputTrigger);
        }
      }
    })();
    try {
      await cueSyncPromise;
    } finally {
      cueSyncPromise = null;
    }
  }

  function scheduleCueSync(trigger) {
    if (!config || config.outputMode !== "artnet") {
      return;
    }
    pendingCueTriggers.add(trigger);
    if (cueSyncTimerId !== null) {
      global.clearTimeout(cueSyncTimerId);
    }
    cueSyncTimerId = global.setTimeout(() => {
      cueSyncTimerId = null;
      runPendingCueSync();
    }, CUE_SYNC_DEBOUNCE_MS);
  }

  async function flushCueSync() {
    if (cueSyncTimerId !== null) {
      global.clearTimeout(cueSyncTimerId);
      cueSyncTimerId = null;
    }
    await runPendingCueSync();
  }

  async function recallTriggerAfterSync(trigger) {
    if (!armed || !config || config.outputMode !== "artnet") {
      return;
    }
    await flushCueSync();
    const desiredTrigger = outputTriggerForMode(outputMode, selectedTrigger, activeGameTrigger);
    if (!dirty && trigger === desiredTrigger) {
      await previewTrigger(trigger);
    }
  }

  async function setOutputMode(nextMode) {
    const normalizedMode = normalizeOutputMode(nextMode);
    if (normalizedMode === outputMode) {
      return;
    }
    outputMode = normalizedMode;
    renderTriggerTabs();
    renderOutputMode();
    if (!armed || !config || config.outputMode !== "artnet") {
      return;
    }
    await flushCueSync();
    const outputTrigger = outputTriggerForMode(outputMode, selectedTrigger, activeGameTrigger);
    if (!dirty) {
      await previewTrigger(outputTrigger);
    }
  }

  function publishControlState(state) {
    if (!state || !Number.isInteger(state.revision)) {
      return;
    }
    if (typeof state.sessionId === "string" && state.sessionId !== controlSessionId) {
      controlSessionId = state.sessionId;
      lastControlRevision = -1;
    }
    if (state.revision <= lastControlRevision) {
      return;
    }
    lastControlRevision = state.revision;
    activeGameTrigger = state.currentStage || "stopAll";
    if (config && config.fixtures.length > 0) {
      renderTriggerTabs();
    }
    renderOutputMode();
    if (typeof onControlState === "function") {
      onControlState(state);
    }
  }

  async function pollControlState() {
    if (!available) {
      return;
    }
    try {
      publishControlState(await requestJson("api/control/state"));
    } catch (error) {
      // A temporary observer-poll failure must not interrupt local audio.
    }
  }

  function startControlEventStream() {
    if (!available || typeof global.EventSource !== "function" || controlEventSource) {
      return;
    }

    controlEventSource = new global.EventSource("api/control/events");
    controlEventSource.addEventListener("control", (event) => {
      try {
        publishControlState(JSON.parse(event.data));
      } catch (error) {
        // The regular control-state poll remains the fallback for malformed events.
      }
    });
  }

  async function pollRuntimeStatus() {
    if (!available) {
      return;
    }
    try {
      applyRuntimeStatus(await requestJson("api/lighting/status"));
    } catch (error) {
      if (!dirty) setStatus("LIGHTING STATUS UNAVAILABLE", "error");
    }
  }

  async function pollSharedConfig() {
    if (!available || dirty || saving) {
      return;
    }
    const requestRevision = configRevision;
    try {
      const nextConfig = await requestJson("api/lighting/config");
      if (!canApplySharedConfig({
        requestRevision,
        currentRevision: configRevision,
        isDirty: dirty,
        isSaving: saving,
      })) {
        return;
      }
      if (!configsEqual(config, nextConfig)) {
        applyConfig(nextConfig, "LIGHTING UPDATED FROM SERVER");
      }
    } catch (error) {
      // Preserve the last valid editor state during a temporary network failure.
    }
  }

  async function dispatchTrigger(trigger, auxiliaryTriggers = [], options = {}) {
    if (!available) {
      return null;
    }
    try {
      await flushCueSync();
      const requestPayload = buildControlTriggerPayload(trigger, auxiliaryTriggers, options);
      const payload = await requestJson("api/control/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      publishControlState(payload.state);
      if (payload.lighting && payload.lighting.runtime) {
        applyRuntimeStatus(payload.lighting.runtime);
      }
      return payload;
    } catch (error) {
      if (!dirty) setStatus(error.message || "LIGHTING TRIGGER FAILED", "error");
      return null;
    }
  }

  async function updateSettings(changes, options = {}) {
    if (!available) {
      throw new ApiError("The local Bluff server is unavailable.");
    }
    const payload = await requestJson("api/control/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes, initializeOnly: options.initializeOnly === true }),
    });
    publishControlState(payload.state);
    return payload;
  }

  function bindStaticFields() {
    [dom.target, dom.interfaceAddress, dom.portAddressBase, dom.refreshHz].forEach((input) => {
      input.dataset.lightingConfigControl = "";
      input.addEventListener("input", () => {
        readStaticFields();
        markDirty();
      });
    });
    dom.fadeTime.addEventListener("input", () => {
      const editedTrigger = selectedTrigger;
      config.cues[editedTrigger].fadeMs = Math.round(Number(dom.fadeTime.value) * 1000);
      markCueDirty(editedTrigger);
    });
    dom.addFixture.addEventListener("click", () => {
      if (!definitions.length) return;
      const randomPart = global.crypto && typeof global.crypto.randomUUID === "function"
        ? global.crypto.randomUUID().replaceAll("-", "").slice(0, 16)
        : `${Date.now()}${Math.floor(Math.random() * 100000)}`;
      config = addFixtureToConfig(config, definitions[0], `fixture-${randomPart}`);
      markDirty();
      renderAll();
    });
    dom.save.addEventListener("click", saveConfig);
    dom.arm.addEventListener("click", () => setArmed(true));
    dom.disarm.addEventListener("click", () => setArmed(false));
    dom.modeButtons.forEach((button) => {
      button.addEventListener("click", () => setOutputMode(button.dataset.lightingMode));
    });
    [dom.oscTarget, dom.oscPort].forEach((input) => {
      input.dataset.lightingConfigControl = "";
      input.addEventListener("input", () => {
        readStaticFields();
        markDirty();
      });
    });
    dom.engineButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (!config || armed) {
          return;
        }
        const nextEngine = normalizeLightingEngine(button.dataset.lightingEngine);
        if (nextEngine === config.outputMode) {
          return;
        }
        config.outputMode = nextEngine;
        markDirty();
        renderLightingEngine();
        updateControlAvailability();
      });
    });
  }

  async function initialize(options = {}) {
    dom = queryDom();
    onControlState = options.onControlState || null;
    onAvailabilityChange = options.onAvailabilityChange || null;
    if (!dom.fieldset) {
      return;
    }
    bindStaticFields();
    try {
      const health = await requestJson("api/health");
      if (!parseServerAvailability(health)) {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      await loadDefinitionsAndConfig();
      await Promise.all([pollControlState(), pollRuntimeStatus()]);
      startControlEventStream();
    } catch (error) {
      setAvailable(false);
      return;
    }
    configPollId = global.setInterval(pollSharedConfig, CONFIG_POLL_MS);
    controlPollId = global.setInterval(pollControlState, CONTROL_POLL_MS);
    statusPollId = global.setInterval(pollRuntimeStatus, STATUS_POLL_MS);
  }

  function onSettingsOpened() {
    renderOutputMode();
    if (available) {
      pollSharedConfig();
      pollRuntimeStatus();
    }
  }

  global.ProjectBluffLighting = {
    addFixtureToConfig,
    buildControlTriggerPayload,
    buildStageTriggers,
    canApplySharedConfig,
    clearProgramState,
    clearProgramValue,
    configsEqual,
    dispatchTrigger,
    effectiveParameterState,
    hasProgrammedValue,
    initialize,
    nextFixturePatch,
    nominationMixEnvelope,
    normalizeLightingEngine,
    normalizeOutputMode,
    onSettingsOpened,
    outputTriggerForMode,
    parametersForEditor,
    parseServerAvailability,
    programStateHasValues,
    removeFixtureFromConfig,
    savedConfigForEditor,
    setProgramFade,
    setProgramValue,
    shouldRecallEditedTrigger,
    updateSettings,
  };
}(window));
