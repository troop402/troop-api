import express from 'express';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { buildCarpoolWorkbook, buildTabularWorkbook } from './excel-export.js';

try {
  process.loadEnvFile?.();
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3080;

// Security & Authentication Configuration
const TROOP_APP_KEY = process.env.TROOP_APP_KEY || 'troop402-app-access';
const COORDINATOR_PASSWORD = process.env.COORDINATOR_PASSWORD;

if (!COORDINATOR_PASSWORD) {
  if (process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)) {
    process.env.COORDINATOR_PASSWORD = 'test-coordinator-password';
  } else {
    console.error('FATAL ERROR: COORDINATOR_PASSWORD environment variable is not set.');
    console.error('Please define COORDINATOR_PASSWORD in your .env file or environment variables before starting the server.');
    process.exit(1);
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.COORDINATOR_PASSWORD || 'troop402-session-secret-salt';
const COORDINATOR_IDLE_TIMEOUT_MINUTES = process.env.COORDINATOR_IDLE_TIMEOUT_MINUTES ? parseFloat(process.env.COORDINATOR_IDLE_TIMEOUT_MINUTES) : null;
const COORDINATOR_IDLE_TIMEOUT_MS = COORDINATOR_IDLE_TIMEOUT_MINUTES && !isNaN(COORDINATOR_IDLE_TIMEOUT_MINUTES)
  ? Math.round(COORDINATOR_IDLE_TIMEOUT_MINUTES * 60 * 1000)
  : parseInt(process.env.COORDINATOR_IDLE_TIMEOUT_MS || process.env.COORDINATOR_SESSION_TIMEOUT_MS || '1500000', 10); // default 25 minutes idle
const COORDINATOR_MAX_SESSION_HOURS = process.env.COORDINATOR_MAX_SESSION_HOURS ? parseFloat(process.env.COORDINATOR_MAX_SESSION_HOURS) : null;
const COORDINATOR_MAX_SESSION_MS = COORDINATOR_MAX_SESSION_HOURS && !isNaN(COORDINATOR_MAX_SESSION_HOURS)
  ? Math.round(COORDINATOR_MAX_SESSION_HOURS * 3600 * 1000)
  : parseInt(process.env.COORDINATOR_MAX_SESSION_MS || '86400000', 10); // default 24 hours absolute max
const COORDINATOR_SESSION_TIMEOUT_MS = COORDINATOR_IDLE_TIMEOUT_MS; // Backwards-compatible alias
const VIEWER_SESSION_TIMEOUT_MS = parseInt(process.env.VIEWER_SESSION_TIMEOUT_MS || '86400000', 10); // default 24 hours
const CARPOOL_CACHE_TTL_MS = process.env.CARPOOL_CACHE_TTL_MS !== undefined ? parseInt(process.env.CARPOOL_CACHE_TTL_MS, 10) : 0;

function createSignedToken(payload) {
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

function verifySignedToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, signature] = parts;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expSigBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }
    if (payload.authAt && (Date.now() - payload.authAt > COORDINATOR_MAX_SESSION_MS)) {
      return null; // Exceeded absolute max session duration (e.g. 24 hours)
    }
    return payload;
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token).trim();
  }
  return null;
}

// Role-Based Access Control Middleware
function requireRole(requiredRole = 'viewer') {
  return (req, res, next) => {
    const token = extractBearerToken(req);
    if (token) {
      const payload = verifySignedToken(token);
      if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired session token.' });
      }
      if (requiredRole === 'coordinator' && payload.role !== 'coordinator') {
        return res.status(403).json({ error: 'Forbidden: Coordinator privileges required.' });
      }
      req.user = payload;
      if (payload.role === 'coordinator') {
        req.coordinator = payload;
      }
      return next();
    }

    // Support legacy x-troop-key or ?key= parameter for viewer access
    if (requiredRole === 'viewer') {
      const expectedKey = process.env.TROOP_APP_KEY || TROOP_APP_KEY;
      const providedKey = req.headers['x-troop-key'] || req.query.key;
      if (providedKey && providedKey === expectedKey) {
        req.user = { role: 'viewer', exp: null };
        return next();
      }
    }

    return res.status(401).json({ error: 'Authentication token required.' });
  };
}

const requireViewerAuth = requireRole('viewer');
const requireCoordinatorAuth = requireRole('coordinator');
const requireAppAuth = requireViewerAuth; // Alias for consistency

const cache = {
  rosterBuffer: null,
  rosterSummary: null,
  rosterTimestamp: 0,
  rosterTtlMs: 12 * 60 * 60 * 1000, // 12 hours

  events: null,
  eventsTimestamp: 0,
  eventsTtlMs: 2 * 60 * 60 * 1000, // 2 hours

  carpoolByEventId: new Map(), // in-memory carpool cache
  carpoolTtlMs: CARPOOL_CACHE_TTL_MS, // 0 = live queries; >0 = configurable TTL in ms

  adultTrainingMap: null,
  adultTrainingTimestamp: 0,
  adultTrainingTtlMs: 2 * 60 * 60 * 1000, // 2 hours
};

let activeRosterPromise = null;
let activeAdultTrainingPromise = null;
let activeEventsPromise = null;
const activeCarpoolPromises = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/healthz', '/api/health'], (_req, res) => {
  res.status(200).send('OK');
});

function isRosterCacheFresh() {
  return Boolean(cache.rosterBuffer) && Date.now() - cache.rosterTimestamp < cache.rosterTtlMs;
}

function parseCsv(text) {
  const lines = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const cleanText = (text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < cleanText.length; i++) {
    const c = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cell.trim());
        cell = '';
      } else if (c === '\r' && next === '\n') {
        row.push(cell.trim());
        lines.push(row);
        row = [];
        cell = '';
        i++;
      } else if (c === '\n' || c === '\r') {
        row.push(cell.trim());
        lines.push(row);
        row = [];
        cell = '';
      } else {
        cell += c;
      }
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.trim());
    lines.push(row);
  }

  if (lines.length === 0) return [];

  const headers = lines[0].map((h) => h.replace(/^["']|["']$/g, '').trim());
  const records = [];

  for (let r = 1; r < lines.length; r++) {
    const rData = lines[r];
    if (rData.length === 1 && !rData[0]) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = rData[c] !== undefined ? rData[c] : '';
    }
    records.push(obj);
  }

  return records;
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

function computeRosterSummary(csvBuffer) {
  const text = csvBuffer.toString('utf8');
  const records = parseCsv(text);

  let adultsCount = 0;
  let scoutsCount = 0;
  const membersByName = new Map();

  for (const row of records) {
    const isAdult = String(row.Adult || '').trim().toUpperCase() === 'Y';
    if (isAdult) {
      adultsCount++;
    } else {
      scoutsCount++;
    }

    const name = String(row.Name || '').trim();
    if (name) {
      const parent1 = (row['Emergency Contact 1'] || '').trim();
      const parent2 = (row['Emergency Contact 2'] || '').trim();
      const parentPhone1 = (row['Emergency Contact 1 Phone'] || '').trim();
      const parentPhone2 = (row['Emergency Contact 2 Phone'] || '').trim();

      const parentNames = [parent1, parent2].filter(Boolean).join(' / ');
      const parentPhone = [parentPhone1, parentPhone2].filter(Boolean).join(' / ');

      membersByName.set(name.toLowerCase(), {
        name,
        isAdult,
        leadership: row.Leadership || '',
        patrol: row.Patrol || '',
        rank: row.Rank || '',
        age: row.Age || '',
        grade: row.Grade || '',
        phone: row['Cell Phone'] || row['Home Phone'] || '',
        email: row.Email || '',
        seatBelts: parseInt(row['Seat Belts'], 10) || 0,
        vehicle: row['Make/Model/Year'] || '',
        licensePlate: row['License Plate'] || '',
        driverLicense: row["Driver's License"] || '',
        parentNames,
        parentPhone,
        emergencyContact1: parent1,
        emergencyContact1Phone: parentPhone1,
        emergencyContact2: parent2,
        emergencyContact2Phone: parentPhone2,
        allergies: row.Allergies || '',
        dietary: row['Dietary Restrictions'] || '',
        swimLevel: row['Swim Level'] || '',
        swimDate: row['Swim Date'] || '',
        bsaId: row['BSA ID'] || '',
        bsaRegistrationEnds: row['BSA Registration Ends'] || '',
        medicalPartA: row['Medical Part A'] || '',
        medicalPartB: row['Medical Part B'] || '',
        medicalPartC: row['Medical Part C'] || '',
      });
    }
  }

  return {
    totalMembers: records.length,
    scoutsCount,
    adultsCount,
    membersByName,
  };
}

async function getRosterData(forceRefresh = false) {
  if (!forceRefresh && isRosterCacheFresh() && cache.rosterSummary) {
    return {
      buffer: cache.rosterBuffer,
      summary: cache.rosterSummary,
      cachedAt: new Date(cache.rosterTimestamp).toISOString(),
      fresh: true,
    };
  }

  if (activeRosterPromise) {
    return activeRosterPromise;
  }

  activeRosterPromise = (async () => {
    const config = getTroopWebHostConfig();
    const buffer = await fetchRosterFromTroopWebHost(config);
    const summary = computeRosterSummary(buffer);

    cache.rosterBuffer = buffer;
    cache.rosterSummary = summary;
    cache.rosterTimestamp = Date.now();

    return {
      buffer,
      summary,
      cachedAt: new Date(cache.rosterTimestamp).toISOString(),
      fresh: false,
    };
  })();

  try {
    return await activeRosterPromise;
  } finally {
    activeRosterPromise = null;
  }
}

function evaluateStateTrainingStatus(trainingInfo) {
  if (!trainingInfo) return 'None';
  if (trainingInfo.hasAb506 && trainingInfo.hasLiveScan) {
    return 'Current';
  }
  if (trainingInfo.hasAb506 || trainingInfo.hasLiveScan) {
    return 'Incomplete';
  }
  return 'None';
}

async function getAdultTrainingData(forceRefresh = false) {
  const isTrainingFresh =
    Boolean(cache.adultTrainingMap) &&
    Date.now() - cache.adultTrainingTimestamp < cache.adultTrainingTtlMs;

  if (!forceRefresh && isTrainingFresh) {
    return cache.adultTrainingMap;
  }

  if (activeAdultTrainingPromise) {
    return activeAdultTrainingPromise;
  }

  activeAdultTrainingPromise = (async () => {
    try {
      const config = getTroopWebHostConfig();
      const session = await authenticateTroopWebHost(config);
      const { client, rootUrl, loginUrl } = session;

      // Fetch Required Training By Person (Menu_Item_ID=46029) which tracks both AB-506 and Live Scan for all adults
      const reportUrl = new URL(
        '/FormReport.aspx?Menu_Item_ID=46029&Stack=1&ReportFormat=CSV',
        loginUrl,
      ).toString();

      let res = await client.get(reportUrl, {
        headers: { Referer: `${rootUrl}/Index.htm` },
        timeout: { request: 25000 },
      });

      let text = typeof res.body === 'string' ? res.body : String(res.body ?? '');
      let rows = parseCsv(text);

      // If Menu_Item_ID=46029 returns empty or non-CSV, fallback to Section 1243
      if (rows.length === 0) {
        const fallbackUrl = new URL(
          '/FormReport.aspx?Menu_Item_ID=45888&Form_ID=403&Stack=1&SectionID=1243&ReportFormat=CSV',
          loginUrl,
        ).toString();
        res = await client.get(fallbackUrl, {
          headers: { Referer: `${rootUrl}/Index.htm` },
          timeout: { request: 25000 },
        });
        text = typeof res.body === 'string' ? res.body : String(res.body ?? '');
        rows = parseCsv(text);
      }

      const trainingMap = new Map();

      for (const row of rows) {
        const adultName = String(row.Name || row.Adult || '').trim().toLowerCase();
        if (!adultName) continue;

        const trainingName = String(row['Training Course'] || row.Training || '').toLowerCase();
        const completed = String(row['Last Completed'] || row.Completed || '').trim();

        if (!trainingMap.has(adultName)) {
          trainingMap.set(adultName, {
            name: row.Name || row.Adult,
            hasAb506: false,
            hasLiveScan: false,
            ab506Completed: '',
            liveScanCompleted: '',
            courses: [],
          });
        }

        const entry = trainingMap.get(adultName);
        entry.courses.push({
          training: row['Training Course'] || row.Training,
          completed,
          expires: row.Expires,
        });

        if ((trainingName.includes('ab-506') || trainingName.includes('mandated reporter')) && completed) {
          entry.hasAb506 = true;
          entry.ab506Completed = completed;
        }

        if ((trainingName.includes('live scan') || trainingName.includes('finger print')) && completed) {
          entry.hasLiveScan = true;
          entry.liveScanCompleted = completed;
        }
      }

      cache.adultTrainingMap = trainingMap;
      cache.adultTrainingTimestamp = Date.now();
      return trainingMap;
    } catch (err) {
      console.error('Failed to fetch adult training data from TWH:', err.message);
      return cache.adultTrainingMap || new Map();
    } finally {
      activeAdultTrainingPromise = null;
    }
  })();

  return activeAdultTrainingPromise;
}

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?)?/i);
  if (!match) return null;
  let [, month, day, year, hour, min, ampm] = match;
  month = parseInt(month, 10) - 1;
  day = parseInt(day, 10);
  year = parseInt(year, 10);
  if (year < 100) year += 2000;
  hour = hour ? parseInt(hour, 10) : 0;
  min = min ? parseInt(min, 10) : 0;
  if (ampm) {
    if (ampm.toUpperCase() === 'PM' && hour < 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  }
  return new Date(year, month, day, hour, min);
}

