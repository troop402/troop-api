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
});