# PROJECT_CONTEXT: troop-api

This file is a project memory file for AI-assisted work. It exists to carry forward the user’s intent, goals, decisions, trade-offs, and historical context across development sessions, ensuring that any AI working on this codebase understands the full trajectory and doesn't introduce architectural or functional regressions.

---

## 1. Project Purpose & Original Intent
The project was born out of a practical operational need: Troop 402 needed a lightweight backend service to automate access to TroopWebHost (TWH) roster and membership data without manual spreadsheet downloads and without incurring recurring infrastructure costs.

The core vision established during early brainstorming:
- **Zero-Cost Operation:** Run indefinitely on free-tier hosting (Render web service) without subscription fees.
- **No Heavy Browser Automation:** Avoid resource-heavy headless browser frameworks (Playwright, Puppeteer, Chromium) or Docker containers. Maintain a tiny footprint (<50 MB RAM) to comfortably survive Render's 512 MB ceiling and 0.1 vCPU limits.
- **TroopWebHost as System of Record:** Read data from TWH directly rather than replacing it.
- **In-Memory Cache First:** Use a 12-hour in-memory TTL cache with request coalescing/de-duplication to prevent duplicate logins and external load. Permanent serverless database solutions (e.g. Neon.tech PostgreSQL) are deferred until historical persistence or relational querying is genuinely needed.
- **Developer Workflow:** Developed in VS Code (GitHub Codespaces) with AI pair programming, version-controlled via GitHub (`main` branch), protected by CI, and auto-deployed to Render.
- **Alpha Framing:** The project is in early development (`0.1.0-alpha`). Breaking changes to internal routes or contracts are acceptable when intentional and documented.

---

## 2. Evolution of the Architecture Through Development

### 2.1 The Direct HTTP Breakthrough
Initially, browser automation seemed required because TroopWebHost is a legacy ASP.NET WebForms application dependent on hidden form state (`__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`) and session cookies (`ASP.NET_SessionId`, `.ASPXAUTH`).

However, inspection of the "Export Roster to Excel" link revealed it was a client-side wrapper:
```html
<a href="javascript:LinkTo('FormReport.aspx?Menu_Item_ID=45897&amp;Stack=1&amp;ReportFormat=XLS','');">Export Roster to Excel</a>
```
This is an ordinary HTTP `GET` request, not an asynchronous AJAX `__doPostBack`. This made pure HTTP scraping viable using lightweight Node.js libraries (`got-scraping`, `cheerio`, `tough-cookie`).

### 2.2 Root URL Redirection & Frameset Traversal
The service was updated to accept the troop's base URL (e.g., `https://www.troopwebhost.org/Troop402lafayette`). TroopWebHost does not serve the login form directly at `Index.htm`; it loads a frameset and redirects to `FormLandingPage.aspx`. The scraper was built to follow redirects, parse the landing page, extract ASP.NET hidden fields, submit credentials, and maintain the authenticated cookie jar.

### 2.3 The CSV Format Discovery & Fallback Strategy
When live-testing against real credentials in PR #2, inspecting the raw bytes returned by `ReportFormat=XLS` revealed a surprise:
* TroopWebHost returned a **UTF-8 CSV payload with a Byte Order Mark (BOM)**, not a binary `.xls` or `.xlsx` workbook.
* Testing `ReportFormat=CSV` returned the exact same clean CSV export (~204 KB).
* Testing `ReportFormat=XLSX` resulted in an HTTP 500 server error from TroopWebHost.

**Decision**: The service requests `ReportFormat=CSV` first. If that request fails or returns unusable data (empty, non-200, or HTML login bounce), it retries once with `ReportFormat=XLS`. Regardless of which upstream format succeeded, the service normalizes the response to `text/csv` and delivers `troop_roster.csv`.

### 2.4 Server-Managed Credentials
The initial prototype accepted credentials in the request body from the frontend. This was quickly deprecated for security:
* Production credentials live in server environment variables: `TWH_TROOP_URL`, `TWH_USERNAME`, `TWH_PASSWORD`.
* The browser UI (`public/index.html`) simply triggers the export without handling sensitive credentials.
* Secret environments are segregated: Codespaces secrets (local development/testing), GitHub Actions repository secrets (CI validation), and Render environment variables (production).

