// live.js — Gemini Live client (burst; inline image + prompt; deduped transcript flow)

import { GoogleGenAI, Modality } from 'https://esm.run/@google/genai/web';

// Put near the other top-level helpers/constants
const ACK_TOKEN = '⟦ACK⟧';  // unlikely to appear naturally; change if you prefer


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

function isNonDescription(t) {
  const s = t.trim();
  if (!s) return true;
  if (NON_DESC_PATTERNS.some(rx => rx.test(s))) return true;
  if (s.length < 12 && /^(ok(ay)?|sure|noted|understood)$/i.test(s)) return true;
  return false;
}
function isUsableDescription(t) {
  const s = t.trim();
  if (!s) return false;
  if (/^no change$/i.test(s)) return true;
  if (isNonDescription(s)) return false;
  return s.split(/\s+/).length >= 4;
}
function b64(u8) { let s=''; for (let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }

export class LiveBurstClient {
  constructor({
    backend = 'http://localhost:8787',
    model = 'gemini-2.0-flash-live-001',
    videoEl,
    onStatus = () => {},
    onAck = () => {},
    onDescription = () => {},
    onTranscript = () => {},   // we’ll call this ONLY for ACKs if consumer wants; otherwise leave to onAck/onDescription
    onDisconnect = () => {},
  } = {}) {
    this.backend = backend;
    this.model = model;
    this.videoEl = videoEl;
    this.onStatus = onStatus;
    this.onAck = onAck;
    this.onDescription = onDescription;
    this.onTranscript = onTranscript; // not used for final desc to avoid dupes
    this.onDisconnect = onDisconnect;

    this.session = null;
    this.media = null;
    this.responseBuffer = '';
    this.state = 'IDLE'; // IDLE | WAIT_ACK | BURSTING | WAIT_DESC | DONE
    this.burstSent = false;
    this.ackFallback = null;
    this.descriptionTimer = null;
    this.framesSent = 0;
    this.lastFrameU8 = null;
  }

  async start({ apiKey, detailMode='concise', durationMs=3000, fps=5, beforeSendInstructions } = {}) {
    this._reset();
    this.detailMode = detailMode;
    this.durationMs = durationMs;
    this.fps = fps;

    const token = await this._mint(apiKey);
    await this._connect(token);
    await this._openCamera();

    // allow caller to show a status (hidden from transcript) before sending instructions
    if (typeof beforeSendInstructions === 'function') beforeSendInstructions();

    await this._sendInstructions();
    this._startAckWatchdog();
  }

  async stop() {
    try {
      if (this.ackFallback) clearTimeout(this.ackFallback);
      if (this.descriptionTimer) clearTimeout(this.descriptionTimer);
      if (this.session) { this.session.close(); this.session = null; }
    } catch {}
    try {
      if (this.media) {
        this.media.getTracks().forEach(t => t.stop());
        this.media = null;
        if (this.videoEl) this.videoEl.srcObject = null;
      }
    } catch {}
    this.onStatus('Stopped.');
  }

  setVideoEl(el) { this.videoEl = el; }

  // --- internals ---
  _reset() {
    this.responseBuffer = '';
    this.state = 'WAIT_ACK';
    this.burstSent = false;
    this.framesSent = 0;
    this.lastFrameU8 = null;
    if (this.ackFallback) clearTimeout(this.ackFallback);
    if (this.descriptionTimer) clearTimeout(this.descriptionTimer);
    this.onStatus('[1/4] Minting token…');
  }

  async _mint(apiKey) {
    const r = await fetch(`${this.backend}/api/ephemeral`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gemini-api-key': apiKey },
      body: '{}'
    });
    if (!r.ok) throw new Error(`Ephemeral token mint failed (${r.status})`);
    const { token, error } = await r.json();
    if (error) throw new Error(error);
    return token;
  }

  async _connect(token) {
    this.onStatus('[2/4] Opening live session…');
    const ai = new GoogleGenAI({ apiKey: token, apiVersion: 'v1alpha' });
    this.session = await ai.live.connect({
      model: this.model,
      config: { responseModalities: [Modality.TEXT] },
      callbacks: {
        onerror: (e) => this.onStatus('Live error: ' + (e?.message || e)),
        onclose: () => { this.onStatus('Disconnected.'); this.onDisconnect(); },
        onmessage: async (msg) => this._onMessage(msg),
      }
    });
  }

  async _openCamera() {
    this.onStatus('[3/4] Starting camera…');
    this.media = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: false
    });
    this.videoEl.srcObject = this.media;
    await this.videoEl.play();
    if (this.videoEl.readyState < 2) {
      await new Promise(r => (this.videoEl.onloadeddata = () => r()));
    }
  }

  async _sendInstructions() {
  // We keep status messaging out of transcript in app.js; just send the prompt here.
  await this.session.sendClientContent({
    turns: [{
      role: 'user',
      parts: [{
        text:
`You are a visual assistant. I will send you a short burst of images. When asked, describe only the most recent image.

If you understand these instructions, reply with EXACTLY the single token ${ACK_TOKEN} on its own line and NOTHING ELSE.
Do NOT include ${ACK_TOKEN} in any subsequent descriptions.`
      }]
    }]
  });
}


  _startAckWatchdog() {
    this.ackFallback = setTimeout(async () => {
      if (!this.burstSent && this.session && this.state === 'WAIT_ACK') {
        console.warn('No ack within 1.5s — proceeding with burst anyway.');
        await this._sendBurstAndDescribe();
      }
    }, 1500);
  }

  _extractText(msg) {
    try {
      const parts = msg?.serverContent?.modelTurn?.parts;
      if (parts?.length) return parts.map(p => p?.text).filter(Boolean).join(' ');
    } catch {}
    return '';
  }

  async _onMessage(msg) {
    const textChunk = this._extractText(msg);
    if (textChunk) this.responseBuffer += textChunk;

    if (!msg?.serverContent?.turnComplete) return;
    const text = this.responseBuffer.trim();
    this.responseBuffer = '';

    if (this.state === 'WAIT_DESC') {
      // Only treat as final if it's a real description. Do NOT echo non-descriptions to transcript.
      if (isUsableDescription(text)) {
        this.onDescription(text); // final (single) path; no onTranscript call here → no duplicates
        this.state = 'DONE';
        await this.stop();
        return;
      }
      // Non-description; resend inline image + prompt.
      if (/send|image|waiting/i.test(text)) {
        await this._inlineDescribe();
      }
      return;
    }

    if (this.state === 'WAIT_ACK') {
      // ACK: show once; avoid generic onTranscript echo to prevent duplicates
      if (this.ackFallback) clearTimeout(this.ackFallback);
      if (text) this.onAck(text);
      await this._sendBurstAndDescribe();
      return;
    }

    // Ignore anything else (BURSTING/DONE) to keep transcript clean.
  }

  async _grabFrameU8() {
    const w = 320, h = 240;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.videoEl, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.7));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  async _sendFrame() {
    const u8 = await this._grabFrameU8();
    if (!u8) return;
    this.lastFrameU8 = u8;
    try {
      await this.session.sendRealtimeInput({ data: b64(u8), mimeType: 'image/jpeg' });
      this.framesSent++;
    } catch (e) {
      console.warn('sendRealtimeInput failed:', e);
    }
  }

  _buildDescribeText() {
    if (this.detailMode === 'detailed') {
      return (
        'Describe this image in a rich, detailed paragraph (up to ~500 words). ' +
        'You are describing to the visually impaired. you need to be detailed to assist the visually impaired to understand the scene.' +
        'Be respectful and inclusive in your descriptions, do not directly point out the disabilities of the viewer.' +
        'Structure your description clearly, mentioning key elements first followed by finer details. ' +
        'However, note that the description should not be in point form. it must be descriptive and immersive, like a narrator' +
        'Do not overdescribe trivial details that do not add to the understanding of the scene.' +
        'Mention subjects, composition, color and lighting, style/medium if evident, textures, mood, and notable details. ' +
        'Avoid guessing hidden camera models. If identical to the last view, say "no change".' + 
        `Do NOT include the token ${ACK_TOKEN} anywhere in your answer.`
      );
    }
    return 'Describe this image in 1–2 concise sentences, focusing on key objects, spatial context, and safety. If identical to the last view, say "no change".'
    + `Do NOT include the token ${ACK_TOKEN} anywhere in your answer.`;
  }

  async _inlineDescribe() {
    if (!this.lastFrameU8) {
      const snap = await this._grabFrameU8();
      if (snap) this.lastFrameU8 = snap;
    }
    if (!this.lastFrameU8) {
      this.onStatus('No frame available to send inline.');
      return;
    }
    this.state = 'WAIT_DESC';
    this.onStatus('Frames sent. Requesting description…');
    const text = this._buildDescribeText();
    await this.session.sendClientContent({
      turns: [{
        role: 'user',
        parts: [
          { inlineData: { data: b64(this.lastFrameU8), mimeType: 'image/jpeg' } },
          { text }
        ]
      }]
    });

    if (this.descriptionTimer) clearTimeout(this.descriptionTimer);
    this.descriptionTimer = setTimeout(async () => {
      if (this.state === 'WAIT_DESC') {
        this.onStatus('Timed out waiting for a description.');
        await this.stop();
      }
    }, 10000);
  }

  async _sendBurstAndDescribe() {
    if (this.burstSent) return;   // <-- extra guard to prevent double burst
    this.state = 'BURSTING';
    this.burstSent = true;
    this.framesSent = 0;
    this.lastFrameU8 = null;

    this.onStatus('Capturing burst (3 seconds)…');
    const frameInterval = Math.max(1, Math.floor(1000 / this.fps));
    const tEnd = Date.now() + this.durationMs;

    while (Date.now() < tEnd) {
      await this._sendFrame();
      const remaining = tEnd - Date.now();
      await new Promise(res => setTimeout(res, Math.max(0, Math.min(frameInterval, remaining))));
    }
    await this._inlineDescribe();
  }
}