async function fetchUpcomingEvents({ days = 90, forceRefresh = false } = {}) {
  const isEventsFresh = Boolean(cache.events) && Date.now() - cache.eventsTimestamp < cache.eventsTtlMs;
  if (!forceRefresh && isEventsFresh) {
    return filterEventsByDays(cache.events, days);
  }

  if (activeEventsPromise) {
    const events = await activeEventsPromise;
    return filterEventsByDays(events, days);
  }

  activeEventsPromise = (async () => {
    const config = getTroopWebHostConfig();
    const session = await authenticateTroopWebHost(config);
    const { client, loginUrl, rootUrl } = session;

    const listUrl = new URL('/FormList.aspx?Menu_Item_ID=45931&Stack=0', loginUrl).toString();
    const res = await client.get(listUrl, {
      headers: { Referer: `${rootUrl}/Index.htm` },
      timeout: { request: 20000 },
    });

    const $ = cheerio.load(res.body);
    const parsedEvents = [];
    const seenIds = new Set();

    $('table').each((_, tbl) => {
      const link = $(tbl).find('a[onclick*="Form_ID=259" i], input[onclick*="Form_ID=167" i]').first();
      if (link.length === 0) return;
      const onclick = link.attr('onclick') || '';
      const match = onclick.match(/[?&]ID=(\d+)/i);
      if (!match) return;
      const id = match[1];
      if (seenIds.has(id)) return;
      seenIds.add(id);

      let title = '';
      let eventType = '';
      let location = '';
      let mapLink = '';
      let start = '';
      let end = '';

      $(tbl).find('tr').each((_, tr) => {
        const caption = $(tr).find('.mobile-grid-caption').text().trim();
        const data = $(tr).find('.mobile-grid-data').text().trim().replace(/\s+/g, ' ');
        if (/event type/i.test(caption)) eventType = data;
        else if (/^event$/i.test(caption)) title = data;
        else if (/location/i.test(caption)) {
          location = data;
          const href = $(tr).find('.mobile-grid-data a').attr('href');
          if (href) mapLink = href;
        }
        else if (/start/i.test(caption)) start = data;
        else if (/end/i.test(caption)) end = data;
      });

      if (!mapLink && location && !location.toUpperCase().includes('CABIN')) {
        mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
      }

      const loc = (location || '').trim().toUpperCase();
      const isCabin = loc.includes('CABIN');
      const isInfo = /information only|holiday/i.test(eventType);
      const isCarpoolCandidate = !isCabin && !isInfo && Boolean(title || eventType);

      if (id && (title || eventType)) {
        parsedEvents.push({
          id,
          title: title || eventType,
          eventType,
          location,
          mapLink,
          start,
          end,
          isCarpoolCandidate,
          startDateObj: parseEventDate(start),
          endDateObj: parseEventDate(end || start),
        });
      }
    });

    cache.events = parsedEvents;
    cache.eventsTimestamp = Date.now();
    return parsedEvents;
  })();

  try {
    const events = await activeEventsPromise;
    return filterEventsByDays(events, days);
  } finally {
    activeEventsPromise = null;
  }
}

function filterEventsByDays(events, days) {
  if (!days || days <= 0) return events;
  const now = new Date();
  // Retain events in progress and through at least the day after their end date
  const cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  cutoffDate.setHours(0, 0, 0, 0);

  const maxFuture = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  maxFuture.setHours(23, 59, 59, 999);

  return events
    .filter((e) => {
      const endOrStart = e.endDateObj || e.startDateObj;
      if (!endOrStart) return true;
      const startOrEnd = e.startDateObj || e.endDateObj;
      return endOrStart >= cutoffDate && startOrEnd <= maxFuture;
    })
    .map(({ startDateObj, endDateObj, ...rest }) => rest);
}

const NICKNAMES = {
  tom: ['thomas', 'tommy'],
  thomas: ['tom', 'tommy'],
  tommy: ['tom', 'thomas'],
  mike: ['michael', 'mikey'],
  michael: ['mike', 'mikey'],
  mikey: ['mike', 'michael'],
  chris: ['christopher', 'christina', 'christine'],
  christopher: ['chris'],
  dan: ['daniel', 'danny'],
  daniel: ['dan', 'danny'],
  dave: ['david', 'davey'],
  david: ['dave', 'davey'],
  matt: ['matthew'],
  matthew: ['matt'],
  ben: ['benjamin', 'benny'],
  benjamin: ['ben', 'benny'],
  alex: ['alexander', 'alexandra', 'alexis'],
  alexander: ['alex'],
  alexandra: ['alex', 'ally', 'allie'],
  sam: ['samuel', 'samantha', 'sammy'],
  samuel: ['sam', 'sammy'],
  samantha: ['sam', 'sammy'],
  nick: ['nicholas'],
  nicholas: ['nick'],
  kate: ['katherine', 'catherine', 'katie'],
  katie: ['katherine', 'catherine', 'kate'],
  katherine: ['kate', 'katie', 'kathy'],
  catherine: ['kate', 'katie', 'cathy'],
  liz: ['elizabeth', 'lizzie', 'beth', 'ellie'],
  beth: ['elizabeth'],
  ellie: ['elizabeth', 'eleanor', 'ellen'],
  elizabeth: ['liz', 'lizzie', 'beth', 'ellie'],
  jen: ['jennifer', 'jenny'],
  jenny: ['jennifer', 'jen'],
  jennifer: ['jen', 'jenny'],
  em: ['emily', 'emma'],
  emily: ['em'],
  emma: ['em'],
  madi: ['madison', 'madelaine', 'madeline', 'maddie', 'maddy'],
  maddie: ['madison', 'madelaine', 'madeline', 'madi', 'maddy'],
  maddy: ['madison', 'madelaine', 'madeline', 'maddie', 'madi'],
  madison: ['madi', 'maddie', 'maddy'],
  madeline: ['madi', 'maddie', 'maddy'],
  madelaine: ['madi', 'maddie', 'maddy'],
  will: ['william', 'bill', 'billy', 'liam'],
  bill: ['william', 'will', 'billy'],
  william: ['will', 'bill', 'billy', 'liam'],
  rob: ['robert', 'bob', 'bobby'],
  bob: ['robert', 'rob', 'bobby'],
  robert: ['rob', 'bob', 'bobby'],
  jim: ['james', 'jimmy'],
  james: ['jim', 'jimmy'],
  joe: ['joseph', 'joey'],
  joseph: ['joe', 'joey'],
  jon: ['jonathan', 'john'],
  john: ['jon', 'johnny', 'jonathan'],
  jonathan: ['jon', 'john'],
  greg: ['gregory'],
  gregory: ['greg'],
  steve: ['steven', 'stephen'],
  steven: ['steve'],
  stephen: ['steve'],
  andy: ['andrew', 'drew'],
  andrew: ['andy', 'drew'],
  zach: ['zachary', 'zack'],
  zachary: ['zach', 'zack'],
  josh: ['joshua'],
  joshua: ['josh'],
  tim: ['timothy', 'timmy'],
  timothy: ['tim', 'timmy'],
  ken: ['kenneth', 'kenny'],
  kenneth: ['ken', 'kenny'],
  tony: ['anthony'],
  anthony: ['tony'],
};

function firstMatches(token, candidateFirst) {
  if (!token || !candidateFirst) return false;
  const t = token.toLowerCase();
  const c = candidateFirst.toLowerCase();
  if (t === c) return true;
  const n1 = NICKNAMES[t] || [];
  if (n1.includes(c)) return true;
  const n2 = NICKNAMES[c] || [];
  if (n2.includes(t)) return true;
  return false;
}


function levenshteinDistance(s1, s2) {
  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;
  const d = [];
  for (let i = 0; i <= s1.length; i++) d[i] = [i];
  for (let j = 0; j <= s2.length; j++) d[0][j] = j;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i - 1][j - 1] + cost,
        d[i][j - 1] + 1
      );
    }
  }
  return d[s1.length][s2.length];
}

function isLastNameMatch(candidateStr, actualLast) {
  if (!candidateStr || !actualLast) return false;
  const cNorm = candidateStr.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const aNorm = actualLast.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cNorm || !aNorm) return false;

  // Exact match
  if (cNorm === aNorm) return true;

  // Space-collapsed match (e.g. "dipasqualucci" vs "di pasqualucci")
  const cNoSpace = cNorm.replace(/\s+/g, '');
  const aNoSpace = aNorm.replace(/\s+/g, '');
  if (cNoSpace === aNoSpace) return true;

  // Suffix/main surname word for compound surnames (e.g. "pasqualucci" or "pasqulucci" vs "di pasqualucci")
  const aWords = aNorm.split(/\s+/);
  if (aWords.length > 1) {
    const mainWord = aWords[aWords.length - 1];
    if (cNorm === mainWord) return true;
    if (mainWord.length >= 6 && levenshteinDistance(cNorm, mainWord) <= 1) return true;
  }

  // Levenshtein distance on full / no-space string (minor typos)
  const minLen = Math.min(cNoSpace.length, aNoSpace.length);
  const maxLen = Math.max(cNoSpace.length, aNoSpace.length);
  if (minLen >= 5 && Math.abs(cNoSpace.length - aNoSpace.length) <= 1) {
    const dist = levenshteinDistance(cNoSpace, aNoSpace);
    if (dist <= 1) return true;
    if (maxLen >= 10 && dist <= 2) return true;
  }

  return false;
}

/**
 * Normalizes and splits a member name into clean first name, clean surname,
 * single-character initial, and display name.
 * Handles "Last, First [Middle]" and "First [Middle] Last" (including compound surnames like Di Pasqualucci).
 */
function parseNameComponents(nameStr) {
  if (!nameStr || typeof nameStr !== 'string') return null;
  let raw = nameStr.trim();
  if (!raw || raw.startsWith('⚠️')) return null;

  // Remove leading "Scout " or "Scouts " if present
  raw = raw.replace(/^scouts?\s*:\s*/i, '').replace(/^scouts?\s+/i, '').trim();

  let first = '';
  let last = '';
  let middle = '';

  if (raw.includes(',')) {
    const [lastPart, ...firstParts] = raw.split(',');
    last = lastPart.trim();
    const firstTokens = firstParts.join(' ').trim().split(/\s+/).filter(Boolean);
    first = firstTokens[0] || '';
    if (firstTokens.length > 1) {
      middle = firstTokens.slice(1).join(' ');
    }
  } else {
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length >= 3 && /^(?:di|de|van|von|la|le|del|dos)$/i.test(parts[parts.length - 2])) {
      last = parts.slice(parts.length - 2).join(' ');
      first = parts[0] || '';
      if (parts.length > 3) {
        middle = parts.slice(1, parts.length - 2).join(' ');
      }
    } else if (parts.length > 1) {
      last = parts.pop() || '';
      first = parts[0] || '';
      if (parts.length > 1) {
        middle = parts.slice(1).join(' ');
      }
    } else {
      first = parts[0] || '';
    }
  }

  // Capitalize first name token
  const cleanFirst = first ? (first[0].toUpperCase() + first.slice(1).toLowerCase()) : '';

  // Clean surname and compute single-letter surname initial (without period)
  // Compound surnames like "Di Pasqualucci" take the first letter "D"
  let cleanLast = last.trim();
  let surnameInitial = '';
  if (cleanLast) {
    const match = cleanLast.match(/[a-zA-Z]/);
    surnameInitial = match ? match[0].toUpperCase() : cleanLast[0].toUpperCase();
  }

  const displayName = cleanLast ? `${cleanFirst} ${cleanLast}` : cleanFirst;

  return {
    raw,
    cleanFirst,
    cleanLast,
    surnameInitial,
    displayName,
    middle,
  };
}

/**
 * Builds a deterministic dictionary of member names across the troop roster/attendees.
 * Outputs:
 * - compactName: "First L" (no period in initial, compound surnames abbreviated to "D")
 * - If collision exists for `${First} ${L}`, disambiguates to Full Name "First Last"
 * - tokens: comprehensive list of name representations for clean note stripping
 */
