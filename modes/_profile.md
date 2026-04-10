# User Profile Context — career-ops
# Shreya Patel | Senior Frontend Engineer

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.
     Your archetypes, framing, negotiation scripts, and scoring
     overrides live here. Customizations always win over _shared.md.
     ============================================================ -->

## CV / PDF Generation Rules (ALWAYS apply when generating PDFs)

These rules override the defaults in `modes/pdf.md`. Apply on every CV generation.

1. **Header — Name + Job Title + US Citizen:** Below the candidate's name, add the job title relevant to the posting (e.g. "Senior Frontend Engineer", "Full Stack Engineer", "UI Developer"). Match the title to the JD archetype. In the contact row, always write "United States | US Citizen" for the location field.

2. **Summary — keep it tight:** Do NOT include "Available immediately", "US Citizen — no sponsorship needed", or a portfolio URL in the summary text. Summary should be 3–4 lines of keyword-dense experience framing only.

3. **Section order:**
   1. Header (Name + Job Title)
   2. Professional Summary
   3. Core Competencies
   4. Skills
   5. Work Experience
   6. Education

4. **No Projects section** — remove entirely. Do not include a Projects block.

5. **ATS-first keyword strategy:**
   - Extract 15–20 exact keywords from the JD (tools, frameworks, methodologies, domain terms)
   - Distribute top 5 keywords in the Summary
   - Core Competencies tags must mirror JD language exactly (copy phrasing, not paraphrase)
   - Skills section entries should include every keyword from the JD that Shreya genuinely has
   - Experience bullets: rewrite/reorder to front-load JD keywords; use the JD's exact verb/noun phrasing where truthful
   - Every required skill in the JD must appear at least once in the document

---

## Your Target Roles

| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Senior Frontend Engineer** | React 18, TypeScript, performance, accessibility | Someone who ships production-grade UIs at scale |
| **Frontend Engineer** | Component systems, micro-frontends, design systems | Someone who defines standards and scales frontend orgs |
| **Full Stack Engineer** | React + Node.js, API integration, end-to-end ownership | Someone who can own features front to back |
| **UI Developer** | creates Responsive web designs, SPAs, component architure | Someone who creates resusable components |
| **Web Developer** | creating webpages, components, integrating APIs | Someone who creates webpages |

## Your Adaptive Framing

| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Senior Frontend / React | React 18 expertise, performance wins (LCP, FCP, 1.8s load reduction), accessibility | cv.md — Citi + J&J | Component standardization (25% duplication reduction), cross-team architecture, micro-frontends | cv.md — J&J |
| Full Stack | Node.js + Express at Citi, AWS deployments at AutoNation, API integration patterns | cv.md |
| AI-forward roles | Claude Code + Copilot practitioner, 30% delivery acceleration, real practitioner not just buzzword | cv.md — J&J |
| Healthcare | J&J vaccination platform, WCAG accessibility, 10K+ daily users | cv.md — J&J |
| Fintech | Citi Banking Dashboard, 20M+ users, 99% CI/CD success, security-aware API patterns | cv.md — Citi |
| EM / Tech Lead | Led team of 5 at J&J, cross-functional mentoring at Citi, code review culture | cv.md |

## Your Cross-cutting Advantage

Frame Shreya as: **"High-scale React engineer with real AI-assisted workflow experience"**
- Not just AI buzzwords — actual practitioner with Claude Code and GitHub Copilot, measurable results
- Proven at both startup scale (small teams) and enterprise scale (20M+ users)
- US Citizen, no sponsorship needed — zero hiring risk for employers

## Your Exit Narrative

Use this framing in summaries, cover notes, and STAR stories:
> "I've spent 7 years building frontend systems that scale — from a vaccination platform serving healthcare workers to a banking dashboard for 20 million users. I've led teams, set architectural standards, and recently leaned into AI-assisted development with Claude Code and GitHub Copilot to ship 30% faster. I'm now looking for a role where I can bring that combination — strong engineering fundamentals, team leadership, and AI-accelerated delivery — to a product that matters."

## Your Comp Targets

- **Target:** $140K–$180K base (USD)
- **Minimum:** $120K
- **Remote:** Preferred; open to hybrid or Onsite
- **No visa sponsorship needed** — always mention this as a positive

