// /api/ephemeral.ts — Edge function (Vercel/Netlify/CF Worker compatible)
export const runtime = 'edge';


import { GoogleGenAI } from '@google/genai';


export default async function handler(req: Request) {
try {
// The client sends THEIR OWN AI Studio API key for this one call.
const userKey = req.headers.get('x-gemini-api-key');
if (!userKey) {
return new Response('Missing x-gemini-api-key header', { status: 400 });
}


// No server key is used. We instantiate the SDK with the user's key.
const ai = new GoogleGenAI({ apiKey: userKey, apiVersion: 'v1alpha' });


const expireTime = new Date(Date.now() + 30 * 60_000).toISOString();
const newSessionExpireTime = new Date(Date.now() + 60_000).toISOString();


const token = await ai.authTokens.create({
config: {
uses: 1,
expireTime,
newSessionExpireTime,
// Lock down what the client can request in the Live session
liveConnectConstraints: {
// Pick a Live model available to your users; this one is commonly enabled.
model: 'gemini-2.0-flash-live-001',
config: {
responseModalities: ['TEXT'], // we TTS in-browser; flip to 'AUDIO' if you want native voice
temperature: 0.6,
},
},
httpOptions: { apiVersion: 'v1alpha' },
},
});


return new Response(JSON.stringify({ token: token.name }), {
headers: { 'content-type': 'application/json' },
});
} catch (err: any) {
return new Response(
JSON.stringify({ error: err?.message || 'token mint failed' }),
{ status: 500, headers: { 'content-type': 'application/json' } }
);
}
}