function buildNameDictionary(persons = []) {
  const records = [];
  const seenRaw = new Set();

  for (const item of persons) {
    if (!item) continue;
    const nameStr = typeof item === 'string' ? item : (item.name || item.Participant || '');
    if (!nameStr || nameStr.startsWith('⚠️')) continue;
    const lowerKey = nameStr.toLowerCase().trim();
    if (seenRaw.has(lowerKey)) continue;
    seenRaw.add(lowerKey);

    const parsed = parseNameComponents(nameStr);
    if (!parsed || !parsed.cleanFirst) continue;

    const isAdult = typeof item === 'object' ? Boolean(item.isAdult || item.leadership) : false;
    records.push({
      originalName: nameStr.trim(),
      parsed,
      isAdult,
    });
  }

  // Collision map based on key: `${cleanFirst.toLowerCase()} ${surnameInitial.toLowerCase()}`
  const initialCollisionMap = new Map();
  for (const r of records) {
    if (!r.parsed.surnameInitial) continue;
    const key = `${r.parsed.cleanFirst.toLowerCase()} ${r.parsed.surnameInitial.toLowerCase()}`;
    const list = initialCollisionMap.get(key) || [];
    list.push(r);
    initialCollisionMap.set(key, list);
  }

  const dictionary = new Map();
  const plainObj = {};

  for (const r of records) {
    const { cleanFirst, cleanLast, surnameInitial, displayName } = r.parsed;
    const raw = r.originalName;
    let compactName = cleanFirst;

    if (surnameInitial) {
      const key = `${cleanFirst.toLowerCase()} ${surnameInitial.toLowerCase()}`;
      const group = initialCollisionMap.get(key) || [];
      // Only 2 representations:
      // Either "First L" (no period) or "First Last" (full name if collision)
      if (group.length > 1) {
        compactName = displayName;
      } else {
        compactName = `${cleanFirst} ${surnameInitial}`;
      }
    }

    // Comprehensive token set for driver comment & note stripping
    const tokens = [];
    if (displayName) tokens.push(displayName);
    if (raw && raw !== displayName) tokens.push(raw);
    if (cleanFirst && cleanLast) {
      tokens.push(`${cleanFirst} ${cleanLast}`);
      tokens.push(`${cleanLast}, ${cleanFirst}`);
      tokens.push(`${cleanLast} ${cleanFirst}`);
    }
    if (compactName && !tokens.includes(compactName)) tokens.push(compactName);
    if (surnameInitial) tokens.push(`${cleanFirst} ${surnameInitial}.`);
    if (cleanFirst && cleanFirst.length > 1 && !tokens.includes(cleanFirst)) {
      tokens.push(cleanFirst);
    }

    // Common adult nicknames
    if (cleanFirst.toLowerCase() === 'thomas') {
      tokens.push('Tom');
      tokens.push('Tom ' + cleanLast);
    }
    if (cleanFirst.toLowerCase() === 'william') {
      tokens.push('Bill', 'Will', 'Bill ' + cleanLast, 'Will ' + cleanLast);
    }
    if (cleanFirst.toLowerCase() === 'robert') {
      tokens.push('Bob', 'Rob', 'Bob ' + cleanLast, 'Rob ' + cleanLast);
    }
    if (cleanFirst.toLowerCase() === 'richard') {
      tokens.push('Rick', 'Dick', 'Rick ' + cleanLast, 'Dick ' + cleanLast);
    }
    if (cleanFirst.toLowerCase() === 'james') {
      tokens.push('Jim', 'Jim ' + cleanLast);
    }

    // Handle compound surname variations (e.g. Di Pasqualucci vs Di Pasqulucci)
    if (/^di\s+pasqu/i.test(cleanLast)) {
      tokens.push(`${cleanFirst} Di Pasqulucci`);
      tokens.push(`Di Pasqulucci, ${cleanFirst}`);
    }

    const uniqueTokens = Array.from(new Set(tokens.filter(Boolean))).sort((a, b) => b.length - a.length);

    const entry = {
      originalName: raw,
      displayName,
      compactName,
      first: cleanFirst,
      last: cleanLast,
      initial: surnameInitial,
      isAdult: r.isAdult,
      tokens: uniqueTokens,
    };

    dictionary.set(raw, entry);
    dictionary.set(raw.toLowerCase(), entry);
    if (displayName) dictionary.set(displayName.toLowerCase(), entry);
    if (compactName) dictionary.set(compactName.toLowerCase(), entry);

    plainObj[raw] = entry;
    plainObj[raw.toLowerCase()] = entry;
    if (displayName) plainObj[displayName.toLowerCase()] = entry;
    if (compactName) plainObj[compactName.toLowerCase()] = entry;
  }

  dictionary.toPlainObject = () => plainObj;
  return dictionary;
}

