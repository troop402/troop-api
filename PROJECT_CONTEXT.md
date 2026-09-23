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
* **Version Control Policy:** Milestone release `v0.1.0-alpha` is tagged on `main` to document the pre-security baseline (what the system did *not* yet have: open read endpoints, no coordinator password, no authentication, no rate/scraper controls). Development of breaking security changes takes place on branch `feat/security-auth` at version `0.2.0-alpha` (matching `package.json` and `openapi/openapi.yaml`). The repository owner handles version tags and release merges.

---

## 5. Current State & Roadmap

### Current Status: `0.2.0-alpha` (Branch `feat/security-auth`)
* **Two-Tier Authentication Architecture**:
  - **Tier 1 (Troop Application Key)**: Shared `x-troop-key` HTTP header (or `?key=` query param for direct browser file downloads) required across all read endpoints (`/api/roster/summary`, `/api/export-roster`, `/api/events`, `/api/events/:id/carpool`, `/api/events/:id/carpool.xlsx`, `/api/events/:id/tabular.xlsx`, `/api/events/:id/twh-status`). Dev fallback is `troop402-app-access`. Unauthenticated calls receive HTTP 401.
  - **Tier 2 (Coordinator Password & Session Token)**: Write operations (`POST /api/events/:id/driver-update`) strictly require an `Authorization: Bearer <token>` signed HMAC session token issued by `POST /api/auth/coordinator-login` using the coordinator password (`COORDINATOR_PASSWORD`, dev fallback `scouts-lead-the-way`). Session tokens expire after 5 minutes (300 seconds).
  - **Visual Full-Page Lockout Overlay**: The Coordinator Worksheet (`/coordinator.html`) is visually locked behind a full-page modal until unlocked with the coordinator password. An active toolbar countdown badge (`🔒 Unlocked (4:59) [Lock]`) tracks remaining session duration and auto-locks immediately upon expiration or 401 response.
* **Shelved Server-Side In-Memory Carpool Cache**:
  - Server in-memory carpool cache TTL set to 0 (`carpoolTtlMs: 0`). The Node server always queries TroopWebHost live on event carpool requests.
  - Prominent floating refresh toast notification (`🔄 Checking...`, `✅ Up to date...`, `✨ Updated with latest...`, `⚠️ Error...`) provides continuous visual status feedback on both `carpool.html` and `coordinator.html`.
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

---

## 8. Shelved Database Exploration & Self-Service Parent Portal

During `0.1.0-alpha` development, an alternative architecture was explored and prototyped before being intentionally shelved in favor of direct TroopWebHost persistence:

### 8.1 The Self-Service Concept & Wireframe Prototype
* **Prototype**: Preserved in `public/wireframe.html` and artifact `wireframe_signup_portal.html`.
* **Concept**: A dedicated mobile-first signup and carpool portal where parents and drivers could:
  - Log in without full TWH access.
  - Directly declare vehicle seat capacity and driving availability (Outbound, Return, Both).
  - Claim their own scouts and additional passenger scouts into open seats.
  - Add departure or arrival timing notes.
* **Authentication Concept ("Loose Auth")**:
  - Rather than provisioning full TroopWebHost accounts or passwords, drivers would authenticate via phone number or email lookup against the scraped TWH roster.
  - Verification handled via one-time passcodes (SMS/Email OTP) or magic links.
  - Parent-to-scout relationships cross-referenced via TWH family linkage (`SectionID=1130` and `967`) so parents could automatically claim their registered children.
* **Database Backends Evaluated**:
  - Serverless SQL (Neon PostgreSQL or Turso LibSQL/SQLite) with schemas for `events`, `drivers`, `scout_assignments`, and `undo_log`.
  - Intended to provide instant, sub-second responses without Render cold starts or TWH HTTP roundtrips.

### 8.2 Why Shelved in Favor of Direct TroopWebHost Persistence
1. **Administrative Edit Feature in TroopWebHost**:
   - Troop leadership identified that TroopWebHost already provides an administrative capability to edit any member's sign-up records, seat capacities, and driver notes at:
     `Menu > Calendar > Sign Up Members > Sign Up Members For Events > [Sign Up Members]` (`FormReport.aspx?Menu_Item_ID=45888&Form_ID=3707`).
2. **Direct HTTP Scraper Feasibility**:
   - Technical investigation confirmed that our service can programmatically read and submit changes to Form 3707 using standard HTTP POST with ASP.NET WebForms ViewState extraction without requiring headless browsers.
3. **Single Source of Truth**:
   - TroopWebHost is a paid platform that Troop 402 is committed to long-term with a very slow software change cadence.
   - Using TWH as the primary datastore eliminates dual-write drift, sync race conditions, and external database maintenance costs.