**Salary script:**
> "Based on current market rates for senior frontend roles, I'm targeting $140K–$180K depending on scope and total comp structure. I'm a US citizen so no sponsorship is needed."

**When offered below target:**
> "I'm currently evaluating roles in the $140K+ range. Given my experience leading teams and the scale I've worked at — 20M+ users at Citi — I'd like to explore if there's flexibility to get closer to that range."

## Your Location Policy

- Location does NOT affect scoring
- On-site, hybrid, remote — all treated equally in evaluations
- Just note the location in the report header for Shreya's awareness, but don't score it

## Scoring Weights for Evaluations

Scoring is based ONLY on skill, experience, and tech stack fit. Location and remote policy do NOT affect the score.

| Dimension | Weight | Notes |
|-----------|--------|-------|
| Tech stack fit (React/TS) | High | Primary signal — must have React or TypeScript |
| Years of experience match | High | 7+ years, senior-level responsibilities |
| Skill overlap | High | Count of matching skills from JD vs CV |
| Domain relevance | Medium | Healthcare, Fintech, AI products = bonus |
| Comp alignment | Medium | Below $110K = flag, not auto-skip |

**Auto-SKIP signals (stack only):**
- Primary stack is Java, .NET, PHP, Ruby, Python-only — no frontend at all
- No React/TypeScript anywhere in the JD
- Role is Staff, Principal, Head of, Director, or VP level

**Do NOT skip or penalize based on:**
- On-site, hybrid, or remote policy — ignore location entirely
- Company size or brand name
- Industry (unless stack is completely irrelevant)

## Job Source — Jobright API (PRIMARY)

Shreya has a Jobright.ai premium membership with curated recommendations. **This is the primary job source — use it instead of generic WebSearch queries.**

When running `/career-ops scan`:
1. **First:** Run `node jobright-fetch.mjs` (or call it via `npm run jobright`) — this fetches personalized recommendations from the Jobright API, applies title filtering, deduplication, and writes directly to `data/pipeline.md`
2. **Then:** Optionally supplement with Greenhouse API calls for specific high-priority companies (Vercel, Figma, Stripe, etc.) that may not appear in Jobright recommendations
3. **Skip:** Generic WebSearch queries (portals.yml search_queries) — Jobright API replaces these entirely

**Cookie refresh:** If `node jobright-fetch.mjs` returns a 401/403 error, cookies have expired. Instruct the user to:
1. Log into jobright.ai in Chrome
2. Open DevTools (F12) → Network tab → filter by `/swan/`
3. Click any request → Headers → copy the full `cookie:` value
4. Paste into `config/jobright.yml` under `auth.cookie:`

## Recency — Apply Early Strategy

Applying in the first 1-3 days of a posting dramatically increases resume visibility (ATS queues are chronological). Follow these rules on every scan:

1. **Extract post date** from every listing — check the job page, ATS metadata, or URL timestamps
2. **Sort pipeline.md newest-first** — freshest jobs go to the top so they get evaluated and applied to first
3. **Label each entry by age:**
   - 🔥 `[today]` or `[1d ago]` — apply immediately, top priority
   - ✅ `[2-3d ago]` — apply same day
   - ⚠️ `[4-7d ago]` — still worth applying, flag it
   - ❌ `[8-14d ago]` — deprioritize, apply only if strong fit
   - 🚫 `[15d+]` — skip entirely, queue likely full
4. **In search queries**, `{date_14d}` and `{date_7d}` are replaced with the actual date (today minus 14 or 7 days) at scan time — e.g. `after:2026-03-26`
5. For **Playwright/API scans** (Level 1 & 2), read the `posted_at` or `updated_at` field if available in the ATS response; otherwise check the job page for a posted date

## Employment Type

- **Preferred:** Full-time employee (FTE)
- **Acceptable:** W2 contract
- **Goal:** Maximize interview volume — apply broadly to all fitting archetypes, don't over-filter
- When evaluating, do NOT penalize W2 contract roles — treat them as viable opportunities
- For W2 contract roles, note the hourly/daily rate equivalent if listed

## Deal-breakers

- Non-frontend primary stack (Java/backend only roles)
- Compensation below $110K base (or equivalent annualized for contracts)
