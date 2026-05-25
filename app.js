const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const AUDIO_CACHE_NAME = "botc-soundtrack-v9";
const DECODE_WORK_UNITS = 2000000;
const RESUMABLE_LOOPS = new Set(["day"]);

const MEDIA_METADATA = {
  title: "Blood on the Clocktower",
  artist: "Project Bluff",
  album: "Soundtrack",
};

const SOUND_FILES = {
  bells: {
    label: "Bells",
    path: "sounds/BotC Bells.wav",
    bytes: 3054198,
  },
  gong: {
    label: "Gong",
    path: "sounds/BotC Gong.mp3",
    bytes: 310124,
  },
  setupLoop: {
    label: "Setup Loop",
    path: "sounds/BotC Setup Loop.mp3",
    bytes: 3466552,
  },
  day: {
    label: "Day Loop",
    path: "sounds/BotC Day Loop.mp3",
    bytes: 45254947,
  },
  crows: {
    label: "Crows",
    path: "sounds/BotC Crows.mp3",
    bytes: 585142,
  },
  maleScream: {
    label: "Male Scream",
    path: "sounds/BotC Male Scream.wav",
    bytes: 1686192,
  },
  femaleScream: {
    label: "Female Scream",
    path: "sounds/BotC Female Scream.wav",
    bytes: 1686192,
  },
  nightIntro: {
    label: "Night Intro",
    path: "sounds/BotC Night Intro.mp3",
    bytes: 316511,
  },
  nightLoop: {
    label: "Night Loop",
    path: "sounds/BotC Night Loop.mp3",
    bytes: 7556701,
  },
  nominations: {
    label: "Nominations Loop",
    path: "sounds/BotC Nominations Loop.mp3",
    bytes: 18616946,
  },
};

const VOLUME_STORAGE_KEY = "project-bluff-volume-settings-v1";
const CUE_TIMER_UPDATE_MS = 250;
const VOLUME_DEFAULTS_VERSION = 2;

const STAGES = {
  setup: "SETUP",
  day: "DAY",
  nominations: "NOMINATIONS",
  night: "NIGHT",
};

const LOOP_CONFIG = {
  setup: {
    file: "setupLoop",
    offset: 0,
    loopStart: 28.369,
  },
  day: {
    file: "day",
    offset: 0,
  },
  nominations: {
    file: "nominations",
    offset: 0.155,
    loopStart: 0.155,
    loopEnd: 463.455,
  },
  night: {
    file: "nightLoop",
    offset: 4.907,
    loopStart: 39.272,
    loopEnd: 228.104,
    fadeIn: 2,
  },
};

const DEFAULT_TRACK_VOLUMES = {
  setupLoop: 0.67,
  day: 0.5,
  maleScream: 0.33,
  femaleScream: 0.33,
};

const PREVIOUS_DEFAULT_TRACK_VOLUMES = {
  setupLoop: 0.5,
  day: 0.5,
};

const ONE_SHOTS = {
  bells: {
    file: "bells",
    offset: 0,
  },
  gong: {
    file: "gong",
    offset: 0,
  },
  nightIntro: {
    file: "nightIntro",
    offset: 1.347,
  },
  crows: {
    file: "crows",
    offset: 0,
  },
  maleScream: {
    file: "maleScream",
    offset: 0,
  },
  femaleScream: {
    file: "femaleScream",
    offset: 0,
  },
};

const FADE = {
  stage: 3,
  stopAll: 1.25,
};

const dom = {
  masterVolumeSlider: document.querySelector('[data-volume-slider="master"]'),
  masterVolumeValue: document.querySelector('[data-volume-value="master"]'),
  stageButtons: Array.from(document.querySelectorAll("[data-stage]")),
  stageTimers: Array.from(document.querySelectorAll("[data-stage-timer]")),
  stopButton: document.querySelector("[data-stop]"),
  status: document.querySelector("[data-status]"),
  activeStage: document.querySelector("[data-active-stage]"),
  preloadProgress: document.querySelector("[data-preload-progress]"),
  preloadProgressFill: document.querySelector("[data-preload-progress-fill]"),
  settingsOpen: document.querySelector("[data-settings-open]"),
  settingsClose: document.querySelector("[data-settings-close]"),
  settingsModal: document.querySelector("[data-settings-modal]"),
  trackVolumeList: document.querySelector("[data-track-volume-list]"),
  loopProgressToggle: document.querySelector("[data-loop-progress-toggle]"),
  loopMeters: Array.from(document.querySelectorAll("[data-loop-meter]")),
  murderSoundButtons: Array.from(document.querySelectorAll("[data-murder-sound]")),
  murderConfirmationModal: document.querySelector("[data-murder-confirmation-modal]"),
  murderConfirmationChoices: Array.from(document.querySelectorAll("[data-murder-confirmation-choice]")),
};

