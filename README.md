# BNB IT Asset Management Assistant

> AI-powered IT management chatbot for Bennet & Bernard — reads live data from Google Sheets, handles tickets, tracks assets and software renewals across 15 Goa sites.

**Live URL:** `https://project-qvmtc.vercel.app`

---

## Table of Contents

- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Google Sheet Structure](#google-sheet-structure)
- [User Roles](#user-roles)
- [Features by Role](#features-by-role)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [API Endpoints](#api-endpoints)
- [Tech Stack](#tech-stack)
- [Local Development](#local-development)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (index.html)                  │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  IT View     │  │  Mgr View    │  │  Login       │  │
│  │  - Dashboard │  │  - KPI tiles │  │  - Pin auth  │  │
│  │  - Full CRUD │  │  - 7 panels  │  │  - FNV hash  │  │
│  │  - Add asset │  │  - KB docs   │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Chat Engine (processMessage)           │    │
│  │   fastRoute (41+ keyword patterns, ~80% hits)   │    │
│  │   → Claude Haiku (primary AI)                   │    │
│  │   → NIM Llama 8B (fallback)                     │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────┬───────────────────────────────────────┘
                  │ fetch /api/*
         ┌────────▼────────────────────────────┐
         │      Vercel Serverless Functions     │
         │                                     │
         │  /api/sheets-proxy   (SA + API key) │
         │  /api/claude-proxy   (Anthropic)    │
         │  /api/nim-proxy      (NVIDIA)       │
         │  /api/diag           (health check) │
         └────────┬────────────┬───────────────┘
                  │            │
    ┌─────────────▼──┐   ┌─────▼──────────────┐
    │  Google Sheets  │   │  Anthropic / NVIDIA │
    │  (SA OAuth2)    │   │  AI APIs            │
    │  11 tabs        │   │  claude-haiku-3-5   │
    └─────────────────┘   └─────────────────────┘
```

### Data flow for a query

```
User types "Show Dell devices"
    │
    ▼
fastRoute() — keyword match in <1ms
    │ match: has(['dell','hp','lenovo',...])
    ▼
tryFetch('IT Asset Inventory')
    │
    ├─► /api/sheets-proxy?sheet=IT+Asset+Inventory
    │       │
    │       ├─ Try SA OAuth2 token (JWT/RS256) ──► Google Sheets API
    │       └─ Fallback: hardcoded read-only API key (server-side, no CORS)
    │
    ▼
renderCards(rows) — filter by brand, format as HTML cards
    │
    ▼
botMsg() — displayed in chat with timestamp + suggestions
```

### Cache layer

```
_sheetCache = {}          // in-memory, per tab name
CACHE_TTL   = 30,000ms   // 30 second TTL

tryFetch(name)
  └── hit? return cached
  └── miss? fetch → cache → return
  └── write ops always invalidate relevant tab
```

---

## Project Structure

```
vercel_v3/
├── index.html              # Entire frontend (single file, ~173KB)
│   ├── <style>             # ~22KB CSS — theming, all panel styles
│   ├── HTML body           # Login overlay, header, toolbar, chat, 7 panels
│   └── <script>            # ~124KB JS — 102 functions, 2366 lines
│
├── api/
│   ├── sheets-proxy.js     # Google Sheets read/write (SA + API key fallback)
│   ├── claude-proxy.js     # Anthropic API proxy (keeps key server-side)
│   ├── nim-proxy.js        # NVIDIA NIM proxy (Llama 8B fallback)
│   └── diag.js             # Diagnostic endpoint — tests all connections
│
├── vercel.json             # {"outputDirectory": "."} — required for SPA
└── README.md               # This file
```

### Why single file?

The app is a zero-build, zero-dependency frontend. No webpack, no npm, no bundler. This means:
- Any developer can open `index.html` and understand everything
- Deployment is a single file upload to GitHub
- No CI pipeline needed — push to main → Vercel deploys in ~10s

---

## How It Works

### 1. Authentication

```javascript
// PIN login — FNV-1a hash, no plain text stored anywhere
var USERS = {
  deeptesh: { role:'it',      pin_hash: hashPin('deeptesh') },
  rajat:    { role:'it',      pin_hash: hashPin('rajat')    },
  it1234:   { role:'it',      pin_hash: hashPin('it1234')   },
  fabiola:  { role:'manager', pin_hash: hashPin('fabiola')  },
  varun:    { role:'manager', pin_hash: hashPin('varun')    }
};
// PIN = username by default. Change via hashPin() with new value.
// 5 wrong attempts → 60s lockout
```

### 2. Permission system

```javascript
var PERMISSIONS = {
  it:      { canRead:true, canWrite:true,  canAddAsset:true,  canUpdateStatus:true  },
  manager: { canRead:true, canWrite:false, canAddAsset:false, canUpdateStatus:false }
};

can('canWrite')  // → true for IT, false for managers
```

### 3. AI routing (fastRoute → Claude)

```javascript
// fastRoute handles ~80% of queries locally with zero AI calls
fastRoute('show dell devices')
  → { intent:'search', sheet:'IT Asset Inventory', filters:{Brand:'Dell'} }

// AI is only called for ambiguous/complex queries
fastRoute('why is tudor cctv still down')
  → { intent:'it_request' }  // manager question → creates ticket + AI answers
```

### 4. Ticket creation flow

Every manager message automatically creates a tracked ticket:

```
Manager sends message
    │
    ├── fastRoute detects intent
    │
    ├── it_request handler:
    │       ticketId = 'MNT-REQ-' + Date.now().slice(-6)
    │       appendRow('Maintenance Log', [...row...])
    │       auditLog('IT_REQUEST', ...)
    │       invalidate cache
    │
    ▼
IT dashboard shows new ticket (polls every 2 min)
IT replies → logged back to sheet
Manager sees status in My Queries panel
```

### 5. Service Account auth (sheets-proxy)

```javascript
// cleanPem() strips surrounding quotes + fixes \\n → real newlines
// (Vercel stores env vars with literal \n by default)
function cleanPem(raw) {
  let key = raw.trim();
  key = key.replace(/^"+|"+$/g, '');  // strip surrounding quotes
  key = key.replace(/\\n/g, '\n');     // fix escaped newlines
  return key;
}

// JWT → OAuth2 token → Google Sheets API
// Falls back to read-only API key if SA fails
```

---

## Google Sheet Structure

**Sheet ID:** `1n1TnyQleh14cGKTbtiOA5hDFEnwcF7JB3t47CUZs_aM`

| Tab | Purpose | Key columns |
|-----|---------|-------------|
| `IT Asset Inventory` | All BNB devices | Asset_ID, Brand, Model, Site, Status, Assigned_To |
| `Spare Inventory` | Unassigned spare devices | Item, Quantity, Location |
| `Maintenance Log` | Monthly site visits + tickets | Entry_ID, Month, Site, Overall_Status, Issues_Troubleshooting |
| `Antivirus Tracker` | AV license status | Site, Software, Next_Due, Status |
| `Network Devices` | Switches, routers, DVR/NVR | Site, Type, Model, IP, Status |
| `Accessories` | Peripherals, pendrives | Item, Quantity, Site |
| `Purchase Register` | Hardware purchases | Item_Name, Cost, Purchase_Date, Vendor |
| `Device Repairs` | Repair history | Device, Issue, Status, Cost |
| `Software Subscriptions` | All 12 SaaS licenses | SW_ID, Software_Name, Vendor, Expiry_Date, Cost |
| `Digital Assets` | Digital/media equipment | Item, Assigned_To |
| `Audit Log` | All write operations | Action, User, Timestamp, Details |

### Maintenance Log — ticket row format

Management query tickets are appended with this structure:

```
Entry_ID         : MNT-REQ-123456
Month            : March 2026
Year             : 2026
Site_Category    : Management Query
Site             : Tudor House (or 'All Sites')
[cols 6–14]      : — (dash placeholders)
Issues_Troubl.   : [QUERY] Fabiola Maam [High] [CCTV]: CCTV not working
Overall_Status   : Pending IT Response
Technician       : Fabiola Maam
Notes            : Raised on 31/03/2026 at 14:23 via IT Assistant chatbot
```

---

## User Roles

| User | Code | Role | Access |
|------|------|------|--------|
| Deeptesh | `deeptesh` | IT | Full read/write, add assets, update status, reply tickets |
| Rajat | `rajat` | IT | Full read/write, add assets, update status, reply tickets |
| IT Team | `it1234` | IT | Shared IT account — full access |
| Fabiola Maam | `fabiola` | Manager | Read all data, raise tickets, view KB and panels |
| Varun Sir | `varun` | Manager | Read all data, raise tickets, view KB and panels |

> PIN = login code by default. To change a PIN, update `hashPin('newpin')` in the USERS object.

---

## Features by Role

### IT Team

| Feature | Description |
|---------|-------------|
| Chat queries | Search any sheet, count assets, compare months |
| Add asset | Quick form — brand, model, site, serial, status |
| Log maintenance | Form — site, month, all device statuses, issues |
| Dashboard | Pending management queries with Reply + Mark Resolved |
| Alerts bar | AV expiring, faulty devices, pending query count |
| Audit log | All writes tracked — ADD_ASSET, ADD_MAINTENANCE, REPLY_QUERY, etc |
| Auto-poll | New management tickets appear automatically every 2 minutes |

### Management (Varun Sir, Fabiola Maam)

| Feature | Description |
|---------|-------------|
| Home screen | Live KPI tiles — open tickets, faulty devices, AV expiry, assets, licenses, my queries |
| Manager toolbar | My Queries · Site Health · Renewals · Raise Ticket · Full Report · IT Spend |
| My Queries panel | All past tickets with status (Pending / In Progress / Resolved) |
| Site Health panel | All 15 sites searchable — open issues, last visit, expand for detail |
| Renewal Calendar | 12 subscriptions sorted by urgency — red <60d, orange <90d |
| Structured Ticket | Guided form — site, category, priority, description |
| Knowledge Base | 5 categories: IT Policies, Sites, Vendors, Software, Team info |
| IT Spend charts | Doughnut by category + horizontal bar per subscription + purchase history |
| Weekly digest | Banner on login (Mondays / 7+ days) — open tickets, AV, renewals, my queries |
| Voice input | Hold mic button to speak query (Web Speech API, en-IN) |

---

## Environment Variables

Set these in **Vercel → Project Settings → Environment Variables**:

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_SA_PRIVATE_KEY` | Yes (writes) | Service account private key — paste raw, Vercel stores with literal `\n` which proxy handles automatically |
| `ANTHROPIC_API_KEY` | Yes | Claude Haiku API key from console.anthropic.com |
| `NIM_API_KEY` | Optional | NVIDIA NIM key from build.nvidia.com — fallback if Claude fails |
| `GOOGLE_API_KEY` | Optional | Read-only Sheets API key — proxy uses hardcoded fallback if not set |

### SA key troubleshooting

The service account key often gets mangled when pasted into env var UIs. The proxy handles this automatically via `cleanPem()`:

```
Raw SA key in Vercel:    "-----BEGIN PRIVATE KEY-----\nMIIEv..."
After cleanPem():         -----BEGIN PRIVATE KEY-----
                          MIIEv...
                          -----END PRIVATE KEY-----
```

If sheets still fail, visit `/api/diag` to see exactly which step is failing.

---

## Deployment

### First deploy

1. Fork or push to a GitHub repo
2. Go to **vercel.com** → Add New Project → Import Git Repository
3. Select your repo → click **Deploy** (no build settings needed)
4. Go to **Project Settings → Environment Variables** → add the keys above
5. Go to **Deployments** → click **Redeploy**

### Subsequent updates

Just push `index.html` to GitHub main branch — Vercel auto-deploys in ~10 seconds.

```bash
git add index.html
git commit -m "update: description of change"
git push origin main
```

### Diagnostic endpoint

```
https://your-project.vercel.app/api/diag
```

Returns JSON showing:
```json
{
  "env": {
    "sa_key_set": true,
    "sa_key_len": 1731,
    "anthropic": true
  },
  "api_key_test": { "ok": true, "rows": 171 },
  "sa_parse_test": { "ok": true, "bytes": 1218 },
  "sa_token_test": { "ok": true }
}
```

---

## API Endpoints

### `GET /api/sheets-proxy?sheet=<name>`

Reads a Google Sheet tab. Tries SA auth first, falls back to API key.

**Response:**
```json
{ "range": "IT Asset Inventory!A1:Z171", "values": [["Asset_ID", "Brand", ...], [...]] }
```

### `POST /api/sheets-proxy`

Writes to a sheet. Requires SA auth (API key is read-only).

**Append row:**
```json
{ "action": "append", "sheet": "Maintenance Log", "row": ["MNT-001", "March 2026", ...] }
```

**Update range:**
```json
{ "action": "update", "range": "Maintenance Log!R5:R5", "values": [["Resolved"]] }
```

### `POST /api/claude-proxy`

Proxies Anthropic API calls. Accepts standard Anthropic request body, returns standard response.

### `POST /api/nim-proxy`

Proxies NVIDIA NIM API calls. Used as Claude fallback with Llama 8B.

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Vanilla HTML/CSS/JS | Zero build step, single file, instant deploy |
| Hosting | Vercel (Hobby free tier) | 100GB/month bandwidth, serverless functions, auto-deploy from GitHub |
| AI Primary | Claude Haiku (claude-haiku-3-5) | Fast, cheap, smart enough for asset queries |
| AI Fallback | NVIDIA NIM Llama 3.1 8B | Free fallback if Anthropic fails |
| Data store | Google Sheets | Existing BNB data, easy for team to edit directly |
| Auth to Sheets | Service Account (JWT/RS256) | Server-side only, no key exposure |
| Charts | Chart.js 4.4.1 | Loaded lazily only when spend panel opens |
| No framework | — | React/Vue adds build complexity with no real benefit here |
| No database | — | Google Sheets IS the database — team edits it directly |

---

## Local Development

Since it's a single HTML file, there's no build step:

```bash
# Option 1: Python server
python3 -m http.server 8080
# Visit: http://localhost:8080

# Option 2: VS Code Live Server extension
# Right-click index.html → Open with Live Server

# Option 3: Direct file open (limited — fetch calls won't work)
open index.html
```

For API calls to work locally, you need to run Vercel dev:

```bash
npm i -g vercel
vercel dev
# Reads .env.local for environment variables
# Visit: http://localhost:3000
```

Create `.env.local`:
```
GOOGLE_SA_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEv...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Migration History

| Platform | Status | Reason |
|----------|--------|--------|
| Netlify | Paused | Hit free tier bandwidth limit (100GB/month) |
| Vercel | ✅ Active | Same free tier limits but slower burn rate for this use case |

Key difference from Netlify:
- Functions go in `/api/` not `/netlify/functions/`
- Use `module.exports = async function(req, res)` not `exports.handler`
- `vercel.json` needs `{"outputDirectory": "."}` for SPA serving

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Could not read IT Asset Inventory" | SA key not deployed or malformed | Check `/api/diag`, verify env var |
| Toolbar buttons not responding | `onclick` attribute quote conflict | Already fixed in latest version |
| Tickets not appearing in IT dashboard | Cache not invalidated | Fixed — cache cleared after every write |
| AI not responding | Anthropic key missing or rate limited | Check env vars, NIM fallback should kick in |
| Weekly digest not showing | Not Monday and <7 days since last | Clear `bnb_digest_*` from localStorage |
| Voice button missing | Browser doesn't support Web Speech API | Only works in Chrome/Edge |

---

## SA Email (for Google Sheet sharing)

```
bnb-it-sheets@blissful-racer-490505-d2.iam.gserviceaccount.com
```

Share the Google Sheet with this email as **Editor** for write access, or **Viewer** for read-only fallback.
