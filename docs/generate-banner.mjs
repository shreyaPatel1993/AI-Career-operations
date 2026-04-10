import { chromium } from 'playwright-extra';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 800px;
    height: 418px;
    background: #0d1117;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden;
    position: relative;
  }

  /* Circuit board background pattern */
  .bg {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at 70% 50%, #0d2d4a 0%, transparent 60%),
      radial-gradient(ellipse at 30% 80%, #0a1628 0%, transparent 50%);
  }

  /* SVG circuit lines */
  .circuits {
    position: absolute;
    inset: 0;
    opacity: 0.18;
  }

  .content {
    position: relative;
    z-index: 10;
    padding: 52px 56px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .title {
    font-size: 68px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: -1px;
    line-height: 1;
    margin-bottom: 14px;
  }

  .subtitle {
    font-size: 26px;
    font-weight: 700;
    color: #4da6ff;
    margin-bottom: 12px;
  }

  .tags {
    font-size: 16px;
    color: #8b9ab0;
    letter-spacing: 0.3px;
  }

  .handle {
    position: absolute;
    bottom: 36px;
    left: 56px;
    font-size: 18px;
    font-weight: 600;
    color: #4da6ff;
    z-index: 10;
  }

  /* Avatar circle top-right */
  .avatar-wrap {
    position: absolute;
    top: 36px;
    right: 52px;
    z-index: 10;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: linear-gradient(135deg, #4da6ff, #1a6fba);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 38px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -1px;
    box-shadow: 0 0 0 3px #4da6ff55, 0 0 24px #4da6ff44;
  }
</style>
</head>
<body>
  <div class="bg"></div>

  <!-- Circuit SVG lines -->
  <svg class="circuits" viewBox="0 0 800 418" xmlns="http://www.w3.org/2000/svg">
    <!-- Horizontal lines -->
    <line x1="400" y1="30" x2="800" y2="30" stroke="#4da6ff" stroke-width="1"/>
    <line x1="500" y1="80" x2="800" y2="80" stroke="#4da6ff" stroke-width="1"/>
    <line x1="460" y1="130" x2="800" y2="130" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="420" y1="180" x2="800" y2="180" stroke="#4da6ff" stroke-width="1"/>
    <line x1="450" y1="230" x2="800" y2="230" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="480" y1="280" x2="800" y2="280" stroke="#4da6ff" stroke-width="1"/>
    <line x1="440" y1="330" x2="800" y2="330" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="400" y1="380" x2="800" y2="380" stroke="#4da6ff" stroke-width="1"/>
    <!-- Vertical connectors -->
    <line x1="500" y1="30" x2="500" y2="80" stroke="#4da6ff" stroke-width="1"/>
    <line x1="600" y1="80" x2="600" y2="130" stroke="#4da6ff" stroke-width="1"/>
    <line x1="550" y1="130" x2="550" y2="180" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="650" y1="180" x2="650" y2="230" stroke="#4da6ff" stroke-width="1"/>
    <line x1="580" y1="230" x2="580" y2="280" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="700" y1="280" x2="700" y2="330" stroke="#4da6ff" stroke-width="1"/>
    <line x1="520" y1="330" x2="520" y2="380" stroke="#4da6ff" stroke-width="0.8"/>
    <!-- Dots at junctions -->
    <circle cx="500" cy="30" r="3" fill="#4da6ff"/>
    <circle cx="600" cy="80" r="3" fill="#4da6ff"/>
    <circle cx="550" cy="130" r="2.5" fill="#4da6ff"/>
    <circle cx="650" cy="180" r="3" fill="#4da6ff"/>
    <circle cx="580" cy="230" r="2.5" fill="#4da6ff"/>
    <circle cx="700" cy="280" r="3" fill="#4da6ff"/>
    <circle cx="520" cy="330" r="2.5" fill="#4da6ff"/>
    <circle cx="500" cy="80" r="3" fill="#4da6ff"/>
    <circle cx="600" cy="130" r="2.5" fill="#4da6ff"/>
    <circle cx="550" cy="180" r="3" fill="#4da6ff"/>
    <circle cx="650" cy="230" r="2.5" fill="#4da6ff"/>
    <circle cx="580" cy="280" r="3" fill="#4da6ff"/>
    <circle cx="700" cy="330" r="2.5" fill="#4da6ff"/>
    <circle cx="520" cy="380" r="3" fill="#4da6ff"/>
    <!-- Extra nodes right side -->
    <circle cx="760" cy="55" r="3" fill="#4da6ff"/>
    <circle cx="730" cy="105" r="2.5" fill="#4da6ff"/>
    <circle cx="780" cy="155" r="3" fill="#4da6ff"/>
    <circle cx="740" cy="205" r="2.5" fill="#4da6ff"/>
    <circle cx="770" cy="255" r="3" fill="#4da6ff"/>
    <circle cx="750" cy="305" r="2.5" fill="#4da6ff"/>
    <circle cx="760" cy="355" r="3" fill="#4da6ff"/>
    <line x1="760" y1="30" x2="760" y2="80" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="730" y1="80" x2="730" y2="130" stroke="#4da6ff" stroke-width="0.8"/>
    <line x1="780" y1="130" x2="780" y2="180" stroke="#4da6ff" stroke-width="0.8"/>
  </svg>

  <!-- Avatar initials -->
  <div class="avatar-wrap">SP</div>

  <div class="content">
    <div class="title">AI-Career-Ops</div>
    <div class="subtitle">Multi-Agent Job Search System</div>
    <div class="tags">Claude Code · Playwright · HITL · 10D Scoring · Auto-Apply</div>
  </div>

  <div class="handle">@shreyaPatel1993</div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 800, height: 418 });
await page.setContent(html, { waitUntil: 'networkidle' });
const buffer = await page.screenshot({ type: 'jpeg', quality: 92 });
await browser.close();

const outPath = join(__dirname, 'hero-banner.jpg');
writeFileSync(outPath, buffer);
console.log(`✅ Banner saved: ${outPath}`);