const loopMeterFills = new Map(
  dom.loopMeters
    .map((meter) => [meter.dataset.loopMeter, meter.querySelector("[data-loop-meter-fill]")])
    .filter((entry) => entry[0] && entry[1]),
);

let audioContext = null;
let masterGain = null;
let loadPromise = null;
let buffers = {};
let currentStage = null;
let currentCueId = 0;
let controlsBusy = false;
let audioSessionWarningShown = false;
let activeCueStartedAt = null;
let activeCueTimerIntervalId = null;

const activeLoops = new Map();
const activeOneShots = new Set();
const cueTimers = new Set();
const stopTimers = new WeakMap();
const loopResumeOffsets = {
  day: 0,
};

const volumeSettings = loadVolumeSettings();

const preloadProgress = {
  decoded: 0,
  downloaded: {},
  total: Object.values(SOUND_FILES).reduce((sum, file) => sum + file.bytes, 0)
    + Object.keys(SOUND_FILES).length * DECODE_WORK_UNITS,
};

let focusedBeforeSettings = null;
let focusedBeforeMurderConfirmation = null;
let loopProgressFrameId = null;
let pendingMurderConfirmation = null;

const murderSoundState = {
  crows: false,
  maleScream: false,
  femaleScream: false,
};

function getDefaultTrackVolume(fileKey) {
  return DEFAULT_TRACK_VOLUMES[fileKey] ?? 1;
}

function getPreviousDefaultTrackVolume(fileKey) {
  return PREVIOUS_DEFAULT_TRACK_VOLUMES[fileKey] ?? 1;
}

function volumesMatch(first, second) {
  return Math.abs(first - second) < 0.001;
}

function createDefaultVolumeSettings() {
  const tracks = {};

  Object.keys(SOUND_FILES).forEach((fileKey) => {
    tracks[fileKey] = getDefaultTrackVolume(fileKey);
  });

  return {
    master: 0.8,
    showLoopProgress: false,
    defaultTrackVolumesVersion: VOLUME_DEFAULTS_VERSION,
    tracks,
  };
}

function clampVolume(value, fallback = 1) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, number));
}

function loadVolumeSettings() {
  const defaults = createDefaultVolumeSettings();
  const settings = {
    master: defaults.master,
    showLoopProgress: defaults.showLoopProgress,
    defaultTrackVolumesVersion: defaults.defaultTrackVolumesVersion,
    tracks: { ...defaults.tracks },
  };

  try {
    const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);

    if (!stored) {
      return settings;
    }

    const parsed = JSON.parse(stored);

    if (!parsed || typeof parsed !== "object") {
      return settings;
    }

    settings.master = clampVolume(parsed.master, defaults.master);
    settings.showLoopProgress = parsed.showLoopProgress === true;

    if (parsed.tracks && typeof parsed.tracks === "object") {
      const shouldMigrateDefaultTracks = parsed.defaultTrackVolumesVersion !== VOLUME_DEFAULTS_VERSION;

      Object.keys(SOUND_FILES).forEach((fileKey) => {
        const parsedVolume = clampVolume(parsed.tracks[fileKey], defaults.tracks[fileKey]);
        const previousDefault = getPreviousDefaultTrackVolume(fileKey);
        settings.tracks[fileKey] = shouldMigrateDefaultTracks && volumesMatch(parsedVolume, previousDefault)
          ? defaults.tracks[fileKey]
          : parsedVolume;
      });
    }
  } catch (error) {
    console.warn("Could not load saved volume settings.", error);
  }

  return settings;
}

function saveVolumeSettings() {
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(volumeSettings));
  } catch (error) {
    console.warn("Could not save volume settings.", error);
  }
}

function volumeToPercent(value) {
  return Math.round(clampVolume(value, 0) * 100);
}

function percentToVolume(value) {
  return clampVolume(Number(value) / 100, 1);
}

function setVolumeControlUi(slider, valueNode, volume) {
  const percent = volumeToPercent(volume);

  if (slider) {
    slider.value = String(percent);
    slider.setAttribute("aria-valuetext", `${percent}%`);
  }

  if (valueNode) {
    valueNode.textContent = `${percent}%`;
  }
}

function getTrackVolume(fileKey) {
  const fallback = getDefaultTrackVolume(fileKey);
  return clampVolume(volumeSettings.tracks[fileKey], fallback);
}

function getTrackTargetGain(track) {
  return getTrackVolume(track.fileKey || track.id);
}

function applyMasterVolume() {
  if (!audioContext || !masterGain) {
    return;
  }

  const now = audioContext.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(volumeSettings.master, now);
}

function setMasterVolume(volume, shouldSave = true) {
  volumeSettings.master = clampVolume(volume, 0.8);
  setVolumeControlUi(dom.masterVolumeSlider, dom.masterVolumeValue, volumeSettings.master);
  applyMasterVolume();

  if (shouldSave) {
    saveVolumeSettings();
  }
}