---

## 3. CI, Testing & Deployment Architecture

### 3.1 Two-Tiered Test Suite
To prevent AI regressions while keeping CI fast and independent:
1. **Deterministic Smoke Tests (`tests/smoke.test.js`):**
   - Runs completely offline against an in-process ephemeral Express server.
   - Verifies `GET /healthz` returns `200 OK`.
   - Verifies that missing server credentials return an immediate `500` JSON error without attempting external network calls.
2. **Live Integration Tests (`tests/twh-integration.test.js`):**
   - Conditioned on the presence of `TWH_USERNAME` and `TWH_PASSWORD`.
   - Tests are decoupled:
     - Test 1 verifies authentication and confirms the resulting page displays "Log Off".
     - Test 2 executes the full export flow via the running API server and validates CSV content.
   - Generates JUnit XML test results and visual GitHub Actions summaries via `dorny/test-reporter`.

### 3.2 Deployment Pipeline (Render + GitHub Actions)
* Changes are developed on feature branches and merged via Pull Requests.
* GitHub Actions (`.github/workflows/validate.yml`) runs on PRs and on pushes to `main`.
* A GitHub branch ruleset protects `main`, requiring the `validate` check to pass before merging.
* Render is configured with **Auto-Deploy: After CI Checks Pass**. It deploys only after GitHub Actions succeeds.
* Render pings `GET /healthz` to confirm the new container booted before routing live traffic.

---

## 4. Documentation & Contract System

To prevent architectural drift and regressions across sessions, the repository maintains a strict documentation hierarchy:

* **`PROJECT_CONTEXT.md` (this file):** The historical memory of decisions, discoveries, architecture, and trade-offs.
* **`PROJECT_CONTRACT.md`:** The plain-language, numbered contract specifying active behavioral promises and endpoint requirements.
* **`openapi/openapi.yaml`:** Machine-readable API contract (OpenAPI 3.0), validated during CI via Redocly.
* **`README.md`:** Minimal, public-facing project description. (Hands-off for AI unless explicitly instructed).
* **Version Control Policy:** The project is at `0.1.0-alpha` (matching `package.json` and `openapi.yaml`). The repository owner handles all version numbering to align with GitHub releases and milestones. AI assistants must **never** auto increment version numbers anywhere witrhout being asked to do so.

---

## 5. Current State & Roadmap

### Current Status: `0.1.0-alpha`
* **UI Architecture Split**:
  - `public/index.html`: Clean, minimal, neutral public status landing page with zero sensitive scout/roster data exposed.
  - `public/manager.html`: Internal manager console with roster sync stats, raw CSV export downloads, and event carpool launcher with Carpool Candidates filtering.
  - `public/carpool.html?id=:id`: Dedicated shareable event carpool and departure clipboard page. Clean URL `/carpool/:id` automatically redirects.
  - `public/coordinator.html?id=:id`: Dedicated interactive Coordinator Worksheet replicating the traditional Lake Berryessa 1-9 scout slot grid with live in-browser reassignment and real-time capacity meters. Clean URL `/coordinator/:id` automatically redirects.
  - `GET /api/events/:id/carpool.xlsx`: One-click pre-populated Excel spreadsheet generator replicating the Lake Berryessa coordinator workbook layout with locked, pristine formulas.
* **Driver Safety & Youth Protection Compliance**:
  - Drivers cross-referenced with the Attending Adults section to inspect `sytStatus` (SYT/YPT Youth Protection), `stateTraining` (California AB 506 mandated reporter training), and `bsaRegistered`.
  - Visual status badges and warning highlights on drivers whose training is not 'Current'.
  - Top-level alert banner if any registered driver is non-compliant (`nonCompliantDriversCount`).