function matchAttendeesInText(text, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries = [], rosterAdultEntries = [], nameDictionary = null) {
  if (!text || typeof text !== 'string') {
    return { matchedScouts: [], matchedAdults: [], ambiguousNotes: [] };
  }

  const matchedScouts = [];
  const matchedAdults = [];
  const matchedAdultObjects = [];
  const ambiguousNotes = [];
  const checkedFirstNames = new Set();
  const checkedFirstInitials = new Set();

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findTokenPosition(tok, occurrenceIndex = 0) {
    if (!tok) return 999;
    const r = new RegExp(`\\b${escapeRegExp(tok)}\\b`, 'gi');
    let m;
    let count = 0;
    while ((m = r.exec(text)) !== null) {
      if (count === occurrenceIndex) return m.index;
      count++;
    }
    return 999;
  }

  function countTokenOccurrences(str, token) {
    if (!str || !token) return 0;
    const escaped = escapeRegExp(token);
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const matches = str.match(regex);
    return matches ? matches.length : 0;
  }

  const consumedCounts = new Map();

  function getConsumedCount(tok) {
    return consumedCounts.get(tok.toLowerCase()) || 0;
  }

  function recordConsumedToken(tok) {
    if (!tok) return;
    const t = tok.toLowerCase();
    consumedCounts.set(t, (consumedCounts.get(t) || 0) + 1);
  }

  function isTokenAvailable(tok) {
    if (!tok) return false;
    const t = tok.toLowerCase();
    return countTokenOccurrences(text, t) > getConsumedCount(t);
  }

  function findAdjacentFullName(firstTok, lastTarget) {
    if (!firstTok || !lastTarget || !isTokenAvailable(firstTok)) return null;
    const r = new RegExp(`\\b${escapeRegExp(firstTok)}\\b`, 'gi');
    let m;
    while ((m = r.exec(text)) !== null) {
      // 1. Check after firstTok: e.g. "Morgan Di Pasqulucci"
      const afterSlice = text.slice(m.index + m[0].length);
      const afterWordsMatch = afterSlice.match(/^\s+([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){0,2})/);
      if (afterWordsMatch) {
        const words = afterWordsMatch[1].split(/\s+/);
        for (let numWords = words.length; numWords >= 1; numWords--) {
          const candidate = words.slice(0, numWords).join(' ');
          if (isLastNameMatch(candidate, lastTarget)) {
            return {
              textIndex: m.index,
              matchedFirst: m[0],
              matchedLast: candidate,
              fullMatchText: `${m[0]} ${candidate}`,
            };
          }
        }
      }

      // 2. Check before firstTok: e.g. "Di Pasqulucci, Morgan" or "Di Pasqulucci Morgan"
      const beforeSlice = text.slice(0, m.index);
      const beforeWordsMatch = beforeSlice.match(/([a-zA-Z'-]+(?:\s+[a-zA-Z'-]+){0,2})[,\s]*$/);
      if (beforeWordsMatch) {
        const words = beforeWordsMatch[1].split(/\s+/);
        for (let numWords = 1; numWords <= words.length; numWords++) {
          const candidate = words.slice(-numWords).join(' ');
          if (isLastNameMatch(candidate, lastTarget)) {
            return {
              textIndex: m.index - candidate.length,
              matchedFirst: m[0],
              matchedLast: candidate,
              fullMatchText: `${candidate} ${m[0]}`,
            };
          }
        }
      }
    }
    return null;
  }

  // Consume self-referential driver tokens present in text so driver isn't matched as passenger
  const selfTokens = ['myself', 'me', 'i', 'self', 'driver'];
  selfTokens.forEach((tok) => {
    if (tok && isTokenAvailable(tok)) {
      recordConsumedToken(tok);
    }
  });

  // If driver wrote their own full name (e.g. "Olivia Nelson"), consume those tokens
  if (driverLast && isTokenAvailable(driverLast) && isTokenAvailable(driverFirst)) {
    const adj = findAdjacentFullName(driverFirst, driverLast);
    if (adj) {
      recordConsumedToken(driverFirst);
      recordConsumedToken(driverLast);
    }
  }

  const matchedScoutOriginals = new Set();
  const matchedAdultNames = new Set();

  // -------------------------------------------------------------
  // PASS 1A: Exact Primary Full Name Matches (First + Last)
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (!sc.last || !sc.first) continue;

    let adjacentMatch = null;
    if (isTokenAvailable(sc.last) && isTokenAvailable(sc.first)) {
      recordConsumedToken(sc.last);
      recordConsumedToken(sc.first);
      checkedFirstNames.add(sc.first);
      matchedScoutOriginals.add(sc.originalName);

      let idx = findTokenPosition(`${sc.first} ${sc.last}`);
      if (idx === 999) idx = findTokenPosition(`${sc.last} ${sc.first}`);
      if (idx === 999) idx = findTokenPosition(sc.first);

      matchedScouts.push({
        name: sc.displayName,
        originalName: sc.originalName,
        status: 'confirmed',
        note: 'Full name matched',
        textIndex: idx,
      });
    } else if ((adjacentMatch = findAdjacentFullName(sc.first, sc.last)) !== null) {
      recordConsumedToken(sc.first);
      adjacentMatch.matchedLast.toLowerCase().split(/\s+/).forEach((w) => recordConsumedToken(w));
      recordConsumedToken(sc.last);
      checkedFirstNames.add(sc.first);
      matchedScoutOriginals.add(sc.originalName);

      matchedScouts.push({
        name: sc.displayName,
        originalName: sc.originalName,
        status: 'confirmed',
        note: 'Full name matched',
        textIndex: adjacentMatch.textIndex,
      });
    }
  }

  // Exact Primary Full Name matches for adults
  for (const ad of adultEntries) {
    if (ad.first === driverFirst && ad.last === driverLast) continue;
    if (matchedScoutOriginals.has(ad.originalName) || matchedScouts.some((m) => m.name === ad.displayName)) continue;
    if (!ad.last || !ad.first) continue;

    let adjacentMatch = null;
    if (isTokenAvailable(ad.last) && isTokenAvailable(ad.first)) {
      recordConsumedToken(ad.last);
      recordConsumedToken(ad.first);
      matchedAdultNames.add(ad.displayName);
      matchedAdults.push(ad.displayName);

      let idx = findTokenPosition(`${ad.first} ${ad.last}`);
      if (idx === 999) idx = findTokenPosition(`${ad.last} ${ad.first}`);
      if (idx === 999) idx = findTokenPosition(ad.first);

      matchedAdultObjects.push({
        name: ad.displayName,
        textIndex: idx,
      });
    } else if ((adjacentMatch = findAdjacentFullName(ad.first, ad.last)) !== null) {
      recordConsumedToken(ad.first);
      adjacentMatch.matchedLast.toLowerCase().split(/\s+/).forEach((w) => recordConsumedToken(w));
      recordConsumedToken(ad.last);
      matchedAdultNames.add(ad.displayName);
      matchedAdults.push(ad.displayName);

      matchedAdultObjects.push({
        name: ad.displayName,
        textIndex: adjacentMatch.textIndex,
      });
    }
  }

  // -------------------------------------------------------------
  // PASS 1B: Nickname Full Name Matches (Nickname + Last)
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;
    if (!sc.last) continue;

    const nickTokens = (NICKNAMES[sc.first] || []);
    let matchedNick = null;
    let adjacentMatch = null;

    if (isTokenAvailable(sc.last)) {
      matchedNick = nickTokens.find((n) => n && isTokenAvailable(n));
    }
    if (!matchedNick) {
      for (const n of nickTokens) {
        if (n && isTokenAvailable(n)) {
          const adj = findAdjacentFullName(n, sc.last);
          if (adj) {
            matchedNick = n;
            adjacentMatch = adj;
            break;
          }
        }
      }
    }

    if (matchedNick) {
      recordConsumedToken(sc.last);
      recordConsumedToken(matchedNick);
      if (adjacentMatch) {
        adjacentMatch.matchedLast.toLowerCase().split(/\s+/).forEach((w) => recordConsumedToken(w));
      }
      checkedFirstNames.add(sc.first);
      matchedScoutOriginals.add(sc.originalName);

      let idx = adjacentMatch ? adjacentMatch.textIndex : findTokenPosition(`${matchedNick} ${sc.last}`);
      if (idx === 999) idx = findTokenPosition(matchedNick);

      matchedScouts.push({
        name: sc.displayName,
        originalName: sc.originalName,
        status: 'confirmed',
        note: 'Full name matched (nickname)',
        textIndex: idx,
      });
    }
  }

  for (const ad of adultEntries) {
    if (ad.first === driverFirst && ad.last === driverLast) continue;
    if (matchedAdultNames.has(ad.displayName) || matchedScoutOriginals.has(ad.originalName) || matchedScouts.some((m) => m.name === ad.displayName)) continue;
    if (!ad.last) continue;

    const nickTokens = (NICKNAMES[ad.first] || []);
    let matchedNick = null;
    let adjacentMatch = null;

    if (isTokenAvailable(ad.last)) {
      matchedNick = nickTokens.find((n) => n && isTokenAvailable(n));
    }
    if (!matchedNick) {
      for (const n of nickTokens) {
        if (n && isTokenAvailable(n)) {
          const adj = findAdjacentFullName(n, ad.last);
          if (adj) {
            matchedNick = n;
            adjacentMatch = adj;
            break;
          }
        }
      }
    }

    if (matchedNick) {
      recordConsumedToken(ad.last);
      recordConsumedToken(matchedNick);
      if (adjacentMatch) {
        adjacentMatch.matchedLast.toLowerCase().split(/\s+/).forEach((w) => recordConsumedToken(w));
      }
      matchedAdultNames.add(ad.displayName);
      matchedAdults.push(ad.displayName);

      let idx = adjacentMatch ? adjacentMatch.textIndex : findTokenPosition(`${matchedNick} ${ad.last}`);
      if (idx === 999) idx = findTokenPosition(matchedNick);

      matchedAdultObjects.push({
        name: ad.displayName,
        textIndex: idx,
      });
    }
  }

  // After full-name passes, consume remaining driver first-name token so driver isn't matched as bare first-name passenger
  const driverFirstTokens = [driverFirst, ...(NICKNAMES[driverFirst] || [])];
  driverFirstTokens.forEach((tok) => {
    if (tok && isTokenAvailable(tok)) {
      recordConsumedToken(tok);
    }
  });

  // -------------------------------------------------------------
  // PASS 2: Primary First Name + Last Initial (e.g. "Iris K." or "Iris K")
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;

    const initialPattern = sc.last ? sc.last[0] : '';
    const initialKey = initialPattern ? `${sc.first}_${initialPattern}` : '';
    if (!initialKey || checkedFirstInitials.has(initialKey)) continue;

    if (!isTokenAvailable(sc.first)) continue;
    const regex = new RegExp(`\\b${sc.first}\\s+${initialPattern}\\.?\\b`, 'i');
    if (!regex.test(text)) continue;

    checkedFirstInitials.add(initialKey);
    checkedFirstNames.add(sc.first);
    recordConsumedToken(sc.first);

    const allWithFirst = firstNameFrequency.get(sc.first) || [];
    const matchingInitials = allWithFirst.filter((c) => c.last && c.last[0] === initialPattern);
    const idx = findTokenPosition(sc.first);

    if (matchingInitials.length === 1) {
      const singleScout = matchingInitials[0];
      if (!matchedScouts.some((m) => m.name === singleScout.displayName)) {
        matchedScoutOriginals.add(singleScout.originalName);
        matchedScouts.push({
          name: singleScout.displayName,
          originalName: singleScout.originalName,
          status: 'confirmed',
          note: 'First name and last initial matched',
          textIndex: idx,
        });
      }
    } else if (matchingInitials.length > 1) {
      const candidateNames = matchingInitials.map((c) => c.displayName);
      const displayTok = sc.first.charAt(0).toUpperCase() + sc.first.slice(1);
      const tokenLabel = `${displayTok} ${initialPattern.toUpperCase()}.`;
      const warningMsg = `Ambiguous "${tokenLabel}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
      ambiguousNotes.push({
        token: tokenLabel,
        candidates: candidateNames,
        candidateScouts: matchingInitials,
        note: warningMsg,
        textIndex: idx,
      });
    }
  }

  // -------------------------------------------------------------
  // PASS 3A: Exact Primary First Name Matches
  // Prioritize the actual primary name used for the scout in TWH.
  // If a commented name exactly matches exactly one scout's primary name,
  // it MUST always be derived as that scout.
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;
    if (sc.first.length <= 2 || checkedFirstNames.has(sc.first)) continue;

    if (isTokenAvailable(sc.first)) {
      checkedFirstNames.add(sc.first);
      recordConsumedToken(sc.first);
      const candidates = firstNameFrequency.get(sc.first) || [];
      const idx = findTokenPosition(sc.first);

      if (candidates.length === 1) {
        const singleScout = candidates[0];
        if (!matchedScouts.some((m) => m.name === singleScout.displayName)) {
          matchedScoutOriginals.add(singleScout.originalName);
          matchedScouts.push({
            name: singleScout.displayName,
            originalName: singleScout.originalName,
            status: 'unique_first',
            note: 'Unique first name',
            textIndex: idx,
          });
        }
      } else {
        // Collision: multiple candidates share exact primary first name
        const familyCandidate = candidates.find((c) => c.last === driverLast);
        if (familyCandidate) {
          if (!matchedScouts.some((m) => m.name === familyCandidate.displayName)) {
            matchedScoutOriginals.add(familyCandidate.originalName);
            matchedScouts.push({
              name: familyCandidate.displayName,
              originalName: familyCandidate.originalName,
              status: 'family_match',
              note: `Family match with driver`,
              textIndex: idx,
            });
          }
        } else {
          // Ambiguous collision
          const candidateNames = candidates.map((c) => c.displayName);
          const displayTok = sc.first.charAt(0).toUpperCase() + sc.first.slice(1);
          const warningMsg = `Ambiguous "${displayTok}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
          ambiguousNotes.push({
            token: sc.first,
            candidates: candidateNames,
            candidateScouts: candidates,
            note: warningMsg,
            textIndex: idx,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------
  // PASS 3B: Nickname Matches for Scouts (Fallback only when NO exact primary match exists)
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;
    if (checkedFirstNames.has(sc.first)) continue;

    const nickTokens = (NICKNAMES[sc.first] || []);
    const matchedNick = nickTokens.find((tok) => tok && isTokenAvailable(tok));

    if (matchedNick) {
      checkedFirstNames.add(sc.first);
      recordConsumedToken(matchedNick);

      const allCandidates = scoutEntries.filter((c) =>
        !(c.first === driverFirst && c.last === driverLast) &&
        (c.first === matchedNick || (NICKNAMES[c.first] || []).includes(matchedNick))
      );

      const hasAlreadyMatched = allCandidates.some((c) => matchedScoutOriginals.has(c.originalName));
      const idx = findTokenPosition(matchedNick);

      if (allCandidates.length === 1 && !hasAlreadyMatched) {
        const singleScout = allCandidates[0];
        if (!matchedScouts.some((m) => m.name === singleScout.displayName)) {
          matchedScoutOriginals.add(singleScout.originalName);
          matchedScouts.push({
            name: singleScout.displayName,
            originalName: singleScout.originalName,
            status: 'unique_first',
            note: 'Unique nickname match',
            textIndex: idx,
          });
        }
      } else if (allCandidates.length > 1 && !hasAlreadyMatched) {
        const familyCandidate = allCandidates.find((c) => c.last === driverLast);
        if (familyCandidate) {
          if (!matchedScouts.some((m) => m.name === familyCandidate.displayName)) {
            matchedScoutOriginals.add(familyCandidate.originalName);
            matchedScouts.push({
              name: familyCandidate.displayName,
              originalName: familyCandidate.originalName,
              status: 'family_match',
              note: `Family match with driver (nickname)`,
              textIndex: idx,
            });
          }
        } else {
          const candidateNames = allCandidates.map((c) => c.displayName);
          const displayTok = matchedNick.charAt(0).toUpperCase() + matchedNick.slice(1);
          const warningMsg = `Ambiguous "${displayTok}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
          ambiguousNotes.push({
            token: displayTok,
            candidates: candidateNames,
            candidateScouts: allCandidates,
            note: warningMsg,
            textIndex: idx,
          });
        }
      } else {
        // Token matches a scout who is already claimed—flag as ambiguous repeated mention
        const candidateNames = allCandidates.map((c) => c.displayName);
        const displayTok = matchedNick.charAt(0).toUpperCase() + matchedNick.slice(1);
        const warningMsg = `Ambiguous "${displayTok}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
        ambiguousNotes.push({
          token: displayTok,
          candidates: candidateNames,
          candidateScouts: allCandidates,
          note: warningMsg,
          textIndex: idx,
        });
      }
    }
  }

  // -------------------------------------------------------------
  // PASS 4: Attending Adults by Primary Name or Nickname
  // -------------------------------------------------------------
  for (const ad of adultEntries) {
    if (ad.first === driverFirst && ad.last === driverLast) continue;
    if (matchedAdultNames.has(ad.displayName) || matchedScoutOriginals.has(ad.originalName) || matchedScouts.some((m) => m.name === ad.displayName)) continue;

    const adFirst = ad.first;
    const adLast = ad.last;
    const isFamily = adLast && adLast === driverLast;

    const possibleNames = [adFirst, ...(NICKNAMES[adFirst] || [])];
    for (const pName of possibleNames) {
      if (pName.length < 2) continue;
      if (!isTokenAvailable(pName)) continue;

      const adultCandidates = adultEntries.filter(
        (other) => !matchedAdultNames.has(other.displayName) &&
                   (other.first === adFirst || (NICKNAMES[other.first] || []).includes(pName) || firstMatches(pName, other.first)) &&
                   !(other.first === driverFirst && other.last === driverLast)
      );

      if (adultCandidates.length === 1 || isFamily) {
        matchedAdultNames.add(ad.displayName);
        matchedAdults.push(ad.displayName);
        matchedAdultObjects.push({
          name: ad.displayName,
          textIndex: findTokenPosition(pName),
        });
        recordConsumedToken(pName);
        break;
      }
    }
  }

  // -------------------------------------------------------------
  // PASS 5A: Repeated First Names (e.g. "Madison W.. Madison")
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (sc.first.length <= 2) continue;

    while (isTokenAvailable(sc.first)) {
      const occIndex = getConsumedCount(sc.first);
      recordConsumedToken(sc.first);
      const candidates = scoutEntries.filter((c) =>
        c.first === sc.first ||
        (NICKNAMES[c.first] || []).includes(sc.first) ||
        (NICKNAMES[sc.first] || []).includes(c.first)
      );
      const candidateNames = candidates.map((c) => c.displayName);
      const displayTok = sc.first.charAt(0).toUpperCase() + sc.first.slice(1);
      const idx = findTokenPosition(sc.first, occIndex);
      ambiguousNotes.push({
        token: displayTok,
        candidates: candidateNames,
        candidateScouts: candidates,
        note: `Ambiguous "${displayTok}" (repeated mention): matches ${candidateNames.length} attending scout${candidateNames.length > 1 ? 's' : ''} (${candidateNames.join(', ')}). Driver clarification needed.`,
        textIndex: idx,
      });
    }
  }

  // -------------------------------------------------------------
  // PASS 5B: Unknown First Name + Attending Scout Surname (e.g. "Ren Routt")
  // -------------------------------------------------------------
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;
    if (!sc.last || sc.last.length <= 2) continue;

    if (isTokenAvailable(sc.last)) {
      const rIdx = findTokenPosition(sc.last);
      if (rIdx !== 999) {
        const beforeSlice = text.slice(0, rIdx).trim();
        const precedingMatch = beforeSlice.match(/([a-zA-Z'-]+)[,\s]*$/);
        const precedingWord = precedingMatch ? precedingMatch[1] : '';
        const stopwords = new Set([
          'and', 'or', 'to', 'from', 'for', 'with', 'taking', 'takes', 'take',
          'driving', 'drives', 'drive', 'myself', 'me', 'i', 'self', 'driver', 'car', 'both', 'only'
        ]);

        let candidateToken = sc.last.charAt(0).toUpperCase() + sc.last.slice(1);
        let tokenIdx = rIdx;
        if (precedingWord && !stopwords.has(precedingWord.toLowerCase()) && isTokenAvailable(precedingWord)) {
          candidateToken = `${precedingWord} ${candidateToken}`;
          tokenIdx = rIdx - precedingWord.length;
          recordConsumedToken(precedingWord);
        }
        recordConsumedToken(sc.last);

        const sameLastScouts = scoutEntries.filter((c) => c.last === sc.last);
        const candidateNames = sameLastScouts.map((c) => c.displayName);
        ambiguousNotes.push({
          token: candidateToken,
          candidates: candidateNames,
          candidateScouts: sameLastScouts,
          note: `Ambiguous "${candidateToken}": surname matches ${candidateNames.length} attending scout${candidateNames.length > 1 ? 's' : ''} (${candidateNames.join(', ')}). Driver clarification needed.`,
          textIndex: tokenIdx,
        });
      }
    }
  }

  // -------------------------------------------------------------
  // PASS 6: Non-Attending Troop Roster Members (Fallback for drivers claiming roster members not registered on event)
  // E.g. Heather Tzortzis claiming "Chris & Alina" or Steve Spiker claiming "Lucy and Madeline" (Maddy Spiker)
  // -------------------------------------------------------------
  for (const sc of rosterScoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;
    if (matchedScoutOriginals.has(sc.originalName)) continue;

    const isFamily = sc.last && sc.last === driverLast;
    let matched = false;
    let idx = 999;

    const firstTokens = [sc.first, ...(NICKNAMES[sc.first] || [])];
    const availableFirst = firstTokens.find((tok) => tok && isTokenAvailable(tok));

    if (isTokenAvailable(sc.last) && availableFirst) {
      matched = true;
      recordConsumedToken(sc.last);
      recordConsumedToken(availableFirst);
      idx = findTokenPosition(`${availableFirst} ${sc.last}`);
      if (idx === 999) idx = findTokenPosition(availableFirst);
    } else if (isFamily && availableFirst) {
      matched = true;
      recordConsumedToken(availableFirst);
      idx = findTokenPosition(availableFirst);
    }

    if (matched) {
      matchedScoutOriginals.add(sc.originalName);
      matchedScouts.push({
        name: sc.displayName,
        originalName: sc.originalName,
        status: 'confirmed',
        notAttending: true,
        note: 'Troop member (not registered on event)',
        textIndex: idx,
      });
    }
  }

  for (const ad of rosterAdultEntries) {
    if (ad.first === driverFirst && ad.last === driverLast) continue;
    if (matchedAdultNames.has(ad.displayName) || matchedScoutOriginals.has(ad.originalName)) continue;

    const isFamily = ad.last && ad.last === driverLast;
    let matched = false;
    let idx = 999;

    const firstTokens = [ad.first, ...(NICKNAMES[ad.first] || [])];
    const availableFirst = firstTokens.find((tok) => tok && isTokenAvailable(tok));

    if (isTokenAvailable(ad.last) && availableFirst) {
      matched = true;
      recordConsumedToken(ad.last);
      recordConsumedToken(availableFirst);
      idx = findTokenPosition(`${availableFirst} ${ad.last}`);
      if (idx === 999) idx = findTokenPosition(availableFirst);
    } else if (isFamily && availableFirst) {
      matched = true;
      recordConsumedToken(availableFirst);
      idx = findTokenPosition(availableFirst);
    }

    if (matched) {
      matchedAdultNames.add(ad.displayName);
      matchedAdults.push(ad.displayName);
      matchedAdultObjects.push({
        name: ad.displayName,
        notAttending: true,
        textIndex: idx,
      });
    }
  }

  // Sort matched attendees by textIndex to strictly preserve the original comment order
  matchedScouts.sort((a, b) => (a.textIndex ?? 999) - (b.textIndex ?? 999));
  matchedAdults.sort((a, b) => {
    const aObj = matchedAdultObjects.find((o) => o.name === a);
    const bObj = matchedAdultObjects.find((o) => o.name === b);
    return ((aObj && aObj.textIndex) ?? 999) - ((bObj && bObj.textIndex) ?? 999);
  });
  ambiguousNotes.sort((a, b) => (a.textIndex ?? 999) - (b.textIndex ?? 999));

  // Unified list of all claimed riders in comment order
  const matchedRiders = [
    ...matchedScouts.map((s) => {
      const entry = nameDictionary ? (nameDictionary.get(s.originalName) || nameDictionary.get(s.name) || nameDictionary.get((s.name || '').toLowerCase())) : null;
      return {
        name: s.name,
        originalName: s.originalName,
        type: 'scout',
        status: s.status,
        notAttending: Boolean(s.notAttending),
        textIndex: s.textIndex ?? 999,
        compactName: entry ? entry.compactName : (s.displayName || s.name),
        displayName: entry ? entry.displayName : (s.displayName || s.name),
        tokens: entry ? entry.tokens : [s.name],
      };
    }),
    ...matchedAdultObjects.map((a) => {
      const entry = nameDictionary ? (nameDictionary.get(a.name) || nameDictionary.get((a.name || '').toLowerCase())) : null;
      return {
        name: a.name,
        type: 'adult',
        notAttending: Boolean(a.notAttending),
        textIndex: a.textIndex ?? 999,
        compactName: entry ? entry.compactName : a.name,
        displayName: entry ? entry.displayName : a.name,
        tokens: entry ? entry.tokens : [a.name],
      };
    }),
    ...ambiguousNotes.map((an) => ({
      name: `⚠️ Ambiguous: "${an.token}"`,
      type: 'ambiguous',
      token: an.token,
      candidates: an.candidates,
      note: an.note,
      textIndex: an.textIndex ?? 999,
      compactName: an.token,
      displayName: an.token,
      tokens: [an.token],
    })),
  ].sort((a, b) => a.textIndex - b.textIndex);

  return { matchedScouts, matchedAdults, ambiguousNotes, matchedRiders };
}

function parseDriverComments(drivers, scouts, adults, rosterMembers = [], existingNameDictionary = null) {
  const nameDictionary = existingNameDictionary || buildNameDictionary([
    ...(rosterMembers || []),
    ...(scouts || []),
    ...(adults || []),
    ...(drivers || []),
  ]);
  const scoutEntries = scouts.map((s) => {
    const parts = s.name.split(',').map((p) => p.trim());
    const first = parts.length > 1 ? parts[1].split(' ')[0] : parts[0].split(' ')[0];
    const last = parts.length > 1 ? parts[0] : '';
    const full = parts.length > 1 ? `${parts[1]} ${parts[0]}` : s.name;
    return {
      originalName: s.name,
      displayName: full,
      first: first.toLowerCase(),
      last: last.toLowerCase(),
    };
  });

  // Track first-name frequency to detect collisions
  const firstNameFrequency = new Map();
  scoutEntries.forEach((sc) => {
    const list = firstNameFrequency.get(sc.first) || [];
    list.push(sc);
    firstNameFrequency.set(sc.first, list);
  });

  const adultEntries = adults.map((a) => {
    const parts = a.name.split(',').map((p) => p.trim());
    const first = parts.length > 1 ? parts[1].split(' ')[0] : parts[0].split(' ')[0];
    const last = parts.length > 1 ? parts[0] : '';
    const full = parts.length > 1 ? `${parts[1]} ${parts[0]}` : a.name;
    return {
      originalName: a.name,
      displayName: full,
      first: first.toLowerCase(),
      last: last.toLowerCase(),
    };
  });

  const rosterScoutEntries = [];
  const rosterAdultEntries = [];
  (rosterMembers || []).forEach((m) => {
    const mName = m.name || '';
    const parts = mName.split(',').map((p) => p.trim());
    const first = parts.length > 1 ? parts[1].split(' ')[0] : parts[0].split(' ')[0];
    const last = parts.length > 1 ? parts[0] : '';
    const full = parts.length > 1 ? `${parts[1]} ${parts[0]}` : mName;
    const entry = {
      originalName: mName,
      displayName: full,
      first: first.toLowerCase(),
      last: last.toLowerCase(),
      patrol: m.patrol || '',
    };
    if (m.isAdult) {
      rosterAdultEntries.push(entry);
    } else {
      rosterScoutEntries.push(entry);
    }
  });

  const scoutRideMap = new Map();
  const scoutAmbiguousMentions = new Map();
  const claimedAdultsSet = new Set();
  const allClarifications = [];
  const scoutDriversTo = new Map();   // originalName -> array of driver names
  const scoutDriversFrom = new Map(); // originalName -> array of driver names

  const enrichedDrivers = drivers.map((d) => {
    const comment = (d.comment || '').trim();
    // TWH seats represent total seatbelts; available passenger seats is 1 less (excluding driver)
    const passengerCapacity = d.seats > 0 ? Math.max(0, d.seats - 1) : 0;

    if (!comment) {
      const isAttending = d.attending === 'Y';
      const toSeats = (d.drivingToFrom === 'Both' || d.drivingToFrom === 'To' || !d.drivingToFrom) ? passengerCapacity : 0;
      const fromSeats = (d.drivingToFrom === 'Both' || d.drivingToFrom === 'From') ? passengerCapacity : 0;
      return {
        ...d,
        claimedScouts: [],
        claimedAdults: [],
        claimedScoutsTo: [],
        claimedScoutsFrom: [],
        claimedAdultsTo: [],
        claimedAdultsFrom: [],
        toSeats,
        fromSeats,
        openSeatsTo: isAttending ? toSeats : 0,
        openSeatsFrom: isAttending ? fromSeats : 0,
        ambiguousNotes: [],
        openSeats: isAttending ? passengerCapacity : 0,
        explicitOpenNote: '',
        cleanNote: '',
      };
    }

    const dParts = d.name.split(',').map((p) => p.trim());
    const driverFirst = (dParts.length > 1 ? dParts[1].split(' ')[0] : dParts[0].split(' ')[0]).toLowerCase();
    const driverLast = (dParts.length > 1 ? dParts[0] : '').toLowerCase();

    // Check if the comment follows structured discrete TO/FROM/Both notation (must have colon)
    const hasDiscrete = /(?:(?:TO|FROM|Both)(?:\s*only)?(?:\s*\([^)]*\))?\s*:)/i.test(comment);

    let matchedScouts = [];
    let matchedAdults = [];
    let claimedScoutsTo = [];
    let claimedScoutsFrom = [];
    let claimedAdultsTo = [];
    let claimedAdultsFrom = [];
    let claimedRidersTo = [];
    let claimedRidersFrom = [];
    let toSeats = passengerCapacity;
    let fromSeats = passengerCapacity;
    let ambiguousNotes = [];
    let cleanNote = '';

    if (hasDiscrete) {
      // Discrete parser: Both (...): ... TO (...): ... FROM (...): ...
      let bothText = '';
      let toText = '';
      let fromText = '';

      // Check for prefix note before Both/TO/FROM (e.g. "Returning sunday evening.")
      const prefixMatch = comment.match(/^([^]*?)(?=(?:Both|TO|FROM)(?:\s*only)?(?:\s*\([^)]*\))?\s*:)/i);
      if (prefixMatch && prefixMatch[1] && prefixMatch[1].trim()) {
        cleanNote = prefixMatch[1].trim().replace(/[.,;]+$/, '').trim();
      }

      const bothBlockMatch = comment.match(/Both(?:\s*only)?(?:\s*\(([^)]*)\))?\s*:\s*([^]*?)(?=(?:TO|FROM)(?:\s*only)?(?:\s*\([^)]*\))?\s*:|$)/i);
      if (bothBlockMatch) {
        if (bothBlockMatch[1]) {
          const numMatch = bothBlockMatch[1].match(/(\d+)/);
          if (numMatch) {
            toSeats = parseInt(numMatch[1], 10);
            fromSeats = toSeats;
          }
        }
        const rawBoth = (bothBlockMatch[2] || '').trim();
        bothText = rawBoth;
        const dotSplit = rawBoth.match(/^(.*?\.)\s+([^.]*.*)$/);
        if (dotSplit) {
          const testMatch = matchAttendeesInText(dotSplit[2], driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);
          if (testMatch.matchedScouts.length === 0 && testMatch.matchedAdults.length === 0 && testMatch.ambiguousNotes.length === 0) {
            if (!cleanNote) cleanNote = dotSplit[2].trim();
            else cleanNote = `${cleanNote}. ${dotSplit[2].trim()}`;
          }
        }
      }

      const fromBlockMatch = comment.match(/FROM(?:\s*only)?(?:\s*\(([^)]*)\))?\s*:\s*([^]*?)$/i);
      if (fromBlockMatch) {
        if (fromBlockMatch[1]) {
          const numMatch = fromBlockMatch[1].match(/(\d+)/);
          if (numMatch) fromSeats = parseInt(numMatch[1], 10);
        }
        const rawFrom = (fromBlockMatch[2] || '').trim();
        fromText = rawFrom;
        const dotSplit = rawFrom.match(/^(.*?\.)\s+([^.]*.*)$/);
        if (dotSplit) {
          const testMatch = matchAttendeesInText(dotSplit[2], driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);
          if (testMatch.matchedScouts.length === 0 && testMatch.matchedAdults.length === 0 && testMatch.ambiguousNotes.length === 0) {
            cleanNote = cleanNote ? `${cleanNote}. ${dotSplit[2].trim()}` : dotSplit[2].trim();
          }
        }
      }

      const toBlockMatch = comment.match(/TO(?:\s*only)?(?:\s*\(([^)]*)\))?\s*:\s*([^]*?)(?=(?:FROM(?:\s*only)?(?:\s*\([^)]*\))?\s*:|$))/i);
      if (toBlockMatch) {
        if (toBlockMatch[1]) {
          const numMatch = toBlockMatch[1].match(/(\d+)/);
          if (numMatch) toSeats = parseInt(numMatch[1], 10);
        }
        const rawTo = (toBlockMatch[2] || '').trim();
        toText = rawTo;
        if (!fromBlockMatch) {
          const dotSplit = rawTo.match(/^(.*?\.)\s+([^.]*.*)$/);
          if (dotSplit) {
            const testMatch = matchAttendeesInText(dotSplit[2], driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);
            if (testMatch.matchedScouts.length === 0 && testMatch.matchedAdults.length === 0 && testMatch.ambiguousNotes.length === 0) {
              cleanNote = cleanNote ? `${cleanNote}. ${dotSplit[2].trim()}` : dotSplit[2].trim();
            }
          }
        }
      }

      if (/^open\.?$/i.test(bothText.trim())) bothText = '';
      if (/^open\.?$/i.test(toText.trim())) toText = '';
      if (/^open\.?$/i.test(fromText.trim())) fromText = '';
      bothText = bothText.replace(/^taking\s+/i, '');
      toText = toText.replace(/^taking\s+/i, '');
      fromText = fromText.replace(/^taking\s+/i, '');

      const fullToText = [bothText, toText].filter(Boolean).join(', ');
      const fullFromText = [bothText, fromText].filter(Boolean).join(', ');

      const toMatch = matchAttendeesInText(fullToText, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);
      const fromMatch = matchAttendeesInText(fullFromText, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);

      claimedScoutsTo = toMatch.matchedScouts;
      claimedAdultsTo = toMatch.matchedAdults;
      claimedScoutsFrom = fromMatch.matchedScouts;
      claimedAdultsFrom = fromMatch.matchedAdults;
      claimedRidersTo = toMatch.matchedRiders || [];
      claimedRidersFrom = fromMatch.matchedRiders || [];

      // Register TO scouts in scoutRideMap
      claimedScoutsTo.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        cur.driverNameTo = d.name;
        cur.statusTo = sc.status;
        scoutRideMap.set(sc.originalName, cur);

        const list = scoutDriversTo.get(sc.originalName) || [];
        if (!list.includes(d.name)) list.push(d.name);
        scoutDriversTo.set(sc.originalName, list);
      });

      // Register FROM scouts in scoutRideMap
      claimedScoutsFrom.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        cur.driverNameFrom = d.name;
        cur.statusFrom = sc.status;
        scoutRideMap.set(sc.originalName, cur);

        const list = scoutDriversFrom.get(sc.originalName) || [];
        if (!list.includes(d.name)) list.push(d.name);
        scoutDriversFrom.set(sc.originalName, list);
      });

      // Combine matched scouts & adults for backwards-compatible arrays
      const scoutNameSet = new Set();
      [...claimedScoutsTo, ...claimedScoutsFrom].forEach((sc) => {
        if (!scoutNameSet.has(sc.name)) {
          scoutNameSet.add(sc.name);
          matchedScouts.push(sc);
        }
      });

      const adultNameSet = new Set();
      [...claimedAdultsTo, ...claimedAdultsFrom].forEach((ad) => {
        if (!adultNameSet.has(ad)) {
          adultNameSet.add(ad);
          matchedAdults.push(ad);
          claimedAdultsSet.add(ad);
        }
      });

      const seenAmbTokens = new Set();
      ambiguousNotes = [];
      [...toMatch.ambiguousNotes, ...fromMatch.ambiguousNotes].forEach((amb) => {
        if (!seenAmbTokens.has(amb.token)) {
          seenAmbTokens.add(amb.token);
          ambiguousNotes.push(amb);
        }
      });

      ambiguousNotes.forEach((amb) => {
        allClarifications.push({
          driverName: d.name,
          token: amb.token,
          candidates: amb.candidates,
          note: amb.note,
        });
        (amb.candidateScouts || []).forEach((c) => {
          const mentions = scoutAmbiguousMentions.get(c.originalName) || [];
          mentions.push(d.name);
          scoutAmbiguousMentions.set(c.originalName, mentions);
        });
      });
    } else {
      // Standard / unified parser
      const match = matchAttendeesInText(comment, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency, rosterScoutEntries, rosterAdultEntries, nameDictionary);
      matchedScouts = match.matchedScouts;
      matchedAdults = match.matchedAdults;
      ambiguousNotes = match.ambiguousNotes;

      // Extract clean note if comment starts with "Taking: ... ." or "Both (...): ... ."
      const takingMatch = comment.match(/^(?:Taking|Both(?:\s*\(\d+\))?):\s*([^.]+)\.?(.*)$/i);
      if (takingMatch) {
        cleanNote = (takingMatch[2] || '').trim();
      } else {
        // Strip matched rider names, driver name/surname, and boilerplate words to extract clean driver notes
        const riderWords = new Set();
        matchedScouts.forEach((sc) => {
          const scName = (typeof sc === 'string' ? sc : (sc.name || sc.displayName || '')).toLowerCase();
          scName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
            riderWords.add(w);
            (NICKNAMES[w] || []).forEach((n) => riderWords.add(n));
          });
          if (sc.originalName) {
            sc.originalName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
              riderWords.add(w);
              (NICKNAMES[w] || []).forEach((n) => riderWords.add(n));
            });
          }
        });
        matchedAdults.forEach((ad) => {
          const adName = (typeof ad === 'string' ? ad : (ad.name || ad.displayName || '')).toLowerCase();
          adName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
            riderWords.add(w);
            (NICKNAMES[w] || []).forEach((n) => riderWords.add(n));
          });
        });

        // Add driver's own name components so driver full name or surname is never treated as a special instruction
        if (driverFirst) {
          riderWords.add(driverFirst);
          (NICKNAMES[driverFirst] || []).forEach((n) => riderWords.add(n));
        }
        if (driverLast) {
          riderWords.add(driverLast);
        }
        if (d.name) {
          d.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => riderWords.add(w));
        }

        const boilerplate = new Set([
          'to', 'from', 'taking', 'takes', 'take', 'driving', 'drives', 'drive', 'with', 'and', 'seats',
          'seat', 'room', 'space', 'more', 'spots', 'spot', 'both', 'ways', 'way', 'only',
          'car', 'rides', 'ride', 'riding', 'for', 'scouts', 'scout', 'open', 'myself', 'self',
          'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
          'available', 'avaliable', 'return', 'trip', 'inbound', 'outbound', 'none', 'full', 'no',
          'driver', 'me', 'i', 'mom', 'dad', 'parent', 'chaperone', 'kids', 'kid', 'son', 'sons',
          'daughter', 'daughters', 'child', 'children', 'family', 'his', 'her', 'my', 'our', 'their',
        ]);

        function isFuzzyNameMatch(word, target) {
          if (!word || !target || word.length < 4 || target.length < 4) return false;
          if (word === target) return true;
          // Levenshtein distance 1 for typo tolerance (e.g. christana vs christina)
          if (Math.abs(word.length - target.length) > 1) return false;
          let diffs = 0;
          let i = 0, j = 0;
          while (i < word.length && j < target.length) {
            if (word[i] !== target[j]) {
              diffs++;
              if (diffs > 1) return false;
              if (word.length > target.length) i++;
              else if (target.length > word.length) j++;
              else { i++; j++; }
            } else {
              i++; j++;
            }
          }
          return true;
        }

        const sentences = comment.split(/(?<=[.!?])\s+/);
        const nonRiderSentences = [];
        for (const s of sentences) {
          const sNorm = s.toLowerCase().replace(/[^a-z0-9]/g, ' ');
          const words = sNorm.split(/\s+/).filter((w) => w.length > 2);
          const meaningfulWords = words.filter((w) => {
            if (boilerplate.has(w) || riderWords.has(w)) return false;
            if (driverFirst && isFuzzyNameMatch(w, driverFirst)) return false;
            if (driverLast && isFuzzyNameMatch(w, driverLast)) return false;
            return true;
          });
          if (meaningfulWords.length > 0) {
            nonRiderSentences.push(s.trim());
          }
        }
        cleanNote = nonRiderSentences.join(' ').replace(/^[.\s,;:]+|[.\s,;:]+$/g, '').trim();
      }

      const drivesTo = d.drivingToFrom === 'Both' || d.drivingToFrom === 'To' || !d.drivingToFrom;
      const drivesFrom = d.drivingToFrom === 'Both' || d.drivingToFrom === 'From' || !d.drivingToFrom;

      const bothSeatsMatch = comment.match(/^Both\s*\((?:(\d+)(?:\s*seats?)?)?\)/i);
      const effectiveCap = (bothSeatsMatch && bothSeatsMatch[1]) ? parseInt(bothSeatsMatch[1], 10) : passengerCapacity;
      toSeats = drivesTo ? effectiveCap : 0;
      fromSeats = drivesFrom ? effectiveCap : 0;

      claimedScoutsTo = drivesTo ? matchedScouts : [];
      claimedScoutsFrom = drivesFrom ? matchedScouts : [];
      claimedAdultsTo = drivesTo ? matchedAdults : [];
      claimedAdultsFrom = drivesFrom ? matchedAdults : [];
      claimedRidersTo = drivesTo ? (match.matchedRiders || []) : [];
      claimedRidersFrom = drivesFrom ? (match.matchedRiders || []) : [];

      matchedScouts.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        if (drivesTo) {
          cur.driverNameTo = d.name;
          cur.statusTo = sc.status;
          const list = scoutDriversTo.get(sc.originalName) || [];
          if (!list.includes(d.name)) list.push(d.name);
          scoutDriversTo.set(sc.originalName, list);
        }
        if (drivesFrom) {
          cur.driverNameFrom = d.name;
          cur.statusFrom = sc.status;
          const list = scoutDriversFrom.get(sc.originalName) || [];
          if (!list.includes(d.name)) list.push(d.name);
          scoutDriversFrom.set(sc.originalName, list);
        }
        scoutRideMap.set(sc.originalName, cur);
      });

      matchedAdults.forEach((ad) => claimedAdultsSet.add(ad));

      ambiguousNotes.forEach((amb) => {
        allClarifications.push({
          driverName: d.name,
          token: amb.token,
          candidates: amb.candidates,
          note: amb.note,
        });
        (amb.candidateScouts || []).forEach((c) => {
          const mentions = scoutAmbiguousMentions.get(c.originalName) || [];
          mentions.push(d.name);
          scoutAmbiguousMentions.set(c.originalName, mentions);
        });
      });
    }

    // Explicit open seats note check
    let explicitOpen = null;
    let explicitOpenNote = '';
    const openMatch = comment.match(/(?:and\s+)?(\d+)\s+(?:more|open|spots|extra|available|avaliable)/i)
      || comment.match(/(?:room|space)\s+for\s+(\d+)/i)
      || comment.match(/(\d+)\s+open\s+seats?/i)
      || comment.match(/(\d+)\s+seats?\s+(?:open|available|avaliable)/i);
    if (openMatch) {
      explicitOpen = parseInt(openMatch[1], 10);
      explicitOpenNote = openMatch[0];
    }

    const openSeatsTo = Math.max(0, toSeats - (claimedScoutsTo.length + claimedAdultsTo.length));
    const openSeatsFrom = Math.max(0, fromSeats - (claimedScoutsFrom.length + claimedAdultsFrom.length));
    const totalFilled = matchedScouts.length + matchedAdults.length + ambiguousNotes.length;
    const openSeats = explicitOpen !== null ? explicitOpen : Math.max(0, passengerCapacity - totalFilled);

    return {
      ...d,
      claimedScouts: matchedScouts,
      claimedAdults: matchedAdults,
      claimedScoutsTo,
      claimedScoutsFrom,
      claimedAdultsTo,
      claimedAdultsFrom,
      claimedRidersTo,
      claimedRidersFrom,
      claimedRiders: [...claimedRidersTo, ...claimedRidersFrom],
      toSeats,
      fromSeats,
      openSeatsTo: d.attending === 'Y' ? openSeatsTo : 0,
      openSeatsFrom: d.attending === 'Y' ? openSeatsFrom : 0,
      ambiguousNotes,
      openSeats: d.attending === 'Y' ? openSeats : 0,
      explicitOpenNote,
      cleanNote,
    };
  });

  const duplicateClaimsMap = new Map();
  scoutDriversTo.forEach((driversList, origName) => {
    if (driversList.length > 1) {
      const cur = duplicateClaimsMap.get(origName) || { scoutName: origName, driversTo: [], driversFrom: [] };
      cur.driversTo = driversList;
      duplicateClaimsMap.set(origName, cur);
    }
  });
  scoutDriversFrom.forEach((driversList, origName) => {
    if (driversList.length > 1) {
      const cur = duplicateClaimsMap.get(origName) || { scoutName: origName, driversTo: [], driversFrom: [] };
      cur.driversFrom = driversList;
      duplicateClaimsMap.set(origName, cur);
    }
  });

  const duplicateRiderClaims = Array.from(duplicateClaimsMap.values()).map((item) => {
    const isBoth = item.driversTo.length > 1 && item.driversFrom.length > 1;
    const direction = isBoth ? 'Both' : (item.driversTo.length > 1 ? 'TO' : 'FROM');
    const allDrivers = Array.from(new Set([...item.driversTo, ...item.driversFrom]));
    return {
      scoutName: item.scoutName,
      direction,
      drivers: allDrivers,
      driversTo: item.driversTo,
      driversFrom: item.driversFrom,
    };
  });

  const baseScoutOriginalNames = new Set(scouts.map((s) => s.name));
  const nonAttendingRosterScouts = [];

  scoutRideMap.forEach((rideInfo, scName) => {
    if (!baseScoutOriginalNames.has(scName)) {
      const rosterEntry = rosterScoutEntries.find((r) => r.originalName === scName);
      nonAttendingRosterScouts.push({
        name: scName,
        patrol: rosterEntry ? rosterEntry.patrol : '',
        comment: '',
        permissionGiven: '',
        medicalNeeded: '',
        bsaRegistered: 'Current',
        attending: 'N',
      });
    }
  });

  const allScoutsForEnrichment = [...scouts, ...nonAttendingRosterScouts];

  const enrichedScouts = allScoutsForEnrichment.map((s) => {
    const rideInfo = scoutRideMap.get(s.name);
    const ambiguousDrivers = scoutAmbiguousMentions.get(s.name);
    const driversToList = scoutDriversTo.get(s.name) || [];
    const driversFromList = scoutDriversFrom.get(s.name) || [];
    const isDuplicate = driversToList.length > 1 || driversFromList.length > 1;

    let rideStatus = 'unassigned';
    let assignedDriver = null;
    let assignedDriverTo = null;
    let assignedDriverFrom = null;
    let rideDirection = 'None';
    let rideNote = s.attending === 'N' ? 'Not Attending' : '';

    if (rideInfo) {
      assignedDriverTo = driversToList.join(' and ') || rideInfo.driverNameTo;
      assignedDriverFrom = driversFromList.join(' and ') || rideInfo.driverNameFrom;

      if (assignedDriverTo && assignedDriverFrom) {
        rideDirection = 'Both';
        rideStatus = isDuplicate ? 'duplicate' : (rideInfo.statusTo || rideInfo.statusFrom || 'confirmed');
        assignedDriver = assignedDriverTo === assignedDriverFrom
          ? assignedDriverTo
          : `${assignedDriverTo} / ${assignedDriverFrom}`;
      } else if (assignedDriverTo) {
        rideDirection = 'To';
        rideStatus = isDuplicate ? 'duplicate' : (rideInfo.statusTo || 'confirmed');
        assignedDriver = assignedDriverTo;
      } else if (assignedDriverFrom) {
        rideDirection = 'From';
        rideStatus = isDuplicate ? 'duplicate' : (rideInfo.statusFrom || 'confirmed');
        assignedDriver = assignedDriverFrom;
      }
    } else if (ambiguousDrivers && ambiguousDrivers.length > 0) {
      rideStatus = 'ambiguous';
      rideNote = `Mentioned without last name by ${ambiguousDrivers.join(', ')}`;
    }

    const nameEntry = nameDictionary ? (nameDictionary.get(s.name) || nameDictionary.get((s.name || '').toLowerCase())) : null;

    return {
      ...s,
      compactName: nameEntry ? nameEntry.compactName : s.name,
      displayName: nameEntry ? nameEntry.displayName : (s.displayName || s.name),
      assignedDriver,
      assignedDriverTo,
      assignedDriverFrom,
      rideDirection,
      rideStatus,
      rideNote,
      isDuplicate,
      duplicateDriversTo: driversToList.length > 1 ? driversToList : [],
      duplicateDriversFrom: driversFromList.length > 1 ? driversFromList : [],
    };
  });

  const assignedAttendingScoutsCount = Array.from(scoutRideMap.keys()).filter((name) => baseScoutOriginalNames.has(name)).length;

  return {
    enrichedDrivers,
    enrichedScouts,
    adultRidersCount: claimedAdultsSet.size,
    assignedScoutsCount: assignedAttendingScoutsCount,
    clarificationsNeeded: allClarifications,
    duplicateRiderClaims,
    nameMap: nameDictionary ? nameDictionary.toPlainObject() : {},
    nameDictionary,
  };
}

