import ExcelJS from 'exceljs';

/**
 * Standardizes a name to "Last, First" format if it isn't already.
 * @param {string} fullName
 * @returns {string}
 */
export function formatLastFirst(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const trimmed = fullName.trim();
  if (trimmed.includes(',')) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length <= 1) return trimmed;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

/**
 * Generates an Excel workbook (.xlsx) replicating the 4-sheet Lake Berryessa coordinator layout:
 * 1. 'Carpool' (trip metadata, KPI box, driver rules, TO slots 1-9, FROM slots 1-9, WAITLIST, boolean formulas)
 * 2. 'Summary' (cross-check formulas for scouts and drivers against roster sheets)
 * 3. 'Scout roster' (scout roster contacts)
 * 4. 'Adult roster' (adult roster contacts)
 *
 * @param {Object} carpoolData Carpool data returned by fetchEventCarpoolDetails
 * @param {Object} [rosterSummary] Optional full troop roster summary from getRosterData
 * @param {Object} [customState] Optional custom working state from coordinator website
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildCarpoolWorkbook(carpoolData, rosterSummary = null, customState = null) {
  const { meta = {}, stats = {}, drivers = [], scouts = [], adults = [] } = carpoolData;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Troop 402 API';
  workbook.created = new Date();

  // Colors matching Lake Berryessa Google Spreadsheet
  const fillIceBlue = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCFE2F3' } };
  const fillUnavailable = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  const fillYellow = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  const fillHeaderGray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

  const borderThin = {
    top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
    left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
    bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
    right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  };

  const borderMediumBottom = {
    bottom: { style: 'medium', color: { argb: 'FF000000' } },
  };

  const fontArial36Bold = { name: 'Arial', size: 36, bold: true, color: { argb: 'FF000000' } };
  const fontSection18Bold = { name: 'Arial', size: 18, bold: true, color: { argb: 'FF000000' } };
  const fontHeader11Bold = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
  const font11 = { name: 'Arial', size: 11, color: { argb: 'FF000000' } };
  const font11Bold = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
  const font10Muted = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF595959' } };

  // ==========================================
  // PREPARE ROSTERS FIRST (For Data Validation)
  // ==========================================
  let allRosterScouts = [];
  let allRosterAdults = [];

  if (rosterSummary && rosterSummary.membersByName) {
    for (const [_, m] of rosterSummary.membersByName.entries()) {
      if (m.isAdult) {
        allRosterAdults.push(m);
      } else {
        allRosterScouts.push(m);
      }
    }
  }

  // Fallback to event attendees if full troop roster not available
  if (allRosterScouts.length === 0) {
    allRosterScouts = scouts.map(s => ({
      name: s.name,
      phone: '',
      email: '',
    }));
  }
  if (allRosterAdults.length === 0) {
    allRosterAdults = adults.map(a => ({
      name: a.name,
      phone: '',
      email: '',
    }));
  }

  allRosterScouts.sort((a, b) => formatLastFirst(a.name).localeCompare(formatLastFirst(b.name)));
  allRosterAdults.sort((a, b) => formatLastFirst(a.name).localeCompare(formatLastFirst(b.name)));

  const scoutRosterFormulaRange = `'Scout roster'!$A$2:$A$${Math.max(2, allRosterScouts.length + 1)}`;

  // ==========================================
  // SHEET 1: Carpool
  // ==========================================
  const carpoolSheet = workbook.addWorksheet('Carpool', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });

  // Column widths matching Google Sheet
  carpoolSheet.columns = [
    { width: 26 }, // A: Driver Name
    { width: 16 }, // B: Cell#
    { width: 12 }, // C: Available Seats
    { width: 45 }, // D: Special Info
    { width: 20 }, // E: Scout 1
    { width: 20 }, // F: Scout 2
    { width: 20 }, // G: Scout 3
    { width: 20 }, // H: Scout 4
    { width: 20 }, // I: Scout 5
    { width: 20 }, // J: Scout 6
    { width: 20 }, // K: Scout 7
    { width: 20 }, // L: Scout 8
    { width: 20 }, // M: Scout 9
    { width: 8 },  // N: Seat 1 avail
    { width: 8 },  // O: Seat 2 avail
    { width: 8 },  // P: Seat 3 avail
    { width: 8 },  // Q: Seat 4 avail
    { width: 8 },  // R: Seat 5 avail
    { width: 8 },  // S: Seat 6 avail
    { width: 8 },  // T: Seat 7 avail
    { width: 8 },  // U: Seat 8 avail
    { width: 8 },  // V: Seat 9 avail
  ];

  // R1: Title
  const r1 = carpoolSheet.getCell('A1');
  r1.value = 'T402G carpool sheet';
  r1.font = fontArial36Bold;

  // Event & Trip Metadata
  const totalAttendingScouts = scouts.length || stats.totalAttendingScouts || 0;
  const registeredDrivers = drivers.filter(d => d.attending === 'Y' && d.seats > 0);
  const registeredDriversCount = registeredDrivers.length;

  carpoolSheet.getCell('A2').value = 'Trip:';
  carpoolSheet.getCell('A2').font = font11Bold;
  carpoolSheet.getCell('B2').value = meta.title || `Event #${carpoolData.eventId || ''}`;
  carpoolSheet.getCell('B2').font = font11;
  carpoolSheet.getCell('D2').value = 'Scouts attending (enter from website):';
  carpoolSheet.getCell('D2').font = font11;
  const e2 = carpoolSheet.getCell('E2');
  e2.value = totalAttendingScouts;
  e2.font = font11Bold;
  e2.fill = fillYellow;

  carpoolSheet.getCell('A3').value = '"TO" Depart Date:';
  carpoolSheet.getCell('A3').font = font11Bold;
  carpoolSheet.getCell('B3').value = meta.start ? meta.start.split(' ')[0] : '';
  carpoolSheet.getCell('B3').font = font11;
  carpoolSheet.getCell('D3').value = '# Drivers (enter from website):';
  carpoolSheet.getCell('D3').font = font11;
  carpoolSheet.getCell('E3').value = registeredDriversCount;
  carpoolSheet.getCell('E3').font = font11;

  carpoolSheet.getCell('A4').value = '"TO" Depart Time:';
  carpoolSheet.getCell('A4').font = font11Bold;
  carpoolSheet.getCell('B4').value = meta.start ? meta.start.split(' ').slice(1).join(' ') : '7:30 AM';
  carpoolSheet.getCell('B4').font = font11;

  carpoolSheet.getCell('A5').value = '"FROM" Depart Date (from event):';
  carpoolSheet.getCell('A5').font = font11Bold;
  carpoolSheet.getCell('B5').value = meta.end ? meta.end.split(' ')[0] : '';
  carpoolSheet.getCell('B5').font = font11;
  carpoolSheet.getCell('D5').value = 'Summary, SCOUTS:';
  carpoolSheet.getCell('D5').font = font11Bold;

  carpoolSheet.getCell('A6').value = '"FROM" Depart Time (from event):';
  carpoolSheet.getCell('A6').font = font11Bold;
  carpoolSheet.getCell('B6').value = meta.end ? meta.end.split(' ').slice(1).join(' ') : '9:30 AM';
  carpoolSheet.getCell('B6').font = font11;
  carpoolSheet.getCell('D6').value = 'Assigned Scouts (TO):';
  carpoolSheet.getCell('D6').font = font11;

  const locationText = customState?.location ?? meta.location ?? '';
  const mapLinkText = customState?.mapLink ?? meta.mapLink ?? '';

  carpoolSheet.getCell('A7').value = 'Event Address:';
  carpoolSheet.getCell('A7').font = font11Bold;
  carpoolSheet.getCell('B7').value = locationText;
  carpoolSheet.getCell('B7').font = font11;
  carpoolSheet.getCell('D7').value = 'Unassigned Scouts (TO):';
  carpoolSheet.getCell('D7').font = font11;

  carpoolSheet.getCell('A8').value = 'Map link:';
  carpoolSheet.getCell('A8').font = font11Bold;
  if (mapLinkText) {
    carpoolSheet.getCell('B8').value = { text: mapLinkText, hyperlink: mapLinkText };
    carpoolSheet.getCell('B8').font = { ...font11, color: { argb: 'FF0000EE' }, underline: true };
  } else {
    carpoolSheet.getCell('B8').value = '';
    carpoolSheet.getCell('B8').font = font11;
  }
  carpoolSheet.getCell('D8').value = 'Net Seat Balance (TO):';
  carpoolSheet.getCell('D8').font = font11;

  carpoolSheet.getCell('D9').value = 'Net Seat Balance (FROM):';
  carpoolSheet.getCell('D9').font = font11;

  carpoolSheet.getCell('A10').value = 'Carpool Leader Contacts:';
  carpoolSheet.getCell('A10').font = font11Bold;
  carpoolSheet.getCell('D10').value = 'Summary, DRIVERS: ';
  carpoolSheet.getCell('D10').font = font11Bold;

  carpoolSheet.getCell('A11').value = 'Carpool Coordinator';
  carpoolSheet.getCell('A11').font = font11;
  carpoolSheet.getCell('B11').value = 'See Roster Tabs';
  carpoolSheet.getCell('B11').font = font11;
  carpoolSheet.getCell('D11').value = 'Drivers, TO and/or FROM: ';
  carpoolSheet.getCell('D11').font = font11;

  carpoolSheet.getCell('D12').value = '#Drivers missing from spdsht: ';
  carpoolSheet.getCell('D12').font = font11;

  // Instructions & Rules
  carpoolSheet.getCell('A15').value = 'Instructions:';
  carpoolSheet.getCell('A15').font = font11Bold;
  carpoolSheet.getCell('B15').value = "IMPORTANT: By entering your info in this spreadsheet, you agree to comply with Scouting's transport guidelines.";
  carpoolSheet.getCell('B15').font = font10Muted;

  carpoolSheet.getCell('A16').value = "1) Driver Requirements/Certification: Completed SYT within the last 12 Months and Minimum Car Insurance Coverage: $100,000 for one person's injuries, up to $300,000 total for all injuries in a single accident, and up to $100,000 for property damage";
  carpoolSheet.getCell('A16').font = font11;
  carpoolSheet.getCell('A17').value = '2) Drivers: enter info in this spdsht ("TO" and "FROM" and/or "WAITLIST");';
  carpoolSheet.getCell('A17').font = font11;
  carpoolSheet.getCell('A18').value = '3) Scouts/parents: sign up for carpool seats ("TO" and "FROM", and/or "WAITLIST").';
  carpoolSheet.getCell('A18').font = font11;
  carpoolSheet.getCell('A19').value = '4) Scouts/parents/drivers: coordinate w/each other to confirm details (contact info on the "roster" tabs of this spdsht).';
  carpoolSheet.getCell('A19').font = font11;
  carpoolSheet.getCell('A20').value = '5) For questions email carpool coordinator.';
  carpoolSheet.getCell('A20').font = font11;
  carpoolSheet.getCell('A21').value = 'NOTE 1: Please sign up even if you are only driving your Scout.';
  carpoolSheet.getCell('A21').font = font11;
  carpoolSheet.getCell('A22').value = 'NOTE 2: ALL carpools will depart from the cabin. Return locations are at drivers’ discretion.';
  carpoolSheet.getCell('A22').font = font11Bold;

  // ==========================================
  // "TO the event:" Section (Starts at Row 24)
  // ==========================================
  carpoolSheet.getCell('A24').value = 'TO the event:';
  carpoolSheet.getCell('A24').font = fontSection18Bold;

  // Row 25: Column numbers (E25..M25 and N25..V25)
  for (let s = 1; s <= 9; s++) {
    const scoutColLetter = String.fromCharCode(68 + s); // E=69
    const cellScout = carpoolSheet.getCell(`${scoutColLetter}25`);
    cellScout.value = s;
    cellScout.alignment = { horizontal: 'center' };
    cellScout.font = font11Bold;

    const boolColLetter = String.fromCharCode(77 + s); // N=78
    const cellBool = carpoolSheet.getCell(`${boolColLetter}25`);
    cellBool.value = s;
    cellBool.alignment = { horizontal: 'center' };
    cellBool.font = font11Bold;
  }

  // Row 26: Headers
  const toHeaders = [
    { cell: 'A26', val: 'Driver (FIRST and LAST name):' },
    { cell: 'B26', val: 'Driver Cell#:' },
    { cell: 'C26', val: '# available seats FOR SCOUTS, leave room for gear):' },
    { cell: 'D26', val: "Special info (departure/return times; list any add'l drivers and passengers, etc.): " },
    { cell: 'E26', val: 'Scout (FIRST and LAST name):' },
    { cell: 'N26', val: 'Seat available?:' },
  ];
  toHeaders.forEach(h => {
    const c = carpoolSheet.getCell(h.cell);
    c.value = h.val;
    c.font = fontHeader11Bold;
    c.border = borderMediumBottom;
  });

  // Resolve drivers for TO
  const toDrivers = (customState && customState.toDrivers)
    ? customState.toDrivers
    : drivers.filter(d => d.drivingToFrom === 'Both' || d.drivingToFrom === 'To' || !d.drivingToFrom);

  let currentRow = 27;

  toDrivers.forEach(d => {
    const r = currentRow;
    const defaultSeats = d.seats > 0 ? Math.max(0, d.seats - 1) : 0;
    const availableSeats = customState
      ? (d.seats || 0)
      : (d.toSeats !== undefined && d.toSeats !== null ? d.toSeats : defaultSeats);

    carpoolSheet.getCell(`A${r}`).value = formatLastFirst(d.name);
    carpoolSheet.getCell(`A${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`A${r}`).font = font11;
    carpoolSheet.getCell(`A${r}`).border = borderThin;

    carpoolSheet.getCell(`B${r}`).value = d.phone || '';
    carpoolSheet.getCell(`B${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`B${r}`).font = font11;
    carpoolSheet.getCell(`B${r}`).border = borderThin;

    carpoolSheet.getCell(`C${r}`).value = availableSeats;
    carpoolSheet.getCell(`C${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`C${r}`).font = font11Bold;
    carpoolSheet.getCell(`C${r}`).alignment = { horizontal: 'center' };
    carpoolSheet.getCell(`C${r}`).border = borderThin;

    carpoolSheet.getCell(`D${r}`).value = d.comment || '';
    carpoolSheet.getCell(`D${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`D${r}`).font = font11;
    carpoolSheet.getCell(`D${r}`).border = borderThin;

    // Riders
    let riders = [];
    if (d.riders && Array.isArray(d.riders)) {
      riders = d.riders.map(r => formatLastFirst(typeof r === 'string' ? r : r.name));
    } else {
      const scoutsTo = d.claimedScoutsTo || d.claimedScouts || [];
      const adultsTo = d.claimedAdultsTo || d.claimedAdults || [];
      scoutsTo.forEach(sc => {
        const scName = typeof sc === 'string' ? sc : sc.name;
        riders.push(formatLastFirst(scName));
      });
      adultsTo.forEach(ad => {
        const adName = typeof ad === 'string' ? ad : ad.name;
        riders.push(`Adult: ${formatLastFirst(adName)}`);
      });
    }

    // Slots 1..9 (Cols E..M) and Availability Formulas (Cols N..V)
    for (let s = 1; s <= 9; s++) {
      const scoutColLetter = String.fromCharCode(68 + s);
      const boolColLetter = String.fromCharCode(77 + s);
      const cellScout = carpoolSheet.getCell(`${scoutColLetter}${r}`);
      const cellBool = carpoolSheet.getCell(`${boolColLetter}${r}`);

      const rider = riders[s - 1];
      const isWithinCapacity = s <= availableSeats;

      if (rider) {
        cellScout.value = rider;
        cellScout.fill = fillIceBlue;
      } else if (isWithinCapacity) {
        cellScout.value = null; // Open seat ready for coordinator selection
        cellScout.fill = fillIceBlue;
      } else {
        cellScout.value = '-';
        cellScout.fill = fillUnavailable;
      }
      cellScout.font = font11;
      cellScout.border = borderThin;

      // Add Data Validation dropdown on scout seat cells
      cellScout.dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [scoutRosterFormulaRange],
        showErrorMessage: true,
        errorTitle: 'Invalid Scout',
        error: 'Please select a scout from the Scout roster dropdown.',
      };

      // Formula: =IF($C{r}<N$25, FALSE, TRUE)
      cellBool.value = {
        formula: `IF($C${r}<${boolColLetter}$25, FALSE, TRUE)`,
        result: isWithinCapacity,
      };
      cellBool.font = font11;
      cellBool.alignment = { horizontal: 'center' };
      cellBool.border = borderThin;
    }

    currentRow++;
  });

  const toEndRow = Math.max(27, currentRow - 1);

  // Link real math formulas in top summary box
  carpoolSheet.getCell('E6').value = {
    formula: `COUNTA(E27:M${toEndRow})`,
    result: (stats.assignedScoutsCount || 0),
  };
  carpoolSheet.getCell('E6').font = font11Bold;

  carpoolSheet.getCell('E7').value = {
    formula: `E2-E6`,
    result: (stats.unassignedScoutsCount || 0),
  };
  carpoolSheet.getCell('E7').font = font11Bold;

  carpoolSheet.getCell('E8').value = {
    formula: `SUM(C27:C${toEndRow})-E2`,
    result: (stats.seatBalance || 0),
  };
  carpoolSheet.getCell('E8').font = font11Bold;

  carpoolSheet.getCell('E11').value = {
    formula: `COUNTA(A27:A${toEndRow})`,
    result: toDrivers.length,
  };
  carpoolSheet.getCell('E11').font = font11Bold;

  carpoolSheet.getCell('E12').value = {
    formula: `E3-E11`,
    result: registeredDriversCount - toDrivers.length,
  };
  carpoolSheet.getCell('E12').font = font11Bold;

  // Add blank spacing before FROM section
  currentRow += 2;

  // ==========================================
  // "FROM the event:" Section
  // ==========================================
  const fromSectionRow = currentRow;
  carpoolSheet.getCell(`A${fromSectionRow}`).value = 'FROM the event:';
  carpoolSheet.getCell(`A${fromSectionRow}`).font = fontSection18Bold;
  currentRow++;

  const fromNumRow = currentRow;
  for (let s = 1; s <= 9; s++) {
    const scoutColLetter = String.fromCharCode(68 + s);
    const cellScout = carpoolSheet.getCell(`${scoutColLetter}${fromNumRow}`);
    cellScout.value = s;
    cellScout.alignment = { horizontal: 'center' };
    cellScout.font = font11Bold;

    const boolColLetter = String.fromCharCode(77 + s);
    const cellBool = carpoolSheet.getCell(`${boolColLetter}${fromNumRow}`);
    cellBool.value = s;
    cellBool.alignment = { horizontal: 'center' };
    cellBool.font = font11Bold;
  }
  currentRow++;

  const fromHeaderRow = currentRow;
  const fromHeaders = [
    { cell: `A${fromHeaderRow}`, val: 'Driver (FIRST and LAST name):' },
    { cell: `B${fromHeaderRow}`, val: 'Driver Cell#:' },
    { cell: `C${fromHeaderRow}`, val: '# available seats FOR SCOUTS, leave room for gear):' },
    { cell: `D${fromHeaderRow}`, val: "Special info (departure/return times; list any add'l drivers and passengers, etc.): " },
    { cell: `E${fromHeaderRow}`, val: 'Scout (FIRST and LAST name):' },
    { cell: `N${fromHeaderRow}`, val: 'Seat available?:' },
  ];
  fromHeaders.forEach(h => {
    const c = carpoolSheet.getCell(h.cell);
    c.value = h.val;
    c.font = fontHeader11Bold;
    c.border = borderMediumBottom;
  });
  currentRow++;

  const fromStartRow = currentRow;
  const fromDrivers = (customState && customState.fromDrivers)
    ? customState.fromDrivers
    : drivers.filter(d => d.drivingToFrom === 'Both' || d.drivingToFrom === 'From');

  fromDrivers.forEach(d => {
    const r = currentRow;
    const defaultSeats = d.seats > 0 ? Math.max(0, d.seats - 1) : 0;
    const availableSeats = customState
      ? (d.seats || 0)
      : (d.fromSeats !== undefined && d.fromSeats !== null ? d.fromSeats : defaultSeats);

    carpoolSheet.getCell(`A${r}`).value = formatLastFirst(d.name);
    carpoolSheet.getCell(`A${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`A${r}`).font = font11;
    carpoolSheet.getCell(`A${r}`).border = borderThin;

    carpoolSheet.getCell(`B${r}`).value = d.phone || '';
    carpoolSheet.getCell(`B${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`B${r}`).font = font11;
    carpoolSheet.getCell(`B${r}`).border = borderThin;

    carpoolSheet.getCell(`C${r}`).value = availableSeats;
    carpoolSheet.getCell(`C${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`C${r}`).font = font11Bold;
    carpoolSheet.getCell(`C${r}`).alignment = { horizontal: 'center' };
    carpoolSheet.getCell(`C${r}`).border = borderThin;

    carpoolSheet.getCell(`D${r}`).value = d.comment || '';
    carpoolSheet.getCell(`D${r}`).fill = fillIceBlue;
    carpoolSheet.getCell(`D${r}`).font = font11;
    carpoolSheet.getCell(`D${r}`).border = borderThin;

    let riders = [];
    if (d.riders && Array.isArray(d.riders)) {
      riders = d.riders.map(r => formatLastFirst(typeof r === 'string' ? r : r.name));
    } else {
      const scoutsFrom = d.claimedScoutsFrom || d.claimedScouts || [];
      const adultsFrom = d.claimedAdultsFrom || d.claimedAdults || [];
      scoutsFrom.forEach(sc => {
        const scName = typeof sc === 'string' ? sc : sc.name;
        riders.push(formatLastFirst(scName));
      });
      adultsFrom.forEach(ad => {
        const adName = typeof ad === 'string' ? ad : ad.name;
        riders.push(`Adult: ${formatLastFirst(adName)}`);
      });
    }

    for (let s = 1; s <= 9; s++) {
      const scoutColLetter = String.fromCharCode(68 + s);
      const boolColLetter = String.fromCharCode(77 + s);
      const cellScout = carpoolSheet.getCell(`${scoutColLetter}${r}`);
      const cellBool = carpoolSheet.getCell(`${boolColLetter}${r}`);

      const rider = riders[s - 1];
      const isWithinCapacity = s <= availableSeats;

      if (rider) {
        cellScout.value = rider;
        cellScout.fill = fillIceBlue;
      } else if (isWithinCapacity) {
        cellScout.value = null;
        cellScout.fill = fillIceBlue;
      } else {
        cellScout.value = '-';
        cellScout.fill = fillUnavailable;
      }
      cellScout.font = font11;
      cellScout.border = borderThin;

      // Add Data Validation dropdown on return scout seat cells
      cellScout.dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [scoutRosterFormulaRange],
        showErrorMessage: true,
        errorTitle: 'Invalid Scout',
        error: 'Please select a scout from the Scout roster dropdown.',
      };

      cellBool.value = {
        formula: `IF($C${r}<${boolColLetter}$${fromNumRow}, FALSE, TRUE)`,
        result: isWithinCapacity,
      };
      cellBool.font = font11;
      cellBool.alignment = { horizontal: 'center' };
      cellBool.border = borderThin;
    }

    currentRow++;
  });

  const fromEndRow = Math.max(fromStartRow, currentRow - 1);

  // Link FROM net seat balance in summary box
  carpoolSheet.getCell('E9').value = {
    formula: `SUM(C${fromStartRow}:C${fromEndRow})-E2`,
    result: (stats.seatBalance || 0),
  };
  carpoolSheet.getCell('E9').font = font11Bold;

  // Add blank spacing before WAITLIST section
  currentRow += 2;

  // ==========================================
  // "WAITLIST:" Section
  // ==========================================
  const waitlistSectionRow = currentRow;
  carpoolSheet.getCell(`A${waitlistSectionRow}`).value = 'WAITLIST:';
  carpoolSheet.getCell(`A${waitlistSectionRow}`).font = fontSection18Bold;
  currentRow++;

  const waitlistHeaderRow = currentRow;
  carpoolSheet.getCell(`A${waitlistHeaderRow}`).value = 'Scout (FIRST and LAST name):';
  carpoolSheet.getCell(`B${waitlistHeaderRow}`).value = 'Parent (FIRST and LAST name):';
  carpoolSheet.getCell(`C${waitlistHeaderRow}`).value = 'Parent Cell#:';
  carpoolSheet.getCell(`D${waitlistHeaderRow}`).value = 'Needs ("To", "From", "To and From"); + any notes:';
  ['A', 'B', 'C', 'D'].forEach(c => {
    const cell = carpoolSheet.getCell(`${c}${waitlistHeaderRow}`);
    cell.font = fontHeader11Bold;
    cell.border = borderMediumBottom;
  });
  currentRow++;

  const waitlistStartRow = currentRow;
  const unassignedScouts = (customState && customState.unassignedScouts)
    ? customState.unassignedScouts
    : scouts.filter(s => s.rideStatus !== 'confirmed' && s.rideStatus !== 'unique_first' && s.rideStatus !== 'family_match');

  unassignedScouts.forEach(s => {
    const r = currentRow;
    carpoolSheet.getCell(`A${r}`).value = formatLastFirst(s.name);
    carpoolSheet.getCell(`A${r}`).font = font11;
    carpoolSheet.getCell(`A${r}`).border = borderThin;

    carpoolSheet.getCell(`B${r}`).value = s.parentName || '';
    carpoolSheet.getCell(`B${r}`).font = font11;
    carpoolSheet.getCell(`B${r}`).border = borderThin;

    carpoolSheet.getCell(`C${r}`).value = s.parentPhone || '';
    carpoolSheet.getCell(`C${r}`).font = font11;
    carpoolSheet.getCell(`C${r}`).border = borderThin;

    const dirNote = s.needsDirection || (s.needsTo && !s.needsFrom ? 'To only' : (!s.needsTo && s.needsFrom ? 'From only' : ''));
    const notes = [
      dirNote,
      s.patrol ? `Patrol: ${s.patrol}` : '',
      s.rideNote ? s.rideNote : '',
    ].filter(Boolean).join(' | ');

    carpoolSheet.getCell(`D${r}`).value = notes || 'To and From';
    carpoolSheet.getCell(`D${r}`).font = font11;
    carpoolSheet.getCell(`D${r}`).border = borderThin;

    currentRow++;
  });

  const waitlistEndRow = Math.max(waitlistStartRow, currentRow - 1);

  // Conditional formatting on KPI cells E7, E8, E9, E12
  try {
    carpoolSheet.addConditionalFormatting({
      ref: 'E7 E12',
      rules: [
        {
          type: 'cellIs',
          operator: 'lessThanOrEqual',
          priority: 1,
          formulae: ['0'],
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' }, bgColor: { argb: 'FFC6EFCE' } },
            font: { color: { argb: 'FF006100' } },
          },
        },
        {
          type: 'cellIs',
          operator: 'greaterThan',
          priority: 2,
          formulae: ['0'],
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' }, bgColor: { argb: 'FFFFC7CE' } },
            font: { color: { argb: 'FF9C0006' } },
          },
        },
      ],
    });

    carpoolSheet.addConditionalFormatting({
      ref: 'E8 E9',
      rules: [
        {
          type: 'cellIs',
          operator: 'greaterThanOrEqual',
          priority: 3,
          formulae: ['0'],
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' }, bgColor: { argb: 'FFC6EFCE' } },
            font: { color: { argb: 'FF006100' } },
          },
        },
        {
          type: 'cellIs',
          operator: 'lessThan',
          priority: 4,
          formulae: ['0'],
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' }, bgColor: { argb: 'FFFFC7CE' } },
            font: { color: { argb: 'FF9C0006' } },
          },
        },
      ],
    });
  } catch {}

  // ==========================================
  // SHEET 2: Summary (Cross-Check COUNTIFs)
  // ==========================================
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { width: 26 }, // A: Scout
    { width: 18 }, // B: TO
    { width: 18 }, // C: FROM
    { width: 22 }, // D: WAITLIST
    { width: 5 },  // E: blank
    { width: 26 }, // F: Driver
    { width: 18 }, // G: TO
    { width: 18 }, // H: FROM
  ];

  summarySheet.getCell('A1').value = 'SCOUT (from roster):';
  summarySheet.getCell('B1').value = 'TO (from spdsht)';
  summarySheet.getCell('C1').value = 'FROM (from spdsht)';
  summarySheet.getCell('D1').value = 'WAITLIST (from spdsht)';
  summarySheet.getCell('F1').value = 'DRIVER (from roster)';
  summarySheet.getCell('G1').value = 'TO (from spdsht)';
  summarySheet.getCell('H1').value = 'FROM (from spdsht)';

  ['A1', 'B1', 'C1', 'D1', 'F1', 'G1', 'H1'].forEach(cellAddr => {
    const c = summarySheet.getCell(cellAddr);
    c.font = fontHeader11Bold;
    c.fill = fillHeaderGray;
    c.border = borderMediumBottom;
  });

  const maxRosterRows = Math.max(allRosterScouts.length, allRosterAdults.length);

  for (let i = 0; i < maxRosterRows; i++) {
    const r = i + 2;

    if (i < allRosterScouts.length) {
      summarySheet.getCell(`A${r}`).value = { formula: `'Scout roster'!A${r}` };
      summarySheet.getCell(`A${r}`).font = font11;
      summarySheet.getCell(`A${r}`).border = borderThin;

      summarySheet.getCell(`B${r}`).value = { formula: `COUNTIF(Carpool!$E$27:$M$${toEndRow}, $A${r})` };
      summarySheet.getCell(`B${r}`).font = font11;
      summarySheet.getCell(`B${r}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`B${r}`).border = borderThin;

      summarySheet.getCell(`C${r}`).value = { formula: `COUNTIF(Carpool!$E$${fromStartRow}:$M$${fromEndRow}, $A${r})` };
      summarySheet.getCell(`C${r}`).font = font11;
      summarySheet.getCell(`C${r}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`C${r}`).border = borderThin;

      summarySheet.getCell(`D${r}`).value = { formula: `COUNTIF(Carpool!$A$${waitlistStartRow}:$A$${waitlistEndRow}, $A${r})` };
      summarySheet.getCell(`D${r}`).font = font11;
      summarySheet.getCell(`D${r}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`D${r}`).border = borderThin;
    }

    if (i < allRosterAdults.length) {
      summarySheet.getCell(`F${r}`).value = { formula: `'Adult roster'!A${r}` };
      summarySheet.getCell(`F${r}`).font = font11;
      summarySheet.getCell(`F${r}`).border = borderThin;

      summarySheet.getCell(`G${r}`).value = { formula: `COUNTIF(Carpool!$A$27:$A$${toEndRow}, $F${r})` };
      summarySheet.getCell(`G${r}`).font = font11;
      summarySheet.getCell(`G${r}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`G${r}`).border = borderThin;

      summarySheet.getCell(`H${r}`).value = { formula: `COUNTIF(Carpool!$A$${fromStartRow}:$A$${fromEndRow}, $F${r})` };
      summarySheet.getCell(`H${r}`).font = font11;
      summarySheet.getCell(`H${r}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`H${r}`).border = borderThin;
    }
  }

  // ==========================================
  // SHEET 3: Scout roster
  // ==========================================
  const scoutSheet = workbook.addWorksheet('Scout roster');
  scoutSheet.columns = [
    { width: 26 }, // Name
    { width: 18 }, // Home Phone
    { width: 18 }, // Cell Phone
    { width: 30 }, // Email
    { width: 30 }, // Email #2
  ];

  scoutSheet.addRow(['Name', 'Home Phone', 'Cell Phone', 'Email', 'Email #2']);
  scoutSheet.getRow(1).eachCell(cell => {
    cell.font = fontHeader11Bold;
    cell.fill = fillHeaderGray;
    cell.border = borderMediumBottom;
  });

  allRosterScouts.forEach(s => {
    const row = scoutSheet.addRow([
      formatLastFirst(s.name),
      s.homePhone || '',
      s.phone || s.cellPhone || '',
      s.email || '',
      s.email2 || '',
    ]);
    row.eachCell(cell => {
      cell.font = font11;
      cell.border = borderThin;
    });
  });

  // ==========================================
  // SHEET 4: Adult roster
  // ==========================================
  const adultSheet = workbook.addWorksheet('Adult roster');
  adultSheet.columns = [
    { width: 26 }, // Name
    { width: 18 }, // Home Phone
    { width: 18 }, // Cell Phone
    { width: 18 }, // Business Phone
    { width: 30 }, // Email
    { width: 30 }, // Email #2
    { width: 25 }, // SMS
  ];

  adultSheet.addRow(['Name', 'Home Phone', 'Cell Phone', 'Business Phone', 'Email', 'Email #2', 'SMS']);
  adultSheet.getRow(1).eachCell(cell => {
    cell.font = fontHeader11Bold;
    cell.fill = fillHeaderGray;
    cell.border = borderMediumBottom;
  });

  allRosterAdults.forEach(a => {
    const row = adultSheet.addRow([
      formatLastFirst(a.name),
      a.homePhone || '',
      a.phone || a.cellPhone || '',
      a.businessPhone || '',
      a.email || '',
      a.email2 || '',
      a.sms || '',
    ]);
    row.eachCell(cell => {
      cell.font = font11;
      cell.border = borderThin;
    });
  });

  return workbook;
}
