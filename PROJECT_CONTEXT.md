# PROJECT_CONTEXT: troop-api

This file is a project memory file for AI-assisted work. It exists to carry forward the user’s intent, goals, decisions, and trade-offs when the active chat context is not available.

Its purpose is intentionally broader than the code itself. It should capture the project’s trajectory, not just the current implementation.

---

## 1. Project purpose and original intent
The project began as a practical need: the troop wanted a lightweight backend service that could automate access to TroopWebHost data without paying for a heavy infrastructure stack.

The user’s recurring goals across the Gemini brainstorm and this chat can be summarized as:

- Build a low-cost, lightweight backend that can live on free-tier hosting.
- Avoid heavy browser automation and Docker unless absolutely necessary.
- Use TroopWebHost as the system of record rather than manual spreadsheet work.
- Keep the service flexible enough to support future troop tooling and endpoints.
- Stay in a Node.js environment that is easy to reason about and deploy.
- Prefer in-memory caching first, with database options kept as future considerations.
- Keep the project easy to hand off to future maintainers and future AI sessions.

This project is not a production-ready SaaS product yet. It is intentionally alpha.

---

## 2. Evolution of the idea through the chat history
The project started from a simple question: is there a public API for TroopWebHost? The answer was effectively no, and the brainstorm then shifted toward a custom backend proxy that does the data access work.

The important progression of the conversation was:

- TroopWebHost does not offer a clean public API.
- The user considered using browser automation (Playwright/Puppeteer) to log in and export data.
- The user then identified the specific export-link pattern and discovered that the roster export may be handled as a direct HTTP GET rather than a browser-driven dynamic postback.
- This became the key breakthrough: a pure Node.js HTTP scraper may be enough.
- The project direction shifted toward a lightweight Node + Express service with neat hosting constraints.
- The user expressed concern about free hosting limits and wanted to keep the app small enough to survive Render’s limits.
- The project moved away from heavy Docker/Playwright and toward direct HTTP + in-memory caching.
- The long-term architecture discussion included Render, Koyeb, Neon, and future DB-backed persistence.

This is the core historical signal: the architecture and intent settled around a lightweight, direct-HTTP backend, not a full browser automation stack.

---

## 3. What we believe TroopWebHost is doing
TroopWebHost is a legacy ASP.NET WebForms app. That matters because the site relies on server-generated state and cookies, including things like:

- `__VIEWSTATE`
- `__EVENTVALIDATION`
- `__VIEWSTATEGENERATOR`
- ASP.NET session cookies such as `ASP.NET_SessionId` and `.ASPXAUTH`

The user discovered a key fact in the roster export flow: the export link is generated as a JavaScript wrapper that resolves to a direct GET URL, which makes it plausible to access without needing a full browser VM.

The relevant pattern is conceptually:

```html
<a href="javascript:LinkTo('FormReport.aspx?Menu_Item_ID=45897&amp;Stack=1&amp;ReportFormat=XLS','');">Export Roster to Excel</a>
```

This effectively becomes a standard HTTP request to:

`FormReport.aspx?Menu_Item_ID=45897&Stack=1&ReportFormat=XLS`

This is the main technical fact that drives the current architecture. It is the reason the project can remain lightweight and avoid a browser-based stack for the first implementation.

---

## 4. Architectural decisions considered and rejected or deferred

### 4.1 Browser automation as the first path
The first instinct was to use Playwright or Puppeteer. That is a valid way to interact with a legacy web form and may be the most reliable approach on a complex site.

Why it was not chosen as the first path:

- It is memory-heavy.
- It is slower to deploy.
- It requires Docker or a larger environment in many free hosting scenarios.
- It increases complexity and maintenance burden.
- The user strongly wanted to stay lightweight and low-overhead.

This alternative remains valid as a reliability fallback if the direct HTTP login/export flow proves too fragile later.

### 4.2 Pure Node.js direct HTTP approach
This is the current preferred approach.

The project assumes:

- `express` as the server
- `got-scraping` or equivalent HTTP client behavior
- `cheerio` to parse hidden form fields and relevant login page state
- `tough-cookie` for preserving cookies across auth flow
- direct report GET after login
- lightweight deploys and low memory consumption

