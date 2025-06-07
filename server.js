// server.js - Twilio Client Server Example
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const path = require('path');

// Environment variables - replace these in your .env file
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_NUMBER,
  TWIML_APP_SID, // Optional TwiML App SID for outgoing calls
  NUMBER_TO_CALL, // Pre-filled phone number
  SERVER_URL,
  PORT = 3000
} = process.env;

// Debug environment variables on startup
console.log('Environment variables loaded:');
console.log(`TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'Found' : 'Missing'}`);
console.log(`TWILIO_AUTH_TOKEN: ${TWILIO_AUTH_TOKEN ? 'Found' : 'Missing'}`);
console.log(`TWILIO_API_KEY_SID: ${TWILIO_API_KEY_SID ? 'Found' : 'Missing'}`);
console.log(`TWILIO_API_KEY_SECRET: ${TWILIO_API_KEY_SECRET ? 'Found' : 'Missing'}`);
console.log(`TWILIO_NUMBER: ${TWILIO_NUMBER ? 'Found' : 'Missing'}`);
console.log(`TWIML_APP_SID: ${TWIML_APP_SID ? 'Found' : 'Not provided (optional)'}`);
console.log(`NUMBER_TO_CALL: ${NUMBER_TO_CALL ? 'Found' : 'Not provided (optional)'}`);
console.log(`SERVER_URL: ${SERVER_URL ? 'Found' : 'Missing'}`);

// Initialize Express app
const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Twilio client - with error handling
let twilioClient;
try {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('Twilio credentials missing. Check your .env file.');
  } else {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
} catch (error) {
  console.error('Error initializing Twilio client:', error.message);
}

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// In-memory store for SSE connections
const sseConnections = new Map();

// GET /token - Generate a Twilio Access Token with Voice Grant
app.get('/token', (req, res) => {
  const identity = 'browserUser';
  
  console.log('Token request received. Generating token with:');
  console.log(`- TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.substring(0, 6) + '...' : 'Missing'}`);
  console.log(`- TWILIO_API_KEY_SID: ${TWILIO_API_KEY_SID ? TWILIO_API_KEY_SID.substring(0, 6) + '...' : 'Missing'}`);
  console.log(`- TWILIO_API_KEY_SECRET: ${TWILIO_API_KEY_SECRET ? 'Present (hidden)' : 'Missing'}`);
  
  // Check for missing credentials
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET) {
    console.error('Missing Twilio credentials. Check your .env file.');
    return res.status(500).json({ 
      error: 'Server configuration error. Missing Twilio credentials.',
      missingCredentials: {
        accountSid: !TWILIO_ACCOUNT_SID,
        apiKeySid: !TWILIO_API_KEY_SID,
        apiKeySecret: !TWILIO_API_KEY_SECRET
      }
    });
  }
  
  try {
    // Create Voice Grant with proper configuration
    const voiceGrant = new VoiceGrant();
    
    // Allow incoming calls
    voiceGrant.incomingAllow = true;
    
    // Set up outgoing call options if TwiML App SID is provided
    if (TWIML_APP_SID) {
      voiceGrant.outgoingApplicationSid = TWIML_APP_SID;
      console.log(`Voice Grant created with TwiML App SID: ${TWIML_APP_SID.substring(0, 6)}...`);
    } else {
      // For this demo, we'll allow outgoing calls without a TwiML App
      // The client will need to use the server's /call endpoint instead
      console.log('Voice Grant created without TwiML App SID - using server-side calling');
    }
    
    // Create the access token
    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity: identity }
    );
    
    // Add the Voice Grant to the token
    token.addGrant(voiceGrant);
    
    const tokenString = token.toJwt();
    console.log(`Token generated successfully: ${tokenString.substring(0, 20)}...`);
    
    // Debug: Log token payload for troubleshooting
    try {
      const tokenParts = tokenString.split('.');
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
      console.log('Token payload (grants):', JSON.stringify(payload.grants, null, 2));
      console.log('Token identity:', payload.grants?.identity || 'NOT FOUND');
      console.log('Token subject (sub):', payload.sub);
      console.log('Token issuer:', payload.iss);
      console.log('Token expires at:', new Date(payload.exp * 1000).toISOString());
    } catch (debugError) {
      console.warn('Could not decode token for debugging:', debugError.message);
    }
    
    // Return the token as JSON with additional config
    res.json({
      token: tokenString,
      identity,
      config: {
        numberToCall: NUMBER_TO_CALL || '',
        twilioNumber: TWILIO_NUMBER
      }
    });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /call - Place a call from Twilio number to provided phone number
