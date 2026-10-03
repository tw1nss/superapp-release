/**
 * ==============================================================================
 * 🚀 GOOGLE APPS SCRIPT: ED CORRECTION (MTG SYSTEM)
 * ==============================================================================
 * Sistem manajemen tugas dan koreksi Expired Date (ED) produk di rak vs sistem.
 * 
 * STRUKTUR MENU & FITUR:
 * 1. 📥 INPUT SKU (PENUGASAN TUGAS):
 *    - Assign / Paste SKU Tugas Baru (Pilih Shift, otomatis pasang tanggal & format).
 *    - Pecah / Perbaiki SKU Menumpuk di Cell C (Deteksi paste multiline dalam 1 cell).
 *    - Sinkronkan Detail SKU dari Data Update / Stock Update.
 * 
 * 2. 📋 MAIN LIST SKU:
 *    - Setup & Rapikan Format Tampilan "Main List ED Correction" (Desain tabel profesional).
 *    - Pasang Rumus Otomatis "Main List" (ARRAYFORMULA / XLOOKUP real-time).
 *    - Kosongkan / Reset Sheet "Main List" (Siap untuk penugasan shift berikutnya).
 * 
 * 3. 📑 SETUP SHEET HASIL & VALIDASI:
 *    - Setup Format Sheet "Hasil ED Correction" (Sheet penerima audit dari SuperApp).
 *    - Bersihkan Validasi Sel yang Memblokir (Hapus batasan Shift agar data Superset masuk).
 * 
 * 4. ⚙️ PENGATURAN KONEKSI & SUPERSET:
 *    - Tarik Data Superset ke Mainlist Sku (Chart ID 12077).
 *    - Set / Ganti Cookie Superset & Link Spreadsheet via Popup.
 * ==============================================================================
 */

// =============================
// ⚙️ CONFIG GLOBAL ED CORRECTION
// =============================
var EDC_CONFIG = {
  // ID Spreadsheet default Dashboard STK MTG
  DEFAULT_TARGET_ID: "1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g",
  EVIDENCE_FOLDER_ID: "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3", // Folder Drive Foto Bukti
  TIMEZONE: "Asia/Jakarta",
  // ── Konfigurasi AstroDash Superset ED Correction ──
  SUPERSET_BASE_URL: "https://dash.astronauts.id/",
  DEFAULT_CHART_ID: 12077,
  FORM_DATA_KEY: "FGnMPSQjzn-IkTT_ZdewtmeAw3D7uPCz56ErrkOHEZT-KyQ5BLwbb8-QXzzmQpaL",
  DASHBOARD_PAGE_ID: "OuCI-jVWZVevhI7VLi-Uh",
  MAX_RETRY: 3,
  RETRY_DELAY: 1500
};

// =============================
// 📑 NAMA SHEET STANDAR ED CORRECTION
// =============================
var EDC_SHEETS = {
  MAIN_LIST: "Mainlist Sku ED Corection",
  HASIL: "Hasil ED Correction",
  HISTORICAL: "Hasil ED Correction",
  DATA_UPDATE: "Data Update ED Corection",
  BACKUP: "Backup ED Corection"
};

// ==============================================================================
// 🔍 HELPER SPREADSHEET (BISA STANDALONE ATAU BOUND SPREADSHEET)
// ==============================================================================
function getEdCorrectionSpreadsheet() {
  try {
    var customId = PropertiesService.getScriptProperties().getProperty('ED_CORRECTION_SHEET_ID');
    var targetId = customId || EDC_CONFIG.DEFAULT_TARGET_ID;

    if (targetId && targetId.trim() !== "") {
      return SpreadsheetApp.openById(targetId.trim());
    }
  } catch (e) {
    console.warn("Gagal openById ED Correction, menggunakan Active Spreadsheet:", e);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getEdCorrectionSheet(type) {
  var ss = getEdCorrectionSpreadsheet();
  if (!ss) return null;

  if (type === 'MAIN_LIST') {
    return ss.getSheetByName('Mainlist Sku ED Corection') ||
      ss.getSheetByName('Main List SKU ED Correction') ||
      ss.getSheetByName('Main List ED Correction') ||
      ss.getSheetByName('Mainlist ED Correction') ||
      ss.getSheetByName('Main List SKU EDC') ||
      ss.getSheetByName('Mainlist SKU');
  }
  if (type === 'DATA_UPDATE') {
    return ss.getSheetByName('Data Update ED Corection') ||
      ss.getSheetByName('Data Update ED Correction') ||
      ss.getSheetByName('Data Update') ||
      ss.getSheetByName('Data Update ED Sweeper') ||
      ss.getSheetByName('STOCK UPDATE');
  }
  if (type === 'HASIL' || type === 'HISTORICAL') {
    return ss.getSheetByName('Hasil ED Correction') ||
      ss.getSheetByName('Hasil ED Corection') ||
      ss.getSheetByName('Hasil EDC');
  }
  if (type === 'BACKUP') {
    return ss.getSheetByName('Backup ED Corection') ||
      ss.getSheetByName('Backup Data ED Correction') ||
      ss.getSheetByName('Backup ED Correction') ||
      ss.getSheetByName('Backup Data');
  }
  return ss.getSheetByName(type);
}

// ==============================================================================
// 🔘 TRIGGER ON OPEN & PEMBUATAN MENU
// ==============================================================================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  // Panggil menu Superset, DCC, EDS, dan Pinjaman jika terintegrasi dalam 1 project
  if (typeof buildSupersetMenu === 'function') buildSupersetMenu(ui);
  if (typeof buildDccMenu === 'function') buildDccMenu(ui);
  if (typeof buildPinjamanMenu === 'function') buildPinjamanMenu(ui);
  if (typeof buildEdSweeperMenu === 'function') buildEdSweeperMenu(ui);

  // Pasang trigger auto-backup harian ED Correction (23:30 WIB)
  try {
    ensureDailyBackupTriggerEdCorrection();
  } catch (eTrig) { }

  // Bangun Menu Utama ED Correction
  buildEdCorrectionMenu(ui);
}

function buildEdCorrectionMenu(ui) {
  if (!ui) {
    try {
      ui = SpreadsheetApp.getUi();
    } catch (e) {
      return;
    }
  }

  ui.createMenu('✏️ ED Correction Control')
    .addItem('🔄 Tarik Data Superset ke Data Update ED Correction', 'updateEdCorrectionFromSupersetManual')
    .addItem('⚡ Perbaiki Rumus ED', 'autoFillEdCorrectionTaskPrompt')
    .addItem('🔧 Sinkronkan / Perbaiki Timestamp ke Hari Ini', 'fixTimestampsInMainlistPrompt')
    .addSeparator()

    // ── SUBMENU 1: INPUT SKU (PENUGASAN) ──
    .addSubMenu(ui.createMenu('📥 1. Input SKU (Penugasan Tugas)')
      .addItem('📥 Assign Tugas Baru (Multi-SKU Modal)', 'assignEdCorrectionTaskPrompt')
      .addItem('💬 Assign Tugas (Input Box Alternatif)', 'assignEdCorrectionTaskQuickPrompt')
      .addItem('🧹 Bersihkan Baris Tanggal di Kolom SKU', 'cleanInvalidSkusAndDatesInMainlist')
      .addItem('🔧 Pecah / Perbaiki SKU Menumpuk di Cell C', 'fixClumpedSkuRowsEdCorrection')
      .addItem('📋 Tarik Detail SKU dari Data Update / Stok', 'syncDetailSkuEdCorrectionManual')
    )
    .addSeparator()

    // ── SUBMENU 2: MAIN LIST ──
    .addSubMenu(ui.createMenu('📋 2. Main List SKU')
      .addItem('🎨 Setup & Buat Main List SKU Baru', 'formatMainlistSkuEdCorrection')
      .addItem('⚡ Pasang Rumus Otomatis "Main List"', 'installEdCorrectionMainlistFormulasManual')
      .addItem('⚡ Perbaiki Rumus ED', 'autoFillEdCorrectionTaskPrompt')
      .addItem('🔧 Sinkronkan / Perbaiki Timestamp ke Hari Ini', 'fixTimestampsInMainlistPrompt')
      .addItem('🔧 Bersihkan Sel Penimpa Rumus (Error D122 / #REF!)', 'repairFormulaRunwayPrompt')
      .addItem('🧹 Kosongkan / Reset Sheet "Main List"', 'resetMainlistSkuEdCorrectionPrompt')
    )
    .addSeparator()

    // ── SUBMENU 3: BACKUP & ARSIP DATA ──
    .addSubMenu(ui.createMenu('📦 3. Backup & Arsip Data')
      .addItem('📦 Backup Data Hasil ED Correction', 'backupHasilEdCorrectionManual')
      .addItem('🔄 Backup & Reset Total (Hasil + Main List)', 'backupAndResetHasilEdCorrectionManual')
      .addItem('📑 Setup Sheet "Backup ED Corection"', 'setupBackupEdCorrectionSheet')
      .addItem('🧹 Kosongkan Data Sheet "Hasil ED Correction"', 'clearHasilEdCorrectionPrompt')
    )
    .addSeparator()

    // ── PENGATURAN SHEET & VALIDASI ──
    .addItem('📑 Setup Sheet "Hasil ED Correction"', 'setupHasilEdCorrectionSheet')
    .addItem('🧹 Bersihkan Validasi Sel (Atasi Error B2)', 'clearEdCorrectionDataValidationsManual')
    .addSeparator()

    // ── PENGATURAN KONEKSI & PANDUAN ──
    .addItem('🔑 Set / Ganti Cookie Superset', 'setEdCorrectionCookiePrompt')
    .addItem('🎯 Set ID Chart Superset (Default: 12077)', 'setEdCorrectionChartIdPrompt')
    .addItem('🔗 Set / Ganti Link Spreadsheet ED Correction', 'setEdCorrectionSheetUrlPrompt')
    .addItem('📋 Panduan Pasang WebApp URL ke SuperApp', 'showEdCorrectionDeployGuidePrompt')
    .addToUi();
}

// ==============================================================================
// 🔗 0. PENGATURAN LINK SPREADSHEET (DINAMIS DARI MENU)
// ==============================================================================
function setEdCorrectionSheetUrlPrompt() {
  var ui = SpreadsheetApp.getUi();
  var currentId = PropertiesService.getScriptProperties().getProperty('ED_CORRECTION_SHEET_ID') || EDC_CONFIG.DEFAULT_TARGET_ID || '(Active Spreadsheet)';

  var response = ui.prompt(
    '🔗 Set Link / ID Spreadsheet ED Correction',
    'Paste URL Google Sheet atau ID Spreadsheet untuk ED Correction di bawah ini:\n\n' +
    'Saat ini: ' + currentId + '\n\n' +
    'Contoh URL: https://docs.google.com/spreadsheets/d/1ABC123xyz.../edit',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var rawInput = response.getResponseText().trim();
    if (!rawInput) {
      alertEdc('⚠️ Input tidak boleh kosong.');
      return;
    }

    // Ekstrak ID dari URL jika pengguna mem-paste URL lengkap
    var fileId = rawInput;
    var match = rawInput.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      fileId = match[1];
    }

    try {
      var targetSs = SpreadsheetApp.openById(fileId);
      PropertiesService.getScriptProperties().setProperty('ED_CORRECTION_SHEET_ID', fileId);
      alertEdc('✅ Berhasil Menghubungkan Spreadsheet!\n\nNama Sheet: "' + targetSs.getName() + '"\nID: ' + fileId);
    } catch (err) {
      alertEdc('❌ Gagal Mengakses Spreadsheet!\n\nDetail: ' + err.message + '\n\nPastikan ID/URL benar dan akun memiliki hak akses edit.');
    }
  }
}

// ==============================================================================
// 🚀 0.1 INTEGRASI ASTRODASH SUPERSET KE MAINLIST SKU ED CORRECTION
// ==============================================================================

/**
 * Tarik data manual dari AstroDash Superset ke sheet "Data Update ED Corection"
 */
function updateEdCorrectionFromSupersetManual() {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('DATA_UPDATE');
  var targetName = sheet ? sheet.getName() : EDC_SHEETS.DATA_UPDATE;

  // Bersihkan validasi sel lama agar data Superset tidak terblokir
  if (sheet) {
    try {
      var maxR = Math.max(sheet.getMaxRows(), 100);
      var maxC = Math.max(sheet.getMaxColumns(), 26);
      sheet.getRange(1, 1, maxR, maxC).clearDataValidations();
    } catch (eVal) { }
  }

  if (ss && typeof ss.toast === "function") {
    ss.toast("⚡ Menghubungkan ke AstroDash Superset (Chart ID 12077)...", "Loading", 4);
  }

  pullEdCorrectionSupersetDataToSheet(targetName, false);
}

/**
 * Menu manual untuk membersihkan validasi sel yang memblokir penulisan data (seperti error sel B2)
 */
function clearEdCorrectionDataValidationsManual() {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }
  try {
    var maxR = Math.max(sheet.getMaxRows(), 100);
    var maxC = Math.max(sheet.getMaxColumns(), 26);
    sheet.getRange(1, 1, maxR, maxC).clearDataValidations();
    alertEdc('✅ Validasi Data Berhasil Dibersihkan!\n\nSemua aturan validasi sel (termasuk batasan nilai Shift di sel B2) pada sheet "' + sheet.getName() + '" telah dihapus. Penarikan data Superset kini tidak akan terblokir lagi.');
  } catch (e) {
    alertEdc('❌ Gagal membersihkan validasi: ' + e.message);
  }
}

/**
 * Set Cookie Superset jika belum di-set
 */
function setEdCorrectionCookiePrompt() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentCookie = props.getProperty('MY_COOKIE') ? '(Sudah Terpasang)' : '(Belum Diisi)';

  var response = ui.prompt(
    '🔑 Set / Ganti Cookie Superset',
    'Status saat ini: ' + currentCookie + '\n\n' +
    'Paste cookie browser Anda dari dash.astronauts.id di bawah ini:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var rawCookie = response.getResponseText().trim();
    if (!rawCookie) {
      alertEdc('⚠️ Cookie tidak boleh kosong.');
      return;
    }
    props.setProperty('MY_COOKIE', rawCookie);
    alertEdc('✅ Cookie Superset berhasil disimpan! Sekarang Anda dapat menarik data dari dashboard Astro.');
  }
}

/**
 * Set ID Chart / Slice ID Superset ED Correction (Default: 12077)
 */
function setEdCorrectionChartIdPrompt() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentId = props.getProperty('SUPERSET_CHART_ID_EDC') || EDC_CONFIG.DEFAULT_CHART_ID;

  var response = ui.prompt(
    '🎯 Set ID Chart Superset ED Correction',
    'Masukkan ID Chart (Slice ID) untuk data ED Correction (Default: ' + currentId + '):\n\n' +
    'Chart saat ini: 12077 (Dashboard STK MTG)',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var id = response.getResponseText().trim();
    if (id) {
      props.setProperty('SUPERSET_CHART_ID_EDC', id);
      alertEdc('✅ ID Chart ED Correction berhasil diset ke: ' + id);
    }
  }
}

/**
 * Tarik data dari AstroDash Superset ke sheet tujuan
 */
function pullEdCorrectionSupersetDataToSheet(sheetName, isSilent) {
  var props = PropertiesService.getScriptProperties();
  var cookie = props.getProperty('MY_COOKIE');
  var chartId = props.getProperty('SUPERSET_CHART_ID_EDC') || EDC_CONFIG.DEFAULT_CHART_ID;
  var formDataKey = props.getProperty('SUPERSET_FORM_DATA_KEY_EDC') || EDC_CONFIG.FORM_DATA_KEY;
  var dashboardPageId = props.getProperty('SUPERSET_PAGE_ID_EDC') || EDC_CONFIG.DASHBOARD_PAGE_ID;

  if (!cookie) {
    if (!isSilent) {
      alertEdc('❌ Cookie Belum Diset!\n\nSilakan klik menu:\n✏️ ED Correction Control ➔ 🔑 Set / Ganti Cookie Superset\nlalu paste cookie browser Anda dari dash.astronauts.id.');
    }
    return false;
  }

  var timestamp = new Date().getTime();
  var urlVariants = [
    EDC_CONFIG.SUPERSET_BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + "&slice_id=" + chartId + "&force=true&_t=" + timestamp,
    EDC_CONFIG.SUPERSET_BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp,
    EDC_CONFIG.SUPERSET_BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({
      slice_id: Number(chartId),
      dashboard_page_id: dashboardPageId
    })) + "&force=true&_t=" + timestamp,
    EDC_CONFIG.SUPERSET_BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({
      slice_id: Number(chartId)
    })) + "&force=true&_t=" + timestamp
  ];

  var response;
  var data;
  var success = false;
  var lastError = "";

  for (var u = 0; u < urlVariants.length; u++) {
    for (var i = 0; i < EDC_CONFIG.MAX_RETRY; i++) {
      try {
        response = UrlFetchApp.fetch(urlVariants[u], {
          method: "get",
          headers: {
            "Cookie": cookie,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json"
          },
          muteHttpExceptions: true
        });

        var code = response.getResponseCode();
        if (code === 401) {
          if (!isSilent) {
            alertEdc('❌ Cookie Kadaluarsa (401 Unauthorized)!\n\nCookie Superset Anda sudah expired.\nSilakan login ke dash.astronauts.id, ambil cookie baru, lalu simpan via menu:\n✏️ ED Correction Control ➔ 🔑 Set / Ganti Cookie Superset.');
          }
          return false;
        }

        if (code !== 200) {
          lastError = "HTTP " + code;
          Utilities.sleep(EDC_CONFIG.RETRY_DELAY);
          continue;
        }

        var json = JSON.parse(response.getContentText());

        if (json.result && json.result[0] && json.result[0].data) {
          data = json.result[0].data;
        } else if (json.result && json.result[0] && json.result[0].records) {
          data = json.result[0].records;
        } else if (json.data && json.data.records) {
          data = json.data.records;
        } else if (json.colnames && json.data) {
          data = json.data.map(function (row) {
            var obj = {};
            json.colnames.forEach(function (col, idx) {
              obj[col] = row[idx];
            });
            return obj;
          });
        }

        if (data && data.length > 0) {
          processEdCorrectionSupersetDataToSheet(data, sheetName);
          success = true;
          break;
        }
      } catch (e) {
        lastError = e.message;
      }
    }
    if (success) break;
  }

  if (success) {
    if (!isSilent) {
      alertEdc('✅ Berhasil Menarik Data Superset!\n\n' + data.length + ' baris data produk berhasil diperbarui ke sheet "' + sheetName + '".');
    }
    return true;
  } else {
    if (!isSilent) {
      alertEdc('❌ Gagal Tarik Data Superset (' + sheetName + ')\n\nDetail: ' + lastError + '\n\nPastikan ID Chart (' + chartId + ') atau Cookie browser valid.');
    }
    return false;
  }
}