* **Driver Comment Intelligence & Name Collision Detection (`parseDriverComments`)**:
  - Layered name resolution:
    1. Full-name matches (e.g. "Maddie Curran", "Allison Annis") &rarr; `status: 'confirmed'`.
    2. Family surname matches (e.g. driver Amanda Renno matching Mackenzie Renno) &rarr; `status: 'family_match'`.
    3. Unique first-name matches (e.g. "Gwyneth", "Alina") &rarr; `status: 'unique_first'`.
    4. Ambiguous first-name collisions (e.g. driver noting "Anya" or "Mila" when multiple attending scouts share that first name) &rarr; prevents blind assignment, flags the collision in `clarificationsNeeded`, generates an alert for leaders to clarify with the driver, and marks affected scouts as `rideStatus: 'ambiguous'`.
  - Itemizes claimed scouts and adult passengers per car.
  - Detects explicit open seat notes (e.g. `"and 2 more"`, `"space for 3"`).
  - Calculates remaining open seats per vehicle.
  - Maps each scout to their assigned driver (`🚗 Riding with...` vs `⚠️ Needs Ride` vs `⚠️ Mentioned in Note (Clarification Needed)`).
* **Scout-Centric Ride Capacity**:
  - Seat balance calculated strictly against attending scouts and adult ride-alongs: `totalSeatsOffered - (totalScouts + adultRidersCount)`.
  - Non-driver adults assumed to drive themselves unless listed in a driver note.
* **Event Lifecycle & Smart Filtering**:
  - Events retained in calendar view while in progress and until at least 24 hours after their end date for return trip carpooling.
  - `isCarpoolCandidate` boolean flags offsite trips and excludes routine `Location: CABIN` meetings and informational placeholders.
* **Hosting & Environment**:
  - Target Troop: `https://www.troopwebhost.org/Troop402lafayette/` (Troop 402 Lafayette, CA).
  - Render URL Behavior: Render default `*.onrender.com` subdomains are permanently allocated at web service creation time and do not change when the service display name is edited. Render deployment active at `https://troop402-api.onrender.com`.
  - Production secrets configured in Render environment.
  - Smoke tests and live TWH integration tests passing.


---

## 6. Long-Term Architecture & Strategic Roadmap

### Phase 4: Free Database Backing & Asynchronous Sync
To enable the application to behave like a fast, responsive website without user-facing Render cold starts:
1. **Free-Tier Database**: Introduce a zero-cost managed database (e.g. Supabase, Turso SQLite, or Neon PostgreSQL) for persistent storage of rosters, events, and carpool logs.
2. **Asynchronous Background Ingestion**: 
   - Public frontend / user queries read directly from the database or lightweight edge functions with instantaneous sub-second response times and zero cold starts.
   - The Render Node.js instance functions as an on-demand scraper/worker: it only needs to spin up when an explicit refresh or scheduled sync runs in the background to ingest updated tables from TroopWebHost into the database.
3. **Data History & Analytics**: Store historical attendance and driver metrics across past events to better plan carpool needs and monitor scout participation over time.

### Phase 5: Architectural Decoupling (Frontend Extraction)
* **Current Monorepo Strategy (Phases 1–3)**: Kept `public/index.html` in the same repository as Express and `server.js` to maximize "vibe coding" iteration speed with AI assistants. This allows full-stack changes, live Codespace testing with secrets, OpenAPI spec validation, and PR creation in single conversational turns.
* **Planned Frontend Extraction (Phase 5)**: 
  - Once the data schema and database backing stabilize, extract the user-facing web interface into its own repository (e.g. hosted on GitHub Pages or Vercel).
  - The OpenAPI contract (`openapi/openapi.yaml`) and database schema will serve as the decoupled boundary between the frontend UI repo and the backend TWH ingestion engine.
  - AI tooling will assist in smoothly migrating the frontend into a standalone application without disrupting the core API.

---

## 7. Driver Communication & Automated Messaging Strategy (Exploratory)

Because carpool drivers manage their own vehicle notes on TroopWebHost, situations frequently arise where leadership needs to contact them:
1. **Clarification on Ambiguous Notes**: A driver lists a first name shared by multiple attending scouts (e.g. "Anya" or "Mila") and needs to be prompted for the scout's surname.
2. **Driver Safety & Youth Protection Gaps**: A registered driver has missing or incomplete CA State AB 506 training or expired Youth Protection (SYT) records.
3. **Trip Departure & Logistics Updates**: Broadcast departure times, parking instructions, or open seat changes to all drivers as the trip approaches.

