// server.js — Dialbot: calling, redial loop, mono recording with auto-prune
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
// const ngrok = require('ngrok'); // Commented out - IT blocks this
require('dotenv').config();

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (req.method === 'POST' && req.path !== '/call-state') {
    console.log('Headers:', req.headers['content-type']);
  }
  next();
});

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
  REDIAL_DELAY_MS = 60000
} = process.env;

// SERVER_URL will be set dynamically by ngrok
let SERVER_URL = process.env.SERVER_URL;

const twilioRest  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

// ── Call State Management ────────────────────────────────────────
const callStates = new Map(); // Track call states and transcriptions

// Call state structure:
// {
//   callSid: string,
//   phoneNumber: string,
//   status: 'dialing' | 'connecting' | 'connected' | 'completed',
//   recordingSid: null,
//   recordingStatus: 'none' | 'recording' | 'completed' | 'failed',
//   recordings: [],  // Array of completed recordings
//   startTime: Date,
//   profile: object,  // Active profile configuration
//   shouldRedial: boolean,
//   redialDelay: number
// }

/* ══ 1. Capability token ════════════════════════════════════════ */
app.get('/token', (_req, res) => {
  // Token TTL: Twilio caps client-side tokens at 1 hour (3600 s)
  const TOKEN_TTL = 3600;          // Twilio SDK cap = 1 h

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity: 'browserUser', ttl: TOKEN_TTL }
  );
  token.addGrant(new VoiceGrant({ incomingAllow: true }));
  res.json({ token: token.toJwt() });
});

/* ══ 1b. Refresh token endpoint ═════════════════════════════════ */
app.get('/refresh-token', (_req, res) => {
  const TOKEN_TTL = 3600;
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity: 'browserUser', ttl: TOKEN_TTL }
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

/* ══ 2c. Get available profiles ═════════════════════════════════ */
app.get('/api/profiles', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  const profilesDir = path.join(__dirname, 'public', 'profiles');
  
  try {
    const files = fs.readdirSync(profilesDir);
    const profiles = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const content = fs.readFileSync(path.join(profilesDir, file), 'utf8');
        return JSON.parse(content);
      });
    
    res.json(profiles);
  } catch (err) {
    console.error('Error loading profiles:', err);
    res.json([]);
  }
});