app.post('/call', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  // Check for missing configuration
  if (!twilioClient) {
    return res.status(500).json({ error: 'Twilio client not initialized. Check server logs.' });
  }
  
  if (!TWILIO_NUMBER) {
    return res.status(500).json({ error: 'TWILIO_NUMBER environment variable is missing' });
  }
  
  if (!SERVER_URL) {
    return res.status(500).json({ error: 'SERVER_URL environment variable is missing' });
  }
  
  try {
    console.log(`Placing call to ${phoneNumber} from ${TWILIO_NUMBER}`);
    
    // Place a call using Twilio API
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      url: `${SERVER_URL}/twiml?client=browserUser`,
      // Add status callback to track call progress
      statusCallback: `${SERVER_URL}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    
    console.log(`Call initiated with SID: ${call.sid}`);
    
    // Return call SID
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('Error placing call:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /end-call - End an active call
app.post('/end-call', async (req, res) => {
  const { callSid } = req.body;
  
  if (!callSid) {
    return res.status(400).json({ error: 'Call SID is required' });
  }
  
  if (!twilioClient) {
    return res.status(500).json({ error: 'Twilio client not initialized. Check server logs.' });
  }
  
  try {
    console.log(`Ending call with SID: ${callSid}`);
    
    // Update the call to end it
    const call = await twilioClient.calls(callSid).update({
      status: 'completed'
    });
    
    console.log(`Call ${callSid} ended successfully`);
    
    // Return success
    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (error) {
    console.error('Error ending call:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /call-status - Receive call status updates from Twilio
app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  console.log(`Call ${callSid} status changed to: ${callStatus}`);
  
  // Log additional information if available
  if (req.body.CallDuration) {
    console.log(`Call duration: ${req.body.CallDuration} seconds`);
  }
  
  // Broadcast status update to all connected SSE clients
  const statusUpdate = {
    callSid,
    status: callStatus,
    duration: req.body.CallDuration || null,
    timestamp: new Date().toISOString()
  };
  
  sseConnections.forEach((res, clientId) => {
    try {
      res.write(`data: ${JSON.stringify(statusUpdate)}\n\n`);
    } catch (error) {
      console.log(`Removing disconnected SSE client: ${clientId}`);
      sseConnections.delete(clientId);
    }
  });
  
  // Send an empty response to acknowledge receipt
  res.sendStatus(200);
});

// GET /call-status-stream - SSE endpoint for real-time call status updates
app.get('/call-status-stream', (req, res) => {
  const clientId = req.query.clientId || `client_${Date.now()}`;
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Store the connection
  sseConnections.set(clientId, res);
  console.log(`SSE client connected: ${clientId}`);
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  
  // Clean up on client disconnect
  req.on('close', () => {
    console.log(`SSE client disconnected: ${clientId}`);
    sseConnections.delete(clientId);
  });
});

// POST /twiml - Generate TwiML to connect the call to the browser client
app.post('/twiml', (req, res) => {
  const client = req.query.client || 'browserUser';
  
  console.log('🎯 TwiML POST REQUEST RECEIVED');
  console.log(`🎯 Generating TwiML for outgoing call to client: ${client}`);
  console.log('🎯 Request details:', {
    method: 'POST',
    query: req.query,
    body: req.body,
    headers: {
      'User-Agent': req.headers['user-agent'],
      'X-Twilio-Signature': req.headers['x-twilio-signature']
    }
  });
  
  // Create TwiML response
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial().client(client);
  
  const twimlString = twiml.toString();
  console.log('🎯 Generated TwiML:', twimlString);
  console.log('🎯 This should trigger an incoming call to the browser');
  
  // Set Content-Type to text/xml and send TwiML
  res.type('text/xml');
  res.send(twimlString);
  
  console.log('🎯 TwiML response sent - browser should receive incoming call now');
});

// Add a GET route for /twiml as well (Twilio might call this as GET)
app.get('/twiml', (req, res) => {
  const client = req.query.client || 'browserUser';
  
  console.log('🎯 TwiML GET REQUEST RECEIVED');
  console.log(`🎯 Generating TwiML for outgoing call to client: ${client}`);
  console.log('🎯 Request details:', {
    method: 'GET',
    query: req.query,
    headers: {
      'User-Agent': req.headers['user-agent'],
      'X-Twilio-Signature': req.headers['x-twilio-signature']
    }
  });
  
  // Create TwiML response
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial().client(client);
  
  const twimlString = twiml.toString();
  console.log('🎯 Generated TwiML:', twimlString);
  console.log('🎯 This should trigger an incoming call to the browser');
  
  // Set Content-Type to text/xml and send TwiML
  res.type('text/xml');
  res.send(twimlString);
  
  console.log('🎯 TwiML response sent - browser should receive incoming call now');
});

// POST /log-client-error - Endpoint to receive client-side errors
app.post('/log-client-error', (req, res) => {
  const errorData = req.body;
  
  // Handle both single errors and arrays of errors
  if (Array.isArray(errorData) || (errorData.errors && Array.isArray(errorData.errors))) {
    const errors = Array.isArray(errorData) ? errorData : errorData.errors;
    console.error(`CLIENT ERROR REPORT: Received ${errors.length} errors`);
    
    errors.forEach((error, index) => {
      console.error(`\n--- Error ${index + 1} of ${errors.length} ---`);
      logErrorDetails(error);
    });
  } else {
    console.error('CLIENT ERROR REPORTED:');
    logErrorDetails(errorData);
  }
  
  // Return a simple response
  res.json({ received: true });
});

// Helper function to log error details
function logErrorDetails(error) {
  if (!error) {
    console.error('Empty error object received');
    return;
  }
  
  // Special formatting for debug messages
  if (error.type && error.type.includes('debug')) {
    console.log('🔍 CLIENT DEBUG:', error.message || 'No message provided');
    console.log('🔍 Type:', error.type || 'Unknown type');
    console.log('🔍 Source:', error.source || 'Unknown source');
    
    if (error.additionalInfo) {
      console.log('🔍 Additional Info:', JSON.stringify(error.additionalInfo, null, 2));
    }
    
    // Special handling for incoming call events
    if (error.type === 'incoming-call-debug') {
      console.log('📞 *** INCOMING CALL DETECTED IN BROWSER ***');
      console.log('📞 This means TwiML was processed and browser should accept the call');
    } else if (error.type === 'incoming-call-accepted') {
      console.log('✅ *** INCOMING CALL ACCEPTED IN BROWSER ***');
      console.log('✅ Browser successfully accepted the connection');
    } else if (error.type === 'audio-ready-debug') {
      console.log('🎵 *** AUDIO CONNECTION READY ***');
      console.log('🎵 Bidirectional audio should be working now');
    }
    
    console.log('🔍 Timestamp:', error.timestamp || new Date().toISOString());
    console.log('---');
    return;
  }
  
  // Regular error formatting
  console.error('Message:', error.message || 'No message provided');
  console.error('Type:', error.type || 'Unknown type');
  console.error('Source:', error.source || 'Unknown source');
  console.error('Line:', error.line || 'Unknown line');
  console.error('Column:', error.column || 'Unknown column');
  
  if (error.stack) {
    console.error('Stack:', error.stack);
  }
  
  console.error('URL:', error.url || 'Unknown URL');
  console.error('User Agent:', error.userAgent || 'Unknown User Agent');
  console.error('Timestamp:', error.timestamp || new Date().toISOString());
}

// GET /reload-client - Force clients to reload
app.get('/reload-client', (req, res) => {
  console.log('Client reload requested');
  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="0; url=/?v=${Date.now()}">
      </head>
      <body>
        <p>Reloading...</p>
        <script>
          // Force reload bypassing the cache
          window.location.href = "/?v=" + Date.now();
        </script>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Current SERVER_URL: ${SERVER_URL || 'Not set'}`);
  console.log(`To run with ngrok: ngrok http ${PORT}`);
  console.log(`Ensure all Twilio environment variables are set in your .env file`);
});

/*
SETUP INSTRUCTIONS:

1. Install dependencies:
   npm install express body-parser twilio dotenv

2. Create a .env file with the following variables:
   TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_API_KEY_SID=SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   TWILIO_API_KEY_SECRET=your_api_key_secret
   TWILIO_NUMBER=+1YourTwilioNumber
   SERVER_URL=https://your-public-url.ngrok.io

3. Run ngrok to expose your local server:
   ngrok http 3000

4. Update SERVER_URL in .env with the ngrok URL

5. Start the server:
   node server.js

6. Open the browser at SERVER_URL or http://localhost:3000
*/
