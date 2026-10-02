import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { app, createSignedToken, verifySignedToken, COORDINATOR_IDLE_TIMEOUT_MS, COORDINATOR_MAX_SESSION_MS } from '../server.js';

let server;
let baseUrl;
const TROOP_KEY_HEADER = { 'x-troop-key': 'troop402-app-access' };
const coordinatorToken = createSignedToken({ role: 'coordinator' });
const COORD_AUTH_HEADER = {
  ...TROOP_KEY_HEADER,
  'Authorization': `Bearer ${coordinatorToken}`,
  'Content-Type': 'application/json',
};

before(() => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
}));

describe('API smoke tests', () => {
  it('reports that the app is running', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
  });

  it('reports missing server credentials for export without contacting TroopWebHost', async () => {
    const environment = {
      TWH_TROOP_URL: process.env.TWH_TROOP_URL,
      TWH_USERNAME: process.env.TWH_USERNAME,
      TWH_PASSWORD: process.env.TWH_PASSWORD,
    };

    delete process.env.TWH_TROOP_URL;
    delete process.env.TWH_USERNAME;
    delete process.env.TWH_PASSWORD;

    let response;
    try {
      response = await fetch(`${baseUrl}/api/export-roster`, {
        method: 'POST',
        headers: { ...TROOP_KEY_HEADER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    } finally {
      Object.assign(process.env, environment);
    }

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'TroopWebHost environment variables are not configured.',
    });
  });

  it('reports missing server credentials for roster summary', async () => {
    const environment = {
      TWH_TROOP_URL: process.env.TWH_TROOP_URL,
      TWH_USERNAME: process.env.TWH_USERNAME,
      TWH_PASSWORD: process.env.TWH_PASSWORD,
    };

    delete process.env.TWH_TROOP_URL;
    delete process.env.TWH_USERNAME;
    delete process.env.TWH_PASSWORD;

    let response;
    try {
      response = await fetch(`${baseUrl}/api/roster/summary`, {
        headers: TROOP_KEY_HEADER,
      });
    } finally {
      Object.assign(process.env, environment);
    }

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'TroopWebHost environment variables are not configured.',
    });
  });

  it('reports missing server credentials for upcoming events', async () => {
    const environment = {
      TWH_TROOP_URL: process.env.TWH_TROOP_URL,
      TWH_USERNAME: process.env.TWH_USERNAME,
      TWH_PASSWORD: process.env.TWH_PASSWORD,
    };

    delete process.env.TWH_TROOP_URL;
    delete process.env.TWH_USERNAME;
    delete process.env.TWH_PASSWORD;

    let response;
    try {
      response = await fetch(`${baseUrl}/api/events?days=30`, {
        headers: TROOP_KEY_HEADER,
      });
    } finally {
      Object.assign(process.env, environment);
    }

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'TroopWebHost environment variables are not configured.',
    });
  });

  it('rejects invalid event ID for carpool endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool`, {
      headers: TROOP_KEY_HEADER,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for carpool.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool.xlsx`, {
      headers: TROOP_KEY_HEADER,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for POST carpool.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool.xlsx`, {
      method: 'POST',
      headers: { ...TROOP_KEY_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toDrivers: [] }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for tabular.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/tabular.xlsx`, {
      headers: TROOP_KEY_HEADER,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for POST tabular.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/tabular.xlsx`, {
      method: 'POST',
      headers: { ...TROOP_KEY_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: ['trip_leg'] }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for driver-update with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/driver-update`, {
      method: 'POST',
      headers: COORD_AUTH_HEADER,
      body: JSON.stringify({ driverName: 'Test, Driver' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects missing driverName for driver-update with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: COORD_AUTH_HEADER,
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'driverName is required.',
    });
  });

  it('rejects driver comments exceeding 100 characters with 400', async () => {
    const longComment = 'This is a very long driver comment that is intentionally going to exceed the strict 100 char limit! (101)';
    assert.ok(longComment.length > 100);
    const response = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: COORD_AUTH_HEADER,
      body: JSON.stringify({
        driverName: 'Simone, Jason',
        updatedComment: longComment,
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.error.includes('100-character maximum limit'));
  });

  it('rejects invalid event ID for twh-status with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/twh-status`, {
      headers: TROOP_KEY_HEADER,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('redirects /carpool/:id to /carpool.html?id=:id', async () => {
    const response = await fetch(`${baseUrl}/carpool/1957`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/carpool.html?id=1957');
  });

  it('redirects /coordinator/:id to /coordinator.html?id=:id', async () => {
    const response = await fetch(`${baseUrl}/coordinator/1957`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/coordinator.html?id=1957');
  });

  it('redirects /manager to /manager.html', async () => {
    const response = await fetch(`${baseUrl}/manager`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/manager.html');
  });
});

describe('Authentication and authorization', () => {
  it('rejects read endpoints without token or key with 401', async () => {
    const resNoKey = await fetch(`${baseUrl}/api/events`);
    assert.equal(resNoKey.status, 401);
    assert.deepEqual(await resNoKey.json(), {
      error: 'Authentication token required.',
    });

    const resWrongKey = await fetch(`${baseUrl}/api/events`, {
      headers: { 'x-troop-key': 'incorrect-key' },
    });
    assert.equal(resWrongKey.status, 401);

    const resWrongQueryKey = await fetch(`${baseUrl}/api/events?key=incorrect-key`);
    assert.equal(resWrongQueryKey.status, 401);
  });

  it('accepts valid viewer bearer token and legacy key parameters', async () => {
    // Valid viewer token reaches event handler
    const viewerToken = createSignedToken({ role: 'viewer' });
    const resBearer = await fetch(`${baseUrl}/api/events/not-an-id/carpool`, {
      headers: { 'Authorization': `Bearer ${viewerToken}` },
    });
    assert.equal(resBearer.status, 400);

    // Valid legacy header reaches event handler
    const resHeader = await fetch(`${baseUrl}/api/events/not-an-id/carpool`, {
      headers: { 'x-troop-key': 'troop402-app-access' },
    });
    assert.equal(resHeader.status, 400);

    // Valid legacy query param reaches event handler
    const resQuery = await fetch(`${baseUrl}/api/events/not-an-id/carpool?key=troop402-app-access`);
    assert.equal(resQuery.status, 400);

    // Valid token via ?token= query parameter reaches event handler
    const resQueryToken = await fetch(`${baseUrl}/api/events/not-an-id/carpool?token=${viewerToken}`);
    assert.equal(resQueryToken.status, 400);
  });

  it('handles token exchange via POST /api/auth/token', async () => {
    // Missing body
    const resMissing = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resMissing.status, 400);
    assert.deepEqual(await resMissing.json(), { error: 'Either appKey or password is required.' });

    // Invalid app key
    const resBadKey = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: 'bad-key' }),
    });
    assert.equal(resBadKey.status, 401);

    // Valid app key -> viewer role
    const resViewer = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: 'troop402-app-access' }),
    });
    assert.equal(resViewer.status, 200);
    const viewerData = await resViewer.json();
    assert.equal(viewerData.ok, true);
    assert.equal(viewerData.role, 'viewer');
    assert.equal(typeof viewerData.token, 'string');

    // Valid coordinator password -> coordinator role
    const validPassword = process.env.COORDINATOR_PASSWORD;
    const resCoord = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: validPassword }),
    });
    assert.equal(resCoord.status, 200);
    const coordData = await resCoord.json();
    assert.equal(coordData.ok, true);
    assert.equal(coordData.role, 'coordinator');
    assert.equal(typeof coordData.token, 'string');
    assert.equal(coordData.expiresIn, 300);
  });

  it('handles coordinator authentication flow via POST /api/auth/coordinator-login', async () => {
    const validPassword = process.env.COORDINATOR_PASSWORD;
    const resOk = await fetch(`${baseUrl}/api/auth/coordinator-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: validPassword }),
    });
    assert.equal(resOk.status, 200);
    const data = await resOk.json();
    assert.equal(data.ok, true);
    assert.equal(data.role, 'coordinator');
    assert.equal(typeof data.token, 'string');
    assert.equal(data.expiresIn, 300);
  });

  it('protects driver-update with coordinator role requirements', async () => {
    // Missing token
    const resNoToken = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverName: 'Doe, John' }),
    });
    assert.equal(resNoToken.status, 401);
    assert.deepEqual(await resNoToken.json(), {
      error: 'Authentication token required.',
    });

    // Invalid token
    const resBadToken = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid.fake.token',
      },
      body: JSON.stringify({ driverName: 'Doe, John' }),
    });
    assert.equal(resBadToken.status, 401);
    assert.deepEqual(await resBadToken.json(), {
      error: 'Invalid or expired session token.',
    });

    // Viewer role attempting driver-update is rejected with 403 Forbidden
    const viewerToken = createSignedToken({ role: 'viewer' });
    const resForbidden = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ driverName: 'Doe, John' }),
    });
    assert.equal(resForbidden.status, 403);
    assert.deepEqual(await resForbidden.json(), {
      error: 'Forbidden: Coordinator privileges required.',
    });

    // Valid coordinator token passes auth and proceeds to handler (invalid event ID -> 400)
    const validCoordToken = createSignedToken({ role: 'coordinator' });
    const resValidToken = await fetch(`${baseUrl}/api/events/not-an-id/driver-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validCoordToken}`,
      },
      body: JSON.stringify({ driverName: 'Doe, John' }),
    });
    assert.equal(resValidToken.status, 400);
    assert.deepEqual(await resValidToken.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('handles idle session refresh via POST /api/auth/refresh and enforces the 24-hour ceiling', async () => {
    // 1. Missing token
    const resNoToken = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(resNoToken.status, 401);
    assert.deepEqual(await resNoToken.json(), {
      error: 'Session token required for refresh.',
    });

    // 2. Expired token
    const expiredToken = createSignedToken({
      role: 'coordinator',
      exp: Date.now() - 5000,
      authAt: Date.now() - 60000,
    });
    const resExpired = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${expiredToken}`,
      },
    });
    assert.equal(resExpired.status, 401);
    assert.deepEqual(await resExpired.json(), {
      error: 'Invalid or expired session token. Please re-enter the coordinator password.',
    });

    // 3. Valid active token refreshes successfully, slides expiration forward, and preserves original authAt
    const originalAuthAt = Date.now() - 120000;
    const activeToken = createSignedToken({
      role: 'coordinator',
      exp: Date.now() + 60000,
      authAt: originalAuthAt,
    });
    const resRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeToken}`,
      },
    });
    assert.equal(resRefresh.status, 200);
    const refreshData = await resRefresh.json();
    assert.equal(refreshData.ok, true);
    assert.equal(refreshData.role, 'coordinator');
    assert.equal(refreshData.authAt, originalAuthAt);
    assert.equal(typeof refreshData.token, 'string');
    assert.equal(refreshData.expiresInMs, COORDINATOR_IDLE_TIMEOUT_MS);
    assert.ok(refreshData.expiresAt > Date.now());

    // Refreshed token is valid and carries original authAt
    const verifiedPayload = verifySignedToken(refreshData.token);
    assert.ok(verifiedPayload);
    assert.equal(verifiedPayload.role, 'coordinator');
    assert.equal(verifiedPayload.authAt, originalAuthAt);

    // 4. Token exceeding 24-hour absolute maximum session duration is rejected
    const cappedAuthAt = Date.now() - (COORDINATOR_MAX_SESSION_MS + 1000);
    const overCapToken = createSignedToken({
      role: 'coordinator',
      exp: Date.now() + 60000,
      authAt: cappedAuthAt,
    });
    const resOverCap = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${overCapToken}`,
      },
    });
    assert.equal(resOverCap.status, 401);

    // verifySignedToken also rejects tokens that exceeded max session duration
    assert.equal(verifySignedToken(overCapToken), null);
  });
});

