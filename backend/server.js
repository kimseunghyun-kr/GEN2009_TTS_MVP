// Tiny, stateless token minter for Gemini Live (BYO user key).
// Client sends THEIR AI Studio API key; we mint a short-lived ephemeral token and return it.
// We NEVER store keys.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 8787;

app.use(helmet());
app.use(cors()); // dev: allow all
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// POST /api/ephemeral
// header: x-gemini-api-key: AIza...
// body   (optional): { "apiKey": "AIza..." }
app.post('/api/ephemeral', async (req, res) => {
  try {
    const userKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    if (!userKey || typeof userKey !== 'string') {
      return res.status(400).json({ error: 'Missing x-gemini-api-key header or {apiKey} in JSON body' });
    }

    // create ephemeral token using the user's key (developer API)
    const ai = new GoogleGenAI({ apiKey: userKey, apiVersion: 'v1alpha' });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        // ~1 min to open session; ~30 min lifetime
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        httpOptions: { apiVersion: 'v1alpha' },
        // Lock what the client can do
        liveConnectConstraints: {
          model: 'gemini-2.0-flash-live-001',
          config: {
            responseModalities: ['TEXT'], // we TTS in browser
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

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