function updateActiveTrackVolume(track, atTime = audioContext.currentTime) {
  if (!audioContext || !track || track.stopping) {
    return;
  }

  const targetGain = getTrackTargetGain(track);
  const currentGain = getTrackGainValue(track, atTime);
  const activeRamp = track.gainRamp && track.gainRamp.endTime > atTime && track.gainRamp.endValue > 0;

  if (!activeRamp) {
    setTrackGain(track, targetGain, atTime);
    return;
  }

  const endTime = track.gainRamp.endTime;
  track.gainRamp = {
    startTime: atTime,
    startValue: currentGain,
    endTime,
    endValue: targetGain,
  };
  track.gain.gain.cancelScheduledValues(atTime);
  track.gain.gain.setValueAtTime(currentGain, atTime);
  track.gain.gain.linearRampToValueAtTime(targetGain, endTime);
}

function applyTrackVolumeToActive(fileKey) {
  if (!audioContext) {
    return;
  }

  const now = audioContext.currentTime;

  activeLoops.forEach((track) => {
    if (track.fileKey === fileKey) {
      updateActiveTrackVolume(track, now);
    }
  });

  activeOneShots.forEach((track) => {
    if (track.fileKey === fileKey) {
      updateActiveTrackVolume(track, now);
    }
  });
}

function setTrackVolume(fileKey, volume, shouldSave = true) {
  if (!SOUND_FILES[fileKey]) {
    return;
  }

  volumeSettings.tracks[fileKey] = clampVolume(volume, getDefaultTrackVolume(fileKey));

  const slider = dom.trackVolumeList.querySelector(`[data-track-volume="${fileKey}"]`);
  const valueNode = dom.trackVolumeList.querySelector(`[data-track-volume-value="${fileKey}"]`);
  setVolumeControlUi(slider, valueNode, volumeSettings.tracks[fileKey]);
  applyTrackVolumeToActive(fileKey);

  if (shouldSave) {
    saveVolumeSettings();
  }
}

function setLoopProgressEnabled(isEnabled, shouldSave = true) {
  volumeSettings.showLoopProgress = isEnabled === true;
  document.body.classList.toggle("loop-progress-enabled", volumeSettings.showLoopProgress);

  if (dom.loopProgressToggle) {
    dom.loopProgressToggle.checked = volumeSettings.showLoopProgress;
  }

  if (volumeSettings.showLoopProgress) {
    updateLoopMeters();
  } else {
    stopLoopMeterUpdates();
    resetAllLoopMeters();
  }

  if (shouldSave) {
    saveVolumeSettings();
  }
}

function renderTrackVolumeSettings() {
  dom.trackVolumeList.textContent = "";

  Object.entries(SOUND_FILES).forEach(([fileKey, file]) => {
    const label = document.createElement("label");
    const name = document.createElement("span");
    const slider = document.createElement("input");
    const value = document.createElement("span");

    label.className = "volume-control track-volume-control";
    name.className = "volume-control-label";
    name.textContent = file.label;

    slider.className = "volume-slider";
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.dataset.trackVolume = fileKey;
    slider.setAttribute("aria-label", `${file.label} volume`);

    value.className = "volume-value";
    value.dataset.trackVolumeValue = fileKey;

    slider.addEventListener("input", () => {
      setTrackVolume(fileKey, percentToVolume(slider.value));
    });

    label.append(name, slider, value);
    dom.trackVolumeList.append(label);
    setVolumeControlUi(slider, value, getTrackVolume(fileKey));
  });
}

function openSettings() {
  focusedBeforeSettings = document.activeElement;
  dom.settingsModal.hidden = false;
  document.body.classList.add("settings-open");
  dom.settingsClose.focus();
}

function closeSettings() {
  dom.settingsModal.hidden = true;
  document.body.classList.remove("settings-open");

  if (focusedBeforeSettings && typeof focusedBeforeSettings.focus === "function") {
    focusedBeforeSettings.focus();
  }
}

function setMurderSoundButtonStates() {
  dom.murderSoundButtons.forEach((button) => {
    const soundId = button.dataset.murderSound;
    button.setAttribute("aria-pressed", String(murderSoundState[soundId] === true));
  });
}

function resetMurderSounds() {
  murderSoundState.crows = false;
  murderSoundState.maleScream = false;
  murderSoundState.femaleScream = false;
  setMurderSoundButtonStates();
}

function toggleMurderSound(soundId) {
  if (controlsBusy) {
    return;
  }

  if (soundId === "crows") {
    if (murderSoundState.crows) {
      resetMurderSounds();
      setStatus("Murder sounds cleared.");
    } else {
      setStatus("Choose a scream to arm crows.");
    }

    return;
  }

  if (soundId !== "maleScream" && soundId !== "femaleScream") {
    return;
  }

  murderSoundState[soundId] = !murderSoundState[soundId];

  if (murderSoundState.maleScream || murderSoundState.femaleScream) {
    murderSoundState.crows = true;
  } else {
    murderSoundState.crows = false;
  }

  setMurderSoundButtonStates();
}

