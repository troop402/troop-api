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
E.5.1 Full-name matches and family matches (matching driver surname) are confirmed automatically.
E.5.2 Unique first-name matches among attendees are matched when unambiguous.
E.5.3 Ambiguous first-name collisions (multiple attending scouts sharing the name) are never blindly assigned: they are logged in `clarificationsNeeded` with candidate rosters and tagged as `rideStatus: 'ambiguous'` on affected scouts so leaders can prompt drivers for full names.
E.5.4 Explicit open-seat notes in driver comments (e.g. "and 2 more") override derived calculations.
E.5.5 Nickname matching (e.g. Tom ↔ Thomas, Mike ↔ Michael) and family-name prioritization are applied to avoid missing adult passengers and family riders.
E.5.6 Tokens consumed by scout assignments are not re-claimed for adult passengers to prevent duplicate attributions.
E.5.7 Driver self-references (driver's own name, "myself", "me") account for the driver seat and do not occupy passenger seats. Available passenger seats are derived as `Math.max(0, seats - 1)`.
E.5.8 Ambiguous rider notes occupy passenger slots provisionally to prevent false open seat calculations.
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
H.3 Provides optimistic concurrency / dirty-state conflict checking: callers may pass `baselineComment`. If the current value in TroopWebHost does not match the baseline, the endpoint responds with HTTP 409 Conflict and the latest comment, unless `force: true` is supplied.
H.4 Injects discrete leg markup when TO and FROM trips are split (e.g. `Taking TO: ... . Taking FROM: ... .`).
H.5 Requires Tier 2 Coordinator authorization token (`Authorization: Bearer <token>`). Returns HTTP 401 if missing or expired.
H.6 Returns HTTP 400 for missing or invalid parameters, HTTP 409 for concurrency conflicts, and HTTP 500 for TroopWebHost submission failures.

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
K.3 Returns a signed HMAC session bearer token (`token`), duration (`expiresIn` / `expiresInMs`, 5 minutes / 300 seconds), and exact expiry timestamp (`expiresAt`).
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
8.4 This file is a current promise list, not a historical document of every abandoned idea.

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

