// app.js — minimal glue: UI ⇄ Live client ⇄ TTS ⇄ Transcript

import { LiveBurstClient } from './live.js';
import { createTTS } from './tts.js';
import { Transcript } from './transcript.js';

const qs = (s) => document.querySelector(s);

// DOM refs
const videoEl   = qs('#cam');
const statusEl  = qs('#status');
const outputEl  = qs('#output');
const startBtn  = qs('#start');
const stopBtn   = qs('#stop');
const apiKeyIn  = qs('#apiKey');
const detailSel = qs('#detail');
const ttsMode   = qs('#ttsMode');
const rateInput = qs('#rate');
const narrateCb = qs('#narrate');
const transcriptEl = qs('#transcript');

// TTS setup (switchable)
let tts = createTTS({ mode: ttsMode.value, rate: Number(rateInput.value) });
const transcript = new Transcript(transcriptEl, (text) => tts.speak(text));

// Helpers
function setStatus(msg, { narrate=false } = {}) {
  statusEl.textContent = msg;
  transcript.add('status', msg);
  if (narrate && narrateCb.checked) tts.speak(msg);
}

// Live client
let live = new LiveBurstClient({
  backend: 'http://localhost:8787',
  model: 'gemini-2.0-flash-live-001',
  videoEl,
  onStatus: (m) => setStatus(m, { narrate: true }),
  onAck:    (t) => transcript.add('model', t),
  onTranscript: (t) => transcript.add('model', t),
  onDescription: (t) => {
    outputEl.textContent = t;
    transcript.add('model', t);
    tts.speak(t); // auto-speak final description
  },
  onDisconnect: () => { startBtn.disabled = false; stopBtn.disabled = true; }
});

// UI bindings
startBtn.addEventListener('click', async () => {
  const apiKey = apiKeyIn.value.trim();
  if (!apiKey) { setStatus('Enter your AI Studio API key (starts with AIza)'); return; }
  startBtn.disabled = true; stopBtn.disabled = false;
  transcript.clear(); outputEl.textContent = '';
  try {
    await live.start({
      apiKey,
      detailMode: detailSel.value, // 'concise' | 'detailed'
      durationMs: 3000,
      fps: 5
    });
  } catch (e) {
    setStatus('Failed to start: ' + (e?.message || e));
    await live.stop();
    startBtn.disabled = false; stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', async () => {
  await live.stop();
  startBtn.disabled = false; stopBtn.disabled = true;
});

ttsMode.addEventListener('change', () => {
  tts = createTTS({ mode: ttsMode.value, rate: Number(rateInput.value) });
});

rateInput.addEventListener('input', () => {
  tts.setRate(Number(rateInput.value));
});

qs('#pauseTTS').addEventListener('click', () => tts.pause());
qs('#resumeTTS').addEventListener('click', () => tts.resume());
qs('#clearTTS').addEventListener('click', () => tts.clear());
