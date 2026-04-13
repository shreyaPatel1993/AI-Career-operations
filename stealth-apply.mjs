#!/usr/bin/env node
/**
 * stealth-apply.mjs — Universal stealth job application script
 *
 * Bypasses WAF/bot detection on Greenhouse, Lever, Workday, Ashby, and more
 * using playwright-extra + stealth plugin (patches 30+ browser fingerprint signals).
 *
 * Usage:
 *   node stealth-apply.mjs <url> [options]
 *
 * Options:
 *   --cover="text"        Custom cover letter (overrides auto-generated)
 *   --pdf=path            Path to resume PDF (default: latest in output/)
 *   --headless=false      Show browser window (default: true)
 *   --dry-run             Fill form but do NOT submit — screenshot only
 *   --salary="$140K-$160K"  Override salary answer
 *   --company=name        Override company slug (needed for Greenhouse embed token URLs)
 *
 * Examples:
 *   node stealth-apply.mjs "https://job-boards.greenhouse.io/embed/job_app?for=rxvantage&token=5599280004"
 *   node stealth-apply.mjs "https://jobs.lever.co/company/job-id/apply"
 *   node stealth-apply.mjs "https://company.myworkdayjobs.com/..." --headless=false
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, createWriteStream, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { fillVerificationCode } from './lib/email-verifier.mjs';

chromium.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ──────────────────────────────────────────────────────────────────

function loadCandidate() {
  const profilePath = join(__dirname, 'config/profile.yml');
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  const c = profile.candidate;
  return {
    firstName:  c.full_name.split(' ')[0],
    lastName:   c.full_name.split(' ').slice(1).join(' '),
    fullName:   c.full_name,
    email:      c.email,
    phone:      c.phone.replace(/[^+\d]/g, ''),
    phoneFormatted: c.phone,
    linkedin:   c.linkedin.startsWith('http') ? c.linkedin : `https://${c.linkedin}`,
    portfolio:  c.portfolio_url,
    github:     c.github,
    location:   'United States',
    city:       c.city || '',
    zipCode:    c.zip  || '',
    visaStatus: 'US Citizen',
    authorized: 'Yes',
    currentCompany: c.current_company || '',
    salary:     profile.compensation?.target_range || '$140,000 - $175,000',
    salaryText: (profile.compensation?.target_range || '$130K-$180K') + ' base. Open to equity and bonus discussion.',
  };
}

function findResumePDF(preferCompany = '') {
  const outputDir = join(__dirname, 'output');
  if (!existsSync(outputDir)) return null;
  const pdfs = readdirSync(outputDir)
    .filter(f => f.endsWith('.pdf'))
    .map(f => ({ name: f, path: join(outputDir, f), mtime: statSync(join(outputDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!pdfs.length) return null;
  // Prefer PDF matching company name
  if (preferCompany) {
    const slug = preferCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = pdfs.find(p => p.name.toLowerCase().includes(slug));
    if (match) return match.path;
  }
  // Prefer the base CV over any tailored/company-specific PDF
  return pdfs.find(p => p.name.toLowerCase().includes('base'))?.path ?? pdfs[0].path;
}

// Loads config/form-answers.yml — the user-maintained Q&A bank.
// Used as a fallback in all portal handlers when the built-in decide() has no answer.
function loadFormAnswers() {
  const path = join(__dirname, 'config/form-answers.yml');
  if (!existsSync(path)) return [];
  try {
    const cfg = yaml.load(readFileSync(path, 'utf-8'));
    return cfg?.questions || [];
  } catch { return []; }
}

// Pattern-match a question string against form-answers.yml entries.
// Returns { answer, type } or null if no match.
function lookupFormAnswer(questionText, formAnswers) {
  if (!questionText || !formAnswers?.length) return null;
  const q = questionText.toLowerCase();
  for (const entry of formAnswers) {
    if (!entry.patterns || entry.answer == null) continue;
    if (entry.patterns.some(p => q.includes(p.toLowerCase()))) {
      return { answer: String(entry.answer), type: entry.type || 'text' };
    }
  }
  return null;
}

// ─── PORTAL DETECTION ────────────────────────────────────────────────────────

function detectPortal(url) {
  if (url.includes('greenhouse.io'))       return 'greenhouse';
  if (url.includes('lever.co'))            return 'lever';
  if (url.includes('myworkdayjobs.com'))   return 'workday';
  if (url.includes('ashbyhq.com'))         return 'ashby';
  if (url.includes('bamboohr.com'))        return 'bamboohr';
  if (url.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (url.includes('icims.com'))           return 'icims';
  if (url.includes('jobvite.com'))         return 'jobvite';
  if (url.includes('taleo.net'))           return 'taleo';
  if (url.includes('applytojob.com'))      return 'applytojob';
  // Greenhouse-hosted jobs on company domains (gh_jid or gh_src in query string)
  if (/[?&]gh_jid=/.test(url) || /[?&]gh_src=/.test(url)) return 'greenhouse';
  return 'generic';
}

// If the URL is a company JD page (not a direct Greenhouse form), resolve the
// actual Greenhouse application URL using the gh_jid param.
// Uses the embed/job_app format which loads the form directly (no Apply button needed,
// more reliable than the classic board which often redirects back to company sites).
function resolveGreenhouseUrl(url) {
  const ghJidMatch = url.match(/[?&]gh_jid=(\d+)/);
  if (!ghJidMatch) return url; // already a direct greenhouse URL
  if (url.includes('greenhouse.io')) return url; // already resolved
  const jobId = ghJidMatch[1];
  // Use embed form URL — loads the application form directly without JD page redirect
  return `https://boards.greenhouse.io/embed/job_app?token=${jobId}`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function safeFill(page, selector, value, { timeout = 5000, optional = false } = {}) {
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    await page.fill(selector, value);
    return true;
  } catch {
    if (!optional) console.log(`  ⚠ Field not found: ${selector}`);
    return false;
  }
}

async function safeSelect(page, selector, value, { timeout = 5000, optional = false } = {}) {
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    await page.selectOption(selector, { label: value }).catch(() =>
      page.selectOption(selector, { value })
    );
    return true;
  } catch {
    if (!optional) console.log(`  ⚠ Select not found: ${selector}`);
    return false;
  }
}

async function safeClick(page, selector, { timeout = 8000, optional = false } = {}) {
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    await page.click(selector);
    return true;
  } catch {
    if (!optional) console.log(`  ⚠ Button not found: ${selector}`);
    return false;
  }
}

async function uploadFile(page, selector, filePath, { timeout = 8000 } = {}) {
  try {
    // File inputs are often hidden (ATS use styled buttons over them).
    // Use 'attached' state instead of 'visible' so we can still set files.
    await page.waitForSelector(selector, { timeout, state: 'attached' });
    await page.setInputFiles(selector, filePath);
    console.log(`  ✅ Resume uploaded: ${filePath}`);
    return true;
  } catch {
    // Last resort: find any visible file input on the page
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const inp of fileInputs) {
        await inp.setInputFiles(filePath).catch(() => {});
        console.log(`  ✅ Resume uploaded via fallback input: ${filePath}`);
        return true;
      }
    } catch { /* ignore */ }
    console.log(`  ⚠ File input not found: ${selector}`);
    return false;
  }
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function screenshot(page, label) {
  const screenshotDir = join(__dirname, 'output', 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(screenshotDir, `apply-${label}-${date}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`\n📸 Screenshot saved: ${path}`);
  return path;
}

// ─── OPTION A: HUMAN BEHAVIOR SIMULATION (reCAPTCHA v3 score booster) ────────
//
// reCAPTCHA v3 is score-based (0.0–1.0). Bots get ~0.1; humans get ~0.9.
// Threshold for Greenhouse is ~0.5. We boost score by mimicking real user
// interactions: natural mouse paths, scroll, hover, realistic keystroke timing.

async function humanType(page, selector, text, { wpm = 65, optional = false } = {}) {
  try {
    await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
    await page.click(selector);
    await page.waitForTimeout(randomBetween(150, 400));
    // Clear existing value first
    await page.fill(selector, '');
    // Type character by character with WPM-based timing + jitter
    const msPerChar = Math.round(60000 / (wpm * 5));
    for (const char of text) {
      await page.type(selector, char, { delay: randomBetween(msPerChar * 0.4, msPerChar * 2.2) });
      // Occasional micro-pause (simulates thinking/correcting)
      if (Math.random() < 0.04) await page.waitForTimeout(randomBetween(300, 900));
    }
    return true;
  } catch {
    if (!optional) console.log(`  ⚠ humanType: field not found: ${selector}`);
    return false;
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function moveMouseNaturally(page, targetX, targetY) {
  // Bézier-like curve: move through a random intermediate point
  const startX = randomBetween(100, 900);
  const startY = randomBetween(100, 600);
  const midX   = randomBetween(Math.min(startX, targetX), Math.max(startX, targetX));
  const midY   = randomBetween(Math.min(startY, targetY), Math.max(startY, targetY));
  const steps  = randomBetween(12, 24);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bézier
    const x = Math.round((1 - t) ** 2 * startX + 2 * (1 - t) * t * midX + t ** 2 * targetX);
    const y = Math.round((1 - t) ** 2 * startY + 2 * (1 - t) * t * midY + t ** 2 * targetY);
    await page.mouse.move(x, y);
    await page.waitForTimeout(randomBetween(8, 28));
  }
}

async function humanBehavior(page) {
  console.log('\n🧠 Running human behavior simulation (reCAPTCHA v3 score boost)...');

  // 1. Natural scroll — read through the form like a human would
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(randomBetween(600, 1200));

  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewHeight   = await page.evaluate(() => window.innerHeight);
  let scrollPos = 0;

  while (scrollPos < scrollHeight - viewHeight) {
    const scrollStep = randomBetween(120, 280);
    scrollPos = Math.min(scrollPos + scrollStep, scrollHeight - viewHeight);
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'smooth' }), scrollPos);
    await page.waitForTimeout(randomBetween(300, 700));
  }

  // Scroll back up partway (humans often re-check what they filled)
  await page.evaluate(y => window.scrollTo({ top: y, behavior: 'smooth' }), Math.floor(scrollHeight * 0.3));
  await page.waitForTimeout(randomBetween(500, 900));

  // 2. Random mouse movements across the page (3–6 movements)
  const numMoves = randomBetween(3, 6);
  for (let i = 0; i < numMoves; i++) {
    await moveMouseNaturally(page, randomBetween(200, 900), randomBetween(200, 600));
    await page.waitForTimeout(randomBetween(200, 500));
  }

  // 3. Hover over the submit button area (signals intent, boosts score)
  const submitBtn = await findSubmitButton(page);
  if (submitBtn) {
    const box = await submitBtn.boundingBox();
    if (box) {
      await moveMouseNaturally(page, box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(randomBetween(400, 800));
      // Micro-jitter on the button (hesitation before clicking)
      for (let i = 0; i < 3; i++) {
        await page.mouse.move(
          box.x + randomBetween(5, box.width - 5),
          box.y + randomBetween(2, box.height - 2)
        );
        await page.waitForTimeout(randomBetween(80, 200));
      }
    }
  }

  // 4. Dwell — let reCAPTCHA observe interaction history
  await page.waitForTimeout(randomBetween(1800, 3200));
  console.log('  ✅ Behavior simulation complete');
}

// ─── OPTION B: reCAPTCHA v2 AUDIO SOLVER (Whisper, free, no API key) ─────────
//
// Strategy: click checkbox → if challenge appears → click audio button →
// download .mp3 → transcribe with @xenova/transformers (Whisper in Node.js) →
// type answer → submit.
//
// Requires: npm install @xenova/transformers  (first run downloads ~80MB model)

async function solveRecaptchaV2(page) {
  // Detect reCAPTCHA v2 iframe
  const frames = page.frames();
  const captchaFrame = frames.find(f => f.url().includes('recaptcha') && f.url().includes('anchor'));
  if (!captchaFrame) return false; // No v2 captcha on this page

  console.log('\n🔒 reCAPTCHA v2 detected — attempting audio solve...');

  try {
    // Wait for frame to fully load before interacting
    await captchaFrame.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);

    // Click the checkbox
    await captchaFrame.waitForSelector('#recaptcha-anchor', { timeout: 15000 });
    await captchaFrame.click('#recaptcha-anchor');
    await page.waitForTimeout(randomBetween(1500, 2500));

    // Check if already solved (no challenge frame appeared)
    const checkboxState = await captchaFrame.$('#recaptcha-anchor[aria-checked="true"]');
    if (checkboxState) {
      console.log('  ✅ reCAPTCHA v2 solved (no challenge)');
      return true;
    }

    // Find the challenge iframe
    const challengeFrame = page.frames().find(f => f.url().includes('recaptcha') && f.url().includes('bframe'));
    if (!challengeFrame) {
      console.log('  ⚠ Challenge frame not found — may need manual solve');
      return false;
    }

    // Click the audio button
    await challengeFrame.waitForSelector('#recaptcha-audio-button', { timeout: 5000 });
    await challengeFrame.click('#recaptcha-audio-button');
    await page.waitForTimeout(randomBetween(1000, 1800));

    // Get the audio challenge URL
    const audioSrc = await challengeFrame.evaluate(() => {
      const el = document.querySelector('.rc-audiochallenge-tdownload-link, #audio-source');
      return el?.href || el?.src || null;
    });

    if (!audioSrc) {
      console.log('  ⚠ Could not find audio challenge URL');
      return false;
    }

    console.log('  📥 Downloading audio challenge...');

    // Download the audio file
    const audioPath = join(tmpdir(), `recaptcha-audio-${Date.now()}.mp3`);
    const audioData = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    }, audioSrc);
    writeFileSync(audioPath, Buffer.from(audioData));

    // Transcribe with Whisper (@xenova/transformers)
    console.log('  🎙 Transcribing with Whisper (first run downloads model ~80MB)...');
    let transcription = '';
    try {
      const { pipeline } = await import('@xenova/transformers');
      const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
      const result = await transcriber(audioPath);
      transcription = result.text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
      console.log(`  📝 Transcription: "${transcription}"`);
    } catch (whisperErr) {
      console.log(`  ⚠ Whisper not available (${whisperErr.message})`);
      console.log('  💡 Install with: npm install @xenova/transformers');
      console.log('  ⏸  Pausing for manual CAPTCHA solve (30s)...');
      await page.waitForTimeout(30000);
      return false;
    }

    // Type the transcription into the audio response field
    await challengeFrame.waitForSelector('#audio-response', { timeout: 5000 });
    await challengeFrame.fill('#audio-response', transcription);
    await page.waitForTimeout(randomBetween(500, 900));

    // Verify
    await challengeFrame.click('#recaptcha-verify-button');
    await page.waitForTimeout(randomBetween(1500, 2500));

    // Check if solved
    const solved = await captchaFrame.$('#recaptcha-anchor[aria-checked="true"]');
    if (solved) {
      console.log('  ✅ reCAPTCHA v2 solved via audio!');
      return true;
    } else {
      console.log('  ⚠ Audio solve failed — retrying not implemented. Try --headless=false for manual solve.');
      return false;
    }
  } catch (err) {
    console.log(`  ⚠ reCAPTCHA solve error: ${err.message}`);
    return false;
  }
}

// ─── ATS ACCOUNT STORE ───────────────────────────────────────────────────────

const ATS_ACCOUNTS_PATH = join(__dirname, 'config/ats-accounts.yml');

function loadAtsAccounts() {
  if (!existsSync(ATS_ACCOUNTS_PATH)) return { workday: {} };
  try {
    return yaml.load(readFileSync(ATS_ACCOUNTS_PATH, 'utf-8')) || { workday: {} };
  } catch { return { workday: {} }; }
}

function saveAtsAccount(platform, tenant, record) {
  const accounts = loadAtsAccounts();
  if (!accounts[platform]) accounts[platform] = {};
  accounts[platform][tenant] = { ...record, updated: new Date().toISOString().slice(0, 10) };
  writeFileSync(ATS_ACCOUNTS_PATH, yaml.dump(accounts), 'utf-8');
  console.log(`  💾 Saved ${platform} account for tenant: ${tenant}`);
}

// ─── PORTAL STRATEGIES ───────────────────────────────────────────────────────

const PORTALS = {

  // ── GREENHOUSE ────────────────────────────────────────────────────────────
  async greenhouse(page, candidate, coverLetter, pdfPath, { securityCode, unanswered } = {}) {
    console.log('\n🌱 Greenhouse detected');
    // networkidle can time out on analytics-heavy pages — use load + grace period
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const isNewBoard = page.url().includes('job-boards.greenhouse.io');
    console.log(`  → ${isNewBoard ? 'New Remix board' : 'Classic board'}`);

    // JD page first — scroll to find and click Apply button before looking for form fields
    const formVisible = await page.$('#first_name, input[name="first_name"]');
    if (!formVisible) {
      console.log('  → JD page detected — searching for Apply button (scrolling)...');

      // Scroll through the page to make sure Apply button is rendered
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await page.waitForTimeout(800);

      // Broad Apply button search (text-based + href-based)
      const applySelectors = [
        'a[href*="/apply"]',
        'button:has-text("Apply for this job")',
        'button:has-text("Apply Now")',
        'button:has-text("Apply")',
        'a:has-text("Apply for this job")',
        'a:has-text("Apply Now")',
        'a:has-text("Apply")',
        '[data-qa="btn-apply"]',
        '[class*="apply" i]',
      ];

      let applyBtn = null;
      for (const sel of applySelectors) {
        applyBtn = await page.$(sel).catch(() => null);
        if (applyBtn && await applyBtn.isVisible().catch(() => false)) break;
        applyBtn = null;
      }

      if (applyBtn) {
        await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        await applyBtn.click();
        console.log('  ✅ Clicked Apply button');
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        // Try navigating directly to /apply path (strip query string before appending)
        const baseUrl = page.url().split('?')[0].replace(/\/$/, '');
        const applyUrl = `${baseUrl}/apply`;
        console.log(`  → No Apply button found — navigating to ${applyUrl}`);
        await page.goto(applyUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    await page.waitForSelector('#first_name, input[name="first_name"]', { timeout: 10000 });

    // ── Basic text fields — use humanType for reCAPTCHA v3 score boost ──
    // (realistic keystroke events signal human intent to reCAPTCHA)
    await humanType(page, '#first_name',     candidate.firstName,  { optional: true });
    await humanType(page, '#last_name',      candidate.lastName,   { optional: true });
    await humanType(page, '#preferred_name', candidate.firstName,  { optional: true });
    await humanType(page, '#email',          candidate.email,      { optional: true });

    // ── Security code — appears dynamically after email is recognised ──
    // Greenhouse sends a one-time code to verify the email address.
    // It shows as a new field shortly after the email input is filled.
    await page.waitForTimeout(2500); // let Greenhouse react to the email
    const securityCodeSelectors = [
      '#security_code',
      'input[id*="security" i]',
      'input[placeholder*="security" i]',
      'input[placeholder*="verification" i]',
      'input[placeholder*="access code" i]',
      'input[autocomplete="one-time-code"]',
    ];
    for (const sel of securityCodeSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        if (securityCode) {
          await humanType(page, sel, securityCode, { optional: true });
          console.log(`  ✅ Security code filled: ${securityCode}`);
        } else {
          console.log(`\n  ⚠ Security code field detected! Greenhouse sent a code to ${candidate.email}.`);
          console.log('  Re-run with: --code=XXXXXXXX');
        }
        break;
      }
    }

    // ── Phone (intl-tel-input widget — fill the tel input directly) ──
    await humanType(page, '#phone', candidate.phoneFormatted, { optional: true });

    // ── Location (City) — React Select combobox ──
    const locationInput = await page.$('#candidate-location');
    if (locationInput) {
      const locationValue = candidate.city || 'Remote';
      const filled = await PORTALS._selectComboOption(page, locationInput, locationValue);
      if (!filled && candidate.city) {
        // Try state-level fallback
        await PORTALS._selectComboOption(page, locationInput, 'Remote');
      }
      console.log(`  ✅ Location: ${locationValue}`);
    }

    // ── Resume upload ──
    if (pdfPath) {
      await uploadFile(page, '#resume, input[type="file"][id*="resume"]', pdfPath)
        .catch(() => uploadFile(page, 'input[type="file"]:first-of-type', pdfPath));
    }

    // ── Cover letter (new board: file upload; classic: textarea) ──
    if (coverLetter) {
      // Classic board has a textarea
      const hasCoverTextarea = await page.$('#cover_letter_text, textarea[name="cover_letter_text"]');
      if (hasCoverTextarea) {
        await hasCoverTextarea.fill(coverLetter);
        console.log('  ✅ Cover letter (text) filled');
      } else {
        // New board: create a .txt file on the fly and upload it
        const clPath = `${tmpdir()}/cover-letter-${Date.now()}.txt`;
        writeFileSync(clPath, coverLetter, 'utf-8');
        await uploadFile(page, '#cover_letter, input[type="file"][id*="cover"]', clPath);
      }
    }

    // ── Education section (uses dedicated IDs, not question_* pattern) ──
    await PORTALS._greenhouseEducation(page);

    // ── Custom questions (new board: all rendered as text inputs / comboboxes) ──
    const formAnswers = loadFormAnswers();
    await PORTALS._greenhouseQuestions(page, candidate, { unanswered, formAnswers });

    // ── EEOC — decline all (voluntary) ──
    await PORTALS._greenhouseEEOC(page);
  },

  // ── EDUCATION ─────────────────────────────────────────────────────────────
  // New Remix board (job-boards.greenhouse.io) uses React Select comboboxes with
  // IDs: school--0, degree--0, discipline--0  (double dash, NOT underscore)
  // Classic board (boards.greenhouse.io) uses: school_name_0, degree_0, discipline_0
  // ALL three fields are React Select — must click + type + pick, NOT el.fill().
  async _greenhouseEducation(page) {
    console.log('  📚 Filling education section...');

    const edu = {
      school: 'Touro College',
      degree: "Master's",
      field:  'Information Systems',
    };

    // Fill a React Select combobox: type prefix to trigger search/filter, pick best match.
    // Falls back to direct text entry if no options appear (for creatable selects).
    async function fillEduCombo(newId, classicId, searchTerm, matchTerm) {
      // Try new board ID (double-dash) first, then classic board ID (underscore)
      let el = null;
      for (const sel of [`#${newId}`, `#${classicId}`, `input[id*="${classicId}"]`]) {
        el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) break;
        el = null;
      }
      if (!el) {
        console.log(`  ⚠ [education] field not found: ${newId}`);
        return false;
      }

      try {
        await el.click();
        await page.waitForTimeout(400);
        // Type first 6 chars to trigger dropdown/API search
        await el.type(searchTerm.slice(0, 6), { delay: 60 });
        await page.waitForTimeout(1500); // wait for API or local filter

        const opts = await page.$$('[role="option"]');
        for (const opt of opts) {
          const txt = (await opt.innerText().catch(() => '')).trim();
          if (txt.toLowerCase().includes(matchTerm.toLowerCase()) ||
              matchTerm.toLowerCase().includes(txt.toLowerCase())) {
            await opt.click();
            console.log(`  ✅ [education] ${newId}: "${txt}"`);
            await page.waitForTimeout(300);
            return true;
          }
        }

        // No matching option — Escape and try free-text entry (creatable React Select)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await el.click();
        await el.fill(searchTerm);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        console.log(`  ⚠ [education] ${newId}: no dropdown match — filled as text: "${searchTerm}"`);
        return true;
      } catch (err) {
        console.log(`  ⚠ [education] ${newId} error: ${err.message}`);
        return false;
      }
    }

    await fillEduCombo('school--0',     'school_name_0', edu.school, edu.school);
    await fillEduCombo('degree--0',     'degree_0',      edu.degree, edu.degree);
    await fillEduCombo('discipline--0', 'discipline_0',  edu.field,  edu.field);
  },

  async _greenhouseQuestions(page, candidate, { unanswered, formAnswers = [] } = {}) {
    // ── Helper: get question text for any element ────────────────────────────
    // Greenhouse uses multiple DOM patterns. Try them all.
    async function getQuestionText(el) {
      const id = await el.getAttribute('id').catch(() => '');
      // 1. aria-labelledby (React Select / Greenhouse new board)
      const labelledBy = await el.getAttribute('aria-labelledby').catch(() => '');
      if (labelledBy) {
        // aria-labelledby can be a space-separated list of ids
        for (const lblId of labelledBy.split(/\s+/)) {
          const lbl = await page.$(`[id="${lblId}"]`);
          if (lbl) {
            const txt = (await lbl.innerText().catch(() => '')).trim();
            if (txt) return txt.toLowerCase();
          }
        }
      }
      // 2. label[for=id]
      if (id) {
        const lbl = await page.$(`label[for="${id}"]`);
        if (lbl) return (await lbl.innerText()).toLowerCase().trim();
      }
      // 3. closest fieldset > legend (radio groups)
      const legend = await el.evaluate(e => e.closest('fieldset')?.querySelector('legend')?.innerText ?? '');
      if (legend) return legend.toLowerCase().trim();
      // 4. closest parent with a label child
      const parentLabel = await el.evaluate(e => {
        const parent = e.closest('[class*="field"], [class*="question"], [class*="form-group"], fieldset, div');
        if (!parent) return '';
        const lbl = parent.querySelector('label, legend, [class*="label"]');
        return lbl ? lbl.innerText : '';
      });
      return parentLabel.toLowerCase().trim();
    }

    // ── Decision engine ──────────────────────────────────────────────────────
    function decide(q) {
      if (!q) return null;
      // Profile links
      if (q.includes('linkedin') || q.includes('linked in'))         return { type: 'text', value: candidate.linkedin };
      if (q.includes('portfolio') || q.includes('personal website') || q.includes('personal site'))
                                                                      return { type: 'text', value: candidate.portfolio };
      if (q.includes('website') && !q.includes('company'))           return { type: 'text', value: candidate.portfolio };
      if (q.includes('github'))                                       return { type: 'text', value: candidate.github || '' };
      // Salary / comp
      if (q.includes('salary') || q.includes('compensation') || q.includes('target pay') ||
          q.includes('expected pay') || q.includes('desired pay') || q.includes('pay expectation'))
                                                                      return { type: 'text', value: candidate.salaryText };
      // Work authorization — Yes answers
      if (q.includes('authorized to work') || q.includes('eligible to work') || q.includes('legally authorized'))
                                                                      return { type: 'yesno', value: 'Yes' };
      if (q.includes('us citizen') || q.includes('work in the us') || q.includes('work in the united states'))
                                                                      return { type: 'yesno', value: 'Yes' };
      if (q.includes('currently employed') || q.includes('current employment status'))
                                                                      return { type: 'yesno', value: 'No' };
      if ((q.includes('cross-functional') || q.includes('cross functional')) ||
          (q.includes('designer') && q.includes('product manager'))) return { type: 'yesno', value: 'Yes' };
      if (q.includes('remote') && !q.includes('require') && !q.includes('sponsorship') && !q.includes('on-site'))
                                                                      return { type: 'yesno', value: 'Yes' };
      if (q.includes('overtime') || q.includes('on call') || q.includes('on-call'))
                                                                      return { type: 'yesno', value: 'Yes' };
      // No answers
      if (q.includes('sponsorship') || q.includes('require.*visa') || q.includes('visa.*require'))
                                                                      return { type: 'yesno', value: 'No' };
      if (q.includes('require relocation') || q.includes('willing to relocate') || q.includes('open to relocation'))
                                                                      return { type: 'yesno', value: 'No' };
      if (q.includes('previously applied') || q.includes('applied before') || q.includes('worked here before') ||
          q.includes('prior application') || q.includes('previously worked'))
                                                                      return { type: 'yesno', value: 'No' };
      if (q.includes('security clearance') || q.includes('clearance required') || q.includes('hold a clearance'))
                                                                      return { type: 'yesno', value: 'No' };
      // Start date / notice period
      if (q.includes('start date') || q.includes('when can you start') || q.includes('earliest start') ||
          q.includes('notice period') || q.includes('notice required'))
                                                                      return { type: 'text', value: '2 weeks' };
      // How did you hear
      if (q.includes('how did you hear') || q.includes('how did you find') || q.includes('where did you find') ||
          q.includes('how did you learn') || q.includes('referred by') || q.includes('source'))
                                                                      return { type: 'text', value: 'LinkedIn' };
      // Years experience — all tech-stack questions default to 7 years
      // (covers dropdown ranges AND plain text inputs on new Greenhouse board)
      if (q.includes('year') && (q.includes('react') || q.includes('typescript') ||
          q.includes('javascript') || q.includes('js') || q.includes('node') ||
          q.includes('python') || q.includes('aws') || q.includes('css') ||
          q.includes('experience') || q.includes('professional') ||
          q.includes('how many') || q.includes('how long') ||
          q.includes('writing') || q.includes('working with') || q.includes('using')))
                                                                      return { type: 'years', value: 7 };
      // City / location text fields
      if (q === 'city' || (q.includes('city') && q.length < 30 && !q.includes('new york') && !q.includes('which city')))
                                                                      return { type: 'text', value: candidate.city || '' };
      // Zip / postal code
      if (q.includes('zip') || q.includes('postal code'))             return { type: 'text', value: candidate.zipCode || '' };
      // Country (question field — not the phone widget)
      if (q.trim() === 'country' || (q.includes('country') && !q.includes('company') && !q.includes('home country') && q.length < 40))
                                                                      return { type: 'yesno', value: 'United States' };
      // San Francisco Bay Area residency (Fremont is in the Bay Area ✓)
      if (q.includes('san francisco bay area') || q.includes('bay area') || (q.includes('reside') && q.includes('san francisco')))
                                                                      return { type: 'yesno', value: 'Yes' };
      // Office attendance / in-person work (always Yes per profile preferences)
      if (q.includes('office') && (q.includes('day') || q.includes('week') || q.includes('willing') || q.includes('work in our') || q.includes('in-person')))
                                                                      return { type: 'yesno', value: 'Yes' };
      // Startup / early-stage experience
      if ((q.includes('start-up') || q.includes('startup') || q.includes('early stage') || q.includes('early-stage')) && (q.includes('experience') || q.includes('worked')))
                                                                      return { type: 'yesno', value: 'Yes' };
      // B2B SaaS product experience
      if (q.includes('b2b') || (q.includes('saas') && q.includes('product')))
                                                                      return { type: 'yesno', value: 'Yes' };
      // Level / seniority
      if ((q.includes('level') && (q.includes('describe') || q.includes('best'))) || q.includes('seniority level'))
                                                                      return { type: 'yesno', value: 'Senior' };
      // State (combobox — type to filter) — matches "state/province", "which state", etc.
      if (q.includes('state/province') || q.includes('which state') || q.includes('state are you') || q.includes('state do you') || q.includes('state you plan'))
                                                                      return { type: 'yesno', value: 'California' };
      // EEOC / diversity — decline all
      if (q.includes('gender') || q.includes('pronouns') || q.includes('sex '))
                                                                      return { type: 'yesno', value: 'Decline to self-identify' };
      if (q.includes('ethnicity') || q.includes('race ') || q.includes('racial'))
                                                                      return { type: 'yesno', value: 'Decline to self-identify' };
      if (q.includes('veteran') || q.includes('military service'))    return { type: 'yesno', value: 'I am not a protected veteran' };
      if (q.includes('disability') || q.includes('disabled'))         return { type: 'yesno', value: 'No, I do not have a disability' };
      // AI usage / acknowledgment dropdowns (options like "Yes, I acknowledge")
      if (q.includes('acknowledge') || q.includes('ai usage') || q.includes('i agree') ||
          (q.includes('agree') && q.includes('policy')))              return { type: 'yesno', value: 'Yes' };
      return null;
    }

    // ── 1. Radio button questions (fieldset > legend pattern) ────────────────
    const fieldsets = await page.$$('fieldset');
    for (const fieldset of fieldsets) {
      const legend = await fieldset.$('legend');
      if (!legend) continue;
      const questionText = (await legend.innerText()).toLowerCase().trim();
      const decision = decide(questionText);
      if (!decision) {
        if (questionText && unanswered) unanswered.push(questionText);
        continue;
      }
      if (decision.type !== 'yesno') continue;

      const radios = await fieldset.$$('input[type="radio"]');
      for (const radio of radios) {
        const radioId = await radio.getAttribute('id');
        const radioLabel = radioId ? await page.$(`label[for="${radioId}"]`) : null;
        const radioText = radioLabel ? (await radioLabel.innerText()).trim() : await radio.getAttribute('value') ?? '';
        if (radioText.toLowerCase() === decision.value.toLowerCase()) {
          await radio.click();
          console.log(`  ✅ [radio] ${questionText.slice(0, 60)}: ${decision.value}`);
          break;
        }
      }
    }

    // ── 2. Text / textarea inputs ────────────────────────────────────────────
    const textInputs = await page.$$('input[id^="question_"]:not([type="radio"]):not([type="checkbox"]), textarea[id^="question_"]');
    for (const el of textInputs) {
      const q = await getQuestionText(el);
      let decision = decide(q);

      // Fallback: check user's form-answers.yml if built-in decide() has no answer
      if (!decision) {
        const saved = lookupFormAnswer(q, formAnswers);
        if (saved) {
          decision = saved;
          console.log(`  📖 [form-answers.yml] ${q.slice(0, 60)}: ${saved.answer.slice(0, 60)}`);
        }
      }

      if (!decision) {
        if (q && unanswered) {
          unanswered.push(q);
          console.log(`  ⚠ [unanswered — needs manual] ${q.slice(0, 80)}`);
        }
        continue;
      }

      if (decision.type === 'years') {
        await PORTALS._selectYearsOption(page, el, decision.value ?? decision.answer);
      } else if (decision.type === 'text') {
        await el.fill(decision.value ?? decision.answer);
        console.log(`  ✅ [text] ${q.slice(0, 60)}: ${(decision.value ?? decision.answer).slice(0, 60)}`);
      } else if (decision.type === 'yesno' || decision.type === 'select') {
        await PORTALS._selectComboOption(page, el, decision.value ?? decision.answer);
        console.log(`  ✅ [combo] ${q.slice(0, 60)}: ${decision.value ?? decision.answer}`);
      }
    }

    // ── 3. Classic <select> elements ─────────────────────────────────────────
    const selectEls = await page.$$('select[id^="question_"]');
    for (const sel of selectEls) {
      const q = await getQuestionText(sel);
      let decision = decide(q);

      // Fallback: check user's form-answers.yml
      if (!decision) {
        const saved = lookupFormAnswer(q, formAnswers);
        if (saved) {
          decision = saved;
          console.log(`  📖 [form-answers.yml] ${q.slice(0, 60)}: ${saved.answer.slice(0, 60)}`);
        }
      }

      if (!decision) {
        if (q && unanswered) {
          unanswered.push(q);
          console.log(`  ⚠ [unanswered — needs manual] ${q.slice(0, 80)}`);
        }
        continue;
      }

      const options = await sel.evaluate(el => [...el.options].map(o => ({ text: o.text.trim(), value: o.value })));
      const answerVal = decision.value ?? decision.answer;
      const match = options.find(o => o.text.toLowerCase() === answerVal.toLowerCase())
        || options.find(o => o.text.toLowerCase().includes(answerVal.toLowerCase()));
      if (match) {
        await sel.selectOption({ value: match.value });
        console.log(`  ✅ [select] ${q.slice(0, 60)}: ${match.text}`);
      }
    }

    // ── 4. Checkbox acknowledgments ──────────────────────────────────────────
    const checkboxes = await page.$$('input[type="checkbox"][id^="question_"]');
    for (const cb of checkboxes) {
      if (await cb.isChecked()) continue;
      const q = await getQuestionText(cb);
      if (q.includes('acknowledge') || q.includes('agree') || q.includes('understand') ||
          q.includes('ai usage') || q.includes('policy') || q.includes('i have read')) {
        await cb.check();
        console.log(`  ✅ [checkbox] ${q.slice(0, 70)}...`);
      }
    }
  },

  // Opens a years-of-experience dropdown, reads the options, and picks the
  // range that contains `years`. Falls back to the highest option.
  async _selectYearsOption(page, inputEl, years) {
    try {
      await inputEl.click();
      await page.waitForTimeout(500);
      await page.waitForSelector('[role="option"]', { timeout: 3000 }).catch(() => {});

      const opts = await page.$$('[role="option"]');
      if (!opts.length) {
        // No dropdown appeared — this is a plain <input type="text">, fill directly
        await inputEl.fill(String(years));
        console.log(`  ✅ Years (${years}y) → text fill (no dropdown)`);
        return true;
      }

      // Parse each option text into a numeric range
      const parsed = [];
      for (const opt of opts) {
        const txt = (await opt.innerText().catch(() => '')).trim();
        if (!txt) continue;
        const lower = txt.toLowerCase();

        let min = null, max = null;

        // "less than 1 year" / "< 1 year"
        if (lower.includes('less than') || lower.startsWith('<')) {
          min = 0; max = 0;
        }
        // "X+ years" / "X or more"
        else if (/(\d+)\s*\+/.test(lower) || lower.includes('or more')) {
          min = parseInt(lower.match(/(\d+)/)?.[1] ?? '0');
          max = Infinity;
        }
        // "X-Y years" or "X to Y years"
        else {
          const m = lower.match(/(\d+)\s*[-–to]+\s*(\d+)/);
          if (m) { min = parseInt(m[1]); max = parseInt(m[2]); }
          // Single number "7 years"
          else {
            const single = lower.match(/(\d+)/);
            if (single) { min = parseInt(single[1]); max = parseInt(single[1]); }
          }
        }

        if (min !== null) parsed.push({ opt, txt, min, max });
      }

      if (parsed.length) {
        // Find the range that contains our years
        const match = parsed.find(p => years >= p.min && years <= p.max);
        if (match) {
          await match.opt.click();
          console.log(`  ✅ Years (${years}y) → "${match.txt}"`);
          return true;
        }
        // Fallback: pick highest range whose min is ≤ years
        const below = parsed.filter(p => p.min <= years).sort((a, b) => b.min - a.min);
        if (below.length) {
          await below[0].opt.click();
          console.log(`  ✅ Years (${years}y) → "${below[0].txt}" (closest)`);
          return true;
        }
        // Fallback: pick first option
        await parsed[0].opt.click();
        console.log(`  ✅ Years (${years}y) → "${parsed[0].txt}" (first)`);
        return true;
      }

      // No parseable options — click first
      const first = await page.$('[role="option"]');
      if (first) { await first.click(); return true; }

      await page.keyboard.press('Escape');
      return false;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  },

  async _selectComboOption(page, inputEl, value) {
    try {
      // Click to open React Select dropdown
      await inputEl.click();
      await page.waitForTimeout(300);

      // Type to filter — React Select filters options as you type
      await inputEl.type(value, { delay: 40 });
      await page.waitForTimeout(500);

      // Wait for options to render
      await page.waitForSelector('[role="option"]', { timeout: 3000 }).catch(() => {});

      const pick = async (opts) => {
        // Exact match
        for (const opt of opts) {
          const txt = (await opt.innerText().catch(() => '')).trim();
          if (txt.toLowerCase() === value.toLowerCase()) { await opt.click(); return true; }
        }
        // Value is contained in option text (e.g. "7" matches "7+ years")
        for (const opt of opts) {
          const txt = (await opt.innerText().catch(() => '')).trim();
          if (txt.toLowerCase().includes(value.toLowerCase())) { await opt.click(); return true; }
        }
        // Option text is contained in value (e.g. "Yes" in "Yes, I acknowledge")
        for (const opt of opts) {
          const txt = (await opt.innerText().catch(() => '')).trim();
          if (value.toLowerCase().includes(txt.toLowerCase()) && txt.length > 1) { await opt.click(); return true; }
        }
        return false;
      };

      const opts = await page.$$('[role="option"]');
      if (await pick(opts)) return true;

      // If typing filtered too aggressively, clear and show all options then try again
      await inputEl.fill('');
      await page.waitForTimeout(400);
      const allOpts = await page.$$('[role="option"]');
      if (await pick(allOpts)) return true;

      await page.keyboard.press('Escape');
      return false;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  },

  async _greenhouseEEOC(page) {
    // EEOC fields in new board are also combobox text inputs
    const eeocIds = ['#gender', '#hispanic_ethnicity', '#race', '#veteran_status', '#disability_status'];
    const declineTerms = ['decline', "don't wish", 'do not want', 'prefer not', 'i do not want'];

    for (const sel of eeocIds) {
      const el = await page.$(sel);
      if (!el) continue;
      try {
        await el.click();
        await page.waitForTimeout(400);
        // Find the decline option in the dropdown
        const options = await page.$$('[role="option"], [role="listbox"] li');
        for (const opt of options) {
          const text = (await opt.innerText()).toLowerCase();
          if (declineTerms.some(t => text.includes(t))) {
            await opt.click();
            break;
          }
        }
        await page.keyboard.press('Escape'); // close dropdown if nothing selected
      } catch { /* voluntary — skip */ }
    }

    // Classic <select> EEOC fallback
    const classicSelects = await page.$$('select[name="gender"], select[name="race"], select[name="disability_status"], select[name="veteran_status"]');
    for (const sel of classicSelects) {
      const options = await sel.evaluate(el => [...el.options].map(o => ({ text: o.text.toLowerCase(), value: o.value })));
      const decline = options.find(o => declineTerms.some(t => o.text.includes(t)));
      if (decline) await sel.selectOption({ value: decline.value });
    }
  },

  // ── LEVER ─────────────────────────────────────────────────────────────────
  async lever(page, candidate, coverLetter, pdfPath) {
    console.log('\n⚙️  Lever detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Check if we need to click Apply button first
    const applyBtn = await page.$('.template-btn-submit, a[href*="/apply"], button:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    await safeFill(page, 'input[name="name"], #name', candidate.fullName);
    await safeFill(page, 'input[name="email"], #email', candidate.email);
    await safeFill(page, 'input[name="phone"], #phone', candidate.phoneFormatted, { optional: true });
    await safeFill(page, 'input[name="org"], input[name="company"], #org', candidate.currentCompany || 'N/A', { optional: true });
    await safeFill(page, 'input[name="urls[LinkedIn]"], input[placeholder*="LinkedIn"]', candidate.linkedin, { optional: true });
    await safeFill(page, 'input[name="urls[Portfolio]"], input[placeholder*="Portfolio"], input[name="urls[Other]"]', candidate.portfolio, { optional: true });

    if (pdfPath) {
      await uploadFile(page, 'input[type="file"]', pdfPath);
    }

    if (coverLetter) {
      await safeFill(page, 'textarea[name="comments"], textarea[placeholder*="cover"], textarea[placeholder*="additional"], .application-additional textarea', coverLetter, { optional: true });
    }

    // Custom questions
    const textareas = await page.$$('textarea:not([name="comments"])');
    for (const ta of textareas) {
      const placeholder = await ta.getAttribute('placeholder') || '';
      if (placeholder.toLowerCase().includes('cover') || placeholder.toLowerCase().includes('letter')) {
        await ta.fill(coverLetter || '');
      }
    }

    // Yes/No selects
    const selects = await page.$$('select');
    for (const sel of selects) {
      const labelText = await sel.evaluate(el => {
        const label = el.closest('div')?.querySelector('label');
        return label ? label.textContent.toLowerCase() : '';
      });
      if (labelText.includes('authorized') || labelText.includes('visa')) {
        await sel.selectOption({ label: 'Yes' }).catch(() => {});
      }
      if (labelText.includes('sponsorship')) {
        await sel.selectOption({ label: 'No' }).catch(() => {});
      }
    }
  },

  // ── WORKDAY ───────────────────────────────────────────────────────────────
  async workday(page, candidate, coverLetter, pdfPath, options = {}) {
    console.log('\n🔷 Workday detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Extract tenant slug from URL (e.g. alkami.wd12.myworkdayjobs.com → alkami)
    const tenantMatch = page.url().match(/https?:\/\/([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i);
    const tenant = tenantMatch?.[1]?.toLowerCase() || 'unknown';
    console.log(`  → Tenant: ${tenant}`);

    // ── Step 1: Click Apply on JD page ──────────────────────────────────────
    const applyBtn = await page.$('a[data-automation-id*="apply" i], button[data-automation-id*="apply" i], a:has-text("Apply Now"), button:has-text("Apply Now"), a:has-text("Apply"), button:has-text("Apply")').catch(() => null);
    if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
      console.log('  → Clicking Apply');
      await applyBtn.click();
      await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // ── Step 2: Authentication (Sign In or Create Account) ───────────────────
    const accounts = loadAtsAccounts();
    const savedAccount = accounts.workday?.[tenant];
    const password = 'Shreya*1';

    // Detect if we're on a login/signup page
    const onAuthPage = await page.$('[data-automation-id="signInSection"], [data-automation-id="createAccountLink"], a:has-text("Create Account"), button:has-text("Create Account"), a:has-text("Sign In"), input[data-automation-id*="password" i]').catch(() => null);

    if (onAuthPage) {
      if (savedAccount) {
        // ── Sign in with existing account ──
        console.log(`  → Signing in with existing account for ${tenant}`);
        await safeClick(page, '[data-automation-id="signInLink"], a:has-text("Sign In"), button:has-text("Sign In")', { optional: true });
        await page.waitForTimeout(1500);
        await safeFill(page, '[data-automation-id="email"], input[type="email"]', candidate.email, { optional: true });
        await safeFill(page, '[data-automation-id="password"], input[type="password"]', savedAccount.password || password, { optional: true });
        await safeClick(page, '[data-automation-id="signInSubmitButton"], button:has-text("Sign In"), button[type="submit"]', { optional: true });
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // Check for sign-in failure
        const signInError = await page.$('[data-automation-id="errorMessage"], [class*="error" i]:has-text("invalid"), [class*="error" i]:has-text("incorrect")').catch(() => null);
        if (signInError) {
          console.log('  ⚠ Sign-in failed — marking needs-manual');
          return 'needs-manual';
        }
        console.log('  ✅ Signed in successfully');
      } else {
        // ── Create new account ──
        console.log(`  → Creating new account for ${tenant}`);
        await safeClick(page, '[data-automation-id="createAccountLink"], a:has-text("Create Account"), button:has-text("Create Account")', { optional: true });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // Check for SMS/phone verification requirement → can't automate, bail
        const smsField = await page.$('input[type="tel"][data-automation-id*="phone" i], input[placeholder*="mobile" i]').catch(() => null);
        if (smsField && await smsField.isVisible().catch(() => false)) {
          console.log('  ⚠ SMS verification required — marking needs-manual');
          return 'needs-manual';
        }

        // Fill account creation form
        await safeFill(page, '[data-automation-id="firstName"], input[aria-label*="First Name" i]', candidate.firstName, { optional: true });
        await safeFill(page, '[data-automation-id="lastName"], input[aria-label*="Last Name" i]', candidate.lastName, { optional: true });
        await safeFill(page, '[data-automation-id="email"], input[type="email"]', candidate.email, { optional: true });

        // Password — try longer format if field has min-length > 8
        const pwField = await page.$('[data-automation-id="password"], input[type="password"]').catch(() => null);
        if (pwField) {
          const minLen = await pwField.getAttribute('minlength').catch(() => null);
          const effectivePassword = (minLen && parseInt(minLen) > 8) ? 'Shreya*123' : password;
          await pwField.fill(effectivePassword).catch(() => {});
          // Confirm password field
          const pwConfirm = await page.$('[data-automation-id="confirmPassword"], input[type="password"]:nth-of-type(2)').catch(() => null);
          if (pwConfirm) await pwConfirm.fill(effectivePassword).catch(() => {});
          // Save whatever password was used
          saveAtsAccount('workday', tenant, { email: candidate.email, password: effectivePassword, created: new Date().toISOString().slice(0, 10) });
        } else {
          saveAtsAccount('workday', tenant, { email: candidate.email, password, created: new Date().toISOString().slice(0, 10) });
        }

        // Submit account creation
        await safeClick(page, '[data-automation-id="createAccountSubmitButton"], button:has-text("Create Account"), button[type="submit"]', { optional: true });
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // ── Email verification ──
        const needsEmailVerify = await page.$('input[data-automation-id*="verif" i], input[placeholder*="verif" i], input[autocomplete="one-time-code"]').catch(() => null);
        if (needsEmailVerify && await needsEmailVerify.isVisible().catch(() => false)) {
          console.log('  → Email verification required');
          const filled = await fillVerificationCode(page, {
            ...(options.gmailTools || {}),
            company: tenant,
            timeoutMs: 60000,
          });
          if (!filled) {
            console.log('  ⚠ Email verification timed out — marking needs-manual');
            return 'needs-manual';
          }
          // Submit verification
          await safeClick(page, 'button:has-text("Verify"), button[type="submit"]', { optional: true });
          await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }

        console.log('  ✅ Account created');
      }
    }

    // ── Step 3: Multi-step application wizard ────────────────────────────────
    console.log('  → Navigating Workday wizard...');
    let stepCount = 0;
    const MAX_STEPS = 8;

    while (stepCount < MAX_STEPS) {
      stepCount++;
      await page.waitForTimeout(1500);

      // Detect CAPTCHA — bail immediately
      const captcha = await page.$('iframe[src*="captcha"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]').catch(() => null);
      if (captcha) {
        console.log('  ⚠ CAPTCHA detected — marking needs-manual');
        return 'needs-manual';
      }

      // Detect completion (thank you / confirmation page)
      const bodyText = await page.innerText('body').catch(() => '');
      if (/thank you|application submitted|successfully submitted|application received/i.test(bodyText)) {
        console.log('  ✅ Workday application submitted');
        return 'submitted';
      }

      // ── Resume upload step ──
      const fileInput = await page.$('input[type="file"]').catch(() => null);
      if (fileInput && pdfPath) {
        console.log('  → Uploading resume');
        await fileInput.setInputFiles(pdfPath).catch(() => {});
        await page.waitForTimeout(4000); // Workday parses resume
      }

      // ── Contact info fields ──
      const contactFields = [
        ['[data-automation-id="legalNameSection_firstName"]', candidate.firstName],
        ['[data-automation-id="legalNameSection_lastName"]',  candidate.lastName],
        ['[data-automation-id="addressSection_addressLine1"]', ''],   // skip — optional
        ['[data-automation-id="phone-device-type"]',          ''],   // skip dropdown
        ['[data-automation-id="phone-number"]',               candidate.phoneFormatted],
        ['[data-automation-id="email"]',                      candidate.email],
      ];
      for (const [sel, val] of contactFields) {
        if (val) await safeFill(page, sel, val, { optional: true, timeout: 2000 });
      }

      // ── Cover letter ──
      if (coverLetter) {
        await safeFill(page, '[data-automation-id*="coverLetter"] textarea, textarea[aria-label*="cover" i]', coverLetter, { optional: true });
      }

      // ── Work authorization radio (Yes) ──
      await safeClick(page, '[data-automation-id*="workAuthorized"] [data-automation-id="true"], [data-automation-id*="authorized"] input[value="1"]', { optional: true });

      // ── Screening questions — yes/no radios ──
      const radios = await page.$$('input[type="radio"]');
      for (const radio of radios) {
        const labelId = await radio.getAttribute('aria-labelledby').catch(() => '');
        const label = labelId ? await page.$(`[id="${labelId}"]`) : null;
        const labelText = label ? (await label.innerText().catch(() => '')).toLowerCase() : '';
        if (!labelText) continue;

        const radioVal = await radio.getAttribute('value') || '';
        if ((labelText.includes('authorized') || labelText.includes('eligible')) && radioVal === 'true') {
          await radio.click().catch(() => {});
        }
        if (labelText.includes('sponsorship') && radioVal === 'false') {
          await radio.click().catch(() => {});
        }
      }

      // ── LinkedIn URL field ──
      await safeFill(page, '[data-automation-id="linkedIn"], input[aria-label*="linkedin" i]', candidate.linkedin, { optional: true });

      // ── Try to advance to next step ──
      const nextBtn = await page.$('[data-automation-id="bottom-navigation-next-btn"], button:has-text("Next"), button[aria-label*="Next"]').catch(() => null);
      if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
        console.log(`  → Step ${stepCount}: clicking Next`);
        await nextBtn.click();
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        continue;
      }

      // No next button — check for submit
      const submitBtn = await page.$('[data-automation-id="bottom-navigation-done-btn"], button:has-text("Submit"), button[aria-label*="Submit"]').catch(() => null);
      if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
        console.log('  → Final step — submit button found, stopping here for review');
        break;
      }

      // Neither next nor submit — likely on a non-standard step
      console.log(`  ⚠ Step ${stepCount}: no Next/Submit found — stopping wizard`);
      break;
    }

    console.log(`  ℹ Workday wizard complete (${stepCount} steps). Review screenshot before submitting.`);
  },

  // ── ASHBY ─────────────────────────────────────────────────────────────────
  async ashby(page, candidate, coverLetter, pdfPath) {
    console.log('\n🔶 Ashby detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Ashby uses React forms
    await safeFill(page, 'input[name="name"], input[placeholder*="full name" i], input[placeholder*="your name" i]', candidate.fullName, { optional: true });
    await safeFill(page, 'input[name="firstName"], input[placeholder*="first name" i]', candidate.firstName, { optional: true });
    await safeFill(page, 'input[name="lastName"], input[placeholder*="last name" i]', candidate.lastName, { optional: true });
    await safeFill(page, 'input[name="email"], input[type="email"]', candidate.email);
    await safeFill(page, 'input[name="phone"], input[type="tel"]', candidate.phoneFormatted, { optional: true });
    await safeFill(page, 'input[name="linkedIn"], input[placeholder*="linkedin" i]', candidate.linkedin, { optional: true });
    await safeFill(page, 'input[name="website"], input[placeholder*="website" i], input[placeholder*="portfolio" i]', candidate.portfolio, { optional: true });

    if (pdfPath) await uploadFile(page, 'input[type="file"]', pdfPath);
    if (coverLetter) await safeFill(page, 'textarea[name="coverLetter"], textarea[placeholder*="cover" i]', coverLetter, { optional: true });
  },

  // ── BAMBOOHR ──────────────────────────────────────────────────────────────
  async bamboohr(page, candidate, coverLetter, pdfPath) {
    console.log('\n🌿 BambooHR detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // BambooHR /careers/ID is a JD page — navigate to the apply form
    if (page.url().includes('/careers/') && !page.url().includes('/apply')) {
      const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply"), a[href*="apply"]').catch(() => null);
      if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click();
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        const applyUrl = page.url().split('?')[0].replace(/\/$/, '') + '/apply';
        console.log(`  → Navigating to: ${applyUrl}`);
        await page.goto(applyUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    await safeFill(page, 'input[name="firstName"], #firstName', candidate.firstName);
    await safeFill(page, 'input[name="lastName"], #lastName', candidate.lastName);
    await safeFill(page, 'input[name="email"], input[type="email"]', candidate.email);
    await safeFill(page, 'input[name="phone"], input[type="tel"]', candidate.phoneFormatted, { optional: true });
    await safeFill(page, 'input[name="linkedInUrl"], input[placeholder*="linkedin" i]', candidate.linkedin, { optional: true });
    await safeFill(page, 'textarea[name="coverLetter"], textarea[name="coverletter"]', coverLetter || '', { optional: true });

    if (pdfPath) await uploadFile(page, 'input[type="file"][name*="resume"], input[type="file"]', pdfPath);
  },

  // ── SMARTRECRUITERS ───────────────────────────────────────────────────────
  async smartrecruiters(page, candidate, coverLetter, pdfPath) {
    console.log('\n🔵 SmartRecruiters detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // SmartRecruiters JD pages need "Apply Now" click to reach the form
    const applyBtn = await page.$('button[data-id="btn-apply"], a[data-id="btn-apply"], button:has-text("Apply Now"), a:has-text("Apply Now"), button:has-text("Apply"), [class*="apply" i]').catch(() => null);
    if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
      console.log('  → Clicking Apply button on JD page...');
      await applyBtn.click();
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    // SmartRecruiters multi-step: resume upload is often the first step
    if (pdfPath) {
      await uploadFile(page, 'input[type="file"]', pdfPath);
      await page.waitForTimeout(3000);
    }

    await safeFill(page, 'input[name="firstName"], #firstName', candidate.firstName, { optional: true });
    await safeFill(page, 'input[name="lastName"], #lastName', candidate.lastName, { optional: true });
    await safeFill(page, 'input[name="email"], input[type="email"]', candidate.email, { optional: true });
    await safeFill(page, 'input[name="phone"]', candidate.phoneFormatted, { optional: true });
    await safeFill(page, 'textarea[name="message"]', coverLetter || '', { optional: true });
  },

  // ── JOBVITE ───────────────────────────────────────────────────────────────
  async jobvite(page, candidate, coverLetter, pdfPath) {
    console.log('\n💼 Jobvite detected');
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Jobvite JD pages need to navigate to /apply path
    if (!page.url().includes('/apply')) {
      const baseUrl = page.url().split('?')[0].replace(/\/$/, '');
      const applyUrl = `${baseUrl}/apply`;
      const applyBtn = await page.$('a.jv-button.btn-apply, a[class*="apply" i][href*="apply"], a:has-text("Apply for this Position"), a:has-text("Apply Now")').catch(() => null);
      if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click();
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        console.log(`  → Navigating to apply URL: ${applyUrl}`);
        await page.goto(applyUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Jobvite application form fields
    await safeFill(page, '#jv-first-name, input[name="firstName"]', candidate.firstName, { optional: true });
    await safeFill(page, '#jv-last-name, input[name="lastName"]', candidate.lastName, { optional: true });
    await safeFill(page, '#jv-email, input[name="email"], input[type="email"]', candidate.email, { optional: true });
    await safeFill(page, '#jv-phone, input[name="phone"], input[type="tel"]', candidate.phoneFormatted, { optional: true });
    await safeFill(page, '#jv-linkedin, input[name="LinkedIn"], input[placeholder*="linkedin" i]', candidate.linkedin, { optional: true });
    await safeFill(page, 'input[placeholder*="website" i], input[placeholder*="portfolio" i]', candidate.portfolio, { optional: true });

    if (pdfPath) {
      await uploadFile(page, 'input[type="file"]', pdfPath);
    }
    if (coverLetter) {
      await safeFill(page, '#jv-cover-letter, textarea[name="coverLetter"], textarea[placeholder*="cover" i]', coverLetter, { optional: true });
    }

    // Work authorization dropdowns
    const selects = await page.$$('select');
    for (const sel of selects) {
      const labelText = await sel.evaluate(el => {
        const label = el.closest('.jv-form-group, div')?.querySelector('label');
        return label ? label.textContent.toLowerCase() : '';
      });
      if (labelText.includes('authorized') || labelText.includes('work in')) {
        await sel.selectOption({ label: 'Yes' }).catch(() => {});
      }
      if (labelText.includes('sponsorship') || labelText.includes('visa')) {
        await sel.selectOption({ label: 'No' }).catch(() => {});
      }
    }
  },

  // ── GENERIC FALLBACK ──────────────────────────────────────────────────────
  async generic(page, candidate, coverLetter, pdfPath) {
    console.log('\n🔍 Unknown portal — using generic form detection');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const strategies = [
      // Name fields
      ['input[name*="first" i][type="text"], input[id*="first" i][type="text"], input[placeholder*="first" i]', candidate.firstName],
      ['input[name*="last" i][type="text"], input[id*="last" i][type="text"], input[placeholder*="last" i]',  candidate.lastName],
      ['input[name*="full" i][type="text"], input[id*="full" i][type="text"], input[placeholder*="full name" i]', candidate.fullName],
      ['input[name*="name" i][type="text"]:not([name*="last" i]):not([name*="first" i])', candidate.fullName],
      // Contact
      ['input[type="email"], input[name*="email" i]', candidate.email],
      ['input[type="tel"], input[name*="phone" i]', candidate.phoneFormatted],
      // Links
      ['input[name*="linkedin" i], input[placeholder*="linkedin" i]', candidate.linkedin],
      ['input[name*="website" i], input[name*="portfolio" i], input[placeholder*="website" i]', candidate.portfolio],
    ];

    for (const [sel, val] of strategies) {
      await safeFill(page, sel, val, { optional: true, timeout: 2000 });
    }

    // Cover letter textarea
    if (coverLetter) {
      const textareas = await page.$$('textarea');
      if (textareas.length > 0) {
        // Use the largest/most likely cover letter textarea
        await textareas[textareas.length - 1].fill(coverLetter);
      }
    }

    // Resume upload
    if (pdfPath) {
      await uploadFile(page, 'input[type="file"]', pdfPath);
    }
  },
};

// ─── FIND SUBMIT BUTTON ──────────────────────────────────────────────────────

async function findSubmitButton(page) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit Application")',
    'button:has-text("Submit")',
    'button:has-text("Apply Now")',
    'button:has-text("Apply")',
    'button:has-text("Send Application")',
    '[data-qa="btn-submit"]',
    '.submit-app-btn',
  ];

  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await btn.isVisible();
      if (visible) return btn;
    }
  }
  return null;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));

  if (!url) {
    console.error('Usage: node stealth-apply.mjs <url> [--cover="..."] [--no-cover] [--pdf=path] [--headless=false] [--dry-run]');
    process.exit(1);
  }

  const headless     = !args.includes('--headless=false');
  const dryRun       = args.includes('--dry-run');
  const autoYes      = args.includes('--yes');
  const noCover      = args.includes('--no-cover');   // skip cover letter entirely
  const customCover  = args.find(a => a.startsWith('--cover='))?.slice(8)?.replace(/^["']|["']$/g, '');
  const customPDF    = args.find(a => a.startsWith('--pdf='))?.slice(6);
  const customSalary = args.find(a => a.startsWith('--salary='))?.slice(9)?.replace(/^["']|["']$/g, '');
  const securityCode = args.find(a => a.startsWith('--code='))?.slice(7)?.replace(/^["']|["']$/g, '');
  const customCompany = args.find(a => a.startsWith('--company='))?.slice(10)?.replace(/^["']|["']$/g, '');

  const candidate = loadCandidate();
  if (customSalary) candidate.salaryText = customSalary;
  const unanswered = [];  // collects skipped questions — written to logs/ after run

  const portal = detectPortal(url);
  // For company-hosted Greenhouse links, resolve to the direct form URL
  const resolvedUrl = portal === 'greenhouse' ? resolveGreenhouseUrl(url) : url;
  if (resolvedUrl !== url) {
    console.log(`   → Greenhouse embed detected — resolved to: ${resolvedUrl}`);
  }
  // Derive company slug: prefer explicit --company flag, then extract from URL
  const company = customCompany
    // BambooHR: company is in subdomain (engenious.bamboohr.com → engenious)
    || (portal === 'bamboohr' ? resolvedUrl.match(/https?:\/\/([a-z0-9-]+)\.bamboohr\.com/i)?.[1] : null)
    // Greenhouse board URLs: /COMPANY/jobs/ID
    || resolvedUrl.match(/greenhouse\.io\/([a-z0-9-]+)\/jobs\//i)?.[1]
    || resolvedUrl.match(/[?&]for=([^&]+)/i)?.[1]
    // Greenhouse embed token URLs — try to use original URL's domain (not boards.greenhouse.io)
    || (portal === 'greenhouse' && !url.includes('greenhouse.io') ? url.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] : null)
    // For lever.co/COMPANY, ashbyhq.com/COMPANY, jobvite.com/COMPANY, smartrecruiters.com/COMPANY
    || resolvedUrl.match(/(?:lever\.co|ashbyhq\.com|smartrecruiters\.com|jobvite\.com)\/([a-z0-9-]+)/i)?.[1]
    // Workday subdomain: COMPANY.myworkdayjobs.com
    || (portal === 'workday' ? resolvedUrl.match(/https?:\/\/([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i)?.[1] : null)
    || portal;
  const pdfPath = customPDF ? resolve(customPDF) : findResumePDF(company);

  console.log('\n🚀 career-ops stealth-apply');
  console.log(`   URL:     ${resolvedUrl}`);
  console.log(`   Portal:  ${portal}`);
  console.log(`   Company: ${company}`);
  console.log(`   Resume:  ${pdfPath || '(none found)'}`);
  console.log(`   Mode:    ${dryRun ? 'DRY RUN (no submit)' : 'LIVE'}`);
  console.log(`   Browser: ${headless ? 'headless' : 'visible'}`);

  // ── Generate cover letter ──
  // Skipped entirely when --no-cover flag is passed (e.g. base CV testing runs).
  let coverLetter = null;
  if (!noCover) {
    coverLetter = customCover || null;
    if (!coverLetter) {
      // Try to load from latest matching report
      const reportsDir = join(__dirname, 'reports');
      if (existsSync(reportsDir)) {
        const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
        const reports = readdirSync(reportsDir).filter(f =>
          f.endsWith('.md') && f.toLowerCase().includes(slug)
        );
        if (reports.length > 0) {
          const reportContent = readFileSync(join(reportsDir, reports[0]), 'utf-8');
          const coverMatch = reportContent.match(/^#+\s*cover letter[^\n]*\n+([\s\S]+?)(?=\n#+\s|\n\*\*[A-Z]|$)/im)
            || reportContent.match(/\*\*cover letter\*\*[^\n]*\n+([\s\S]+?)(?=\n\*\*[A-Z]|\n##|$)/im);
          if (coverMatch) coverLetter = coverMatch[1].trim();
        }
      }
    }
    // Only generate a generic fallback when there IS a matching report but no explicit cover section.
    // Do NOT auto-generate for completely unknown companies — attach nothing instead.
    if (!coverLetter && company !== portal) {
      console.log('  ℹ No cover letter found for this company — skipping (pass --cover="..." to add one)');
    }
  }

  // ── Launch browser ──
  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });

  const page = await context.newPage();

  // Extra stealth patches
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    console.log('\n⏳ Navigating to job page...');
    await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ── Fill form ──
    console.log('\n📝 Filling form...');
    const fillFn = PORTALS[portal] || PORTALS.generic;
    await fillFn(page, candidate, coverLetter, pdfPath, { securityCode, unanswered });

    await page.waitForTimeout(1000);

    // ── Option A: Human behavior simulation (boosts reCAPTCHA v3 score) ──
    if (!dryRun) {
      await humanBehavior(page);
    }

    // ── Screenshot ──
    const screenshotPath = await screenshot(page, company);
    console.log(`\n✅ Form filled. Review the screenshot before submitting.`);
    console.log(`   Open: ${screenshotPath}`);

    // ── Unanswered questions log ──
    if (unanswered.length) {
      const logsDir = join(__dirname, 'logs');
      mkdirSync(logsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const logPath = join(logsDir, `unanswered-questions-${date}.md`);
      const content = [
        `# Unanswered Questions — ${company} — ${date}`,
        '',
        `URL: ${resolvedUrl}`,
        '',
        '## Questions that need answers',
        ...unanswered.map(q => `- [ ] ${q}`),
        '',
        '## How to fix',
        'Add an entry to `config/form-answers.yml` for each question above:',
        '',
        '```yaml',
        '  - patterns: ["keyword from question"]',
        '    answer: "your answer"',
        '    type: text   # or: select',
        '```',
      ].join('\n');
      writeFileSync(logPath, content, 'utf-8');
      console.log(`\n📋 ${unanswered.length} unanswered question(s) logged → ${logPath}`);
    } else {
      console.log('\n✅ All questions answered!');
    }

    if (dryRun) {
      console.log('\n🏁 Dry run complete — no submission made.');
      await browser.close();
      return;
    }

    // ── Option B: reCAPTCHA v2 audio solve (if v2 checkbox detected) ──
    await solveRecaptchaV2(page);

    // ── Find submit button ──
    const submitBtn = await findSubmitButton(page);
    if (!submitBtn) {
      console.log('\n⚠ Could not find submit button automatically.');
      console.log('  If using --headless=false, you can submit manually in the browser.');
    } else {
      console.log('\n🔴 Submit button found and ready.');
    }

    // ── Confirm ──
    console.log('\n─────────────────────────────────────────');
    const answer = autoYes ? 'yes' : await confirm('Review the screenshot above. Submit application? (yes / no / open): ');

    if (answer === 'open') {
      // Open screenshot in default viewer
      const { exec } = await import('child_process');
      exec(`open "${screenshotPath}"`);
      const answer2 = await confirm('Submit application? (yes / no): ');
      if (answer2 !== 'yes') {
        console.log('\n❌ Submission cancelled.');
        await browser.close();
        return;
      }
    } else if (answer !== 'yes') {
      console.log('\n❌ Submission cancelled.');
      await browser.close();
      return;
    }

    // ── Submit with human-like click (move to button naturally, then click) ──
    if (submitBtn) {
      // One more natural mouse move to the button right before clicking
      const box = await submitBtn.boundingBox();
      if (box) {
        await moveMouseNaturally(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(randomBetween(200, 500));
      }

      console.log('\n📤 Submitting...');
      await submitBtn.click();
      await page.waitForTimeout(5000);

      // Check for confirmation
      const pageText = await page.innerText('body');
      const confirmed = pageText.toLowerCase().match(/thank you|application received|submitted|confirmation|success/);

      if (confirmed) {
        console.log('\n🎉 Application submitted successfully!');
      } else {
        const postPath = await screenshot(page, `${company}-post-submit`);
        console.log(`\n⚠ Could not confirm submission. Check screenshot: ${postPath}`);
      }
    }

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    await screenshot(page, `${company}-error`).catch(() => {});
  } finally {
    await browser.close();
  }
}

// ─── EXPORTS (for auto-apply.mjs orchestrator) ───────────────────────────────
export {
  PORTALS,
  loadCandidate,
  detectPortal,
  resolveGreenhouseUrl,
  findResumePDF,
  humanBehavior,
  solveRecaptchaV2,
  findSubmitButton,
  screenshot,
  humanType,
  safeFill,
  safeClick,
  uploadFile,
  randomBetween,
};

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────────────
// Only run when invoked directly (not when imported as a module)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