async function fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId }) {
  const url = new URL(
    `/FormReport.aspx?Menu_Item_ID=45931&Form_ID=259&ID=${eventId}&Stack=2&SectionID=${sectionId}&ReportFormat=CSV`,
    loginUrl,
  ).toString();

  try {
    const res = await client.get(url, {
      responseType: 'buffer',
      headers: { Referer: `${rootUrl}/Index.htm` },
      timeout: { request: 15000 },
    });

    const ctype = String(res.headers['content-type'] || '');
    if (res.statusCode >= 200 && res.statusCode < 300 && !ctype.includes('text/html')) {
      return res.body.toString('utf8');
    }
  } catch (err) {
    // Fallback: ignore or log
  }
  return '';
}

async function fetchEventCarpoolDetails({ eventId, forceRefresh = false }) {
  if (!eventId) {
    throw new Error('Event ID is required.');
  }

  // Note: Server-side carpool memory caching is shelved due to container lifecycle / spin-up characteristics on Render.
  // Every request fetches live from TroopWebHost, retaining activeCarpoolPromises to deduplicate concurrent in-flight requests.

  if (activeCarpoolPromises.has(eventId)) {
    return activeCarpoolPromises.get(eventId);
  }

  const fetchPromise = (async () => {
    const config = getTroopWebHostConfig();
    const session = await authenticateTroopWebHost(config);
    const { client, loginUrl, rootUrl } = session;

    // Fetch drivers (38199), adults (730), scouts (967), and adult training (1243) in parallel
    const [driversCsv, adultsCsv, scoutsCsv, adultTrainingMap] = await Promise.all([
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 38199 }),
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 730 }),
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 967 }),
      getAdultTrainingData(forceRefresh),
    ]);

    const rawDrivers = parseCsv(driversCsv);
    const rawAdults = parseCsv(adultsCsv);
    const rawScouts = parseCsv(scoutsCsv);

    // Get roster members map if available to enrich contact details
    let membersMap = new Map();
    let rosterMembers = [];
    try {
      const rosterData = await getRosterData(false);
      membersMap = rosterData.summary.membersByName;
      rosterMembers = Array.from(rosterData.summary.membersByName.values());
    } catch {
      // Enrichment is best-effort
    }

    const adults = rawAdults.map((row) => {
      const name = row.Participant || '';
      const rosterInfo = membersMap.get(name.toLowerCase()) || {};
      const trainingInfo = adultTrainingMap.get(name.toLowerCase()) || null;
      return {
        name,
        leadership: row.Leadership || rosterInfo.leadership || '',
        sytStatus: row['SYT Status'] || 'None',
        stateTraining: row['State Training'] || row['State Training Status'] || evaluateStateTrainingStatus(trainingInfo),
        registered: row['BSA Registered?'] || '',
        phone: rosterInfo.phone || '',
        email: rosterInfo.email || '',
        vehicle: rosterInfo.vehicle || '',
        licensePlate: rosterInfo.licensePlate || '',
      };
    });

    const baseScouts = rawScouts.map((row) => {
      const name = row.Participant || '';
      const rosterInfo = membersMap.get(name.toLowerCase()) || {};

      let bsaRegistered = 'No';
      const bsaEnds = rosterInfo.bsaRegistrationEnds || '';
      if (bsaEnds) {
        const endsDate = new Date(bsaEnds);
        if (!isNaN(endsDate.getTime()) && endsDate >= new Date()) {
          bsaRegistered = 'Current';
        } else if (!isNaN(endsDate.getTime())) {
          bsaRegistered = 'Expired';
        } else {
          bsaRegistered = rosterInfo.bsaId ? 'Current' : 'No';
        }
      } else if (rosterInfo.bsaId) {
        bsaRegistered = 'Current';
      }

      return {
        name,
        patrol: row.Patrol || rosterInfo.patrol || '',
        comment: row.Comment || '',
        permissionGiven: row['Permission Given?'] || '',
        medicalNeeded: row['Medical Forms Needed'] || '',
        medicalPartA: rosterInfo.medicalPartA || '',
        medicalPartB: rosterInfo.medicalPartB || '',
        medicalPartC: rosterInfo.medicalPartC || '',
        bsaRegistered,
        bsaId: rosterInfo.bsaId || '',
        bsaRegistrationEnds: bsaEnds,
        swimTest: rosterInfo.swimLevel || row['Swim Test'] || '',
        swimDate: rosterInfo.swimDate || '',
        age: rosterInfo.age || '',
        grade: rosterInfo.grade || '',
        rank: rosterInfo.rank || '',
        parentNames: rosterInfo.parentNames || '',
        parentPhone: rosterInfo.parentPhone || '',
        emergencyContact1: rosterInfo.emergencyContact1 || '',
        emergencyContact1Phone: rosterInfo.emergencyContact1Phone || '',
        emergencyContact2: rosterInfo.emergencyContact2 || '',
        emergencyContact2Phone: rosterInfo.emergencyContact2Phone || '',
        allergies: rosterInfo.allergies || '',
        dietary: rosterInfo.dietary || '',
      };
    });

    let totalSeatsOffered = 0;
    const baseDrivers = rawDrivers.map((row) => {
      const name = row.Participant || '';
      const seats = parseInt(row.Seats, 10) || 0;
      const attending = (row['Attending?'] || '').toUpperCase() === 'Y';
      const drivingToFrom = row['Driving To / From'] || '';
      const comment = row.Comment || '';

      if (attending && seats > 0) {
        totalSeatsOffered += Math.max(0, seats - 1);
      }

      const rosterInfo = membersMap.get(name.toLowerCase()) || {};
      const matchingAdult = adults.find((a) => a.name.toLowerCase() === name.toLowerCase());
      const trainingInfo = adultTrainingMap.get(name.toLowerCase()) || null;

      const sytStatus = row['SYT Status'] || matchingAdult?.sytStatus || 'None';
      const stateTraining = row['State Training'] || row['State Training Status'] || matchingAdult?.stateTraining || evaluateStateTrainingStatus(trainingInfo);
      const bsaRegistered = matchingAdult?.registered || 'No';
      const isCompliant = sytStatus.toLowerCase() === 'current' && stateTraining.toLowerCase() === 'current';

      return {
        name,
        attending: row['Attending?'] || 'N',
        drivingToFrom,
        seats,
        comment,
        phone: rosterInfo.phone || '',
        email: rosterInfo.email || '',
        registeredVehicle: rosterInfo.vehicle || '',
        leadership: matchingAdult?.leadership || rosterInfo.leadership || '',
        licensePlate: rosterInfo.licensePlate || '',
        driverLicense: rosterInfo.driverLicense || '',
        sytStatus,
        stateTraining,
        bsaRegistered,
        isCompliant,
      };
    });

    const nameDictionary = buildNameDictionary([
      ...(rosterMembers || []),
      ...baseScouts,
      ...adults,
      ...baseDrivers,
    ]);

    const {
      enrichedDrivers: drivers,
      enrichedScouts: scouts,
      adultRidersCount,
      assignedScoutsCount,
      clarificationsNeeded,
      duplicateRiderClaims,
      nameMap,
    } = parseDriverComments(baseDrivers, baseScouts, adults, rosterMembers, nameDictionary);

    const totalAttendingScouts = scouts.filter((s) => s.attending !== 'N').length;
    const totalAttendingAdults = adults.length;
    const totalAttendees = totalAttendingScouts + totalAttendingAdults;
    const unassignedScoutsCount = Math.max(0, totalAttendingScouts - assignedScoutsCount);
    const totalOpenSeats = drivers
      .filter((d) => d.attending === 'Y')
      .reduce((sum, d) => sum + (d.openSeats || 0), 0);

    const nonCompliantDriversCount = drivers
      .filter((d) => !d.isCompliant).length;

    // Scout-centric seat balance: passenger seats offered vs (scouts + adult ride-alongs)
    const seatBalance = totalSeatsOffered - (totalAttendingScouts + adultRidersCount);

    let meta = {
      id: eventId,
      title: `Event #${eventId}`,
      eventType: 'Troop Event',
      location: '',
      mapLink: '',
      start: '',
      end: '',
    };

    try {
      let eventsList = cache.events;
      if (!eventsList || eventsList.length === 0) {
        eventsList = await fetchUpcomingEvents({ days: 365 });
      }
      const found = (eventsList || []).find((e) => String(e.id) === String(eventId));
      if (found) {
        meta = {
          id: found.id,
          title: found.title || `Event #${eventId}`,
          eventType: found.eventType || 'Troop Event',
          location: found.location || '',
          mapLink: found.mapLink || '',
          start: found.start || '',
          end: found.end || '',
        };
      }
    } catch {
      // Best-effort metadata enrichment
    }

    try {
      const config = getTroopWebHostConfig();
      const origin = new URL(config.troopUrl).origin;
      meta.twhEventUrl = `${origin}/FormDetail.aspx?Menu_Item_ID=45922&Form_ID=5429&Stack=0&Application_ID=2858&ID=${eventId}`;
      meta.twhSignupUrl = `${origin}/FormDetail.aspx?Menu_Item_ID=45926&Form_ID=3707&FK=0&ID=${eventId}&Stack=0`;
    } catch {
      // Best-effort TWH URL generation
    }

    const result = {
      eventId,
      meta,
      stats: {
        totalDrivers: drivers.filter((d) => d.seats > 0 && d.attending === 'Y').length,
        totalSeatsOffered,
        totalOpenSeats,
        totalAttendingScouts,
        assignedScoutsCount,
        unassignedScoutsCount,
        totalAttendingAdults,
        adultRidersCount,
        totalAttendees,
        seatBalance,
        nonCompliantDriversCount,
        clarificationsNeeded,
        duplicateRiderClaims,
      },
      duplicateRiderClaims,
      drivers,
      adults,
      scouts,
      roster: (rosterMembers || []).map((m) => ({
        name: m.name,
        isAdult: Boolean(m.isAdult),
        patrol: m.patrol || '',
      })),
      nameMap: nameMap || nameDictionary.toPlainObject(),
      cachedAt: new Date().toISOString(),
    };

    cache.carpoolByEventId.set(eventId, { data: result, timestamp: Date.now() });
    return result;
  })();

  activeCarpoolPromises.set(eventId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    activeCarpoolPromises.delete(eventId);
  }
}

