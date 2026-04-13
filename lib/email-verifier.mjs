/**
 * lib/email-verifier.mjs — Gmail-based verification code poller
 *
 * Used by auto-apply.mjs to read one-time codes sent by ATS platforms
 * (Greenhouse security codes, Workday account verification, etc.)
 *
 * Requires: Gmail MCP tools to be available in the Claude Code session.
 * In batch/headless mode (auto-apply.mjs), these are called via the MCP client.
 *
 * Usage:
 *   import { waitForVerificationCode } from './lib/email-verifier.mjs';
 *   const code = await waitForVerificationCode({ timeoutMs: 60000 });
 *   if (code) await page.fill('#security_code', code);
 */

/**
 * Known ATS senders that email verification codes.
 * Used to build the Gmail search query.
 */
const ATS_SENDERS = [
  'greenhouse.io',
  'greenhouse-mail.io',
  'lever.co',
  'ashbyhq.com',
  'workday.com',
  'myworkday.com',
  'bamboohr.com',
  'smartrecruiters.com',
  'jobvite.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'noreply@',          // many ATS send from noreply addresses
];

/**
 * Regex patterns to extract verification codes from email body text.
 * Ordered from most to least specific.
 */
const CODE_PATTERNS = [
  /\b([A-Z0-9]{6,8})\b(?=.*(?:code|verify|verification|access|security))/i,
  /(?:code|pin|otp|token)[:\s]+([A-Z0-9]{4,8})/i,
  /(?:your|the)\s+(?:verification|security|access|one.time)\s+code\s+is[:\s]+([A-Z0-9]{4,8})/i,
  /\b(\d{6})\b/,   // bare 6-digit number (most common OTP format)
  /\b([A-Z0-9]{8})\b/, // bare 8-char alphanumeric (Greenhouse format)
];

/**
 * Extract a verification code from email body text.
 * @param {string} text - email body or snippet
 * @returns {string|null}
 */
export function extractCode(text) {
  if (!text) return null;
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const code = match[1].trim();
      // Filter out obviously wrong matches (dates, zip codes, phone fragments)
      if (code.length >= 4 && code.length <= 8) return code;
    }
  }
  return null;
}

/**
 * Poll Gmail for a verification code email.
 *
 * This function is designed to be called with a Gmail MCP caller function
 * so it can work both in interactive Claude Code sessions and in auto-apply
 * batch mode where we pass MCP tool wrappers.
 *
 * @param {object} options
 * @param {function} options.searchMessages  - gmail_search_messages MCP tool wrapper
 * @param {function} options.readMessage     - gmail_read_message MCP tool wrapper
 * @param {string}   [options.recipientEmail] - candidate's email (for targeted search)
 * @param {string}   [options.company]       - company name (for logging)
 * @param {number}   [options.timeoutMs]     - max wait in ms (default 60000)
 * @param {number}   [options.pollIntervalMs] - poll interval in ms (default 5000)
 * @returns {Promise<string|null>} - the code, or null if timed out
 */
export async function waitForVerificationCode({
  searchMessages,
  readMessage,
  recipientEmail = '',
  company = '',
  timeoutMs = 60000,
  pollIntervalMs = 5000,
} = {}) {
  if (!searchMessages || !readMessage) {
    console.log('  ⚠ Email verifier: MCP tools not provided — skipping code poll');
    return null;
  }

  const label = company ? `[${company}]` : '';
  console.log(`\n📬 ${label} Polling Gmail for verification code (up to ${timeoutMs / 1000}s)...`);

  // Build search query: recent emails from known ATS senders mentioning codes
  const senderQuery = ATS_SENDERS.slice(0, 6).map(s => `from:${s}`).join(' OR ');
  const query = `(${senderQuery}) subject:(verification OR code OR security OR access OR "one-time") newer_than:5m`;

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    try {
      const results = await searchMessages({ query, maxResults: 5 });
      const messages = results?.messages || results?.data?.messages || [];

      for (const msg of messages) {
        const id = msg.id || msg.messageId;
        if (!id) continue;

        const detail = await readMessage({ messageId: id });
        const body = detail?.body || detail?.snippet || detail?.data?.body || '';
        const subject = detail?.subject || detail?.data?.subject || '';

        // Try subject first (often contains the code directly)
        let code = extractCode(subject);
        if (!code) code = extractCode(body);

        if (code) {
          console.log(`  ✅ ${label} Verification code found: ${code} (attempt ${attempts})`);
          return code;
        }
      }
    } catch (err) {
      console.log(`  ⚠ ${label} Gmail poll error: ${err.message}`);
    }

    if (Date.now() - startTime + pollIntervalMs < timeoutMs) {
      console.log(`  ⏳ ${label} No code yet (attempt ${attempts}) — waiting ${pollIntervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, pollIntervalMs));
    } else {
      break;
    }
  }

  console.log(`  ⚠ ${label} No verification code found after ${attempts} attempts (${timeoutMs / 1000}s timeout)`);
  return null;
}

/**
 * Convenience: wait then fill the code into a page field.
 * Returns true if code was found and filled, false otherwise.
 *
 * @param {object} page - Playwright page
 * @param {object} options - same as waitForVerificationCode + field selectors
 * @returns {Promise<boolean>}
 */
export async function fillVerificationCode(page, options = {}) {
  const code = await waitForVerificationCode(options);
  if (!code) return false;

  const codeSelectors = [
    '#security_code',
    'input[id*="security" i]',
    'input[autocomplete="one-time-code"]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="access code" i]',
    'input[placeholder*="code" i]',
    'input[type="text"][maxlength="6"]',
    'input[type="text"][maxlength="8"]',
  ];

  for (const sel of codeSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      await el.fill(code);
      console.log(`  ✅ Verification code filled into: ${sel}`);
      return true;
    }
  }

  console.log(`  ⚠ Code found (${code}) but no field to fill — may need manual entry`);
  return false;
}
