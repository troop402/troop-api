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

  it('rejects invalid event ID for carpool.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool.xlsx`);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for POST carpool.xlsx endpoint with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/carpool.xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toDrivers: [] }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects invalid event ID for driver-update with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/driver-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverName: 'Test, Driver' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Valid numeric event ID is required.',
    });
  });

  it('rejects missing driverName for driver-update with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/1957/driver-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'driverName is required.',
    });
  });

  it('rejects invalid event ID for twh-status with 400', async () => {
    const response = await fetch(`${baseUrl}/api/events/not-an-id/twh-status`);

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

  it('redirects /coordinator/:id to /coordinator.html?id=:id', async () => {
    const response = await fetch(`${baseUrl}/coordinator/1957`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/coordinator.html?id=1957');
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

    // Check Elena's vehicle (4 seatbelts - 1 driver - 3 scouts = 0 open seats)
    const elena = result.enrichedDrivers.find((d) => d.name === 'Ayers, Elena');
    assert.equal(elena.claimedScouts.length, 3);
    assert.equal(elena.openSeats, 0);

    // Check Heather's vehicle with explicit "and 2 more"
    const heather = result.enrichedDrivers.find((d) => d.name === 'Tzortzis, Heather');
    assert.equal(heather.claimedScouts.length, 1);
    assert.equal(heather.claimedAdults.length, 1);
    assert.equal(heather.openSeats, 2);

    // Check Brad's vehicle (4 seatbelts - 1 driver = 3 available passenger seats)
    const brad = result.enrichedDrivers.find((d) => d.name === 'Hoover, Brad');
    assert.equal(brad.openSeats, 3);

    // Check scout ride status
    const allison = result.enrichedScouts.find((s) => s.name === 'Annis, Allison');
    assert.equal(allison.assignedDriver, 'Ayers, Elena');
    assert.equal(allison.rideStatus, 'confirmed');

    const john = result.enrichedScouts.find((s) => s.name === 'Smith, John');
    assert.equal(john.assignedDriver, null);
    assert.equal(john.rideStatus, 'unassigned');
  });

  it('detects first-name collisions, refuses blind assignments, and logs clarificationsNeeded', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Clayshulte, Alison',
        attending: 'Y',
        seats: 5,
        comment: 'Alison, Anya, Mila, and 2 open spots',
      },
    ];

    const scouts = [
      { name: 'Lavrinets, Anya', patrol: 'Dragon' },
      { name: 'Patath, Anya', patrol: 'Gator' },
      { name: 'Lavrinets, Mila', patrol: 'Dragon' },
      { name: 'Robinson, Mila', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Clayshulte, Alison', leadership: 'Committee Member' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    // Collision should refuse blind assignment
    assert.equal(result.assignedScoutsCount, 0);
    assert.equal(result.clarificationsNeeded.length, 2);

    const anyaClarification = result.clarificationsNeeded.find((c) => c.token === 'anya');
    assert.ok(anyaClarification);
    assert.equal(anyaClarification.driverName, 'Clayshulte, Alison');
    assert.equal(anyaClarification.candidates.length, 2);
    assert.ok(anyaClarification.candidates.includes('Anya Lavrinets'));
    assert.ok(anyaClarification.candidates.includes('Anya Patath'));

    const anya1 = result.enrichedScouts.find((s) => s.name === 'Lavrinets, Anya');
    assert.equal(anya1.assignedDriver, null);
    assert.equal(anya1.rideStatus, 'ambiguous');
    assert.match(anya1.rideNote, /Clayshulte, Alison/);

    const mila1 = result.enrichedScouts.find((s) => s.name === 'Robinson, Mila');
    assert.equal(mila1.assignedDriver, null);
    assert.equal(mila1.rideStatus, 'ambiguous');

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.ambiguousNotes.length, 2);
    assert.equal(driver.claimedScouts.length, 0);
    // Open seats should honor explicit note "and 2 open spots"
    assert.equal(driver.openSeats, 2);
  });

  it('resolves family matches and full-name disambiguation when multiple scouts share first names', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Renno, Amanda',
        attending: 'Y',
        seats: 4,
        comment: 'Driving Mackenzie',
      },
      {
        name: 'Polcari, Emily',
        attending: 'Y',
        seats: 4,
        comment: 'Emily, Maddie Curran',
      },
    ];

    const scouts = [
      { name: 'Renno, Mackenzie', patrol: 'Falcon' },
      { name: 'Stern, MacKenzie', patrol: 'Dragon' },
      { name: 'Curran, Maddie', patrol: 'Gator' },
      { name: 'Keeler-Hodgets, Maddie', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Renno, Amanda', leadership: 'Adult' },
      { name: 'Polcari, Emily', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    // Mackenzie Renno resolved via family match with driver Amanda Renno
    const macRenno = result.enrichedScouts.find((s) => s.name === 'Renno, Mackenzie');
    assert.equal(macRenno.assignedDriver, 'Renno, Amanda');
    assert.equal(macRenno.rideStatus, 'family_match');

    // MacKenzie Stern left unassigned and NOT ambiguous (since driver matched family)
    const macStern = result.enrichedScouts.find((s) => s.name === 'Stern, MacKenzie');
    assert.equal(macStern.assignedDriver, null);
    assert.equal(macStern.rideStatus, 'unassigned');

    // Maddie Curran resolved via full-name match in comment
    const maddieCurran = result.enrichedScouts.find((s) => s.name === 'Curran, Maddie');
    assert.equal(maddieCurran.assignedDriver, 'Polcari, Emily');
    assert.equal(maddieCurran.rideStatus, 'confirmed');

    // Maddie Keeler-Hodgets left unassigned
    const maddieKH = result.enrichedScouts.find((s) => s.name === 'Keeler-Hodgets, Maddie');
    assert.equal(maddieKH.assignedDriver, null);
    assert.equal(maddieKH.rideStatus, 'unassigned');

    // No clarifications needed because both were successfully resolved
    assert.equal(result.clarificationsNeeded.length, 0);
  });

  it('resolves adult nicknames, prevents token re-use, and handles capacity', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Renno, Amanda',
        attending: 'Y',
        seats: 4,
        comment: 'Amanda, Tom, Emily, Mackenzie',
      },
    ];

    const scouts = [
      { name: 'Renno, Emily', patrol: 'Gator' },
      { name: 'Renno, Mackenzie', patrol: 'Falcon' },
    ];

    const adults = [
      { name: 'Renno, Amanda', leadership: 'Adult' },
      { name: 'Renno, Thomas', leadership: 'Adult' },
      { name: 'Polcari, Emily', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.claimedScouts.length, 2);
    assert.equal(driver.claimedAdults.length, 1);
    assert.equal(driver.claimedAdults[0], 'Thomas Renno');
    // Emily token was consumed by Emily Renno, so Emily Polcari was not claimed
    assert.ok(!driver.claimedAdults.includes('Emily Polcari'));
    // 4 seatbelts total - 1 driver - 2 scouts - 1 adult = 0 open seats
    assert.equal(driver.openSeats, 0);
  });

  it('intelligently parses discrete TO and FROM structured driver comments with split capacities and riders', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Knudson, BJ',
        attending: 'Y',
        seats: 4,
        drivingToFrom: 'Both',
        comment: 'TO (3 seats): Taking Iris Knudson, Julia Parsons. FROM (1 seats): Taking Julia Parsons. Arriving late Friday.',
      },
    ];

    const scouts = [
      { name: 'Knudson, Iris', patrol: 'Dragon' },
      { name: 'Parsons, Julia', patrol: 'Falcon' },
      { name: 'Lavrinets, Anya', patrol: 'Dragon' },
    ];

    const adults = [
      { name: 'Knudson, BJ', leadership: 'Adult' },
    ];

    const result = parseDriverComments(drivers, scouts, adults);

    const driver = result.enrichedDrivers[0];
    assert.equal(driver.toSeats, 3);
    assert.equal(driver.fromSeats, 1);
    assert.equal(driver.cleanNote, 'Arriving late Friday.');

    assert.equal(driver.claimedScoutsTo.length, 2);
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Iris Knudson'));
    assert.ok(driver.claimedScoutsTo.some((s) => s.name === 'Julia Parsons'));

    assert.equal(driver.claimedScoutsFrom.length, 1);
    assert.equal(driver.claimedScoutsFrom[0].name, 'Julia Parsons');

    const iris = result.enrichedScouts.find((s) => s.name === 'Knudson, Iris');
    assert.equal(iris.assignedDriverTo, 'Knudson, BJ');
    assert.equal(iris.assignedDriverFrom, null);
    assert.equal(iris.rideDirection, 'To');

    const julia = result.enrichedScouts.find((s) => s.name === 'Parsons, Julia');
    assert.equal(julia.assignedDriverTo, 'Knudson, BJ');
    assert.equal(julia.assignedDriverFrom, 'Knudson, BJ');
    assert.equal(julia.rideDirection, 'Both');

    const anya = result.enrichedScouts.find((s) => s.name === 'Lavrinets, Anya');
    assert.equal(anya.assignedDriverTo, null);
    assert.equal(anya.assignedDriverFrom, null);
    assert.equal(anya.rideDirection, 'None');
  });
});