function getArmedMurderCue() {
  const maleScream = murderSoundState.maleScream === true;
  const femaleScream = murderSoundState.femaleScream === true;

  if (!maleScream && !femaleScream) {
    return null;
  }

  return {
    crows: true,
    maleScream,
    femaleScream,
  };
}

function getMurderCueFromConfirmation(choice) {
  if (choice === "both") {
    return {
      crows: true,
      maleScream: true,
      femaleScream: true,
    };
  }

  if (choice === "male") {
    return {
      crows: true,
      maleScream: true,
      femaleScream: false,
    };
  }

  if (choice === "female") {
    return {
      crows: true,
      maleScream: false,
      femaleScream: true,
    };
  }

  return false;
}

function closeMurderConfirmation(choice) {
  if (!pendingMurderConfirmation) {
    return;
  }

  const resolve = pendingMurderConfirmation;
  pendingMurderConfirmation = null;
  dom.murderConfirmationModal.hidden = true;
  document.body.classList.remove("murder-confirmation-open");

  if (
    focusedBeforeMurderConfirmation
    && typeof focusedBeforeMurderConfirmation.focus === "function"
  ) {
    focusedBeforeMurderConfirmation.focus();
  }

  resolve(choice);
}

function showMurderConfirmation() {
  focusedBeforeMurderConfirmation = document.activeElement;
  dom.murderConfirmationModal.hidden = false;
  document.body.classList.add("murder-confirmation-open");

  const primaryChoice = dom.murderConfirmationChoices.find(
    (button) => button.dataset.murderConfirmationChoice === "both",
  );

  if (primaryChoice) {
    primaryChoice.focus();
  }

  return new Promise((resolve) => {
    pendingMurderConfirmation = resolve;
  });
}

async function resolveMurderCueForStage(stage) {
  if (stage !== "day") {
    return null;
  }

  const armedCue = getArmedMurderCue();

  if (!armedCue) {
    return null;
  }

  if (armedCue.maleScream && armedCue.femaleScream) {
    const choice = await showMurderConfirmation();
    return getMurderCueFromConfirmation(choice);
  }

  return armedCue;
}

function playMurderCue(murderCue) {
  if (!murderCue) {
    return;
  }

  if (murderCue.crows) {
    playOneShot("crows");
  }

  if (murderCue.maleScream) {
    playOneShot("maleScream");
  }

  if (murderCue.femaleScream) {
    playOneShot("femaleScream");
  }
}

function initializeMurderSoundUi() {
  setMurderSoundButtonStates();

  dom.murderSoundButtons.forEach((button) => {
    button.addEventListener("click", () => {
      toggleMurderSound(button.dataset.murderSound);
    });
  });

  dom.murderConfirmationChoices.forEach((button) => {
    button.addEventListener("click", () => {
      closeMurderConfirmation(button.dataset.murderConfirmationChoice);
    });
  });
}

function initializeVolumeUi() {
  setMasterVolume(volumeSettings.master, false);
  setLoopProgressEnabled(volumeSettings.showLoopProgress, false);
  renderTrackVolumeSettings();

  dom.masterVolumeSlider.addEventListener("input", () => {
    setMasterVolume(percentToVolume(dom.masterVolumeSlider.value));
  });

  if (dom.loopProgressToggle) {
    dom.loopProgressToggle.addEventListener("change", () => {
      setLoopProgressEnabled(dom.loopProgressToggle.checked);
    });
  }

  dom.settingsOpen.addEventListener("click", openSettings);
  dom.settingsClose.addEventListener("click", closeSettings);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (!dom.murderConfirmationModal.hidden) {
      closeMurderConfirmation("cancel");
      return;
    }

    if (!dom.settingsModal.hidden) {
      closeSettings();
    }
  });
}

function setStatus(message) {
  dom.status.textContent = message;
}

function setPreloadProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));

  dom.preloadProgressFill.style.width = `${safePercent}%`;
  dom.preloadProgress.setAttribute("aria-valuenow", String(safePercent));
}

function setPreloadProgressVisible(isVisible) {
  dom.preloadProgress.hidden = !isVisible;
}

function updatePreloadProgress(label) {
  const downloaded = Object.values(preloadProgress.downloaded).reduce((sum, value) => sum + value, 0);
  const loaded = downloaded + preloadProgress.decoded;
  const percent = preloadProgress.total > 0 ? (loaded / preloadProgress.total) * 100 : 0;
  const rounded = Math.max(0, Math.min(100, Math.round(percent)));

  setPreloadProgress(rounded);

  if (label && rounded < 100) {
    setStatus(`${label} ${rounded}%`);
  }
}