// Routes
app.post('/api/auth/token', (req, res) => {
  const { appKey, password } = req.body || {};
  const expectedKey = process.env.TROOP_APP_KEY || TROOP_APP_KEY;
  const expectedPassword = process.env.COORDINATOR_PASSWORD;

  if (password && typeof password === 'string') {
    const passBuf = Buffer.from(password);
    const expBuf = Buffer.from(expectedPassword);
    const isValid = passBuf.length === expBuf.length && crypto.timingSafeEqual(passBuf, expBuf);

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect coordinator password.' });
    }

    const now = Date.now();
    const expiresInMs = COORDINATOR_IDLE_TIMEOUT_MS;
    const payload = {
      role: 'coordinator',
      authAt: now,
      exp: now + expiresInMs,
    };
    const token = createSignedToken(payload);

    return res.status(200).json({
      ok: true,
      token,
      role: 'coordinator',
      expiresIn: Math.floor(expiresInMs / 1000),
      expiresInMs,
      expiresAt: payload.exp,
      authAt: payload.authAt,
      maxSessionMs: COORDINATOR_MAX_SESSION_MS,
      idleTimeoutMs: COORDINATOR_IDLE_TIMEOUT_MS,
    });
  }

  if (appKey && typeof appKey === 'string') {
    const keyBuf = Buffer.from(appKey);
    const expKeyBuf = Buffer.from(expectedKey);
    const isValid = keyBuf.length === expKeyBuf.length && crypto.timingSafeEqual(keyBuf, expKeyBuf);

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect troop application key.' });
    }

    const now = Date.now();
    const expiresInMs = VIEWER_SESSION_TIMEOUT_MS;
    const payload = {
      role: 'viewer',
      authAt: now,
      exp: now + expiresInMs,
    };
    const token = createSignedToken(payload);

    return res.status(200).json({
      ok: true,
      token,
      role: 'viewer',
      expiresIn: Math.floor(expiresInMs / 1000),
      expiresInMs,
      expiresAt: payload.exp,
      authAt: payload.authAt,
    });
  }

  return res.status(400).json({ error: 'Either appKey or password is required.' });
});

