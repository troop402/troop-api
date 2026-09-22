import express from 'express';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { buildCarpoolWorkbook } from './excel-export.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const cache = {
  rosterBuffer: null,
  rosterSummary: null,
  rosterTimestamp: 0,
  rosterTtlMs: 12 * 60 * 60 * 1000, // 12 hours

  events: null,
  eventsTimestamp: 0,
  eventsTtlMs: 2 * 60 * 60 * 1000, // 2 hours

  carpoolByEventId: new Map(), // eventId -> { data, timestamp }
  carpoolTtlMs: 15 * 60 * 1000, // 15 minutes

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
      membersByName.set(name.toLowerCase(), {
        name,
        isAdult,
        leadership: row.Leadership || '',
        patrol: row.Patrol || '',
        rank: row.Rank || '',
        phone: row['Cell Phone'] || row['Home Phone'] || '',
        email: row.Email || '',
        seatBelts: parseInt(row['Seat Belts'], 10) || 0,
        vehicle: row['Make/Model/Year'] || '',
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
  if (!trainingInfo) return 'Missing';
  if (trainingInfo.hasAb506 && trainingInfo.hasLiveScan) {
    return 'Current';
  }
  if (trainingInfo.hasAb506 && !trainingInfo.hasLiveScan) {
    return 'Missing Live Scan';
  }
  if (!trainingInfo.hasAb506 && trainingInfo.hasLiveScan) {
    return 'Missing AB-506';
  }
  return 'Missing';
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
  madi: ['madison', 'madelaine', 'madeline'],
  maddie: ['madison', 'madelaine', 'madeline'],
  madison: ['madi', 'maddie'],
  madeline: ['madi', 'maddie'],
  madelaine: ['madi', 'maddie'],
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


function matchAttendeesInText(text, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency) {
  if (!text || typeof text !== 'string') {
    return { matchedScouts: [], matchedAdults: [], ambiguousNotes: [] };
  }

  const matchedScouts = [];
  const matchedAdults = [];
  const ambiguousNotes = [];
  const checkedFirstNames = new Set();
  const consumedTokens = new Set();

  ['myself', 'me', 'i', driverFirst, ...(NICKNAMES[driverFirst] || [])].forEach((tok) => {
    consumedTokens.add(tok.toLowerCase());
  });

  // Match attending scouts with ambiguity & family detection
  for (const sc of scoutEntries) {
    if (sc.first === driverFirst && sc.last === driverLast) continue;

    const hasFullName = sc.last && text.toLowerCase().includes(sc.last) && (
      text.toLowerCase().includes(sc.first) ||
      (NICKNAMES[sc.first] || []).some((n) => new RegExp(`\\b${n}\\b`, 'i').test(text))
    );

    if (hasFullName) {
      checkedFirstNames.add(sc.first);
      consumedTokens.add(sc.first);
      (NICKNAMES[sc.first] || []).forEach((n) => consumedTokens.add(n));
      if (!matchedScouts.some((m) => m.name === sc.displayName)) {
        matchedScouts.push({
          name: sc.displayName,
          originalName: sc.originalName,
          status: 'confirmed',
          note: 'Full name matched',
        });
      }
    } else if (sc.first.length > 2 && !checkedFirstNames.has(sc.first)) {
      // Check exact first name or recognized nicknames
      const testTokens = [sc.first, ...(NICKNAMES[sc.first] || [])];
      const matchedToken = testTokens.find((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(text));

      if (matchedToken) {
        checkedFirstNames.add(sc.first);
        consumedTokens.add(matchedToken);
        consumedTokens.add(sc.first);
        const candidates = firstNameFrequency.get(sc.first) || [];

        if (candidates.length === 1) {
          const singleScout = candidates[0];
          if (!matchedScouts.some((m) => m.name === singleScout.displayName)) {
            matchedScouts.push({
              name: singleScout.displayName,
              originalName: singleScout.originalName,
              status: 'unique_first',
              note: 'Unique first name',
            });
          }
        } else {
          // Collision: multiple candidates share first name
          const familyCandidate = candidates.find((c) => c.last === driverLast);
          if (familyCandidate) {
            if (!matchedScouts.some((m) => m.name === familyCandidate.displayName)) {
              matchedScouts.push({
                name: familyCandidate.displayName,
                originalName: familyCandidate.originalName,
                status: 'family_match',
                note: `Family match with driver`,
              });
            }
          } else {
            // Ambiguous collision
            const candidateNames = candidates.map((c) => c.displayName);
            const warningMsg = `Ambiguous "${matchedToken}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
            ambiguousNotes.push({
              token: matchedToken,
              candidates: candidateNames,
              candidateScouts: candidates,
              note: warningMsg,
            });
          }
        }
      }
    }
  }

  // Match attending adults (e.g. husband/wife or leader riding as passenger)
  for (const ad of adultEntries) {
    if (ad.first === driverFirst && ad.last === driverLast) continue;
    if (matchedScouts.some((m) => m.name === ad.displayName)) continue;

    const adFirst = ad.first;
    const adLast = ad.last;
    const isFamily = adLast && adLast === driverLast;

    // Check full name match first
    const hasFullName = adLast && text.toLowerCase().includes(adLast) && (
      text.toLowerCase().includes(adFirst) ||
      (NICKNAMES[adFirst] || []).some((n) => new RegExp(`\\b${n}\\b`, 'i').test(text))
    );

    if (hasFullName) {
      if (!matchedAdults.includes(ad.displayName)) {
        matchedAdults.push(ad.displayName);
        consumedTokens.add(adFirst);
        (NICKNAMES[adFirst] || []).forEach((n) => consumedTokens.add(n));
      }
      continue;
    }

    // Check first name or nicknames (ensuring token wasn't already consumed by scout)
    const possibleNames = [adFirst, ...(NICKNAMES[adFirst] || [])];
    for (const pName of possibleNames) {
      if (pName.length < 2) continue;
      if (consumedTokens.has(pName)) continue;

      const regex = new RegExp(`\\b${pName}\\b`, 'i');
      if (regex.test(text)) {
        const adultCandidates = adultEntries.filter(
          (other) => (other.first === adFirst || (NICKNAMES[other.first] || []).includes(pName)) &&
                     !(other.first === driverFirst && other.last === driverLast)
        );

        if (adultCandidates.length === 1 || isFamily) {
          if (!matchedAdults.includes(ad.displayName)) {
            matchedAdults.push(ad.displayName);
            consumedTokens.add(pName);
            consumedTokens.add(adFirst);
          }
          break;
        }
      }
    }
  }

  return { matchedScouts, matchedAdults, ambiguousNotes };
}

function parseDriverComments(drivers, scouts, adults) {
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

  const scoutRideMap = new Map();
  const scoutAmbiguousMentions = new Map();
  const claimedAdultsSet = new Set();
  const allClarifications = [];

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

    // Check if the comment follows structured discrete TO/FROM notation
    const hasDiscrete = /(?:TO\s*(?:\([^)]*\)|only)|FROM\s*(?:\([^)]*\)|only))/i.test(comment);

    let matchedScouts = [];
    let matchedAdults = [];
    let claimedScoutsTo = [];
    let claimedScoutsFrom = [];
    let claimedAdultsTo = [];
    let claimedAdultsFrom = [];
    let toSeats = passengerCapacity;
    let fromSeats = passengerCapacity;
    let ambiguousNotes = [];
    let cleanNote = '';

    if (hasDiscrete) {
      // Discrete parser: TO (...): ... FROM (...): ...
      let toText = '';
      let fromText = '';

      const fromBlockMatch = comment.match(/FROM(?:\s*only)?(?:\s*\((?:(\d+)\s*seats?)?\))?\s*:\s*([^]*?)$/i);
      if (fromBlockMatch) {
        if (fromBlockMatch[1]) fromSeats = parseInt(fromBlockMatch[1], 10);
        const rawFrom = (fromBlockMatch[2] || '').trim();
        const dotSplit = rawFrom.match(/^(.*?\.)\s+([^.]*.*)$/);
        if (dotSplit) {
          fromText = dotSplit[1].trim();
          cleanNote = dotSplit[2].trim();
        } else {
          fromText = rawFrom;
        }
      }

      const toBlockMatch = comment.match(/TO(?:\s*only)?(?:\s*\((?:(\d+)\s*seats?)?\))?\s*:\s*([^]*?)(?=(?:FROM(?:\s*only)?(?:\s*\([^)]*\))?\s*:|$))/i);
      if (toBlockMatch) {
        if (toBlockMatch[1]) toSeats = parseInt(toBlockMatch[1], 10);
        const rawTo = (toBlockMatch[2] || '').trim();
        if (!fromBlockMatch) {
          const dotSplit = rawTo.match(/^(.*?\.)\s+([^.]*.*)$/);
          if (dotSplit) {
            toText = dotSplit[1].trim();
            cleanNote = dotSplit[2].trim();
          } else {
            toText = rawTo;
          }
        } else {
          toText = rawTo;
        }
      }

      const toMatch = matchAttendeesInText(toText, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency);
      const fromMatch = matchAttendeesInText(fromText, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency);

      claimedScoutsTo = toMatch.matchedScouts;
      claimedAdultsTo = toMatch.matchedAdults;
      claimedScoutsFrom = fromMatch.matchedScouts;
      claimedAdultsFrom = fromMatch.matchedAdults;

      // Register TO scouts in scoutRideMap
      claimedScoutsTo.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        cur.driverNameTo = d.name;
        cur.statusTo = sc.status;
        scoutRideMap.set(sc.originalName, cur);
      });

      // Register FROM scouts in scoutRideMap
      claimedScoutsFrom.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        cur.driverNameFrom = d.name;
        cur.statusFrom = sc.status;
        scoutRideMap.set(sc.originalName, cur);
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

      ambiguousNotes = [...toMatch.ambiguousNotes, ...fromMatch.ambiguousNotes];
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
      const match = matchAttendeesInText(comment, driverFirst, driverLast, scoutEntries, adultEntries, firstNameFrequency);
      matchedScouts = match.matchedScouts;
      matchedAdults = match.matchedAdults;
      ambiguousNotes = match.ambiguousNotes;

      // Extract clean note if comment starts with "Taking: ... ."
      const takingMatch = comment.match(/^Taking:\s*([^.]+)\.?(.*)$/i);
      cleanNote = takingMatch ? (takingMatch[2] || '').trim() : comment;

      const drivesTo = d.drivingToFrom === 'Both' || d.drivingToFrom === 'To' || !d.drivingToFrom;
      const drivesFrom = d.drivingToFrom === 'Both' || d.drivingToFrom === 'From' || !d.drivingToFrom;

      toSeats = drivesTo ? passengerCapacity : 0;
      fromSeats = drivesFrom ? passengerCapacity : 0;

      claimedScoutsTo = drivesTo ? matchedScouts : [];
      claimedScoutsFrom = drivesFrom ? matchedScouts : [];
      claimedAdultsTo = drivesTo ? matchedAdults : [];
      claimedAdultsFrom = drivesFrom ? matchedAdults : [];

      matchedScouts.forEach((sc) => {
        const cur = scoutRideMap.get(sc.originalName) || { driverNameTo: null, driverNameFrom: null, statusTo: null, statusFrom: null };
        if (drivesTo) {
          cur.driverNameTo = d.name;
          cur.statusTo = sc.status;
        }
        if (drivesFrom) {
          cur.driverNameFrom = d.name;
          cur.statusFrom = sc.status;
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
    const openMatch = comment.match(/(?:and\s+)?(\d+)\s+(?:more|open|spots|extra|seats)/i)
      || comment.match(/(?:room|space)\s+for\s+(\d+)/i);
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

  const enrichedScouts = scouts.map((s) => {
    const rideInfo = scoutRideMap.get(s.name);
    const ambiguousDrivers = scoutAmbiguousMentions.get(s.name);

    let rideStatus = 'unassigned';
    let assignedDriver = null;
    let assignedDriverTo = null;
    let assignedDriverFrom = null;
    let rideDirection = 'None';
    let rideNote = '';

    if (rideInfo) {
      assignedDriverTo = rideInfo.driverNameTo;
      assignedDriverFrom = rideInfo.driverNameFrom;

      if (assignedDriverTo && assignedDriverFrom) {
        rideDirection = 'Both';
        rideStatus = rideInfo.statusTo || rideInfo.statusFrom || 'confirmed';
        assignedDriver = assignedDriverTo === assignedDriverFrom
          ? assignedDriverTo
          : `${assignedDriverTo} / ${assignedDriverFrom}`;
      } else if (assignedDriverTo) {
        rideDirection = 'To';
        rideStatus = rideInfo.statusTo || 'confirmed';
        assignedDriver = assignedDriverTo;
      } else if (assignedDriverFrom) {
        rideDirection = 'From';
        rideStatus = rideInfo.statusFrom || 'confirmed';
        assignedDriver = assignedDriverFrom;
      }
    } else if (ambiguousDrivers && ambiguousDrivers.length > 0) {
      rideStatus = 'ambiguous';
      rideNote = `Mentioned without last name by ${ambiguousDrivers.join(', ')}`;
    }

    return {
      ...s,
      assignedDriver,
      assignedDriverTo,
      assignedDriverFrom,
      rideDirection,
      rideStatus,
      rideNote,
    };
  });

  return {
    enrichedDrivers,
    enrichedScouts,
    adultRidersCount: claimedAdultsSet.size,
    assignedScoutsCount: scoutRideMap.size,
    clarificationsNeeded: allClarifications,
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

  const cached = cache.carpoolByEventId.get(eventId);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < cache.carpoolTtlMs) {
    return cached.data;
  }

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
    try {
      const rosterData = await getRosterData(false);
      membersMap = rosterData.summary.membersByName;
    } catch {
      // Enrichment is best-effort
    }

    const adults = rawAdults.map((row) => {
      const name = row.Participant || '';
      const trainingInfo = adultTrainingMap.get(name.toLowerCase()) || null;
      return {
        name,
        leadership: row.Leadership || '',
        sytStatus: row['SYT Status'] || '',
        stateTraining: evaluateStateTrainingStatus(trainingInfo),
        registered: row['BSA Registered?'] || '',
      };
    });

    const baseScouts = rawScouts.map((row) => ({
      name: row.Participant || '',
      patrol: row.Patrol || '',
      swimTest: row['Swim Test'] || '',
      permissionGiven: row['Permission Given?'] || '',
      medicalNeeded: row['Medical Forms Needed'] || '',
    }));

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

      const sytStatus = row['SYT Status'] || matchingAdult?.sytStatus || 'N/A';
      const stateTraining = evaluateStateTrainingStatus(trainingInfo);
      const bsaRegistered = matchingAdult?.registered || 'N/A';
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
        sytStatus,
        stateTraining,
        bsaRegistered,
        isCompliant,
      };
    });

    const {
      enrichedDrivers: drivers,
      enrichedScouts: scouts,
      adultRidersCount,
      assignedScoutsCount,
      clarificationsNeeded,
    } = parseDriverComments(baseDrivers, baseScouts, adults);

    const totalAttendingScouts = scouts.length;
    const totalAttendingAdults = adults.length;
    const totalAttendees = totalAttendingScouts + totalAttendingAdults;
    const unassignedScoutsCount = Math.max(0, totalAttendingScouts - assignedScoutsCount);
    const totalOpenSeats = drivers
      .filter((d) => d.attending === 'Y')
      .reduce((sum, d) => sum + (d.openSeats || 0), 0);

    const nonCompliantDriversCount = drivers
      .filter((d) => d.attending === 'Y' && !d.isCompliant).length;

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
      meta.twhSignupUrl = `${origin}/FormDetail.aspx?Menu_Item_ID=45926&Form_ID=3707&FK=0&ID=${eventId}&Stack=2`;
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
      },
      drivers,
      adults,
      scouts,
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
app.post('/api/export-roster', async (req, res) => {
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

app.get('/api/roster/summary', async (req, res) => {
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

app.get('/api/events', async (req, res) => {
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

app.get('/api/events/:id/carpool', async (req, res) => {
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

app.get('/api/events/:id/carpool.xlsx', async (req, res) => {
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

app.post('/api/events/:id/carpool.xlsx', async (req, res) => {
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
  if (!force && baselineComment !== undefined) {
    if (currentLiveComment.trim() !== baselineComment.trim()) {
      return {
        conflict: true,
        driverName: foundMemberName,
        liveComment: currentLiveComment,
        proposedComment: updatedComment,
        message: `Conflict detected: ${foundMemberName}'s comment in TWH is "${currentLiveComment}", which differs from your baseline "${baselineComment}".`,
      };
    }
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

app.post('/api/events/:id/driver-update', async (req, res) => {
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

app.get('/api/events/:id/twh-status', async (req, res) => {
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
  parseDriverComments,
  getRosterData,
  getAdultTrainingData,
  fetchUpcomingEvents,
  fetchEventCarpoolDetails,
  updateEventDriverInTWH,
  firstMatches,
  NICKNAMES,
};

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
