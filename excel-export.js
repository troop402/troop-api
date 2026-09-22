import ExcelJS from 'exceljs';

/**
 * Generates an Excel workbook (.xlsx) replicating the Troop 402 carpool coordinator layout.
 * Includes Header KPIs, Guidelines, "TO the event" section (slots 1-9), "FROM the event" section,
 * and Unassigned Scouts / Waitlist.
 *
 * @param {Object} options
 * @param {Object} options.carpoolData Carpool data returned by fetchEventCarpoolDetails
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildCarpoolWorkbook(carpoolData) {
  const { meta = {}, stats = {}, drivers = [], scouts = [] } = carpoolData;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Troop 402 API';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Carpool Sheet', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });

  // Styles
  const fontTitle = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF1E293B' } };
  const fontSection = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  const fontHeader = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FF0F172A' } };
  const fontData = { name: 'Calibri', size: 9 };
  const fontMuted = { name: 'Calibri', size: 8.5, italic: true, color: { argb: 'FF64748B' } };
  const fontBold = { name: 'Calibri', size: 9, bold: true };

  const fillSectionTo = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } }; // Sky blue
  const fillSectionFrom = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9488' } }; // Teal
  const fillSectionWait = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE11D48' } }; // Rose / red
  const fillHeader = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  const fillKpi = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

  const borderThin = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };

  // Define column widths (13 main columns)
  sheet.columns = [
    { key: 'col1', width: 22 },  // Driver Name / Waitlist Scout
    { key: 'col2', width: 15 },  // Phone / Patrol
    { key: 'col3', width: 12 },  // Seats / Status
    { key: 'col4', width: 34 },  // Special Info / Notes
    { key: 'col5', width: 18 },  // Scout 1
    { key: 'col6', width: 18 },  // Scout 2
    { key: 'col7', width: 18 },  // Scout 3
    { key: 'col8', width: 18 },  // Scout 4
    { key: 'col9', width: 18 },  // Scout 5
    { key: 'col10', width: 18 }, // Scout 6
    { key: 'col11', width: 18 }, // Scout 7
    { key: 'col12', width: 18 }, // Scout 8
    { key: 'col13', width: 18 }, // Scout 9
  ];

  // 1. Title & Metadata
  const r1 = sheet.addRow(['T402G Carpool Coordinator Sheet']);
  r1.getCell(1).font = fontTitle;

  const r2 = sheet.addRow(['Trip:', meta.title || 'Troop Event', '', 'Scouts Attending (from TWH):', stats.totalAttendingScouts || 0]);
  r2.getCell(1).font = fontBold;
  r2.getCell(4).font = fontBold;

  const r3 = sheet.addRow(['"TO" Depart Date:', meta.start ? meta.start.split(' ')[0] : '', '', '# Drivers (from TWH):', stats.totalDrivers || 0]);
  r3.getCell(1).font = fontBold;
  r3.getCell(4).font = fontBold;

  const r4 = sheet.addRow(['"TO" Depart Time:', meta.start ? meta.start.split(' ').slice(1).join(' ') : '', '', 'Total Seats Offered:', stats.totalSeatsOffered || 0]);
  r4.getCell(1).font = fontBold;
  r4.getCell(4).font = fontBold;

  const r5 = sheet.addRow(['"FROM" Depart Date:', meta.end ? meta.end.split(' ')[0] : '', '', 'Net Seat Balance:', stats.seatBalance >= 0 ? `+${stats.seatBalance} (Surplus)` : `${stats.seatBalance} (DEFICIT)`]);
  r5.getCell(1).font = fontBold;
  r5.getCell(4).font = fontBold;
  if (stats.seatBalance < 0) {
    r5.getCell(5).font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FFE11D48' } };
  }

  const r6 = sheet.addRow(['"FROM" Depart Time:', meta.end ? meta.end.split(' ').slice(1).join(' ') : '', '', 'Unassigned Scouts:', stats.unassignedScoutsCount || 0]);
  r6.getCell(1).font = fontBold;
  r6.getCell(4).font = fontBold;

  const r7 = sheet.addRow(['Event Address:', meta.location || 'See TroopWebHost', '', 'Adult Passengers:', stats.adultRidersCount || 0]);
  r7.getCell(1).font = fontBold;
  r7.getCell(4).font = fontBold;

  sheet.addRow([]);

  // Instructions
  const rInst = sheet.addRow(['Instructions & Transport Guidelines:']);
  rInst.getCell(1).font = fontBold;

  const rInst1 = sheet.addRow([
    '1) Driver Certification: Completed SYT (Youth Protection) within last 12 months. Insurance: $100k injury/person, $300k accident total, $100k property.',
  ]);
  rInst1.getCell(1).font = fontMuted;

  const rInst2 = sheet.addRow([
    '2) All carpools depart from the church cabin. Return departure locations and times are at drivers’ discretion.',
  ]);
  rInst2.getCell(1).font = fontMuted;

  const rInst3 = sheet.addRow([
    '3) Please sign up even if only driving your own scout. Account for gear volume taking up seating space.',
  ]);
  rInst3.getCell(1).font = fontMuted;

  sheet.addRow([]);

  // Helper function to render a carpool section (TO or FROM)
  function renderSection(sectionTitle, sectionFill, filterPredicate) {
    const sHeader = sheet.addRow([sectionTitle]);
    sHeader.getCell(1).font = fontSection;
    sHeader.getCell(1).fill = sectionFill;
    sheet.mergeCells(`A${sHeader.number}:M${sHeader.number}`);

    const colHeaders = [
      'Driver (FIRST and LAST name)',
      'Driver Cell#',
      'Available Seats',
      "Special info (departure/return times, riders, gear notes):",
      'Scout 1',
      'Scout 2',
      'Scout 3',
      'Scout 4',
      'Scout 5',
      'Scout 6',
      'Scout 7',
      'Scout 8',
      'Scout 9',
    ];

    const hRow = sheet.addRow(colHeaders);
    hRow.eachCell((cell) => {
      cell.font = fontHeader;
      cell.fill = fillHeader;
      cell.border = borderThin;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    });
    hRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };

    const sectionDrivers = drivers.filter(filterPredicate);

    if (sectionDrivers.length === 0) {
      const emptyRow = sheet.addRow(['No drivers registered for this trip leg yet.']);
      emptyRow.getCell(1).font = fontMuted;
      sheet.mergeCells(`A${emptyRow.number}:M${emptyRow.number}`);
    } else {
      sectionDrivers.forEach((d) => {
        // Collect passengers: claimed scouts first, then adult passengers
        const riders = [];
        (d.claimedScouts || []).forEach((sc) => {
          const scName = typeof sc === 'string' ? sc : sc.name;
          riders.push(scName);
        });
        (d.claimedAdults || []).forEach((ad) => {
          const adName = typeof ad === 'string' ? ad : ad.name;
          riders.push(`Adult: ${adName}`);
        });

        // Assemble row values
        const rowVals = [
          d.name || '',
          d.phone || '',
          d.seats || 0,
          d.comment || '',
        ];

        // Fill slots 1..9
        for (let i = 0; i < 9; i++) {
          rowVals.push(riders[i] || '');
        }

        const dataRow = sheet.addRow(rowVals);
        dataRow.eachCell((cell, colNumber) => {
          cell.font = fontData;
          cell.border = borderThin;
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: colNumber === 4 };

          if (colNumber === 3) {
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.font = fontBold;
          }

          // Highlight filled vs open slots
          if (colNumber >= 5 && colNumber <= 13) {
            const slotIndex = colNumber - 5;
            const hasRider = Boolean(riders[slotIndex]);
            const isWithinCapacity = slotIndex < d.seats;

            if (hasRider) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } }; // Light blue
            } else if (isWithinCapacity && d.attending === 'Y') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } }; // Light green (Open)
            }
          }
        });
      });
    }

    sheet.addRow([]);
  }

  // 2. Render "TO the event:"
  renderSection(
    'TO the event (Outbound Caravan):',
    fillSectionTo,
    (d) => d.drivingToFrom === 'Both' || d.drivingToFrom === 'To' || !d.drivingToFrom,
  );

  // 3. Render "FROM the event:"
  renderSection(
    'FROM the event (Return Caravan):',
    fillSectionFrom,
    (d) => d.drivingToFrom === 'Both' || d.drivingToFrom === 'From',
  );

  // 4. Render "WAITLIST / UNASSIGNED SCOUTS:"
  const sWait = sheet.addRow(['WAITLIST / UNASSIGNED SCOUTS (Need Rides):']);
  sWait.getCell(1).font = fontSection;
  sWait.getCell(1).fill = fillSectionWait;
  sheet.mergeCells(`A${sWait.number}:M${sWait.number}`);

  const waitHeaders = [
    'Scout (FIRST and LAST name)',
    'Patrol',
    'Ride Status',
    'Permission Slip?',
    'Swim Test',
    'Driver Mention / Ambiguity Note',
  ];

  const wHRow = sheet.addRow(waitHeaders);
  wHRow.eachCell((cell) => {
    cell.font = fontHeader;
    cell.fill = fillHeader;
    cell.border = borderThin;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });

  const unassignedScouts = scouts.filter(
    (s) => !s.assignedDriver || s.rideStatus === 'unassigned' || s.rideStatus === 'ambiguous',
  );

  if (unassignedScouts.length === 0) {
    const allAssigned = sheet.addRow(['All attending scouts are assigned to a driver note! 🎉']);
    allAssigned.getCell(1).font = fontBold;
    allAssigned.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };
    sheet.mergeCells(`A${allAssigned.number}:F${allAssigned.number}`);
  } else {
    unassignedScouts.forEach((s) => {
      const statusLabel = s.rideStatus === 'ambiguous' ? '⚠️ Ambiguous Mention' : '⚠️ Needs Ride';
      const wRow = sheet.addRow([
        s.name || '',
        s.patrol || '',
        statusLabel,
        s.permissionGiven || 'N/A',
        s.swimTest || 'N/A',
        s.rideNote || '',
      ]);

      wRow.eachCell((cell, colNum) => {
        cell.font = fontData;
        cell.border = borderThin;
        if (colNum === 3) {
          cell.font = fontBold;
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: s.rideStatus === 'ambiguous' ? 'FFFFFBEB' : 'FFFEE2E2' },
          };
        }
      });
    });
  }

  return workbook;
}
