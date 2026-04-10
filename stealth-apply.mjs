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
 *
 * Examples:
 *   node stealth-apply.mjs "https://job-boards.greenhouse.io/embed/job_app?for=rxvantage&token=5599280004"
 *   node stealth-apply.mjs "https://jobs.lever.co/company/job-id/apply"
 *   node stealth-apply.mjs "https://company.myworkdayjobs.com/..." --headless=false
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import yaml from 'js-yaml';

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
    visaStatus: 'US Citizen',
    authorized: 'Yes',
    salary:     profile.compensation?.target_range || '$140,000 - $175,000',
    salaryText: '$145,000 - $175,000 base. Open to equity and bonus discussion.',
  };
}

function findResumePDF(preferCompany = '') {
  const outputDir = join(__dirname, 'output');
  if (!existsSync(outputDir)) return null;
  const pdfs = readdirSync(outputDir)
    .filter(f => f.endsWith('.pdf'))
    .map(f => ({ name: f, path: join(outputDir, f), mtime: readFileSync(join(outputDir, f)).length }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!pdfs.length) return null;
  // Prefer PDF matching company name
  if (preferCompany) {
    const slug = preferCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = pdfs.find(p => p.name.toLowerCase().includes(slug));
    if (match) return match.path;
  }
  return pdfs[0].path;
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
  return 'generic';
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
    await page.waitForSelector(selector, { timeout });
    await page.setInputFiles(selector, filePath);
    console.log(`  ✅ Resume uploaded: ${filePath}`);
    return true;
  } catch {
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

// ─── PORTAL STRATEGIES ───────────────────────────────────────────────────────

const PORTALS = {

  // ── GREENHOUSE ────────────────────────────────────────────────────────────
  async greenhouse(page, candidate, coverLetter, pdfPath, { securityCode } = {}) {
    console.log('\n🌱 Greenhouse detected');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.waitForSelector('#first_name, input[name="first_name"]', { timeout: 10000 });

    const isNewBoard = page.url().includes('job-boards.greenhouse.io');
    console.log(`  → ${isNewBoard ? 'New Remix board' : 'Classic board'}`);

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
      await PORTALS._selectComboOption(page, locationInput, 'Los Angeles');
      console.log('  ✅ Location: Los Angeles, CA');
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

    // ── Security / verification code (Greenhouse emails this before submission) ──
    // Greenhouse sometimes sends a one-time code to verify the applicant's email.
    // Pass it via --code=XXXXXXXX  e.g.  npm run apply <url> --code=Q783GBHb
    if (securityCode) {
      const codeSelectors = [
        '#security_code',
        'input[id*="security" i]',
        'input[placeholder*="security code" i]',
        'input[placeholder*="verification" i]',
        'input[placeholder*="access code" i]',
        'input[label*="code" i]',
      ];
      let codeFilled = false;
      for (const sel of codeSelectors) {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await humanType(page, sel, securityCode, { optional: true });
          console.log(`  ✅ Security code filled: ${securityCode}`);
          codeFilled = true;
          break;
        }
      }
      if (!codeFilled) {
        // Try any short text input near the word "code" in its label
        const inputs = await page.$$('input[type="text"], input[type="number"]');
        for (const inp of inputs) {
          const id = await inp.getAttribute('id') || '';
          const label = await page.$(`label[for="${id}"]`);
          const labelText = label ? (await label.innerText()).toLowerCase() : '';
          if (labelText.includes('code') || labelText.includes('security') || labelText.includes('verify')) {
            await inp.fill(securityCode);
            console.log(`  ✅ Security code filled via label match ("${labelText}"): ${securityCode}`);
            codeFilled = true;
            break;
          }
        }
      }
      if (!codeFilled) {
        console.log(`  ⚠ Security code field not found — if visible in browser, enter manually: ${securityCode}`);
      }
    } else {
      // No code provided — check if field exists and warn
      const codeField = await page.$('#security_code, input[id*="security" i], input[placeholder*="security code" i]');
      if (codeField && await codeField.isVisible()) {
        console.log(`\n  ⚠ Security code field detected! Greenhouse sent a code to ${candidate.email}.`);
        console.log('  Re-run with: --code=XXXXXXXX  (use the code from your email)');
      }
    }

    // ── Custom questions (new board: all rendered as text inputs / comboboxes) ──
    await PORTALS._greenhouseQuestions(page, candidate);

    // ── EEOC — decline all (voluntary) ──
    await PORTALS._greenhouseEEOC(page);
  },

  async _greenhouseQuestions(page, candidate) {
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
      if (q.includes('linkedin') || q.includes('linked in'))         return { type: 'text', value: candidate.linkedin };
      if (q.includes('portfolio') || q.includes('website'))          return { type: 'text', value: candidate.portfolio };
      if (q.includes('github'))                                       return { type: 'text', value: candidate.github || '' };
      if (q.includes('salary') || q.includes('compensation') || q.includes('target pay') || q.includes('expected pay'))
                                                                      return { type: 'text', value: candidate.salaryText };
      // Yes answers
      if (q.includes('authorized to work') || q.includes('eligible to work') || q.includes('legally authorized'))
                                                                      return { type: 'yesno', value: 'Yes' };
      if (q.includes('us citizen') || q.includes('work in the us') || q.includes('work in the united states'))
                                                                      return { type: 'yesno', value: 'Yes' };
      if ((q.includes('cross-functional') || q.includes('cross functional')) ||
          (q.includes('designer') && q.includes('product manager'))) return { type: 'yesno', value: 'Yes' };
      if (q.includes('remote') && !q.includes('require') && !q.includes('sponsorship'))
                                                                      return { type: 'yesno', value: 'Yes' };
      // No answers
      if (q.includes('sponsorship'))                                  return { type: 'yesno', value: 'No' };
      if (q.includes('require relocation') || q.includes('willing to relocate'))
                                                                      return { type: 'yesno', value: 'No' };
      // Years experience — open dropdown and pick the range that fits
      if (q.includes('year') && (q.includes('react') || q.includes('experience') || q.includes('professional')))
                                                                      return { type: 'years', value: 7 };
      // State (combobox — type to filter)
      if (q.includes('which state') || q.includes('state are you') || q.includes('state do you') || q.includes('state you plan'))
                                                                      return { type: 'yesno', value: 'California' };
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
      if (!decision || decision.type !== 'yesno') continue;

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
      const decision = decide(q);
      if (!decision) continue;

      if (decision.type === 'years') {
        await PORTALS._selectYearsOption(page, el, decision.value);
      } else if (decision.type === 'text') {
        await el.fill(decision.value);
        console.log(`  ✅ [text] ${q.slice(0, 60)}: ${decision.value}`);
      } else if (decision.type === 'yesno') {
        await PORTALS._selectComboOption(page, el, decision.value);
        console.log(`  ✅ [combo] ${q.slice(0, 60)}: ${decision.value}`);
      }
    }

    // ── 3. Classic <select> elements ─────────────────────────────────────────
    const selectEls = await page.$$('select[id^="question_"]');
    for (const sel of selectEls) {
      const q = await getQuestionText(sel);
      const decision = decide(q);
      if (!decision) continue;

      const options = await sel.evaluate(el => [...el.options].map(o => ({ text: o.text.trim(), value: o.value })));
      const match = options.find(o => o.text.toLowerCase() === decision.value.toLowerCase());
      if (match) {
        await sel.selectOption({ value: match.value });
        console.log(`  ✅ [select] ${q.slice(0, 60)}: ${decision.value}`);
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
      if (!opts.length) { await page.keyboard.press('Escape'); return false; }

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
      await inputEl.selectAll?.().catch(() => {});
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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Check if we need to click Apply button first
    const applyBtn = await page.$('.template-btn-submit, a[href*="/apply"], button:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
    }

    await safeFill(page, 'input[name="name"], #name', candidate.fullName);
    await safeFill(page, 'input[name="email"], #email', candidate.email);
    await safeFill(page, 'input[name="phone"], #phone', candidate.phoneFormatted, { optional: true });
    await safeFill(page, 'input[name="org"], input[name="company"], #org', 'TCS', { optional: true });
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
  async workday(page, candidate, coverLetter, pdfPath) {
    console.log('\n🔷 Workday detected (multi-step — monitoring progress)');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Click Apply button if on job description page
    const applyBtn = await page.$('a[href*="apply"], button:has-text("Apply"), a:has-text("Apply Now")');
    if (applyBtn) {
      console.log('  → Clicking Apply button');
      await applyBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
    }

    // Workday may ask for login/create account
    const createAccountBtn = await page.$('a:has-text("Create Account"), button:has-text("Create Account")', ).catch(() => null);
    if (createAccountBtn) {
      console.log('  ⚠ Workday requires account creation — taking screenshot for manual completion');
      return;
    }

    // Step 1: Resume upload (Workday usually starts here)
    if (pdfPath) {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(pdfPath);
        console.log('  ✅ Resume uploaded');
        await page.waitForTimeout(3000); // Workday parses resume
      }
    }

    // Fill fields by label text (Workday uses data-automation-id)
    const fields = [
      ['[data-automation-id="legalNameSection_firstName"], input[aria-label*="First Name"]',  candidate.firstName],
      ['[data-automation-id="legalNameSection_lastName"], input[aria-label*="Last Name"]',   candidate.lastName],
      ['[data-automation-id="email"], input[aria-label*="Email"]',                           candidate.email],
      ['[data-automation-id="phone-number"], input[aria-label*="Phone"]',                   candidate.phoneFormatted],
    ];
    for (const [sel, val] of fields) {
      await safeFill(page, sel, val, { optional: true, timeout: 3000 });
    }

    // Cover letter
    if (coverLetter) {
      await safeFill(page, 'textarea[aria-label*="Cover"], textarea[aria-label*="cover"], [data-automation-id*="coverLetter"] textarea', coverLetter, { optional: true });
    }

    // Work authorization
    await safeClick(page, '[data-automation-id*="authorized"] input[value="1"], input[aria-label*="authorized"][type="radio"]', { optional: true });

    console.log('  ℹ Workday is multi-step. Review each step before proceeding.');
  },

  // ── ASHBY ─────────────────────────────────────────────────────────────────
  async ashby(page, candidate, coverLetter, pdfPath) {
    console.log('\n🔶 Ashby detected');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

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
    console.error('Usage: node stealth-apply.mjs <url> [--cover="..."] [--pdf=path] [--headless=false] [--dry-run]');
    process.exit(1);
  }

  const headless     = !args.includes('--headless=false');
  const dryRun       = args.includes('--dry-run');
  const customCover  = args.find(a => a.startsWith('--cover='))?.slice(8)?.replace(/^["']|["']$/g, '');
  const customPDF    = args.find(a => a.startsWith('--pdf='))?.slice(6);
  const customSalary = args.find(a => a.startsWith('--salary='))?.slice(9)?.replace(/^["']|["']$/g, '');
  const securityCode = args.find(a => a.startsWith('--code='))?.slice(7)?.replace(/^["']|["']$/g, '');

  const candidate = loadCandidate();
  if (customSalary) candidate.salaryText = customSalary;

  const portal = detectPortal(url);
  const company = url.match(/for=(\w+)|\/([a-z0-9-]+)\/jobs\//i)?.[1] || portal;
  const pdfPath = customPDF ? resolve(customPDF) : findResumePDF(company);

  console.log('\n🚀 career-ops stealth-apply');
  console.log(`   URL:     ${url}`);
  console.log(`   Portal:  ${portal}`);
  console.log(`   Company: ${company}`);
  console.log(`   Resume:  ${pdfPath || '(none found)'}`);
  console.log(`   Mode:    ${dryRun ? 'DRY RUN (no submit)' : 'LIVE'}`);
  console.log(`   Browser: ${headless ? 'headless' : 'visible'}`);

  // ── Generate cover letter ──
  let coverLetter = customCover;
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
        const coverMatch = reportContent.match(/cover letter.*?\n([\s\S]+?)(?=\n##|$)/i);
        if (coverMatch) coverLetter = coverMatch[1].trim();
      }
    }
  }
  if (!coverLetter) {
    coverLetter = `Senior Frontend Engineer with 7+ years building React 18 and TypeScript applications at scale -- serving 20M+ users at Citi and leading a React 18 team at J&J (10K+ daily users). Expert in component architecture, performance optimization, REST/GraphQL API integration, and CI/CD. US Citizen, no sponsorship needed. Targeting ${candidate.salaryText}.`;
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ── Fill form ──
    console.log('\n📝 Filling form...');
    const fillFn = PORTALS[portal] || PORTALS.generic;
    await fillFn(page, candidate, coverLetter, pdfPath, { securityCode });

    await page.waitForTimeout(1000);

    // ── Option A: Human behavior simulation (boosts reCAPTCHA v3 score) ──
    if (!dryRun) {
      await humanBehavior(page);
    }

    // ── Screenshot ──
    const screenshotPath = await screenshot(page, company);
    console.log(`\n✅ Form filled. Review the screenshot before submitting.`);
    console.log(`   Open: ${screenshotPath}`);

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
    const answer = await confirm('Review the screenshot above. Submit application? (yes / no / open): ');

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

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