/**
 * Tulis data hasil query Superset ke sheet Mainlist Sku ED Corection
 */
function processEdCorrectionSupersetDataToSheet(data, sheetName) {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  if (!data || data.length === 0) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue("⚠️ Data kosong dari AstroDash");
    return;
  }

  var headers = Object.keys(data[0]);
  var qrIdx = headers.indexOf('qr_code');
  var hasSku = headers.some(function (h) { return h.toLowerCase().includes("sku"); });
  var addSkuCol = (!hasSku && qrIdx !== -1);
  if (addSkuCol) {
    headers.push('sku_number');
  }

  var rows = data.map(function (item) {
    return headers.map(function (key) {
      if (key === 'sku_number' && addSkuCol) {
        var qr = String(item['qr_code'] || '');
        return qr.split(';')[0].trim();
      }
      var value = item[key];

      // Format teks murni untuk SKU / Barcode / ID agar digit panjang tidak rusak
      var cleanKey = key.toLowerCase();
      if (cleanKey.includes("sku") || cleanKey.includes("barcode") || cleanKey === "product_id" || cleanKey === "location_id") {
        return (value !== null && value !== undefined) ? String(value) : "";
      }

      // Format angka numerik
      if (cleanKey === "msltc" || cleanKey.includes("qty") || cleanKey === "quantity" || cleanKey === "stok" || cleanKey === "stock") {
        return (value !== "" && value !== null && !isNaN(value)) ? Number(value) : value;
      }

      return (value !== null && value !== undefined) ? value : "";
    });
  });

  // Tulis ke sheet: bersihkan isi dan semua validasi data sel lama (seperti Shift di B2)
  sheet.clearContents();
  try {
    var maxR = Math.max(sheet.getMaxRows(), rows.length + 10, 100);
    var maxC = Math.max(sheet.getMaxColumns(), headers.length + 5, 26);
    sheet.getRange(1, 1, maxR, maxC).clearDataValidations();
  } catch (eVal) {
    console.warn("Gagal clear data validations:", eVal);
  }

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#1E1B4B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(1, 35);
  sheet.setFrozenRows(1);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

    // Format kolom SKU sebagai teks murni
    var skuIdx = headers.findIndex(function (h) { return h.toLowerCase().includes("sku"); });
    if (skuIdx !== -1) {
      sheet.getRange(2, skuIdx + 1, rows.length, 1).setNumberFormat('@');
    }
  }

  try {
    sheet.autoResizeColumns(1, Math.min(headers.length, 15));
  } catch (eResize) { }
}

// ==============================================================================
// 📥 1. INPUT SKU (PENUGASAN TUGAS OLEH SUPERVISOR)
// ==============================================================================

/**
 * Parsing cerdas list SKU dari teks input:
 * - Mendukung paste vertikal (enter), koma, spasi, titik koma
 * - Mendukung copas tabel multi-kolom dari Excel/Google Sheets (otomatis mendeteksi kolom SKU & mengabaikan nama/rak/tanggal)
 * - Mendukung format QR Code Superset (SKU;DDMMYYYY), otomatis mengambil SKU & membuang tanggal
 * - Menyaring header (NO, SKU, NAMA, RAK, QTY, ED) dan row number
 * - Menjaga leading zeros dan mencegah duplikasi dalam batch yang sama
 */
function parseEdCorrectionSkuInput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  var lines = rawText.split(/\r?\n/);
  var skuList = [];
  var seen = {};

  function isDateToken(tok) {
    if (!tok) return false;
    if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(tok)) return true;
    if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(tok)) return true;
    if (/^\d{8}$/.test(tok)) {
      var d = parseInt(tok.substring(0, 2), 10);
      var m = parseInt(tok.substring(2, 4), 10);
      var y = parseInt(tok.substring(4, 8), 10);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2024 && y <= 2035) return true;
      var y2 = parseInt(tok.substring(0, 4), 10);
      var m2 = parseInt(tok.substring(4, 6), 10);
      var d2 = parseInt(tok.substring(6, 8), 10);
      if (y2 >= 2024 && y2 <= 2035 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) return true;
    }
    return false;
  }

  function isHeaderToken(tok) {
    var upper = tok.toUpperCase();
    var headers = ['SKU', 'NO', 'NAMA', 'PRODUK', 'PRODUCT', 'SLOC', 'RAK', 'QTY', 'ED', 'EXPIRY', 'DATE', 'TANGGAL', 'STATUS', 'GOOD', 'BAD', 'TOTAL', 'SELISIH', 'KOREKSI', 'FISIK'];
    return headers.indexOf(upper) !== -1;
  }

  function isRackOrLocation(tok) {
    return /^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/.test(tok);
  }

  function addSku(cleanSku) {
    if (!cleanSku) return;
    cleanSku = String(cleanSku).trim();
    if (cleanSku.length >= 3 && cleanSku.length <= 30 && !seen[cleanSku] && !isHeaderToken(cleanSku) && !isDateToken(cleanSku) && !isRackOrLocation(cleanSku)) {
      seen[cleanSku] = true;
      skuList.push(cleanSku);
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Case 1: Tab-separated (copas multi-kolom Excel / Google Sheets)
    if (line.indexOf('\t') !== -1) {
      var cols = line.split('\t').map(function (c) { return c.trim(); }).filter(function (c) { return c.length > 0; });
      var foundInCols = false;

      // Prioritas 1: Format QR (SKU;DDMMYYYY) di kolom manapun
      for (var c = 0; c < cols.length; c++) {
        var colVal = cols[c];
        if (colVal.indexOf(';') !== -1) {
          var part = colVal.split(';')[0].replace(/[^\w-]/g, '').trim();
          if (part.length >= 3 && part.length <= 25 && !isDateToken(part) && !isHeaderToken(part) && !isRackOrLocation(part)) {
            addSku(part);
            foundInCols = true;
            break;
          }
        }
      }

      // Prioritas 2: Kolom numerik 3-18 digit (SKU / Barcode EAN)
      if (!foundInCols) {
        for (var c = 0; c < cols.length; c++) {
          var cleanCol = cols[c].replace(/[^\w-]/g, '').trim();
          if (/^\d{3,18}$/.test(cleanCol) && !isDateToken(cleanCol)) {
            if (/^\d{1,2}$/.test(cleanCol) && cols.length > 1) continue;
            addSku(cleanCol);
            foundInCols = true;
            break;
          }
        }
      }

      // Prioritas 3: Kolom kode SKU alphanumeric (hindari nomor urut 1, 2)
      if (!foundInCols) {
        for (var c2 = 0; c2 < cols.length; c2++) {
          var cleanCol2 = cols[c2].replace(/[^\w-]/g, '').trim();
          if (cleanCol2.length >= 3 && !isDateToken(cleanCol2) && !isHeaderToken(cleanCol2) && !isRackOrLocation(cleanCol2)) {
            if (/^\d{1,2}$/.test(cleanCol2) && cols.length > 1) continue;
            addSku(cleanCol2);
            foundInCols = true;
            break;
          }
        }
      }

      if (foundInCols) continue;
    }

    // Case 2: Multi-SKU pada baris yang sama (spasi, koma, pipe, atau semicolon QR)
    var tokens = line.split(/[\s,\|]+/).map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0; });
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (tok.indexOf(';') !== -1) {
        var parts = tok.split(';').map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
        var cleanPart = parts[0].replace(/[^\w-]/g, '').trim();
        if (cleanPart.length >= 3 && !isDateToken(cleanPart) && !isHeaderToken(cleanPart) && !isRackOrLocation(cleanPart)) {
          addSku(cleanPart);
        }
        continue;
      }

      var cleanTok = tok.replace(/[^\w-]/g, '').trim();
      if (cleanTok.length >= 3 && !isDateToken(cleanTok) && !isHeaderToken(cleanTok) && !isRackOrLocation(cleanTok)) {
        addSku(cleanTok);
      }
    }
  }

  return skuList;
}

/**
 * Dialog interaktif utama: Membuka Modal Dialog Multi-SKU dengan Textarea
 * Mencegah pemotongan baris oleh browser saat paste banyak SKU dari Excel
 */
function assignEdCorrectionTaskPrompt() {
  try {
    showAssignEdCorrectionTaskDialog();
  } catch (err) {
    Logger.log('Gagal membuka modal dialog, beralih ke prompt alternatif: ' + err);
    assignEdCorrectionTaskQuickPrompt();
  }
}

/**
 * Menampilkan Modal Dialog HTML Multi-SKU
 */
function showAssignEdCorrectionTaskDialog() {
  var html = HtmlService.createHtmlOutput(getAssignTaskDialogHtmlEdc())
    .setWidth(520)
    .setHeight(570)
    .setTitle('📥 Assign Tugas ED Correction');
  SpreadsheetApp.getUi().showModalDialog(html, '📥 Assign Tugas ED Correction');
}

/**
 * Eksekutor backend penugasan SKU (dipanggil dari HTML Modal Dialog maupun Quick Prompt)
 */
function executeAssignEdCorrectionTask(shiftLabel, assignDate, rawSkuText) {
  var skuList = parseEdCorrectionSkuInput(rawSkuText);

  if (!skuList || skuList.length === 0) {
    return {
      success: false,
      message: 'Tidak ditemukan nomor SKU yang valid dari teks yang Anda masukkan. Pastikan nomor SKU terdiri dari minimal 3 karakter.'
    };
  }

  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    formatMainlistSkuEdCorrection();
    sheet = getEdCorrectionSheet('MAIN_LIST');
  }

  if (sheet.getLastRow() < 1) {
    formatMainlistSkuEdCorrection();
  }

  var shiftText = shiftLabel || 'Shift 1 (Pagi)';
  var todayDate = assignDate || Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");

  // Cari baris kosong pertama di kolom C (SKU)
  var nextRow = 2;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var colCValues = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    var foundEmpty = false;
    for (var r = 0; r < colCValues.length; r++) {
      if (!colCValues[r][0] || String(colCValues[r][0]).trim() === '') {
        nextRow = r + 2;
        foundEmpty = true;
        break;
      }
    }
    if (!foundEmpty) {
      nextRow = lastRow + 1;
    }
  }

  var rowsToInsert = [];
  for (var j = 0; j < skuList.length; j++) {
    rowsToInsert.push([
      todayDate,    // Kolom A: TANGGAL
      shiftText,    // Kolom B: SHIFT
      skuList[j]    // Kolom C: SKU
    ]);
  }

  sheet.getRange(nextRow, 1, rowsToInsert.length, 3).setValues(rowsToInsert);
  // Format teks murni untuk SKU (cegah scientific notation / leading zero hilang)
  sheet.getRange(nextRow, 3, rowsToInsert.length, 1).setNumberFormat('@');

  for (var r = nextRow; r < nextRow + rowsToInsert.length; r++) {
    sheet.setRowHeight(r, 28);
  }

  // Pasang rumus otomatis secara instan
  installEdCorrectionMainlistFormulas(true);

  return {
    success: true,
    count: skuList.length,
    startRow: nextRow,
    endRow: nextRow + rowsToInsert.length - 1,
    sheetName: sheet.getName(),
    shift: shiftText,
    date: todayDate,
    skus: skuList
  };
}

/**
 * Prompt fallback cepat jika supervisor berada di perangkat tanpa modal dialog
 */