4. **Preservation**:
   - All database connection configs, schema designs, and wireframe prototypes remain preserved in project configuration secrets and git history so they can be readily reactivated if the troop later decides to expose a direct self-service portal to parents.

---

## 9. Recent Major Milestones & Squashed Regressions

### 9.1 Direct TroopWebHost Writeback (`POST /api/events/:id/driver-update`)
* The Coordinator Worksheet (`public/coordinator.html`) writes seat counts, driving leg, and structured comments directly to TWH Form 3707.
* **Structured Comment Standard**: Formats comments deterministically (e.g. `Taking: Scout A, Scout B. Notes: Depart 4:30 PM`) so subsequent API runs parse assignments with 100% confidence.
* **Discrete Leg Split**: Supports discrete split legs: `Taking TO: Scout A. Taking FROM: Scout B.` when travel legs differ.
* **Dirty-State / Concurrency Checking**: Accepts `baselineComment` to detect if a parent has changed their note concurrently in TWH, returning HTTP 409 Conflict with the latest text unless `force: true` is set.

### 9.2 Coordinator In-Browser & Local-Storage Undo Stack
* Maintains a reversible action history in `coordinator.html`.
* Coordinators can roll back scout assignments and seat adjustments sequentially, with automatic writeback to TroopWebHost.

### 9.3 TroopWebHost Direct URL Architecture
* Direct links to event details (`Menu_Item_ID=36979`) and signup tables (`Menu_Item_ID=45888&Form_ID=3707`) initially returned HTTP 404 when prefixed with `/Troop402Danville/` or `/Troop402lafayette/`.
* Updated backend to generate direct URLs rooted at `https://www.troopwebhost.org/...`:
  - **Event Details (`twhEventUrl`)**: Matches TroopWebHost's official *Copy URL for this Event* pattern: `https://www.troopwebhost.org/FormDetail.aspx?Menu_Item_ID=45922&Form_ID=5429&Stack=0&Application_ID=2858&ID=${eventId}`.
  - **Member Sign-Ups (`twhSignupUrl`)**: Uses `https://www.troopwebhost.org/FormDetail.aspx?Menu_Item_ID=45926&Form_ID=3707&FK=0&ID=${eventId}&Stack=0`. The `Stack=0` parameter is critical: previous attempts with `Stack=2` triggered ASP.NET session stack-frame mismatch errors when opened directly in a new browser tab. With `Stack=0`, TWH renders the sign-up table cleanly without parent stack dependency.

### 9.4 Adult Safety Training & SYT (Youth Protection) Resolution
* **Centralized Compliance Scraping**: Rather than relying solely on individual course records in Section 1243, the backend queries TroopWebHost's centralized troop-wide report: **"Required Training By Person"** (`Menu_Item_ID=46029` &rarr; `FormReport.aspx?Menu_Item_ID=46029&Stack=1&ReportFormat=CSV`).
* **Dual California AB-506 Requirements**: California youth organization compliance mandates BOTH:
  1. Mandated Reporter Training (`AB-506 - CA Mandated Reporter`)
  2. DOJ Live Scan Fingerprint Background Check (`Live Scan - Finger Print Registration`)
* **Accurate Status Granularity**: Adults who completed the mandated reporter training but lack Live Scan fingerprinting (e.g. Vanessa Stewart, David Kersten) are accurately flagged with `stateTraining: 'Missing Live Scan'`, making `isCompliant: false`.
* **Terminology Modernization**: Completely replaced legacy "YPT" with BSA's official "SYT" (Safeguarding Youth Training) across backend, exports, and frontends.
* **Dual Compliance Rule**: A driver is marked `isCompliant: true` only if both SYT status and CA AB-506 State Training status are 'Current'.
* **Unconditional Safety Flagging**: Drivers who are registered in the event driver table but lack required compliance (e.g. Vanessa Stewart with `attending: '?'` and David Kersten with `attending: 'Y'`) are highlighted in amber (`#fffbeb`) and tagged with `Safety Non-Compliant` / `⚠️ Safety Gaps` across all driver and leg tables regardless of their attending answer. Troop safety compliance is an absolute prerequisite for any driver listed on the event roster.


### 9.5 Ambiguity Deduplication & Streamlined Button Format Across Trip Legs
* When an ambiguous note (e.g. "Taking Anya") applies to a driver driving both legs, `coordinator.html` previously displayed duplicate amber alert buttons.
* Deduplicated into a single unified action button and resolution modal that resolves both legs simultaneously.
* **Streamlined Alert Button Format**: The top-of-page alert banner button text is kept clean and concise (`⚠️ Driver Name: "token" →`, e.g. `⚠️ Alison Clayshulte: "anya" →`), omitting cluttered candidate lists and trip leg tags from the button label while preserving full candidate names and leg context within the resolution modal dialog.

