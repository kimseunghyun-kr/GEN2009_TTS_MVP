// Tiny, stateless token minter for Gemini Live (BYO user key) + TTS endpoint.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { GoogleGenAI } from '@google/genai';

// --- NEW: imports for TTS ---
import gTTS from 'node-gtts';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8787;

app.use(helmet());
app.use(cors()); // dev: allow all
app.use(express.json({ limit: '1mb' }));

// --- NEW: static dir for generated audio ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_DIR = path.join(__dirname, 'tts-cache');
fs.mkdirSync(TTS_DIR, { recursive: true });
app.use('/tts', express.static(TTS_DIR, { maxAge: '5m', immutable: false }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// POST /api/ephemeral  (unchanged)
app.post('/api/ephemeral', async (req, res) => {
  try {
    const userKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    if (!userKey || typeof userKey !== 'string') {
      return res.status(400).json({ error: 'Missing x-gemini-api-key header or {apiKey} in JSON body' });
    }

    const ai = new GoogleGenAI({ apiKey: userKey, apiVersion: 'v1alpha' });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),   // you can bump to 2 * 60_000 if desired
        expireTime:           new Date(now + 30 * 60_000).toISOString(),
        httpOptions: { apiVersion: 'v1alpha' },
        liveConnectConstraints: {
          model: 'gemini-2.0-flash-live-001',
          config: {
            responseModalities: ['TEXT'],
            temperature: 0.6,
            systemInstruction:
              'You are an accessibility narrator. Describe scenes succinctly for a blind user with spatial context and safety cues first.'
          }
        }
      }
    });

    return res.json({ token: token.name });
  } catch (err) {
    console.error('[ephemeral] error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// --- NEW: POST /api/tts (Google-Translate via node-gtts) ---
// Body: { text: string, lang?: string } → { audioUrl: "/tts/<file>.mp3" }
app.post('/api/tts', async (req, res) => {
  try {
    let { text, lang = 'en' } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'missing_text' });
    }
    text = text.slice(0, 5000); // basic safety cap

    const id = uuidv4();
    const file = path.join(TTS_DIR, `${id}.mp3`);

    const engine = gTTS(lang); // language codes like 'en', 'en-US', 'ko', 'ja', etc.
    engine.save(file, text, (err) => {
      if (err) {
        console.error('[tts] synth error:', err);
        return res.status(500).json({ error: 'tts_failed' });
      }
      // Client will <audio src={audioUrl}> or play via JS
      res.json({ audioUrl: `/tts/${path.basename(file)}` });
    });
  } catch (e) {
    console.error('[tts] route error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
