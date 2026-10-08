/**
 * =========================================================================
 * 📅 SCRIPT GENERATOR JADWAL SHIFT MINGGUAN CWG (HUB CAWANG)
 * =========================================================================
 * Fitur:
 * 1. Otomatis membuat template Jadwal Shift Mingguan 7 hari (Senin s/d Minggu).
 * 2. Pre-fill 24 Karyawan CWG lengkap dengan divisi/role (Screening, Inbound, Stock Keeper, QA).
 * 3. Dropdown Data Validation Shift & Role langsung terpasang di setiap sel.
 * 4. Conditional Formatting warna shift otomatis sesuai standar (OFF kuning, S14 hitam, M22 biru, dsb).
 * 5. Formula perhitungan otomatis di bawah (Summary per shift, TOTAL hadir, dan rekap per role).
 * 6. Tampilan rapi, freeze header, border elegan, dan column widths presisi.
 * =========================================================================
 */

// Konfigurasi Standar Shift & Warna
var JADWAL_CONFIG = {
  HUB_NAME: "CWG",
  DEFAULT_START_DATE: "2026-10-05", // Format YYYY-MM-DD (Hari Senin)
  DAYS: ["SENIN", "SELASA", "RABU", "KAMIS", "JUMAT", "SABTU", "MINGGU"],
  SHIFTS: [
    "P2", "P6", "P7", "MD8", "MD9", "MD10", "MD11",
    "S12", "S14", "S16", "M18", "M19", "M20", "M21", "M22", "M23", "M24", "OFF"
  ],
  ROLES: [
    "INV_SCREENING_FF_STAFF",
    "IB_FF_STAFF",
    "INV_STOCK_KEEPER_FF_STAFF",
    "QA HUB FRESH"
  ],
  // Data Master Karyawan CWG (Bisa disesuaikan / ditambah)
  EMPLOYEES: [
    { no: 1, name: "Kurnia Bagas Pranata", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["MD11", "MD11", "MD11", "MD11", "MD11", "MD11", "OFF"] },
    { no: 2, name: "Rinny Lasmaria Sitorus", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["P6", "P6", "P6", "P6", "OFF", "OFF", "OFF"] },
    { no: 3, name: "Listiyanti Prastiwi", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["OFF", "OFF", "P6", "P6", "P6", "P6", "P6"] },
    { no: 4, name: "Rendi Fernando", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["S14", "S14", "S14", "S14", "S14", "S14", "OFF"] },
    { no: 5, name: "Bryan Heidy Raffael Rihi", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["P6", "P6", "OFF", "P6", "P6", "P6", "OFF"] },
    { no: 6, name: "Eka Karunia Syahputra", ket: "Correction, SO BAD", role: "INV_SCREENING_FF_STAFF", sample: ["OFF", "P7", "P7", "P7", "P7", "P7", "OFF"] },
    { no: 7, name: "Rendi Aji Pratama", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["OFF", "M22", "M22", "M22", "OFF", "M22", "M22"] },
    { no: 8, name: "Raditya Wardana Putra", ket: "", role: "INV_SCREENING_FF_STAFF", sample: ["M22", "OFF", "M22", "M22", "M22", "OFF", "M22"] },
    { no: 9, name: "Regowo aji bramasto", ket: "", role: "IB_FF_STAFF", sample: ["MD10", "MD10", "MD10", "MD10", "OFF", "OFF", "MD10"] },
    { no: 10, name: "RIFKY HABIBI", ket: "", role: "IB_FF_STAFF", sample: ["MD10", "MD10", "OFF", "OFF", "MD10", "MD10", "MD10"] },
    { no: 11, name: "ALI AKBAR", ket: "", role: "IB_FF_STAFF", sample: ["OFF", "OFF", "MD10", "MD10", "MD10", "MD10", "MD10"] },
    { no: 12, name: "Mochammad Yoristansyah", ket: "", role: "IB_FF_STAFF", sample: ["S14", "OFF", "S14", "S14", "S14", "S14", "S14"] },
    { no: 13, name: "IMAM WAHYUDI", ket: "", role: "IB_FF_STAFF", sample: ["S14", "S14", "S14", "S14", "S14", "S14", "OFF"] },
    { no: 14, name: "Nasyirwan z", ket: "", role: "IB_FF_STAFF", sample: ["OFF", "OFF", "OFF", "OFF", "OFF", "OFF", "OFF"] },
    { no: 15, name: "Muhammad Habibu Rachman", ket: "", role: "IB_FF_STAFF", sample: ["OFF", "M18", "M18", "M18", "M18", "M18", "M18"] },
    { no: 16, name: "FARHAN NURHIDAYAT", ket: "", role: "IB_FF_STAFF", sample: ["M22", "M22", "OFF", "OFF", "M22", "M22", "M22"] },
    { no: 17, name: "Mohammad Farhan Arofi", ket: "", role: "IB_FF_STAFF", sample: ["M18", "M18", "M18", "M18", "M18", "M18", "OFF"] },
    { no: 18, name: "Sholahuddin", ket: "", role: "IB_FF_STAFF", sample: ["M24", "M24", "OFF", "M24", "M24", "M24", "OFF"] },
    { no: 19, name: "NURUL AZHARI IMANUDIN", ket: "", role: "IB_FF_STAFF", sample: ["M24", "M24", "M24", "OFF", "OFF", "M24", "M24"] },
    { no: 20, name: "YUDHA FARDAN LESMANA", ket: "", role: "QA HUB FRESH", sample: ["OFF", "OFF", "OFF", "OFF", "OFF", "S14", "S14"] },
    { no: 21, name: "MUHAMMAD ARIE MIJATOVIC", ket: "", role: "QA HUB FRESH", sample: ["OFF", "OFF", "OFF", "OFF", "S14", "S14", "OFF"] },
    { no: 22, name: "Fathur Rizky Firdaus", ket: "Stock Keeper", role: "INV_STOCK_KEEPER_FF_STAFF", sample: ["MD8", "MD8", "MD8", "MD8", "OFF", "OFF", "MD8"] },
    { no: 23, name: "ZICO ARSYITO PUTRA ANKY", ket: "Stock Keeper", role: "INV_STOCK_KEEPER_FF_STAFF", sample: ["MD8", "MD8", "OFF", "OFF", "MD8", "MD8", "MD8"] },
    { no: 24, name: "Fathur Alamsyah", ket: "Stock Keeper", role: "INV_STOCK_KEEPER_FF_STAFF", sample: ["OFF", "OFF", "S16", "S16", "S16", "S16", "S16"] }
  ],
  // Warna Palette Shift (Background, Text)
  SHIFT_STYLES: {
    "OFF":  { bg: "#FFFF00", text: "#000000", bold: true },  // Kuning terang
    "S14":  { bg: "#374151", text: "#FFFFFF", bold: true },  // Charcoal / abu gelap
    "S16":  { bg: "#7F1D1D", text: "#FFFFFF", bold: true },  // Maroon / merah tua
    "M22":  { bg: "#1D4ED8", text: "#FFFFFF", bold: true },  // Biru royal
    "M24":  { bg: "#0E7490", text: "#FFFFFF", bold: true },  // Dark teal
    "M20":  { bg: "#15803D", text: "#FFFFFF", bold: true },  // Forest green
    "S12":  { bg: "#2563EB", text: "#FFFFFF", bold: true },  // Medium blue
    "MD10": { bg: "#BAE6FD", text: "#0284C7", bold: true },  // Light sky blue
    "MD11": { bg: "#FEF3C7", text: "#B45309", bold: true },  // Light peach / orange
    "MD8":  { bg: "#EDE9FE", text: "#7E22CE", bold: true },  // Lavender / soft purple
    "MD9":  { bg: "#DCFCE7", text: "#16A34A", bold: true },  // Light green
    "P7":   { bg: "#FEE2E2", text: "#DC2626", bold: true },  // Soft pink / red
    "P6":   { bg: "#F3F4F6", text: "#374151", bold: true },  // Light gray
    "P2":   { bg: "#F8FAFC", text: "#475569", bold: true },  // Off-white / light slate
    "M18":  { bg: "#CFFAFE", text: "#0891B2", bold: true },  // Cyan muda
    "M19":  { bg: "#FEF08A", text: "#854D0E", bold: true },  // Cream / soft amber
    "M21":  { bg: "#475569", text: "#FFFFFF", bold: true },  // Slate gray
    "M23":  { bg: "#E2E8F0", text: "#1E293B", bold: true }   // Cool gray
  }
};

