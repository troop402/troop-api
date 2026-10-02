# PROJECT_CONTRACT: troop-api

This document is the human-readable promise list for the project’s current behavior. It is intentionally not a technical design document. Its purpose is to state what the service is expected to do right now, in plain language, so future AI work and human review stay aligned.

This file is not meant to explain every implementation detail. It exists to be the project’s current contract: what we are promising to deliver, and which behaviors we want to preserve as the project evolves.

---

## 1. Purpose and scope
1.1 The project exists to provide a lightweight backend for troop operations and troop data integration.
1.2 The service is intended to act as a bridge between TroopWebHost and future internal troop tools.
1.3 The project is intentionally alpha. API behavior may change, but those changes should be deliberate and documented.
1.4 The codebase is meant to stay lightweight, low-cost, and easy to host on free-tier infrastructure.

## 2. Core product promises
2.1 The application should remain lightweight enough to run on free-tier hosting without heavy runtime overhead.
2.2 The service should prefer direct HTTP access to TroopWebHost over heavy browser automation.
2.3 TroopWebHost is treated as the source of truth for roster-export workflows.
2.4 The service shelves server-side in-memory carpool caching (`carpoolTtlMs: 0`) so event carpool data is queried live from TroopWebHost on every request, paired with prominent client-side toast feedback to keep users clearly informed during background refreshes. Roster export/summary continues to use server in-memory caching to avoid heavy repeated scrapes.
2.5 The project should remain flexible enough to support future endpoints without requiring a full rewrite.
2.6 The codebase should remain understandable to future developers and future AI agents.

## 3. Current behavior promises
3.1 The project will expose a lightweight health check endpoint.
3.2 The health check endpoint will return a successful status when the app process is alive and able to respond.
3.3 The project will provide an export endpoint for the troop roster data.
3.4 The export endpoint will use the configured TroopWebHost account held by the server environment.
3.5 The export endpoint will retrieve the roster CSV from TroopWebHost and return it in a way suitable for browser download.
3.5.1 The service will request CSV first and may retry with the TroopWebHost XLS format if the CSV response is unusable.
3.6 The service should avoid issuing duplicate external fetches when multiple requests arrive at the same time.
3.7 The service should cache recent export data in memory to reduce redundant work.
3.8 When the export fails, the service should return a clear error rather than silently succeeding.
3.9 Missing server configuration should produce a predictable error with a clear response status.
3.10 The service enforces a two-tier authentication architecture across all API endpoints:
3.10.1 Tier 1 (Troop Application Key): All read endpoints require a valid shared troop application key supplied via `x-troop-key` HTTP header or `?key=` query parameter. Requests with missing or invalid keys are rejected with HTTP 401.
3.10.2 Tier 2 (Coordinator Authorization): All coordinator mutation endpoints (such as `POST /api/events/:id/driver-update`) require a valid signed coordinator bearer token (`Authorization: Bearer <token>`) issued by `POST /api/auth/coordinator-login` using the coordinator password.
3.10.3 The Coordinator Worksheet UI (`/coordinator.html`) presents a full-page lockout overlay requiring the coordinator password to access or edit carpool records, expiring after 5 minutes with a live countdown and manual lock control.

## 4. Expected endpoint behaviors

### A. GET /healthz
A.1 This endpoint exists for deployment and health monitoring.
A.2 It should return HTTP 200 when the service is running.
A.3 It should be minimal, fast, and not depend on external systems.
A.4 It should not require authentication.

### B. POST /api/export-roster
B.1 This endpoint exists to export roster data from TroopWebHost.
B.2 It should use `TWH_TROOP_URL`, `TWH_USERNAME`, and `TWH_PASSWORD` from the server environment.
B.3 It should not require callers to send TroopWebHost credentials.
B.4 It should return a downloadable CSV file when successful.
B.4.1 It should try the CSV report format first and use XLS as a fallback when necessary.
B.5 It should set reasonable response headers for file download behavior.
B.6 It should return clear JSON errors for missing fields and request failures.
B.7 It should use caching and in-flight de-duping to avoid repeated expensive requests.

