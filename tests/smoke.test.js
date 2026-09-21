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

  it('rejects an export request with missing credentials', async () => {
    const response = await fetch(`${baseUrl}/api/export-roster`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ troopUrl: 'https://example.com' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Missing troopUrl, username, or password.',
    });
  });
});