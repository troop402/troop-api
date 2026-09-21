import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { app, authenticateTroopWebHost } from '../server.js';

let server;
let baseUrl;

before(() => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
}));

describe('TroopWebHost integration', () => {
  it('authenticates with the configured TroopWebHost account', async () => {
    const session = await authenticateTroopWebHost({
      troopUrl: process.env.TWH_TROOP_URL,
      username: process.env.TWH_USERNAME,
      password: process.env.TWH_PASSWORD,
    });
    const body = String(session.authenticatedResponse.body ?? '');

    assert.equal(session.authenticatedResponse.statusCode, 200);
    assert.match(body, /Log Off/i);
  });

  it('downloads the configured roster export through the API', async () => {
    const response = await fetch(`${baseUrl}/api/export-roster`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const errorText = body.toString('utf8').slice(0, 500);
      assert.fail(`TroopWebHost export failed with HTTP ${response.status}: ${errorText}`);
    }

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/csv/i);
    assert.match(response.headers.get('content-disposition') || '', /troop_roster\.csv/);
    assert.ok(body.length > 0);

    if (process.env.TWH_EXPORT_OUTPUT_PATH) {
      await writeFile(process.env.TWH_EXPORT_OUTPUT_PATH, body);
    }
  });

  it('returns roster summary statistics', async () => {
    const response = await fetch(`${baseUrl}/api/roster/summary`, {
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200);
    const data = await response.json();

    assert.ok(typeof data.totalMembers === 'number' && data.totalMembers > 0);
    assert.ok(typeof data.scoutsCount === 'number');
    assert.ok(typeof data.adultsCount === 'number');
    assert.equal(data.totalMembers, data.scoutsCount + data.adultsCount);
    assert.ok(data.cachedAt);
  });

  it('retrieves upcoming troop events and carpool details', async () => {
    const eventsResponse = await fetch(`${baseUrl}/api/events?days=120`, {
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(eventsResponse.status, 200);
    const eventsData = await eventsResponse.json();

    assert.ok(Array.isArray(eventsData.events));
    assert.ok(eventsData.events.length > 0, 'Should find at least one event in 120 days');

    const firstEvent = eventsData.events[0];
    assert.ok(firstEvent.id);
    assert.ok(firstEvent.title);
    assert.ok(typeof firstEvent.isCarpoolCandidate === 'boolean');

    // Test carpool endpoint for the first event
    const carpoolResponse = await fetch(`${baseUrl}/api/events/${firstEvent.id}/carpool`, {
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(carpoolResponse.status, 200);
    const carpoolData = await carpoolResponse.json();

    assert.equal(carpoolData.eventId, firstEvent.id);
    assert.ok(carpoolData.stats);
    assert.ok(typeof carpoolData.stats.totalSeatsOffered === 'number');
    assert.ok(typeof carpoolData.stats.totalAttendingScouts === 'number');
    assert.ok(typeof carpoolData.stats.assignedScoutsCount === 'number');
    assert.ok(typeof carpoolData.stats.unassignedScoutsCount === 'number');
    assert.ok(typeof carpoolData.stats.totalOpenSeats === 'number');
    assert.ok(typeof carpoolData.stats.seatBalance === 'number');
    assert.ok(Array.isArray(carpoolData.drivers));
    assert.ok(Array.isArray(carpoolData.scouts));
    assert.ok(Array.isArray(carpoolData.adults));

    if (carpoolData.drivers.length > 0) {
      assert.ok(Array.isArray(carpoolData.drivers[0].claimedScouts));
      assert.ok(Array.isArray(carpoolData.drivers[0].claimedAdults));
      assert.ok(typeof carpoolData.drivers[0].openSeats === 'number');
    }
    if (carpoolData.scouts.length > 0) {
      assert.ok('assignedDriver' in carpoolData.scouts[0]);
    }
  });
});