describe('Driver comment parsing unit test', () => {
  it('correctly matches scouts and adult passengers, and calculates open seats', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Ayers, Elena',
        attending: 'Y',
        seats: 4,
        comment: 'driving myself, Gwyneth, Allison Annis, Rachael Schonfeld',
      },
      {
        name: 'Tzortzis, Heather',
        attending: 'Y',
        seats: 5,
        comment: 'Heather, Chris & Alina and 2 more',
      },
      {
        name: 'Hoover, Brad',
        attending: 'Y',
        seats: 4,
        comment: '',
      },
    ];

    const scouts = [
      { name: 'Annis, Allison', patrol: 'Gator' },
      { name: 'Ayers, Gwyneth', patrol: 'Dragon' },
      { name: 'Schonfeld, Rachael', patrol: 'Dragon' },
      { name: 'Tzortzis, Alina', patrol: 'Falcon' },
      { name: 'Smith, John', patrol: 'Gator' },
    ];

    const adults = [
      { name: 'Ayers, Elena', leadership: 'Committee Chair' },
      { name: 'Tzortzis, Heather', leadership: 'Scoutmaster' },
      { name: 'Tzortzis, Chris', leadership: 'Assistant Scoutmaster' },
      { name: 'Hoover, Brad', leadership: 'Committee Member' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    assert.equal(result.adultRidersCount, 1); // Chris Tzortzis is riding
    assert.equal(result.assignedScoutsCount, 4); // Allison, Gwyneth, Rachael, Alina

    // Check Elena's vehicle (4 seatbelts - 1 driver - 3 scouts = 0 open seats)
    const elena = result.enrichedDrivers.find((d) => d.name === 'Ayers, Elena');
    assert.equal(elena.claimedScouts.length, 3);
    assert.equal(elena.openSeats, 0);

    // Check Heather's vehicle with explicit "and 2 more"
    const heather = result.enrichedDrivers.find((d) => d.name === 'Tzortzis, Heather');
    assert.equal(heather.claimedScouts.length, 1);
    assert.equal(heather.claimedAdults.length, 1);
    assert.equal(heather.openSeats, 2);

    // Check Brad's vehicle (4 seatbelts - 1 driver = 3 available passenger seats)
    const brad = result.enrichedDrivers.find((d) => d.name === 'Hoover, Brad');
    assert.equal(brad.openSeats, 3);

    // Check scout ride status
    const allison = result.enrichedScouts.find((s) => s.name === 'Annis, Allison');
    assert.equal(allison.assignedDriver, 'Ayers, Elena');
    assert.equal(allison.rideStatus, 'confirmed');

    const john = result.enrichedScouts.find((s) => s.name === 'Smith, John');
    assert.equal(john.assignedDriver, null);
    assert.equal(john.rideStatus, 'unassigned');
  });

  it('detects first-name collisions, refuses blind assignments, and logs clarificationsNeeded', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Clayshulte, Alison',
        attending: 'Y',
        seats: 5,
        comment: 'Alison, Anya, Mila, and 2 open spots',
      },
    ];

    const scouts = [
      { name: 'Lavrinets, Anya', patrol: 'Dragon' },
      { name: 'Patath, Anya', patrol: 'Gator' },
      { name: 'Lavrinets, Mila', patrol: 'Dragon' },
      { name: 'Robinson, Mila', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Clayshulte, Alison', leadership: 'Committee Member' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    // Collision should refuse blind assignment
    assert.equal(result.assignedScoutsCount, 0);
    assert.equal(result.clarificationsNeeded.length, 2);

    const anyaClarification = result.clarificationsNeeded.find((c) => c.token === 'anya');
    assert.ok(anyaClarification);
    assert.equal(anyaClarification.driverName, 'Clayshulte, Alison');
    assert.equal(anyaClarification.candidates.length, 2);
    assert.ok(anyaClarification.candidates.includes('Anya Lavrinets'));
    assert.ok(anyaClarification.candidates.includes('Anya Patath'));

    const anya1 = result.enrichedScouts.find((s) => s.name === 'Lavrinets, Anya');
    assert.equal(anya1.assignedDriver, null);
    assert.equal(anya1.rideStatus, 'ambiguous');
    assert.match(anya1.rideNote, /Clayshulte, Alison/);

    const mila1 = result.enrichedScouts.find((s) => s.name === 'Robinson, Mila');
    assert.equal(mila1.assignedDriver, null);
    assert.equal(mila1.rideStatus, 'ambiguous');

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.ambiguousNotes.length, 2);
    assert.equal(driver.claimedScouts.length, 0);
    // Open seats should honor explicit note "and 2 open spots"
    assert.equal(driver.openSeats, 2);
  });

  it('resolves family matches and full-name disambiguation when multiple scouts share first names', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Renno, Amanda',
        attending: 'Y',
        seats: 4,
        comment: 'Driving Mackenzie',
      },
      {
        name: 'Polcari, Emily',
        attending: 'Y',
        seats: 4,
        comment: 'Emily, Maddie Curran',
      },
    ];

    const scouts = [
      { name: 'Renno, Mackenzie', patrol: 'Falcon' },
      { name: 'Stern, MacKenzie', patrol: 'Dragon' },
      { name: 'Curran, Maddie', patrol: 'Gator' },
      { name: 'Keeler-Hodgets, Maddie', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Renno, Amanda', leadership: 'Adult' },
      { name: 'Polcari, Emily', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    // Mackenzie Renno resolved via family match with driver Amanda Renno
    const macRenno = result.enrichedScouts.find((s) => s.name === 'Renno, Mackenzie');
    assert.equal(macRenno.assignedDriver, 'Renno, Amanda');
    assert.equal(macRenno.rideStatus, 'family_match');

    // MacKenzie Stern left unassigned and NOT ambiguous (since driver matched family)
    const macStern = result.enrichedScouts.find((s) => s.name === 'Stern, MacKenzie');
    assert.equal(macStern.assignedDriver, null);
    assert.equal(macStern.rideStatus, 'unassigned');

    // Maddie Curran resolved via full-name match in comment
    const maddieCurran = result.enrichedScouts.find((s) => s.name === 'Curran, Maddie');
    assert.equal(maddieCurran.assignedDriver, 'Polcari, Emily');
    assert.equal(maddieCurran.rideStatus, 'confirmed');

    // Maddie Keeler-Hodgets left unassigned
    const maddieKH = result.enrichedScouts.find((s) => s.name === 'Keeler-Hodgets, Maddie');
    assert.equal(maddieKH.assignedDriver, null);
    assert.equal(maddieKH.rideStatus, 'unassigned');

    // No clarifications needed because both were successfully resolved
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('resolves adult nicknames, prevents token re-use, and handles capacity', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Renno, Amanda',
        attending: 'Y',
        seats: 4,
        comment: 'Amanda, Tom, Emily, Mackenzie',
      },
    ];

    const scouts = [
      { name: 'Renno, Emily', patrol: 'Gator' },
      { name: 'Renno, Mackenzie', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Renno, Amanda', leadership: 'Adult' },
      { name: 'Renno, Thomas', leadership: 'Adult' },
      { name: 'Polcari, Emily', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.claimedScouts.length, 2);
    assert.equal(driver.claimedAdults.length, 1);
    assert.equal(driver.claimedAdults[0], 'Thomas Renno');
    // Emily token was consumed by Emily Renno, so Emily Polcari was not claimed
    assert.ok(!driver.claimedAdults.includes('Emily Polcari'));
    // 4 seatbelts total - 1 driver - 2 scouts - 1 adult = 0 open seats
    assert.equal(driver.openSeats, 0);
  });

  it('intelligently parses discrete TO and FROM structured driver comments with split capacities and riders', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Knudson, BJ',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'TO (3 seats): Taking Iris Knudson, Julia Parsons. FROM (1 seats): Taking Julia Parsons. Arriving late Friday.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
      { name: 'Lavrinets, Anya', patrol: 'Dragon' },
    ];

    const adults = [
      { name: 'Knudson, BJ', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 3);
    assert.equal(driver.fromSeats, 1);
    assert.equal(driver.cleanNote, 'Arriving late Friday.');

    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Iris Knudson'));
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Julia Parsons'));

    assert.equal(driver.claimedScoutsFrom.length, 1);
    assert.equal(driver.claimedScoutsFrom[0].name, 'Julia Parsons');

    const iris = result.enrichedScouts.find((s) => s.name === 'Knudson, Iris');
    assert.equal(iris.assignedDriverTo, 'Knudson, BJ');
    assert.equal(iris.assignedDriverFrom, null);
    assert.equal(iris.rideDirection, 'To');

    const julia = result.enrichedScouts.find((s) => s.name === 'Parsons, Julia');
    assert.equal(julia.assignedDriverTo, 'Knudson, BJ');
    assert.equal(julia.assignedDriverFrom, 'Knudson, BJ');
    assert.equal(julia.rideDirection, 'Both');

    const anya = result.enrichedScouts.find((s) => s.name === 'Lavrinets, Anya');
    assert.equal(anya.assignedDriverTo, null);
    assert.equal(anya.assignedDriverFrom, null);
    assert.equal(anya.rideDirection, 'None');
  });

  it('parses compact Both (seats) comments and preserves custom notes', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Simone, Jason',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Both (2): Iris Knudson, Julia Parsons. Leaving at 6am.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Simone, Jason', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 2);
    assert.equal(driver.fromSeats, 2);
    assert.equal(driver.cleanNote, 'Leaving at 6am.');
    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.equal(driver.claimedScoutsFrom.length, 2);
  });

  it('parses factored Both (seats) with discrete TO/FROM additions', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Simone, Jason',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'Both (4): Iris Knudson. TO: Julia Parsons. Arriving Friday night.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Simone, Jason', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 4);
    assert.equal(driver.fromSeats, 4);
    assert.equal(driver.cleanNote, 'Arriving Friday night.');
    // Iris rode both ways (from Both block), Julia rode TO only (from TO block)
    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.equal(driver.claimedScoutsFrom.length, 1);
    assert.equal(driver.claimedScoutsFrom[0].name, 'Iris Knudson');
  });

  it('parses compact discrete TO and FROM comments without the word Taking', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Simone, Jason',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'TO (1): Iris Knudson. FROM (2): Julia Parsons. Departing Sunday morning.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Simone, Jason', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 1);
    assert.equal(driver.fromSeats, 2);
    assert.equal(driver.cleanNote, 'Departing Sunday morning.');
    assert.equal(driver.claimedScoutsTo.length, 1);
    assert.equal(driver.claimedScoutsTo[0].name, 'Iris Knudson');
    assert.equal(driver.claimedScoutsFrom.length, 1);
    assert.equal(driver.claimedScoutsFrom[0].name, 'Julia Parsons');
  });

  it('parses freeform leg prefix and extracts clean note for complex driver comments', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Simone, Jason',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'TO: Myself and Elianna only, One avaliable seat on return. Departing Sunday morning.',
      },
    ];

    const scouts = [
      { name: 'Simone, Elianna', patrol: 'Sun Bear' },
    ];

    const adults = [
      { name: 'Simone, Jason', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.claimedScoutsTo.length, 1);
    assert.equal(driver.claimedScoutsTo[0].name, 'Elianna Simone');
  });

  it('matches scouts formatted as First L. with surname initials and uppercase BOTH', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Knudson, BJ',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'BOTH (4): Iris K., Julia P. Arriving Friday night.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Knudson, BJ', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 4);
    assert.equal(driver.fromSeats, 4);
    assert.equal(driver.cleanNote, 'Arriving Friday night.');
    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Iris Knudson'));
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Julia Parsons'));
  });

  it('disambiguates duplicate first names using last initial (First L.)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Leader, Dan',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'BOTH (4): Emily P., Emily R.',
      },
    ];

    const scouts = [
      { name: 'Polcari, Emily', patrol: 'Dragon' },
      { name: 'Renno, Emily', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Leader, Dan', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Emily Polcari'));
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Emily Renno'));
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('detects ambiguity when multiple scouts share the same first name and same last initial', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Leader, Dan',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'BOTH (4): Emily P.',
      },
    ];

    const scouts = [
      { name: 'Polcari, Emily', patrol: 'Dragon' },
      { name: 'Patterson, Emily', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Leader, Dan', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.claimedScoutsTo.length, 0);
    assert.equal(result.clarificationsNeeded.length, 1);
    assert.ok(result.clarificationsNeeded[0].token.includes('Emily P'));
  });

  it('matches scouts formatted as First L (without period) with surname initials', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Knudson, BJ',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'BOTH (4): Iris K, Julia P. Arriving Friday night.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Knudson, BJ', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 4);
    assert.equal(driver.fromSeats, 4);
    assert.equal(driver.cleanNote, 'Arriving Friday night.');
    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Iris Knudson'));
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Julia Parsons'));
  });

  it('accurately detects functional equivalence between driver comments to prevent false conflicts', async () => {
    const { areCommentsFunctionallyEquivalent, normalizeCommentForComparison } = await import('../server.js');

    // Identical comments
    const c1 = 'TO (1): Elianna S.. FROM (2): Elianna S.. One available seat on return. Departing Sunday morning';
    const c2 = 'TO (1): Elianna S.. FROM (2): Elianna S.. One available seat on return. Departing Sunday morning';
    assert.ok(areCommentsFunctionallyEquivalent(c1, c2));

    // Double-dot vs single-dot and trailing period differences
    const c3 = 'TO (1): Elianna S. FROM (2): Elianna S. One available seat on return. Departing Sunday morning.';
    assert.ok(areCommentsFunctionallyEquivalent(c1, c3));

    // Surname initial with period vs without period (Iris K. vs Iris K)
    const cWithDot = 'BOTH (2): Iris K., Julia P. Arriving Friday night.';
    const cWithoutDot = 'BOTH (2): Iris K, Julia P. Arriving Friday night.';
    assert.ok(areCommentsFunctionallyEquivalent(cWithDot, cWithoutDot));

    // Case difference in leg prefixes (Both vs BOTH) and extra spaces
    const c4 = 'both (2): Iris K., Julia P.   Arriving Friday night.';
    const c5 = 'BOTH (2): Iris K., Julia P. Arriving Friday night';
    assert.ok(areCommentsFunctionallyEquivalent(c4, c5));

    // Genuine difference in seat counts
    const diffSeats = 'BOTH (3): Iris K., Julia P. Arriving Friday night';
    assert.ok(!areCommentsFunctionallyEquivalent(c4, diffSeats));

    // Genuine difference in riders
    const diffRiders = 'BOTH (2): Iris K., Anya L. Arriving Friday night';
    assert.ok(!areCommentsFunctionallyEquivalent(c4, diffRiders));

    // Genuine difference in driver note
    const diffNote = 'BOTH (2): Iris K., Julia P. Leaving Saturday morning';
    assert.ok(!areCommentsFunctionallyEquivalent(c4, diffNote));
  });

  it('prioritizes exact primary TWH names over nicknames and prevents token re-use (Emily Polcari & Maddie Curran)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Polcari, Emily',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Driving Keira, Maddie Curran, and Katie Kidd',
      },
    ];

    const scouts = [
      { name: 'Polcari, Keira', patrol: 'Dragon' },
      { name: 'Curran, Maddie', patrol: 'Dragon' },
      { name: 'Kidd, Katie', patrol: 'Dragon' },
      { name: 'Watkins, Madison', patrol: 'Falcon' },
      { name: 'Wong, Madison', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Polcari, Emily', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    // Only Keira, Maddie Curran, and Katie Kidd should be claimed
    assert.equal(driver.claimedScouts.length, 3);
    assert.ok(driver.claimedScouts.some((s) => s.name === 'Maddie Curran'));
    assert.ok(driver.claimedScouts.some((s) => s.name === 'Katie Kidd'));
    assert.ok(driver.claimedScouts.some((s) => s.name === 'Keira Polcari'));

    // Neither Madison Watkins nor Madison Wong should be claimed
    assert.ok(!driver.claimedScouts.some((s) => s.name.includes('Madison')));
    assert.ok(!driver.claimedScouts.some((s) => s.name.includes('Watkins')));
    assert.ok(!driver.claimedScouts.some((s) => s.name.includes('Wong')));

    // No clarifications needed
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('guarantees exact primary TWH name always matches even if another scout has that name as a nickname', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Driver, Bob',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Taking Maddie',
      },
    ];

    const scouts = [
      { name: 'Curran, Maddie', patrol: 'Dragon' },
      { name: 'Watkins, Madison', patrol: 'Falcon' }, // Has nickname "Maddie"
    ];

    const adults = [
      { name: 'Driver, Bob', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    // Primary name "Maddie" on Curran, Maddie MUST win over secondary nickname on Watkins, Madison
    assert.equal(driver.claimedScouts.length, 1);
    assert.equal(driver.claimedScouts[0].name, 'Maddie Curran');
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('matches Maddy as a nickname alias for Maddie in driver comments (Steve Spiker comment)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Spiker, Steve',
        attending: 'N',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'Taking Lucy, Maddy Spiker plus my fam no spare seats',
      },
    ];

    const scouts = [
      { name: 'Spiker, Maddie', patrol: 'Dragon' },
      { name: 'Ayers, Lucy', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Spiker, Steve', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    // Both Lucy Ayers and Maddie Spiker should be claimed
    assert.equal(driver.claimedScouts.length, 2);
    const claimedNames = driver.claimedScouts.map((s) => s.name);
    assert.ok(claimedNames.includes('Lucy Ayers'));
    assert.ok(claimedNames.includes('Maddie Spiker'));
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('detects duplicate rider claims when multiple drivers claim the same scout on a trip leg (Penny Campos)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Driver, Alice',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Taking Penny Campos',
      },
      {
        name: 'Driver, Bob',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Taking Penny Campos',
      },
    ];

    const scouts = [
      { name: 'Campos, Penny', patrol: 'Dragon' },
    ];

    const adults = [
      { name: 'Driver, Alice', leadership: 'Adult' },
      { name: 'Driver, Bob', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    // Duplicate should be consolidated per scout combining TO and FROM legs
    assert.ok(result.duplicateRiderClaims);
    assert.equal(result.duplicateRiderClaims.length, 1); // Consolidated across both legs
    const claim = result.duplicateRiderClaims[0];
    assert.equal(claim.scoutName, 'Campos, Penny');
    assert.equal(claim.direction, 'Both');
    assert.deepEqual(claim.drivers, ['Driver, Alice', 'Driver, Bob']);
    assert.deepEqual(claim.driversTo, ['Driver, Alice', 'Driver, Bob']);
    assert.deepEqual(claim.driversFrom, ['Driver, Alice', 'Driver, Bob']);

    // Scout status should indicate duplicate
    const penny = result.enrichedScouts.find((s) => s.name === 'Campos, Penny');
    assert.ok(penny);
    assert.equal(penny.rideStatus, 'duplicate');
    assert.equal(penny.isDuplicate, true);
  });

  it('strictly preserves the original comment order of riders instead of sorting alphabetically', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Polcari, Emily',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'Driving Keira, Maddie Curran, and Katie Kidd',
      },
      {
        name: 'Hoover, Brad',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'Taking Thomas (adult), and Owen',
      },
    ];

    const scouts = [
      { name: 'Curran, Maddie', patrol: 'Dragon' },
      { name: 'Kidd, Katie', patrol: 'Falcon' },
      { name: 'Polcari, Keira', patrol: 'Dragon' },
      { name: 'Ayers, Owen', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Polcari, Emily', leadership: 'Committee Chair' },
      { name: 'Hoover, Brad', leadership: 'Adult' },
      { name: 'Renno, Thomas', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const emily = result.enrichedDrivers.find((d) => d.name === 'Polcari, Emily');

    // Keira (index 8), Maddie Curran (index 15), Katie Kidd (index 34)
    // Must NOT be sorted alphabetically (Curran, Kidd, Polcari)
    assert.equal(emily.claimedScouts.length, 3);
    assert.equal(emily.claimedScouts[0].name, 'Keira Polcari');
    assert.equal(emily.claimedScouts[1].name, 'Maddie Curran');
    assert.equal(emily.claimedScouts[2].name, 'Katie Kidd');

    assert.equal(emily.claimedRidersTo.length, 3);
    assert.equal(emily.claimedRidersTo[0].name, 'Keira Polcari');
    assert.equal(emily.claimedRidersTo[1].name, 'Maddie Curran');
    assert.equal(emily.claimedRidersTo[2].name, 'Katie Kidd');

    // Brad Hoover: adult Thomas mentioned before scout Owen
    const brad = result.enrichedDrivers.find((d) => d.name === 'Hoover, Brad');
    assert.equal(brad.claimedRidersTo.length, 2);
    assert.equal(brad.claimedRidersTo[0].name, 'Thomas Renno');
    assert.equal(brad.claimedRidersTo[0].type, 'adult');
    assert.equal(brad.claimedRidersTo[1].name, 'Owen Ayers');
    assert.equal(brad.claimedRidersTo[1].type, 'scout');
  });

  it('correctly matches compound surname with minor typo and discrete TO/FROM split without ambiguity (David Carrico & Morgan Di Pasqualucci)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Carrico, David',
        attending: 'Y',
        seats: 5,
        drivingToFrom: 'Both',
        comment: 'Returning sunday evening. TO: Sarah Carrico, Morgan Di Pasqulucci, Wendy Dong. FROM (Sunday): Open.',
      },
    ];

    const scouts = [
      { name: 'Carrico, Sarah', patrol: 'Dragon' },
      { name: 'Di Pasqualucci, Morgan', patrol: 'Falcon' },
      { name: 'Murray, Morgan', patrol: 'Dragon' },
      { name: 'Dong, Wendy', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Carrico, David', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    assert.equal(driver.cleanNote, 'Returning sunday evening');
    assert.equal(driver.claimedScoutsTo.length, 3);
    assert.equal(driver.claimedScoutsFrom.length, 0);

    const toNames = driver.claimedScoutsTo.map((s) => s.name);
    assert.ok(toNames.includes('Sarah Carrico'));
    assert.ok(toNames.includes('Morgan Di Pasqualucci'));
    assert.ok(toNames.includes('Wendy Dong'));

    // Zero ambiguity / clarifications needed
    assert.equal(result.clarificationsNeeded.length, 0);

    // Scout direction check
    const morgan = result.enrichedScouts.find((s) => s.name === 'Di Pasqualucci, Morgan');
    assert.equal(morgan.rideDirection, 'To');
    assert.equal(morgan.assignedDriverTo, 'Carrico, David');
    assert.equal(morgan.assignedDriverFrom, null);
    assert.equal(morgan.assignedDriver, 'Carrico, David');

    const sarah = result.enrichedScouts.find((s) => s.name === 'Carrico, Sarah');
    assert.equal(sarah.rideDirection, 'To');
    assert.equal(sarah.assignedDriverTo, 'Carrico, David');
    assert.equal(sarah.assignedDriverFrom, null);
  });

  it('correctly matches scout who shares first name with driver in full name comment (Olivia Nelson & Olivia Eng)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Nelson, Olivia',
        attending: 'Y',
        seats: 2,
        drivingToFrom: 'Both',
        comment: 'Driving myself, Matilda Nelson and Olivia Eng (TBD on space for others)',
      },
    ];

    const scouts = [
      { name: 'Nelson, Matilda', patrol: 'Dragon' },
      { name: 'Eng, Olivia', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Nelson, Olivia', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    assert.equal(driver.claimedScouts.length, 2);
    const claimed = driver.claimedScouts.map((s) => s.name);
    assert.ok(claimed.includes('Matilda Nelson'));
    assert.ok(claimed.includes('Olivia Eng'));
    assert.equal(result.clarificationsNeeded.length, 0);

    const oliviaScout = result.enrichedScouts.find((s) => s.name === 'Eng, Olivia');
    assert.equal(oliviaScout.assignedDriver, 'Nelson, Olivia');
    assert.equal(oliviaScout.rideStatus, 'confirmed');

    const matildaScout = result.enrichedScouts.find((s) => s.name === 'Nelson, Matilda');
    assert.equal(matildaScout.assignedDriver, 'Nelson, Olivia');
  });

  it('handles Scott Fukayama comment by matching confirmed scouts and flagging nickname surname as ambiguous (Ren Routt -> Adeline Routt)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Fukayama, Scott',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'Driving myself, Saya, and Ibuki Trickey, Ren Routt',
      },
    ];

    const scouts = [
      { name: 'Fukayama, Saya', patrol: 'Dragon' },
      { name: 'Trickey, Ibuki', patrol: 'Falcon' },
      { name: 'Routt, Adeline', patrol: 'Dragon' },
    ];

    const adults = [
      { name: 'Fukayama, Scott', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    // Saya Fukayama & Ibuki Trickey confirmed
    assert.equal(driver.claimedScouts.length, 2);
    const names = driver.claimedScouts.map((s) => s.name);
    assert.ok(names.includes('Saya Fukayama'));
    assert.ok(names.includes('Ibuki Trickey'));

    // Ren Routt flagged as ambiguous
    assert.equal(driver.ambiguousNotes.length, 1);
    const amb = driver.ambiguousNotes[0];
    assert.equal(amb.token, 'Ren Routt');
    assert.ok(amb.candidates.includes('Adeline Routt'));

    // Original comment order preserved in claimedRidersTo
    assert.equal(driver.claimedRidersTo.length, 3);
    assert.equal(driver.claimedRidersTo[0].name, 'Saya Fukayama');
    assert.equal(driver.claimedRidersTo[1].name, 'Ibuki Trickey');
    assert.equal(driver.claimedRidersTo[2].token, 'Ren Routt');
  });

  it('parses Stephen Robinson comment as unified with driver self-token and explicit 0 available', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Robinson, Stephen',
        attending: 'Y',
        seats: 2,
        drivingToFrom: 'Both',
        comment: 'TO and FROM (2 seats, driver and Mila, rest for family, 0 available)',
      },
    ];

    const scouts = [
      { name: 'Robinson, Mila', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Robinson, Stephen', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    // Mila Robinson confirmed for both legs
    assert.equal(driver.claimedScouts.length, 1);
    assert.equal(driver.claimedScouts[0].name, 'Mila Robinson');
    assert.equal(driver.claimedScoutsTo.length, 1);
    assert.equal(driver.claimedScoutsFrom.length, 1);

    // Capacity and open seats
    assert.equal(driver.toSeats, 1);
    assert.equal(driver.fromSeats, 1);
    assert.equal(driver.openSeats, 0);

    const mila = result.enrichedScouts.find((s) => s.name === 'Robinson, Mila');
    assert.equal(mila.assignedDriver, 'Robinson, Stephen');
    assert.ok(['confirmed', 'unique_first', 'family_match'].includes(mila.rideStatus));
  });

  it('parses Heather Tzortzis comment with non-attending roster members (Chris & Alina Tzortzis)', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Tzortzis, Heather',
        attending: 'Y',
        seats: 3,
        drivingToFrom: 'Both',
        comment: 'Heather, Chris & Alina',
      },
    ];

    // Neither Chris nor Alina is in the event attendees
    const scouts = [
      { name: 'Annis, Allison', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Tzortzis, Heather', leadership: 'Scoutmaster' },
    ];

    const rosterMembers = [
      { name: 'Tzortzis, Heather', isAdult: true, patrol: '' },
      { name: 'Tzortzis, Chris', isAdult: true, patrol: '' },
      { name: 'Tzortzis, Alina', isAdult: false, patrol: 'Falcon' },
    ];

    const result = parseDriverComments(drivers, scouts, adults, rosterMembers);
    const driver = result.enrichedDrivers[0];

    // Chris Tzortzis matched as adult rider
    assert.equal(driver.claimedAdults.length, 1);
    assert.equal(driver.claimedAdults[0], 'Chris Tzortzis');

    // Alina Tzortzis matched as non-attending scout rider
    assert.equal(driver.claimedScouts.length, 1);
    assert.equal(driver.claimedScouts[0].name, 'Alina Tzortzis');
    assert.equal(driver.claimedScouts[0].notAttending, true);

    // Enriched scouts should include Alina tagged as Not Attending
    const alina = result.enrichedScouts.find((s) => s.name === 'Tzortzis, Alina');
    assert.ok(alina);
    assert.equal(alina.attending, 'N');
    assert.equal(alina.assignedDriver, 'Tzortzis, Heather');
    assert.equal(alina.rideNote, 'Not Attending');
  });

  it('parses Trent Watkins comment preserving Alice Henderson and flagging repeated Madison as ambiguous', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Watkins, Trent',
        attending: 'Y',
        seats: 5,
        drivingToFrom: 'Both',
        comment: 'BOTH (4): Madison W.. Madison, Alice Henderson',
      },
    ];

    const scouts = [
      { name: 'Watkins, Madison', patrol: 'Dragon' },
      { name: 'Henderson, Alice', patrol: 'Falcon' },
      { name: 'Curran, Maddie', patrol: 'Gator' },
    ];

    const adults = [
      { name: 'Watkins, Trent', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);
    const driver = result.enrichedDrivers[0];

    assert.equal(driver.toSeats, 4);
    assert.equal(driver.fromSeats, 4);

    // Both Madison Watkins and Alice Henderson confirmed
    assert.equal(driver.claimedScoutsTo.length, 2);
    const toNames = driver.claimedScoutsTo.map((s) => s.name);
    assert.ok(toNames.includes('Madison Watkins'));
    assert.ok(toNames.includes('Alice Henderson'));

    // Repeated Madison flagged as ambiguous
    assert.equal(driver.ambiguousNotes.length, 1);
    assert.equal(driver.ambiguousNotes[0].token, 'Madison');
    assert.ok(driver.ambiguousNotes[0].candidates.includes('Madison Watkins'));

    // Order in claimedRidersTo strictly preserved
    assert.equal(driver.claimedRidersTo.length, 3);
    assert.equal(driver.claimedRidersTo[0].name, 'Madison Watkins');
    assert.equal(driver.claimedRidersTo[1].token, 'Madison');
    assert.equal(driver.claimedRidersTo[2].name, 'Alice Henderson');

    const alice = result.enrichedScouts.find((s) => s.name === 'Henderson, Alice');
    assert.equal(alice.assignedDriver, 'Watkins, Trent');
    assert.equal(alice.rideStatus, 'confirmed');
  });

  it('buildNameDictionary generates deterministic First L compact names without periods and handles compound surnames and disambiguation', async () => {
    const { buildNameDictionary } = await import('../server.js');

    const members = [
      { name: 'Haney, Aubrey P' },
      { name: 'Di Pasqualucci, Morgan' },
      { name: 'Carrico, Sarah' },
      { name: 'Chen, Sarah' },
      { name: 'Parsons, Julia' },
      { name: 'Renno, Thomas', isAdult: true },
    ];

    const dict = buildNameDictionary(members);

    // Aubrey P Haney -> Aubrey H (no period, middle initial ignored)
    const aubrey = dict.get('Haney, Aubrey P');
    assert.ok(aubrey);
    assert.equal(aubrey.compactName, 'Aubrey H');
    assert.equal(aubrey.displayName, 'Aubrey Haney');

    // Morgan Di Pasqualucci -> Morgan D (single initial D, compound surname)
    const morgan = dict.get('Di Pasqualucci, Morgan');
    assert.ok(morgan);
    assert.equal(morgan.compactName, 'Morgan D');
    assert.equal(morgan.displayName, 'Morgan Di Pasqualucci');

    // Julia Parsons -> Julia P (unique)
    const julia = dict.get('Parsons, Julia');
    assert.ok(julia);
    assert.equal(julia.compactName, 'Julia P');

    // Sarah Carrico and Sarah Chen -> collision on "Sarah C" -> disambiguate to full names
    const sarahCarrico = dict.get('Carrico, Sarah');
    const sarahChen = dict.get('Chen, Sarah');
    assert.ok(sarahCarrico);
    assert.ok(sarahChen);
    assert.equal(sarahCarrico.compactName, 'Sarah Carrico');
    assert.equal(sarahChen.compactName, 'Sarah Chen');

    // Thomas Renno has 'Tom' in tokens
    const tom = dict.get('Renno, Thomas');
    assert.ok(tom);
    assert.ok(tom.tokens.includes('Tom'));
  });
});