This matches the project’s free-tier and simplicity goals and is considered the best path forward for the next iteration.

### 4.3 Render vs Koyeb
The user explored both hosting options.

The key conclusions were:

- Render is simpler and fully workable with the Node-only approach.
- Koyeb was discussed as an alternative, but the platform situation changed and free-tier assumptions were not something to rely on long-term.
- Render became the stable target for the project after the direct HTTP approach was favored.

Key Render constraints that matter:

- 512 MB RAM ceiling
- 0.1 vCPU
- spin-down after inactivity
- no persistent local disk
- free service quotas and cold starts

### 4.4 Database strategy
The project has explicitly been designed around a memory-first model.

Current thinking:

- In-memory cache is the first layer.
- The app should avoid heavier database setup during alpha.
- The cache should reduce duplicate logins and repeated TroopWebHost exports.
- Future persistent storage would likely be Neon or another managed Postgres option if historical data or richer APIs are required.

Important principle: the service does not need a database just to work in the early stage. The database is a future enhancement, not a current requirement.

### 4.5 CI and API documentation
The user later decided this project should keep a contract and documentation structure in the repo as a visible “truth source.”

This includes:

- a plain-language project contract file
- machine-readable API docs via OpenAPI
- eventual CI validation for the API contract and endpoint smoke tests

This is not a production requirement today, but it is a deliberate framework choice to keep the project maintainable and guard against regressions.

---

## 5. Current technical constraints
These are the constraints the project should keep in mind when writing code or AI-generated changes.

- Runtime must be lightweight enough for free hosting.
- Avoid heavy browser automation unless absolutely necessary.
- Stay in Node.js with a simple app structure.
- Prefer direct HTTP requests to TroopWebHost over a headless browser stack.
- Use in-memory caching as the default storage model.
- Do not assume persistent file writes or local DB state are available.
- Keep project files small and understandable.
- Keep API behavior documented and reviewable.

---

## 6. Current intended architecture
The current intended architecture is intentionally modest:

- Node.js server using Express
- direct HTTP login and export flow to TroopWebHost
- request coalescing to avoid duplicate work when multiple requests overlap
- in-memory TTL cache for recent export data
- optional JSON conversion layer later via `xlsx`
- later optional DB integration if persistent data is needed
- Render deployment using native Node runtime

This is the architecture that best fits the user’s goals and constraints.

---

## 7. Non-goals and boundaries
The project is not currently trying to be:

- a full troop CRM
- a browser-based automation platform
- a heavy enterprise backend framework
- a multi-tenant SaaS platform
- a database-first app with permanent state on day one

These are not wrong ideas in the future, but they are not the current objective.

---

## 8. Guardrails for future AI sessions
This file should serve as the reference point for any AI that joins the project later.

The AI should treat the following as important truths:

- The project is lightweight by design.
- The project is alpha and may break APIs intentionally.
- TroopWebHost is the source of truth for roster/export data.
- The service should use direct HTTP where possible rather than browser automation.
- Keep the project grounded in low-cost hosting and low memory use.
- Preserve the project’s contract and docs alongside the code.
- Keep the project’s human-readable promises and the implementation aligned.

This document is intended to be updated as the project evolves. It should grow with the project rather than remain a fixed design spec.

---

## 9. File conventions to preserve
The project should keep a predictable naming and structure pattern:

- `PROJECT_CONTEXT.md` — long-lived AI memory and project history
- `PROJECT_CONTRACT.md` — current plain-language promises and requirements
- `openapi/openapi.yaml` — machine-readable API contract
- `README.md` — public-facing summary only
- `server.js` — runtime implementation

This makes the project easier to navigate and reduces the chance of conflicting interpretations between AI sessions.

---

## 10. Current status summary
The project is in an early alpha phase, with a clear direction but not yet a fully hardened production app.

Current state:

- direct HTTP approach is favored over headless browser automation
- Render is the deployment target of choice
- in-memory caching is the default data strategy
- the API contract and docs are being formalized in repo files
- future improvements may include DB persistence, CI smoke tests, and richer API endpoints

The project is intentionally narrow in scope but flexible enough to expand later.
