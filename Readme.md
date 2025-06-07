# Twilio Dialbot

Browser-to-phone bridge built with Twilio Client SDK v1.13 and Node.js.



## Environment Variables

Create a `.env` file with the following variables:

```ini
# Twilio Account Credentials
TWILIO_ACCOUNT_SID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx # https://console.twilio.com/ ➜ Account SID
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx # https://console.twilio.com/ ➜ Auth Token

# Twilio API Keys (for generating access tokens)
TWILIO_API_KEY_SID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx # Create from https://console.twilio.com/ ➜ API keys
TWILIO_API_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Twilio Phone Numbers and Apps
TWILIO_NUMBER=+1xxxxxxxxxx                           # Your Twilio phone number
TWIML_APP_SID=AP37xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # Create TwiML App from https://console.twilio.com/ ➜ Phone Numbers ➜ Manage ➜ TwiML Apps

# Server Configuration
SERVER_URL=https://xxx-xx-xxx-xxx-xxx.ngrok-free.app # Your public HTTPS URL (ngrok, etc.)
PORT=3000                                            # Local server port (optional, defaults to 3000)

# Default Number (optional)
NUMBER_TO_CALL=+1xxxxxxxxxx                         # Pre-fill phone number field (optional)
```


## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-user/twilio-dial-bridge.git
cd twilio-dial-bridge
npm install

# 2. Create .env
cp .env.example .env            # then edit with your credentials

# 3. Run locally
node server.js                  # default port 3000

# 4. Expose to the internet (ngrok or similar)
ngrok http 3000                 # copy the HTTPS URL into SERVER_URL in .env

# 5. Open the app
open https://<your-ngrok>.ngrok-free.app
```

## Usage

1. Enter a phone number in E.164 format (`+1…`) and press **Call**
2. When the call connects, the page shows "Connected – speak!"
3. Use the keypad to send menu options, or press **End Call** to hang up

## Folder Structure

```
server.js            # Express server: /token, /call, /twiml, /end-call
public/
  └── index.html     # Front-end UI and Twilio Client logic
.env.example         # Sample environment file
README.md            # This file