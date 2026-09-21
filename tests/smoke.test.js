import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { app } from '../server.js';

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
        headers: { 'content-type': 'application/json' },
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
      response = await fetch(`${baseUrl}/api/roster/summary`);
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
      response = await fetch(`${baseUrl}/api/events?days=30`);
    } finally {
      Object.assign(process.env, environment);
    }

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'TroopWebHost environment variables are not configured.',
    });
  });

  it('rejects invalid event ID for carpool endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool`);

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

  it('redirects /manager to /manager.html', async () => {
    const response = await fetch(`${baseUrl}/manager`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/manager.html');
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

    // Check Elena's vehicle
    const elena = result.enrichedDrivers.find((d) => d.name === 'Ayers, Elena');
    assert.equal(elena.claimedScouts.length, 3);
    assert.equal(elena.openSeats, 1);

    // Check Heather's vehicle with explicit "and 2 more"
    const heather = result.enrichedDrivers.find((d) => d.name === 'Tzortzis, Heather');
    assert.equal(heather.claimedScouts.length, 1);
    assert.equal(heather.claimedAdults.length, 1);
    assert.equal(heather.openSeats, 2);

    // Check Brad's vehicle (no comment)
    const brad = result.enrichedDrivers.find((d) => d.name === 'Hoover, Brad');
    assert.equal(brad.openSeats, 4);

    // Check scout ride status
    const allison = result.enrichedScouts.find((s) => s.name === 'Annis, Allison');
    assert.equal(allison.assignedDriver, 'Ayers, Elena');

    const john = result.enrichedScouts.find((s) => s.name === 'Smith, John');
    assert.equal(john.assignedDriver, null);
  });
});