describe('Carpool Excel export unit test', () => {
  it('generates an Excel workbook with proper sections, headers, and pre-filled slots', async () => {
    const { buildCarpoolWorkbook } = await import('../excel-export.js');

    const mockData = {
      meta: {
        title: 'Mt. Lassen Campout',
        start: '10/10/2026 5:00 PM',
        end: '10/12/2026 11:00 AM',
        location: 'Mt. Lassen State Park',
      },
      stats: {
        totalDrivers: 2,
        totalSeatsOffered: 7,
        totalAttendingScouts: 5,
        assignedScoutsCount: 3,
        unassignedScoutsCount: 2,
        seatBalance: 2,
        adultRidersCount: 0,
      },
      drivers: [
        {
          name: 'Knudson, BJ',
          phone: '925-899-7663',
          seats: 4,
          comment: 'driving Iris, Julia',
          claimedScouts: [{ name: 'Iris Knudson' }, { name: 'Julia Parsons' }],
          drivingToFrom: 'Both',
          attending: 'Y',
        },
        {
          name: 'Bronson, Darren',
          phone: '415-722-4453',
          seats: 1,
          comment: 'leave Saturday night',
          claimedScouts: [{ name: 'Kyla Bronson' }],
          drivingToFrom: 'From',
          attending: 'Y',
        },
      ],
      scouts: [
        { name: 'Iris Knudson', patrol: 'Dragon', assignedDriver: 'Knudson, BJ', rideStatus: 'confirmed' },
        { name: 'Julia Parsons', patrol: 'Dragon', assignedDriver: 'Knudson, BJ', rideStatus: 'confirmed' },
        { name: 'Kyla Bronson', patrol: 'Falcon', assignedDriver: 'Bronson, Darren', rideStatus: 'confirmed' },
        { name: 'Charlie Brown', patrol: 'Gator', assignedDriver: null, rideStatus: 'unassigned' },
        { name: 'Lucy van Pelt', patrol: 'Gator', assignedDriver: null, rideStatus: 'unassigned' },
      ],
    };

    const workbook = await buildCarpoolWorkbook(mockData);
    assert.ok(workbook);

    // Verify all 4 sheets are present
    const carpoolSheet = workbook.getWorksheet('Carpool');
    const summarySheet = workbook.getWorksheet('Summary');
    const scoutSheet = workbook.getWorksheet('Scout roster');
    const adultSheet = workbook.getWorksheet('Adult roster');

    assert.ok(carpoolSheet, 'Carpool sheet should exist');
    assert.ok(summarySheet, 'Summary sheet should exist');
    assert.ok(scoutSheet, 'Scout roster sheet should exist');
    assert.ok(adultSheet, 'Adult roster sheet should exist');

    // Verify title and metadata
    assert.equal(carpoolSheet.getCell('A1').value, 'T402G carpool sheet');
    assert.equal(carpoolSheet.getCell('B2').value, 'Mt. Lassen Campout');

    // Verify BJ Knudson available passenger seats = 3 (4 total minus 1 driver)
    assert.equal(carpoolSheet.getCell('C27').value, 3);
    assert.equal(carpoolSheet.getCell('A27').value, 'Knudson, BJ');

    // Verify Data Validation dropdown on scout seat cell E27
    assert.equal(carpoolSheet.getCell('E27').dataValidation?.type, 'list');
    assert.ok(carpoolSheet.getCell('E27').dataValidation?.formulae[0].includes("'Scout roster'"));

    // Verify real math KPI formulas
    assert.equal(carpoolSheet.getCell('E6').value.formula, 'COUNTA(E27:M27)');
    assert.equal(carpoolSheet.getCell('E7').value.formula, 'E2-E6');
    assert.equal(carpoolSheet.getCell('E8').value.formula, 'SUM(C27:C27)-E2');

    // Verify boolean availability formula in column N (seat 1)
    assert.equal(carpoolSheet.getCell('N27').value.formula, 'IF($C27<N$25, FALSE, TRUE)');
    assert.equal(carpoolSheet.getCell('N27').value.result, true);

    // Verify Summary sheet has formulas referencing rosters and Carpool
    assert.ok(summarySheet.getCell('A2').value.formula.includes("'Scout roster'!A2"));
    assert.ok(summarySheet.getCell('B2').value.formula.includes("COUNTIF(Carpool!"));

    // Verify buffer generation
    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.length > 5000);
  });

  it('generates workbook with custom state and live coordinator edits', async () => {
    const { buildCarpoolWorkbook } = await import('../excel-export.js');

    const mockData = {
      meta: { title: 'Campout Test' },
      stats: {},
      drivers: [],
      scouts: [],
    };

    const customState = {
      toDrivers: [
        {
          name: 'Leader, Jane',
          phone: '925-555-1234',
          seats: 4,
          comment: 'leaving at 7am',
          riders: ['Scout, One', 'Scout, Two'],
        },
      ],
      fromDrivers: [],
      unassignedScouts: [{ name: 'Scout, Three', patrol: 'Dragon' }],
    };

    const workbook = await buildCarpoolWorkbook(mockData, null, customState);
    assert.ok(workbook);

    const sheet = workbook.getWorksheet('Carpool');
    assert.equal(sheet.getCell('A27').value, 'Leader, Jane');
    assert.equal(sheet.getCell('C27').value, 4);
    assert.equal(sheet.getCell('E27').value, 'Scout, One');
    assert.equal(sheet.getCell('F27').value, 'Scout, Two');
    // Open seat ready for coordinator
    assert.equal(sheet.getCell('G27').value, null);
  });
});