describe('Carpool Excel export unit test', () => {
  it('generates an Excel workbook with proper sections, headers, and pre-filled slots', async () => {
    const { buildCarpoolWorkbook } = await import('../excel-export.js');

    const mockData = {
      meta: {
        title: 'Mt. Lassen Campout',
        start: '10/10/2026 5:00 PM',
        end: '10/12/2026 11:00 AM',
        location: 'Mt. Lassen State Park',
      },
      stats: {
        totalDrivers: 2,
        totalSeatsOffered: 7,
        totalAttendingScouts: 5,
        assignedScoutsCount: 3,
        unassignedScoutsCount: 2,
        seatBalance: 2,
        adultRidersCount: 0,
      },
      drivers: [
        {
          name: 'Knudson, BJ',
          phone: '925-899-7663',
          seats: 4,
          comment: 'driving Iris, Julia',
          claimedScouts: [{ name: 'Iris Knudson' }, { name: 'Julia Parsons' }],
          drivingToFrom: 'Both',
          attending: 'Y',
        },
        {
          name: 'Bronson, Darren',
          phone: '415-722-4453',
          seats: 1,
          comment: 'leave Saturday night',
          claimedScouts: [{ name: 'Kyla Bronson' }],
          drivingToFrom: 'From',
          attending: 'Y',
        },
      ],
      scouts: [
        { name: 'Iris Knudson', patrol: 'Dragon', assignedDriver: 'Knudson, BJ', rideStatus: 'confirmed' },
        { name: 'Julia Parsons', patrol: 'Dragon', assignedDriver: 'Knudson, BJ', rideStatus: 'confirmed' },
        { name: 'Kyla Bronson', patrol: 'Falcon', assignedDriver: 'Bronson, Darren', rideStatus: 'confirmed' },
        { name: 'Charlie Brown', patrol: 'Gator', assignedDriver: null, rideStatus: 'unassigned' },
        { name: 'Lucy van Pelt', patrol: 'Gator', assignedDriver: null, rideStatus: 'unassigned' },
      ],
    };

    const workbook = await buildCarpoolWorkbook(mockData);
    assert.ok(workbook);

    // Verify all 4 sheets are present
    const carpoolSheet = workbook.getWorksheet('Carpool');
    const summarySheet = workbook.getWorksheet('Summary');
    const scoutSheet = workbook.getWorksheet('Scout roster');
    const adultSheet = workbook.getWorksheet('Adult roster');

    assert.ok(carpoolSheet, 'Carpool sheet should exist');
    assert.ok(summarySheet, 'Summary sheet should exist');
    assert.ok(scoutSheet, 'Scout roster sheet should exist');
    assert.ok(adultSheet, 'Adult roster sheet should exist');

    // Verify title and metadata
    assert.equal(carpoolSheet.getCell('A1').value, 'T402G carpool sheet');
    assert.equal(carpoolSheet.getCell('B2').value, 'Mt. Lassen Campout');

    // Verify BJ Knudson available passenger seats = 3 (4 total minus 1 driver)
    assert.equal(carpoolSheet.getCell('C27').value, 3);
    assert.equal(carpoolSheet.getCell('A27').value, 'Knudson, BJ');

    // Verify Data Validation dropdown on scout seat cell E27
    assert.equal(carpoolSheet.getCell('E27').dataValidation?.type, 'list');
    assert.ok(carpoolSheet.getCell('E27').dataValidation?.formulae[0].includes("'Scout roster'"));

    // Verify real math KPI formulas
    assert.equal(carpoolSheet.getCell('E6').value.formula, 'COUNTA(E27:M27)');
    assert.equal(carpoolSheet.getCell('E7').value.formula, 'E2-E6');
    assert.equal(carpoolSheet.getCell('E8').value.formula, 'SUM(C27:C27)-E2');

    // Verify boolean availability formula in column N (seat 1)
    assert.equal(carpoolSheet.getCell('N27').value.formula, 'IF($C27<N$25, FALSE, TRUE)');
    assert.equal(carpoolSheet.getCell('N27').value.result, true);

    // Verify Summary sheet has formulas referencing rosters and Carpool
    assert.ok(summarySheet.getCell('A2').value.formula.includes("'Scout roster'!A2"));
    assert.ok(summarySheet.getCell('B2').value.formula.includes("COUNTIF(Carpool!"));

    // Verify buffer generation
    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.length > 5000);
  });

  it('generates workbook with custom state and live coordinator edits', async () => {
    const { buildCarpoolWorkbook } = await import('../excel-export.js');

    const mockData = {
      meta: { title: 'Campout Test' },
      stats: {},
      drivers: [],
      scouts: [],
    };

    const customState = {
      toDrivers: [
        {
          name: 'Leader, Jane',
          phone: '925-555-1234',
          seats: 4,
          comment: 'leaving at 7am',
          riders: ['Scout, One', 'Scout, Two'],
        },
      ],
      fromDrivers: [],
      unassignedScouts: [{ name: 'Scout, Three', patrol: 'Dragon' }],
    };

    const workbook = await buildCarpoolWorkbook(mockData, null, customState);
    assert.ok(workbook);

    const sheet = workbook.getWorksheet('Carpool');
    assert.equal(sheet.getCell('A27').value, 'Leader, Jane');
    assert.equal(sheet.getCell('C27').value, 4);
    assert.equal(sheet.getCell('E27').value, 'Scout, One');
    assert.equal(sheet.getCell('F27').value, 'Scout, Two');
    // Open seat ready for coordinator
    assert.equal(sheet.getCell('G27').value, null);
  });
});

