const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const AUDIO_CACHE_NAME = "botc-soundtrack-v6";
const DECODE_WORK_UNITS = 2000000;
const RESUMABLE_LOOPS = new Set(["day"]);

const SOUND_FILES = {
  bells: {
    label: "Bells",
    path: "sounds/BotC Bells.wav",
    bytes: 3054198,
  },
  day: {
    label: "Day Loop",
    path: "sounds/BotC Day Loop.mp3",
    bytes: 45254947,
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

const STAGES = {
  day: "DAY",
  nominations: "NOMINATIONS",
  night: "NIGHT",
};

const LOOP_CONFIG = {
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

const ONE_SHOTS = {
  bells: {
    file: "bells",
    offset: 0,
  },
  nightIntro: {
    file: "nightIntro",
    offset: 1.347,
  },
};

const FADE = {
  stage: 3,
  stopAll: 1.25,
};

const dom = {
  stageButtons: Array.from(document.querySelectorAll("[data-stage]")),
  stageStates: Array.from(document.querySelectorAll("[data-stage-state]")),
  stopButton: document.querySelector("[data-stop]"),
  status: document.querySelector("[data-status]"),
  activeStage: document.querySelector("[data-active-stage]"),
  preloadProgress: document.querySelector("[data-preload-progress]"),
  preloadProgressFill: document.querySelector("[data-preload-progress-fill]"),
};

let audioContext = null;
let masterGain = null;
let loadPromise = null;
let buffers = {};
let currentStage = null;
let currentCueId = 0;
let controlsBusy = false;

const activeLoops = new Map();
const activeOneShots = new Set();
const cueTimers = new Set();
const stopTimers = new WeakMap();
const loopResumeOffsets = {
  day: 0,
};

const preloadProgress = {
  decoded: 0,
  downloaded: {},
  total: Object.values(SOUND_FILES).reduce((sum, file) => sum + file.bytes, 0)
    + Object.keys(SOUND_FILES).length * DECODE_WORK_UNITS,
};

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
}

function setAllStageStates(label) {
  dom.stageStates.forEach((node) => {
    node.textContent = label;
  });
}

function setCurrentStage(stage) {
  currentStage = stage;
  dom.activeStage.textContent = stage ? STAGES[stage] : "Idle";

  dom.stageButtons.forEach((button) => {
    const isActive = button.dataset.stage === stage;
    button.setAttribute("aria-pressed", String(isActive));
  });

  dom.stageStates.forEach((node) => {
    node.textContent = node.dataset.stageState === stage ? "Active" : "Ready";
  });
}

function enableStopButton() {
  dom.stopButton.disabled = false;
  dom.stopButton.style.cursor = "pointer";
}

function makeAudioContext() {
  if (!AudioContextClass) {
    throw new Error("This browser does not support the Web Audio API.");
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 1;
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
  setAllStageStates("Loading");
  resetPreloadProgress();
  setStatus("Preloading audio files...");

  try {
    makeAudioContext();
    await queueBufferLoad();
    setCurrentStage(null);
    setPreloadProgress(100);
    setPreloadProgressVisible(false);
    setStatus("Audio ready. Tap a stage.");
  } catch (error) {
    console.error(error);
    setAllStageStates("Retry");
    setStatus(error.message || "Audio preload failed. Tap a stage to retry.");
  } finally {
    if (AudioContextClass) {
      setControlsBusy(false);
    }
  }
}

async function ensureAudioReady() {
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
  const track = { id, source, gain, type: "oneShot" };

  source.buffer = buffer;
  connectSource(source, gain);
  setTrackGain(track, 1);

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
    rampTrackGain(track, 1, fadeIn, now);
  } else {
    setTrackGain(track, 1, now);
  }

  source.addEventListener("ended", () => {
    if (activeLoops.get(id) === track) {
      activeLoops.delete(id);
    }

    clearStopTimer(track);
  });

  activeLoops.set(id, track);
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
  enableStopButton();
  return currentCueId;
}

function runDayCue() {
  const cueId = beginCue("day");

  playOneShot("bells");
  fadeOutOtherLoops(["day", "night"]);

  scheduleCueTask(cueId, 1, () => {
    fadeOutLoop("night", FADE.stage);
    startLoop("day", { fadeIn: 3 });
  });

  setStatus("DAY active.");
}

function runNominationsCue() {
  beginCue("nominations");

  fadeOutOtherLoops(["nominations", "day"]);
  fadeOutLoop("day", FADE.stage);
  startLoop("nominations");

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

function runStageCue(stage) {
  if (stage === "day") {
    runDayCue();
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

  setControlsBusy(true);
  setStatus(loadPromise ? "Starting cue..." : "Loading audio files...");

  try {
    await ensureAudioReady();
    runStageCue(stage);
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

preloadAudio();
