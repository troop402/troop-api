# Context: troop-api (TroopWebHost Export & In-Memory Cache Proxy)

## 1. Project Goal & Intent (User's Core Vision)
* **Zero-Cost, Lightweight Operation:** Build a lightweight, low-overhead Node.js API service designed to run indefinitely on free-tier hosting (Render) without recurring troop infrastructure costs.
* **No Heavy Browser Automation:** Avoid resource-heavy headless browsers (Playwright/Puppeteer/Chromium) and Docker containers. Prioritize a pure Node.js HTTP approach to keep memory low (<50 MB), deployments instantaneous, and cold starts minimal.
* **TroopWebHost as the System of Record:** Automate extracting membership/roster data directly from TroopWebHost so leaders do not have to perform manual spreadsheet exports.
* **In-Memory Cache First:** Rather than setting up external databases or dealing with Render's 30-day expiring free databases, keep roster data cached directly in Node runtime memory. This shields TroopWebHost from duplicate logins and fits cleanly with Render's spin-down cycle. External permanent serverless SQL (e.g., Neon.tech) can be considered later if persistent history is needed.
* **Developer Workflow:** Developed locally in VS Code with Antigravity, version-controlled via GitHub (`main` branch), and auto-deployed to Render.

---

## 2. Platform Intelligence: TroopWebHost
* **Underlying Architecture:** Legacy Microsoft ASP.NET WebForms.
* **Authentication Mechanics:**
  * Login pages require capturing hidden tokens (`__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`) and tracking session cookies (`ASP.NET_SessionId`, `.ASPXAUTH`).
* **Export Mechanism (Key Finding):**
  * The site's "Export Roster to Excel" link uses a client-side wrapper:
    ```html
    <a href="javascript:LinkTo('FormReport.aspx?Menu_Item_ID=45897&amp;Stack=1&amp;ReportFormat=XLS','');">Export Roster to Excel</a>
    ```
  * This does **not** use an AJAX postback (`__doPostBack`). It is an ordinary HTTP `GET` request to:
    `FormReport.aspx?Menu_Item_ID=45897&Stack=1&ReportFormat=XLS`
  * **Result:** No browser execution is required. Standard HTTP clients can execute the login and stream the Excel file directly.

---

## 3. Hosting & Deployment Constraints (Render Free Tier)
* **Runtime:** Native Node (not Docker).
* **RAM:** 512 MB hard ceiling (OOM kill if exceeded).
* **CPU:** 0.1 vCPU.
* **Spin-down Policy:** Spins down after ~15 minutes of inactivity; subsequent cold start takes 30–50 seconds.
* **Execution Environment:** Single Web Service covering all endpoints; ephemeral filesystem (no persistent local file writes).
* **Current Deploy Status:** Render is connected to the GitHub repository but failed its first deploy because the repo is empty (`ENOENT: no such file or directory, open 'package.json'`). Adding the initial files resolves this.

---

## 4. Suggested Technical Approach for Antigravity

### Tech Stack
* **Runtime:** Node.js (ES Modules, `"type": "module"`).
* **Server:** `express`.
* **Scraping / HTTP:** `got-scraping` (manages browser headers/TLS fingerprinting), `tough-cookie` (cookie jar persistence), `cheerio` (HTML parsing to extract ASP.NET hidden fields).
* **Data Processing (Phase 2):** `xlsx` (SheetJS) to parse binary Excel buffers into JSON arrays.

### API Contract & Documentation Policy
* The service should maintain a plain-language API contract in the repository so the intended behavior is explicit and reviewable.
* This should be treated as the contract source of truth for human users and AI-assisted coding.
* OpenAPI is the preferred machine-readable format for any future formal API docs and CI checks.
* The API contract and the implementation should evolve together; documentation is not optional.
* The project is alpha, so breaking changes are allowed, but they must be intentional and documented.

### Recommended File Structure
```text
troop-api/
├── CONTEXT.md           # Project intent and requirements
├── API_CONTRACT.md      # Human-readable API promises and endpoint expectations
├── .gitignore           # node_modules, .env
├── package.json         # Scripts and dependencies
├── server.js            # Express app, auth scraper, caching, API routes
├── openapi/
│   └── openapi.yaml     # Future machine-readable API contract
├── public/
│   └── index.html       # Lightweight test harness UI
└── docs/
    └── generated/       # Generated docs output (optional)