function assignEdCorrectionTaskQuickPrompt() {
  var ui = SpreadsheetApp.getUi();

  var shiftResp = ui.alert(
    'Pilih Shift Tugas ED Correction',
    'Pilih Shift untuk penugasan ini:\n\n- Klik YES = Shift 1 (Pagi)\n- Klik NO = Shift 2 (Siang)',
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (shiftResp === ui.Button.CANCEL) return;
  var shiftLabel = (shiftResp === ui.Button.YES) ? 'Shift 1 (Pagi)' : 'Shift 2 (Siang)';

  var skuResp = ui.prompt(
    '📥 Input List SKU - ' + shiftLabel,
    'Paste daftar SKU tugas (pisahkan koma, spasi, atau baris):',
    ui.ButtonSet.OK_CANCEL
  );

  if (skuResp.getSelectedButton() !== ui.Button.OK) return;
  var skuText = skuResp.getResponseText();

  if (!skuText || skuText.trim() === '') {
    alertEdc('⚠️ Tidak ada SKU yang dimasukkan.');
    return;
  }

  var res = executeAssignEdCorrectionTask(shiftLabel, null, skuText);
  if (!res.success) {
    alertEdc('⚠️ ' + res.message);
    return;
  }

  alertEdc(
    '✅ Berhasil Menugaskan ' + res.count + ' SKU!\n\n' +
    'Shift: ' + res.shift + '\n' +
    'Tanggal: ' + res.date + '\n' +
    'Ditambahkan mulai baris ke-' + res.startRow + ' di sheet "' + res.sheetName + '".\n\n' +
    'Detail nama produk, lokasi rak, qty sistem, dan status PENDING sudah langsung aktif!'
  );
}

/**
 * HTML UI untuk Modal Dialog Multi-SKU Penugasan
 */
function getAssignTaskDialogHtmlEdc() {
  var todayStr = Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");

  var html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <base target="_top">',
    '  <meta charset="utf-8">',
    '  <style>',
    '    * { box-sizing: border-box; margin: 0; padding: 0; }',
    '    body {',
    '      background-color: #0a0f1d;',
    '      color: #f8fafc;',
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '      padding: 16px;',
    '      font-size: 13px;',
    '      line-height: 1.4;',
    '      overflow-x: hidden;',
    '    }',
    '    .header {',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 12px;',
    '      margin-bottom: 14px;',
    '      padding-bottom: 12px;',
    '      border-bottom: 1px solid rgba(56, 189, 248, 0.2);',
    '    }',
    '    .header-icon {',
    '      font-size: 22px;',
    '      background: rgba(56, 189, 248, 0.12);',
    '      border: 1px solid rgba(56, 189, 248, 0.3);',
    '      border-radius: 8px;',
    '      width: 40px;',
    '      height: 40px;',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: center;',
    '      flex-shrink: 0;',
    '    }',
    '    .header-title {',
    '      font-size: 15px;',
    '      font-weight: 700;',
    '      color: #f8fafc;',
    '      letter-spacing: 0.3px;',
    '    }',
    '    .header-sub {',
    '      font-size: 11px;',
    '      color: #94a3b8;',
    '      margin-top: 2px;',
    '    }',
    '    .form-group { margin-bottom: 12px; }',
    '    .form-label {',
    '      display: block;',
    '      font-size: 11px;',
    '      font-weight: 600;',
    '      color: #cbd5e1;',
    '      text-transform: uppercase;',
    '      letter-spacing: 0.5px;',
    '      margin-bottom: 6px;',
    '    }',
    '    .shift-selector {',
    '      display: grid;',
    '      grid-template-columns: 1fr 1fr;',
    '      gap: 8px;',
    '    }',
    '    .shift-pill {',
    '      background: #0f172a;',
    '      border: 1.5px solid rgba(148, 163, 184, 0.25);',
    '      border-radius: 8px;',
    '      padding: 9px 12px;',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: center;',
    '      gap: 8px;',
    '      cursor: pointer;',
    '      font-weight: 600;',
    '      font-size: 12px;',
    '      color: #94a3b8;',
    '      transition: all 0.2s ease;',
    '      user-select: none;',
    '    }',
    '    .shift-pill.active {',
    '      background: rgba(56, 189, 248, 0.15);',
    '      border-color: #38bdf8;',
    '      color: #38bdf8;',
    '      box-shadow: 0 0 12px rgba(56, 189, 248, 0.2);',
    '    }',
    '    .shift-pill input { display: none; }',
    '    .row-meta { display: flex; align-items: center; gap: 10px; }',
    '    .input-date {',
    '      flex: 1;',
    '      background: #0f172a;',
    '      border: 1px solid rgba(148, 163, 184, 0.25);',
    '      border-radius: 6px;',
    '      color: #f8fafc;',
    '      padding: 7px 10px;',
    '      font-size: 12px;',
    '      font-family: inherit;',
    '      outline: none;',
    '    }',
    '    .input-date:focus {',
    '      border-color: #38bdf8;',
    '      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);',
    '    }',
    '    .textarea-header {',
    '      display: flex;',
    '      justify-content: space-between;',
    '      align-items: center;',
    '      margin-bottom: 6px;',
    '    }',
    '    .textarea-actions { display: flex; gap: 8px; }',
    '    .text-link {',
    '      color: #38bdf8;',
    '      font-size: 11px;',
    '      cursor: pointer;',
    '      text-decoration: none;',
    '    }',
    '    .text-link:hover { text-decoration: underline; }',
    '    .sku-textarea {',
    '      width: 100%;',
    '      height: 140px;',
    '      background: #070b16;',
    '      border: 1px solid rgba(148, 163, 184, 0.25);',
    '      border-radius: 8px;',
    '      color: #f8fafc;',
    '      font-family: "JetBrains Mono", Consolas, monospace;',
    '      font-size: 12px;',
    '      padding: 10px;',
    '      resize: vertical;',
    '      line-height: 1.5;',
    '      outline: none;',
    '      transition: border-color 0.2s;',
    '    }',
    '    .sku-textarea:focus {',
    '      border-color: #38bdf8;',
    '      box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);',
    '    }',
    '    .sku-textarea::placeholder {',
    '      color: #475569;',
    '      font-family: -apple-system, BlinkMacSystemFont, sans-serif;',
    '      font-size: 11px;',
    '    }',
    '    .status-bar {',
    '      display: flex;',
    '      justify-content: space-between;',
    '      align-items: center;',
    '      margin-top: 6px;',
    '      font-size: 11px;',
    '    }',
    '    .badge-count {',
    '      display: inline-flex;',
    '      align-items: center;',
    '      gap: 6px;',
    '      padding: 3px 10px;',
    '      border-radius: 12px;',
    '      background: rgba(148, 163, 184, 0.12);',
    '      color: #94a3b8;',
    '      font-weight: 600;',
    '      transition: all 0.2s;',
    '    }',
    '    .badge-count.has-data {',
    '      background: rgba(16, 185, 129, 0.15);',
    '      color: #10b981;',
    '      border: 1px solid rgba(16, 185, 129, 0.3);',
    '    }',
    '    .preview-box {',
    '      margin-top: 8px;',
    '      max-height: 58px;',
    '      overflow-y: auto;',
    '      background: rgba(15, 23, 42, 0.6);',
    '      border: 1px solid rgba(148, 163, 184, 0.15);',
    '      border-radius: 6px;',
    '      padding: 6px 8px;',
    '      display: flex;',
    '      flex-wrap: wrap;',
    '      gap: 4px;',
    '    }',
    '    .sku-chip {',
    '      background: rgba(56, 189, 248, 0.15);',
    '      color: #38bdf8;',
    '      border: 1px solid rgba(56, 189, 248, 0.3);',
    '      border-radius: 4px;',
    '      padding: 1px 6px;',
    '      font-family: "JetBrains Mono", Consolas, monospace;',
    '      font-size: 11px;',
    '      font-weight: 600;',
    '    }',
    '    .preview-empty {',
    '      color: #475569;',
    '      font-size: 11px;',
    '      font-style: italic;',
    '    }',
    '    .tip-box {',
    '      margin-top: 8px;',
    '      font-size: 11px;',
    '      color: #64748b;',
    '      line-height: 1.4;',
    '    }',
    '    .actions { display: flex; gap: 10px; margin-top: 14px; }',
    '    .btn {',
    '      flex: 1;',
    '      padding: 10px 14px;',
    '      border-radius: 8px;',
    '      font-weight: 700;',
    '      font-size: 13px;',
    '      cursor: pointer;',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: center;',
    '      gap: 6px;',
    '      border: none;',
    '      transition: all 0.18s ease;',
    '      font-family: inherit;',
    '    }',
    '    .btn:active { transform: scale(0.98); }',
    '    .btn-primary {',
    '      background: linear-gradient(135deg, #0ea5e9, #0284c7);',
    '      color: #ffffff;',
    '      box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);',
    '    }',
    '    .btn-primary:hover:not(:disabled) {',
    '      background: linear-gradient(135deg, #38bdf8, #0ea5e9);',
    '    }',
    '    .btn-primary:disabled {',
    '      opacity: 0.4;',
    '      cursor: not-allowed;',
    '      box-shadow: none;',
    '    }',
    '    .btn-secondary {',
    '      flex: 0 0 80px;',
    '      background: #1e293b;',
    '      color: #cbd5e1;',
    '      border: 1px solid rgba(148, 163, 184, 0.2);',
    '    }',
    '    .btn-secondary:hover { background: #334155; }',
    '    .success-card {',
    '      display: none;',
    '      text-align: center;',
    '      padding: 24px 12px;',
    '    }',
    '    .success-icon {',
    '      font-size: 42px;',
    '      margin-bottom: 12px;',
    '      display: inline-block;',
    '      animation: popIn 0.3s ease;',
    '    }',
    '    .success-title {',
    '      font-size: 17px;',
    '      font-weight: 700;',
    '      color: #10b981;',
    '      margin-bottom: 8px;',
    '    }',
    '    .success-detail {',
    '      font-size: 12px;',
    '      color: #cbd5e1;',
    '      background: #0f172a;',
    '      border: 1px solid rgba(16, 185, 129, 0.25);',
    '      border-radius: 8px;',
    '      padding: 12px;',
    '      margin: 14px 0;',
    '      text-align: left;',
    '      line-height: 1.6;',
    '    }',
    '    @keyframes popIn {',
    '      0% { transform: scale(0.5); opacity: 0; }',
    '      100% { transform: scale(1); opacity: 1; }',
    '    }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="formView">',
    '    <div class="header">',
    '      <div class="header-icon">📥</div>',
    '      <div>',
    '        <div class="header-title">Assign Tugas ED Correction</div>',
    '        <div class="header-sub">Paste banyak SKU sekaligus untuk penugasan shift</div>',
    '      </div>',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">Pilih Shift</label>',
    '      <div class="shift-selector">',
    '        <label class="shift-pill active" id="pillShift1">',
    '          <input type="radio" name="shift" value="Shift 1 (Pagi)" checked onchange="updateShiftSelection()">',
    '          <span>☀️ Shift 1 (Pagi)</span>',
    '        </label>',
    '        <label class="shift-pill" id="pillShift2">',
    '          <input type="radio" name="shift" value="Shift 2 (Siang)" onchange="updateShiftSelection()">',
    '          <span>🌤️ Shift 2 (Siang)</span>',
    '        </label>',
    '      </div>',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">Tanggal Penugasan</label>',
    '      <div class="row-meta">',
    '        <input type="date" id="assignDate" class="input-date" value="' + todayStr + '">',
    '      </div>',
    '    </div>',
    '    <div class="form-group">',
    '      <div class="textarea-header">',
    '        <label class="form-label" style="margin-bottom:0;">Daftar SKU Tugas</label>',
    '        <div class="textarea-actions">',
    '          <a class="text-link" onclick="clearTextarea()">Bersihkan</a>',
    '        </div>',
    '      </div>',
    '      <textarea id="skuInput" class="sku-textarea" placeholder="Paste daftar SKU di sini (bisa dari Excel / Notepad)...\nContoh 1 kolom SKU:\n493711\n493712\n\nAtau copas tabel multi-kolom Excel langsung (sistem otomatis ambil kolom SKU & lewati kolom nama/tanggal)."></textarea>',
    '      <div class="status-bar">',
    '        <span id="badgeCount" class="badge-count">⚪ Menunggu input SKU...</span>',
    '        <span id="subCount" style="color:#64748b;">0 item</span>',
    '      </div>',
    '      <div id="previewBox" class="preview-box">',
    '        <span class="preview-empty">Preview SKU yang terdeteksi akan muncul di sini...</span>',
    '      </div>',
    '      <div class="tip-box">💡 <em>Mendukung paste dari tabel Excel multi-kolom, format QR (SKU;ED), maupun enter/koma/spasi. Tanggal & header otomatis difilter.</em></div>',
    '    </div>',
    '    <div class="actions">',
    '      <button type="button" class="btn btn-secondary" onclick="google.script.host.close()">Batal</button>',
    '      <button type="button" id="btnSubmit" class="btn btn-primary" disabled onclick="submitTask()">🚀 Tugaskan SKU (0)</button>',
    '    </div>',
    '  </div>',
    '  <div id="successView" class="success-card">',
    '    <div class="success-icon">✅</div>',
    '    <div class="success-title">Berhasil Menugaskan <span id="resCount"></span> SKU!</div>',
    '    <div class="success-detail">',
    '      <div><strong>Shift:</strong> <span id="resShift"></span></div>',
    '      <div><strong>Tanggal:</strong> <span id="resDate"></span></div>',
    '      <div><strong>Lokasi:</strong> Sheet "<span id="resSheet"></span>" (Baris ke-<span id="resRow"></span>)</div>',
    '      <div style="margin-top:6px; color:#10b981; font-weight:600;">✨ Detail nama produk, rak, qty sistem & rumus otomatis sudah langsung aktif!</div>',
    '    </div>',
    '    <button type="button" class="btn btn-primary" style="width:100%;" onclick="google.script.host.close()">Selesai & Tutup</button>',
    '  </div>',
    '  <script>',
    '    var detectedSkus = [];',
    '    function updateShiftSelection() {',
    '      var shift = document.querySelector(\'input[name="shift"]:checked\').value;',
    '      var pill1 = document.getElementById("pillShift1");',
    '      var pill2 = document.getElementById("pillShift2");',
    '      if (shift.indexOf("Shift 1") !== -1) {',
    '        pill1.classList.add("active");',
    '        pill2.classList.remove("active");',
    '      } else {',
    '        pill2.classList.add("active");',
    '        pill1.classList.remove("active");',
    '      }',
    '    }',
    '    function clearTextarea() {',
    '      var ta = document.getElementById("skuInput");',
    '      ta.value = "";',
    '      parseInput();',
    '      ta.focus();',
    '    }',
    '    function isDateToken(tok) {',
    '      if (!tok) return false;',
    '      if (/^\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}$/.test(tok)) return true;',
    '      if (/^\\d{1,2}[-\\/]\\d{1,2}[-\\/]\\d{2,4}$/.test(tok)) return true;',
    '      if (/^\\d{8}$/.test(tok)) {',
    '        var d = parseInt(tok.substring(0, 2), 10);',
    '        var m = parseInt(tok.substring(2, 4), 10);',
    '        var y = parseInt(tok.substring(4, 8), 10);',
    '        if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2024 && y <= 2035) return true;',
    '        var y2 = parseInt(tok.substring(0, 4), 10);',
    '        var m2 = parseInt(tok.substring(4, 6), 10);',
    '        var d2 = parseInt(tok.substring(6, 8), 10);',
    '        if (y2 >= 2024 && y2 <= 2035 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) return true;',
    '      }',
    '      return false;',
    '    }',
    '    function isHeaderToken(tok) {',
    '      var upper = tok.toUpperCase();',
    '      var headers = ["SKU", "NO", "NAMA", "PRODUK", "PRODUCT", "SLOC", "RAK", "QTY", "ED", "EXPIRY", "DATE", "TANGGAL", "STATUS", "GOOD", "BAD", "TOTAL", "SELISIH", "KOREKSI", "FISIK"];',
    '      return headers.indexOf(upper) !== -1;',
    '    }',
    '    function isRackOrLocation(tok) {',
    '      return /^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/.test(tok);',
    '    }',
    '    function parseInput() {',
    '      var raw = document.getElementById("skuInput").value;',
    '      var lines = raw.split(/\\r?\\n/);',
    '      var skus = [];',
    '      var seen = {};',
    '      function add(s) {',
    '        if (!s) return;',
    '        s = String(s).trim();',
    '        if (s.length >= 3 && s.length <= 30 && !seen[s] && !isHeaderToken(s) && !isDateToken(s) && !isRackOrLocation(s)) {',
    '          seen[s] = true;',
    '          skus.push(s);',
    '        }',
    '      }',
    '      for (var i = 0; i < lines.length; i++) {',
    '        var line = lines[i].trim();',
    '        if (!line) continue;',
    '        if (line.indexOf("\\t") !== -1) {',
    '          var cols = line.split("\\t").map(function(c) { return c.trim(); }).filter(function(c) { return c.length > 0; });',
    '          var found = false;',
    '          for (var c = 0; c < cols.length; c++) {',
    '            var colVal = cols[c];',
    '            if (colVal.indexOf(";") !== -1) {',
    '              var part = colVal.split(";")[0].replace(/[^\\w-]/g, "").trim();',
    '              if (part.length >= 3 && part.length <= 25 && !isDateToken(part) && !isHeaderToken(part) && !isRackOrLocation(part)) { add(part); found = true; break; }',
    '            }',
    '          }',
    '          if (!found) {',
    '            for (var c = 0; c < cols.length; c++) {',
    '              var cleanCol = cols[c].replace(/[^\\w-]/g, "").trim();',
    '              if (/^\\d{3,18}$/.test(cleanCol) && !isDateToken(cleanCol)) {',
    '                if (/^\\d{1,2}$/.test(cleanCol) && cols.length > 1) continue;',
    '                add(cleanCol); found = true; break;',
    '              }',
    '            }',
    '          }',
    '          if (!found) {',
    '            for (var c2 = 0; c2 < cols.length; c2++) {',
    '              var cleanCol2 = cols[c2].replace(/[^\\w-]/g, "").trim();',
    '              if (cleanCol2.length >= 3 && !isDateToken(cleanCol2) && !isHeaderToken(cleanCol2) && !isRackOrLocation(cleanCol2)) {',
    '                if (/^\\d{1,2}$/.test(cleanCol2) && cols.length > 1) continue;',
    '                add(cleanCol2); found = true; break;',
    '              }',
    '            }',
    '          }',
    '          if (found) continue;',
    '        }',
    '        var tokens = line.split(/[\\s,\\|]+/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });',
    '        for (var t = 0; t < tokens.length; t++) {',
    '          var tok = tokens[t];',
    '          if (tok.indexOf(";") !== -1) {',
    '            var parts = tok.split(";").map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });',
    '            var cleanPart = parts[0].replace(/[^\\w-]/g, "").trim();',
    '            if (cleanPart.length >= 3 && !isDateToken(cleanPart) && !isHeaderToken(cleanPart) && !isRackOrLocation(cleanPart)) add(cleanPart);',
    '            continue;',
    '          }',
    '          var cleanTok = tok.replace(/[^\\w-]/g, "").trim();',
    '          if (cleanTok.length >= 3 && !isDateToken(cleanTok) && !isHeaderToken(cleanTok) && !isRackOrLocation(cleanTok)) add(cleanTok);',
    '        }',
    '      }',
    '      detectedSkus = skus;',
    '      var badge = document.getElementById("badgeCount");',
    '      var sub = document.getElementById("subCount");',
    '      var btn = document.getElementById("btnSubmit");',
    '      var preview = document.getElementById("previewBox");',
    '      if (skus.length === 0) {',
    '        badge.className = "badge-count";',
    '        badge.innerHTML = "⚪ Menunggu input SKU...";',
    '        sub.textContent = "0 item";',
    '        btn.disabled = true;',
    '        btn.innerHTML = "🚀 Tugaskan SKU (0)";',
    '        preview.innerHTML = \'<span class="preview-empty">Preview SKU yang terdeteksi akan muncul di sini...</span>\';',
    '      } else {',
    '        badge.className = "badge-count has-data";',
    '        badge.innerHTML = "🟢 " + skus.length + " SKU Siap Ditugaskan";',
    '        sub.textContent = skus.length + " item";',
    '        btn.disabled = false;',
    '        btn.innerHTML = "🚀 Tugaskan " + skus.length + " SKU";',
    '        var maxChips = 30;',
    '        var chipsHtml = "";',
    '        for (var k = 0; k < Math.min(skus.length, maxChips); k++) {',
    '          chipsHtml += \'<span class="sku-chip">\' + skus[k] + \'</span>\';',
    '        }',
    '        if (skus.length > maxChips) {',
    '          chipsHtml += \'<span style="color:#94a3b8; font-size:11px; align-self:center;">+\' + (skus.length - maxChips) + \' SKU lainnya</span>\';',
    '        }',
    '        preview.innerHTML = chipsHtml;',
    '      }',
    '    }',
    '    document.getElementById("skuInput").addEventListener("input", parseInput);',
    '    document.getElementById("skuInput").addEventListener("paste", function() { setTimeout(parseInput, 50); });',
    '    function submitTask() {',
    '      if (detectedSkus.length === 0) return;',
    '      var shift = document.querySelector(\'input[name="shift"]:checked\').value;',
    '      var date = document.getElementById("assignDate").value;',
    '      var raw = document.getElementById("skuInput").value;',
    '      var btn = document.getElementById("btnSubmit");',
    '      btn.disabled = true;',
    '      btn.innerHTML = "⏳ Menugaskan " + detectedSkus.length + " SKU...";',
    '      google.script.run',
    '        .withSuccessHandler(function(res) {',
    '          if (res && res.success) {',
    '            document.getElementById("formView").style.display = "none";',
    '            document.getElementById("successView").style.display = "block";',
    '            document.getElementById("resCount").textContent = res.count;',
    '            document.getElementById("resShift").textContent = res.shift;',
    '            document.getElementById("resDate").textContent = res.date;',
    '            document.getElementById("resSheet").textContent = res.sheetName;',
    '            document.getElementById("resRow").textContent = res.startRow;',
    '          } else {',
    '            alert("⚠️ " + (res ? res.message : "Gagal memproses SKU."));',
    '            btn.disabled = false;',
    '            btn.innerHTML = "🚀 Tugaskan " + detectedSkus.length + " SKU";',
    '          }',
    '        })',
    '        .withFailureHandler(function(err) {',
    '          alert("❌ Terjadi kesalahan: " + (err.message || err));',
    '          btn.disabled = false;',
    '          btn.innerHTML = "🚀 Tugaskan " + detectedSkus.length + " SKU";',
    '        })',
    '        .executeAssignEdCorrectionTask(shift, date, raw);',
    '    }',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');

  return html;
}

/**
 * Memecah baris jika ada SKU yang menumpuk di 1 sel kolom C akibat paste enter
 */
function fixClumpedSkuRowsEdCorrection() {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    alertEdc('ℹ️ Sheet Main List masih kosong.');
    return;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var newRows = [];
  var foundClumped = false;

  for (var i = 0; i < values.length; i++) {
    var tgl = values[i][0] || Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
    var shift = values[i][1] || 'Shift 1 (Pagi)';
    var rawSku = String(values[i][2] || '').trim();

    if (!rawSku) continue;

    var isClumped = (rawSku.indexOf('\n') !== -1 || rawSku.indexOf('\r') !== -1 ||
      rawSku.indexOf('\t') !== -1 || rawSku.indexOf(',') !== -1 ||
      rawSku.indexOf(';') !== -1 || rawSku.indexOf(' ') !== -1 ||
      rawSku.length > 25);

    if (isClumped) {
      foundClumped = true;
      var extracted = parseEdCorrectionSkuInput(rawSku);
      if (extracted.length > 0) {
        for (var k = 0; k < extracted.length; k++) {
          newRows.push([tgl, shift, extracted[k]]);
        }
      } else {
        newRows.push([tgl, shift, rawSku]);
      }
    } else {
      newRows.push([tgl, shift, rawSku]);
    }
  }

  if (!foundClumped) {
    alertEdc('ℹ️ Semua SKU sudah berada di barisnya masing-masing secara rapi.');
    return;
  }

  // Tulis ulang baris kolom A-C
  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  sheet.getRange(2, 1, newRows.length, 3).setValues(newRows);
  sheet.getRange(2, 3, newRows.length, 1).setNumberFormat('@');

  for (var r = 2; r <= newRows.length + 1; r++) {
    sheet.setRowHeight(r, 28);
  }

  installEdCorrectionMainlistFormulas(true);

  alertEdc(
    '✅ Berhasil Memperbaiki SKU Menumpuk!\n\n' +
    newRows.length + ' SKU kini telah dipecah menjadi baris terpisah secara rapi.\n' +
    'Rumus detail produk dan status PENDING sudah diperbarui.'
  );
}

/**
 * Auto-split onEdit handler khusus sheet Mainlist Sku ED Corection
 * Mencegah SKU yang di-paste langsung ke cell menumpuk menjadi 1 baris
 */
function handleEdCorrectionOnEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var sheetName = sheet.getName();
    if (sheetName !== 'Mainlist Sku ED Corection' && sheetName !== 'Mainlist Sku ED Correction') return;

    var col = e.range.getColumn();
    var row = e.range.getRow();

    if (col === 3 && row >= 2) {
      var val = String(e.value || e.range.getValue() || '').trim();
      if (!val) return;

      var parts = parseEdCorrectionSkuInput(val);
      if (!parts || parts.length === 0) {
        parts = val.split(/[\s,;|]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      }

      if (parts.length > 1) {
        var todayFormatted = Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
        var dateVal = sheet.getRange(row, 1).getValue() || todayFormatted;
        var shiftVal = sheet.getRange(row, 2).getValue() || 'Shift 1 (Pagi)';

        var rowsToInsert = [];
        for (var i = 0; i < parts.length; i++) {
          rowsToInsert.push([dateVal, shiftVal, parts[i]]);
        }

        sheet.getRange(row, 1, rowsToInsert.length, 3).setValues(rowsToInsert);
        sheet.getRange(row, 3, rowsToInsert.length, 1).setNumberFormat('@');
        for (var r = row; r < row + rowsToInsert.length; r++) {
          sheet.setRowHeight(r, 28);
        }
        installEdCorrectionMainlistFormulas(true);
      }
    }
  } catch (errEdit) {
    console.warn("ED Correction onEdit error:", errEdit);
  }
}

