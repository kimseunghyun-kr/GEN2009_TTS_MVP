// frontend/app.js
// BYO key flow: user pastes their AI Studio key → we call our backend to mint an ephemeral token →
// open a Live session with that token → send periodic JPEG frames → receive TEXT → speak via TTS.

import { GoogleGenAI, Modality } from 'https://esm.run/@google/genai';

const qs = (s) => document.querySelector(s);
const statusEl = qs('#status');
const transcriptEl = qs('#transcript');

let session = null;
let ai = null;
let media = null;
let frameTimer = null;
let lastText = '';

const UI = {
  announce(msg) { statusEl.textContent = msg; console.log('[status]', msg); },
  speak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Number(qs('#rate').value);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },
  setButtons(running) {
    qs('#start').disabled = running;
    qs('#stop').disabled = !running;
  },
  showTranscript(show) { transcriptEl.setAttribute('aria-hidden', show ? 'false' : 'true'); }
};

async function mintEphemeral(userKey) {
  const r = await fetch('http://localhost:8787/api/ephemeral', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gemini-api-key': userKey },
    body: JSON.stringify({})
  });
  if (!r.ok) throw new Error('Ephemeral token mint failed');
  const { token } = await r.json();
  return token;
}

async function start() {
  try {
    const apiKey = qs('#apiKey').value.trim();
    if (!apiKey) throw new Error('Enter your AI Studio API key');

    UI.setButtons(true);
    UI.announce('Minting token…');

    const token = await mintEphemeral(apiKey);

    // Use ephemeral token like a short-lived API key
    ai = new GoogleGenAI({ apiKey: token, apiVersion: 'v1alpha' });

    UI.announce('Opening Live session…');
    session = await ai.live.connect({
      model: 'gemini-2.0-flash-live-001',
      config: { responseModalities: [Modality.TEXT] },
      callbacks: {
        onopen: () => UI.announce('Connected. Streaming video frames…'),
        onerror: (e) => UI.announce('Live error: ' + (e?.message || e)),
        onclose: () => UI.announce('Disconnected.'),
        onmessage: (msg) => {
          const text = msg?.serverContent?.modelTurn?.parts?.map(p => p.text).filter(Boolean).join(' ');
          if (text) {
            lastText = text;
            if (qs('#captions').checked) transcriptEl.textContent = text;
            UI.speak(text);
          }
        }
      }
    });

    // Grab camera
    media = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    const videoEl = qs('#cam');
    videoEl.srcObject = media; videoEl.play();

    // Frame pump: send JPEG frames; optionally ask for a description periodically
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let lastPromptTs = 0;

    const sendFrame = async () => {
      if (!session) return;
      const w = 320, h = 240; canvas.width = w; canvas.height = h;
      ctx.drawImage(videoEl, 0, 0, w, h);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.6));
      if (blob) {
        await session.send({ realtimeInput: { video: blob } });
      }
      // Every 3 seconds, ask for a short update (throttled)
      const now = performance.now();
      if (qs('#auto').checked && now - lastPromptTs > 3000) {
        lastPromptTs = now;
        await session.send({ input: 'Describe what is visible for a blind user. Be concise, safety cues first.' });
      }
    };

    frameTimer = setInterval(sendFrame, 500); // ~2 FPS
    UI.announce('Describing what the camera sees…');
  } catch (e) {
    UI.announce('Failed to start: ' + (e?.message || e));
    await stop();
  }
}

async function stop() {
  try {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (session) { session.close(); session = null; }
    if (media) {
      media.getTracks().forEach(t => t.stop());
      media = null;
    }
  } finally {
    UI.setButtons(false);
  }
}

// UI bindings
window.addEventListener('DOMContentLoaded', () => {
  UI.showTranscript(qs('#captions').checked);
  qs('#captions').addEventListener('change', (e) => UI.showTranscript(e.target.checked));
  qs('#start').addEventListener('click', start);
  qs('#stop').addEventListener('click', stop);
  qs('#repeat').addEventListener('click', () => lastText && UI.speak(lastText));
  qs('#apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
});