// transcript.js — store + render + per-line TTS replay
// Hides status lines, the explicit ACK token (e.g., ⟦ACK⟧), and short image prompts.

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- If you used a different token in live.js, change it here to match ---
const ACK_TOKEN = '⟦ACK⟧';

// Short prompt phrases we want to hide (kept conservative)
const PROMPT_PHRASES = [
  'please send the image',
  'please send image',
  'waiting for the image',
  'waiting for image',
  'send me the image',
  'send the image',
  'no image yet',
  'no image received',
  'need an image',
  'need image'
];

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // Unicode-safe: keep letters/numbers/space
    .replace(/\s+/g, ' ')
    .trim();
}

// Very conservative filter:
// 1) hide if it's exactly the ACK token (after trim)
// 2) allow "no change"
// 3) hide very short prompts (<= 10 words) that contain one of PROMPT_PHRASES
function isAckOrPrompt(text) {
  const raw = (text || '').trim();
  if (!raw) return true;

  if (raw === ACK_TOKEN) return true;        // exact ACK token
  const norm = normalize(raw);
  if (norm === 'no change') return false;    // keep legit "no change"

  const words = norm.split(' ').filter(Boolean);
  if (words.length <= 10) {
    for (const phrase of PROMPT_PHRASES) {
      if (norm.includes(phrase)) return true;
    }
  }
  return false; // default: KEEP (so concise descriptions are never dropped)
}

export class Transcript {
  constructor(listEl, onReplay) {
    this.list = [];
    this.listEl = listEl;
    this.onReplay = onReplay;

    this.listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button.play');
      if (!btn) return;
      const li = btn.closest('li.line');
      const idx = Number(li?.dataset?.idx ?? -1);
      if (idx >= 0) this.onReplay(this.list[idx].text);
    });
  }

  add(role, text) {
    if (!text) return;

    // 1) Never show status lines
    if (role === 'status') return;

    // 2) Hide model ACK token or short "send image" prompts
    if (role === 'model' && isAckOrPrompt(text)) return;

    const idx = this.list.push({ role, text, ts: Date.now() }) - 1;
    const { role: r, ts } = this.list[idx];

    const li = document.createElement('li');
    li.className = `line ${r}`;
    li.dataset.idx = String(idx);

    const icon = r === 'model' ? '💬' : '🧑';
    const when = new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    li.innerHTML = `
      <button class="play" title="Replay via TTS" aria-label="Replay">▶</button>
      <span class="meta">${icon} ${r} • ${when}</span>
      <div class="text">${escapeHTML(text)}</div>
    `;

    this.listEl.appendChild(li);
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  clear() {
    this.list.length = 0;
    this.listEl.innerHTML = '';
  }
}
