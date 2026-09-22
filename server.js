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
  rosterBuffer: null,
  rosterSummary: null,
  rosterTimestamp: 0,
  rosterTtlMs: 12 * 60 * 60 * 1000, // 12 hours

  events: null,
  eventsTimestamp: 0,
  eventsTtlMs: 2 * 60 * 60 * 1000, // 2 hours

  carpoolByEventId: new Map(), // eventId -> { data, timestamp }
  carpoolTtlMs: 15 * 60 * 1000, // 15 minutes
};

let activeRosterPromise = null;
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
      let start = '';
      let end = '';

      $(tbl).find('tr').each((_, tr) => {
        const caption = $(tr).find('.mobile-grid-caption').text().trim();
        const data = $(tr).find('.mobile-grid-data').text().trim().replace(/\s+/g, ' ');
        if (/event type/i.test(caption)) eventType = data;
        else if (/^event$/i.test(caption)) title = data;
        else if (/location/i.test(caption)) location = data;
        else if (/start/i.test(caption)) start = data;
        else if (/end/i.test(caption)) end = data;
      });

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
    if (!comment) {
      return {
        ...d,
        claimedScouts: [],
        claimedAdults: [],
        ambiguousNotes: [],
        openSeats: d.attending === 'Y' ? d.seats : 0,
        explicitOpenNote: '',
      };
    }

    const dParts = d.name.split(',').map((p) => p.trim());
    const driverFirst = (dParts.length > 1 ? dParts[1].split(' ')[0] : dParts[0].split(' ')[0]).toLowerCase();
    const driverLast = (dParts.length > 1 ? dParts[0] : '').toLowerCase();

    // Look for explicit open seats / spots mention in comment
    let explicitOpen = null;
    let explicitOpenNote = '';
    const openMatch = comment.match(/(?:and\s+)?(\d+)\s+(?:more|open|spots|extra|seats)/i)
      || comment.match(/(?:room|space)\s+for\s+(\d+)/i);
    if (openMatch) {
      explicitOpen = parseInt(openMatch[1], 10);
      explicitOpenNote = openMatch[0];
    }

    const matchedScouts = [];
    const matchedAdults = [];
    const ambiguousNotes = [];
    const checkedFirstNames = new Set();

    // Match attending scouts with ambiguity & family detection
    for (const sc of scoutEntries) {
      if (sc.first === driverFirst && sc.last === driverLast) continue;

      const hasFullName = sc.last && comment.toLowerCase().includes(sc.last) && comment.toLowerCase().includes(sc.first);

      if (hasFullName) {
        checkedFirstNames.add(sc.first);
        if (!matchedScouts.some((m) => m.name === sc.displayName)) {
          matchedScouts.push({
            name: sc.displayName,
            status: 'confirmed',
            note: 'Full name matched',
          });
          scoutRideMap.set(sc.originalName, { driverName: d.name, status: 'confirmed' });
        }
      } else if (sc.first.length > 2 && !checkedFirstNames.has(sc.first)) {
        const regex = new RegExp(`\\b${sc.first}\\b`, 'i');
        if (regex.test(comment)) {
          checkedFirstNames.add(sc.first);
          const candidates = firstNameFrequency.get(sc.first) || [];

          if (candidates.length === 1) {
            const singleScout = candidates[0];
            if (!matchedScouts.some((m) => m.name === singleScout.displayName)) {
              matchedScouts.push({
                name: singleScout.displayName,
                status: 'unique_first',
                note: 'Unique first name',
              });
              scoutRideMap.set(singleScout.originalName, { driverName: d.name, status: 'unique_first' });
            }
          } else {
            // Collision: multiple candidates share first name!
            const familyCandidate = candidates.find((c) => c.last === driverLast);
            if (familyCandidate) {
              if (!matchedScouts.some((m) => m.name === familyCandidate.displayName)) {
                matchedScouts.push({
                  name: familyCandidate.displayName,
                  status: 'family_match',
                  note: `Family match with driver (${d.name})`,
                });
                scoutRideMap.set(familyCandidate.originalName, { driverName: d.name, status: 'family_match' });
              }
            } else {
              // Ambiguous collision
              const candidateNames = candidates.map((c) => c.displayName);
              const warningMsg = `Ambiguous "${sc.first}": matches ${candidateNames.length} attending scouts (${candidateNames.join(', ')}). Driver clarification needed.`;
              ambiguousNotes.push({
                token: sc.first,
                candidates: candidateNames,
                note: warningMsg,
              });
              allClarifications.push({
                driverName: d.name,
                token: sc.first,
                candidates: candidateNames,
                note: warningMsg,
              });

              candidates.forEach((c) => {
                const mentions = scoutAmbiguousMentions.get(c.originalName) || [];
                mentions.push(d.name);
                scoutAmbiguousMentions.set(c.originalName, mentions);
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

      if (ad.last && comment.toLowerCase().includes(ad.last) && comment.toLowerCase().includes(ad.first)) {
        if (!matchedAdults.includes(ad.displayName)) {
          matchedAdults.push(ad.displayName);
          claimedAdultsSet.add(ad.originalName);
        }
      } else if (ad.first.length > 2) {
        const regex = new RegExp(`\\b${ad.first}\\b`, 'i');
        if (regex.test(comment)) {
          if (!matchedAdults.includes(ad.displayName)) {
            matchedAdults.push(ad.displayName);
            claimedAdultsSet.add(ad.originalName);
          }
        }
      }
    }

    let openSeats;
    if (explicitOpen !== null) {
      openSeats = explicitOpen;
    } else {
      const passengerCount = matchedScouts.length + matchedAdults.length;
      openSeats = Math.max(0, d.seats - passengerCount);
    }

    return {
      ...d,
      claimedScouts: matchedScouts,
      claimedAdults: matchedAdults,
      ambiguousNotes,
      openSeats: d.attending === 'Y' ? openSeats : 0,
      explicitOpenNote,
    };
  });

  const enrichedScouts = scouts.map((s) => {
    const rideInfo = scoutRideMap.get(s.name);
    const ambiguousDrivers = scoutAmbiguousMentions.get(s.name);

    let rideStatus = 'unassigned';
    let assignedDriver = null;
    let rideNote = '';

    if (rideInfo) {
      rideStatus = rideInfo.status;
      assignedDriver = rideInfo.driverName;
    } else if (ambiguousDrivers && ambiguousDrivers.length > 0) {
      rideStatus = 'ambiguous';
      rideNote = `Mentioned without last name by ${ambiguousDrivers.join(', ')}`;
    }

    return {
      ...s,
      assignedDriver,
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

    // Fetch drivers (38199), adults (730), scouts (967) in parallel
    const [driversCsv, adultsCsv, scoutsCsv] = await Promise.all([
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 38199 }),
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 730 }),
      fetchEventSectionCsv({ client, loginUrl, rootUrl, eventId, sectionId: 967 }),
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

    const adults = rawAdults.map((row) => ({
      name: row.Participant || '',
      leadership: row.Leadership || '',
      sytStatus: row['SYT Status'] || '',
      stateTraining: row['State Training'] || '',
      registered: row['BSA Registered?'] || '',
    }));

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
        totalSeatsOffered += seats;
      }

      const rosterInfo = membersMap.get(name.toLowerCase()) || {};
      const matchingAdult = adults.find((a) => a.name.toLowerCase() === name.toLowerCase());

      const sytStatus = matchingAdult?.sytStatus || 'N/A';
      const stateTraining = matchingAdult?.stateTraining || 'N/A';
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

    const result = {
      eventId,
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

// Friendly redirect routes
app.get('/carpool/:id', (req, res) => {
  const eventId = req.params.id;
  if (!eventId || !/^\d+$/.test(eventId)) {
    return res.status(400).send('Invalid event ID');
  }
  return res.redirect(`/carpool.html?id=${encodeURIComponent(eventId)}`);
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
  fetchUpcomingEvents,
  fetchEventCarpoolDetails,
};

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