function resetPreloadProgress() {
  preloadProgress.decoded = 0;
  preloadProgress.downloaded = {};
  setPreloadProgressVisible(true);
  setPreloadProgress(0);
}

function setControlsBusy(isBusy) {
  controlsBusy = isBusy;
  dom.stageButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  dom.murderSoundButtons.forEach((button) => {
    button.disabled = isBusy;
  });
}

function formatCueElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clearCueTimersDisplay() {
  dom.stageTimers.forEach((node) => {
    node.textContent = "";
    node.removeAttribute("aria-label");
  });
}

function updateCueTimersDisplay() {
  if (!currentStage || activeCueStartedAt === null) {
    clearCueTimersDisplay();
    return;
  }

  const elapsedLabel = formatCueElapsed(performance.now() - activeCueStartedAt);

  dom.stageTimers.forEach((node) => {
    const isActive = node.dataset.stageTimer === currentStage;
    node.textContent = isActive ? elapsedLabel : "";

    if (isActive) {
      node.setAttribute("aria-label", `${elapsedLabel} in ${STAGES[currentStage]} cue`);
    } else {
      node.removeAttribute("aria-label");
    }
  });
}

function startActiveCueTimer() {
  activeCueStartedAt = performance.now();
  updateCueTimersDisplay();

  if (activeCueTimerIntervalId === null) {
    activeCueTimerIntervalId = window.setInterval(updateCueTimersDisplay, CUE_TIMER_UPDATE_MS);
  }
}

function stopActiveCueTimer() {
  activeCueStartedAt = null;

  if (activeCueTimerIntervalId !== null) {
    window.clearInterval(activeCueTimerIntervalId);
    activeCueTimerIntervalId = null;
  }

  clearCueTimersDisplay();
}

function setCurrentStage(stage) {
  currentStage = stage;
  dom.activeStage.textContent = stage ? STAGES[stage] : "Idle";

  dom.stageButtons.forEach((button) => {
    const isActive = button.dataset.stage === stage;
    button.setAttribute("aria-pressed", String(isActive));
  });

  if (stage) {
    startActiveCueTimer();
  } else {
    stopActiveCueTimer();
  }
}

function setLoopMeterProgress(id, progress) {
  const fill = loopMeterFills.get(id);

  if (!fill) {
    return;
  }

  const safeProgress = Math.max(0, Math.min(1, progress));
  fill.style.transform = `scaleX(${safeProgress})`;
}

function resetLoopMeter(id) {
  setLoopMeterProgress(id, 0);
}

function resetAllLoopMeters() {
  loopMeterFills.forEach((_, id) => {
    resetLoopMeter(id);
  });
}

function getLoopProgress(track, atTime = audioContext.currentTime) {
  const loopLength = track.loopEnd - track.loopStart;

  if (loopLength <= 0) {
    return 0;
  }

  const elapsed = Math.max(0, atTime - track.startedAt);
  const rawPosition = track.startOffset + elapsed;

  if (rawPosition < track.loopStart) {
    return 0;
  }

  return (((rawPosition - track.loopStart) % loopLength) + loopLength) % loopLength / loopLength;
}

function updateLoopMeters() {
  if (!volumeSettings.showLoopProgress || !audioContext || activeLoops.size === 0) {
    loopProgressFrameId = null;
    resetAllLoopMeters();
    return;
  }

  const activeIds = new Set();
  const now = audioContext.currentTime;

  activeLoops.forEach((track, id) => {
    activeIds.add(id);
    setLoopMeterProgress(id, getLoopProgress(track, now));
  });

  loopMeterFills.forEach((_, id) => {
    if (!activeIds.has(id)) {
      resetLoopMeter(id);
    }
  });

  if (typeof window.requestAnimationFrame === "function") {
    loopProgressFrameId = window.requestAnimationFrame(updateLoopMeters);
  }
}

function startLoopMeterUpdates() {
  if (
    !volumeSettings.showLoopProgress
    || loopProgressFrameId !== null
    || typeof window.requestAnimationFrame !== "function"
  ) {
    return;
  }

  loopProgressFrameId = window.requestAnimationFrame(updateLoopMeters);
}

function stopLoopMeterUpdates() {
  if (loopProgressFrameId !== null && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(loopProgressFrameId);
  }

  loopProgressFrameId = null;
}

function stopLoopMeterUpdatesIfIdle() {
  if (activeLoops.size > 0) {
    return;
  }

  stopLoopMeterUpdates();
  resetAllLoopMeters();
}

function enableStopButton() {
  dom.stopButton.disabled = false;
  dom.stopButton.style.cursor = "pointer";
}

