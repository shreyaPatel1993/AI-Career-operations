#!/usr/bin/env node
/**
 * jobright-fetch.mjs
 * Fetches curated job recommendations from Jobright.ai API
 * and adds new matches to data/pipeline.md + data/scan-history.tsv
 *
 * Usage:
 *   node jobright-fetch.mjs              # fetch and add to pipeline
 *   node jobright-fetch.mjs --dry-run    # preview without writing
 *   node jobright-fetch.mjs --json       # output raw JSON only
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ── Args ─────────────────────────────────────────────────────────────────────
const DRY_RUN  = process.argv.includes('--dry-run');
const JSON_OUT = process.argv.includes('--json');
const DEBUG    = process.argv.includes('--debug');

// ── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = join(ROOT, 'config/jobright.yml');
  if (!existsSync(configPath)) {
    console.error('❌  config/jobright.yml not found. Copy config/jobright.example.yml and add your cookie.');
    process.exit(1);
  }
  // Simple YAML key: value parser (no external deps)
  const raw = readFileSync(configPath, 'utf8');
  // Support both session_id (simple) and cookie (full string) formats
  const sessionId = raw.match(/^\s*session_id:\s*"?([a-f0-9]+)"?\s*$/m)?.[1] ?? '';
  const fullCookie = (raw.match(/^\s*cookie:\s*"(.+?)"\s*$/m)?.[1] ?? '')
                      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const cookie = sessionId
    ? `SESSION_ID=${sessionId}`
    : fullCookie.includes('SESSION_ID=')
    ? fullCookie
    : fullCookie;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
  const pages     = parseInt(raw.match(/^\s*pages:\s*(\d+)/m)?.[1] ?? '4');
  const maxAge    = parseInt(raw.match(/^\s*max_age_days:\s*(\d+)/m)?.[1] ?? '3');
  const count     = parseInt(raw.match(/^\s*count:\s*(\d+)/m)?.[1] ?? '25');
  if (!cookie || cookie.length < 20) {
    console.error('❌  No SESSION_ID found in config/jobright.yml.');
    console.error('    Add: session_id: "your-session-id-value"');
    process.exit(1);
  }
  return { cookie, userAgent, pages, maxAge, count };
}

// ── Title filter (mirrors portals.yml) ───────────────────────────────────────
const POSITIVE = [
  'frontend', 'front-end', 'front end', 'react', 'ui engineer', 'ui developer',
  'web engineer', 'javascript engineer', 'typescript engineer', 'next.js',
  'full stack', 'fullstack', 'web developer', 'software engineer',
];
const NEGATIVE = [
  'junior', 'intern', '.net', 'java ', 'ios', 'android', 'php', 'ruby',
  'embedded', 'firmware', 'fpga', 'asic', 'blockchain', 'web3', 'crypto',
  'salesforce admin', 'sap ', 'oracle ebs', 'mainframe', 'cobol',
  'backend', 'back-end', 'data engineer', 'data scientist', 'machine learning',
  'devops', 'sre', 'infrastructure', 'staff ', 'principal ', 'head of',
  'director', 'vp ',
];

function titleMatches(title) {
  const t = title.toLowerCase();
  const hasPositive = POSITIVE.some(k => t.includes(k));
  const hasNegative = NEGATIVE.some(k => t.includes(k));
  return hasPositive && !hasNegative;
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function ageLabel(postedAt) {
  if (!postedAt) return '⚠️ [unknown]';
  const diffMs   = Date.now() - new Date(postedAt).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHrs  = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 60)         return `🔥 [${diffMins}m ago]`;
  if (diffHrs < 24)          return `🔥 [${diffHrs}h ago]`;
  if (diffDays === 1)        return '🔥 [1d ago]';
  if (diffDays <= 3)         return `✅ [${diffDays}d ago]`;
  if (diffDays <= 7)         return `⚠️ [${diffDays}d ago]`;
  if (diffDays <= 14)        return `❌ [${diffDays}d ago]`;
  return `🚫 [${diffDays}d ago]`;
}

function isWithinMaxAge(postedAt, maxAge) {
  if (!postedAt) return true; // keep unknowns, let user decide
  const diffDays = Math.floor((Date.now() - new Date(postedAt).getTime()) / 86_400_000);
  return diffDays <= maxAge;
}

// ── Dedup sources ─────────────────────────────────────────────────────────────
function loadSeenUrls() {
  const seen = new Set();
  const files = [
    join(ROOT, 'data/scan-history.tsv'),
    join(ROOT, 'data/pipeline.md'),
    join(ROOT, 'data/applications.md'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const content = readFileSync(f, 'utf8');
    const urls = content.match(/https?:\/\/[^\s|)\]]+/g) ?? [];
    urls.forEach(u => seen.add(u.trim()));
  }
  return seen;
}

// ── Fetch one page (native https — avoids fetch quirks with cookies) ──────────
function fetchPage(position, config) {
  return new Promise((resolve, reject) => {
    const qs = `refresh=${position === 0 ? 'true' : 'false'}&sortCondition=1&position=${position}&count=${config.count}&syncRerank=false`;
    const path = `/swan/recommend/list/jobs?${qs}`;

    if (DEBUG) console.log(`\nDEBUG fetching: https://jobright.ai${path}`);

    const options = {
      hostname: 'jobright.ai',
      path,
      method:   'GET',
      headers: {
        'cookie':          config.cookie,   // already "SESSION_ID=xxxx"
        'accept-encoding': 'gzip, deflate, br',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] ?? '').toLowerCase();

        const decompress = enc.includes('br')
          ? cb => zlib.brotliDecompress(buf, cb)
          : enc.includes('gzip')
          ? cb => zlib.gunzip(buf, cb)
          : enc.includes('deflate')
          ? cb => zlib.inflate(buf, cb)
          : cb => cb(null, buf);

        decompress((err, decoded) => {
          if (err) return reject(err);
          const body = decoded.toString('utf8');

          if (DEBUG) {
            console.log(`DEBUG status: ${res.statusCode}`);
            console.log(`DEBUG body (first 400): ${body.slice(0, 400)}`);
          }

          if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403) {
            console.error(`\n❌  Auth error (${res.statusCode})`);
            console.error(`    Server says: ${body.slice(0, 200)}`);
            console.error('\nTo refresh cookies:');
            console.error('  1. Log into jobright.ai, go to /jobs/recommend');
            console.error('  2. DevTools → Network → filter "/swan/" → click any request');
            console.error('  3. Copy the "cookie:" header value → paste into config/jobright.yml');
            process.exit(1);
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 100)}`));

          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 100)}`)); }
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Parse job from Jobright response ─────────────────────────────────────────
function parseJob(item) {
  // item = { jobResult: {...}, companyResult: {...}, displayScore, rankDesc }
  const j = item.jobResult ?? item;
  const c = item.companyResult ?? {};

  const id       = j.jobId ?? '';
  const title    = j.jobTitle ?? j.jobNlpTitle ?? '';
  const company  = c.companyName ?? c.name ?? j.companyName ?? '';
  // publishTime is "2026-04-10 00:39:13" string
  const postedAt = j.publishTime ? new Date(j.publishTime).toISOString() : null;
  const location = j.jobLocation ?? '';
  const jobUrl   = j.originalUrl ?? j.applyLink
                ?? (id ? `https://jobright.ai/jobs/info/${id}` : '');
  const isRemote = j.isRemote === true
                || j.workModel?.toLowerCase().includes('remote')
                || location.toLowerCase().includes('remote');
  const salary   = j.salaryDesc ?? '';
  const score    = item.displayScore ?? null;
  const matchRank = item.rankDesc ?? '';

  return { id, title, company, postedAt, location, jobUrl, isRemote, salary, score, matchRank };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const config  = loadConfig();
  const seenUrls = loadSeenUrls();
  const today   = new Date().toISOString().slice(0, 10);

  const allJobs   = [];
  const newJobs   = [];
  const skipped   = { dup: 0, title: 0, age: 0 };

  // Fetch pages
  if (DEBUG) {
    console.log(`\nDEBUG cookie (first 80 chars): ${config.cookie.slice(0, 80)}`);
    console.log(`DEBUG cookie length: ${config.cookie.length}`);
    console.log(`DEBUG cookie contains raw backslash-quote: ${config.cookie.includes('\\"')}`);
    console.log(`DEBUG SESSION_ID: ${config.cookie.match(/SESSION_ID=([^;]+)/)?.[1]}`);
  }
  if (!JSON_OUT) process.stdout.write(`\nFetching Jobright recommendations`);
  for (let page = 0; page < config.pages; page++) {
    const position = page * config.count;
    try {
      const data = await fetchPage(position, config);
      if (!JSON_OUT) process.stdout.write('.');

      // Jobright response shape: { result: { jobList: [ { jobResult: {...}, companyResult: {...} } ] } }
      const jobList = data?.result?.jobList ?? data?.data?.jobs ?? data?.jobs ?? [];
      if (!Array.isArray(jobList) || jobList.length === 0) break;
      allJobs.push(...jobList); // keep full item so we can access companyResult
    } catch (err) {
      if (!JSON_OUT) console.error(`\n⚠️  Page ${page + 1} failed: ${err.message}`);
      break;
    }
  }
  if (!JSON_OUT) console.log(` done (${allJobs.length} total)\n`);

  if (JSON_OUT) {
    console.log(JSON.stringify(allJobs, null, 2));
    return;
  }

  // Filter
  for (const item of allJobs) {
    const job = parseJob(item);
    if (!job.jobUrl) continue;

    if (seenUrls.has(job.jobUrl)) { skipped.dup++;   continue; }
    if (!titleMatches(job.title)) { skipped.title++; continue; }
    if (!isWithinMaxAge(job.postedAt, config.maxAge)) { skipped.age++; continue; }

    newJobs.push(job);
  }

  // Sort: newest date first, then Strong Match > Good Match within same date
  const RANK_ORDER = { 'Strong Match': 0, 'Good Match': 1 };
  newJobs.sort((a, b) => {
    // 1. Date descending (newest first)
    const tA = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const tB = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    if (tB !== tA) return tB - tA;
    // 2. Match rank (Strong Match before Good Match)
    const rA = RANK_ORDER[a.matchRank] ?? 99;
    const rB = RANK_ORDER[b.matchRank] ?? 99;
    return rA - rB;
  });

  // Separate by priority
  const fresh    = newJobs.filter(j => { const l = ageLabel(j.postedAt); return l.startsWith('🔥'); });
  const recent   = newJobs.filter(j => { const l = ageLabel(j.postedAt); return l.startsWith('✅'); });
  const older    = newJobs.filter(j => { const l = ageLabel(j.postedAt); return l.startsWith('⚠️') || l.startsWith('❌'); });

  // ── Write to pipeline.md ──────────────────────────────────────────────────
  if (!DRY_RUN && newJobs.length > 0) {
    const pipelinePath = join(ROOT, 'data/pipeline.md');
    let pipeline = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '# Pipeline — Pending Evaluations\n\n## Pendientes\n\n';

    // Ensure section exists
    if (!pipeline.includes('## Pendientes')) {
      pipeline += '\n## Pendientes\n\n';
    }

    // Prepend new jobs (newest first) right after ## Pendientes
    const lines = newJobs.map(j => {
      const label  = ageLabel(j.postedAt);
      const remote = j.isRemote ? ' 🌐' : '';
      const sal    = j.salary ? ` | ${j.salary}` : '';
      const match  = j.score  ? ` | ⭐${Math.round(j.score)}% ${j.matchRank}` : '';
      return `- [ ] ${j.jobUrl} | ${j.company} | ${j.title}${remote}${sal}${match} | ${label}`;
    }).join('\n');

    pipeline = pipeline.replace('## Pendientes\n', `## Pendientes\n\n${lines}\n`);
    writeFileSync(pipelinePath, pipeline);
  }

  // ── Write to scan-history.tsv ─────────────────────────────────────────────
  if (!DRY_RUN && newJobs.length > 0) {
    const historyPath = join(ROOT, 'data/scan-history.tsv');
    if (!existsSync(historyPath)) {
      writeFileSync(historyPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
    }
    const rows = newJobs.map(j =>
      `${j.jobUrl}\t${today}\tJobright API\t${j.title}\t${j.company}\tadded`
    ).join('\n');
    appendFileSync(historyPath, rows + '\n');

    // Also record skipped entries from this run (title mismatches from this batch only)
    // We don't log all skips to avoid bloating the file, just the count
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log(`Jobright Scan — ${today}`);
  console.log('━'.repeat(40));
  console.log(`Total fetched:          ${allJobs.length}`);
  console.log(`Filtered by title:      ${skipped.title} skipped`);
  console.log(`Duplicates skipped:     ${skipped.dup}`);
  console.log(`Too old (>${config.maxAge}d):       ${skipped.age} skipped`);
  console.log(`New added to pipeline:  ${newJobs.length}`);
  console.log('');

  if (fresh.length > 0) {
    console.log('🔥 Fresh (0-1 days) — apply immediately:');
    fresh.forEach(j => console.log(`  + ${j.company} | ${j.title} | ${ageLabel(j.postedAt)}`));
    console.log('');
  }
  if (recent.length > 0) {
    console.log('✅ Recent (2-3 days) — apply today:');
    recent.forEach(j => console.log(`  + ${j.company} | ${j.title} | ${ageLabel(j.postedAt)}`));
    console.log('');
  }
  if (older.length > 0) {
    console.log('⚠️  Older (4-14 days):');
    older.forEach(j => console.log(`  + ${j.company} | ${j.title} | ${ageLabel(j.postedAt)}`));
    console.log('');
  }
  if (newJobs.length === 0) {
    console.log('No new matching jobs found.');
    console.log('→ Try refreshing cookies in config/jobright.yml if this seems wrong.');
  } else {
    console.log('→ Run /career-ops pipeline to evaluate and generate tailored CVs.');
  }

  if (DRY_RUN) console.log('\n[DRY RUN — nothing written]');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
