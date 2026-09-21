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
  res.setHeader('Content-Disposition', 'attachment; filename="troop_roster.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
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

function getTroopWebHostConfig() {
  const { TWH_TROOP_URL: troopUrl, TWH_USERNAME: username, TWH_PASSWORD: password } = process.env;

  if (!troopUrl || !username || !password) {
    throw new Error('TroopWebHost environment variables are not configured.');
  }

  return { troopUrl, username, password };
}

function getTroopWebHostRootUrl(troopUrl) {
  const url = new URL(troopUrl);
  const pathname = url.pathname
    .replace(/\/Index\.htm(?:l)?$/i, '')
    .replace(/\/+$/, '');

  return `${url.origin}${pathname}`;
}

async function authenticateTroopWebHost({ troopUrl, username, password }) {
  if (!troopUrl || !username || !password) {
    throw new Error('Missing troopUrl, username, or password.');
  }

  const client = makeClient();
  const rootUrl = getTroopWebHostRootUrl(troopUrl);

  const homeResponse = await client.get(`${rootUrl}/Index.htm`);
  let html = typeof homeResponse.body === 'string' ? homeResponse.body : String(homeResponse.body ?? '');

  if (!html) {
    throw new Error('Unable to load TroopWebHost landing page.');
  }

  let $ = cheerio.load(html);
  let loginResponse = homeResponse;

  if ($('form').length === 0) {
    const redirectResponse = await client.get(`${rootUrl}/Redirect.htm`);
    const $redirect = cheerio.load(String(redirectResponse.body ?? ''));
    const redirectAction = $redirect('form').attr('action');
    if (!redirectAction) {
      throw new Error('TroopWebHost landing page did not provide a login redirect.');
    }

    const loginUrl = new URL(redirectAction, redirectResponse.url).toString();
    loginResponse = await client.get(loginUrl);
    html = typeof loginResponse.body === 'string'
      ? loginResponse.body
      : String(loginResponse.body ?? '');
    $ = cheerio.load(html);
  }

  const loginForm = $('form').first();
  if (loginForm.length === 0) {
    throw new Error('TroopWebHost login form was not found.');
  }

  const loginPayload = {};

  loginForm.find('input').each((_, element) => {
    const name = $(element).attr('name');
    if (!name) {
      return;
    }

    loginPayload[name] = $(element).attr('value') || '';
  });

  const userInputName = loginForm.find('input[type="text"][name*="User" i]').attr('name') || 'txtUser';
  const passInputName = loginForm.find('input[type="password"]').attr('name') || 'txtPassword';

  loginPayload[userInputName] = username;
  loginPayload[passInputName] = password;
  loginPayload.Selected_Action = 'login';
  loginPayload.Selected_Button_ID = loginForm.find('input[name="login"]').attr('id') || 'login';

  const formAction = loginForm.attr('action') || loginResponse.url;
  const postUrl = new URL(formAction, loginResponse.url).toString();

  const loginPostResponse = await client.post(postUrl, {
    form: loginPayload,
    followRedirect: false,
    headers: {
      Referer: `${rootUrl}/Index.htm`,
    },
  });

  if (loginPostResponse.statusCode >= 300 && loginPostResponse.statusCode < 400) {
    const redirectUrl = loginPostResponse.headers.location;
    if (!redirectUrl) {
      throw new Error('TroopWebHost login did not provide a redirect.');
    }

    const authenticatedResponse = await client.get(new URL(redirectUrl, postUrl).toString(), {
      followRedirect: false,
    });

    return { client, rootUrl, loginUrl: authenticatedResponse.url, authenticatedResponse };
  }

  return { client, rootUrl, loginUrl: loginResponse.url, authenticatedResponse: loginPostResponse };
}

async function downloadRosterExport({ client, rootUrl, loginUrl }) {
  let lastError;

  for (const format of ['CSV', 'XLS']) {
    try {
      const reportUrl = new URL(
        `/FormReport.aspx?Menu_Item_ID=45897&Stack=1&ReportFormat=${format}`,
        loginUrl,
      ).toString();
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

      if (
        reportResponse.statusCode >= 200
        && reportResponse.statusCode < 300
        && reportBuffer.length > 0
        && !contentType.includes('text/html')
      ) {
        return reportBuffer;
      }

      lastError = new Error(`TroopWebHost returned an unusable ${format} export response.`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'Authentication failed or the export could not be retrieved.');
}

async function fetchRosterFromTroopWebHost(config) {
  const session = await authenticateTroopWebHost(config);
  return downloadRosterExport(session);
}

app.post('/api/export-roster', async (req, res) => {
  const { forceRefresh } = req.body;

  let troopWebHostConfig;
  try {
    troopWebHostConfig = getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
    activeFetchPromise = fetchRosterFromTroopWebHost(troopWebHostConfig);
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

export { app, authenticateTroopWebHost, downloadRosterExport };

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