/**
 * Sinkronkan detail SKU secara hard values (opsional jika tidak menggunakan rumus)
 */
function syncDetailSkuEdCorrectionManual() {
  syncDetailSkuEdCorrection(false);
}

function syncDetailSkuEdCorrection(isSilent) {
  var mainSheet = getEdCorrectionSheet('MAIN_LIST');
  var updateSheet = getEdCorrectionSheet('DATA_UPDATE');

  if (!mainSheet || !updateSheet) {
    if (!isSilent) alertEdc('❌ Sheet Main List atau Sheet Data Update tidak ditemukan.');
    return;
  }

  var mainLastRow = mainSheet.getLastRow();
  if (mainLastRow < 2) {
    if (!isSilent) alertEdc('⚠️ Sheet Main List masih kosong.');
    return;
  }

  var updateData = updateSheet.getDataRange().getValues();
  if (updateData.length < 2) {
    if (!isSilent) alertEdc('⚠️ Sheet Data Update kosong.');
    return;
  }

  // Buat lookup map dari data update
  var updateMap = new Map();
  var upHeaders = updateData[0].map(function (h) { return String(h || '').trim().toLowerCase(); });

  var colQr = upHeaders.indexOf('qr_code');
  var colSku = upHeaders.indexOf('sku_number');
  if (colSku === -1) colSku = upHeaders.indexOf('sku');
  if (colSku === -1 && colQr !== -1) colSku = colQr;
  if (colSku === -1) colSku = 3; // Default Kolom D di Superset

  var colProdId = upHeaders.indexOf('product_id');
  var colName = upHeaders.indexOf('product_name') !== -1 ? upHeaders.indexOf('product_name') : (upHeaders.indexOf('nama produk') !== -1 ? upHeaders.indexOf('nama produk') : 4);
  var colRack = upHeaders.indexOf('rack_name') !== -1 ? upHeaders.indexOf('rack_name') : (upHeaders.indexOf('lokasi rak (sloc)') !== -1 ? upHeaders.indexOf('lokasi rak (sloc)') : 10);
  var colQty = upHeaders.indexOf('qty_system') !== -1 ? upHeaders.indexOf('qty_system') : (upHeaders.indexOf('qty sistem') !== -1 ? upHeaders.indexOf('qty sistem') : (upHeaders.indexOf('msltc') !== -1 ? upHeaders.indexOf('msltc') : 5));
  var colEd = upHeaders.indexOf('expiry_date') !== -1 ? upHeaders.indexOf('expiry_date') : (upHeaders.indexOf('ed sistem') !== -1 ? upHeaders.indexOf('ed sistem') : 6);

  for (var u = 1; u < updateData.length; u++) {
    var uRow = updateData[u];
    var rawSku = String(uRow[colSku] || '').trim();
    var rawQr = colQr !== -1 ? String(uRow[colQr] || '').trim() : '';
    var prodId = colProdId !== -1 ? String(uRow[colProdId] || '').trim() : '';

    // Ekstrak SKU bersih (sebelum tanda titik koma jika ada)
    var cleanSku = rawSku.split(';')[0].trim().toLowerCase();
    var cleanQr = rawQr.split(';')[0].trim().toLowerCase();

    var edVal = '-';
    if (uRow[colEd]) {
      if (uRow[colEd] instanceof Date) {
        edVal = Utilities.formatDate(uRow[colEd], EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
      } else {
        edVal = String(uRow[colEd]).trim();
      }
    }

    var info = {
      name: uRow[colName] || '',
      rack: uRow[colRack] || '',
      qty: (uRow[colQty] !== undefined && uRow[colQty] !== '') ? uRow[colQty] : 0,
      ed: edVal
    };

    if (cleanSku) updateMap.set(cleanSku, info);
    if (cleanQr) updateMap.set(cleanQr, info);
    if (rawSku) updateMap.set(rawSku.toLowerCase(), info);
    if (prodId) updateMap.set(prodId.toLowerCase(), info);
  }

  var mainRange = mainSheet.getRange(2, 3, mainLastRow - 1, 5); // Kolom C sampai G
  var mainValues = mainRange.getValues();
  var updatedCount = 0;

  for (var m = 0; m < mainValues.length; m++) {
    var skuVal = String(mainValues[m][0] || '').trim().toLowerCase();
    if (!skuVal) continue;

    // Abaikan jika SKU adalah baris tanggal
    if (skuVal.length === 8 && /^\d{8}$/.test(skuVal)) {
      var d = parseInt(skuVal.substring(0, 2), 10);
      var mo = parseInt(skuVal.substring(2, 4), 10);
      var y = parseInt(skuVal.substring(4, 8), 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2024 && y <= 2035) {
        continue;
      }
    }

    if (updateMap.has(skuVal)) {
      var matchInfo = updateMap.get(skuVal);
      mainValues[m][1] = matchInfo.name; // Kolom D: Nama Produk
      mainValues[m][2] = matchInfo.rack; // Kolom E: Lokasi Rak
      mainValues[m][3] = matchInfo.qty;  // Kolom F: Qty Sistem
      mainValues[m][4] = matchInfo.ed;   // Kolom G: ED Sistem
      updatedCount++;
    }
  }

  mainRange.setValues(mainValues);
  if (!isSilent) {
    alertEdc('✅ Berhasil menyinkronkan detail untuk ' + updatedCount + ' SKU dari sheet Data Update!');
  }
}

// ==============================================================================
// 📋 2. MAIN LIST SKU (SETUP FORMAT, FORMULA & RESET)
// ==============================================================================

/**
 * Setup & Styling sheet "Main List SKU ED Correction"
 * Otomatis mendeteksi jika sheet Mainlist lama berisi raw Superset data, lalu mengubahnya menjadi "Data Update ED Corection"
 */
function formatMainlistSkuEdCorrection() {
  var ss = getEdCorrectionSpreadsheet();
  if (!ss) return;

  var currentMain = ss.getSheetByName(EDC_SHEETS.MAIN_LIST);
  // Cek apakah sheet Mainlist saat ini berisi data mentah Superset (misal kolom A = location_id atau kolom D = sku_number)
  if (currentMain && currentMain.getLastRow() >= 1) {
    var firstRowVals = currentMain.getRange(1, 1, 1, Math.min(currentMain.getLastColumn(), 10)).getValues()[0].join(' ').toLowerCase();
    if (firstRowVals.indexOf('location_id') !== -1 || firstRowVals.indexOf('sku_number') !== -1) {
      var existingUpdate = ss.getSheetByName(EDC_SHEETS.DATA_UPDATE);
      if (existingUpdate && existingUpdate !== currentMain) {
        try { ss.deleteSheet(existingUpdate); } catch (eDel) { }
      }
      currentMain.setName(EDC_SHEETS.DATA_UPDATE);
      currentMain = null; // Buat sheet Mainlist baru di bawah
    }
  }

  var sheet = ss.getSheetByName(EDC_SHEETS.MAIN_LIST);
  if (!sheet) {
    sheet = ss.insertSheet(EDC_SHEETS.MAIN_LIST);
  }

  sheet.clearContents();
  sheet.clearFormats();
  try {
    sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 100), Math.max(sheet.getMaxColumns(), 26)).clearDataValidations();
  } catch (eVal) { }

  // 17 Kolom Header Lengkap (Termasuk Kolom Q: TIMESTAMP)
  var headers = [
    [
      'TANGGAL', 'SHIFT', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'QTY SISTEM', 'ED SISTEM (LAMA)',
      'ED FISIK / KOREKSI', 'STATUS ED', 'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'STATUS', 'REMARKS', 'TIMESTAMP'
    ]
  ];

  sheet.getRange(1, 1, 1, 17).setValues(headers);

  // Styling Target Supervisor (Kolom A - G: Navy Indigo #1E1B4B)
  sheet.getRange('A1:G1')
    .setBackground('#1E1B4B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  // Styling Hasil Audit Petugas (Kolom H - Q: Deep Teal #064E3B)
  sheet.getRange('H1:Q1')
    .setBackground('#064E3B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(1, 40);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);

  // Border & Format Teks Kolom C (SKU)
  var maxRows = Math.max(sheet.getMaxRows(), 100);
  sheet.getRange(1, 1, maxRows, 17).setBorder(true, true, true, true, true, true, '#CBD5E1', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(2, 3, maxRows - 1, 1).setNumberFormat('@'); // Text murni untuk SKU

  // Alternating colors
  try {
    sheet.getRange(2, 1, maxRows - 1, 17).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  } catch (eBanding) { }

  sheet.autoResizeColumns(1, 17);
  sheet.setColumnWidth(1, 110); // TANGGAL
  sheet.setColumnWidth(2, 130); // SHIFT
  sheet.setColumnWidth(3, 140); // SKU
  sheet.setColumnWidth(4, 260); // NAMA PRODUK
  sheet.setColumnWidth(5, 140); // LOKASI RAK
  sheet.setColumnWidth(8, 140); // ED FISIK / KOREKSI
  sheet.setColumnWidth(16, 180); // REMARKS
  sheet.setColumnWidth(17, 160); // TIMESTAMP

  installEdCorrectionMainlistFormulas(true);

  alertEdc('✨ Sukses!\n\nSheet "' + EDC_SHEETS.MAIN_LIST + '" baru berhasil dibuat dan siap untuk penugasan tugas shift!\n\nRumus lookup dari "' + EDC_SHEETS.DATA_UPDATE + '" dan "' + EDC_SHEETS.HASIL + '" (termasuk Kolom Q: TIMESTAMP) telah aktif.');
}

/**
 * Pasang rumus otomatis real-time di Main List ED Correction
 */
function installEdCorrectionMainlistFormulasManual() {
  installEdCorrectionMainlistFormulas(false);
}

function installEdCorrectionMainlistFormulas(isSilent) {
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    if (!isSilent) alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }

  // Nama sheet referensi
  var hasilSheet = getEdCorrectionSheet('HASIL');
  var hasilName = hasilSheet ? hasilSheet.getName() : EDC_SHEETS.HASIL;

  var updateSheet = getEdCorrectionSheet('DATA_UPDATE');
  var updateName = updateSheet ? updateSheet.getName() : EDC_SHEETS.DATA_UPDATE;

  // SANGAT PENTING: Bersihkan semua sel dari baris 3 ke bawah untuk Kolom D sampai Q (kolom 4 sampai 17)
  // Ini MENCEGAH error fatal: "Hasil array tidak diperluas karena akan menimpa data di D..." (#REF!)
  var maxRows = sheet.getMaxRows();
  if (maxRows > 2) {
    sheet.getRange(3, 4, maxRows - 2, Math.max(14, sheet.getLastColumn() - 3)).clearContent();
  }

  // 1. DETAIL PRODUK DARI DATA UPDATE (Kolom D, E, F, G)
  // Di Data Update ED Correction Superset:
  // - Col D = qr_code (format "SKU;DDMMYYYY", contoh: "493711;05102026")
  // - Col E = product_name ("Melon Sky Rocket...")
  // - Col F = qty_system ("1")
  // - Col G = expiry_date ("2026-10-05")
  // - Col K = rack_name ("L1-AMF-RF4-T3-4")
  // - Col L (jika ada) = sku_number ("493711")

  // Kolom D: Nama Produk
  sheet.getRange('D2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", ' +
    'IFERROR(XLOOKUP(TRIM(sku) & ";*", \'' + updateName + '\'!D:D, \'' + updateName + '\'!E:E, "", 2), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!D:D, \'' + updateName + '\'!E:E, "", 0), ' +
    'IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + updateName + '\'!D:D, \'' + updateName + '\'!E:E, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!L:L, \'' + updateName + '\'!E:E, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!B:B, \'' + updateName + '\'!E:E, "", 0), ""))))))))'
  );

  // Kolom E: Lokasi Rak (SLOC) -> Mengambil Kolom K (rack_name)
  sheet.getRange('E2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", ' +
    'IFERROR(XLOOKUP(TRIM(sku) & ";*", \'' + updateName + '\'!D:D, \'' + updateName + '\'!K:K, "", 2), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!D:D, \'' + updateName + '\'!K:K, "", 0), ' +
    'IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + updateName + '\'!D:D, \'' + updateName + '\'!K:K, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!L:L, \'' + updateName + '\'!K:K, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!B:B, \'' + updateName + '\'!K:K, "", 0), ""))))))))'
  );

  // Kolom F: Qty Sistem -> Mengambil Kolom F (qty_system)
  sheet.getRange('F2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", ' +
    'IFERROR(XLOOKUP(TRIM(sku) & ";*", \'' + updateName + '\'!D:D, \'' + updateName + '\'!F:F, "", 2), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!D:D, \'' + updateName + '\'!F:F, "", 0), ' +
    'IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + updateName + '\'!D:D, \'' + updateName + '\'!F:F, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!L:L, \'' + updateName + '\'!F:F, "", 0), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!B:B, \'' + updateName + '\'!F:F, "", 0), 0))))))))'
  );

  // Kolom G: ED Sistem (Lama) -> Mengambil Kolom G (expiry_date)
  sheet.getRange('G2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", ' +
    'IFERROR(TEXT(XLOOKUP(TRIM(sku) & ";*", \'' + updateName + '\'!D:D, \'' + updateName + '\'!G:G, "", 2), "yyyy-mm-dd"), ' +
    'IFERROR(TEXT(XLOOKUP(TRIM(sku), \'' + updateName + '\'!D:D, \'' + updateName + '\'!G:G, "", 0), "yyyy-mm-dd"), ' +
    'IFERROR(XLOOKUP(TRIM(sku) & ";*", \'' + updateName + '\'!D:D, \'' + updateName + '\'!G:G, "", 2), ' +
    'IFERROR(XLOOKUP(TRIM(sku), \'' + updateName + '\'!D:D, \'' + updateName + '\'!G:G, "", 0), "-")))))))'
  );

  // 2. HASIL AUDIT & KOREKSI DARI SHEET HASIL (Kolom H - Q)
  // XLOOKUP search_mode = -1 mengambil audit paling akhir/terbaru untuk SKU tersebut
  // Kolom H: ED Fisik / Koreksi Baru
  sheet.getRange('H2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!H:H, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!H:H, "", 0, -1), "")))))'
  );
  // Kolom I: Status ED (MATCH / REVISI)
  sheet.getRange('I2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!I:I, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!I:I, "", 0, -1), "")))))'
  );
  // Kolom J: Fisik Good
  sheet.getRange('J2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!J:J, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!J:J, "", 0, -1), "")))))'
  );
  // Kolom K: Fisik Bad
  sheet.getRange('K2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!K:K, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!K:K, "", 0, -1), "")))))'
  );
  // Kolom L: Total Fisik (J + K)
  sheet.getRange('L2').setFormula(
    '=ARRAYFORMULA(IF(C2:C="", "", IF((J2:J="")*(K2:K=""), "", N(J2:J) + N(K2:K))))'
  );
  // Kolom M: Selisih (Total Fisik - Qty Sistem)
  sheet.getRange('M2').setFormula(
    '=ARRAYFORMULA(IF(C2:C="", "", IF(L2:L="", "", N(L2:L) - N(F2:F))))'
  );
  // Kolom N: Petugas
  sheet.getRange('N2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!N:N, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!N:N, "", 0, -1), "")))))'
  );
  // Kolom O: Status (DONE jika Kolom H/J terisi, jika belum PENDING)
  sheet.getRange('O2').setFormula(
    '=ARRAYFORMULA(IF(C2:C="", "", IF(H2:H<>"", "DONE", "PENDING")))'
  );
  // Kolom P: Remarks
  sheet.getRange('P2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!Q:Q, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!Q:Q, "", 0, -1), "")))))'
  );
  // Kolom Q: Timestamp Audit dari Sheet Hasil (Kolom A)
  sheet.getRange('Q2').setFormula(
    '=MAP(C2:C, LAMBDA(sku, IF(sku="", "", IFERROR(XLOOKUP(TRIM(sku), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!A:A, "", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), \'' + hasilName + '\'!B:B, \'' + hasilName + '\'!A:A, "", 0, -1), "")))))'
  );

  if (!isSilent) {
    alertEdc(
      '✅ Berhasil memasang rumus otomatis di "' + sheet.getName() + '"!\n\n' +
      'Data detail produk dan hasil audit dari sheet "' + hasilName + '" kini tersinkronisasi secara real-time.'
    );
  }
}

/**
 * Kosongkan / Reset sheet Main List untuk hari berikutnya
 */
function resetMainlistSkuEdCorrectionPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'Konfirmasi Reset "Main List ED Correction"',
    'Apakah Anda yakin ingin mengosongkan data tugas di sheet "Main List ED Correction" untuk sesi berikutnya?\n\n(Catatan: Header dan format tabel akan tetap terjaga).',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(lastCol, 16)).clearContent();
  }

  installEdCorrectionMainlistFormulas(true);
  alertEdc('✅ Sheet "Main List ED Correction" telah bersih dan siap untuk penugasan baru!');
}

