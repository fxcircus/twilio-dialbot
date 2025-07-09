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
//   status: 'dialing' | 'ivr_detected' | 'waiting' | 'human_detected' | 'connected',
//   transcriptions: [],
//   humanDetected: false,
//   recordingSid: null,
//   startTime: Date
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

/* ══ 3. Start outbound call ═════════════════════════════════════ */
app.post('/call', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    console.log('\n════════════════════════════════════════');
    console.log('📞 POST /call - Creating outbound call');
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
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    };
    
    console.log('📤 Twilio call parameters:', JSON.stringify(callParams, null, 2));

    const call = await twilioRest.calls.create(callParams);

    // Initialize call state
    callStates.set(call.sid, {
      callSid: call.sid,
      phoneNumber: phoneNumber,
      status: 'dialing',
      transcriptions: [],
      humanDetected: false,
      recordingSid: null,
      startTime: new Date(),
      shouldRedial: false
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

/* ══ 5. Initial outbound call - with speech recognition ═════════ */
app.post('/outbound-gather', (req, res) => {
  console.log('\n════════════════════════════════════════');
  console.log('📞 /outbound-gather webhook called');
  console.log('🕐 Time:', new Date().toISOString());
  console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
  console.log('🔗 SERVER_URL:', SERVER_URL);
  
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
      callState.status = 'listening';
      console.log('✅ Found call state, status updated to: listening');
    }
    
    // Enable speech recognition with Gather
    console.log('🎤 Setting up speech recognition...');
    const gather = vr.gather({
      input: 'speech',
      speechTimeout: 3,  // 3 seconds of silence will complete the gather
      timeout: 30,       // Total timeout of 30 seconds
      language: 'en-US',
      partialResultCallback: `${SERVER_URL}/transcribe/${CallSid}`,
      action: `${SERVER_URL}/process-speech/${CallSid}`,
      method: 'POST',
      hints: 'agent, representative, dmv, department of motor vehicles, all agents are busy, please call back later, try your call again'
    });
    
    // Keep listening
    gather.pause({ length: 30 });
    
    const twimlResponse = vr.toString();
    console.log('📤 TwiML Response with speech recognition enabled');
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

/* ══ 6. Real-time partial transcription ═════════════════════════ */
app.post('/transcribe/:callSid', (req, res) => {
  const { callSid } = req.params;
  const { UnstableSpeechResult, StableSpeechResult, SequenceNumber } = req.body;
  
  const callState = callStates.get(callSid);
  if (!callState) {
    return res.sendStatus(200);
  }
  
  const transcript = StableSpeechResult || UnstableSpeechResult || '';
  
  if (transcript) {
    console.log(`[${callSid}] ${StableSpeechResult ? 'Stable' : 'Unstable'}: ${transcript}`);
    
    // Check if this is just a minor variation of the last transcript
    const lastTranscript = callState.transcriptions[callState.transcriptions.length - 1];
    const isMinorVariation = lastTranscript && 
                           lastTranscript.type === 'unstable' && 
                           !StableSpeechResult &&
                           Math.abs(transcript.length - lastTranscript.text.length) <= 3 &&
                           (transcript.includes(lastTranscript.text) || lastTranscript.text.includes(transcript));
    
    // Only store if it's not a minor variation
    if (!isMinorVariation) {
      callState.transcriptions.push({
        text: transcript,
        timestamp: new Date(),
        type: StableSpeechResult ? 'stable' : 'unstable',
        sequence: SequenceNumber
      });
    }
    
    // Check for DMV patterns
    const lowerTranscript = transcript.toLowerCase();
    
    // Pattern 1: "all agents are busy" or variations
    if (lowerTranscript.includes('all agents are') || 
        lowerTranscript.includes('agents are currently busy') ||
        lowerTranscript.includes('call back later') ||
        lowerTranscript.includes('try your call later') ||
        lowerTranscript.includes('try your call again') ||
        lowerTranscript.includes('please call back') ||
        lowerTranscript.includes('try again later')) {
      console.log(`[${callSid}] ⚠️ AGENTS BUSY PATTERN DETECTED in transcript: "${transcript}"`);
      callState.status = 'agents_busy';
      callState.shouldRedial = true; // Set redial flag immediately
      
      // Add system message
      callState.transcriptions.push({
        text: "⚠️ Detected: All agents busy message",
        timestamp: new Date(),
        type: 'system',
        sequence: -2
      });
    }
    
    // Pattern 2: "Welcome to the DMV" or Florida DMV variations
    if (lowerTranscript.includes('welcome to the dmv') || 
        lowerTranscript.includes('department of motor vehicles') ||
        lowerTranscript.includes('department of highway safety') ||
        lowerTranscript.includes('florida department of highway')) {
      console.log(`[${callSid}] Detected: DMV IVR system`);
      callState.status = 'ivr_detected';
      
      // Add system message
      callState.transcriptions.push({
        text: "🏢 Detected: DMV IVR system",
        timestamp: new Date(),
        type: 'system',
        sequence: -2
      });
    }
    
    // Human detection patterns
    const humanPatterns = [
      'how can i help',
      'speaking',
      'this is',
      'good morning',
      'good afternoon',
      'hello',
      'yes?'
    ];
    
    if (humanPatterns.some(pattern => lowerTranscript.includes(pattern))) {
      console.log(`[${callSid}] Potential human detected!`);
      callState.humanDetected = true;
      callState.status = 'human_detected';
    }
  }
  
  res.sendStatus(200);
});

/* ══ 7. Process complete speech results ═════════════════════════ */
app.post('/process-speech/:callSid', async (req, res) => {
  const { callSid } = req.params;
  const { SpeechResult } = req.body;
  
  const callState = callStates.get(callSid);
  if (!callState) {
    return res.sendStatus(200);
  }
  
  console.log(`[${callSid}] Complete speech: ${SpeechResult}`);
  
  const vr = new twilio.twiml.VoiceResponse();
  
  // Handle different states
  console.log(`[${callSid}] Processing speech - Current status: ${callState.status}`);
  
  if (callState.status === 'agents_busy') {
    // Set redial flag and hang up
    callState.shouldRedial = true;
    console.log(`[${callSid}] ✅ AGENTS BUSY DETECTED - Setting redial flag and hanging up`);
    
    // Add system message to transcript
    callState.transcriptions.push({
      text: "🔄 All agents busy - hanging up and scheduling redial",
      timestamp: new Date(),
      type: 'system',
      sequence: -1
    });
    
    vr.hangup();
  } else if (callState.status === 'ivr_detected' && !callState.humanDetected) {
    // Say "Agent" twice
    console.log(`[${callSid}] Saying 'Agent' to navigate IVR`);
    
    // Add system message to transcript
    callState.transcriptions.push({
      text: "🤖 Saying 'Agent' to navigate DMV menu",
      timestamp: new Date(),
      type: 'system',
      sequence: -1
    });
    
    vr.say('Agent');
    vr.pause({ length: 2 });
    vr.say('Agent');
    vr.pause({ length: 2 });
    
    // Continue listening
    const gather = vr.gather({
      input: 'speech',
      speechTimeout: 3,
      timeout: 30,
      language: 'en-US',
      partialResultCallback: `${SERVER_URL}/transcribe/${callSid}`,
      action: `${SERVER_URL}/process-speech/${callSid}`,
      method: 'POST',
      hints: 'agent, representative, try your call again, all agents are busy'
    });
    gather.pause({ length: 30 });
  } else if (callState.humanDetected) {
    // Human detected! Connect to browser and start recording
    console.log(`[${callSid}] Human detected! Connecting to browser...`);
    
    // Start recording now
    try {
      const recording = await twilioRest.calls(callSid)
        .recordings
        .create({ recordingChannels: 'dual' });
      callState.recordingSid = recording.sid;
      console.log(`[${callSid}] Started recording: ${recording.sid}`);
    } catch (err) {
      console.error(`[${callSid}] Failed to start recording:`, err);
    }
    
    // Connect to browser
    callState.status = 'connected';
    const dial = vr.dial();
    dial.client('browserUser');
  } else {
    // Continue listening
    const gather = vr.gather({
      input: 'speech',
      speechTimeout: 3,
      timeout: 30,
      language: 'en-US',
      partialResultCallback: `${SERVER_URL}/transcribe/${callSid}`,
      action: `${SERVER_URL}/process-speech/${callSid}`,
      method: 'POST',
      hints: 'agent, representative, try your call again, all agents are busy'
    });
    gather.pause({ length: 30 });
  }
  
  res.type('text/xml').send(vr.toString());
});

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
    humanDetected: callState.humanDetected,
    shouldRedial: callState.shouldRedial,
    transcriptions: callState.transcriptions.slice(-20), // Last 20 transcriptions
    duration: Date.now() - callState.startTime.getTime()
  });
});