function configurePlaybackSession() {
  if (typeof navigator === "undefined") {
    return;
  }

  if ("audioSession" in navigator) {
    try {
      navigator.audioSession.type = "playback";
    } catch (error) {
      if (!audioSessionWarningShown) {
        console.warn("Could not set audio session type to playback.", error);
        audioSessionWarningShown = true;
      }
    }
  }

  if ("mediaSession" in navigator) {
    if (window.MediaMetadata && !navigator.mediaSession.metadata) {
      navigator.mediaSession.metadata = new window.MediaMetadata(MEDIA_METADATA);
    }

    navigator.mediaSession.playbackState = currentStage ? "playing" : "none";
  }
}

function setMediaPlaybackState(state) {
  if (typeof navigator === "undefined") {
    return;
  }

  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = state;
  }
}

function makeAudioContext() {
  if (!AudioContextClass) {
    throw new Error("This browser does not support the Web Audio API.");
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = volumeSettings.master;
    masterGain.connect(audioContext.destination);
  }

  return audioContext;
}

function queueBufferLoad() {
  if (!loadPromise) {
    loadPromise = loadBuffers().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }

  return loadPromise;
}

async function preloadAudio() {
  setControlsBusy(true);
  clearCueTimersDisplay();
  resetPreloadProgress();
  setStatus("Preloading audio files...");

  try {
    configurePlaybackSession();
    makeAudioContext();
    await queueBufferLoad();
    setCurrentStage(null);
    setPreloadProgress(100);
    setPreloadProgressVisible(false);
    setStatus("Audio ready. Tap a stage.");
  } catch (error) {
    console.error(error);
    clearCueTimersDisplay();
    setStatus(error.message || "Audio preload failed. Tap a stage to retry.");
  } finally {
    if (AudioContextClass) {
      setControlsBusy(false);
    }
  }
}

async function ensureAudioReady() {
  configurePlaybackSession();
  const context = makeAudioContext();

  await queueBufferLoad();

  if (context.state === "suspended") {
    await context.resume();
  }
}

async function loadBuffers() {
  const entries = Object.entries(SOUND_FILES);
  const decoded = {};

  for (const [key, file] of entries) {
    const arrayBuffer = await loadAudioArrayBuffer(key, file);
    decoded[key] = await audioContext.decodeAudioData(arrayBuffer);
    preloadProgress.decoded += DECODE_WORK_UNITS;
    updatePreloadProgress(`Decoded ${file.label}.`);
  }

  buffers = decoded;
}

async function loadAudioArrayBuffer(key, file) {
  const request = new Request(new URL(file.path, window.location.href));
  const response = await getAudioResponse(request, file);

  if (!response.ok) {
    throw new Error(`Could not load ${file.path}: ${response.status}`);
  }

  return readResponseWithProgress(key, file, response);
}

async function getAudioResponse(request, file) {
  if (!("caches" in window)) {
    return fetch(request);
  }

  const cache = await caches.open(AUDIO_CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok) {
    cache.put(request, response.clone()).catch((error) => {
      console.warn(`Could not cache ${file.path}`, error);
    });
  }

  return response;
}

async function readResponseWithProgress(key, file, response) {
  const reader = response.body ? response.body.getReader() : null;
  const expectedBytes = Number(response.headers.get("content-length")) || file.bytes;

  preloadProgress.downloaded[key] = 0;
  updatePreloadProgress(`Preloading ${file.label}...`);

  if (!reader) {
    const arrayBuffer = await response.arrayBuffer();
    preloadProgress.downloaded[key] = expectedBytes;
    updatePreloadProgress(`Preloading ${file.label}...`);
    return arrayBuffer;
  }

  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    received += value.byteLength;
    preloadProgress.downloaded[key] = Math.min(received, expectedBytes);
    updatePreloadProgress(`Preloading ${file.label}...`);
  }

  preloadProgress.downloaded[key] = expectedBytes;
  updatePreloadProgress(`Preloading ${file.label}...`);

  const bytes = new Uint8Array(received);
  let offset = 0;

  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return bytes.buffer;
}

function clearCueTimers() {
  cueTimers.forEach((timerId) => window.clearTimeout(timerId));
  cueTimers.clear();
}

function scheduleCueTask(cueId, delaySeconds, callback) {
  const timerId = window.setTimeout(() => {
    cueTimers.delete(timerId);

    if (cueId !== currentCueId) {
      return;
    }

    callback();
  }, delaySeconds * 1000);

  cueTimers.add(timerId);
}

function clampTime(value, buffer, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(value, buffer.duration));
}

function getLoopBounds(config, buffer) {
  const configuredStart = clampTime(config.loopStart, buffer, 0);
  const configuredEnd = clampTime(config.loopEnd, buffer, buffer.duration);

  if (configuredEnd > configuredStart) {
    return {
      loopStart: configuredStart,
      loopEnd: configuredEnd,
    };
  }

  return {
    loopStart: 0,
    loopEnd: buffer.duration,
  };
}