### 9.6 One-Way Driver Differentiation
* Visual differentiation for drivers driving only outbound or return:
  - Lavender row background and border (`#8b5cf6`).
  - Clear `🔄 One-Way: TO Only` / `🔄 One-Way: FROM Only` badges.
  - Section subtitles clearly itemizing driver count disparities (e.g., 11 outbound vs. 12 return drivers).

### 9.7 Attending Scouts Waitlist & Interactive Table (`carpool.html`)
* Fixed broken scout search input by implementing comprehensive `filterScouts()` logic.
* Added live search filtering across scout name, patrol, and assigned driver.
* Implemented multi-column sorting (Scout Name, Patrol, Ride TO, Ride FROM, Permission Slip, Swim Test) with toggleable sort indicators (`▲`/`▼`).
* Added "⚡ Waitlist at Top" prioritization placing unassigned scouts needing rides at the very top.
* Added quick filter buttons (`All`, `⚠️ Needs Ride`, `🚗 Has Ride`) with dynamic scout counters.

### 9.8 Client-Side LocalStorage Instant Caching & Cross-Page Synchronization
* Both `carpool.html` and `coordinator.html` utilize `localStorage` with a stale-while-revalidate pattern (`twh_event_carpool_${eventId}`).
* **0ms Instant Render**: When navigating between the public carpool view and coordinator worksheet, or returning to a previously viewed event, the page renders immediately from `localStorage` without showing a loading spinner.
* **Background Revalidation**: Fetches fresh data silently in the background and updates the UI if upstream changes occurred.
* **Cross-Page Synchrony**: When a coordinator saves an edit on `coordinator.html`, the updated state is immediately saved to `localStorage`, so switching to `carpool.html` displays the updated assignments instantly without network delay.
* **Hard Refresh Flush**: Clicking the "🔄 Refresh" button clears `localStorage` and requests `/api/events/:id/carpool?forceRefresh=true`, forcing the server to bypass in-memory caches and fetch fresh from TroopWebHost.

### 9.9 Attending Scout Enrichment (BSA Registration, Medical Needs, Attendance Comments, Swim Date/Test)
* **Root Cause of Empty Swim Data**:
  - The Event Section 967 CSV (`Attending Scouts`) has columns: `Participant,Leadership,Patrol,Medical Forms Needed,Permission Given?,Additional Guests,Comment,Signed Up`.
  - It does NOT have a `Swim Test` column.
  - Swim test results and completion dates (`Swim Level`, `Swim Date`) reside globally in the Troop Roster export (`Menu_Item_ID=45897`).
  - Previously, `computeRosterSummary` did not extract these fields from the roster records.
* **Enriched Attributes**:
  - `swimTest` & `swimDate`: Populated from `Swim Level` (e.g., 'Swimmer', 'Beginner') and `Swim Date` in the troop roster.
  - `bsaRegistered`, `bsaId`, `bsaRegistrationEnds`: Evaluated from the troop roster (`Current`, `Expired`, or `No`).
  - `medicalNeeded`: Extracted directly from Event Section 967 `Medical Forms Needed` (e.g. `'A B'`, `'B'`).
  - `comment`: Extracted directly from Event Section 967 `Comment`. Parents and scouts frequently leave critical logistics notes here (e.g., Subhi Balaji: *"need to leave sunday morning have school on monday"*).
* **UI Integration**:
  - **`carpool.html` Table 4**: Expanded to 9 dedicated columns: Scout Name, Patrol, Ride TO, Ride FROM, Note / Comment, Permission, Medical Forms Needed, BSA Reg, and Swim Test & Date.
  - **Attendance Note Popover Modal**: Scouts with notes have a speech bubble button (`💬 Note`) that opens a clean modal with the full text, with previews in the table cell.
  - **Interactive Sorting & Live Filtering**: Multi-column sorting (`toggleScoutSort`) and live search (`scoutSearch`) search across all scout attributes including notes, medical status, and swim tests.
  - **`coordinator.html` Waitlist & Seat Modal**: Waitlist cards and the seat assignment selection modal display scout attendance comments inline (e.g. `💬 need to leave sunday morning...`), preventing coordinators from assigning riders with early departure constraints to the wrong drivers.