describe('Scout and roster enrichment unit test', () => {
  it('extracts swim test, BSA registration, and medical dates in computeRosterSummary', async () => {
    const { computeRosterSummary } = await import('../server.js');

    const csvContent = [
      'Adult,Name,Patrol,Cell Phone,Swim Level,Swim Date,BSA ID,BSA Registration Ends,Medical Part A,Medical Part B,Medical Part C',
      'N,"Annis, Allison",Gator,925-555-0101,Swimmer,8/23/2026,141713280,8/31/2027,8/17/2026,8/17/2026,4/17/2026',
      'Y,"Ayers, Elena",,925-555-0102,,,141553648,3/31/2027,,,',
    ].join('\n');

    const summary = computeRosterSummary(Buffer.from(csvContent, 'utf8'));
    assert.equal(summary.totalMembers, 2);
    assert.equal(summary.scoutsCount, 1);
    assert.equal(summary.adultsCount, 1);

    const scout = summary.membersByName.get('annis, allison');
    assert.ok(scout);
    assert.equal(scout.swimLevel, 'Swimmer');
    assert.equal(scout.swimDate, '8/23/2026');
    assert.equal(scout.bsaId, '141713280');
    assert.equal(scout.bsaRegistrationEnds, '8/31/2027');
    assert.equal(scout.medicalPartA, '8/17/2026');
    assert.equal(scout.medicalPartC, '4/17/2026');
  });

  it('preserves scout attendance comments and enriched fields through parseDriverComments', async () => {
    const { parseDriverComments } = await import('../server.js');

    const drivers = [
      {
        name: 'Ayers, Elena',
        attending: 'Y',
        seats: 4,
        comment: 'driving Gwyneth',
      },
    ];

    const scouts = [
      {
        name: 'Ayers, Gwyneth',
        patrol: 'Sun Bear',
        comment: 'Leaving early at noon',
        permissionGiven: 'Yes',
        medicalNeeded: 'A B',
        bsaRegistered: 'Current',
        bsaId: '141553648',
        swimTest: 'Swimmer',
        swimDate: '6/26/2026',
      },
    ];

    const adults = [{ name: 'Ayers, Elena', leadership: 'Adult' }];

    const result = parseDriverComments(drivers, scouts, adults);
    const enriched = result.enrichedScouts.find((s) => s.name === 'Ayers, Gwyneth');
    assert.ok(enriched);
    assert.equal(enriched.comment, 'Leaving early at noon');
    assert.equal(enriched.medicalNeeded, 'A B');
    assert.equal(enriched.bsaRegistered, 'Current');
    assert.equal(enriched.swimTest, 'Swimmer');
    assert.equal(enriched.swimDate, '6/26/2026');
    assert.equal(enriched.assignedDriver, 'Ayers, Elena');
  });
});