app.post('/api/auth/coordinator-login', (req, res) => {
  const { password } = req.body || {};
  const expectedPassword = process.env.COORDINATOR_PASSWORD;

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required.' });
  }

  const passBuf = Buffer.from(password);
  const expBuf = Buffer.from(expectedPassword);
  const isValid = passBuf.length === expBuf.length && crypto.timingSafeEqual(passBuf, expBuf);

  if (!isValid) {
    return res.status(401).json({ error: 'Incorrect coordinator password.' });
  }

  const now = Date.now();
  const expiresInMs = COORDINATOR_IDLE_TIMEOUT_MS;
  const payload = {
    role: 'coordinator',
    authAt: now,
    exp: now + expiresInMs,
  };
  const token = createSignedToken(payload);

  return res.status(200).json({
    ok: true,
    token,
    role: 'coordinator',
    expiresIn: Math.floor(expiresInMs / 1000),
    expiresInMs,
    expiresAt: payload.exp,
    authAt: payload.authAt,
    maxSessionMs: COORDINATOR_MAX_SESSION_MS,
    idleTimeoutMs: COORDINATOR_IDLE_TIMEOUT_MS,
  });
});

app.post('/api/auth/refresh', (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Session token required for refresh.' });
  }

  const payload = verifySignedToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired session token. Please re-enter the coordinator password.' });
  }

  const now = Date.now();
  const authAt = payload.authAt || (payload.exp ? payload.exp - COORDINATOR_IDLE_TIMEOUT_MS : now);
  if (now - authAt > COORDINATOR_MAX_SESSION_MS) {
    return res.status(401).json({ error: 'Session exceeded maximum allowed duration (24-hour cap). Please re-enter the coordinator password.' });
  }

  const isCoord = payload.role === 'coordinator';
  const expiresInMs = isCoord ? COORDINATOR_IDLE_TIMEOUT_MS : VIEWER_SESSION_TIMEOUT_MS;
  const newPayload = {
    ...payload,
    authAt,
    exp: now + expiresInMs,
  };
  const newToken = createSignedToken(newPayload);

  return res.status(200).json({
    ok: true,
    token: newToken,
    role: payload.role,
    expiresIn: Math.floor(expiresInMs / 1000),
    expiresInMs,
    expiresAt: newPayload.exp,
    authAt,
    maxSessionMs: COORDINATOR_MAX_SESSION_MS,
    idleTimeoutMs: COORDINATOR_IDLE_TIMEOUT_MS,
  });
});