### 9.10 Customizable Cartesian Tabular Excel Export (`tabular.xlsx`)
* **Design Rationale**:
  - While the 4-sheet Lake Berryessa coordinator workbook (`carpool.xlsx`) serves printable roster check-in and complex cell-formula coordination, troop leadership often needs flat, plain-text relational data exports for pivot tables, ad-hoc filtering, external rosters, and custom analysis.
  - Rather than fixed columns, leadership requested full control to pick and order exported attributes from a rich catalog.
* **Cartesian Row Architecture**:
  - Each adult-driver-rider assignment is split into its own discrete row.
  - **Open Seats**: Drivers with remaining passenger capacity emit individual rows labeled `[Open Seat]` (with vehicle and driver info filled, rider info blank), making unfilled capacity instantly auditable. Toggleable via `includeOpenSeats` (default: on).
  - **Unassigned Attendees**: Scouts without rides emit individual rows with Driver labeled `(Unassigned)`, ensuring no attendee is missed during early export stages. Toggleable via `includeUnassigned` (default: on).
* **Trip Leg Splitting & Coalescing**:
  - Controlled by the `splitTripLegs` toggle (default: true).
  - When true: Outbound (`TO`) and return (`FROM`) trips produce distinct individual rows labeled with their specific leg, allowing users to filter by leg using Excel's built-in column auto-filter.
  - When false: Identical driver-rider trips across both directions coalesce into a single row marked `Trip Leg: Both`. One-way or asymmetric rides emit separate `TO only` or `FROM only` rows.
* **Column Catalog & Standard Preset**:
  - Supports 40+ selectable columns covering trip/event details, driver info (vehicle, license plate, driver status, SYT, AB506), and passenger info (rank, age, grade, parent emergency contacts 1 & 2, phone, permission, medical clearance dates, swim level, allergies, and dietary restrictions).
  - **Standard Preset**: Focused on core carpool logistics (`trip_leg`, `adult_name`, `adult_cell`, `adult_vehicle`, `adult_passenger_seats`, `seat_number`, `rider_name`, `rider_patrol`, `rider_parent_names`, `rider_parent_phone`, `rider_permission`, `rider_medical_forms`).
  - **Comments Excluded by Default**: In response to user feedback, driver comments and rider attendance comments are unchecked by default in the standard preset to keep exports clean and tabular, but remain selectable.
* **Client-Side Persistence & Workflow**:
  - Both `coordinator.html` and `carpool.html` feature a dedicated `📑 Tabular Export (.xlsx)` button opening an interactive modal with live column count badges, category groups, quick preset actions, and row toggles.
  - User selections persist across sessions in `localStorage` under `twh_tabular_export_settings`.
  - When triggered from `coordinator.html`, `POST /api/events/:id/tabular.xlsx` transmits the live in-browser `localDraft` state so exports reflect uncommitted assignments.

### 9.11 Tabular Export Scout Attribute Resolution & Unassigned Deduplication
* **Bug Squashed**:
  - In initial testing of the tabular export, scouts assigned to drivers had blank values for all scout-related columns (`rider_patrol`, `rider_parent_names`, `rider_parent_phone`, `rider_age`, `rider_grade`, `rider_rank`), and were simultaneously duplicated as unassigned rows (`(Unassigned)`) at the bottom of the spreadsheet.
* **Root Cause**:
  - In `carpoolData.scouts`, attendee names are stored as `"Last, First"` (e.g. `"Annis, Allison"`), whereas in driver comments parsed by `parseDriverComments`, riders are represented as `"First Last"` (e.g. `"Allison Annis"`).
  - The previous `normalizeNameKey(name)` merely stripped commas without transposing word order, producing `"annis allison"` vs. `"allison annis"`.
  - Consequently, `resolveScout()` failed to locate the scout in `scoutsByName` and returned a bare `{ name }` stub without attributes.
  - In parallel, `assignedToKeys.has("annis allison")` evaluated to `false`, wrongly classifying the assigned scout as unassigned and re-emitting them at the bottom.
* **Solution**:
  - Transposed `"Last, First"` &rarr; `"first last"` in `normalizeNameKey()`, ensuring identical normalized keys across all sources.
  - Enriched `scoutsByName` with multi-key indexing (including middle name/initial omission and original raw names) and merged attributes from `rosterSummary` when available.
  - Upgraded `resolveScout()` to accept both objects and strings, inspect `originalName`, and match first + last parts.
  - Updated `assignedToKeys` and `assignedFromKeys` to register both `r.name` and `r.originalName` while ignoring `r.type === 'adult'`.
  - Direct end-to-end testing on Event 1957 confirmed 100% attribute population on driver rows and 0 duplicate unassigned rows.





