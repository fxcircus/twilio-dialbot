// server.js ─────────────────────────────────────────────
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static('public')); // serve index.html

// ── env vars ───────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_NUMBER,
  SERVER_URL // e.g. https://xxxx.ngrok-free.app
} = process.env;

// Twilio helper instances
const twilioRest = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// 1️⃣ Capability Token for Twilio Client
app.get('/token', (req, res) => {
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity: 'browserUser' }
  );
  token.addGrant(new VoiceGrant({ incomingAllow: true }));
  res.json({ token: token.toJwt() });
});

// 2️⃣ Make the outbound PSTN call
app.post('/call', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const call = await twilioRest.calls.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      url: `${SERVER_URL}/twiml?client=browserUser`
    });
    res.json({ callSid: call.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3️⃣ End the call
app.post('/end-call', async (req, res) => {
  try {
    const { callSid } = req.body;
    await twilioRest.calls(callSid).update({ status: 'completed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4️⃣ TwiML that bridges PSTN leg → browser client
app.post('/twiml', (req, res) => {
  const clientName = req.query.client || 'browserUser';
  const vr = new twilio.twiml.VoiceResponse();
  vr.dial().client(clientName);
  res.type('text/xml').send(vr.toString());
});

// ── start ───────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
