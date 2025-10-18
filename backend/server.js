// backend/server.js
// Tiny, stateless token minter for Gemini Live (BYO user key).
// The client sends THEIR AI Studio API key once per session, we mint an ephemeral Live token
// with safe constraints and return it. We NEVER store the user's key.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 8787;

// Allow your dev front-end origin; set FRONTEND_ORIGIN in prod
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(helmet());
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// POST /api/ephemeral  (also accepts GET with header)
// Client must include x-gemini-api-key header OR JSON body { apiKey }
app.all('/api/ephemeral', async (req, res) => {
  try {
    const userKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    if (!userKey || typeof userKey !== 'string') {
      return res.status(400).json({ error: 'Missing x-gemini-api-key header or {apiKey} in JSON body' });
    }

    // IMPORTANT: we DO NOT persist this. Instantiate SDK with the user key just for minting.
    const ai = new GoogleGenAI({ apiKey: userKey, apiVersion: 'v1alpha' });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),   // 1 min to start a Live session
        expireTime: new Date(now + 30 * 60_000).toISOString(),        // ~30 min overall token lifetime
        httpOptions: { apiVersion: 'v1alpha' },
        // Lock down the Live session so clients can’t escalate
        liveConnectConstraints: {
          model: 'gemini-2.0-flash-live-001',
          config: {
            responseModalities: ['TEXT'], // we use browser TTS; switch to 'AUDIO' if you want native voice
            temperature: 0.6,
            systemInstruction: 'You are an accessibility narrator. Describe scenes succinctly for a blind user with spatial context and safety cues first.'
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

app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));