### 7.1 The Telecom & Carrier Landscape (Why Free SMS is Hard)
* **The Death of Email-to-SMS Gateways**: TroopWebHost historically used free email-to-SMS relays (`number@vtext.com`, `number@txt.att.net`). As documented by [TWH (Help ID 562)](https://www.troopwebhost.org/help.aspx?ID=562), carriers have largely discontinued or heavily throttled these gateways due to spam abuse. Delivery rates are now unacceptably poor.
* **A2P 10DLC Regulations**: Major US mobile carriers (AT&T, Verizon, T-Mobile) now mandate that **any** cloud/software application sending automated SMS must register via The Campaign Registry (TCR). This requires business entity vetting (EIN/tax ID), one-time registration fees ($15–$50), and recurring monthly campaign fees ($1.50–$10/month), plus per-message carrier surcharges. Unregistered 10-digit cloud SMS is blocked outright by carriers.

### 7.2 Evaluated Tools & Architectural Options

| Approach / Tool | Type | Monthly Cost | Automated by Server? | 1:1 Targeted? | Carrier 10DLC Req? | Notes & Trade-offs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Native `sms:` Deep-Links** | Mobile URI | $0 | No (1-tap coordinator action) | Yes | No | Generates prefilled text on leader's phone. 100% delivery via peer-to-peer cellular plan. Drivers reply directly to leader. |
| **Group SMS Launcher** | Mobile URI | $0 | No (1-tap coordinator action) | No (Group) | No | Launches comma-separated group SMS with all driver cell numbers for departure day coordination. |
| **Resend / SendGrid** | Transactional Email | $0 (Free tier 3k/mo) | Yes (100% hands-off) | Yes | No | Backend automatically dispatches emails using driver email already scraped from TWH roster. Zero parent enrollment required. |
| **Twilio Toll-Free SMS** | Cloud SMS | ~$2–$3 / mo | Yes (100% hands-off) | Yes | No (Bypasses 10DLC) | Toll-free numbers (800/888) bypass 10DLC via a free verification form. $2.15/mo number rental + $0.0079/msg. Very cheap, but not zero-cost. |
| **GroupMe Bots API** | Group Messaging | $0 | Yes (via HTTP POST) | No (Group only) | No | Free public Bot API. Parents can receive messages as real SMS. Catch: Bots can only post into the group, not send private 1:1 DMs. |
| **Remind.com** | EdTech Messaging | Closed / N/A | No | Yes | N/A | Evaluated but ruled out: Remind has no public, self-serve developer REST API. Its Share SDK is restricted to invite-only enterprise partners. |
| **Self-Hosted Android Relay** | Android HTTP Gateway | $0 (using existing phone plan) | Yes | Yes | No | Runs an open-source SMS gateway app (e.g. `android-sms-gateway`) on a spare Android phone connected to Wi-Fi. Free and automated, but introduces hardware maintenance. |

### 7.3 Candidate Workflow Models

* **Model A: "One-Tap Coordinator Cockpit" (Low Tech, Highest Reliability)**:
  - Add contextual `📱 Text Driver to Clarify` buttons directly in the Amber Alert box and Drivers table in `carpool.html`.
  - Clicking pre-fills a targeted message on the leader's phone (e.g., *"Hi Alison, Troop 402 carpool coordinator here regarding Mt. Lassen. In your driver note you listed 'Anya'. We have Anya L. and Anya P. attending—could you let us know which one is riding in your car? Thanks!"*).
  - Add a `📱 Group Text Drivers` button for departure day announcements.
* **Model B: "Automated Email Ingestion Bot" (Zero Coordinator Effort)**:
  - When the background sync detects an ambiguity or incomplete training, the Node server automatically fires a templated email to the driver's email address via Resend.
  - Drivers can reply to the email or edit their note directly on TroopWebHost.
* **Model C: "Hybrid Automated Email + Urgent One-Tap Text"**:
  - The system auto-emails drivers as soon as notes are saved on TWH.
  - If notes remain unclarified within 48–72 hours of departure, the carpool UI surfaces the one-tap SMS button for the trip lead to quickly ping them by text.