### C. GET /api/roster/summary
C.1 This endpoint returns summary statistics of the troop membership roster.
C.2 It returns JSON with `totalMembers`, `scoutsCount`, `adultsCount`, and cache status (`cachedAt`, `fresh`).
C.3 It reuses the cached roster data when available or fetches fresh data when expired.
C.4 It returns HTTP 500 if server credentials are not configured.

### D. GET /api/events
D.1 This endpoint returns upcoming and in-progress troop events.
D.2 It accepts an optional `days` query parameter (default 90 days) to filter events by date range.
D.3 Events remain visible while in progress and until at least 24 hours after their end date for return trip carpooling.
D.4 It returns an array of events: `id`, `title`, `eventType`, `location`, `start`, `end`, and `isCarpoolCandidate` (flagging offsite trips vs. CABIN or informational meetings).
D.5 It caches the events list in memory to minimize load on TroopWebHost.

### E. GET /api/events/:id/carpool
E.1 This endpoint returns combined carpool, attendance details, and comment intelligence for a specific event ID.
E.2 It retrieves driver registrations (`SectionID=38199`), attending adults (`SectionID=730`), and attending scouts (`SectionID=967`).
E.3 It calculates scout-centric carpool statistics: total drivers, total seats offered, total attending scouts, assigned scouts in driver notes, unassigned scouts needing rides, adult riders in vehicles, net scout seat balance (surplus/deficit), non-compliant drivers count, and leadership clarifications needed.
E.4 It cross-references driver contact details (phone, email, registered vehicle) from the cached roster and safety training compliance from both the attending adults roster (`SectionID=730`) and the Required Training By Person report (`Menu_Item_ID=46029` CSV). California State Training (`stateTraining`) requires completion of BOTH the online mandated reporter training (`AB-506`) and DOJ fingerprinting (`Live Scan`); drivers missing either requirement are marked with their specific gap (e.g. `'Missing Live Scan'`). A driver is marked `isCompliant: true` only if both BSA Safeguarding Youth Training (`sytStatus`) and California State Training (`stateTraining`) are 'Current'. Non-compliant status, metrics (`nonCompliantDriversCount`), and UI table row highlighting apply to all drivers registered on the event regardless of their attendance answer (`Y`, `?`, or `N`).
E.5 It parses driver comments against the attendee roster using layered name resolution:
E.5.1 Primary TWH Name Prioritization: The naming convention used as a scout's primary name in TroopWebHost takes absolute priority over nickname matches. If a commented name exactly matches the primary name of exactly one attending scout, it MUST always be derived as that scout.
E.5.2 Name Collision & Ambiguity: If a commented name matches the primary name of multiple attending scouts (e.g. identical first name or identical first name + last initial), it is treated as an ambiguous collision and flagged for coordinator resolution in `clarificationsNeeded`.
E.5.3 Nickname Fallback: Nicknames (e.g. Tom ↔ Thomas, Maddie ↔ Madison) are evaluated strictly as a secondary fallback only when NO attending scout possesses that name as their primary name in TroopWebHost.
E.5.4 Token Occurrence Enforcement: Tokens in a driver comment are tracked by occurrence (`countTokenOccurrences`). A word token can only be consumed once per appearance in the text, preventing multiple scouts from claiming the same word occurrence.
E.5.5 Migration to Primary Website Representation: Any editing, seat assignment by button press, or text compacting MUST seek to migrate a scout's name to the official representation used on the website (`First L` or `First Last` if collision, derived from the scout's primary TWH roster name).
E.5.6 Full-name matches and family matches (matching driver surname) are confirmed automatically.
E.5.7 Explicit open-seat notes in driver comments (e.g. "and 2 more") override derived calculations.
E.5.8 Tokens consumed by scout assignments are not re-claimed for adult passengers to prevent duplicate attributions.
E.5.9 Driver self-references (driver's own name, "myself", "me") account for the driver seat and do not occupy passenger seats. Available passenger seats are derived as `Math.max(0, seats - 1)`.
E.5.10 Ambiguous rider notes occupy passenger slots provisionally to prevent false open seat calculations.
E.6 It returns 400 for invalid or missing event IDs, and 500 if TroopWebHost retrieval fails.
E.7 It provides direct TroopWebHost URLs (`twhEventUrl` matching TWH's official Copy URL for Event `FormDetail.aspx?Menu_Item_ID=45922&Form_ID=5429&Stack=0&Application_ID=2858&ID=${eventId}`, and `twhSignupUrl` `FormDetail.aspx?Menu_Item_ID=45926&Form_ID=3707&FK=0&ID=${eventId}&Stack=0` with `Stack=0` to prevent ASP.NET session stack frame mismatch errors).
E.8 The accompanying Carpool HTML report (`/carpool.html`) provides an interactive Attending Scouts waitlist table with columns for Scout Name, Patrol, Ride TO, Ride FROM, Attendance Note / Comment, Permission, Medical Forms Needed, BSA Registration, and Swim Test & Date; clickable column sorting across all columns; live search across all scout attributes; and a one-click "⚡ Waitlist at Top" prioritization mode that places unassigned scouts at the top.
E.9 Attending scout records are enriched combining Event Section 967 (attendance `comment`, `permissionGiven`, `medicalNeeded`) and the troop roster (`swimTest` / `swimLevel`, `swimDate`, `bsaRegistered` status, `bsaId`, `bsaRegistrationEnds`, and medical clearance dates).

### F. GET /api/events/:id/carpool.xlsx
F.1 It generates a valid `.xlsx` binary spreadsheet workbook with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
F.2 It includes 4 tabs replicating the coordinator workbook: `Carpool`, `Summary` (with cross-checking formulas), `Scout roster`, and `Adult roster`.
F.3 In `Carpool`, available seats represent passenger seats for scouts (excluding driver: `Math.max(0, seats - 1)`), with helper availability formula columns (`=IF($C{row}<N$25, FALSE, TRUE)`), conditional formatting, and ice blue styling.
F.4 It renders "TO the event" and "FROM the event" sections with drivers, phone numbers, available passenger seats, special info/notes, and claimed scouts pre-assigned across horizontal slots 1 through 9, followed by a "WAITLIST" section.
F.5 It returns HTTP 400 for missing/invalid event IDs and 500 if TroopWebHost retrieval fails.

### G. POST /api/events/:id/carpool.xlsx
G.1 Accepts live custom working state (`toDrivers`, `fromDrivers`, `unassignedScouts`, `location`, `mapLink`) to produce an on-demand coordinator Excel spreadsheet reflective of in-browser edits.
G.2 Re-applies standard Lake Berryessa layout, data validation dropdowns, formulas, and roster references to the custom state.

### H. POST /api/events/:id/driver-update
H.1 Persists coordinator edits to a driver's comments, passenger seats, driving direction (`Both`, `To`, `From`), or driver status directly into TroopWebHost.
H.2 Submits directly to TroopWebHost's Admin Sign-Up Form (`FormReport.aspx?Menu_Item_ID=45888&Form_ID=3707`) via authenticated HTTP POST, parsing and sending ASP.NET WebForms ViewState.
H.3 TroopWebHost 100-Character Maximum Limit: Driver comments must not exceed 100 characters. Comments exceeding 100 characters are rejected with HTTP 400.
H.4 Compact Syntax & Single-Letter Surnames: Comments use compact syntax (`BOTH (seats): Scout A, Scout B.` with overlap factoring, and discrete `TO (seats): ... FROM (seats): ...`). Single-letter surnames omit periods (`Elianna S, Julia P`) and sentences guarantee a single trailing period without double dots (`..`).
H.5 Functional Equivalence & False Conflict Suppression: Concurrency checks compare comments using functional normalization (`normalizeCommentForComparison`). If the live comment and the proposed comment (or live comment and baseline) are functionally equivalent (ignoring whitespace, initial periods, casing, or trailing punctuation), no HTTP 409 conflict is raised.
H.6 Provides optimistic concurrency / dirty-state conflict checking: callers may pass `baselineComment`. If the current value in TroopWebHost differs substantially from the baseline, the endpoint responds with HTTP 409 Conflict and the latest comment, unless `force: true` is supplied.
H.7 Injects discrete leg markup when TO and FROM trips are split (e.g. `TO (seats): ... FROM (seats): ...`).
H.8 Requires Coordinator authorization Bearer token (`Authorization: Bearer <token>`). Returns HTTP 401 if missing/expired or HTTP 403 if role is not coordinator.
H.9 Returns HTTP 400 for missing or invalid parameters, HTTP 409 for concurrency conflicts, and HTTP 500 for TroopWebHost submission failures.

### I. GET /api/events/:id/twh-status
I.1 Checks whether the backend's current TroopWebHost credentials have active permission to edit driver sign-up records on the event.
I.2 Returns JSON with `authenticated: boolean`, `canEdit: boolean`, and edit URL details.
I.3 Requires Tier 1 application key.
I.4 Returns HTTP 400 for invalid event IDs and HTTP 500 if checking fails.

### J. GET and POST /api/events/:id/tabular.xlsx
J.1 Generates a flat Cartesian-style tabular Excel spreadsheet workbook (`.xlsx`) where each driver-rider assignment occupies its own discrete row.
J.2 Emits rows for assigned riders, extra rows for open passenger seats (`[Open Seat]`, enabled by default via `includeOpenSeats`), and rows for unassigned scouts (`(Unassigned)`, enabled by default via `includeUnassigned`).
J.3 Supports trip leg splitting via `splitTripLegs`:
J.3.1 When `splitTripLegs` is true (default), outbound (`TO`) and return (`FROM`) trips produce distinct individual rows labeled with their specific leg.
J.3.2 When `splitTripLegs` is false, identical driver-rider trips across both directions coalesce into a single row marked `Trip Leg: Both`, while asymmetric or one-way rides list `TO only` or `FROM only`.
J.4 Supports user-configurable column selection across 40+ attributes spanning trip details, adult driver data (name, cell, email, vehicle, license plate, SYT, AB506, seats), and rider data (name, patrol, rank, age, grade, parent contacts, emergency phone, permission slip, medical forms, BSA registration, swim test, and comments).
J.5 The default Standard preset provides a clean operational view without comment clutter (`adult_comment` and `rider_attendance_comment` are excluded by default from the preset).
J.6 Generates a single styled worksheet (`Carpool Tabular`) with a frozen header row (`ySplit: 1`), auto-filter enabled across all columns, subtle alternating row fills, distinctive styling for open seats and unassigned attendees, and auto-computed column widths.
J.7 `POST /api/events/:id/tabular.xlsx` accepts an optional live working state (`customState`) from the coordinator worksheet to export uncommitted in-browser edits.
J.8 Requires Tier 1 application key.
J.9 Returns HTTP 400 for invalid event IDs and HTTP 500 for generation failures.

### K. POST /api/auth/coordinator-login
K.1 Authenticates coordinator access using `COORDINATOR_PASSWORD` defined in server environment (defaults to dev fallback).
K.2 Verifies the password using constant-time buffer comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
K.3 Returns a signed HMAC session bearer token (`token`), duration (`expiresIn` / `expiresInMs`, defaulting to 25 minutes / 1500 seconds / 1,500,000 ms, configurable via `COORDINATOR_IDLE_TIMEOUT_MINUTES` or `COORDINATOR_IDLE_TIMEOUT_MS`), `idleTimeoutMs`, `maxSessionMs` (defaulting to 24 hours / 86,400,000 ms, configurable via `COORDINATOR_MAX_SESSION_HOURS` or `COORDINATOR_MAX_SESSION_MS`), and exact expiry timestamp (`expiresAt`).
K.4 Returns HTTP 400 if password is missing or not a string.
K.5 Returns HTTP 401 if password is incorrect.
K.6 Does not require prior authentication or application key.




## 5. Operational promises
5.1 Sensitive credentials should not be committed to the repository.
5.2 Secret values should live in environment variables or host-managed secrets.
5.3 The service must keep TroopWebHost credentials out of public browser code and request bodies.
5.4 The API contract should be kept in sync with the code, even during alpha.
5.5 Documentation should be reviewed alongside code changes when API behavior changes.

## 6. Documentation and CI promises
6.1 The project will keep both human-readable and machine-readable API documentation in the repository.
6.2 OpenAPI documentation should be treated as a contract that describes the API promises.
6.3 CI validates the OpenAPI contract and smoke-tests key endpoint behavior.
6.4 If an endpoint or response contract changes, the documentation and tests should change in the same change set.

## 7. Future-facing promises
7.1 The project may add more endpoints later for roster JSON, operational health checks, or future troop tools.
7.2 Any new endpoint should follow the same documentation and contract discipline.
7.3 Persistent database support may be added later if historical persistence becomes necessary.
7.4 Database support will not be treated as a current requirement unless the project explicitly adopts it.

## 8. Change policy
8.1 Breaking changes are allowed in alpha, but they should be intentional and called out.
8.2 The project should avoid silent regressions in endpoint behavior.
8.3 When a behavior changes, the corresponding contract and tests should be updated.
8.4 Local Development Definition & Default: The term "dev" explicitly and exclusively refers to the user's local Unraid development environment currently running via npm (`npm run dev`). The user only ever runs dev locally. Unless the user explicitly requests to push to live or create a pull request, all active iteration, commits, and testing MUST remain strictly local in the development environment. AI assistants and contributors must NOT push commits to GitHub (`origin/main`) or trigger deployment to live/production (Render) without explicit user instruction.
8.5 This file is a current promise list, not a historical document of every abandoned idea.
8.6 Summary URL Delivery: When publishing changes or delivering summaries, the AI assistant MUST always supply direct, clickable URLs to the relevant endpoints:
  - For local development iterations: provide links to local endpoints on the Unraid server (`http://localhost:3080/manager`, `http://localhost:3080/coordinator/1985`, `http://localhost:3080/carpool/1985`).
  - When changes are merged or published live: provide links to the live Render deployment (`https://troop402-api.onrender.com/manager`, `https://troop402-api.onrender.com/coordinator/1985`, `https://troop402-api.onrender.com/carpool/1985`).

## 9. Reference summary
9.1 This file is the current source of truth for what the project promises to do right now.
9.2 The implementation may evolve faster than the design docs, but the contract should not drift silently.
9.3 Longer historical context belongs in `PROJECT_CONTEXT.md`.
9.4 The technical design and implementation details are not the primary subject of this file.

## 10. Client-side loading, caching, and synchronization contract
10.1 Instant Render (0ms): All event views (Carpool View, Coordinator Worksheet) MUST render cached data from localStorage immediately on first execution tick if available, bypassing any initial loading splash.
10.2 Non-Interruptive Refreshing: Non-destructive backend refreshes—whether triggered automatically in the background on load or manually via "Refresh Website Data"—MUST NEVER tear down, hide, or blank out existing rendered data.
10.3 Subtle Activity Indicators: While revalidating or refreshing data in the background, pages MUST show a non-intrusive status indicator (e.g. animated refresh icon or sync badge), preserving the user's reading position and interaction state.
10.4 Canonical Data Source: Frontend views MUST rely on `GET /api/events/:id/carpool` as the single authoritative source for both carpool logistics and event metadata, eliminating redundant sequential calls to `/api/events`.
10.5 Force Refresh Parity: When a user explicitly requests a refresh ("Refresh Website Data"), the client MUST send `?forceRefresh=true` to the backend to bypass in-memory server TTL and scrape fresh data from TroopWebHost, while updating local cache seamlessly on completion.
10.6 Consistent Key Namespaces: Client-side storage keys MUST adhere to a consistent prefix (`twh_event_carpool_${id}`, `twh_coord_draft_${id}`, `twh_coord_history_${id}`, `twh_tabular_export_settings`).
10.7 Cache as Read-Performance Optimization (Not Dirty State): A copy of event carpool data in client `localStorage` (`twh_event_carpool_${id}`) exists solely as a performance cache for instant 0ms rendering and MUST NEVER be treated as evidence of uncommitted coordinator edits.
10.8 Aggressive Upstream Truth & Dirty State Granularity: Unless a driver row is currently in an active dirty state (pending a 3-second debounce timer or with an HTTP writeback actively in-flight), background fetches, page loads, and tab focus revalidations MUST aggressively adopt fresh data from TroopWebHost, overwriting local cache and re-rendering with zero prompts.
10.9 Row-Level Locking During Active Editing: If a background revalidation arrives while specific driver rows are in an active dirty state, the system locks and preserves only those specific dirty driver rows while freely updating all clean driver rows. A conflict prompt is raised if and only if an upstream change directly collides with an active dirty driver row.
10.10 Direct & Debounced Save Overlays with Seamless Screen Greyout:
10.10.1 Full Screen Blocking & Unbroken Greyout: When a save writeback is initiated from the note modal (`#noteSaveBtn`) or table row (`saveDriverDirectly`), the client MUST immediately disable the save button, show saving progress, and display the high-contrast full-screen saving overlay (`#savingOverlay`, background `rgba(15, 23, 42, 0.75)`, `backdrop-filter: blur(4px)`, `z-index: 999999`) before closing any open modal dialog. The screen MUST remain seamlessly and continuously greyed out and blocking until the HTTP writeback completes.
10.10.2 Graceful Save Failure & Local Preservation: If an HTTP writeback fails, the client MUST dismiss the saving overlay, retain the driver's edits locally in `localDraft`, mark the driver row with an active dirty indicator (`💾 (Unsaved)` and amber row styling), and surface clear failure feedback. The user is returned to the worksheet with their unsaved changes safely preserved and ready to retry, matching the open-seat assignment workflow.
10.11 Cross-Trip-Leg Clarification Sync Prompt: When a coordinator resolves a driver clarification or ambiguity on one trip leg (e.g. TO), and the exact same clarification condition exists on the opposite trip leg (e.g. FROM), the client MUST prompt the user (`#legSyncPromptModal`) asking whether to apply the identical resolution to the other leg, eliminating duplicate manual corrections.
10.12 Driver Note Dialog Comparison & Character Budget: The Driver Note dialog (`#noteModal`) MUST display the current live TroopWebHost comment field prominently above the proposed coordinator edit, feature a single-line input for Special Instructions / Constraints, and display a live preview of the complete proposed concatenated comment with an interactive character counter (`X / 100 chars`). If the total proposed comment exceeds the 100-character TroopWebHost limit, the dialog MUST highlight the overage and prevent saving.
10.13 Stale Dirty Data Escalation & Implicit Uncertainty: If uncommitted local dirty edits (`twh_coord_draft_${id}`) remain in `localStorage` across long periods (e.g. older than 15 minutes) or if upstream TroopWebHost data evolves underneath an uncommitted draft, the system MUST NOT silently overwrite or discard the draft. Because staleness introduces implicit uncertainty in which source of truth to trust, the client MUST escalate immediately to a conflict resolution modal (`#staleDraftModal`) displaying side-by-side comparisons of live TroopWebHost comments vs. stale coordinator edits, age indicators, and explicit options to either discard stale edits in favor of live TroopWebHost data (recommended) or force overwrite TroopWebHost with the stale edits.
10.14 Strict Preservation of Comment-Parsed Rider Order: The system MUST strictly preserve the exact sequential order in which riders are itemized in the driver's TroopWebHost comments across both backend parsing (`server.js`) and frontend rendering (`carpool.html` and `coordinator.html`). The parser and client MUST NEVER sort riders alphabetically or artificially group all scouts before adults. Preserving this order provides vital context (e.g., driver's own child or co-parent listed first, last rider added listed last) and prevents seat decrements from discarding the wrong passengers.
10.15 Dirty-Aware Full Reconstruction on Refresh & Invalidation of Non-Dirty Drafts:
10.15.1 A stored draft payload (`twh_coord_draft_${id}`) is valid ONLY if it contains active dirty drivers (`dirtyDrivers.length > 0`) that have verifiable differences from the live baseline (`isDriverTrulyDirty`). If no drivers are truly dirty, any stored draft payload MUST be purged immediately from `localStorage` on page load or refresh.
10.15.2 Browser page reloads (e.g. F5, Cmd+R, navigation reload type) and explicit refresh actions MUST bypass in-memory server caches via `?forceRefresh=true` and trigger a full rebuild (`buildBaselineDraft()`) of all clean driver rows and data structures from freshly scraped and parsed TroopWebHost comments.
10.15.3 The system MUST NEVER treat the mere presence of cached data in `localStorage` as a justification to retain obsolete drafts or display data inconsistent with the current codebase parsing logic. Clean driver rows are always reconstituted from live server truth.
10.16 Dynamic Seat Deficit & Surplus KPI Cards (Dual Card Display):
10.16.1 Separate Dedicated Cards: The coordinator worksheet summary KPI row features dedicated capacity balance cards for seat shortage ("Extra Seats Needed", `#kpiDeficitCard`, red theme) and surplus ("Extra Seats", `#kpiExtraCard`, blue theme) that evaluate true remaining seat balance relative to waitlisted scouts (`balanceTo = openSeatsTo - needsToCount`, `balanceFrom = openSeatsFrom - needsFromCount`).
10.16.2 Clean Numeric Representation: In all states, the TO and FROM split values MUST display clean, pure integer numbers without inline bold text descriptions or embedded words.
10.16.3 Dual Card Coexistence on Mixed Legs: When one trip leg has a deficit and the other leg has a surplus (e.g. TO has a deficit, FROM has a surplus), the worksheet MUST display BOTH cards simultaneously side-by-side:
  - "Extra Seats Needed" (red `.kpi-deficit`) displaying the shortage count for the deficit leg (e.g. TO: 1, FROM: 0).
  - "Extra Seats" (blue `.kpi-surplus`) displaying the surplus count for the extra leg (e.g. TO: 0, FROM: 2).
10.16.4 Pure Deficit / Pure Surplus Visibility: If all non-zero legs have a deficit, only "Extra Seats Needed" is displayed. If all legs have a surplus or exact capacity (0/0), only "Extra Seats" is displayed.
10.17 Proactive Coordinator Authentication, Action Continuation & Error Preservation:
10.17.1 Pre-Flight & Reactive Password Prompting: Whenever a coordinator triggers an action requiring coordinator privileges (e.g. saving driver comments/seats, generating/downloading live custom spreadsheets) while unauthenticated or after session expiration, the client MUST proactively float up the password prompt (`#coordinatorLockOverlay`) with an explicit contextual rationale (e.g. "Coordinator password required to save changes to Website" or "Coordinator password required to download spreadsheet").
10.17.2 Seamless Action Continuation & Auto-Retry: The authentication prompt MUST resolve pending actions asynchronously. Upon successful password verification, any in-flight or intercepted request (such as a driver save or spreadsheet generation) MUST be automatically executed or retried without requiring the user to re-trigger the action from scratch.
10.17.3 Preservation of Dirty State on Writeback Failures: If a driver update fails due to authentication or network error, `persistDriverChange` MUST propagate the error, and the client MUST strictly preserve dirty drivers in `pendingDriversToSync` and `localDraft`. The system MUST NEVER mark a driver clean or disable the save button when synchronization has not succeeded.
10.17.4 Proactive Visibility Expiry Detection: The client MUST listen for browser `visibilitychange` and window `focus` events to immediately evaluate token freshness when returning to the tab, prompting for re-authentication immediately if the inactivity window has elapsed in the background.
10.18 Non-Attending Nickname Resolution, Surname Extraction Safeguards, and Direct Save Actions:
10.18.1 Nickname Aliasing for Non-Attending Troop Members: The system MUST check known nicknames (`NICKNAMES`) when evaluating claims of non-attending troop roster members (`rosterScoutEntries` and `rosterAdultEntries`), ensuring aliases like "Madeline" correctly match non-attending roster members like "Maddy Spiker" as confirmed riders with `notAttending: true`.
10.18.2 Roster-Aware Ambiguity Resolution: The Ambiguity Resolution Modal MUST inspect both attending scouts and full troop roster entries, surfacing high-confidence family surname matches and nickname candidates with clear badge distinctions (`Family Match`, `Troop Roster (Not Registered)`).
10.18.3 Strict Surname & Driver Self-Reference Stripping: Custom driver note extraction (`extractDriverNote` and `cleanNote`) MUST strip driver surnames, driver full names, rider surnames, driver first names, nicknames, relationship stopwords (`kids`, `son`, `daughter`), and typo matches (Levenshtein distance <= 1), guaranteeing surnames are never mistakenly treated as special instructions or custom notes.
10.18.4 Direct Row-Level Writebacks: Clicking the dirty save icon (`💾`) in a driver table row MUST initiate an immediate HTTP writeback (`saveDriverDirectly`), display `#savingOverlay` with progress, and confirm success via toast notification, while reserving the note link/button for modal editing.
10.18.5 Render Spin-Up & Cold-Start Indicator: The coordinator password modal MUST display a loading spinner and an explicit status notice (`#coordSpinNotice`) if the verification request takes longer than 2.5 seconds, informing coordinators that the Render web service is waking from sleep.
10.19 Manager Console Authentication, Opportunistic Loading & Cold-Start Resilience:
10.19.1 Proactive Coordinator Unlock on Manager Console: The manager console (`manager.html`) provides the `#coordinatorLockOverlay` password modal and header session status controls (`#btnHeaderCoordAuth`), allowing coordinators to authenticate directly. Privileged operations (such as custom tabular spreadsheet exports or mutations) prompt for coordinator credentials if required, while read endpoints (roster summary, events) authenticate via the application key.
10.19.2 Instant 0ms Cache & Seamless Opportunistic Loading: Upcoming events (`twh_manager_events_cache`) and troop roster summary (`twh_manager_roster_summary`) are cached in client `localStorage`. On page load, cached events and summary counts render instantly (0ms) so the carpool dropdown and counts are immediately visible. The page opportunistically fetches fresh data in the background and seamlessly updates the UI upon response arrival without requiring manual refresh or sync buttons.
10.19.3 Network Spin-Up Auto-Retry: API calls executed through `managerFetch` catch cold-start network failures and retry once with a 2.5-second backoff while the service is waking up from idle before displaying any error states.
10.19.4 Authenticated Spreadsheet Downloads: Spreadsheet generation actions on the Manager Console route through authenticated `managerFetch`, downloading blobs directly and prompting for credentials if unauthorized rather than exposing raw unauthenticated endpoints.
10.20 Persistent Download Feedback & Multi-Mode Dismissal:
10.20.1 Prominent Top-Center Download Toast: Whenever a user triggers a spreadsheet or report export (.xlsx) across the Manager Console, Coordinator Worksheet, or Carpool Portal, the UI MUST display a prominent top-center floating toast notification (`.download-toast`).
10.20.2 Distinct Preparation and Completion States:
  - While generating on the server: displays an active indicator ("Preparing report (.xlsx)..." or "Preparing spreadsheet (.xlsx)...").
  - Upon download completion: transitions to a prominent success state ("Downloaded! Saved to your Downloads folder.") with an explicit close button (`✕`).
10.20.3 Multi-Mode Dismissal: The completion toast remains visible until dismissed. It MUST support dismissal via:
  - Clicking the `✕` close button.
  - Clicking directly on the toast itself.
  - Clicking anywhere off the toast (document click).
  - Pressing the Escape key.