app.post('/api/export-roster', requireAppAuth, async (req, res) => {
  const { forceRefresh } = req.body || {};

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const data = await getRosterData(Boolean(forceRefresh));
    return sendDownload(res, data.buffer, data.fresh);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Scrape failed.' });
  }
});

app.get('/api/roster/summary', requireAppAuth, async (req, res) => {
  const { forceRefresh } = req.query;

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const data = await getRosterData(forceRefresh === 'true');
    return res.status(200).json({
      totalMembers: data.summary.totalMembers,
      scoutsCount: data.summary.scoutsCount,
      adultsCount: data.summary.adultsCount,
      cachedAt: data.cachedAt,
      fresh: data.fresh,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to retrieve roster summary.' });
  }
});

app.get('/api/events', requireAppAuth, async (req, res) => {
  const days = req.query.days ? parseInt(req.query.days, 10) : 90;
  const forceRefresh = req.query.forceRefresh === 'true';

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const events = await fetchUpcomingEvents({ days, forceRefresh });
    return res.status(200).json({ events });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to retrieve upcoming events.' });
  }
});

app.get('/api/events/:id/carpool', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  const forceRefresh = req.query.forceRefresh === 'true';

  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh });
    return res.status(200).json(carpool);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to retrieve event carpool details.' });
  }
});

app.get('/api/events/:id/carpool.xlsx', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  const forceRefresh = req.query.forceRefresh === 'true';

  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh });
    let rosterSummary = null;
    try {
      const rosterData = await getRosterData(false);
      rosterSummary = rosterData.summary;
    } catch {
      // Best-effort roster lookup
    }

    const workbook = await buildCarpoolWorkbook(carpool, rosterSummary);

    const safeTitle = (carpool.meta?.title || 'event').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="carpool_${eventId}_${safeTitle}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate carpool spreadsheet.' });
  }
});

app.post('/api/events/:id/carpool.xlsx', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh: false });
    let rosterSummary = null;
    try {
      const rosterData = await getRosterData(false);
      rosterSummary = rosterData.summary;
    } catch {
      // Best-effort roster lookup
    }

    const customState = req.body || null;
    const workbook = await buildCarpoolWorkbook(carpool, rosterSummary, customState);

    const safeTitle = (carpool.meta?.title || 'event').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="carpool_${eventId}_${safeTitle}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate carpool spreadsheet.' });
  }
});

app.get('/api/events/:id/tabular.xlsx', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  const forceRefresh = req.query.forceRefresh === 'true';

  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh });
    let rosterSummary = null;
    try {
      const rosterData = await getRosterData(false);
      rosterSummary = rosterData.summary;
    } catch {
      // Best-effort roster lookup
    }

    const columns = req.query.columns ? req.query.columns.split(',').map(c => c.trim()).filter(Boolean) : null;
    const splitTripLegs = req.query.splitTripLegs !== 'false';
    const includeOpenSeats = req.query.includeOpenSeats !== 'false';
    const includeUnassigned = req.query.includeUnassigned !== 'false';

    const workbook = await buildTabularWorkbook(carpool, rosterSummary, null, {
      columns,
      splitTripLegs,
      includeOpenSeats,
      includeUnassigned,
    });

    const safeTitle = (carpool.meta?.title || 'event').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="carpool_tabular_${eventId}_${safeTitle}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate tabular carpool spreadsheet.' });
  }
});

app.post('/api/events/:id/tabular.xlsx', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh: false });
    let rosterSummary = null;
    try {
      const rosterData = await getRosterData(false);
      rosterSummary = rosterData.summary;
    } catch {
      // Best-effort roster lookup
    }

    const { customState, columns, splitTripLegs, includeOpenSeats, includeUnassigned } = req.body || {};

    const workbook = await buildTabularWorkbook(carpool, rosterSummary, customState, {
      columns,
      splitTripLegs: splitTripLegs !== false,
      includeOpenSeats: includeOpenSeats !== false,
      includeUnassigned: includeUnassigned !== false,
    });

    const safeTitle = (carpool.meta?.title || 'event').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="carpool_tabular_${eventId}_${safeTitle}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate tabular carpool spreadsheet.' });
  }
});

function normalizeCommentForComparison(c) {
  if (!c || typeof c !== 'string') return '';
  return c
    .trim()
    .replace(/\s+/g, ' ')                          // collapse multiple whitespace
    .replace(/\.{2,}/g, '.')                       // collapse .. to .
    .replace(/\b([A-Za-z]+ [A-Z])\.(?=[,\s]|$)/g, '$1') // normalize initial period (Iris K. -> Iris K)
    .replace(/[.,;:]+$/, '')                       // strip trailing punctuation
    .replace(/\b(both|to|from)\b/gi, (m) => m.toUpperCase()) // normalize trip leg casing
    .trim();
}

function areCommentsFunctionallyEquivalent(c1, c2) {
  if (!c1 && !c2) return true;
  if (!c1 || !c2) return false;
  return normalizeCommentForComparison(c1).toLowerCase() === normalizeCommentForComparison(c2).toLowerCase();
}

async function updateEventDriverInTWH({
  eventId,
  driverName,
  updatedComment,
  passengerSeats,
  drivingToFrom,
  isDriver,
  baselineComment,
  force = false,
}) {
  const config = getTroopWebHostConfig();
  const session = await authenticateTroopWebHost(config);
  const { client, rootUrl, loginUrl } = session;

  const signupDetailUrl = new URL(
    `/FormDetail.aspx?Menu_Item_ID=45926&Form_ID=3707&FK=0&ID=${eventId}&Stack=2`,
    loginUrl,
  ).toString();

  const getRes = await client.get(signupDetailUrl, {
    headers: { Referer: `${rootUrl}/Index.htm` },
    timeout: { request: 25000 },
  });

  const $ = cheerio.load(getRes.body);
  const form = $('form#easyform');
  const actionUrl = new URL(form.attr('action') || '/FormDetail.aspx', signupDetailUrl).toString();

  function normName(n) {
    return (n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  let targetPrefix = null;
  let currentLiveComment = '';
  let foundMemberName = '';

  $('tr').each((_, tr) => {
    const $tr = $(tr);
    let rowName = '';
    $tr.find('span').each((_, span) => {
      if ($(span).text().trim().toLowerCase() === 'name') {
        const nextDiv = $(span).nextAll('div').first();
        if (nextDiv.length > 0) {
          rowName = nextDiv.text().trim();
        }
      }
    });

    if (rowName && (normName(rowName) === normName(driverName) || rowName.includes(driverName))) {
      foundMemberName = rowName;
      $tr.find('input').each((_, inp) => {
        const name = $(inp).attr('name') || '';
        const match = name.match(/^(CB\d+ROW\d+)DATA/);
        if (match) {
          targetPrefix = match[1];
        }
      });
      if (targetPrefix) {
        currentLiveComment = $tr.find(`input[name="${targetPrefix}DATA73079"]`).val() || '';
      }
    }
  });

  if (!targetPrefix) {
    throw new Error(`Driver "${driverName}" was not found in the TroopWebHost event sign-up table.`);
  }

  // Dirty / Conflict check
  const normLive = normalizeCommentForComparison(currentLiveComment);
  const normProposed = normalizeCommentForComparison(updatedComment);
  const normBaseline = normalizeCommentForComparison(baselineComment);

  const isLiveMatchingProposed = normLive === normProposed;
  const isLiveMatchingBaseline = normLive === normBaseline;

  if (!force && baselineComment !== undefined && !isLiveMatchingProposed && !isLiveMatchingBaseline) {
    return {
      conflict: true,
      driverName: foundMemberName,
      liveComment: currentLiveComment,
      proposedComment: updatedComment,
      message: `Conflict detected: ${foundMemberName}'s comment in TWH is "${currentLiveComment}", which differs from your baseline "${baselineComment}".`,
    };
  }

  const commentInputName = `${targetPrefix}DATA73079`;
  const seatsInputName = `${targetPrefix}DATA159284`;
  const directionInputName = `${targetPrefix}DATA159283`;
  const driverCheckboxName = `${targetPrefix}DATA73081`;

  const payload = {};

  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name || $el.is(':disabled')) return;

    const type = ($el.attr('type') || el.tagName).toLowerCase();

    // Overrides for target driver
    if (name === commentInputName) {
      if (updatedComment !== undefined) {
        payload[name] = updatedComment;
        return;
      }
    }
    if (name === seatsInputName) {
      if (passengerSeats !== undefined) {
        const pSeats = parseInt(passengerSeats, 10) || 0;
        payload[name] = pSeats > 0 ? String(pSeats + 1) : '0';
        return;
      }
    }
    if (name === directionInputName) {
      if (drivingToFrom !== undefined) {
        payload[name] = drivingToFrom;
        return;
      }
    }
    if (name === driverCheckboxName) {
      if (isDriver !== undefined || passengerSeats !== undefined) {
        const pSeats = passengerSeats !== undefined ? (parseInt(passengerSeats, 10) || 0) : 1;
        const wantDriver = isDriver !== undefined ? Boolean(isDriver) : true;
        payload[name] = (wantDriver && pSeats > 0) ? 'Y' : '';
        return;
      }
    }

    if (type === 'radio') {
      if ($el.attr('checked') !== undefined) {
        payload[name] = $el.val() || '';
      }
    } else if (type === 'checkbox') {
      if ($el.attr('checked') !== undefined) {
        payload[name] = $el.val() || 'Y';
      }
    } else if (type === 'submit' || type === 'button') {
      // omit
    } else {
      payload[name] = $el.val() || '';
    }
  });

  payload.Selected_Action = 'save exit';
  payload.Selected_Button_ID = 'BUTTON36';

  const postRes = await client.post(actionUrl, {
    form: payload,
    followRedirect: false,
    headers: { Referer: signupDetailUrl },
    timeout: { request: 25000 },
  });

  const isRedirect = postRes.statusCode === 302 || Boolean(postRes.headers?.location);
  const isInitError = (postRes.body && typeof postRes.body === 'string' && postRes.body.includes('Initialization Error'));

  if (!isRedirect || isInitError) {
    const detail = isInitError
      ? 'TroopWebHost rejected the update with an "Initialization Error" (comment exceeds 100-character limit or session timed out).'
      : `TroopWebHost did not save the changes (returned HTTP ${postRes.statusCode}).`;
    throw new Error(`Failed to update driver in TroopWebHost: ${detail}`);
  }

  cache.carpoolByEventId.delete(String(eventId));

  return {
    success: true,
    conflict: false,
    driverName: foundMemberName,
    updatedComment,
    passengerSeats,
    drivingToFrom,
    statusCode: postRes.statusCode,
  };
}

app.post('/api/events/:id/driver-update', requireCoordinatorAuth, async (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  const {
    driverName,
    updatedComment,
    passengerSeats,
    drivingToFrom,
    isDriver,
    baselineComment,
    force,
  } = req.body || {};

  if (!driverName) {
    return res.status(400).json({ error: 'driverName is required.' });
  }

  if (updatedComment && typeof updatedComment === 'string' && updatedComment.length > 100) {
    return res.status(400).json({
      error: `Comment length (${updatedComment.length} characters) exceeds TroopWebHost's 100-character maximum limit. Please trim the comment.`,
    });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const result = await updateEventDriverInTWH({
      eventId,
      driverName,
      updatedComment,
      passengerSeats,
      drivingToFrom,
      isDriver,
      baselineComment,
      force: Boolean(force),
    });

    if (result.conflict) {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update driver in TroopWebHost.' });
  }
});

app.get('/api/events/:id/twh-status', requireAppAuth, async (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).json({ error: 'Valid numeric event ID is required.' });
  }

  try {
    getTroopWebHostConfig();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  try {
    const carpool = await fetchEventCarpoolDetails({ eventId, forceRefresh: true });
    const signature = (carpool.drivers || [])
      .map((d) => `${d.name}:${d.seats}:${d.drivingToFrom}:${d.comment}`)
      .join('|');

    return res.json({
      eventId,
      driverCount: carpool.drivers?.length || 0,
      scoutCount: carpool.scouts?.length || 0,
      totalSeatsOffered: carpool.stats?.totalSeatsOffered || 0,
      signature,
      timestamp: Date.now(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to fetch event status.' });
  }
});

// Friendly redirect routes
app.get('/carpool/:id', (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).send('Invalid event ID');
  }
  return res.redirect(`/carpool.html?id=${encodeURIComponent(eventId)}`);
});

app.get('/coordinator/:id', (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).send('Invalid event ID');
  }
  return res.redirect(`/coordinator.html?id=${encodeURIComponent(eventId)}`);
});

app.get('/manager', (req, res) => {
  return res.redirect('/manager.html');
});

export {
  app,
  authenticateTroopWebHost,
  downloadRosterExport,
  parseCsv,
  computeRosterSummary,
  parseDriverComments,
  getRosterData,
  getAdultTrainingData,
  fetchUpcomingEvents,
  fetchEventCarpoolDetails,
  updateEventDriverInTWH,
  firstMatches,
  NICKNAMES,
  buildTabularWorkbook,
  createSignedToken,
  verifySignedToken,
  requireRole,
  normalizeCommentForComparison,
  areCommentsFunctionallyEquivalent,
  buildNameDictionary,
  COORDINATOR_IDLE_TIMEOUT_MS,
  COORDINATOR_MAX_SESSION_MS,
  COORDINATOR_IDLE_TIMEOUT_MINUTES,
  COORDINATOR_MAX_SESSION_HOURS,
};

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });
}
