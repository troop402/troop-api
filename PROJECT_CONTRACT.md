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
2.4 The service should keep in-memory caching as the default data retention model during alpha.
2.5 The project should remain flexible enough to support future endpoints without requiring a full rewrite.
2.6 The codebase should remain understandable to future developers and future AI agents.

## 3. Current behavior promises
3.1 The project will expose a lightweight health check endpoint.
3.2 The health check endpoint will return a successful status when the app process is alive and able to respond.
3.3 The project will provide an export endpoint for the troop roster data.
3.4 The export endpoint will accept TroopWebHost credentials and a troop URL in a structured request body.
3.5 The export endpoint will attempt to retrieve the proper roster file from TroopWebHost and return it in a way suitable for browser download.
3.6 The service should avoid issuing duplicate external fetches when multiple requests arrive at the same time.
3.7 The service should cache recent export data in memory to reduce redundant work.
3.8 When the export fails, the service should return a clear error rather than silently succeeding.
3.9 Missing required data should produce a predictable validation error with a clear response status.

## 4. Expected endpoint behaviors

### A. GET /healthz
A.1 This endpoint exists for deployment and health monitoring.
A.2 It should return HTTP 200 when the service is running.
A.3 It should be minimal, fast, and not depend on external systems.
A.4 It should not require authentication.

### B. POST /api/export-roster
B.1 This endpoint exists to export roster data from TroopWebHost.
B.2 It should accept a JSON payload containing the troop URL, username, and password.
B.3 It should validate required fields before attempting the export.
B.4 It should return a downloadable Excel file when successful.
B.5 It should set reasonable response headers for file download behavior.
B.6 It should return clear JSON errors for missing fields and request failures.
B.7 It should use caching and in-flight de-duping to avoid repeated expensive requests.

## 5. Operational promises
5.1 Sensitive credentials should not be committed to the repository.
5.2 Secret values should live in environment variables or host-managed secrets.
5.3 The service should keep TroopWebHost credentials away from public browser code when possible.
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