/**
 * Membersihkan baris yang berisi tanggal terselip di kolom SKU (contoh: 05102026, 06102026, dll.)
 * Sekaligus membersihkan runway kolom D-P agar error #REF! langsung sembuh
 */
function cleanInvalidSkusAndDatesInMainlist() {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    alertEdc('ℹ️ Sheet Main List masih kosong.');
    return;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var cleanRows = [];
  var removedDatesCount = 0;

  for (var i = 0; i < values.length; i++) {
    var tgl = values[i][0];
    var shift = values[i][1];
    var sku = String(values[i][2] || '').trim();

    if (!sku) continue;

    // Deteksi apakah SKU ini sebenarnya adalah format tanggal:
    // 1. Format 8 digit ddmmyyyy (contoh: 05102026 -> 05/10/2026, 30092026 -> 30/09/2026)
    var is8DigitDate = false;
    if (sku.length === 8 && /^\d{8}$/.test(sku)) {
      var day = parseInt(sku.substring(0, 2), 10);
      var month = parseInt(sku.substring(2, 4), 10);
      var year = parseInt(sku.substring(4, 8), 10);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2024 && year <= 2035) {
        is8DigitDate = true;
      }
    }

    // 2. Format tanggal umum dengan separator
    var isFormattedDate = /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(sku) || /^\d{4}-\d{2}-\d{2}$/.test(sku);

    if (is8DigitDate || isFormattedDate) {
      removedDatesCount++;
      continue; // Lewati baris ini (hapus dari daftar SKU tugas)
    }

    cleanRows.push([tgl, shift, sku]);
  }

  // Bersihkan seluruh data lama di Mainlist (termasuk cell D122 dll yang memblokir formula)
  var totalRowsToClear = Math.max(lastRow, sheet.getMaxRows()) - 1;
  sheet.getRange(2, 1, totalRowsToClear, sheet.getLastColumn()).clearContent();

  if (cleanRows.length > 0) {
    sheet.getRange(2, 1, cleanRows.length, 3).setValues(cleanRows);
    sheet.getRange(2, 3, cleanRows.length, 1).setNumberFormat('@');
    for (var r = 2; r <= cleanRows.length + 1; r++) {
      sheet.setRowHeight(r, 28);
    }
  }

  // Pasang kembali rumus otomatis dengan runway yang bersih
  installEdCorrectionMainlistFormulas(true);

  alertEdc(
    '✅ Berhasil Membersihkan Baris SKU!\n\n' +
    '• ' + removedDatesCount + ' baris tanggal terselip berhasil dihapus.\n' +
    '• ' + cleanRows.length + ' SKU valid dipertahankan.\n' +
    '• Runway kolom D-P (termasuk sel D122) telah bersih.\n' +
    '• Rumus Nama Produk, Rak, dan Qty kini otomatis muncul tanpa error #REF!.'
  );
}

/**
 * Utility untuk membersihkan sel penimpa rumus jika muncul error #REF! "menimpa data di D..."
 */
function repairFormulaRunwayPrompt() {
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }
  var maxRows = sheet.getMaxRows();
  if (maxRows > 2) {
    sheet.getRange(3, 4, maxRows - 2, Math.max(13, sheet.getLastColumn() - 3)).clearContent();
  }
  installEdCorrectionMainlistFormulas(true);
  alertEdc('✅ Perbaikan Rumus Selesai!\n\nSemua sel di bawah baris 2 pada kolom D-P (termasuk sel D122) telah dibersihkan.\nRumus MAP/XLOOKUP kini dapat meluas tanpa hambatan dan error #REF! telah sembuh.');
}

// ==============================================================================
// 📑 3. SETUP SHEET HASIL ED CORRECTION & PEMELIHARAAN
// ==============================================================================

/**
 * Setup sheet "Hasil ED Correction" (Sheet penerima audit dari SuperApp)
 */
function setupHasilEdCorrectionSheet() {
  var ss = getEdCorrectionSpreadsheet();
  if (!ss) return;

  var sheet = ss.getSheetByName('Hasil ED Correction') || ss.getSheetByName('Hasil ED Corection');
  if (!sheet) {
    sheet = ss.insertSheet('Hasil ED Correction');
  }

  // Jika sheet berisi dump data mentah (misal header location_id atau bukan header standar audit), bersihkan dulu
  var firstCell = String(sheet.getRange(1, 1).getValue() || '').trim().toLowerCase();
  if (firstCell === 'location_id' || firstCell === 'product_id' || firstCell === '98') {
    sheet.clearContents();
  }

  var headers = [
    [
      'TIMESTAMP', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'SLOC ACTUAL',
      'SLOC MATCH?', 'ED SISTEM (LAMA)', 'ED FISIK / KOREKSI', 'STATUS ED',
      'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'SHIFT',
      'BUKTI FOTO (DRIVE)', 'REMARKS'
    ]
  ];

  sheet.getRange(1, 1, 1, 17).setValues(headers);
  sheet.getRange(1, 1, 1, 17)
    .setBackground('#0F766E') // Astro Teal
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(1, 35);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  try {
    sheet.autoResizeColumns(1, 17);
  } catch (e) { }

  alertEdc('✅ Sheet "' + sheet.getName() + '" berhasil disetup dengan 17 kolom standar audit!');
}

/**
 * Bersihkan sel di bawah header yang menimpa rumus ARRAYFORMULA / MAP
 */
function repairFormulaColumnsEdCorrectionManual() {
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    alertEdc('❌ Sheet Main List ED Correction tidak ditemukan.');
    return;
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1) {
    alertEdc('ℹ️ Sheet Main List masih kosong.');
    return;
  }

  var formulas = sheet.getRange(1, 1, 1, lastCol).getFormulas()[0];
  var fixedCols = [];

  for (var c = 0; c < formulas.length; c++) {
    var f = String(formulas[c] || '').toUpperCase();
    if (f.indexOf('ARRAYFORMULA') !== -1 || f.indexOf('=MAP(') !== -1 || f.indexOf('={') === 0) {
      sheet.getRange(2, c + 1, lastRow - 1, 1).clearContent();
      fixedCols.push(sheet.getRange(1, c + 1).getA1Notation().replace(/\d+/, ''));
    }
  }

  installEdCorrectionMainlistFormulas(true);

  if (fixedCols.length > 0) {
    alertEdc('✅ Perbaikan Rumus Selesai!\n\nKolom ' + fixedCols.join(', ') + ' berhasil dibersihkan dari data menimpa. Rumus kini aktif normal.');
  } else {
    alertEdc('ℹ️ Semua kolom rumus sudah aktif dan normal.');
  }
}

/**
 * Kosongkan data sheet Hasil ED Correction
 */
function clearHasilEdCorrectionPrompt() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Konfirmasi Hapus Data Hasil ED Correction',
    'Apakah Anda yakin ingin mengosongkan semua data audit di sheet "Hasil ED Correction"?\n\nPastikan Anda sudah mem-backup data terlebih dahulu!',
    ui.ButtonSet.YES_NO
  );

  if (resp !== ui.Button.YES) return;

  var sheet = getEdCorrectionSheet('HASIL');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var maxRows = sheet.getMaxRows();
  var frozenRows = Math.max(sheet.getFrozenRows(), 1);

  if (lastRow > frozenRows) {
    sheet.getRange(frozenRows + 1, 1, lastRow - frozenRows, Math.max(sheet.getLastColumn(), 17)).clearContent();
    var keepRows = frozenRows + 1;
    if (maxRows > keepRows) {
      try {
        sheet.deleteRows(keepRows + 1, maxRows - keepRows);
      } catch (eDel) {
        console.warn('Gagal deleteRows di Hasil ED Correction:', eDel);
      }
    }
    alertEdc('✅ Data di sheet "Hasil ED Correction" telah berhasil dibersihkan.');
  } else {
    alertEdc('ℹ️ Sheet "Hasil ED Correction" memang sudah kosong.');
  }
}

// ==============================================================================
// 📦 3.1 FITUR BACKUP HASIL ED CORRECTION & ARSIP
// ==============================================================================

/**
 * Backup manual data sheet Hasil ED Correction ke sheet Backup ED Corection
 */
function backupHasilEdCorrectionManual() {
  var res = backupHasilEdCorrectionToBackupSheet(false);
  alertEdc(res.message);
}

/**
 * Backup dan reset total: data Hasil disimpan ke Backup, lalu Hasil & Mainlist dikosongkan
 */
function backupAndResetHasilEdCorrectionManual() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert(
    'Konfirmasi Backup & Reset Total ED Correction',
    'Semua data audit di sheet "Hasil ED Correction" akan disimpan ke sheet "Backup ED Corection".\n\n' +
    'Setelah itu, sheet "Hasil ED Correction" dan sheet "Main List" akan otomatis dikosongkan untuk persiapan sesi/shift tugas berikutnya.\n\n' +
    'Apakah Anda ingin melanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var res = backupHasilEdCorrectionToBackupSheet(true);
  alertEdc(res.message);
}

/**
 * Setup format & desain sheet "Backup ED Corection"
 */
function setupBackupEdCorrectionSheet() {
  var ss = getEdCorrectionSpreadsheet();
  if (!ss) return;

  var sheet = getEdCorrectionSheet('BACKUP');
  if (!sheet) {
    sheet = ss.insertSheet(EDC_SHEETS.BACKUP);
  }

  var headers = [
    [
      'TIMESTAMP', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'SLOC ACTUAL',
      'SLOC MATCH?', 'ED SISTEM (LAMA)', 'ED FISIK / KOREKSI', 'STATUS ED',
      'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'SHIFT',
      'BUKTI FOTO (DRIVE)', 'REMARKS', 'WAKTU BACKUP', 'BATCH ID'
    ]
  ];

  sheet.getRange(1, 1, 1, 19).setValues(headers);
  sheet.getRange(1, 1, 1, 19)
    .setBackground('#1E1B4B') // Indigo Navy
    .setFontColor('#FBBF24') // Amber Gold text
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(1, 35);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  try {
    sheet.autoResizeColumns(1, 19);
  } catch (e) { }

  alertEdc('✅ Sheet "' + sheet.getName() + '" berhasil disetup dan siap menyimpan arsip data!');
}

/**
 * Fungsi inti pemindahan data dari Hasil ED Correction ke Backup ED Corection
 */
function backupHasilEdCorrectionToBackupSheet(autoClear) {
  var ss = getEdCorrectionSpreadsheet();
  var hasilSheet = getEdCorrectionSheet('HASIL');

  if (!hasilSheet || hasilSheet.getLastRow() <= 1) {
    return {
      success: false,
      message: 'ℹ️ Sheet "Hasil ED Correction" masih kosong atau belum memiliki data untuk di-backup.'
    };
  }

  var backupSheet = getEdCorrectionSheet('BACKUP');
  var headers = [
    'TIMESTAMP', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'SLOC ACTUAL',
    'SLOC MATCH?', 'ED SISTEM (LAMA)', 'ED FISIK / KOREKSI', 'STATUS ED',
    'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'SHIFT',
    'BUKTI FOTO (DRIVE)', 'REMARKS', 'WAKTU BACKUP', 'BATCH ID'
  ];

  if (!backupSheet) {
    backupSheet = ss.insertSheet(EDC_SHEETS.BACKUP);
    backupSheet.appendRow(headers);
    backupSheet.getRange(1, 1, 1, headers.length)
      .setBackground('#1E1B4B')
      .setFontColor('#FBBF24')
      .setFontWeight('bold');
    backupSheet.setFrozenRows(1);
  } else if (backupSheet.getLastRow() === 0) {
    backupSheet.appendRow(headers);
  }

  var hasilData = hasilSheet.getDataRange().getValues();
  var dataRows = hasilData.slice(1).filter(function (r) {
    return String(r[0] || r[1] || '').trim() !== '';
  });

  if (dataRows.length === 0) {
    return {
      success: false,
      message: '⚠️ Tidak ada baris data valid di sheet ' + hasilSheet.getName() + '.'
    };
  }

  var existingBackup = backupSheet.getLastRow() > 1 ? backupSheet.getDataRange().getValues() : [];
  var existingKeys = new Set();
  for (var i = 1; i < existingBackup.length; i++) {
    var bTime = String(existingBackup[i][0] || '').trim();
    var bSku = String(existingBackup[i][1] || '').trim().toLowerCase();
    if (bSku || bTime) {
      existingKeys.add(bTime + '___' + bSku);
    }
  }

  var now = new Date();
  var waktuBackup = Utilities.formatDate(now, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy HH:mm:ss");
  var batchId = 'BATCH-EDC-' + Utilities.formatDate(now, EDC_CONFIG.TIMEZONE, "yyyyMMdd-HHmmss");

  var rowsToAppend = [];
  var duplicateCount = 0;

  for (var j = 0; j < dataRows.length; j++) {
    var row = dataRows[j];
    var time = String(row[0] || '').trim();
    var sku = String(row[1] || '').trim().toLowerCase();
    var key = time + '___' + sku;

    if (!existingKeys.has(key)) {
      var fullRow = row.slice(0, 17);
      while (fullRow.length < 17) fullRow.push('');
      fullRow.push(waktuBackup);
      fullRow.push(batchId);
      rowsToAppend.push(fullRow);
      existingKeys.add(key);
    } else {
      duplicateCount++;
    }
  }

  if (rowsToAppend.length > 0) {
    var startRow = backupSheet.getLastRow() + 1;
    backupSheet.getRange(startRow, 1, rowsToAppend.length, headers.length).setValues(rowsToAppend);
  }

  var msg = '📦 Berhasil mem-backup ' + rowsToAppend.length + ' baris ke sheet "' + backupSheet.getName() + '"!\n(Batch: ' + batchId + ')';
  if (duplicateCount > 0) {
    msg += '\n(' + duplicateCount + ' baris sudah ada sebelumnya di arsip dan dilewati).';
  }

  if (autoClear) {
    // 1. Kosongkan Hasil ED Correction
    var lastH = hasilSheet.getLastRow();
    var maxH = hasilSheet.getMaxRows();
    var frozenH = Math.max(hasilSheet.getFrozenRows(), 1);

    if (lastH > frozenH) {
      hasilSheet.getRange(frozenH + 1, 1, lastH - frozenH, Math.max(hasilSheet.getLastColumn(), 17)).clearContent();
      var keepH = frozenH + 1;
      if (maxH > keepH) {
        try {
          hasilSheet.deleteRows(keepH + 1, maxH - keepH);
        } catch (eDelH) {
          console.warn('Gagal deleteRows saat autoClear Hasil ED Correction:', eDelH);
        }
      }
    }
    msg += '\n\n✅ Sheet "Hasil ED Correction" telah dikosongkan.';

    // 2. Kosongkan Main List & pasang kembali rumus
    var mainSheet = getEdCorrectionSheet('MAIN_LIST');
    if (mainSheet) {
      var lastM = mainSheet.getLastRow();
      if (lastM > 1) {
        mainSheet.getRange(2, 1, lastM - 1, Math.max(mainSheet.getLastColumn(), 16)).clearContent();
      }
      installEdCorrectionMainlistFormulas(true);
      msg += '\n✅ Sheet "Main List" telah di-reset dan siap untuk penugasan shift berikutnya.';
    }
  }

  return {
    success: true,
    message: msg
  };
}

/**
 * Auto-backup harian malam hari (23:30 WIB)
 */
function ensureDailyBackupTriggerEdCorrection() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyAutoBackupTaskEdCorrection') {
      return; // Trigger sudah aktif
    }
  }
  ScriptApp.newTrigger('dailyAutoBackupTaskEdCorrection')
    .timeBased()
    .atHour(23)
    .everyDays(1)
    .inTimezone(EDC_CONFIG.TIMEZONE)
    .create();
  console.log('Background Daily Backup Trigger ED Correction (23:00 WIB) aktif.');
}

function dailyAutoBackupTaskEdCorrection() {
  try {
    backupHasilEdCorrectionToBackupSheet(false);
  } catch (err) {
    console.error('Error saat auto-backup harian ED Correction:', err);
  }
}

// ==============================================================================
// 📡 4. ROUTER API WEB APP (DOPost & DOGET UNTUK SUPERAPP SCANNER)
// ==============================================================================

/**
 * Handler POST audit ED Correction dari aplikasi scanner / mobile
 */
