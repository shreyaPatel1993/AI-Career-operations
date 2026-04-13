import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, 'config', 'gmail-oauth.json');
const TOKEN_PATH = path.join(__dirname, 'config', '.gmail-token.json');

// Load credentials
function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Gmail OAuth credentials not found at ${CREDENTIALS_PATH}`);
  }
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(raw).installed;
}

// Get OAuth2 client
function getAuth(credentials) {
  const { client_id, client_secret, redirect_uris } = credentials;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Load or refresh token
async function getAccessToken(auth) {
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    auth.setCredentials(token);

    // Refresh if expired
    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const { credentials } = await auth.refreshAccessToken();
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
      auth.setCredentials(credentials);
    }
    return auth;
  }

  // First time: guide user through OAuth
  console.log('\n🔐 Gmail authentication needed.');

  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  });

  console.log('   1. Open this URL in your browser:');
  console.log(`   ${authUrl}\n`);
  console.log('   2. Grant permission to access Gmail');
  console.log('   3. You will be redirected to http://localhost with a code\n');

  // Start local server to capture OAuth code
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>✅ Gmail authenticated!</h1><p>You can close this window and return to the terminal.</p>');
        server.close();

        try {
          const { tokens } = await auth.getToken(code);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          auth.setCredentials(tokens);
          console.log('   ✅ OAuth token saved!\n');
          resolve(auth);
        } catch (err) {
          reject(err);
        }
      } else {
        res.writeHead(400);
        res.end('Missing authorization code');
      }
    });

    // Try to listen on port 80, fall back to 3000 if not available
    server.listen(80, () => {
      console.log('   Waiting for OAuth callback on http://localhost...\n');
    }).on('error', () => {
      server.listen(3000, () => {
        console.log('   Waiting for OAuth callback on http://localhost:3000...\n');
        console.log('   (Port 80 unavailable, using 3000 instead)\n');
      });
    });

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout after 5 minutes'));
    }, 5 * 60 * 1000); // 5 minute timeout
  });
}

function extractBodyFromMessage(emailData) {
  let body = '';
  function walkParts(parts) {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
        if (part.body?.data) body += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) walkParts(part.parts); // nested multipart
    }
  }
  if (emailData.payload.parts) {
    walkParts(emailData.payload.parts);
  } else if (emailData.payload.body?.data) {
    body = Buffer.from(emailData.payload.body.data, 'base64').toString('utf-8');
  }
  return body;
}

function extractCode(rawBody) {
  // Strip HTML tags so regex works on clean text
  const body = rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return (
    // Greenhouse pattern: "application: jWhuxElU" or "code: jWhuxElU"
    body.match(/(?:application|field)[^:]*:\s*([A-Za-z0-9]{6,12})/)?.[1] ||
    // Generic colon-delimited code: ": XXXXXX"
    body.match(/:\s+([A-Za-z0-9]{6,12})(?:\s|$)/)?.[1] ||
    // 6-digit numeric code
    body.match(/\b([0-9]{6})\b/)?.[1] ||
    null
  );
}

// Fetch verification code from latest Greenhouse email — polls Gmail until email arrives.
// `afterMs` (epoch ms) filters out emails received BEFORE this timestamp so we never
// reuse a code from a previous run.
export async function fetchVerificationCodeFromGmail({ maxWaitMs = 30000, pollIntervalMs = 4000, afterMs = null } = {}) {
  try {
    const credentials = loadCredentials();
    const auth = getAuth(credentials);
    const authedAuth = await getAccessToken(auth);
    const gmail = google.gmail({ version: 'v1', auth: authedAuth });

    // Build query. When afterMs is provided, use `after:` epoch-seconds so Gmail
    // only returns emails received AFTER the submit click — not old codes from
    // previous runs which newer_than:5m would incorrectly include.
    let q;
    if (afterMs) {
      const afterSecs = Math.floor(afterMs / 1000);
      q = `from:greenhouse-mail.io after:${afterSecs}`;
    } else {
      q = 'from:greenhouse-mail.io newer_than:5m';
    }

    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      console.log(`\n📧 Checking Gmail for Greenhouse code (attempt ${attempt})...`);

      const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });

      if (res.data.messages?.length) {
        for (const msgRef of res.data.messages) {
          const message = await gmail.users.messages.get({
            userId: 'me',
            id: msgRef.id,
            format: 'full',
          });

          // Skip emails received before the submit click (stale code guard)
          if (afterMs) {
            const msgDate = parseInt(message.data.internalDate ?? '0', 10);
            if (msgDate < afterMs) {
              console.log(`  ⏭ Skipping old email (arrived before submit click): id=${msgRef.id}`);
              continue;
            }
          }

          const body = extractBodyFromMessage(message.data);
          const code = extractCode(body);

          if (code) {
            console.log(`  ✅ Code extracted: ${code}`);
            return code;
          }

          console.log('  ⚠ Email found but no code pattern matched. Retrying...');
        }
      } else {
        console.log('  ⏳ Email not arrived yet. Waiting...');
      }

      if (Date.now() + pollIntervalMs < deadline) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
    }

    throw new Error(`No verification code found after ${maxWaitMs / 1000}s`);
  } catch (err) {
    console.error('\n❌ Gmail error:', err.message);
    throw err;
  }
}
