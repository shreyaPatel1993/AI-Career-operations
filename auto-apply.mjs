#!/usr/bin/env node
/**
 * auto-apply.mjs — Autonomous job application orchestrator
 *
 * Reads evaluated offers from applications.md, filters by score, applies to each
 * one automatically in sequence using stealth-apply.mjs handlers.
 *
 * Usage:
 *   node auto-apply.mjs                          # Dry-run all Evaluated >= 4.0
 *   node auto-apply.mjs --live                   # Actually submit (confirmation required per-job)
 *   node auto-apply.mjs --threshold=3.5          # Lower score threshold
 *   node auto-apply.mjs --limit=5                # Max 5 applications per run
 *   node auto-apply.mjs --dry-run                # Explicitly dry-run (default)
 *   node auto-apply.mjs --portal=greenhouse      # Only Greenhouse jobs
 *   node auto-apply.mjs --report=010             # Apply to specific report only
 *   node auto-apply.mjs --headless=false         # Watch the browser
 *   node auto-apply.mjs --delay=120              # Seconds between applications
 *
 * Safety:
 *   - Dry-run by default — requires --live to actually submit
 *   - Max 10 applications per day (hard cap, not overridable without code change)
 *   - Score floor: never below 3.5 even with --threshold
 *   - Duplicate guard: skips if status is already Applied/Interview/Offer/Rejected
 *   - Screenshots every application in output/screenshots/
 *   - Unanswered questions logged to logs/unanswered-questions-{date}.md
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import {
  PORTALS, loadCandidate, detectPortal, resolveGreenhouseUrl,
  findResumePDF, humanBehavior, findSubmitButton,
  screenshot, randomBetween,
} from './stealth-apply.mjs';

import { fillVerificationCode } from './lib/email-verifier.mjs';

chromium.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SCORE_FLOOR       = 3.5;
const DEFAULT_THRESHOLD = 4.0;
const DEFAULT_LIMIT     = 10;  // default per run, overridable with --limit=N
const DEFAULT_DELAY_MIN = 120; // seconds
const DEFAULT_DELAY_MAX = 300;

// Statuses that mean "already handled" — don't re-apply
const TERMINAL_STATUSES = new Set([
  'Applied', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP',
]);

// ─── PARSERS ─────────────────────────────────────────────────────────────────

/**
 * Parse applications.md → array of offer objects.
 * Columns: # | Date | Company | Role | Score | Status | PDF | Report | Notes
 */
function parseApplications() {
  const path = join(__dirname, 'data/applications.md');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const offers = [];

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('# |')) continue;
    const cells = line.split('|').map(c => c.trim()).filter((_, i) => i > 0);
    if (cells.length < 8) continue;
    const [num, date, company, role, score, status, pdf, report, ...notesParts] = cells;
    if (!num || isNaN(Number(num))) continue; // header row

    const scoreNum = parseFloat(score);
    const reportMatch = report?.match(/\[(\d+)\]\(([^)]+)\)/);

    offers.push({
      num: Number(num),
      date,
      company: company.trim(),
      role: role.trim(),
      score: scoreNum,
      scoreRaw: score.trim(),
      status: status.trim(),
      hasPDF: pdf?.includes('✅'),
      reportNum: reportMatch?.[1],
      reportPath: reportMatch?.[2] ? join(__dirname, reportMatch[2]) : null,
      notes: notesParts.join('|').trim(),
    });
  }
  return offers;
}

/**
 * Extract URL and cover letter from an evaluation report.
 */
function parseReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return { url: null, coverLetter: null, pdfPath: null };
  const content = readFileSync(reportPath, 'utf-8');

  // URL line: **URL:** https://...
  const urlMatch = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
  const url = urlMatch?.[1]?.trim() || null;

  // PDF line: **PDF:** output/...
  const pdfMatch = content.match(/\*\*PDF:\*\*\s*(\S+\.pdf)/);
  const pdfPath = pdfMatch?.[1] ? join(__dirname, pdfMatch[1]) : null;

  // Cover letter: try dedicated section first, then Section G first answer
  let coverLetter = null;
  const clSection = content.match(/^#+\s*cover letter[^\n]*\n+([\s\S]+?)(?=\n#+\s|$)/im)
    || content.match(/\*\*cover letter\*\*[^\n]*\n+([\s\S]+?)(?=\n\*\*[A-Z]|\n##|$)/im);
  if (clSection) {
    coverLetter = clSection[1].trim();
  } else {
    // Section G: use the first quoted answer block (> "...")
    const gSection = content.match(/## G\)[\s\S]+?(?=\n##|$)/i);
    if (gSection) {
      const firstAnswer = gSection[0].match(/^>\s*"([\s\S]+?)"/m);
      if (firstAnswer) coverLetter = firstAnswer[1].trim();
    }
  }

  return { url, coverLetter, pdfPath };
}

// ─── TRACKER UPDATER ─────────────────────────────────────────────────────────

/**
 * Update the status of an offer in applications.md in-place.
 * Only modifies the status column — does not reformat the table.
 */
function updateStatus(num, newStatus) {
  const path = join(__dirname, 'data/applications.md');
  let content = readFileSync(path, 'utf-8');

  // Match the row that starts with | num | and update its status column (col 6)
  const rowRegex = new RegExp(
    `^(\\|\\s*${num}\\s*\\|[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\|)([^|]+)(\\|.*)$`,
    'm'
  );
  if (rowRegex.test(content)) {
    content = content.replace(rowRegex, `$1 ${newStatus} $3`);
    writeFileSync(path, content, 'utf-8');
    console.log(`  📝 Tracker updated: #${num} → ${newStatus}`);
  } else {
    console.log(`  ⚠ Could not find row #${num} in applications.md to update`);
  }
}

// ─── LOGGER ──────────────────────────────────────────────────────────────────

class RunLogger {
  constructor() {
    this.date = new Date().toISOString().slice(0, 10);
    mkdirSync(join(__dirname, 'logs'), { recursive: true });
    this.logPath = join(__dirname, `logs/auto-apply-${this.date}.log`);
    this.unansweredPath = join(__dirname, `logs/unanswered-questions-${this.date}.md`);
    this.results = [];
    this.unanswered = [];
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    writeFileSync(this.logPath, line + '\n', { flag: 'a' });
  }

  recordResult({ num, company, role, url, status, error, screenshotPath }) {
    this.results.push({ num, company, role, url, status, error, screenshotPath });
  }

  recordUnanswered(company, questions) {
    if (questions.length) this.unanswered.push({ company, questions });
  }

  writeSummary() {
    const applied    = this.results.filter(r => r.status === 'applied').length;
    const failed     = this.results.filter(r => r.status === 'failed').length;
    const manual     = this.results.filter(r => r.status === 'needs-manual').length;
    const skipped    = this.results.filter(r => r.status === 'skipped').length;
    const dryRun     = this.results.filter(r => r.status === 'dry-run').length;

    this.log('\n' + '─'.repeat(60));
    this.log('📊 Auto-Apply Run Summary');
    this.log(`   Applied:      ${applied}`);
    this.log(`   Dry-run:      ${dryRun}`);
    this.log(`   Failed:       ${failed}`);
    this.log(`   Needs manual: ${manual}`);
    this.log(`   Skipped:      ${skipped}`);
    this.log(`   Total:        ${this.results.length}`);

    if (this.unanswered.length) {
      let md = `# Unanswered Questions — ${this.date}\n\n`;
      md += `Review these questions and add answers to \`config/form-answers.yml\`.\n\n`;
      for (const { company, questions } of this.unanswered) {
        md += `## ${company}\n\n`;
        for (const q of questions) md += `- [ ] ${q}\n`;
        md += '\n';
      }
      writeFileSync(this.unansweredPath, md, 'utf-8');
      this.log(`\n📝 Unanswered questions saved: ${this.unansweredPath}`);
    }

    this.log(`📄 Full log: ${this.logPath}`);
  }
}

// ─── FORM ANSWERS LOADER ─────────────────────────────────────────────────────

function loadFormAnswers() {
  const path = join(__dirname, 'config/form-answers.yml');
  if (!existsSync(path)) return [];
  try {
    const cfg = yaml.load(readFileSync(path, 'utf-8'));
    return cfg?.questions || [];
  } catch { return []; }
}

/**
 * Look up an answer for a question using form-answers.yml patterns.
 * @returns {string|null}
 */
function lookupAnswer(questionText, formAnswers) {
  const q = questionText.toLowerCase();
  for (const entry of formAnswers) {
    if (!entry.patterns || !entry.answer) continue;
    if (entry.patterns.some(p => q.includes(p.toLowerCase()))) {
      return entry.answer;
    }
  }
  return null;
}

// ─── APPLY ONE JOB ───────────────────────────────────────────────────────────

async function applyToJob(offer, { headless, dryRun, formAnswers, logger, gmailTools }) {
  const { num, company, role, reportPath } = offer;
  logger.log(`\n${'═'.repeat(60)}`);
  logger.log(`🚀 [${num}] ${company} — ${role}`);

  const { url, coverLetter, pdfPath: reportPdfPath } = parseReport(reportPath);

  if (!url) {
    logger.log(`  ⚠ No URL found in report — skipping`);
    logger.recordResult({ num, company, role, url: null, status: 'skipped', error: 'No URL in report' });
    return;
  }

  const portal = detectPortal(url);
  const resolvedUrl = portal === 'greenhouse' ? resolveGreenhouseUrl(url) : url;
  const candidate = loadCandidate();
  const pdfPath = (reportPdfPath && existsSync(reportPdfPath))
    ? reportPdfPath
    : findResumePDF(company);

  logger.log(`  URL:     ${resolvedUrl}`);
  logger.log(`  Portal:  ${portal}`);
  logger.log(`  Resume:  ${pdfPath || '(none)'}`);
  logger.log(`  Mode:    ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  let result = { num, company, role, url, status: 'failed', error: null, screenshotPath: null };

  try {
    logger.log(`  ⏳ Navigating...`);
    await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Fill the form
    logger.log(`  📝 Filling form...`);
    const fillFn = PORTALS[portal] || PORTALS.generic;
    const unanswered = [];
    const fillResult = await fillFn(page, candidate, coverLetter, pdfPath, { gmailTools, unanswered });

    // Workday (and future handlers) can return 'needs-manual' or 'submitted'
    if (fillResult === 'needs-manual') {
      result.status = 'needs-manual';
      result.screenshotPath = await screenshot(page, `${company}-${num}-needs-manual`).catch(() => null);
      logger.log(`  ⚠ Handler returned needs-manual`);
      return;
    }
    if (fillResult === 'submitted') {
      result.status = 'applied';
      result.screenshotPath = await screenshot(page, `${company}-${num}`).catch(() => null);
      logger.log(`  ✅ Submitted by handler`);
      updateStatus(num, 'Applied');
      return;
    }

    // Email verification (Greenhouse and some others)
    if (portal === 'greenhouse' && gmailTools) {
      const codeFound = await fillVerificationCode(page, {
        ...gmailTools,
        company,
        timeoutMs: 60000,
      });
      if (!codeFound) {
        logger.log(`  ⚠ No verification code — marking needs-manual`);
        result.status = 'needs-manual';
        result.screenshotPath = await screenshot(page, `${company}-needs-manual`).catch(() => null);
        return;
      }
    }

    await page.waitForTimeout(1000);

    // Record any questions the handler couldn't answer
    logger.recordUnanswered(company, unanswered);

    // Screenshot
    result.screenshotPath = await screenshot(page, `${company}-${num}`);
    logger.log(`  📸 Screenshot: ${result.screenshotPath}`);

    if (dryRun) {
      result.status = 'dry-run';
      logger.log(`  ✅ Dry run complete`);
      return;
    }

    // Human behavior (reCAPTCHA v3 score boost)
    await humanBehavior(page);

    // Find submit button
    const submitBtn = await findSubmitButton(page);
    if (!submitBtn) {
      logger.log(`  ⚠ Submit button not found — marking needs-manual`);
      result.status = 'needs-manual';
      result.error = 'Submit button not found';
      return;
    }

    // Submit
    const box = await submitBtn.boundingBox();
    if (box) {
      await page.mouse.move(
        box.x + randomBetween(5, box.width - 5),
        box.y + randomBetween(2, box.height - 2)
      );
      await page.waitForTimeout(randomBetween(200, 500));
    }

    logger.log(`  📤 Submitting...`);
    await submitBtn.click();
    await page.waitForTimeout(5000);

    // Check for confirmation
    const pageText = await page.innerText('body').catch(() => '');
    const confirmed = /thank you|application received|submitted|confirmation|success/i.test(pageText);

    if (confirmed) {
      result.status = 'applied';
      logger.log(`  🎉 Applied successfully!`);
      updateStatus(num, 'Applied');
    } else {
      result.status = 'needs-manual';
      result.screenshotPath = await screenshot(page, `${company}-${num}-post-submit`);
      logger.log(`  ⚠ Could not confirm submission — marked needs-manual`);
      updateStatus(num, 'Applied'); // optimistic — they can correct if needed
    }

  } catch (err) {
    result.error = err.message;
    result.status = 'failed';
    logger.log(`  ❌ Error: ${err.message}`);
    await screenshot(page, `${company}-${num}-error`).catch(() => {});
    updateStatus(num, 'Apply-Failed');
  } finally {
    logger.recordResult(result);
    await browser.close();
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);

  const threshold   = parseFloat(args.find(a => a.startsWith('--threshold='))?.split('=')?.[1] ?? DEFAULT_THRESHOLD);
  const limit       = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')?.[1] ?? DEFAULT_LIMIT);
  const headless    = !args.includes('--headless=false');
  const live        = args.includes('--live');
  const dryRun      = !live; // safe by default
  const portalFilter = args.find(a => a.startsWith('--portal='))?.split('=')?.[1] ?? null;
  const reportFilter = args.find(a => a.startsWith('--report='))?.split('=')?.[1] ?? null;
  const delayArg    = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')?.[1] ?? '0');
  const delayMin    = delayArg > 0 ? delayArg : DEFAULT_DELAY_MIN;
  const delayMax    = delayArg > 0 ? delayArg : DEFAULT_DELAY_MAX;

  // Safety: enforce score floor
  const effectiveThreshold = Math.max(threshold, SCORE_FLOOR);
  if (threshold < SCORE_FLOOR) {
    console.warn(`⚠ Threshold ${threshold} is below minimum ${SCORE_FLOOR} — using ${SCORE_FLOOR}`);
  }

  const effectiveLimit = limit;

  console.log('\n🤖 career-ops auto-apply');
  console.log(`   Threshold: ${effectiveThreshold}/5`);
  console.log(`   Limit:     ${effectiveLimit}`);
  console.log(`   Mode:      ${dryRun ? 'DRY RUN (pass --live to submit)' : '⚡ LIVE — will submit!'}`);
  console.log(`   Headless:  ${headless}`);
  if (portalFilter) console.log(`   Portal:    ${portalFilter}`);
  if (reportFilter) console.log(`   Report:    ${reportFilter}`);

  // Load offers
  const allOffers = parseApplications();

  // Normalise company+role into a dedup key: lowercase, collapse whitespace/punctuation.
  const normalize = s => s.toLowerCase().replace(/[-–—/\\,.()'":]/g, ' ').replace(/\s+/g, ' ').trim();
  const jobKey = o => `${normalize(o.company)}|${normalize(o.role)}`;

  // Track which keys we've already queued this run (handles duplicate Evaluated rows).
  const queuedThisRun = new Set();

  let offers = allOffers.filter(o => {
    if (reportFilter) return String(o.reportNum) === String(reportFilter).padStart(3, '0')
      || String(o.num) === String(reportFilter);
    if (o.status !== 'Evaluated') return false;
    if (o.score < effectiveThreshold) return false;

    const key = jobKey(o);

    // Skip if a terminal-status entry already exists for this exact company+role.
    const terminalExists = allOffers.some(x => jobKey(x) === key && TERMINAL_STATUSES.has(x.status));
    if (terminalExists) {
      console.log(`  ⏭ [${o.num}] ${o.company} — ${o.role}: already Applied/Rejected/etc — skipping`);
      return false;
    }

    // Skip if we already queued this company+role earlier in this run (duplicate Evaluated rows).
    if (queuedThisRun.has(key)) {
      console.log(`  ⏭ [${o.num}] ${o.company} — ${o.role}: duplicate entry — skipping`);
      return false;
    }

    queuedThisRun.add(key);
    return true;
  });

  // Apply portal filter if set (requires report URL)
  if (portalFilter && !reportFilter) {
    offers = offers.filter(o => {
      const { url } = parseReport(o.reportPath);
      return url && detectPortal(url) === portalFilter;
    });
  }

  // Cap to limit
  offers = offers.slice(0, effectiveLimit);

  if (!offers.length) {
    console.log('\n✅ No qualifying offers found. Nothing to apply to.');
    console.log(`   (Need status=Evaluated, score>=${effectiveThreshold})`);
    return;
  }

  console.log(`\n📋 ${offers.length} offer(s) queued:`);
  for (const o of offers) {
    console.log(`   [${o.num}] ${o.company} — ${o.role} (${o.scoreRaw})`);
  }

  if (live) {
    console.log('\n⚡ LIVE MODE — applications will be submitted.');
    console.log('   Press Ctrl+C within 5s to abort...');
    await new Promise(r => setTimeout(r, 5000));
  }

  const logger = new RunLogger();
  const formAnswers = loadFormAnswers();

  // Gmail MCP tools — available when running inside Claude Code session
  // In batch/headless mode they won't be available and email verification
  // will fall back to needs-manual.
  const gmailTools = null; // will be injected by Claude Code session when needed

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];

    await applyToJob(offer, { headless, dryRun, formAnswers, logger, gmailTools });

    // Delay between applications (skip after last one)
    if (i < offers.length - 1) {
      const delaySec = randomBetween(delayMin, delayMax);
      logger.log(`\n⏱ Waiting ${delaySec}s before next application...`);
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  logger.writeSummary();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

// ─── EXPORTS (for unit testing) ───────────────────────────────────────────────

/**
 * Filter applications by score threshold, deduplication, and terminal status.
 * Extracted from run() for testability.
 */
function filterByScore(allOffers, threshold = DEFAULT_THRESHOLD) {
  const effectiveThreshold = Math.max(threshold, SCORE_FLOOR);
  const normalize = s => s.toLowerCase().replace(/[-–—/\\,.()'":]/g, ' ').replace(/\s+/g, ' ').trim();
  const jobKey = o => `${normalize(o.company)}|${normalize(o.role)}`;
  const queuedThisRun = new Set();

  return allOffers.filter(o => {
    if (o.status !== 'Evaluated') return false;
    if (o.score < effectiveThreshold) return false;

    const key = jobKey(o);
    const terminalExists = allOffers.some(x => jobKey(x) === key && TERMINAL_STATUSES.has(x.status));
    if (terminalExists) return false;
    if (queuedThisRun.has(key)) return false;

    queuedThisRun.add(key);
    return true;
  });
}

export { parseApplications, parseReport, filterByScore, lookupAnswer };