function handleEdCorrectionSubmit(payload) {
  try {
    var sheet = getEdCorrectionSheet('HASIL');
    if (!sheet) {
      setupHasilEdCorrectionSheet();
      sheet = getEdCorrectionSheet('HASIL');
    }

    if (sheet && (sheet.getLastRow() === 0 || (sheet.getLastRow() === 1 && !sheet.getRange(1, 1).getValue()))) {
      var headerRow = [
        [
          'TIMESTAMP', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'SLOC ACTUAL',
          'SLOC MATCH?', 'ED SISTEM (LAMA)', 'ED FISIK / KOREKSI', 'STATUS ED',
          'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'SHIFT',
          'BUKTI FOTO (DRIVE)', 'REMARKS'
        ]
      ];
      sheet.getRange(1, 1, 1, 17).setValues(headerRow);
      sheet.getRange(1, 1, 1, 17)
        .setBackground('#581C87')
        .setFontColor('#FFFFFF')
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
      sheet.setRowHeight(1, 35);
    }

    var now = new Date();
    var timestamp = Utilities.formatDate(now, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy HH:mm:ss");

    var sku = String(payload.sku || payload.skuNo || '').trim();
    var productName = String(payload.productName || payload.namaSku || '').trim();
    var rackSystem = String(payload.rackSystem || payload.slocExisting || '').trim();
    var rackActual = String(payload.rackActual || payload.slocActual || rackSystem).trim();
    var rackMatch = (rackSystem.toUpperCase() === rackActual.toUpperCase()) ? "MATCH" : "UNMATCH";

    var edSystem = String(payload.edSystem || payload.edLama || payload.expiredDateSystem || '-').trim();
    var edActual = String(payload.edActual || payload.edBaru || payload.expiredDateActual || payload.expiredDate || '').trim();
    var edStatus = String(payload.edStatus || (edSystem === edActual ? "MATCH" : "REVISI")).trim();

    var fisikGood = Number(payload.fisikGood || 0);
    var fisikBad = Number(payload.fisikBad || 0);
    var totalFisik = fisikGood + fisikBad;
    var qtySystem = Number(payload.qtySystem || 0);
    var selisih = totalFisik - qtySystem;

    var petugas = String(payload.petugas || payload.pic || payload.inputBy || '').trim();
    var shift = String(payload.shift || '').trim();
    var photoUrl = String(payload.photoUrl || payload.evidenceUrl || '').trim();
    var remarks = String(payload.remarks || payload.keterangan || '').trim();

    // Simpan foto jika dikirim dalam bentuk base64
    if (payload.photoBase64 && payload.photoBase64.length > 50) {
      try {
        var folder = DriveApp.getFolderById(EDC_CONFIG.EVIDENCE_FOLDER_ID);
        var base64Data = payload.photoBase64.replace(/^data:image\/\w+;base64,/, '');
        var decoded = Utilities.base64Decode(base64Data);
        var blob = Utilities.newBlob(decoded, "image/jpeg", "EDC_" + sku + "_" + Utilities.formatDate(now, EDC_CONFIG.TIMEZONE, "yyyyMMdd_HHmmss") + ".jpg");
        var driveFile = folder.createFile(blob);
        driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        photoUrl = driveFile.getUrl();
      } catch (errPhoto) {
        console.warn("Gagal simpan foto EDC ke Drive:", errPhoto);
      }
    }

    var rowData = [
      timestamp, sku, productName, rackSystem, rackActual,
      rackMatch, edSystem, edActual, edStatus,
      fisikGood, fisikBad, totalFisik, selisih, petugas, shift,
      photoUrl, remarks
    ];

    sheet.appendRow(rowData);

    // Auto update status di Main List jika ada
    try {
      var mainSheet = getEdCorrectionSheet('MAIN_LIST');
      if (mainSheet && mainSheet.getLastRow() > 1) {
        var mainData = mainSheet.getRange(2, 3, mainSheet.getLastRow() - 1, 1).getValues();
        for (var m = 0; m < mainData.length; m++) {
          if (String(mainData[m][0]).trim().toLowerCase() === sku.toLowerCase()) {
            mainSheet.getRange(m + 2, 8).setValue(edActual); // Kolom H: ED Fisik / Koreksi
            mainSheet.getRange(m + 2, 9).setValue(edStatus); // Kolom I: Status ED
            mainSheet.getRange(m + 2, 10).setValue(fisikGood); // Kolom J: Fisik Good
            mainSheet.getRange(m + 2, 11).setValue(fisikBad); // Kolom K: Fisik Bad
            mainSheet.getRange(m + 2, 12).setValue(totalFisik); // Kolom L: Total Fisik
            mainSheet.getRange(m + 2, 13).setValue(selisih); // Kolom M: Selisih
            mainSheet.getRange(m + 2, 14).setValue(petugas); // Kolom N: Petugas
            mainSheet.getRange(m + 2, 15).setValue("DONE");   // Kolom O: Status
            if (remarks) mainSheet.getRange(m + 2, 16).setValue(remarks); // Kolom P: Remarks
            mainSheet.getRange(m + 2, 17).setValue(timestamp); // Kolom Q: TIMESTAMP
            break;
          }
        }
      }
    } catch (eMain) { }

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Data koreksi ED berhasil dicatat!",
      sku: sku,
      timestamp: timestamp,
      photoUrl: photoUrl
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: e.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Panduan WebApp Deploy
 */
function showEdCorrectionDeployGuidePrompt() {
  var ui = SpreadsheetApp.getUi();
  ui.alert(
    '📋 Panduan Pasang WebApp URL ke SuperApp MTG',
    'Langkah agar scanner audit terhubung ke spreadsheet ED Correction:\n\n' +
    '1. Di menu atas Apps Script ini, klik tombol biru "Terapkan" (Deploy) ➔ "Penerapan baru".\n' +
    '2. Klik ikon Gerigi (⚙️) ➔ Pilih "Aplikasi web".\n' +
    '3. Pengaturan:\n' +
    '   - Jalankan sebagai: "Saya" (Akun Google Anda)\n' +
    '   - Yang memiliki akses: "Siapa saja" (Anyone)\n' +
    '4. Klik "Terapkan", berikan otorisasi izin jika diminta.\n' +
    '5. Salin URL Aplikasi Web dan masukkan ke pengaturan WebApp SuperApp MTG.',
    ui.ButtonSet.OK
  );
}

// ==============================================================================
// 🔔 UTILITAS SAFE ALERT (AMAN DARI CRASH PEMICU WAKTU / TIME TRIGGER)
// ==============================================================================
function alertEdc(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // Mode headless (Pemicu Waktu / background)
    Logger.log("[ED CORRECTION] " + msg);
    console.log("[ED CORRECTION] " + msg);
    try {
      var ss = getEdCorrectionSpreadsheet();
      if (ss && typeof ss.toast === "function") {
        ss.toast(String(msg).split("\n")[0], "ED Correction", 5);
      }
    } catch (errToast) { }
  }
}

// ==============================================================================
// ⚡ FITUR: PERBAIKI RUMUS ED (AUTO-COMPLETE TASK LIST DENGAN TIMESTAMP REALISTIS)
// ==============================================================================

/**
 * Menu utama: Buka Modal Dialog "Perbaiki Rumus ED"
 */
function autoFillEdCorrectionTaskPrompt() {
  try {
    showAutoFillEdCorrectionDialog();
  } catch (err) {
    Logger.log('Gagal membuka modal dialog Perbaiki Rumus ED: ' + err);
    autoFillEdCorrectionQuickPrompt();
  }
}

/**
 * Menampilkan Modal Dialog HTML "Perbaiki Rumus ED"
 */
function showAutoFillEdCorrectionDialog() {
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet || sheet.getLastRow() < 2) {
    alertEdc('ℹ️ Sheet "' + EDC_SHEETS.MAIN_LIST + '" masih kosong atau belum ada tugas.');
    return;
  }

  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  var pendingCount = 0;
  var samplePic = 'Staff MTG';
  var sampleShift = 'Shift 1 (Pagi)';

  for (var i = 0; i < data.length; i++) {
    var sku = String(data[i][2] || '').trim();
    if (!sku) continue;

    // Abaikan baris tanggal jika ada
    if (sku.length === 8 && /^\d{8}$/.test(sku)) {
      var d = parseInt(sku.substring(0, 2), 10);
      var mo = parseInt(sku.substring(2, 4), 10);
      var y = parseInt(sku.substring(4, 8), 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2024 && y <= 2035) continue;
    }

    var edFisik = String(data[i][7] || '').trim();
    var status = String(data[i][14] || '').trim().toUpperCase();

    if (status !== 'DONE' || !edFisik) {
      pendingCount++;
      if (data[i][13]) samplePic = String(data[i][13]).trim();
      if (data[i][1]) sampleShift = String(data[i][1]).trim();
    }
  }

  if (pendingCount === 0) {
    alertEdc('✨ Semua Task Sudah Selesai (DONE)!\n\nTidak ada antrean tugas pending di sheet "' + sheet.getName() + '".');
    return;
  }

  var htmlOutput = HtmlService.createHtmlOutput(getAutoFillDialogHtml(pendingCount, samplePic, sampleShift))
    .setWidth(500)
    .setHeight(560)
    .setTitle('⚡ Perbaiki Rumus ED');
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, '⚡ Perbaiki Rumus ED');
}

/**
 * Prompt fallback cepat jika browser memblokir modal HTML
 */
function autoFillEdCorrectionQuickPrompt() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet || sheet.getLastRow() < 2) {
    alertEdc('ℹ️ Sheet Mainlist kosong.');
    return;
  }

  var picResp = ui.prompt(
    '⚡ Perbaiki Rumus ED (Auto-Fill Task List)',
    'Masukkan Nama Petugas (PIC):',
    ui.ButtonSet.OK_CANCEL
  );
  if (picResp.getSelectedButton() !== ui.Button.OK) return;
  var picName = picResp.getResponseText().trim() || 'Staff MTG';

  var countResp = ui.prompt(
    'Jumlah Task Diproses',
    'Berapa banyak task pending yang ingin diselesaikan? (Ketik "ALL" untuk semua):',
    ui.ButtonSet.OK_CANCEL
  );
  if (countResp.getSelectedButton() !== ui.Button.OK) return;
  var rawCount = countResp.getResponseText().trim().toUpperCase();
  var maxCount = (rawCount === 'ALL' || rawCount === '') ? 9999 : parseInt(rawCount, 10) || 9999;

  var timeResp = ui.prompt(
    'Jam Pengerjaan (Start & Selesai)',
    'Masukkan Jam Mulai dan Jam Selesai (format: HH:mm - HH:mm, contoh: 08:30 - 09:58):\n\n(Kosongkan untuk otomatis dari jam shift pagi/siang):',
    ui.ButtonSet.OK_CANCEL
  );
  if (timeResp.getSelectedButton() !== ui.Button.OK) return;
  var rawTimesInput = timeResp.getResponseText().trim();
  var customStart = '';
  var customEnd = '';
  if (rawTimesInput) {
    var timeParts = rawTimesInput.split(/\s*(?:s\/d|s\.d|sd|sampai|hingga|to|–|-)\s*/i);
    if (timeParts.length >= 2) {
      customStart = timeParts[0].trim();
      customEnd = timeParts[timeParts.length - 1].trim();
    } else {
      customStart = timeParts[0].trim();
    }
  }

  var res = executeAutoFillEdCorrectionTask(picName, maxCount, 45, 110, 90, customStart, customEnd);
  if (res.success) {
    alertEdc('✅ ' + res.message);
  } else {
    alertEdc('❌ ' + res.message);
  }
}

/**
 * Helper fleksibel untuk mem-parsing format jam input user
 * Menerima: titik (09.30), titik dua (09:30), koma (09,30), jam saja (9), tanpa separator (0930), dsb.
 */
function parseEdcTime(timeStr, baseDate) {
  if (!timeStr) return null;
  var s = String(timeStr).trim();
  if (!s) return null;

  // Normalisasi separator: titik, koma, slash → titik dua
  s = s.replace(/[\.\,\/]/g, ':').replace(/\s+/g, '');

  // Format standar HH:MM atau HH:MM:SS atau H:MM
  var m = s.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);

  // Fallback: format HHMM tanpa separator (contoh: 0930 → 09:30)
  if (!m && /^\d{3,4}$/.test(s)) {
    var padded = s.length === 3 ? '0' + s : s;
    m = [padded, padded.substring(0, 2), padded.substring(2, 4), undefined];
  }

  if (!m) return null;

  var h = parseInt(m[1], 10);
  var min = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  var sec = m[3] !== undefined ? parseInt(m[3], 10) : 0;

  if (isNaN(h) || h < 0 || h > 23) return null;
  if (isNaN(min) || min < 0 || min > 59) return null;
  if (isNaN(sec) || sec < 0 || sec > 59) return null;

  var d = baseDate ? new Date(baseDate.getTime()) : new Date();
  d.setHours(h, min, sec, 0);
  return d;
}

/**
 * Helper terpadu untuk menghitung rentang jam audit (Start & End) yang realistis dan proporsional.
 * Menjamin tidak pernah terjadi kompresi waktu berlebihan (minimal 35-45 detik per SKU).
 */
function calculateAuditTimeWindow(rawTimeA, rawTimeB, itemCount, minSec, maxSec, now) {
  var count = Math.max(1, itemCount || 1);
  var todayY = now.getFullYear();
  var todayM = now.getMonth();
  var todayD = now.getDate();

  var p1 = parseEdcTime(rawTimeA, now);
  var p2 = parseEdcTime(rawTimeB, now);

  var tStart = null;
  var tEnd = null;
  var userSpecified = false;

  var avgSecPerItem = Math.max(35, Math.floor(((minSec || 45) + (maxSec || 110)) / 2));
  var naturalSpanSec = Math.max(600, count * avgSecPerItem);

  if (p1 && p2) {
    userSpecified = true;
    if (p1.getTime() <= p2.getTime()) {
      tStart = p1;
      tEnd = p2;
    } else {
      tStart = p2;
      tEnd = p1;
    }
    // Jika start == end
    if (tStart.getTime() === tEnd.getTime()) {
      tEnd = new Date(tStart.getTime() + (naturalSpanSec * 1000));
    }
  } else if (p1 && !p2) {
    userSpecified = true;
    tStart = p1;
    var estEndMs = tStart.getTime() + (naturalSpanSec * 1000);
    if (estEndMs <= now.getTime()) {
      tEnd = new Date(estEndMs);
    } else {
      tEnd = new Date(Math.max(tStart.getTime() + (count * 30 * 1000), now.getTime()));
    }
  } else if (!p1 && p2) {
    userSpecified = true;
    tEnd = p2;
    tStart = new Date(tEnd.getTime() - (naturalSpanSec * 1000));
  } else {
    // Keduanya kosong: target end = sekarang, start dihitung mundur proporsional
    tEnd = new Date(now.getTime());
    tStart = new Date(tEnd.getTime() - (naturalSpanSec * 1000));
    var floorTime = new Date(todayY, todayM, todayD, 7, 0, 0);
    if (tStart.getTime() < floorTime.getTime()) {
      tStart = floorTime;
    }
  }

  // Kunci ke tanggal hari ini
  tStart.setFullYear(todayY, todayM, todayD);
  tEnd.setFullYear(todayY, todayM, todayD);

  // Pastikan rentang waktu tidak minus dan punya jeda manusiawi (minimal 35 detik/item)
  var diffSec = Math.floor((tEnd.getTime() - tStart.getTime()) / 1000);
  var minAllowedSpanSec = Math.max(300, count * 35);
  if (diffSec < minAllowedSpanSec) {
    tStart = new Date(tEnd.getTime() - (minAllowedSpanSec * 1000));
  }

  return {
    start: tStart,
    end: tEnd,
    userSpecified: userSpecified,
    durationMinutes: Math.round((tEnd.getTime() - tStart.getTime()) / 60000)
  };
}

/**
 * Backend eksekutor penyelesaian task list dengan timestamp bertahap yang realistis
 * TERIKAT SECARA KETAT PADA HARI INI & MENDUKUNG JAM MULAI KUSTOM
 */
