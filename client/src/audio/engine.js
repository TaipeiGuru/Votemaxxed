const BGM_BASE_URL = `${import.meta.env.BASE_URL}audio/bgm/`;
const SFX_BASE_URL = `${import.meta.env.BASE_URL}audio/sfx/`;
const DEFAULT_FADE_MS = 1200;

const bgmTrackFiles = {
  lobby: "lobby.mp3",
  countdown_30_sec: "countdown_30_sec.mp3",
  countdown_60_sec: "countdown_60_sec.mp3",
  countdown_75_sec: "countdown_75_sec.mp3",
  countdown_90_sec: "countdown_90_sec.mp3",
  round_1_voting: "round_1_voting.mp3",
  round_2_voting: "round_2_voting.mp3",
  round_3_voting: "round_3_voting.mp3",
  final_results: "final_results.mp3",
};

const sfxTrackFiles = {
  mogged: "mogged.mp3",
  pop: "pop.mp3",
  success: "success.mp3",
  drumroll: "drumroll.mp3",
  kaching: "kaching.mp3",
  glitch: "glitch.mp3",
  thud: "thud.mp3",
};

let masterEnabled = true;
let activeTrackKey = null;
let activeAudio = null;
let activeBgmTargetVolume = 1;
let bgmDuckHoldTimer = null;
let bgmDuckGeneration = 0;
const fadeTimersByAudio = new Map();
const audioByTrack = new Map();
const sfxAudioByKey = new Map();

function clearFadeTimer(audio) {
  const timer = fadeTimersByAudio.get(audio);
  if (timer) {
    clearInterval(timer);
    fadeTimersByAudio.delete(audio);
  }
}

function clearBgmDuckTimer() {
  if (bgmDuckHoldTimer) {
    clearTimeout(bgmDuckHoldTimer);
    bgmDuckHoldTimer = null;
  }
}

function stopImmediate(audio) {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  audio.volume = 0;
}

function fadeVolume(audio, from, to, fadeMs, onDone) {
  clearFadeTimer(audio);
  const duration = Math.max(0, Number(fadeMs) || 0);
  if (!audio || duration === 0 || from === to) {
    if (audio) audio.volume = to;
    if (onDone) onDone();
    return;
  }

  const startedAt = performance.now();
  const delta = to - from;
  audio.volume = from;
  const timer = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / duration);
    audio.volume = Math.max(0, Math.min(1, from + delta * t));
    if (t >= 1) {
      clearFadeTimer(audio);
      if (onDone) onDone();
    }
  }, 33);
  fadeTimersByAudio.set(audio, timer);
}

function ensureTrack(trackKey) {
  if (!trackKey) return null;
  if (!bgmTrackFiles[trackKey]) {
    console.warn(`[audio] Unknown BGM track "${trackKey}".`);
    return null;
  }
  if (audioByTrack.has(trackKey)) return audioByTrack.get(trackKey);
  const audio = new Audio(`${BGM_BASE_URL}${bgmTrackFiles[trackKey]}`);
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = 0;
  audioByTrack.set(trackKey, audio);
  return audio;
}

function ensureSfxTrack(sfxKey) {
  if (!sfxKey) return null;
  if (!sfxTrackFiles[sfxKey]) {
    console.warn(`[audio] Unknown SFX key "${sfxKey}".`);
    return null;
  }
  if (sfxAudioByKey.has(sfxKey)) return sfxAudioByKey.get(sfxKey);
  const audio = new Audio(`${SFX_BASE_URL}${sfxTrackFiles[sfxKey]}`);
  audio.preload = "auto";
  audio.volume = 1;
  sfxAudioByKey.set(sfxKey, audio);
  return audio;
}

export function preloadBgmTracks(trackKeys = []) {
  for (const trackKey of trackKeys) {
    const audio = ensureTrack(trackKey);
    if (!audio) continue;
    audio.load();
  }
}

export function preloadSfxTracks(sfxKeys = []) {
  for (const sfxKey of sfxKeys) {
    const audio = ensureSfxTrack(sfxKey);
    if (!audio) continue;
    audio.load();
  }
}

