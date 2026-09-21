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

---

## 5. Current State & Roadmap

### Current Version: `0.1.0-alpha`
* Working `GET /healthz` endpoint.
* Working `POST /api/export-roster` endpoint with in-memory caching and CSV-first fallback.
* Fully automated CI with smoke and live integration testing.

### Planned Phase 2 Features:
1. **CSV Parsing to JSON:** Parse the 204 KB CSV payload into structured objects (scouts, adults, patrols, ranks, contact info) using a lightweight streaming/CSV parser.
2. **Normalized API Endpoints:** Expose clean JSON routes (e.g. `GET /api/roster` or `GET /api/members`).
3. **Operational Health Probes:** Add dedicated dependency probes (e.g. `GET /twhz`) separate from container liveness (`GET /healthz`).
4. **Persistent Database (Deferred):** Neon serverless PostgreSQL if historical sync or relational querying is required later.