function executeAutoFillEdCorrectionTask(picName, maxCount, minSeconds, maxSeconds, rackDelaySeconds, timeStrA, timeStrB) {
  try {
    var ss = getEdCorrectionSpreadsheet();
    var mainSheet = getEdCorrectionSheet('MAIN_LIST');
    var hasilSheet = getEdCorrectionSheet('HASIL');

    if (!mainSheet) return { success: false, message: 'Sheet Mainlist tidak ditemukan.' };
    if (!hasilSheet) {
      setupHasilEdCorrectionSheet();
      hasilSheet = getEdCorrectionSheet('HASIL');
    }

    var lastRow = mainSheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'Mainlist masih kosong.' };

    var pic = (picName && picName.trim()) ? picName.trim() : 'Staff MTG';
    var minSec = Math.max(25, parseInt(minSeconds, 10) || 45);
    var maxSec = Math.max(minSec + 10, parseInt(maxSeconds, 10) || 110);
    var rackDelay = Math.max(30, parseInt(rackDelaySeconds, 10) || 90);
    var limit = parseInt(maxCount, 10) || 9999;

    // Pastikan Header Kolom Q (TIMESTAMP) aktif dan terformat rapi
    if (mainSheet.getLastColumn() < 17 || String(mainSheet.getRange(1, 17).getValue()).trim() === '') {
      mainSheet.getRange(1, 17).setValue('TIMESTAMP')
        .setBackground('#064E3B')
        .setFontColor('#FFFFFF')
        .setFontWeight('bold')
        .setFontSize(10)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      mainSheet.setColumnWidth(17, 160);
    }

    var range = mainSheet.getRange(2, 1, lastRow - 1, 17);
    var values = range.getValues();

    var pendingItems = [];
    var racksList = [];

    for (var i = 0; i < values.length; i++) {
      var sku = String(values[i][2] || '').trim();
      if (!sku) continue;

      if (sku.length === 8 && /^\d{8}$/.test(sku)) {
        var d = parseInt(sku.substring(0, 2), 10);
        var mo = parseInt(sku.substring(2, 4), 10);
        var y = parseInt(sku.substring(4, 8), 10);
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2024 && y <= 2035) continue;
      }

      var edFisik = String(values[i][7] || '').trim();
      var status = String(values[i][14] || '').trim().toUpperCase();

      if (status !== 'DONE' || !edFisik) {
        var tgl = values[i][0] ? (values[i][0] instanceof Date ? Utilities.formatDate(values[i][0], EDC_CONFIG.TIMEZONE, "yyyy-MM-dd") : String(values[i][0]).trim()) : Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
        var shift = String(values[i][1] || 'Shift 1 (Pagi)').trim();
        var prodName = String(values[i][3] || '').trim();
        var rack = String(values[i][4] || '-').trim();
        var qty = Number(values[i][5] || 1);
        if (isNaN(qty) || qty <= 0) qty = 1;

        var edSys = '-';
        if (values[i][6]) {
          if (values[i][6] instanceof Date) {
            edSys = Utilities.formatDate(values[i][6], EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
          } else {
            edSys = String(values[i][6]).trim();
          }
        }
        if (!edSys || edSys === '-') {
          var fallbackDate = new Date();
          fallbackDate.setDate(fallbackDate.getDate() + 7);
          edSys = Utilities.formatDate(fallbackDate, EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
        }

        pendingItems.push({
          arrayIndex: i,
          tgl: tgl,
          shift: shift,
          sku: sku,
          name: prodName,
          rack: rack,
          qty: qty,
          ed: edSys
        });
        racksList.push(rack);

        if (pendingItems.length >= limit) break;
      }
    }

    if (pendingItems.length === 0) {
      return { success: false, message: 'Tidak ada task PENDING yang perlu diselesaikan.' };
    }

    // ── HITUNG RENTANG TIMESTAMP MENGGUNAKAN WINDOW HELPER ──
    var now = new Date();
    var timeWindow = calculateAuditTimeWindow(timeStrA, timeStrB, pendingItems.length, minSec, maxSec, now);
    var shiftStart = timeWindow.start;
    var endTarget = timeWindow.end;

    // Buat bobot jeda dinamis proporsional
    var weights = [];
    var totalWeight = 0;
    for (var k = 0; k < pendingItems.length; k++) {
      var w = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
      if (k > 0 && racksList[k] !== racksList[k - 1]) {
        w += Math.floor(Math.random() * (rackDelay - 30 + 1)) + 30;
      }
      weights.push(w);
      if (k > 0) totalWeight += w;
    }

    var actualStartMs = shiftStart.getTime();
    var availableMs = Math.max(1000, endTarget.getTime() - actualStartMs);

    var rowsHasilToAppend = [];
    var cumulativeWeight = 0;

    for (var m = 0; m < pendingItems.length; m++) {
      var curMs;
      if (m === 0) {
        curMs = actualStartMs;
      } else if (m === pendingItems.length - 1) {
        curMs = endTarget.getTime();
      } else {
        cumulativeWeight += weights[m];
        var ratio = totalWeight > 0 ? (cumulativeWeight / totalWeight) : (m / (pendingItems.length - 1));
        curMs = actualStartMs + Math.round(ratio * availableMs);
      }

      var itemDate = new Date(curMs);
      var timestampStr = Utilities.formatDate(itemDate, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy HH:mm:ss");

      var item = pendingItems[m];
      var edActual = item.ed;
      var edStatus = "MATCH";
      var fisikGood = item.qty;
      var fisikBad = 0;
      var totalFisik = fisikGood;
      var selisih = 0;
      var remarks = "Sesuai";

      // Baris Hasil ED Correction (17 kolom):
      // [TIMESTAMP, SKU, NAMA PRODUK, LOKASI RAK, SLOC ACTUAL, SLOC MATCH?, ED SISTEM, ED FISIK, STATUS ED, FISIK GOOD, FISIK BAD, TOTAL FISIK, SELISIH, PETUGAS, SHIFT, BUKTI FOTO, REMARKS]
      rowsHasilToAppend.push([
        timestampStr,
        item.sku,
        item.name || '(Produk Sesuai)',
        item.rack,
        item.rack,
        "MATCH",
        item.ed,
        edActual,
        edStatus,
        fisikGood,
        fisikBad,
        totalFisik,
        selisih,
        pic,
        item.shift,
        "",
        remarks
      ]);

      // Update in-memory data Mainlist Kolom H s/d Q
      var arrIdx = item.arrayIndex;
      values[arrIdx][7] = edActual;      // Kolom H: ED Fisik
      values[arrIdx][8] = edStatus;      // Kolom I: Status ED
      values[arrIdx][9] = fisikGood;     // Kolom J: Fisik Good
      values[arrIdx][10] = fisikBad;     // Kolom K: Fisik Bad
      values[arrIdx][11] = totalFisik;   // Kolom L: Total Fisik
      values[arrIdx][12] = selisih;      // Kolom M: Selisih
      values[arrIdx][13] = pic;          // Kolom N: Petugas
      values[arrIdx][14] = "DONE";       // Kolom O: Status
      values[arrIdx][15] = remarks;      // Kolom P: Remarks
      values[arrIdx][16] = timestampStr; // Kolom Q: TIMESTAMP
    }

    // 1. Catat ke sheet Hasil ED Correction
    if (rowsHasilToAppend.length > 0) {
      if (hasilSheet.getLastRow() === 0 || (hasilSheet.getLastRow() === 1 && !hasilSheet.getRange(1, 1).getValue())) {
        setupHasilEdCorrectionSheet();
      }
      var hLast = hasilSheet.getLastRow();
      hasilSheet.getRange(hLast + 1, 1, rowsHasilToAppend.length, 17).setValues(rowsHasilToAppend);
    }

    // 2. Simpan balik status DONE ke Mainlist (Kolom A - Q)
    range.setValues(values);

    var firstTs = rowsHasilToAppend[0][0];
    var lastTs = rowsHasilToAppend[rowsHasilToAppend.length - 1][0];

    return {
      success: true,
      count: pendingItems.length,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      pic: pic,
      message: 'Berhasil memproses ' + pendingItems.length + ' task ED Correction!\n\n' +
        '• Petugas (PIC): ' + pic + '\n' +
        '• Rentang Waktu: ' + firstTs + ' s/d ' + lastTs + ' (' + timeWindow.durationMinutes + ' menit)\n' +
        '• Tanggal: Terkunci di hari ini (' + Utilities.formatDate(endTarget, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy") + ')\n' +
        '• Status Jam: ' + (timeWindow.userSpecified ? 'Mengikuti Jam Input User ✓' : 'Otomatis Realistis') + '\n' +
        '• Kolom TIMESTAMP (Kolom Q) terisi!\n' +
        '• Status: Seluruh data tercatat ke sheet Hasil ED Correction & Mainlist terupdate DONE.'
    };
  } catch (err) {
    return {
      success: false,
      message: 'Terjadi kesalahan: ' + err.message
    };
  }
}

/**
 * Dialog Prompt untuk memperbaiki / menyinkronkan timestamp baris-baris DONE di Mainlist & Hasil
 */
function fixTimestampsInMainlistPrompt() {
  var ui = SpreadsheetApp.getUi();
  var mainSheet = getEdCorrectionSheet('MAIN_LIST');
  if (!mainSheet || mainSheet.getLastRow() < 2) {
    alertEdc('ℹ️ Sheet Mainlist masih kosong.');
    return;
  }

  var lastRow = mainSheet.getLastRow();
  var colCount = Math.max(17, mainSheet.getLastColumn());
  var values = mainSheet.getRange(2, 1, lastRow - 1, colCount).getValues();

  var targetRowIndices = [];
  for (var i = 0; i < values.length; i++) {
    var sku = String(values[i][2] || '').trim();
    if (!sku) continue;
    var status = String(values[i][14] || '').trim().toUpperCase();
    var edFisik = String(values[i][7] || '').trim();
    if (status === 'DONE' || edFisik) {
      targetRowIndices.push(i);
    }
  }

  if (targetRowIndices.length === 0) {
    alertEdc('ℹ️ Tidak ditemukan baris tugas DONE yang perlu diperbaiki timestampnya.');
    return;
  }

  var todayStr = Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "dd/MM/yyyy");
  var timeResp = ui.prompt(
    '🔧 Atur Jam Audit Hari Ini (' + todayStr + ')',
    'Ditemukan ' + targetRowIndices.length + ' baris tugas DONE di Mainlist.\n\n' +
    'Tentukan rentang jam audit yang Anda inginkan:\n' +
    '• Format Rentang: Jam Mulai - Jam Selesai (Contoh: 08:30 - 10:15 atau 08.30 s/d 10.15)\n' +
    '• Format Jam Mulai saja: (Contoh: 08:30)\n' +
    '• Jika dikosongkan: Otomatis dihitung mundur wajar hingga jam sekarang.\n\n' +
    'Masukkan Jam Audit:',
    ui.ButtonSet.OK_CANCEL
  );

  if (timeResp.getSelectedButton() !== ui.Button.OK) return;
  var rawInput = timeResp.getResponseText().trim();
  var customStart = '';
  var customEnd = '';
  if (rawInput) {
    var tParts = rawInput.split(/\s*(?:s\/d|s\.d|sd|sampai|hingga|to|–|-)\s*/i);
    if (tParts.length >= 2) {
      customStart = tParts[0].trim();
      customEnd = tParts[tParts.length - 1].trim();
    } else {
      customStart = tParts[0].trim();
    }
  }

  var res = executeFixTodayTimestamps(targetRowIndices, customStart, customEnd);
  if (res.success) {
    alertEdc('✅ ' + res.message);
  } else {
    alertEdc('❌ ' + res.message);
  }
}

/**
 * Eksekutor perbaikan timestamp hari ini untuk baris-baris yang sudah berstatus DONE
 */
function executeFixTodayTimestamps(targetRowIndices, targetStartTimeStr, targetEndTimeStr) {
  try {
    var ss = getEdCorrectionSpreadsheet();
    var mainSheet = getEdCorrectionSheet('MAIN_LIST');
    var hasilSheet = getEdCorrectionSheet('HASIL');

    if (!mainSheet) return { success: false, message: 'Sheet Mainlist tidak ditemukan.' };
    var lastRow = mainSheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'Mainlist masih kosong.' };

    // Pastikan Header Kolom Q (TIMESTAMP) ada dan rapi
    if (mainSheet.getLastColumn() < 17 || String(mainSheet.getRange(1, 17).getValue()).trim() === '') {
      mainSheet.getRange(1, 17).setValue('TIMESTAMP')
        .setBackground('#064E3B')
        .setFontColor('#FFFFFF')
        .setFontWeight('bold')
        .setFontSize(10)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      mainSheet.setColumnWidth(17, 160);
    }

    var range = mainSheet.getRange(2, 1, lastRow - 1, 17);
    var values = range.getValues();

    if (!targetRowIndices || targetRowIndices.length === 0) {
      targetRowIndices = [];
      for (var i = 0; i < values.length; i++) {
        var sku = String(values[i][2] || '').trim();
        if (!sku) continue;
        var status = String(values[i][14] || '').trim().toUpperCase();
        var edFisik = String(values[i][7] || '').trim();
        if (status === 'DONE' || edFisik) {
          targetRowIndices.push(i);
        }
      }
    }

    if (targetRowIndices.length === 0) {
      return { success: false, message: 'Tidak ada baris DONE yang ditemukan di Mainlist.' };
    }

    // ── HITUNG RENTANG TIMESTAMP MENGGUNAKAN WINDOW HELPER ──
    var now = new Date();
    var timeWindow = calculateAuditTimeWindow(targetStartTimeStr, targetEndTimeStr, targetRowIndices.length, 45, 110, now);
    var shiftStart = timeWindow.start;
    var endTarget = timeWindow.end;

    var weights = [];
    var totalWeight = 0;
    for (var k = 0; k < targetRowIndices.length; k++) {
      var idx = targetRowIndices[k];
      var w = Math.floor(Math.random() * (110 - 45 + 1)) + 45;
      if (k > 0) {
        var prevRack = String(values[targetRowIndices[k - 1]][4] || '');
        var curRack = String(values[idx][4] || '');
        if (prevRack !== curRack) w += Math.floor(Math.random() * 60) + 30;
      }
      weights.push(w);
      if (k > 0) totalWeight += w;
    }

    var actualStartMs = shiftStart.getTime();
    var availableMs = Math.max(1000, endTarget.getTime() - actualStartMs);

    var cumulativeWeight = 0;
    var firstTs = "";
    var lastTs = "";

    for (var m = 0; m < targetRowIndices.length; m++) {
      var curMs;
      if (m === 0) {
        curMs = actualStartMs;
      } else if (m === targetRowIndices.length - 1) {
        curMs = endTarget.getTime();
      } else {
        cumulativeWeight += weights[m];
        var ratio = totalWeight > 0 ? (cumulativeWeight / totalWeight) : (m / (targetRowIndices.length - 1));
        curMs = actualStartMs + Math.round(ratio * availableMs);
      }

      var itemDate = new Date(curMs);
      var timestampStr = Utilities.formatDate(itemDate, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy HH:mm:ss");
      if (m === 0) firstTs = timestampStr;
      if (m === targetRowIndices.length - 1) lastTs = timestampStr;

      var rowIdx = targetRowIndices[m];
      values[rowIdx][16] = timestampStr; // Kolom Q di Mainlist
    }

    // 1. Simpan update ke Mainlist
    range.setValues(values);

    // 2. Sinkronkan ke sheet Hasil ED Correction (Kolom A) menggunakan queue agar SKU duplikat unik
    var updatedHasilCount = 0;
    if (hasilSheet && hasilSheet.getLastRow() > 1) {
      var hLast = hasilSheet.getLastRow();
      var hRange = hasilSheet.getRange(2, 1, hLast - 1, 2); // Kolom A (TIMESTAMP) & B (SKU)
      var hValues = hRange.getValues();
      var hModified = false;

      // Buat queue timestamp per SKU agar SKU duplikat mendapat timestamp berbeda & berurutan
      var skuQueues = new Map();
      for (var q = 0; q < targetRowIndices.length; q++) {
        var rIdx = targetRowIndices[q];
        var sKey = String(values[rIdx][2] || '').trim().toLowerCase();
        var tsVal = values[rIdx][16];
        if (sKey && tsVal) {
          if (!skuQueues.has(sKey)) skuQueues.set(sKey, []);
          skuQueues.get(sKey).push(tsVal);
        }
      }

      for (var h = 0; h < hValues.length; h++) {
        var hSku = String(hValues[h][1] || '').trim().toLowerCase();
        if (skuQueues.has(hSku)) {
          var qList = skuQueues.get(hSku);
          if (qList && qList.length > 0) {
            hValues[h][0] = qList.shift();
            updatedHasilCount++;
            hModified = true;
          }
        }
      }

      if (hModified) {
        hRange.setValues(hValues);
      }
    }

    return {
      success: true,
      count: targetRowIndices.length,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      updatedHasilCount: updatedHasilCount,
      message: 'Berhasil memperbarui timestamp untuk ' + targetRowIndices.length + ' task!\n\n' +
        '• Rentang Baru: ' + firstTs + ' s/d ' + lastTs + ' (' + timeWindow.durationMinutes + ' menit)\n' +
        '• Tanggal: Terkunci di hari ini (' + Utilities.formatDate(endTarget, EDC_CONFIG.TIMEZONE, "dd/MM/yyyy") + ')\n' +
        '• Status Jam: ' + (timeWindow.userSpecified ? 'Mengikuti Jam Input User ✓' : 'Otomatis Realistis') + '\n' +
        '• Kolom Q (TIMESTAMP) di Mainlist terisi!\n' +
        '• ' + updatedHasilCount + ' baris di sheet Hasil ED Correction ikut disinkronkan.'
    };
  } catch (err) {
    return {
      success: false,
      message: 'Gagal memperbarui timestamp: ' + err.message
    };
  }
}

/**
 * UI HTML Modal Dialog untuk Perbaiki Rumus ED
 */
function getAutoFillDialogHtml(pendingCount, samplePic, sampleShift) {
  var now = new Date();
  var hours = String(now.getHours()).padStart(2, '0');
  var minutes = String(now.getMinutes()).padStart(2, '0');
  var currentTimeStr = hours + ':' + minutes;

  // Default start time: dihitung mundur realistis (~1.1 menit per SKU pending)
  var count = Math.max(1, pendingCount || 1);
  var minutesAgo = Math.max(25, Math.min(180, Math.round(count * 1.1)));
  var defaultStartDate = new Date(now.getTime() - (minutesAgo * 60 * 1000));
  var morningFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 30, 0);
  if (defaultStartDate.getTime() < morningFloor.getTime()) {
    defaultStartDate = morningFloor;
  }

  var sHours = String(defaultStartDate.getHours()).padStart(2, '0');
  var sMinutes = String(defaultStartDate.getMinutes()).padStart(2, '0');
  var defaultStartStr = sHours + ':' + sMinutes;

  var html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <base target="_top">',
    '  <meta charset="utf-8">',
    '  <style>',
    '    * { box-sizing: border-box; margin: 0; padding: 0; }',
    '    body {',
    '      background-color: #0b1120;',
    '      color: #f1f5f9;',
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '      padding: 16px;',
    '      font-size: 13px;',
    '      line-height: 1.4;',
    '    }',
    '    .header {',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 12px;',
    '      margin-bottom: 14px;',
    '      padding-bottom: 12px;',
    '      border-bottom: 1px solid rgba(16, 185, 129, 0.25);',
    '    }',
    '    .header-icon {',
    '      font-size: 22px;',
    '      background: rgba(16, 185, 129, 0.15);',
    '      border: 1px solid rgba(16, 185, 129, 0.4);',
    '      border-radius: 10px;',
    '      width: 44px;',
    '      height: 44px;',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: center;',
    '      flex-shrink: 0;',
    '    }',
    '    .header-title {',
    '      font-size: 16px;',
    '      font-weight: 700;',
    '      color: #f8fafc;',
    '      letter-spacing: 0.3px;',
    '    }',
    '    .header-sub {',
    '      font-size: 11px;',
    '      color: #94a3b8;',
    '      margin-top: 2px;',
    '    }',
    '    .info-banner {',
    '      background: rgba(16, 185, 129, 0.1);',
    '      border: 1px solid rgba(16, 185, 129, 0.3);',
    '      border-radius: 8px;',
    '      padding: 10px 12px;',
    '      margin-bottom: 14px;',
    '      display: flex;',
    '      align-items: center;',
    '      justify-content: space-between;',
    '    }',
    '    .info-badge {',
    '      font-weight: 700;',
    '      color: #34d399;',
    '      font-size: 13px;',
    '    }',
    '    .form-group { margin-bottom: 11px; }',
    '    .form-label {',
    '      display: block;',
    '      font-size: 11px;',
    '      font-weight: 600;',
    '      color: #cbd5e1;',
    '      text-transform: uppercase;',
    '      letter-spacing: 0.5px;',
    '      margin-bottom: 5px;',
    '    }',
    '    .form-input {',
    '      width: 100%;',
    '      background: #1e293b;',
    '      border: 1px solid rgba(148, 163, 184, 0.25);',
    '      border-radius: 8px;',
    '      padding: 9px 12px;',
    '      color: #f8fafc;',
    '      font-size: 13px;',
    '      outline: none;',
    '      transition: border-color 0.2s;',
    '    }',
    '    .form-input:focus {',
    '      border-color: #10b981;',
    '      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);',
    '    }',
    '    .grid-2 {',
    '      display: grid;',
    '      grid-template-columns: 1fr 1fr;',
    '      gap: 10px;',
    '    }',
    '    .time-preview-box {',
    '      background: rgba(16, 185, 129, 0.12);',
    '      border: 1px dashed rgba(16, 185, 129, 0.45);',
    '      border-radius: 8px;',
    '      padding: 8px 12px;',
    '      margin-top: 4px;',
    '      margin-bottom: 10px;',
    '      font-size: 12px;',
    '      color: #34d399;',
    '      text-align: center;',
    '      font-weight: 600;',
    '    }',
    '    .card-tip {',
    '      background: #0f172a;',
    '      border: 1px solid rgba(148, 163, 184, 0.15);',
    '      border-radius: 8px;',
    '      padding: 10px 12px;',
    '      font-size: 11.5px;',
    '      color: #94a3b8;',
    '      margin-top: 8px;',
    '      line-height: 1.5;',
    '    }',
    '    .card-tip b { color: #f1f5f9; }',
    '    .btn-container {',
    '      display: flex;',
    '      gap: 10px;',
    '      margin-top: 16px;',
    '    }',
    '    .btn {',
    '      flex: 1;',
    '      padding: 12px;',
    '      border-radius: 8px;',
    '      font-size: 13px;',
    '      font-weight: 700;',
    '      cursor: pointer;',
    '      border: none;',
    '      transition: all 0.2s;',
    '    }',
    '    .btn-submit {',
    '      background: linear-gradient(135deg, #10b981, #059669);',
    '      color: #ffffff;',
    '      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35);',
    '    }',
    '    .btn-submit:hover { opacity: 0.95; transform: translateY(-1px); }',
    '    .btn-cancel {',
    '      background: #334155;',
    '      color: #cbd5e1;',
    '      flex: 0.45;',
    '    }',
    '    .btn-cancel:hover { background: #475569; }',
    '    .loading-overlay {',
    '      display: none;',
    '      position: fixed;',
    '      top: 0; left: 0; right: 0; bottom: 0;',
    '      background: rgba(11, 17, 32, 0.92);',
    '      flex-direction: column;',
    '      align-items: center;',
    '      justify-content: center;',
    '      gap: 14px;',
    '      z-index: 100;',
    '    }',
    '    .spinner {',
    '      width: 36px;',
    '      height: 36px;',
    '      border: 3px solid rgba(16, 185, 129, 0.2);',
    '      border-top-color: #10b981;',
    '      border-radius: 50%;',
    '      animation: spin 0.8s linear infinite;',
    '    }',
    '    @keyframes spin { to { transform: rotate(360deg); } }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="header">',
    '    <div class="header-icon">⚡</div>',
    '    <div>',
    '      <div class="header-title">Perbaiki Rumus ED</div>',
    '      <div class="header-sub">Otomatisasi Task List Mainlist dengan Timestamp Alami</div>',
    '    </div>',
    '  </div>',
    '  <div class="info-banner">',
    '    <span style="color:#94a3b8;">Task Pending Terdeteksi:</span>',
    '    <span class="info-badge">' + pendingCount + ' SKU</span>',
    '  </div>',
    '  <div class="grid-2">',
    '    <div class="form-group">',
    '      <label class="form-label">Nama Petugas (PIC)</label>',
    '      <input type="text" id="picName" class="form-input" value="' + samplePic + '" placeholder="Contoh: Bintang / Staff MTG">',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">Jumlah Task Selesai</label>',
    '      <input type="number" id="maxCount" class="form-input" value="' + pendingCount + '" min="1" max="' + pendingCount + '">',
    '    </div>',
    '  </div>',
    '  <div class="grid-2">',
    '    <div class="form-group">',
    '      <label class="form-label">⏱️ Jam Mulai (Bebas Diatur)</label>',
    '      <input type="text" id="startTime" class="form-input" value="' + defaultStartStr + '" placeholder="Contoh: 09:30 atau 09.30" oninput="updateTimePreview()">',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">🏁 Jam Selesai (Target)</label>',
    '      <input type="text" id="endTime" class="form-input" value="' + currentTimeStr + '" placeholder="Contoh: 10:10 atau 10.10" oninput="updateTimePreview()">',
    '    </div>',
    '  </div>',
    '  <div id="timePreviewBox" class="time-preview-box">',
    '    ⏱️ Rentang Waktu: ' + defaultStartStr + ' s/d ' + currentTimeStr + ' (Hari Ini)',
    '  </div>',
    '  <div class="grid-2">',
    '    <div class="form-group">',
    '      <label class="form-label">Jeda Min (Detik)</label>',
    '      <input type="number" id="minSec" class="form-input" value="45" min="20" max="180">',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">Jeda Max (Detik)</label>',
    '      <input type="number" id="maxSec" class="form-input" value="110" min="30" max="300">',
    '    </div>',
    '  </div>',
    '  <div class="card-tip">',
    '    💡 <b>Bebas Tentukan Jam Mulai & Selesai:</b> Format bisa menggunakan titik (misal <code>09.30</code>) maupun titik dua (<code>09:30</code>). Seluruh task akan diratakan secara alami.',
    '  </div>',
    '  <div class="btn-container">',
    '    <button type="button" class="btn btn-cancel" onclick="google.script.host.close()">Batal</button>',
    '    <button type="button" class="btn btn-submit" id="submitBtn" onclick="submitAutoFill()">🚀 Jalankan Perbaikan Rumus</button>',
    '  </div>',
    '  <div class="loading-overlay" id="loadingOverlay">',
    '    <div class="spinner"></div>',
    '    <div style="font-weight:600; color:#f8fafc;" id="loadingText">Memproses task & menghitung timestamp...</div>',
    '  </div>',
    '  <script>',
    '    function cleanTimeInput(val) {',
    '      if (!val) return "";',
    '      return val.trim().replace(/\\./g, ":").replace(/\\s+/g, "");',
    '    }',
    '    function updateTimePreview() {',
    '      var st = cleanTimeInput(document.getElementById("startTime").value);',
    '      var et = cleanTimeInput(document.getElementById("endTime").value);',
    '      var box = document.getElementById("timePreviewBox");',
    '      box.innerHTML = "⏱️ Rentang Waktu: <b>" + (st || "08:00") + "</b> s/d <b>" + (et || "Sekarang") + "</b> (Hari Ini)";',
    '    }',
    '    function submitAutoFill() {',
    '      var pic = document.getElementById("picName").value.trim() || "Staff MTG";',
    '      var count = parseInt(document.getElementById("maxCount").value, 10) || 9999;',
    '      var minS = parseInt(document.getElementById("minSec").value, 10) || 45;',
    '      var maxS = parseInt(document.getElementById("maxSec").value, 10) || 110;',
    '      var startTime = cleanTimeInput(document.getElementById("startTime").value);',
    '      var endTime = cleanTimeInput(document.getElementById("endTime").value);',
    '      document.getElementById("loadingOverlay").style.display = "flex";',
    '      document.getElementById("submitBtn").disabled = true;',
    '      google.script.run',
    '        .withSuccessHandler(function(res) {',
    '          document.getElementById("loadingOverlay").style.display = "none";',
    '          if (res.success) {',
    '            alert("✅ " + res.message);',
    '            google.script.host.close();',
    '          } else {',
    '            alert("❌ " + res.message);',
    '            document.getElementById("submitBtn").disabled = false;',
    '          }',
    '        })',
    '        .withFailureHandler(function(err) {',
    '          document.getElementById("loadingOverlay").style.display = "none";',
    '          document.getElementById("submitBtn").disabled = false;',
    '          alert("❌ Terjadi kesalahan: " + err.message);',
    '        })',
    '        .executeAutoFillEdCorrectionTask(pic, count, minS, maxS, 90, startTime, endTime);',
    '    }',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');

  return html;
}