export function setMasterEnabled(enabled) {
  masterEnabled = Boolean(enabled);
  if (!masterEnabled) stopBgm({ fadeMs: 0 });
}

export function playBgm(trackKey, options = {}) {
  if (!masterEnabled || !trackKey) return;
  const fadeMs = Number(options.fadeMs) || DEFAULT_FADE_MS;
  const targetVolume = Math.max(0, Math.min(1, Number(options.targetVolume) || 0.1));
  const loop = options.loop !== false;
  const target = ensureTrack(trackKey);
  if (!target) return;

  target.loop = loop;
  activeBgmTargetVolume = targetVolume;

  if (activeTrackKey === trackKey && activeAudio === target) {
    if (target.paused) {
      target.currentTime = 0;
      void target.play().catch(() => {});
    }
    fadeVolume(target, target.volume, activeBgmTargetVolume, fadeMs);
    return;
  }

  const outgoing = activeAudio;
  activeTrackKey = trackKey;
  activeAudio = target;

  target.volume = 0;
  target.currentTime = 0;
  const started = target.play();
  if (started?.catch) {
    started.catch((err) => {
      console.warn(`[audio] Failed to start BGM "${trackKey}".`, err);
    });
  }
  fadeVolume(target, 0, activeBgmTargetVolume, fadeMs);

  if (outgoing && outgoing !== target) {
    const fromVol = outgoing.volume;
    fadeVolume(outgoing, fromVol, 0, fadeMs, () => stopImmediate(outgoing));
  }
}

export function stopBgm(options = {}) {
  const fadeMs = Number(options.fadeMs) || DEFAULT_FADE_MS;
  const outgoing = activeAudio;
  activeAudio = null;
  activeTrackKey = null;
  activeBgmTargetVolume = 1;
  bgmDuckGeneration += 1;
  clearBgmDuckTimer();
  if (!outgoing) return;

  const fromVol = outgoing.volume;
  fadeVolume(outgoing, fromVol, 0, fadeMs, () => stopImmediate(outgoing));
}

export function duckBgm(options = {}) {
  if (!activeAudio) return false;
  const target = Math.max(0, Math.min(1, Number(options.targetVolume) || 0));
  const attackMs = Math.max(0, Number(options.attackMs) || 100);
  const holdMs = Math.max(0, Number(options.holdMs) || 2400);
  const releaseMs = Math.max(0, Number(options.releaseMs) || 400);
  const generation = ++bgmDuckGeneration;

  clearBgmDuckTimer();
  fadeVolume(activeAudio, activeAudio.volume, target, attackMs);
  bgmDuckHoldTimer = setTimeout(() => {
    if (generation !== bgmDuckGeneration || !activeAudio) return;
    fadeVolume(activeAudio, activeAudio.volume, activeBgmTargetVolume, releaseMs);
    bgmDuckHoldTimer = null;
  }, holdMs);
  return true;
}

export function playSfx(sfxKey, options = {}) {
  const ignoreMaster = options.ignoreMaster === true;
  if ((!masterEnabled && !ignoreMaster) || !sfxKey) return false;
  const base = ensureSfxTrack(sfxKey);
  if (!base) return false;

  const volume = Math.max(0, Math.min(1, Number(options.volume) || 1));
  const allowOverlap = options.allowOverlap !== false;
  const audio = allowOverlap ? base.cloneNode(true) : base;
  audio.currentTime = 0;
  audio.volume = volume;
  const started = audio.play();
  if (started?.catch) {
    started.catch((err) => {
      console.warn(`[audio] Failed to play SFX "${sfxKey}".`, err);
    });
  }
  return true;
}

export function disposeAudioEngine() {
  stopBgm({ fadeMs: 0 });
  clearBgmDuckTimer();
  for (const audio of fadeTimersByAudio.keys()) {
    clearFadeTimer(audio);
  }
  for (const audio of audioByTrack.values()) {
    stopImmediate(audio);
    audio.src = "";
  }
  audioByTrack.clear();
  for (const audio of sfxAudioByKey.values()) {
    stopImmediate(audio);
    audio.src = "";
  }
  sfxAudioByKey.clear();
}
