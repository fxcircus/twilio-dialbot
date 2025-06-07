// server.js ───────────────────────────────────────────
const express = require('express');
const bodyParser = require('body-parser');
const twilio  = require('twilio');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_NUMBER,
  SERVER_URL,
  REDIAL_DELAY_MS = 60000          // fallback 60 s
} = process.env;

const twilioRest   = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const AccessToken  = twilio.jwt.AccessToken;
const VoiceGrant   = AccessToken.VoiceGrant;

// ── 1. Capability token ──────────────────────────────
app.get('/token', (_req, res) => {
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity: 'browserUser' }
  );
  token.addGrant(new VoiceGrant({ incomingAllow: true }));
  res.json({ token: token.toJwt() });
});

// ── 2. Config endpoint (sends redial delay) ──────────
app.get('/config', (_req, res) =>
  res.json({ redialDelayMs: Number(REDIAL_DELAY_MS) })
);

// ── 3. Start outbound call ───────────────────────────
app.post('/call', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const call = await twilioRest.calls.create({
      to:   phoneNumber,
      from: TWILIO_NUMBER,
      url:  `${SERVER_URL}/twiml?client=browserUser`
    });
    res.json({ callSid: call.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. End call manually ─────────────────────────────
app.post('/end-call', async (req, res) => {
  const { callSid } = req.body;
  try {
    await twilioRest.calls(callSid).update({ status: 'completed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. TwiML bridge ──────────────────────────────────
app.post('/twiml', (req, res) => {
  const client = req.query.client || 'browserUser';
  const vr = new twilio.twiml.VoiceResponse();
  vr.dial().client(client);
  res.type('text/xml').send(vr.toString());
});

// ── Start server ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