/**
 * 🔘 MENU BUILDER KHUSUS JADWAL CWG
 */
function buildJadwalMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('📅 Jadwal Shift CWG')
    .addItem('✨ Buat Template Jadwal Baru (Dialog Tanggal)', 'promptGenerateJadwalCwg')
    .addItem('⚡ Buat Jadwal Minggu Ini Langsung', 'generateJadwalCurrentWeek')
    .addSeparator()
    .addItem('🎨 Terapkan Warna & Dropdown Shift (Sheet Aktif)', 'applyStylesToActiveScheduleSheet')
    .addItem('📊 Perbarui / Refresh Formula Summary (Sheet Aktif)', 'refreshScheduleSummaryFormulas')
    .addToUi();
}

/**
 * Prompt input tanggal awal (Senin) lalu generate template
 */
function promptGenerateJadwalCwg() {
  var ui = SpreadsheetApp.getUi();
  var defaultDate = getUpcomingMondayStr();

  var res = ui.prompt(
    '📅 Buat Jadwal Shift Mingguan CWG',
    'Masukkan tanggal awal minggu (Hari SENIN):\nFormat: YYYY-MM-DD (Contoh: ' + defaultDate + ' atau 2026-10-05):',
    ui.ButtonSet.OK_CANCEL
  );

  if (res.getSelectedButton() === ui.Button.OK) {
    var inputDate = res.getResponseText().trim();
    if (!inputDate) inputDate = defaultDate;
    generateJadwalCwg(inputDate);
  }
}