/* ══ 9. Call-status webhook ═════════════════════════════════════ */
app.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, To, From } = req.body;
  
  console.log('\n════════════════════════════════════════');
  console.log(`📞 Call Status Update: ${CallStatus}`);
  console.log(`📞 Call SID: ${CallSid}`);
  console.log(`📱 From: ${From} → To: ${To}`);
  if (CallDuration) console.log(`⏱️  Duration: ${CallDuration} seconds`);
  
  const callState = callStates.get(CallSid);
  if (callState) {
    callState.lastStatus = CallStatus;
    
    // Update call status
    if (CallStatus === 'completed') {
      console.log(`✅ Call completed. Human detected: ${callState.humanDetected}`);
      console.log(`📝 Total transcriptions: ${callState.transcriptions.length}`);
      
      // Clean up state after 5 minutes
      setTimeout(() => {
        callStates.delete(CallSid);
      }, 5 * 60 * 1000);
    } else if (CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
      console.log(`❌ Call failed with status: ${CallStatus}`);
    }
  } else {
    console.log('⚠️  No call state found for this call');
  }
  
  console.log('════════════════════════════════════════\n');
  res.sendStatus(200);
});

/* ══ 10. Start server ════════════════════════════════════════════ */
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
      console.log(`   - Transcribe Callback: ${SERVER_URL}/transcribe/:callSid`);
      console.log(`   - Process Speech: ${SERVER_URL}/process-speech/:callSid\n`);
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
