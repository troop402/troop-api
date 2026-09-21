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

describe('TroopWebHost integration', () => {
  it('downloads the configured roster export', async () => {
    const response = await fetch(`${baseUrl}/api/export-roster`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /spreadsheetml\.sheet/);
    assert.match(response.headers.get('content-disposition') || '', /attachment/);
    assert.ok(body.length > 0);
    assert.equal(body.subarray(0, 2).toString(), 'PK');
  });
});