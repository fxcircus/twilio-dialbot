// server.js — Dialbot: calling, redial loop, mono recording with auto-prune
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());                        // for our own API
app.use(express.urlencoded({ extended: false }));  // for Twilio webhooks
app.use(express.static('public'));                 // serve /public/index.html

// ── .env values ──────────────────────────────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_NUMBER,
  SERVER_URL,
  REDIAL_DELAY_MS = 60000
} = process.env;

const twilioRest  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

/* ══ 1. Capability token ════════════════════════════════════════ */
app.get('/token', (_req, res) => {
  // Token TTL: default 12 h (43 200 s) — can be overridden via env TOKEN_TTL_SECONDS
  const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 43200);

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    {
      identity: 'browserUser',
      ttl: TOKEN_TTL_SECONDS > 86400 ? 86400 : TOKEN_TTL_SECONDS // Twilio max = 24 h
    }
  );
  token.addGrant(new VoiceGrant({ incomingAllow: true }));
  res.json({ token: token.toJwt() });
});

/* ══ 2. Front-end config (redial delay) ═════════════════════════ */
app.get('/config', (_req, res) =>
  res.json({ redialDelayMs: Number(REDIAL_DELAY_MS) })
);

/* ══ 2b. Get default number if set ══════════════════════════════ */
app.get('/default-number', (_req, res) =>
  res.json({ number: process.env.NUMBER_TO_CALL || null })
);

/* ══ 3. Start outbound call ═════════════════════════════════════ */
app.post('/call', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    console.log('📞 Call request received:', req.body);

    const call = await twilioRest.calls.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      url: `${SERVER_URL}/twiml?client=browserUser`,
      record: true,
      machineDetection: 'Enable',
      statusCallback: `${SERVER_URL}/call-status`,
      statusCallbackEvent: ['completed']
    });

    console.log('✅ Call created successfully:', call.sid);
    res.json({ callSid: call.sid });
  } catch (err) {
    console.error('Call creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══ 4. Hang up on demand ═══════════════════════════════════════ */
app.post('/end-call', async (req, res) => {
  try {
    await twilioRest.calls(req.body.callSid).update({ status: 'completed' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══ 5. TwiML: bridge PSTN → browser ════════════════════════════ */
app.post('/twiml', (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.dial({ record: true })
    .client(req.query.client || 'browserUser');
  res.type('text/xml').send(vr.toString());
});

/* ══ 6. Call-status webhook: prune useless recordings ═══════════ */
app.post('/call-status', async (req, res) => {
  const {
    AnsweredBy, CallDuration = 0,
    RecordingSid
  } = req.body;

  const human   = AnsweredBy === 'human';
  const longish = Number(CallDuration) >= 30;
  const keep    = human && longish;

  try {
    if (!keep && RecordingSid) {
      // .remove() deletes the recording immediately
      await twilioRest.recordings(RecordingSid).remove();
    }
  } catch (err) {
    console.error('call-status handler error:', err.message);
  }
  res.sendStatus(200);
});

/* ══ 7. Start server ════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dialbot server running on port ${PORT}`));