/**
 * Generate langsung untuk minggu ini
 */
function generateJadwalCurrentWeek() {
  var mondayStr = getUpcomingMondayStr();
  generateJadwalCwg(mondayStr);
}

/**
 * Fungsi Utama: Generate Sheet Jadwal Shift CWG Lengkap
 */
function generateJadwalCwg(mondayDateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Spreadsheet aktif tidak ditemukan.");
  }

  // 1. Parsing tanggal Senin
  var startDate = parseDateString(mondayDateStr);
  if (!startDate) {
    SpreadsheetApp.getUi().alert("❌ Format tanggal tidak valid. Gunakan format YYYY-MM-DD (contoh: 2026-10-05).");
    return;
  }

  // Hitung 7 tanggal berturut-turut (Senin s/d Minggu)
  var weekDates = [];
  for (var d = 0; d < 7; d++) {
    var cur = new Date(startDate.getTime() + (d * 24 * 60 * 60 * 1000));
    weekDates.push({
      dateStr: formatDateDDMMYYYY(cur),
      dayName: JADWAL_CONFIG.DAYS[d]
    });
  }

  var sheetName = "JADWAL CWG (" + weekDates[0].dateStr.substring(0, 5) + " - " + weekDates[6].dateStr.substring(0, 5) + ")";
  
  // 2. Buat atau ambil sheet
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    var confirm = SpreadsheetApp.getUi().alert(
      "Konfirmasi Timpa",
      "Sheet '" + sheetName + "' sudah ada. Apakah Anda ingin menimpa dan memformat ulang?",
      SpreadsheetApp.ButtonSet.YES_NO
    );
    if (confirm !== SpreadsheetApp.Button.YES) return;
    sheet.clear();
  } else {
    sheet = ss.insertSheet(sheetName);
  }

  SpreadsheetApp.setActiveSheet(sheet);

  // 3. SUSUN HEADER (Baris 1, 2, 3)
  // Baris 1: Banner Hub CWG
  sheet.getRange("A1").setValue(JADWAL_CONFIG.HUB_NAME);
  sheet.getRange("A1:K1").setBackground("#FFFF00"); // Kuning terang
  sheet.getRange("A1").setFontSize(14).setFontWeight("bold").setFontColor("#000000");
  sheet.setRowHeight(1, 32);

  // Baris 2 & 3: Header Kolom & Tanggal
  var headersRow2 = ["NO", "NAMA", "KETERANGAN", "ROLE"];
  var headersRow3 = ["", "", "", ""];

  for (var w = 0; w < weekDates.length; w++) {
    headersRow2.push(weekDates[w].dateStr);
    headersRow3.push(weekDates[w].dayName);
  }

  sheet.getRange(2, 1, 1, headersRow2.length).setValues([headersRow2]);
  sheet.getRange(3, 1, 1, headersRow3.length).setValues([headersRow3]);

  // Merge NO, NAMA, KETERANGAN, ROLE secara vertikal (Baris 2 & 3)
  sheet.getRange("A2:A3").merge();
  sheet.getRange("B2:B3").merge();
  sheet.getRange("C2:C3").merge();
  sheet.getRange("D2:D3").merge();

  // Styling Header Tabel (Baris 2 & 3: Biru Royal Modern)
  var headerRange = sheet.getRange(2, 1, 2, 11);
  headerRange
    .setBackground("#2563EB")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setFontSize(10)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  sheet.setRowHeight(2, 24);
  sheet.setRowHeight(3, 24);

  // 4. SUSUN DATA KARYAWAN (Baris 4 s/d 27)
  var empList = JADWAL_CONFIG.EMPLOYEES;
  var empRows = [];

  for (var e = 0; e < empList.length; e++) {
    var emp = empList[e];
    var row = [
      emp.no,
      emp.name,
      emp.ket || "",
      emp.role
    ];
    // Masukkan sample shift per hari
    for (var s = 0; s < 7; s++) {
      row.push((emp.sample && emp.sample[s]) ? emp.sample[s] : "OFF");
    }
    empRows.push(row);
  }

  var startEmpRow = 4;
  var endEmpRow = startEmpRow + empRows.length - 1;

  sheet.getRange(startEmpRow, 1, empRows.length, 11).setValues(empRows);

  // Styling Data Karyawan
  sheet.getRange(startEmpRow, 1, empRows.length, 1).setHorizontalAlignment("center"); // Col A: NO
  sheet.getRange(startEmpRow, 2, empRows.length, 1).setHorizontalAlignment("left").setFontWeight("bold"); // Col B: NAMA
  sheet.getRange(startEmpRow, 3, empRows.length, 1).setHorizontalAlignment("left"); // Col C: KET
  sheet.getRange(startEmpRow, 4, empRows.length, 1).setHorizontalAlignment("center"); // Col D: ROLE
  sheet.getRange(startEmpRow, 5, empRows.length, 7).setHorizontalAlignment("center").setFontWeight("bold"); // Col E-K: Shift

  for (var r = startEmpRow; r <= endEmpRow; r++) {
    sheet.setRowHeight(r, 26);
  }

  // 5. SUSUN TABEL SUMMARY PERHITUNGAN DI BAWAH (Mulai Baris 28)
  var summaryStartRow = endEmpRow + 1;
  var summaryShifts = [
    "P2", "P6", "P7", "MD8", "MD9", "MD10", "MD11",
    "S12", "S14", "S16", "M18", "M19", "M20", "M21", "M22", "M23", "M24", "OFF"
  ];

  var summaryRows = [];
  for (var si = 0; si < summaryShifts.length; si++) {
    var shiftCode = summaryShifts[si];
    var sRow = ["", shiftCode, "", ""];
    for (var colIdx = 5; colIdx <= 11; colIdx++) {
      var colLetter = getColumnLetter(colIdx);
      // Rumus COUNTIF(E$4:E$27; "P6")
      sRow.push('=COUNTIF(' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + '; "' + shiftCode + '")');
    }
    summaryRows.push(sRow);
  }

  // Baris TOTAL Manpower Masuk Kerja (Semua kecuali OFF)
  var totalRow = ["", "TOTAL", "", ""];
  for (var colIdx = 5; colIdx <= 11; colIdx++) {
    var colLetter = getColumnLetter(colIdx);
    // Rumus: COUNTIF(E$4:E$27, "<>") - COUNTIF(E$4:E$27, "OFF")
    totalRow.push('=(COUNTA(' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + ') - COUNTIF(' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + '; "OFF"))');
  }
  summaryRows.push(totalRow);

  // Breakdown per Role
  var roleBreakdowns = [
    { label: "IB_FF_STAFF", roleKey: "IB_FF_STAFF" },
    { label: "INV_STOCK_KEEPER_FF_STAFF", roleKey: "INV_STOCK_KEEPER_FF_STAFF" },
    { label: "INV_SCREENING_FF_STAFF", roleKey: "INV_SCREENING_FF_STAFF" },
    { label: "QA HUB FRESH -> untuk process Inbound", roleKey: "QA HUB FRESH" }
  ];

  for (var rb = 0; rb < roleBreakdowns.length; rb++) {
    var itemRole = roleBreakdowns[rb];
    var rRow = ["", itemRole.label, "", ""];
    for (var colIdx = 5; colIdx <= 11; colIdx++) {
      var colLetter = getColumnLetter(colIdx);
      // Rumus: COUNTIFS($D$4:$D$27, "IB_FF_STAFF", E$4:E$27, "<>OFF", E$4:E$27, "<>")
      rRow.push('=COUNTIFS($D$' + startEmpRow + ':$D$' + endEmpRow + '; "' + itemRole.roleKey + '"; ' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + '; "<>OFF"; ' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + '; "<>")');
    }
    summaryRows.push(rRow);
  }

  sheet.getRange(summaryStartRow, 1, summaryRows.length, 11).setFormulas(summaryRows);

  // Styling Summary Section
  var totalRowIndex = summaryStartRow + summaryShifts.length;
  var lastSummaryRowIndex = summaryStartRow + summaryRows.length - 1;

  // Background selang-seling warna peach lembut untuk breakdown shift
  var summaryShiftRange = sheet.getRange(summaryStartRow, 5, summaryShifts.length, 7);
  summaryShiftRange.setBackground("#FEF3C7").setFontColor("#92400E").setHorizontalAlignment("center").setFontWeight("bold");

  // Styling Baris TOTAL (Biru Royal Tebal)
  var totalRange = sheet.getRange(totalRowIndex, 1, 1, 11);
  totalRange
    .setBackground("#1D4ED8")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setFontSize(11);
  sheet.getRange(totalRowIndex, 2).setHorizontalAlignment("left");
  sheet.getRange(totalRowIndex, 5, 1, 7).setHorizontalAlignment("center");

  // Styling Breakdown Role di bawah TOTAL
  var roleRange = sheet.getRange(totalRowIndex + 1, 1, roleBreakdowns.length, 11);
  roleRange.setFontSize(9).setVerticalAlignment("middle");
  sheet.getRange(totalRowIndex + 1, 2, roleBreakdowns.length, 1).setFontWeight("bold").setHorizontalAlignment("left");
  sheet.getRange(totalRowIndex + 1, 5, roleBreakdowns.length, 7).setHorizontalAlignment("center");

  for (var sr = summaryStartRow; sr <= lastSummaryRowIndex; sr++) {
    sheet.setRowHeight(sr, 22);
  }
  sheet.setRowHeight(totalRowIndex, 28);

  // 6. ATUR LEBAR KOLOM (COLUMN WIDTHS) PRESISI
  sheet.setColumnWidth(1, 45);   // A: NO
  sheet.setColumnWidth(2, 240);  // B: NAMA
  sheet.setColumnWidth(3, 160);  // C: KETERANGAN
  sheet.setColumnWidth(4, 180);  // D: ROLE
  for (var c = 5; c <= 11; c++) {
    sheet.setColumnWidth(c, 105); // E-K: Hari 1 s/d 7
  }

  // 7. BORDER TABEL LENGKAP
  var allDataRange = sheet.getRange(2, 1, lastSummaryRowIndex - 1, 11);
  allDataRange.setBorder(true, true, true, true, true, true, "#CBD5E1", SpreadsheetApp.BorderStyle.SOLID);

  // 8. DATA VALIDATION (DROPDOWN)
  applyDropdownValidations(sheet, startEmpRow, endEmpRow);

  // 9. CONDITIONAL FORMATTING (PEWARNAAN SHIFT OTOMATIS)
  applyShiftConditionalFormatting(sheet, startEmpRow, endEmpRow);

  // 10. FREEZE ROWS & COLUMNS
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(2);

  SpreadsheetApp.flush();

  SpreadsheetApp.getUi().alert(
    "✅ Sukses!",
    "Template Jadwal Shift CWG berhasil dibuat di sheet:\n'" + sheetName + "'\n\n" +
    "• Periode: " + weekDates[0].dateStr + " s/d " + weekDates[6].dateStr + "\n" +
    "• Karyawan: " + empList.length + " Orang\n" +
    "• Formula Summary & Dropdown Warna sudah aktif otomatis!",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * Memasang Data Validation Dropdown di Kolom Shift & Role
 */
function applyDropdownValidations(sheet, startRow, endRow) {
  // Dropdown Shift (Kolom E s/d K)
  var shiftRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JADWAL_CONFIG.SHIFTS, true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange(startRow, 5, endRow - startRow + 1, 7).setDataValidation(shiftRule);

  // Dropdown Role (Kolom D)
  var roleRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JADWAL_CONFIG.ROLES, true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange(startRow, 4, endRow - startRow + 1, 1).setDataValidation(roleRule);
}

/**
 * Memasang Aturan Conditional Formatting untuk Setiap Kode Shift
 */
function applyShiftConditionalFormatting(sheet, startRow, endRow) {
  var scheduleRange = sheet.getRange(startRow, 5, endRow - startRow + 1, 7);
  var rules = sheet.getConditionalFormatRules();

  var styles = JADWAL_CONFIG.SHIFT_STYLES;

  for (var shiftCode in styles) {
    var conf = styles[shiftCode];
    var ruleBuilder = SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(shiftCode)
      .setBackground(conf.bg)
      .setFontColor(conf.text)
      .setRanges([scheduleRange]);

    if (conf.bold) {
      ruleBuilder.setBold(true);
    }
    rules.push(ruleBuilder.build());
  }

  sheet.setConditionalFormatRules(rules);
}

/**
 * Menu pembantu: Terapkan style & warna pada sheet aktif yang sedang dibuka
 */
function applyStylesToActiveScheduleSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 4) {
    SpreadsheetApp.getUi().alert("Sheet ini sepertinya belum memiliki data jadwal.");
    return;
  }
  applyDropdownValidations(sheet, 4, 27);
  applyShiftConditionalFormatting(sheet, 4, 27);
  SpreadsheetApp.getUi().alert("✅ Berhasil menerapkan Dropdown dan Pewarnaan Shift pada sheet aktif!");
}

