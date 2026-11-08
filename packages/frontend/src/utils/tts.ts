import { apiGet } from './api';

// ─── Configuration ───────────────────────────────────────────────────
/** Max utterances tracked before we flush the queue and speak only the latest */
const MAX_QUEUE_SIZE = 8;
/** Pause/resume heartbeat interval to prevent Chrome/Chromium TTS freeze */
const KEEPALIVE_MS = 10_000;
/** Auto-remove tracked utterances whose callbacks never fired */
const ORPHAN_TIMEOUT_MS = 30_000;

// ─── Public helpers ──────────────────────────────────────────────────

export function getVoices(): SpeechSynthesisVoice[] {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const filtered = all.filter((v) => v.lang.toLowerCase().startsWith('es') || v.lang.toLowerCase().startsWith('en'));
  return filtered.length > 0 ? filtered : all;
}

// ─── Utterance tracking (prevents Chrome GC bug + bounded size) ──────

interface TrackedUtterance {
  utterance: SpeechSynthesisUtterance;
  createdAt: number;
}

const tracked: TrackedUtterance[] = [];

function untrack(utterance: SpeechSynthesisUtterance) {
  const idx = tracked.findIndex((t) => t.utterance === utterance);
  if (idx > -1) tracked.splice(idx, 1);
  if (tracked.length === 0) stopKeepalive();
}

/** Remove utterances that exceeded the timeout without finishing. */
function pruneOrphans() {
  const now = Date.now();
  for (let i = tracked.length - 1; i >= 0; i--) {
    if (now - tracked[i].createdAt > ORPHAN_TIMEOUT_MS) {
      tracked.splice(i, 1);
    }
  }
  if (tracked.length === 0) stopKeepalive();
}

// ─── Keepalive heartbeat (Chrome/Chromium TTS freeze workaround) ─────
// Chrome silently freezes speechSynthesis after prolonged use.
// Calling pause() + resume() every ~10 s keeps the engine alive.

let keepaliveId: ReturnType<typeof setInterval> | null = null;

function startKeepalive() {
  if (keepaliveId) return;
  keepaliveId = setInterval(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (synth.speaking) {
      synth.pause();
      synth.resume();
    }
    pruneOrphans();
  }, KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveId) {
    clearInterval(keepaliveId);
    keepaliveId = null;
  }
}

// ─── Piper TTS (HTTP Server) ─────────────────────────────────────────

const piperQueue: string[] = [];
let isPiperPlaying = false;
let currentPiperAudio: HTMLAudioElement | null = null;

function processPiperQueue(volume: number) {
  if (isPiperPlaying || piperQueue.length === 0) return;
  const url = piperQueue.shift()!;
  isPiperPlaying = true;
  
  const audio = new Audio(url);
  audio.volume = volume;
  currentPiperAudio = audio;
  
  const cleanup = () => {
    URL.revokeObjectURL(url);
    isPiperPlaying = false;
    currentPiperAudio = null;
    processPiperQueue(volume);
  };
  
  audio.onended = cleanup;
  audio.onerror = (e) => {
    console.error('[TTS] Audio element error:', e);
    cleanup();
  };
  audio.play().catch(err => {
    console.error('[TTS] Audio play() failed:', err);
    cleanup();
  });
}

function speakPiper(text: string, rate: number, volume: number, lang: 'es' | 'en') {
  if (piperQueue.length >= MAX_QUEUE_SIZE) {
    piperQueue.forEach(u => URL.revokeObjectURL(u));
    piperQueue.length = 0;
    if (currentPiperAudio) {
      currentPiperAudio.pause();
      isPiperPlaying = false;
      currentPiperAudio = null;
    }
  }

  const path = `/api/tts/piper?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`;
  
  apiGet(path)
    .then(res => {
      if (!res.ok) throw new Error(`Piper returned ${res.status}`);
      return res.blob();
    })
    .then(blob => {
      const audioUrl = URL.createObjectURL(blob);
      piperQueue.push(audioUrl);
      processPiperQueue(volume);
    })
    .catch(err => {
      console.warn('[TTS] Piper Error, falling back to native TTS:', err);
      speakNative(text, null, rate, volume, lang);
    });
}

function speakNative(
  text: string,
  voiceURI: string | null,
  rate: number,
  volume: number,
  fallbackLang: 'es' | 'en' = 'es',
) {
  const synth = window.speechSynthesis;
  if (!synth) return;

  if (synth.paused) {
    try { synth.resume(); } catch {}
  }

  // Queue limit: flush stale queue so the user hears recent messages
  if (tracked.length >= MAX_QUEUE_SIZE) {
    synth.cancel();
    tracked.length = 0;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  tracked.push({ utterance, createdAt: Date.now() });

  utterance.onend = () => untrack(utterance);
  utterance.onerror = () => untrack(utterance);

  const availableVoices = getVoices();
  if (voiceURI) {
    const found = availableVoices.find((v) => v.voiceURI === voiceURI);
    if (found) utterance.voice = found;
  }
  if (!utterance.voice && availableVoices.length > 0) {
    const preferred =
      availableVoices.find((v) => v.lang.toLowerCase().startsWith(fallbackLang)) ||
      availableVoices.find((v) => v.default) ||
      availableVoices[0];
    if (preferred) utterance.voice = preferred;
  }
  utterance.lang = utterance.voice?.lang || (fallbackLang === 'en' ? 'en-US' : 'es-ES');
  utterance.rate = rate;
  utterance.volume = volume;

  synth.speak(utterance);
  startKeepalive();
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Enqueue a text-to-speech utterance.
 *
 * If the internal queue exceeds `MAX_QUEUE_SIZE`, the whole queue is
 * flushed and only the newest message is spoken, keeping the TTS
 * output relevant to the live conversation.
 */
export function speak(
  text: string,
  voiceURI: string | null,
  rate: number,
  volume: number,
  engine: 'native' | 'piper' = 'native',
  piperLang: 'es' | 'en' = 'es'
) {
  const cleaned = text.trim();
  if (!cleaned) return;
  if (engine === 'piper') {
    speakPiper(cleaned, rate, volume, piperLang);
    return;
  }
  speakNative(cleaned, voiceURI, rate, volume, piperLang);
}

/** Cancel all pending/active speech and release tracked references. */
export function cancelAll() {
  window.speechSynthesis?.cancel();
  tracked.length = 0;
  stopKeepalive();

  piperQueue.forEach(u => URL.revokeObjectURL(u));
  piperQueue.length = 0;
  if (currentPiperAudio) {
    currentPiperAudio.pause();
    currentPiperAudio = null;
  }
  isPiperPlaying = false;
}
