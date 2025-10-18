// tts.js — queue + two adapters (Web Speech, Remote URL)
// Usage:
//   const tts = createTTS({ mode: 'remote', remoteUrl: '/api/tts', lang: 'en', rate: 1.0 });
//   tts.speak("hello"); tts.pause(); tts.resume(); tts.clear(); tts.setRate(1.1); tts.setLang('ko');

function chunk(text) {
  const parts = String(text).split(/(?<=[.!?])\s+/g).filter(Boolean);
  return parts.length ? parts : [String(text)];
}

// ---------- Queue (soft stop: never cuts current utterance) ----------
class Queue {
  constructor(adapter) {
    this.adapter = adapter;
    this.q = [];
    this.playing = false;
  }
  speak(text) {
    if (!text) return;
    for (const part of chunk(text)) this.q.push(part);
    if (!this.playing) this._next();
  }
  setRate(r) { this.adapter.setRate?.(r); }
  setLang(l) { this.adapter.setLang?.(l); }
  pause() { this.adapter.pause?.(); }
  resume() { this.adapter.resume?.(); if (!this.playing && this.q.length) this._next(); }
  clear() { this.q.length = 0; this.adapter.clear?.(); } // soft-clear only
  async _next() {
    const next = this.q.shift();
    if (!next) { this.playing = false; return; }
    this.playing = true;
    try { await this.adapter.play(next); }
    catch { /* swallow; keep going */ }
    finally {
      this.playing = false;
      if (this.q.length) this._next();
    }
  }
}

// ---------- Web Speech adapter ----------
class WebSpeechAdapter {
  constructor({ rate=1.0, lang='en' } = {}) {
    this.rate = Number(rate || 1.0);
    this.lang = lang || 'en';
  }
  setRate(r) { this.rate = Number(r || 1.0); }
  setLang(l) { this.lang = l || 'en'; }
  _pickVoice() {
    const voices = speechSynthesis.getVoices?.() || [];
    // try exact lang, then language prefix, else default
    return voices.find(v => v.lang === this.lang)
        || voices.find(v => v.lang?.startsWith(this.lang.split('-')[0]))
        || null;
  }
  play(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = this.lang;
      u.rate = this.rate;
      const v = this._pickVoice();
      if (v) u.voice = v;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  }
  pause() { speechSynthesis.pause(); }
  resume() { speechSynthesis.resume(); }
  clear() { /* soft clear only; current is not cancelled */ }
}

// ---------- Remote adapter (server returns audioUrl or base64) ----------
class RemoteAdapter {
  constructor({ remoteUrl='/api/tts', rate=1.0, lang='en' } = {}) {
    this.remoteUrl = remoteUrl;
    this.rate = Number(rate || 1.0);
    this.lang = lang || 'en';
    this.audio = new Audio();
    this.audio.preload = 'auto';
  }
  setRate(r) { this.rate = Number(r || 1.0); this._applyPlaybackRate(); }
  setLang(l) { this.lang = l || 'en'; }
  _applyPlaybackRate() {
    try { this.audio.playbackRate = this.rate; } catch {}
  }
  async play(text) {
    try {
      const r = await fetch(this.remoteUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(text), lang: this.lang, rate: this.rate })
      });
      if (!r.ok) throw new Error(`TTS ${r.status}`);

      // server may return {audioUrl} OR {audioBase64, mimeType}
      const data = await r.json();
      let srcUrl = null;

      if (data.audioUrl) {
        srcUrl = data.audioUrl; // should be same-origin or CORS-enabled
      } else if (data.audioBase64) {
        const mime = data.mimeType || 'audio/mpeg';
        const b = Uint8Array.from(atob(data.audioBase64), c => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([b], { type: mime }));
        srcUrl = blobUrl;
      } else {
        throw new Error('No audioUrl or audioBase64 in response');
      }

      await this._playUrl(srcUrl);
      if (data.audioBase64) { // cleanup blob if we created one
        try { URL.revokeObjectURL(srcUrl); } catch {}
      }
    } catch (e) {
      console.warn('Remote TTS failed, falling back to Web Speech for this line.', e);
      const fallback = new WebSpeechAdapter({ rate: this.rate, lang: this.lang });
      await fallback.play(text);
    }
  }
  _playUrl(url) {
    return new Promise((resolve) => {
      this.audio.onended = resolve;
      this.audio.onerror = resolve; // don't stall the queue
      this.audio.src = url;
      this._applyPlaybackRate();
      const p = this.audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => resolve());
    });
  }
  pause() { try { this.audio.pause(); } catch {} }
  resume() { try { this.audio.play(); } catch {} }
  clear() { /* soft clear only */ }
}

// ---------- factory ----------
export function createTTS({ mode='webspeech', rate=1.0, lang='en', remoteUrl='/api/tts' } = {}) {
  const adapter = mode === 'remote'
    ? new RemoteAdapter({ remoteUrl, rate, lang })
    : new WebSpeechAdapter({ rate, lang });

  const q = new Queue(adapter);
  return {
    speak: (t) => q.speak(t),
    pause: () => q.pause(),
    resume: () => q.resume(),
    clear: () => q.clear(),
    setRate: (r) => q.setRate(r),
    setLang: (l) => q.setLang(l),
  };
}