/**
 * Menu pembantu: Refresh rumus summary
 */
function refreshScheduleSummaryFormulas() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var startEmpRow = 4;
  var endEmpRow = 27;
  var summaryStartRow = 28;

  var summaryShifts = [
    "P2", "P6", "P7", "MD8", "MD9", "MD10", "MD11",
    "S12", "S14", "S16", "M18", "M19", "M20", "M21", "M22", "M23", "M24", "OFF"
  ];

  for (var si = 0; si < summaryShifts.length; si++) {
    var sRowIdx = summaryStartRow + si;
    var shiftCode = summaryShifts[si];
    for (var colIdx = 5; colIdx <= 11; colIdx++) {
      var colLetter = getColumnLetter(colIdx);
      sheet.getRange(sRowIdx, colIdx).setFormula('=COUNTIF(' + colLetter + '$' + startEmpRow + ':' + colLetter + '$' + endEmpRow + '; "' + shiftCode + '")');
    }
  }
  SpreadsheetApp.getUi().alert("✅ Formula summary berhasil diperbarui!");
}

// =============================
// 🛠️ HELPER DATE & COLUMN
// =============================

function parseDateString(str) {
  if (!str) return null;
  // Format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    var parts = str.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  // Format DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    var parts = str.split('-');
    return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  }
  var d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateDDMMYYYY(date) {
  var day = String(date.getDate()).padStart(2, '0');
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var year = date.getFullYear();
  return day + "-" + month + "-" + year;
}

function getUpcomingMondayStr() {
  var now = new Date();
  var day = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  var diffToMonday = (day === 0 ? -6 : 1) - day;
  var monday = new Date(now.getTime() + (diffToMonday * 24 * 60 * 60 * 1000));
  var y = monday.getFullYear();
  var m = String(monday.getMonth() + 1).padStart(2, '0');
  var d = String(monday.getDate()).padStart(2, '0');
  return y + "-" + m + "-" + d;
}

function getColumnLetter(colIndex) {
  var temp = "";
  var letter = "";
  while (colIndex > 0) {
    temp = (colIndex - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colIndex = (colIndex - temp - 1) / 26;
  }
  return letter;
}
