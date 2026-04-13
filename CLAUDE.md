# Career-Ops

AI job search pipeline: scan portals → evaluate offers → tailor CV → track applications.

## Agent Rules

- **Do not make any changes until you have 95% confidence in what you need to build. Ask follow-up questions until you reach that confidence.**
- **Use subagents for any exploration or research. If a task needs 3+ files or multi-file analysis, spawn a subagent and return only summarized insights.**
- Score < 3.5/5 → recommend against applying. Quality over quantity.
- **NEVER verify offer status via WebSearch/WebFetch.** Use Playwright: `browser_navigate` → `browser_snapshot`. Footer/nav only = closed. Title + description + Apply = active. Exception: batch mode → use WebFetch, mark `**Verification:** unconfirmed (batch mode)`.

---

## Data Layers

**User layer (never auto-overwrite):** `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`, `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System layer (safe to update):** `modes/_shared.md`, all `modes/*.md`, `CLAUDE.md`, `*.mjs`, `templates/*`, `batch/*`

**Rule:** Archetypes, narrative, comp targets, deal-breakers → always write to `modes/_profile.md` or `config/profile.yml`. Never put user data in `modes/_shared.md`.

---

## File Map

### User Profile & Config
| File | Purpose |
|------|---------|
| `config/profile.yml` | Name, target roles, comp range, deal-breakers |
| `modes/_profile.md` | Archetypes, scoring weights, personal narrative |
| `portals.yml` | Job portal queries + company list for scanning |
| `config/jobright.yml` | Jobright.ai API auth + scan settings (gitignored) |

### Job Search
| File | Purpose |
|------|---------|
| `data/pipeline.md` | Inbox of pending URLs to evaluate |
| `data/scan-history.tsv` | Scanner dedup (prevents re-processing URLs) |
| `jobright-fetch.mjs` | Fetches jobs from Jobright API → pipeline.md |

### Evaluation & Scoring
| File | Purpose |
|------|---------|
| `modes/_shared.md` | Shared scoring logic injected into all eval modes |
| `modes/evaluate.md` | JD evaluation + A-F scoring |
| `modes/auto-pipeline.md` | Full pipeline: evaluate + report + PDF + tracker |

### CV & Application
| File | Purpose |
|------|---------|
| `cv.md` | Canonical CV — read this, never hardcode metrics |
| `article-digest.md` | Proof points / portfolio highlights (optional) |
| `templates/cv-template.html` | HTML CV template for PDF rendering |
| `generate-pdf.mjs` | Playwright: HTML → PDF |
| `modes/apply.md` | Live application assistant + form answers |
| `config/form-answers.yml` | Saved answers for common application fields |

### Tracking & Reports
| File | Purpose |
|------|---------|
| `data/applications.md` | Master application tracker |
| `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` | Per-offer evaluation reports |
| `interview-prep/{company}-{role}.md` | Interview intel per company |
| `interview-prep/story-bank.md` | STAR+R stories bank |

### Scripts
| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges TSV additions → applications.md |
| `verify-pipeline.mjs` | Pipeline health check |
| `normalize-statuses.mjs` | Fix canonical status values |
| `dedup-tracker.mjs` | Remove duplicate tracker rows |
| `analyze-patterns.mjs` | Rejection pattern analysis (JSON) |

---

## Skill Modes

| User intent | Mode |
|-------------|------|
| Paste JD or URL | `auto-pipeline` (evaluate + report + PDF + tracker) |
| Evaluate offer | `evaluate` |
| Compare offers | `compare` |
| Generate CV/PDF | `pdf` |
| Apply to job form | `apply` |
| Scan portals | `scan` |
| Process pipeline inbox | `pipeline` |
| LinkedIn outreach | `outreach` |
| Company research | `deep` |
| Interview prep | `interview-prep` |
| View tracker status | `tracker` |
| Analyze patterns | `patterns` |
| Batch process | `batch` |

---

## Pipeline Rules

- **NEVER add entries to `applications.md` directly** — write TSV to `batch/tracker-additions/{num}-{slug}.tsv`, run `node merge-tracker.mjs`.
- **Edit `applications.md`** only to update status/notes on existing rows.
- **Never duplicate** — if company+role exists, update the existing row.
- Reports must include `**URL:**` in header.
- After any batch: run `node merge-tracker.mjs`.

### TSV Format (`batch/tracker-additions/{num}-{slug}.tsv`)

Single line, 9 tab-separated columns (status BEFORE score):
```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

### Canonical Statuses (source: `templates/states.yml`)

`Evaluated` · `Applied` · `Responded` · `Interview` · `Offer` · `Rejected` · `Discarded` · `SKIP`

No bold, no dates, no extra text in status field.

---

## Onboarding (first run)

Check silently: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`. If any missing, guide user step by step before proceeding. If `modes/_profile.md` missing, copy from `modes/_profile.template.md` silently.