describe('Scout and roster enrichment unit test', () => {
  it('extracts swim test, BSA registration, and medical dates in computeRosterSummary', async () => {
    const { computeRosterSummary } = await import('../server.js');

    const csvContent = [
      'Adult,Name,Patrol,Cell Phone,Swim Level,Swim Date,BSA ID,BSA Registration Ends,Medical Part A,Medical Part B,Medical Part C',
      'N,"Annis, Allison",Gator,925-555-0101,Swimmer,8/23/2026,141713280,8/31/2027,8/17/2026,8/17/2026,4/17/2026',
      'Y,"Ayers, Elena",,925-555-0102,,,141553648,3/31/2027,,,',
    ].join('\n');

    const summary = computeRosterSummary(Buffer.from(csvContent, 'utf8'));
    assert.equal(summary.totalMembers, 2);
    assert.equal(summary.scoutsCount, 1);
    assert.equal(summary.adultsCount, 1);

    const scout = summary.membersByName.get('annis, allison');
    assert.ok(scout);
    assert.equal(scout.swimLevel, 'Swimmer');
    assert.equal(scout.swimDate, '8/23/2026');
    assert.equal(scout.bsaId, '141713280');
    assert.equal(scout.bsaRegistrationEnds, '8/31/2027');
    assert.equal(scout.medicalPartA, '8/17/2026');
    assert.equal(scout.medicalPartC, '4/17/2026');
  });

  it('preserves scout attendance comments and enriched fields through parseDriverComments', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Ayers, Elena',
        attending: 'Y',
        seats: 4,
        comment: 'driving Gwyneth',
      },
    ];

    const scouts = [
      {
        name: 'Ayers, Gwyneth',
        patrol: 'Sun Bear',
        comment: 'Leaving early at noon',
        permissionGiven: 'Yes',
        medicalNeeded: 'A B',
        bsaRegistered: 'Current',
        bsaId: '141553648',
        swimTest: 'Swimmer',
        swimDate: '6/26/2026',
      },
    ];

    const adults = [{ name: 'Ayers, Elena', leadership: 'Adult' }];

    const result = parseDriverComments(drivers, scouts, adults);
    const enriched = result.enrichedScouts.find((s) => s.name === 'Ayers, Gwyneth');
    assert.ok(enriched);
    assert.equal(enriched.comment, 'Leaving early at noon');
    assert.equal(enriched.medicalNeeded, 'A B');
    assert.equal(enriched.bsaRegistered, 'Current');
    assert.equal(enriched.swimTest, 'Swimmer');
    assert.equal(enriched.swimDate, '6/26/2026');
    assert.equal(enriched.assignedDriver, 'Ayers, Elena');
  });
});