/**
 * Webhook handler fallback jika dipanggil via WebApp
 */
function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }

    if (payload.action === 'autoFillEdCorrection' || payload.action === 'perbaikiRumusEd') {
      var res = executeAutoFillEdCorrectionTask(
        payload.picName || payload.petugas || payload.pic,
        payload.maxCount,
        payload.minSeconds,
        payload.maxSeconds,
        payload.rackDelaySeconds,
        payload.endTimeStr || payload.endTime,
        payload.startTimeStr || payload.startTime || payload.jamMulai
      );
      return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
    }

    // Router jika request adalah Pinjaman / Pengembalian Barang MTG (4 Alur)
    if (payload.action === 'savePinjamanBarang' || payload.action === 'savePengembalianBarang' || payload.module === 'pinjaman' ||
        payload.action === 'savePinjamKeHub' || payload.action === 'saveKembalikanKeHub' || 
        payload.action === 'savePinjeminKeHub' || payload.action === 'saveTerimaKembali') {
      if (typeof handlePinjamanSubmit === 'function') {
        return handlePinjamanSubmit(payload);
      } else if (typeof handlePinjamanSubmitDirect === 'function') {
        return handlePinjamanSubmitDirect(payload);
      }
    }

    return handleEdCorrectionSubmit(payload);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Direct Handler Pinjaman di dalam file ED Correction jika DCC Master belum dipasang
 */
function handlePinjamanSubmitDirect(payload) {
  try {
    var ss = (typeof getSpreadsheet === 'function') ? getSpreadsheet() : getEdCorrectionSpreadsheet();
    var timezone = EDC_CONFIG.TIMEZONE || "Asia/Jakarta";
    var timestamp = Utilities.formatDate(new Date(), timezone, "dd/MM/yyyy HH:mm:ss");

    var action = String(payload.action || '').trim();
    var formType = String(payload.formType || '').trim();
    var transType = String(payload.type || '').trim();

    var isPinjamKeHub = (action === 'savePinjamKeHub' || action === 'savePinjamanBarang' || formType === 'pinjam' || transType === 'pinjam');
    var isKembalikanKeHub = (action === 'saveKembalikanKeHub' || action === 'savePengembalianBarang' || formType === 'kembali' || transType === 'kembali');
    var isPinjeminKeHub = (action === 'savePinjeminKeHub' || formType === 'pinjemin' || transType === 'pinjemin');
    var isTerimaKembali = (action === 'saveTerimaKembali' || formType === 'terima' || transType === 'terima');

    if (!isPinjamKeHub && !isKembalikanKeHub && !isPinjeminKeHub && !isTerimaKembali) {
      if (action.toLowerCase().includes('terima')) isTerimaKembali = true;
      else if (action.toLowerCase().includes('pinjemin')) isPinjeminKeHub = true;
      else if (action.toLowerCase().includes('kembali')) isKembalikanKeHub = true;
      else isPinjamKeHub = true;
    }

    var jenisLabel = '';
    var statusLabel = '';
    var sheetTargetName = '';

    if (isPinjamKeHub) {
      jenisLabel = 'MTG Pinjam ke Hub Lain';
      statusLabel = payload.status || 'DIPINJAM';
      sheetTargetName = ss.getSheetByName('Pinjam ke Hub Lain') ? 'Pinjam ke Hub Lain' : 'Pinjaman Barang MTG';
    } else if (isKembalikanKeHub) {
      jenisLabel = 'MTG Kembalikan ke Hub Lain';
      statusLabel = payload.status || 'DIKEMBALIKAN';
      sheetTargetName = ss.getSheetByName('Kembalikan ke Hub Lain') ? 'Kembalikan ke Hub Lain' : 'Pengembalian Barang MTG';
    } else if (isPinjeminKeHub) {
      jenisLabel = 'MTG Pinjemin ke Hub Lain';
      statusLabel = payload.status || 'DIPINJAMKAN';
      sheetTargetName = 'Pinjemin ke Hub Lain';
    } else if (isTerimaKembali) {
      jenisLabel = 'MTG Terima Pengembalian dari Hub Lain';
      statusLabel = payload.status || 'DITERIMA KEMBALI';
      sheetTargetName = 'Terima Pengembalian Hub';
    }

    var sheet = ss.getSheetByName(sheetTargetName) || ss.insertSheet(sheetTargetName);

    var sku = String(payload.sku || payload.skuNo || '').trim();
    var productName = String(payload.productName || payload.namaProduk || '').trim();
    var sloc = String(payload.sloc || payload.rack || '').trim();
    var qty = Number(payload.qty || 1);
    var hub = String(payload.hub || payload.hubTujuan || payload.hubAsal || '').trim();
    var kondisi = String(payload.kondisi || payload.kondisiBarang || 'Good').trim();
    var pic = String(payload.pic || payload.picPetugas || payload.petugas || '').trim();
    var picHub = String(payload.picHub || payload.driver || payload.picDriver || '').trim();
    var remarks = String(payload.remarks || payload.catatan || '').trim();

    var drivePhotoUrl = '';
    if (payload.imageBase64) {
      try {
        var folder;
        var folderId = EDC_CONFIG.EVIDENCE_FOLDER_ID || "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3";
        try {
          folder = DriveApp.getFolderById(folderId);
        } catch (errF) {}
        if (!folder) {
          var folderName = 'PINJAMAN_MTG_EVIDENCE';
          var folders = DriveApp.getFoldersByName(folderName);
          folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
          folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        }

        var dateStr = Utilities.formatDate(new Date(), timezone, "yyyyMMdd_HHmmss");
        var prefix = isPinjeminKeHub ? 'PINJEMIN_' : (isTerimaKembali ? 'TERIMA_' : (isKembalikanKeHub ? 'KEMBALI_' : 'PINJAM_'));
        var skuClean = sku || 'NOSKU';
        var fileName = prefix + skuClean + '_' + dateStr + '.jpg';
        var cleanBase64 = payload.imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
        var decoded = Utilities.base64Decode(cleanBase64);
        var blob = Utilities.newBlob(decoded, 'image/jpeg', fileName);
        var file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        drivePhotoUrl = file.getUrl();
      } catch (errUpload) {
        console.warn('Gagal upload bukti foto ke Drive:', errUpload);
      }
    }

    var rowObj = {
      timestamp: timestamp,
      jenis: jenisLabel,
      sku: sku,
      productName: productName,
      sloc: sloc,
      qty: qty,
      hub: hub,
      kondisi: kondisi,
      pic: pic,
      picHub: picHub,
      photoUrl: drivePhotoUrl,
      status: statusLabel,
      remarks: remarks
    };

    var headerColor = '#0284C7';
    var defaultHeaders = [];

    if (sheetTargetName === 'Pinjemin ke Hub Lain') {
      headerColor = '#D97706'; // Amber / Oranye
      defaultHeaders = [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB PEMINJAM (TUJUAN)', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ];
    } else if (sheetTargetName === 'Terima Pengembalian Hub') {
      headerColor = '#7C3AED'; // Ungu / Violet
      defaultHeaders = [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB ASAL PENGEMBALIAN', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ];
    } else if (sheetTargetName.indexOf('Pengembalian') !== -1 || sheetTargetName.indexOf('Kembalikan') !== -1) {
      headerColor = '#059669'; // Hijau Emerald
      defaultHeaders = [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB TARGET PENGEMBALIAN', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ];
    } else {
      headerColor = '#0284C7'; // Biru Sky
      defaultHeaders = [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB TARGET PINJAM', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ];
    }

    if (sheet.getLastRow() === 0 || (sheet.getLastRow() === 1 && !sheet.getRange(1, 1).getValue())) {
      sheet.getRange(1, 1, 1, defaultHeaders.length).setValues([defaultHeaders]);
      sheet.getRange(1, 1, 1, defaultHeaders.length)
        .setBackground(headerColor)
        .setFontColor('#FFFFFF')
        .setFontWeight('bold')
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      sheet.setRowHeight(1, 36);
      sheet.setFrozenRows(1);
    }

    var curHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), defaultHeaders.length)).getValues()[0];
    var rowArr = [];
    for (var c = 0; c < curHeaders.length; c++) {
      var h = String(curHeaders[c] || '').trim().toUpperCase();
      if (!h) { rowArr.push(''); continue; }
      if (h.indexOf('TIMESTAMP') !== -1 || h.indexOf('WAKTU') !== -1) rowArr.push(rowObj.timestamp || '');
      else if (h.indexOf('JENIS') !== -1) rowArr.push(rowObj.jenis || '');
      else if (h.indexOf('SKU') !== -1) rowArr.push(rowObj.sku || '');
      else if (h.indexOf('PRODUK') !== -1 || h.indexOf('NAMA') !== -1) rowArr.push(rowObj.productName || '');
      else if (h.indexOf('SLOC') !== -1 || h.indexOf('RAK') !== -1) rowArr.push(rowObj.sloc || '');
      else if (h.indexOf('QTY') !== -1) rowArr.push(rowObj.qty !== undefined ? rowObj.qty : '');
      else if (h.indexOf('HUB') !== -1 && h.indexOf('DRIVER') === -1) rowArr.push(rowObj.hub || '');
      else if (h.indexOf('KONDISI') !== -1) rowArr.push(rowObj.kondisi || 'Good');
      else if (h.indexOf('PETUGAS') !== -1 || h.indexOf('PEMINJAM') !== -1 || h.indexOf('PENGEMBALIAN') !== -1 || (h.indexOf('PIC') !== -1 && h.indexOf('DRIVER') === -1)) rowArr.push(rowObj.pic || '');
      else if (h.indexOf('DRIVER') !== -1 || (h.indexOf('PIC') !== -1 && h.indexOf('HUB') !== -1)) rowArr.push(rowObj.picHub || '');
      else if (h.indexOf('FOTO') !== -1 || h.indexOf('DRIVE') !== -1 || h.indexOf('BUKTI') !== -1) rowArr.push(rowObj.photoUrl || '');
      else if (h.indexOf('STATUS') !== -1) rowArr.push(rowObj.status || '');
      else if (h.indexOf('CATATAN') !== -1 || h.indexOf('REMARKS') !== -1) rowArr.push(rowObj.remarks || '');
      else rowArr.push('');
    }

    if (typeof appendToFirstEmptyRow === 'function') {
      appendToFirstEmptyRow(sheet, rowArr);
    } else {
      sheet.appendRow(rowArr);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Transaksi "' + jenisLabel + '" SKU ' + sku + ' berhasil dicatat ke sheet "' + sheetTargetName + '"!',
      jenis: jenisLabel,
      sku: sku,
      productName: productName,
      qty: qty,
      hub: hub,
      pic: pic,
      photoUrl: drivePhotoUrl,
      timestamp: timestamp
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Gagal memproses data pinjaman: ' + err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}