function normalizeLoopOffset(offset, loopStart, loopEnd) {
  const loopLength = loopEnd - loopStart;

  if (loopLength <= 0) {
    return loopStart;
  }

  if (offset < loopStart || offset >= loopEnd) {
    return loopStart + ((((offset - loopStart) % loopLength) + loopLength) % loopLength);
  }

  return offset;
}

function connectSource(source, gain) {
  source.connect(gain);
  gain.connect(masterGain);
}

function getTrackLoopPosition(track, atTime = audioContext.currentTime) {
  const elapsed = Math.max(0, atTime - track.startedAt);
  return normalizeLoopOffset(
    track.startOffset + elapsed,
    track.loopStart,
    track.loopEnd,
  );
}

function rememberLoopPosition(track, atTime = audioContext.currentTime) {
  if (!RESUMABLE_LOOPS.has(track.id)) {
    return;
  }

  loopResumeOffsets[track.id] = getTrackLoopPosition(track, atTime);
}

function getTrackGainValue(track, atTime = audioContext.currentTime) {
  if (!track.gainRamp) {
    return track.gain.gain.value;
  }

  const { startTime, startValue, endTime, endValue } = track.gainRamp;

  if (atTime <= startTime) {
    return startValue;
  }

  if (atTime >= endTime) {
    return endValue;
  }

  const progress = (atTime - startTime) / (endTime - startTime);
  return startValue + (endValue - startValue) * progress;
}

function setTrackGain(track, value, atTime = audioContext.currentTime) {
  track.gainRamp = {
    startTime: atTime,
    startValue: value,
    endTime: atTime,
    endValue: value,
  };
  track.gain.gain.cancelScheduledValues(atTime);
  track.gain.gain.setValueAtTime(value, atTime);
}

function rampTrackGain(track, endValue, duration, atTime = audioContext.currentTime) {
  const startValue = getTrackGainValue(track, atTime);

  track.gainRamp = {
    startTime: atTime,
    startValue,
    endTime: atTime + duration,
    endValue,
  };
  track.gain.gain.cancelScheduledValues(atTime);
  track.gain.gain.setValueAtTime(startValue, atTime);
  track.gain.gain.linearRampToValueAtTime(endValue, atTime + duration);
}

function playOneShot(id) {
  const config = ONE_SHOTS[id];
  const buffer = buffers[config.file];
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const offset = clampTime(config.offset, buffer, 0);
  const duration = Math.max(0, buffer.duration - offset);
  const track = { id, fileKey: config.file, source, gain, type: "oneShot" };

  source.buffer = buffer;
  connectSource(source, gain);
  setTrackGain(track, getTrackTargetGain(track));

  source.addEventListener("ended", () => {
    activeOneShots.delete(track);
    clearStopTimer(track);
  });

  activeOneShots.add(track);
  source.start(audioContext.currentTime, offset, duration);
  return track;
}

function startLoop(id, options = {}) {
  const config = { ...LOOP_CONFIG[id], ...options };
  const buffer = buffers[config.file];

  stopLoopNow(id);

  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  const fadeIn = config.fadeIn || 0;
  const { loopStart, loopEnd } = getLoopBounds(config, buffer);
  const configuredOffset = RESUMABLE_LOOPS.has(id) ? loopResumeOffsets[id] : config.offset;
  const clampedOffset = clampTime(configuredOffset, buffer, loopStart);
  const startOffset = RESUMABLE_LOOPS.has(id)
    ? normalizeLoopOffset(clampedOffset, loopStart, loopEnd)
    : clampedOffset;
  const track = {
    id,
    fileKey: config.file,
    source,
    gain,
    type: "loop",
    startedAt: now,
    startOffset,
    loopStart,
    loopEnd,
  };

  source.buffer = buffer;
  source.loop = true;
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;

  connectSource(source, gain);

  if (fadeIn > 0) {
    setTrackGain(track, 0, now);
    rampTrackGain(track, getTrackTargetGain(track), fadeIn, now);
  } else {
    setTrackGain(track, getTrackTargetGain(track), now);
  }

  source.addEventListener("ended", () => {
    if (activeLoops.get(id) === track) {
      activeLoops.delete(id);
      resetLoopMeter(id);
      stopLoopMeterUpdatesIfIdle();
    }

    clearStopTimer(track);
  });

  activeLoops.set(id, track);
  setLoopMeterProgress(id, getLoopProgress(track, now));
  startLoopMeterUpdates();
  source.start(now, startOffset);
  return track;
}

function clearStopTimer(track) {
  const timerId = stopTimers.get(track);

  if (timerId) {
    window.clearTimeout(timerId);
    stopTimers.delete(track);
  }
}

function scheduleStop(track, duration) {
  clearStopTimer(track);

  const stopAt = audioContext.currentTime + duration;
  const timerId = window.setTimeout(() => {
    stopSource(track, stopAt);
  }, duration * 1000 + 80);

  stopTimers.set(track, timerId);
}

