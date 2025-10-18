// Burst (3s) scene describer — sends a burst, then requests a description
// by attaching the latest frame INLINE to the same turn (reliable for Live).

import { GoogleGenAI, Modality } from 'https://esm.run/@google/genai/web';

const qs = (s) => document.querySelector(s);
const statusEl = qs('#status');
const outputEl = qs('#output');
const videoEl = qs('#cam');

let session = null;
let media = null;
let responseBuffer = '';
let state = 'IDLE'; // IDLE | WAIT_ACK | BURSTING | WAIT_DESC | DONE
let burstSent = false;
let ackFallback = null;
let framesSentThisBurst = 0;
let descriptionTimer = null;

// NEW: keep latest frame bytes to co-send inline with the prompt
let lastFrameU8 = null;

const BACKEND = 'http://localhost:8787';

// ---------- utils ----------
function status(msg) { statusEl.textContent = msg; console.log('[status]', msg); }
function b64(u8) { let s=''; for (let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }
const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function mintEphemeral(apiKey) {
  const r = await fetch(`${BACKEND}/api/ephemeral`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gemini-api-key': apiKey },
    body: '{}'
  });
  if (!r.ok) throw new Error(`Ephemeral token mint failed (${r.status})`);
  const { token, error } = await r.json();
  if (error) throw new Error(error);
  return token;
}

function extractText(msg) {
  try {
    const parts = msg?.serverContent?.modelTurn?.parts;
    if (parts?.length) return parts.map(p => p?.text).filter(Boolean).join(' ');
  } catch {}
  return '';
}

// ---------- heuristics ----------
const NON_DESC_PATTERNS = [
  /send (me|the) (an )?image/i,
  /please (send|provide)/i,
  /waiting for (the )?image/i,
  /i (?:will|can) describe (?:once|when)/i,
  /once you send/i,
  /no image (?:yet|received)/i,
  /need an? image/i,
  /please capture/i,
  /please upload/i,
];
function isNonDescription(text) {
  const t = text.trim();
  if (!t) return true;
  if (NON_DESC_PATTERNS.some(rx => rx.test(t))) return true;
  if (t.length < 12 && /^(ok(ay)?|sure|noted|understood)$/i.test(t)) return true;
  return false;
}
function isUsableDescription(text) {
  const t = text.trim();
  if (!t) return false;
  if (/^no change$/i.test(t)) return true;
  if (isNonDescription(t)) return false;
  return t.split(/\s+/).length >= 4;
}

// ---------- frame helpers ----------
async function grabFrameU8() {
  if (!videoEl) return null;
  const w = 320, h = 240;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.6));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

async function sendFrame() {
  // Optional: still stream via realtime input (not strictly required now)
  if (!session) return;
  const u8 = await grabFrameU8();
  if (!u8) return;
  lastFrameU8 = u8;               // <-- cache the freshest frame
  try {
    await session.sendRealtimeInput({ data: b64(u8), mimeType: 'image/jpeg' });
    framesSentThisBurst++;
  } catch (e) {
    console.warn('sendRealtimeInput failed:', e);
  }
}

// Attach the latest frame INLINE in the same turn as the prompt.
// This is the reliable way for the model to "see" the image.
async function inlineDescribe() {
  if (!session) return;
  if (!lastFrameU8) {
    // Fallback: take one snapshot now if burst didn't produce one
    const snap = await grabFrameU8();
    if (snap) lastFrameU8 = snap;
  }
  if (!lastFrameU8) {
    status('No frame available to send inline.');
    return;
  }

  state = 'WAIT_DESC';
  status('Frames sent. Requesting description…');

  await session.sendClientContent({
    turns: [{
      role: 'user',
      parts: [
        { inlineData: { data: b64(lastFrameU8), mimeType: 'image/jpeg' } },
        { text: 'Describe this image in 1–2 concise sentences. Say "no change" if identical to last view.' },
      ]
    }]
  });

  if (descriptionTimer) clearTimeout(descriptionTimer);
  descriptionTimer = setTimeout(async () => {
    if (state === 'WAIT_DESC') {
      status('Timed out waiting for a description.');
      await stopAll();
    }
  }, 10000);
}

async function sendBurstAndDescribe() {
  state = 'BURSTING';
  framesSentThisBurst = 0;
  lastFrameU8 = null;

  status('Capturing burst (3s)…');
  const durationMs = 3000, fps = 5;
  const frameInterval = Math.max(1, Math.floor(1000 / fps));
  const tEnd = Date.now() + durationMs;

  while (Date.now() < tEnd) {
    await sendFrame();
    const remaining = tEnd - Date.now();
    await delay(Math.max(0, Math.min(frameInterval, remaining)));
  }

  // After burst, co-send the freshest frame inline with the prompt
  await inlineDescribe();
}

