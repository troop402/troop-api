import express from 'express';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const cache = {
  data: null,
  timestamp: 0,
  ttlMs: 12 * 60 * 60 * 1000,
};

let activeFetchPromise = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.status(200).send('OK');
});

function isCacheFresh() {
  return Boolean(cache.data) && Date.now() - cache.timestamp < cache.ttlMs;
}

function sendDownload(res, buffer, cacheHit) {
  res.setHeader('X-Cache-Hit', String(cacheHit));
  res.setHeader('Content-Disposition', 'attachment; filename="troop_roster.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buffer);
}

function makeClient() {
  const cookieJar = new CookieJar();

  return gotScraping.extend({
    cookieJar,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
  });
}

async function fetchRosterFromTroopWebHost({ troopUrl, username, password }) {
  if (!troopUrl || !username || !password) {
    throw new Error('Missing troopUrl, username, or password.');
  }

  const client = makeClient();
  const rootUrl = troopUrl.replace(/\/Index\.htm$/i, '');

  const homeResponse = await client.get(`${rootUrl}/Index.htm`);
  const html = typeof homeResponse.body === 'string' ? homeResponse.body : String(homeResponse.body ?? '');

  if (!html) {
    throw new Error('Unable to load TroopWebHost landing page.');
  }

  const $ = cheerio.load(html);
  const loginPayload = {};

  $('form input').each((_, element) => {
    const name = $(element).attr('name');
    if (!name) {
      return;
    }

    loginPayload[name] = $(element).attr('value') || '';
  });

  const userInputName = $('input[type="text"][name*="User" i]').attr('name') || 'txtUser';
  const passInputName = $('input[type="password"]').attr('name') || 'txtPassword';
  const submitName = $('input[type="submit"][value*="Log On" i]').attr('name') || 'btnLogOn';

  loginPayload[userInputName] = username;
  loginPayload[passInputName] = password;
  loginPayload[submitName] = 'Log On';

  const formAction = $('form').attr('action') || 'Index.htm';
  const postUrl = formAction.startsWith('http') ? formAction : `${rootUrl}/${formAction}`;

  await client.post(postUrl, {
    form: loginPayload,
    followRedirect: true,
    headers: {
      Referer: `${rootUrl}/Index.htm`,
    },
  });

  const reportUrl = `${rootUrl}/FormReport.aspx?Menu_Item_ID=45897&Stack=1&ReportFormat=XLS`;
  const reportResponse = await client.get(reportUrl, {
    responseType: 'buffer',
    headers: {
      Referer: `${rootUrl}/Index.htm`,
    },
  });

  const reportBody = reportResponse.body ?? reportResponse.rawBody;
  const reportBuffer = Buffer.isBuffer(reportBody)
    ? reportBody
    : Buffer.from(reportBody ?? '');

  const contentType = String(reportResponse.headers['content-type'] || '');

  if (reportBuffer.length === 0 || contentType.includes('text/html')) {
    throw new Error('Authentication failed or the export could not be retrieved.');
  }

  return reportBuffer;
}

app.post('/api/export-roster', async (req, res) => {
  const { troopUrl, username, password, forceRefresh } = req.body;

  if (!troopUrl || !username || !password) {
    return res.status(400).json({ error: 'Missing troopUrl, username, or password.' });
  }

  if (!forceRefresh && isCacheFresh()) {
    return sendDownload(res, cache.data, true);
  }

  if (activeFetchPromise) {
    try {
      const result = await activeFetchPromise;
      return sendDownload(res, result, false);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Scrape failed.' });
    }
  }

  try {
    activeFetchPromise = fetchRosterFromTroopWebHost({ troopUrl, username, password });
    const result = await activeFetchPromise;
    cache.data = result;
    cache.timestamp = Date.now();

    return sendDownload(res, result, false);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Scrape failed.' });
  } finally {
    activeFetchPromise = null;
  }
});

export { app };

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