function fadeOutTrack(track, duration = FADE.stage) {
  if (!track || track.stopping) {
    return;
  }

  const now = audioContext.currentTime;
  track.stopping = true;
  rampTrackGain(track, 0, duration, now);
  scheduleStop(track, duration);
}

function fadeOutLoop(id, duration = FADE.stage) {
  fadeOutTrack(activeLoops.get(id), duration);
}

function fadeOutOtherLoops(keepIds, duration = FADE.stage) {
  activeLoops.forEach((track, id) => {
    if (!keepIds.includes(id)) {
      fadeOutTrack(track, duration);
    }
  });
}

function fadeOutOneShots(duration = 0.75) {
  activeOneShots.forEach((track) => fadeOutTrack(track, duration));
}

function stopSource(track, atTime = audioContext.currentTime) {
  clearStopTimer(track);
  rememberLoopPosition(track, atTime);

  try {
    track.source.stop();
  } catch (error) {
    // Already stopped sources can throw in some browsers.
  }

  if (track.type === "loop" && activeLoops.get(track.id) === track) {
    activeLoops.delete(track.id);
    resetLoopMeter(track.id);
    stopLoopMeterUpdatesIfIdle();
  }

  if (track.type === "oneShot") {
    activeOneShots.delete(track);
  }
}

function stopLoopNow(id) {
  const track = activeLoops.get(id);

  if (track) {
    stopSource(track);
  }
}

function beginCue(stage) {
  currentCueId += 1;
  clearCueTimers();
  fadeOutOneShots();
  setCurrentStage(stage);
  configurePlaybackSession();
  setMediaPlaybackState("playing");
  enableStopButton();
  return currentCueId;
}

function runDayCue(murderCue = null) {
  const cueId = beginCue("day");

  playOneShot("bells");
  playMurderCue(murderCue);
  if (murderCue) {
    resetMurderSounds();
  }

  fadeOutOtherLoops(["day", "night"]);

  scheduleCueTask(cueId, 1, () => {
    fadeOutLoop("night", FADE.stage);
    startLoop("day", { fadeIn: 3 });
  });

  setStatus("DAY active.");
}

function runSetupCue() {
  beginCue("setup");

  fadeOutOtherLoops(["setup"]);
  startLoop("setup");

  setStatus("SETUP active.");
}

function runNominationsCue() {
  const cueId = beginCue("nominations");

  fadeOutOtherLoops(["nominations"], FADE.stage);
  playOneShot("gong");

  scheduleCueTask(cueId, 2, () => {
    startLoop("nominations");
  });

  setStatus("NOMINATIONS active.");
}

function runNightCue() {
  const cueId = beginCue("night");

  fadeOutOtherLoops(["night", "nominations"]);
  fadeOutLoop("nominations", FADE.stage);
  playOneShot("nightIntro");

  scheduleCueTask(cueId, 1.5, () => {
    startLoop("night");
  });

  setStatus("NIGHT active.");
}

function runStageCue(stage, murderCue = null) {
  if (stage === "setup") {
    runSetupCue();
    return;
  }

  if (stage === "day") {
    runDayCue(murderCue);
    return;
  }

  if (stage === "nominations") {
    runNominationsCue();
    return;
  }

  runNightCue();
}

async function handleStageTap(stage) {
  if (controlsBusy) {
    return;
  }

  if (stage === currentStage) {
    setStatus(`${STAGES[stage]} already active.`);
    return;
  }

  const murderCue = await resolveMurderCueForStage(stage);

  if (murderCue === false) {
    setStatus("DAY cue canceled.");
    return;
  }

  setControlsBusy(true);
  setStatus(loadPromise ? "Starting cue..." : "Loading audio files...");

  try {
    await ensureAudioReady();
    runStageCue(stage, murderCue);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Audio could not be started.");
  } finally {
    setControlsBusy(false);
  }
}

async function stopAll() {
  if (controlsBusy) {
    return;
  }

  setControlsBusy(true);
  currentCueId += 1;
  clearCueTimers();

  try {
    if (audioContext && audioContext.state === "suspended") {
      await audioContext.resume();
    }

    activeLoops.forEach((track) => fadeOutTrack(track, FADE.stopAll));
    activeOneShots.forEach((track) => fadeOutTrack(track, FADE.stopAll));
    setCurrentStage(null);
    setMediaPlaybackState("none");
    setStatus("Stopping.");

    window.setTimeout(() => {
      if (!currentStage) {
        setStatus("Stopped.");
      }
    }, FADE.stopAll * 1000 + 100);
  } finally {
    setControlsBusy(false);
  }
}

initializeMurderSoundUi();
initializeVolumeUi();

dom.stageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    handleStageTap(button.dataset.stage);
  });
});

dom.stopButton.addEventListener("click", stopAll);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch((error) => {
    console.warn("Could not register service worker.", error);
  });
}

configurePlaybackSession();
preloadAudio();
