import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { app, authenticateTroopWebHost, downloadRosterExport } from '../server.js';

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
});