describe('Tabular Cartesian Excel export unit test', () => {
  const sampleCarpoolData = {
    eventId: '1957',
    meta: {
      id: '1957',
      title: 'Lassen Volcanic Campout',
      location: 'Manzanita Lake Campground',
      start: '10/02/2026 7:00 AM',
      end: '10/04/2026 3:00 PM',
    },
    drivers: [
      {
        name: 'Clayshulte, Alison',
        phone: '925-555-0199',
        seats: 4, // 3 passenger seats
        attending: 'Y',
        drivingToFrom: 'Both',
        comment: 'Taking Anya and Evelyn',
        registeredVehicle: 'Subaru Outback 2022',
        claimedScoutsTo: ['Lavrinets, Anya', 'Adams, Evelyn'],
        claimedScoutsFrom: ['Lavrinets, Anya', 'Adams, Evelyn'],
        isCompliant: true,
      },
      {
        name: 'Kersten, David',
        phone: '925-555-0188',
        seats: 3, // 2 passenger seats
        attending: 'Y',
        drivingToFrom: 'To',
        comment: 'Driving TO only',
        registeredVehicle: 'Ford F-150',
        claimedScoutsTo: ['Kersten, Luke'],
        claimedScoutsFrom: [],
        isCompliant: false,
      },
    ],
    scouts: [
      {
        name: 'Lavrinets, Anya',
        patrol: 'Sun Bear',
        permissionGiven: 'Yes',
        medicalNeeded: 'None',
        parentNames: 'Olga Lavrinets',
        parentPhone: '925-555-1111',
        age: '13',
        grade: '8',
      },
      {
        name: 'Adams, Evelyn',
        patrol: 'Sun Bear',
        permissionGiven: 'Yes',
        medicalNeeded: 'A B',
        parentNames: 'Melanie Adams',
        parentPhone: '925-555-2222',
        age: '12',
        grade: '7',
      },
      {
        name: 'Kersten, Luke',
        patrol: 'Gator',
        permissionGiven: 'Yes',
        medicalNeeded: 'None',
        parentNames: 'David Kersten',
        parentPhone: '925-555-0188',
        age: '14',
        grade: '9',
      },
      {
        name: 'Unassigned, Sam',
        patrol: 'Gator',
        permissionGiven: 'No',
        medicalNeeded: 'B',
        parentNames: 'Alex Unassigned',
        parentPhone: '925-555-3333',
        age: '11',
        grade: '6',
      },
    ],
    adults: [],
  };

  it('generates a tabular Excel workbook with standard default columns (excluding comments)', async () => {
    const { buildTabularWorkbook, STANDARD_TABULAR_COLUMNS } = await import('../excel-export.js');
    const workbook = await buildTabularWorkbook(sampleCarpoolData, null, null, {
      columns: STANDARD_TABULAR_COLUMNS,
      splitTripLegs: true,
      includeOpenSeats: true,
      includeUnassigned: true,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    assert.ok(sheet, 'Should create Carpool Tabular worksheet');

    // Headers in row 1
    const row1 = sheet.getRow(1);
    assert.equal(row1.getCell(1).value, 'Trip Leg');
    assert.equal(row1.getCell(2).value, 'Driver Name');
    assert.equal(row1.getCell(STANDARD_TABULAR_COLUMNS.length).value, 'Medical Forms Needed');

    // Verify comments are not in standard columns
    const headerValues = [];
    row1.eachCell(cell => headerValues.push(cell.value));
    assert.ok(!headerValues.includes('Driver Comment'), 'Standard default must not include Driver Comment');
    assert.ok(!headerValues.includes('Rider Attendance Comment'), 'Standard default must not include Rider Attendance Comment');
  });

  it('generates discrete TO and FROM rows when splitTripLegs is true', async () => {
    const { buildTabularWorkbook } = await import('../excel-export.js');
    const workbook = await buildTabularWorkbook(sampleCarpoolData, null, null, {
      splitTripLegs: true,
      includeOpenSeats: true,
      includeUnassigned: true,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    const tripLegColIdx = 1; // Trip Leg is first column in default

    const tripLegs = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        tripLegs.push(row.getCell(tripLegColIdx).value);
      }
    });

    assert.ok(tripLegs.includes('TO'), 'Should have TO rows');
    assert.ok(tripLegs.includes('FROM'), 'Should have FROM rows');
    assert.ok(!tripLegs.includes('Both'), 'Should not have "Both" rows when splitTripLegs is true');
  });

  it('coalesces identical rides into "Both" when splitTripLegs is false', async () => {
    const { buildTabularWorkbook } = await import('../excel-export.js');
    const workbook = await buildTabularWorkbook(sampleCarpoolData, null, null, {
      splitTripLegs: false,
      includeOpenSeats: true,
      includeUnassigned: true,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    const tripLegs = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        tripLegs.push(row.getCell(1).value);
      }
    });

    assert.ok(tripLegs.includes('Both'), 'Should have "Both" rows when splitTripLegs is false');
    assert.ok(tripLegs.includes('TO only'), 'Should have "TO only" for Kersten David who only drives TO');
  });

  it('generates open seat rows and unassigned scout rows', async () => {
    const { buildTabularWorkbook } = await import('../excel-export.js');
    const workbook = await buildTabularWorkbook(sampleCarpoolData, null, null, {
      columns: ['trip_leg', 'adult_name', 'rider_name'],
      splitTripLegs: true,
      includeOpenSeats: true,
      includeUnassigned: true,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    const riderNames = [];
    const driverNames = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        driverNames.push(row.getCell(2).value);
        riderNames.push(row.getCell(3).value);
      }
    });

    assert.ok(riderNames.includes('[Open Seat]'), 'Should contain [Open Seat] rows for unused capacity');
    assert.ok(driverNames.includes('(Unassigned)'), 'Should contain (Unassigned) rows for unassigned scouts');
    assert.ok(riderNames.some(r => r && r.includes('Unassigned, Sam')), 'Sam Unassigned should appear in unassigned rows');
  });

  it('applies custom working state from coordinator page', async () => {
    const { buildTabularWorkbook } = await import('../excel-export.js');

    const customState = {
      title: 'Custom Lassen 2026',
      toDrivers: [
        {
          name: 'Clayshulte, Alison',
          seats: 3,
          riders: [{ name: 'Custom, ScoutA', type: 'scout' }],
        },
      ],
      fromDrivers: [
        {
          name: 'Clayshulte, Alison',
          seats: 3,
          riders: [{ name: 'Custom, ScoutA', type: 'scout' }],
        },
      ],
      unassignedScouts: [],
    };

    const workbook = await buildTabularWorkbook(sampleCarpoolData, null, customState, {
      columns: ['trip_leg', 'adult_name', 'rider_name'],
      splitTripLegs: false,
      includeOpenSeats: false,
      includeUnassigned: false,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    const riderNames = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        riderNames.push(row.getCell(3).value);
      }
    });

    assert.ok(riderNames.includes('Custom, ScoutA'), 'Should export riders from customState');
  });

  it('resolves scout attributes on driver rows and prevents duplicate unassigned rows when names use "First Last"', async () => {
    const { buildTabularWorkbook } = await import('../excel-export.js');

    const testCarpool = {
      meta: { title: 'Lassen Volcanic 2026' },
      drivers: [
        {
          name: 'Clayshulte, Alison',
          attending: 'Y',
          seats: 4,
          drivingToFrom: 'Both',
          // Driver comment parsing yields First Last or objects with originalName
          claimedScoutsTo: [
            { name: 'Anya Lavrinets', originalName: 'Lavrinets, Anya', status: 'confirmed' },
            { name: 'Evelyn Adams', originalName: 'Adams, Evelyn', status: 'confirmed' },
          ],
          claimedScoutsFrom: [
            { name: 'Anya Lavrinets', originalName: 'Lavrinets, Anya', status: 'confirmed' },
            { name: 'Evelyn Adams', originalName: 'Adams, Evelyn', status: 'confirmed' },
          ],
        },
      ],
      scouts: [
        {
          name: 'Lavrinets, Anya',
          patrol: 'Sun Bear',
          parentNames: 'Olga Lavrinets',
          parentPhone: '925-555-1111',
          age: '13',
          grade: '8',
          rank: 'First Class',
        },
        {
          name: 'Adams, Evelyn',
          patrol: 'Sun Bear',
          parentNames: 'Melanie Adams',
          parentPhone: '925-555-2222',
          age: '12',
          grade: '7',
          rank: 'Second Class',
        },
        {
          name: 'Unassigned, Sam',
          patrol: 'Gator',
          parentNames: 'Alex Unassigned',
          parentPhone: '925-555-3333',
          age: '11',
          grade: '6',
          rank: 'Scout',
        },
      ],
      adults: [],
    };

    const workbook = await buildTabularWorkbook(testCarpool, null, null, {
      columns: [
        'trip_leg',
        'adult_name',
        'rider_name',
        'rider_patrol',
        'rider_parent_names',
        'rider_parent_phone',
        'rider_age',
        'rider_grade',
        'rider_rank',
      ],
      splitTripLegs: true,
      includeOpenSeats: true,
      includeUnassigned: true,
    });

    const sheet = workbook.getWorksheet('Carpool Tabular');
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        rows.push({
          leg: row.getCell(1).value,
          driver: row.getCell(2).value,
          rider: row.getCell(3).value,
          patrol: row.getCell(4).value,
          parentNames: row.getCell(5).value,
          parentPhone: row.getCell(6).value,
          age: row.getCell(7).value,
          grade: row.getCell(8).value,
          rank: row.getCell(9).value,
        });
      }
    });

    // 1. Check Anya on driver row
    const anyaDriverRow = rows.find(r => r.driver && r.driver.includes('Clayshulte') && r.rider.includes('Lavrinets, Anya'));
    assert.ok(anyaDriverRow, 'Anya Lavrinets must appear on a driver row');
    assert.equal(anyaDriverRow.patrol, 'Sun Bear', 'Patrol must be populated on driver row');
    assert.equal(anyaDriverRow.parentNames, 'Olga Lavrinets', 'Parent names must be populated on driver row');
    assert.equal(anyaDriverRow.parentPhone, '925-555-1111', 'Parent phone must be populated on driver row');
    assert.equal(anyaDriverRow.age, '13', 'Age must be populated on driver row');
    assert.equal(anyaDriverRow.grade, '8', 'Grade must be populated on driver row');
    assert.equal(anyaDriverRow.rank, 'First Class', 'Rank must be populated on driver row');

    // 2. Check Evelyn on driver row
    const evelynDriverRow = rows.find(r => r.driver && r.driver.includes('Clayshulte') && r.rider.includes('Adams, Evelyn'));
    assert.ok(evelynDriverRow, 'Evelyn Adams must appear on a driver row');
    assert.equal(evelynDriverRow.patrol, 'Sun Bear');
    assert.equal(evelynDriverRow.parentNames, 'Melanie Adams');

    // 3. Check unassigned rows
    const unassignedRows = rows.filter(r => r.driver === '(Unassigned)');
    assert.equal(unassignedRows.length, 2, 'Should have exactly 2 unassigned rows (1 for TO, 1 for FROM for Sam Unassigned)');
    unassignedRows.forEach(ur => {
      assert.ok(ur.rider.includes('Unassigned, Sam'), 'Only Sam Unassigned should appear in unassigned rows');
      assert.ok(!ur.rider.includes('Lavrinets'), 'Assigned scout Anya Lavrinets must NOT appear in unassigned rows');
      assert.ok(!ur.rider.includes('Adams'), 'Assigned scout Evelyn Adams must NOT appear in unassigned rows');
    });
  });
});