/* ══ 3. Start outbound call ═════════════════════════════════════ */
app.post('/call', async (req, res) => {
  const { phoneNumber, profileId } = req.body;
  
  // Load profile if specified
  let profile = null;
  if (profileId) {
    try {
      const fs = require('fs');
      const path = require('path');
      const profilePath = path.join(__dirname, 'public', 'profiles', `${profileId}.json`);
      const profileContent = fs.readFileSync(profilePath, 'utf8');
      profile = JSON.parse(profileContent);
      console.log(`📋 Using profile: ${profile.name}`);
    } catch (err) {
      console.error(`Failed to load profile ${profileId}:`, err);
    }
  }
  
  try {
    console.log('\n════════════════════════════════════════');
    console.log('📞 POST /call - Creating outbound call');
    console.log('🕐 Time:', new Date().toISOString());
    console.log('📱 Phone number:', phoneNumber);
    console.log('📞 From number:', TWILIO_NUMBER);
    console.log('🔗 Webhook URL:', `${SERVER_URL}/outbound-gather`);
    console.log('🔗 Status callback:', `${SERVER_URL}/call-status`);
    
    if (!SERVER_URL) {
      throw new Error('SERVER_URL is not set! ngrok may have failed to start.');
    }
    
    if (!TWILIO_NUMBER) {
      throw new Error('TWILIO_NUMBER is not set in .env file!');
    }

    const callParams = {
      to: phoneNumber,
      from: TWILIO_NUMBER,
      url: `${SERVER_URL}/outbound-gather`,
      statusCallback: `${SERVER_URL}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      method: 'POST'  // Explicitly set method
    };
    
    console.log('📤 Twilio call parameters:', JSON.stringify(callParams, null, 2));
    
    // Verify webhook URL is accessible
    console.log('🔍 Verifying webhook URL is accessible...');
    if (!SERVER_URL.includes('ngrok')) {
      console.log('⚠️ WARNING: SERVER_URL does not appear to be an ngrok URL');
    }

    const call = await twilioRest.calls.create(callParams);
    
    console.log('🌐 Call webhook will be:', call.url);
    console.log('📞 Twilio Console URL:', `https://console.twilio.com/console/voice/calls/${call.sid}`);

    // Initialize call state
    callStates.set(call.sid, {
      callSid: call.sid,
      phoneNumber: phoneNumber,
      status: 'dialing',
      recordingSid: null,
      recordingStatus: 'none',
      recordings: [],
      startTime: new Date(),
      shouldRedial: false,
      profile: profile,
      redialDelay: 60
    });

    console.log('✅ Call created successfully!');
    console.log(`📞 Call SID: ${call.sid}`);
    console.log(`🔗 Call URL: https://console.twilio.com/console/voice/calls/${call.sid}`);
    console.log('════════════════════════════════════════\n');
    
    res.json({ callSid: call.sid });
  } catch (err) {
    console.error('\n❌ ERROR: Call creation failed!');
    console.error('Error message:', err.message);
    console.error('Error code:', err.code);
    console.error('Full error:', err);
    console.error('════════════════════════════════════════\n');
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


/* ══ 5. Initial outbound call - with recording ══════════════════ */
app.post('/outbound-gather', (req, res) => {
  console.log('\n════════════════════════════════════════');
  console.log('🎆 CRITICAL: /outbound-gather webhook HIT!');
  console.log('📞 /outbound-gather webhook called');
  console.log('🕐 Time:', new Date().toISOString());
  console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
  console.log('🔗 SERVER_URL:', SERVER_URL);
  console.log('🔍 Headers:', req.headers);
  
  try {
    const { CallSid, CallStatus, To, From, Direction } = req.body;
    
    if (!CallSid) {
      console.error('❌ ERROR: No CallSid in request body!');
      const vr = new twilio.twiml.VoiceResponse();
      vr.say('Sorry, an error occurred. Missing call ID.');
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }
    
    console.log(`📱 Call Details:
      - SID: ${CallSid}
      - Status: ${CallStatus}
      - From: ${From} → To: ${To}
    `);
    
    const vr = new twilio.twiml.VoiceResponse();
    
    // Update call state
    const callState = callStates.get(CallSid);
    if (callState) {
      callState.status = 'connecting';
      console.log('✅ Found call state, connecting to browser with recording');
    }
    
    console.log('📞 Connecting to browser with call recording...');
    
    // Connect to browser with recording enabled
    const dial = vr.dial({
      action: `${SERVER_URL}/handle-dial-status/${CallSid}`,
      method: 'POST',
      record: 'record-from-answer-dual',  // Record both sides from answer
      recordingStatusCallback: `${SERVER_URL}/recording-status/${CallSid}`,
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: ['in-progress', 'completed', 'failed']
    });
    dial.client('browserUser');
    
    console.log('🎙️ Browser will connect with dual-channel recording');
    
    const twimlResponse = vr.toString();
    console.log('📤 TwiML Response:');
    console.log(twimlResponse);
    console.log('════════════════════════════════════════\n');
    
    res.type('text/xml').send(twimlResponse);
  } catch (error) {
    console.error('❌ ERROR in /outbound-gather:', error);
    console.error('Stack trace:', error.stack);
    
    const vr = new twilio.twiml.VoiceResponse();
    vr.say('Sorry, an application error occurred.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
});

/* ══ 6. [REMOVED] Real-time transcription endpoints ══════════════ */
// Transcription endpoints removed - using recording instead

/* ══ 7. [REMOVED] Process speech endpoint ════════════════════════ */
// Speech processing endpoint removed - using recording instead

/* ══ 8. Get call state for client ═══════════════════════════════ */
app.get('/call-state/:callSid', (req, res) => {
  const { callSid } = req.params;
  const callState = callStates.get(callSid);
  
  if (!callState) {
    return res.status(404).json({ error: 'Call not found' });
  }
  
  // Return relevant state info
  res.json({
    status: callState.status,
    shouldRedial: callState.shouldRedial,
    redialDelay: callState.redialDelay,
    duration: Date.now() - callState.startTime.getTime(),
    recordingStatus: callState.recordingStatus || 'none',
    recordingSid: callState.recordingSid,
    recordings: callState.recordings || [],
    profile: callState.profile ? {
      id: callState.profile.id,
      name: callState.profile.name,
      icon: callState.profile.icon
    } : null
  });
});

/* ══ 9. Inject speech into active call ══════════════════════════ */
app.post('/inject-speech/:callSid', async (req, res) => {
  const { callSid } = req.params;
  const { text = 'Agent', repeat = 1 } = req.body;
  
  console.log(`💬 Injecting speech into call ${callSid}: "${text}" (repeat: ${repeat})`);
  
  try {
    const callState = callStates.get(callSid);
    if (!callState) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    // Create a conference if not already in one
    // For now, we'll use a simpler approach - modify the call
    // This would require updating the call's TwiML
    
    res.json({ 
      success: true, 
      message: 'Speech injection queued',
      note: 'Feature requires conference setup for live injection'
    });
  } catch (err) {
    console.error('Error injecting speech:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ══ 10. Recording status callback ═══════════════════════════════ */
app.post('/recording-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const { RecordingSid, RecordingStatus, RecordingUrl, RecordingDuration } = req.body;
  
  console.log(`[${callSid}] Recording status: ${RecordingStatus}`);
  
  const callState = callStates.get(callSid);
  if (!callState) {
    console.error(`[${callSid}] No call state found for recording callback`);
    return res.sendStatus(200);
  }
  
  // Update call state with recording info
  if (RecordingStatus === 'in-progress') {
    callState.recordingSid = RecordingSid;
    callState.recordingStatus = 'recording';
    console.log(`[${callSid}] 🔴 Recording started: ${RecordingSid}`);
  } else if (RecordingStatus === 'completed') {
    callState.recordingStatus = 'completed';
    callState.recordingUrl = RecordingUrl;
    callState.recordingDuration = RecordingDuration;
    console.log(`[${callSid}] ✅ Recording completed: ${RecordingDuration}s`);
    console.log(`[${callSid}] 🔗 Recording URL: ${RecordingUrl}`);
    
    // Store recording info
    callState.recordings = callState.recordings || [];
    callState.recordings.push({
      sid: RecordingSid,
      url: RecordingUrl,
      duration: RecordingDuration,
      timestamp: new Date()
    });
  } else if (RecordingStatus === 'failed') {
    callState.recordingStatus = 'failed';
    console.error(`[${callSid}] ❌ Recording failed`);
  }
  
  res.sendStatus(200);
});

/* ══ 11. Say Agent endpoint ═══════════════════════════════════════ */
app.post('/say-agent/:callSid', async (req, res) => {
  const { callSid } = req.params;
  
  console.log(`🗣️ Saying "Agent" into call ${callSid}`);
  
  try {
    const callState = callStates.get(callSid);
    if (!callState) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    // Update the call with TwiML that says "Agent" then reconnects
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Say "Agent" twice with a short pause
    twiml.say({ voice: 'alice' }, 'Agent');
    twiml.pause({ length: 1 });
    twiml.say({ voice: 'alice' }, 'Agent');
    twiml.pause({ length: 1 });
    
    // Redirect back to the gather endpoint to continue listening
    twiml.redirect(`${process.env.SERVER_URL}/outbound-gather/${callState.phoneNumber}`);
    
    // Update the active call
    await twilioRest.calls(callSid).update({
      twiml: twiml.toString()
    });
    
    console.log(`✅ Successfully updated call to say "Agent"`);
    
    res.json({ 
      success: true, 
      message: 'Said "Agent" into the call'
    });
  } catch (err) {
    console.error('Error saying Agent:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ══ 11. [REMOVED] Setup speech recognition ═════════════════════ */
// Speech recognition setup removed - using recording instead

/* ══ 12. [REMOVED] Continue speech recognition ══════════════════ */
// Continue speech recognition removed - using recording instead

/* ══ 13. Handle dial status callback ═════════════════════════════ */
app.post('/handle-dial-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const { DialCallStatus } = req.body;
  
  console.log(`[${callSid}] Dial status: ${DialCallStatus}`);
  
  const callState = callStates.get(callSid);
  if (callState) {
    if (DialCallStatus === 'answered') {
      callState.browserConnected = true;
      callState.status = 'connected';
      console.log(`[${callSid}] ✅ Browser connected successfully`);
    } else if (DialCallStatus === 'completed') {
      callState.browserConnected = false;
      console.log(`[${callSid}] 📴 Browser disconnected`);
    }
  }
  
  res.sendStatus(200);
});

/* ══ 12. Call-status webhook ═════════════════════════════════════ */
app.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, To, From } = req.body;
  
  console.log('\n════════════════════════════════════════');
  console.log(`📞 Call Status Update: ${CallStatus}`);
  console.log(`🕐 Time: ${new Date().toISOString()}`);
  console.log(`📞 Call SID: ${CallSid}`);
  console.log(`📱 From: ${From} → To: ${To}`);
  if (CallDuration) console.log(`⏱️  Duration: ${CallDuration} seconds`);
  
  const callState = callStates.get(CallSid);
  if (callState) {
    callState.lastStatus = CallStatus;
    
    // Update call status
    if (CallStatus === 'completed') {
      console.log(`✅ Call completed.`);
      console.log(`🔄 Should redial: ${callState.shouldRedial}`);
      console.log(`🔴 Recording status: ${callState.recordingStatus || 'none'}`);
      
      // Clean up state after 5 minutes
      setTimeout(() => {
        callStates.delete(CallSid);
      }, 5 * 60 * 1000);
    } else if (CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
      console.log(`❌ Call failed with status: ${CallStatus}`);
    } else if (CallStatus === 'answered') {
      console.log(`🎯 Call answered - webhook should be called soon`);
    }
  } else {
    console.log('⚠️  No call state found for this call');
  }
  
  console.log('════════════════════════════════════════\n');
  res.sendStatus(200);
});

/* ══ 12. Start server ════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Validate required environment variables
    console.log('🔍 Checking environment variables...');
    const requiredVars = {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      TWILIO_NUMBER
    };
    
    const missing = [];
    for (const [key, value] of Object.entries(requiredVars)) {
      if (!value) {
        missing.push(key);
      }
    }
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(key => console.error(`   - ${key}`));
      console.error('\nPlease set these in your .env file');
      process.exit(1);
    }
    
    console.log('✅ All required environment variables are set');
    console.log(`📞 Twilio phone number: ${TWILIO_NUMBER}`);
    
    // Start the Express server
    const server = app.listen(PORT, async () => {
      console.log(`✅ Dialbot server running on port ${PORT}`);
      
      // Check SERVER_URL configuration
      if (SERVER_URL && SERVER_URL.startsWith('https://')) {
        console.log(`✅ Using SERVER_URL: ${SERVER_URL}`);
        console.log('📝 Make sure your ngrok tunnel is active!\n');
      } else {
        console.log('\n⚠️  WARNING: No SERVER_URL configured!');
        console.log('\n📋 To fix this:');
        console.log('1. Open a new terminal');
        console.log('2. Run: ngrok http 3000');
        console.log('3. Copy the HTTPS URL (e.g., https://abc123.ngrok.io)');
        console.log('4. Add to your .env file: SERVER_URL=https://abc123.ngrok.io');
        console.log('5. Restart this server\n');
        console.log('🚀 For now, the server will run but Twilio webhooks won\'t work.\n');
        
        // Set a dummy URL so the server doesn't crash
        SERVER_URL = 'http://localhost:3000';
      }
      
      console.log('🔗 Twilio webhook URLs:');
      console.log(`   - Voice URL: ${SERVER_URL}/outbound-gather`);
      console.log(`   - Status Callback: ${SERVER_URL}/call-status`);
      console.log(`   - Recording Status: ${SERVER_URL}/recording-status/:callSid`);
      console.log(`   - Dial Status: ${SERVER_URL}/handle-dial-status/:callSid\n`);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('📴 Shutting down gracefully...');
      server.close(() => {
        console.log('👋 Server closed');
      });
    });
    
    process.on('SIGINT', async () => {
      console.log('\n📴 Shutting down gracefully...');
      server.close(() => {
        console.log('👋 Server closed');
        process.exit(0);
      });
    });
    
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

// Start the server
startServer();