// ---------- main burst flow ----------
async function startBurst() {
  try {
    const apiKey = qs('#apiKey')?.value?.trim();
    if (!apiKey) throw new Error('Enter your AI Studio API key (starts with AIza)');

    qs('#start').disabled = true;
    qs('#stop').disabled = false;

    // reset state
    outputEl.textContent = '';
    responseBuffer = '';
    burstSent = false;
    framesSentThisBurst = 0;
    lastFrameU8 = null;
    state = 'WAIT_ACK';
    if (ackFallback) { clearTimeout(ackFallback); ackFallback = null; }
    if (descriptionTimer) { clearTimeout(descriptionTimer); descriptionTimer = null; }

    status('[1/4] Minting token…');
    const token = await mintEphemeral(apiKey);

    status('[2/4] Opening live session…');
    const ai = new GoogleGenAI({ apiKey: token, apiVersion: 'v1alpha' });

    session = await ai.live.connect({
      model: 'gemini-2.0-flash-live-001',
      config: { responseModalities: [Modality.TEXT] },
      callbacks: {
        onerror: (e) => status('Live error: ' + (e?.message || e)),
        onclose: () => status('Disconnected.'),
        onmessage: async (msg) => {
          const chunk = extractText(msg);
          if (chunk) responseBuffer += chunk;

          if (!msg?.serverContent?.turnComplete) return;

          const text = responseBuffer.trim();
          responseBuffer = '';

          if (state === 'WAIT_DESC') {
            if (isUsableDescription(text)) {
              if (descriptionTimer) { clearTimeout(descriptionTimer); descriptionTimer = null; }
              outputEl.textContent = text;
              state = 'DONE';
              await delay(150);
              await stopAll();
              return;
            } else {
              console.log('Non-description while WAIT_DESC:', text || '(empty)');
              // If the model says "send the image", push the inline image again.
              if (/send/i.test(text) || /image/i.test(text) || /waiting/i.test(text)) {
                await inlineDescribe(); // reattach latest frame + prompt
              }
              return;
            }
          }

          if (state === 'WAIT_ACK') {
            console.log('Model acknowledged / replied:', text || '(no text)');
            if (ackFallback) { clearTimeout(ackFallback); ackFallback = null; }
            if (!burstSent) {
              burstSent = true;
              await sendBurstAndDescribe();
            }
            return;
          }

          // Ignore during BURSTING; DONE ignores everything.
        }
      }
    });

    status('[3/4] Starting camera…');
    media = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: false
    });
    videoEl.srcObject = media;
    await videoEl.play();
    if (videoEl.readyState < 2) {
      await new Promise(r => (videoEl.onloadeddata = () => r()));
    }

    status('[4/4] Sending run instructions…');
    await session.sendClientContent({
      turns: [{
        role: 'user',
        parts: [{ text:
          'You are a visual assistant. I will send you a short burst of images. When asked, describe only the most recent image in 1–2 sentences, focusing on key objects and safety. Acknowledge these instructions.'
        }]
      }]
    });

    // Ack watchdog: proceed with burst if no ack shows up
    ackFallback = setTimeout(async () => {
      if (!burstSent && session && state === 'WAIT_ACK') {
        console.warn('No ack within 1.5s — proceeding with burst anyway.');
        burstSent = true;
        await sendBurstAndDescribe();
      }
    }, 1500);

  } catch (e) {
    status('Failed to start: ' + (e?.message || e));
    await stopAll();
  }
}

async function stopAll() {
  try {
    if (ackFallback) { clearTimeout(ackFallback); ackFallback = null; }
    if (descriptionTimer) { clearTimeout(descriptionTimer); descriptionTimer = null; }
    if (session) { session.close(); session = null; }
  } catch {}
  try {
    if (media) {
      media.getTracks().forEach(t => t.stop());
      media = null;
      videoEl.srcObject = null;
    }
  } catch {}
  qs('#start').disabled = false;
  qs('#stop').disabled = true;
  status('Stopped.');
}

// ---------- UI ----------
window.addEventListener('DOMContentLoaded', () => {
  qs('#start').addEventListener('click', startBurst);
  qs('#stop').addEventListener('click', stopAll);
});
