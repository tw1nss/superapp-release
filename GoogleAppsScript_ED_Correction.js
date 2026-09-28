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
  DATA_UPDATE: "Data Update ED Corection"
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
  if (type === 'HASIL' || type === 'HISTORICAL' || type === 'BACKUP') {
    return ss.getSheetByName('Hasil ED Correction') || 
           ss.getSheetByName('Hasil ED Corection') || 
           ss.getSheetByName('Hasil EDC') || 
           ss.getSheetByName('Backup ED Corection') || 
           ss.getSheetByName('Backup Data ED Correction');
  }
  return ss.getSheetByName(type);
}

// ==============================================================================
// 🔘 TRIGGER ON OPEN & PEMBUATAN MENU
// ==============================================================================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  // Panggil menu Superset, DCC, dan EDS jika terintegrasi dalam 1 file
  if (typeof buildSupersetMenu === 'function') buildSupersetMenu(ui);
  if (typeof buildDccMenu === 'function') buildDccMenu(ui);
  if (typeof buildEdSweeperMenu === 'function') buildEdSweeperMenu(ui);

  // Bangun Menu Utama ED Correction
  buildEdCorrectionMenu(ui);
}

function buildEdCorrectionMenu(ui) {
  if (!ui) {
    try {
      ui = SpreadsheetApp.getUi();
    } catch(e) {
      return;
    }
  }

  ui.createMenu('✏️ ED Correction Control')
    .addItem('🔄 Tarik Data Superset ke Data Update ED Correction', 'updateEdCorrectionFromSupersetManual')
    .addSeparator()

    // ── SUBMENU 1: INPUT SKU (PENUGASAN) ──
    .addSubMenu(ui.createMenu('📥 1. Input SKU (Penugasan Tugas)')
      .addItem('📥 Assign Tugas Baru (Paste SKU)', 'assignEdCorrectionTaskPrompt')
      .addItem('🧹 Bersihkan Baris Tanggal di Kolom SKU', 'cleanInvalidSkusAndDatesInMainlist')
      .addItem('🔧 Pecah / Perbaiki SKU Menumpuk di Cell C', 'fixClumpedSkuRowsEdCorrection')
      .addItem('📋 Tarik Detail SKU dari Data Update / Stok', 'syncDetailSkuEdCorrectionManual')
    )
    .addSeparator()

    // ── SUBMENU 2: MAIN LIST ──
    .addSubMenu(ui.createMenu('📋 2. Main List SKU')
      .addItem('🎨 Setup & Buat Main List SKU Baru', 'formatMainlistSkuEdCorrection')
      .addItem('⚡ Pasang Rumus Otomatis "Main List"', 'installEdCorrectionMainlistFormulasManual')
      .addItem('🔧 Bersihkan Sel Penimpa Rumus (Error D122 / #REF!)', 'repairFormulaRunwayPrompt')
      .addItem('🧹 Kosongkan / Reset Sheet "Main List"', 'resetMainlistSkuEdCorrectionPrompt')
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
    } catch(err) {
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
    } catch(eVal) {}
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
  } catch(e) {
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
          data = json.data.map(function(row) {
            var obj = {};
            json.colnames.forEach(function(col, idx) {
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
  var hasSku = headers.some(function(h) { return h.toLowerCase().includes("sku"); });
  var addSkuCol = (!hasSku && qrIdx !== -1);
  if (addSkuCol) {
    headers.push('sku_number');
  }

  var rows = data.map(function(item) {
    return headers.map(function(key) {
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
  } catch(eVal) {
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
    var skuIdx = headers.findIndex(function(h) { return h.toLowerCase().includes("sku"); });
    if (skuIdx !== -1) {
      sheet.getRange(2, skuIdx + 1, rows.length, 1).setNumberFormat('@');
    }
  }

  try {
    sheet.autoResizeColumns(1, Math.min(headers.length, 15));
  } catch(eResize) {}
}

// ==============================================================================
// 📥 1. INPUT SKU (PENUGASAN TUGAS OLEH SUPERVISOR)
// ==============================================================================

/**
 * Dialog interaktif untuk supervisor mem-paste list SKU tugas
 */
function assignEdCorrectionTaskPrompt() {
  var ui = SpreadsheetApp.getUi();

  // 1. Pilih Shift
  var shiftResp = ui.alert(
    'Pilih Shift Tugas ED Correction',
    'Pilih Shift untuk penugasan ini:\n\n- Klik YES = Shift 1 (Pagi)\n- Klik NO = Shift 2 (Siang)',
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (shiftResp === ui.Button.CANCEL) return;
  var shiftLabel = (shiftResp === ui.Button.YES) ? 'Shift 1 (Pagi)' : 'Shift 2 (Siang)';

  // 2. Input List SKU
  var skuResp = ui.prompt(
    '📥 Input List SKU - ' + shiftLabel,
    'Paste daftar SKU tugas di bawah ini (bisa copas dari Excel / teks baris):\n' +
    'Tip: Jika copas tabel Excel, sistem otomatis mengambil kolom SKU & mengabaikan tanggal.',
    ui.ButtonSet.OK_CANCEL
  );

  if (skuResp.getSelectedButton() !== ui.Button.OK) return;
  var skuText = skuResp.getResponseText();

  if (!skuText || skuText.trim() === '') {
    alertEdc('⚠️ Tidak ada SKU yang dimasukkan.');
    return;
  }

  // Parsing cerdas anti-clump & anti-gabung tanggal
  var lines = skuText.split(/\r?\n/);
  var skuList = [];
  var seen = {};

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Jika baris berisi format QR Code Superset (SKU;DDMMYYYY)
    if (line.indexOf(';') !== -1) {
      var qrPart = line.split(';')[0].replace(/[^\w-]/g, '').trim();
      if (qrPart.length >= 3 && !seen[qrPart]) {
        seen[qrPart] = true;
        skuList.push(qrPart);
        continue;
      }
    }

    // Jika baris berisi tab (copas multi-kolom Excel), utamakan kolom pertama yang valid sebagai SKU
    if (line.indexOf('\t') !== -1) {
      var cols = line.split('\t').map(function(c) { return c.trim(); }).filter(function(c) { return c.length > 0; });
      if (cols.length > 0) {
        var firstCol = cols[0].replace(/[^\w-]/g, '').trim();
        var is8Date = (firstCol.length === 8 && /^\d{8}$/.test(firstCol));
        if (is8Date) {
          var td = parseInt(firstCol.substring(0, 2), 10);
          var tm = parseInt(firstCol.substring(2, 4), 10);
          var ty = parseInt(firstCol.substring(4, 8), 10);
          if (td >= 1 && td <= 31 && tm >= 1 && tm <= 12 && ty >= 2024 && ty <= 2035) {
            continue;
          }
        }
        // Pastikan bukan tanggal berformat separator
        if (firstCol && !firstCol.match(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/) && !firstCol.match(/^\d{4}-\d{2}-\d{2}$/)) {
          if (!seen[firstCol]) {
            seen[firstCol] = true;
            skuList.push(firstCol);
            continue;
          }
        }
      }
    }

    // Pisahkan berdasarkan spasi, koma, titik-koma, pipe
    var tokens = line.split(/[\s,;|]+/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      // Abaikan token yang merupakan tanggal (contoh: 07/10/2026, 10/2026, 2026-10-07)
      if (tok.match(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/) || tok.match(/^\d{1,2}[\/-]\d{2,4}$/) || tok.match(/^\d{4}-\d{2}-\d{2}$/)) {
        continue;
      }
      // Abaikan format 8 digit tanggal DDMMYYYY (contoh: 05102026, 30092026)
      if (tok.length === 8 && /^\d{8}$/.test(tok)) {
        var d8 = parseInt(tok.substring(0, 2), 10);
        var m8 = parseInt(tok.substring(2, 4), 10);
        var y8 = parseInt(tok.substring(4, 8), 10);
        if (d8 >= 1 && d8 <= 31 && m8 >= 1 && m8 <= 12 && y8 >= 2024 && y8 <= 2035) {
          continue;
        }
      }
      var clean = tok.replace(/[^\w-]/g, '').trim();
      if (clean.length >= 3 && !seen[clean]) {
        seen[clean] = true;
        skuList.push(clean);
      }
    }
  }

  if (skuList.length === 0) {
    alertEdc('⚠️ Tidak ditemukan SKU yang valid dari teks yang Anda masukkan.');
    return;
  }

  // 3. Masukkan ke sheet Main List SKU ED Correction
  var ss = getEdCorrectionSpreadsheet();
  var sheet = getEdCorrectionSheet('MAIN_LIST');
  if (!sheet) {
    formatMainlistSkuEdCorrection();
    sheet = getEdCorrectionSheet('MAIN_LIST');
  }

  if (sheet.getLastRow() < 1) {
    formatMainlistSkuEdCorrection();
  }

  var todayDate = Utilities.formatDate(new Date(), EDC_CONFIG.TIMEZONE, "yyyy-MM-dd");
  
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
      todayDate,     // Kolom A: TANGGAL
      shiftLabel,    // Kolom B: SHIFT
      skuList[j]     // Kolom C: SKU
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

  alertEdc(
    '✅ Berhasil Menugaskan ' + skuList.length + ' SKU!\n\n' +
    'Shift: ' + shiftLabel + '\n' +
    'Tanggal: ' + todayDate + '\n' +
    'Ditambahkan mulai baris ke-' + nextRow + ' di sheet "' + sheet.getName() + '".\n\n' +
    'Detail nama produk, lokasi rak, qty sistem, dan status PENDING sudah langsung aktif!'
  );
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
      var tokens = rawSku.split(/[\r\n\t,; ]+/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
      for (var k = 0; k < tokens.length; k++) {
        var tok = tokens[k];
        if (tok.match(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/) || tok.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
        var clean = tok.replace(/[^\w-]/g, '').trim();
        if (clean.length >= 3) {
          newRows.push([tgl, shift, clean]);
        }
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
  var upHeaders = updateData[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
  
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
        try { ss.deleteSheet(existingUpdate); } catch(eDel) {}
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
  } catch(eVal) {}

  // 16 Kolom Header Lengkap
  var headers = [
    [
      'TANGGAL', 'SHIFT', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'QTY SISTEM', 'ED SISTEM (LAMA)',
      'ED FISIK / KOREKSI', 'STATUS ED', 'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'PETUGAS', 'STATUS', 'REMARKS'
    ]
  ];

  sheet.getRange(1, 1, 1, 16).setValues(headers);

  // Styling Target Supervisor (Kolom A - G: Navy Indigo #1E1B4B)
  sheet.getRange('A1:G1')
    .setBackground('#1E1B4B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  // Styling Hasil Audit Petugas (Kolom H - P: Deep Teal #064E3B)
  sheet.getRange('H1:P1')
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
  sheet.getRange(1, 1, maxRows, 16).setBorder(true, true, true, true, true, true, '#CBD5E1', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(2, 3, maxRows - 1, 1).setNumberFormat('@'); // Text murni untuk SKU

  // Alternating colors
  try {
    sheet.getRange(2, 1, maxRows - 1, 16).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  } catch(eBanding) {}

  sheet.autoResizeColumns(1, 16);
  sheet.setColumnWidth(1, 110); // TANGGAL
  sheet.setColumnWidth(2, 130); // SHIFT
  sheet.setColumnWidth(3, 140); // SKU
  sheet.setColumnWidth(4, 260); // NAMA PRODUK
  sheet.setColumnWidth(5, 140); // LOKASI RAK
  sheet.setColumnWidth(8, 140); // ED FISIK / KOREKSI
  sheet.setColumnWidth(16, 200); // REMARKS

  installEdCorrectionMainlistFormulas(true);

  alertEdc('✨ Sukses!\n\nSheet "' + EDC_SHEETS.MAIN_LIST + '" baru berhasil dibuat dan siap untuk penugasan tugas shift!\n\nRumus lookup dari "' + EDC_SHEETS.DATA_UPDATE + '" dan "' + EDC_SHEETS.HASIL + '" telah aktif.');
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

  // SANGAT PENTING: Bersihkan semua sel dari baris 3 ke bawah untuk Kolom D sampai P (kolom 4 sampai 16)
  // Ini MENCEGAH error fatal: "Hasil array tidak diperluas karena akan menimpa data di D..." (#REF!)
  var maxRows = sheet.getMaxRows();
  if (maxRows > 2) {
    sheet.getRange(3, 4, maxRows - 2, Math.max(13, sheet.getLastColumn() - 3)).clearContent();
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

  // 2. HASIL AUDIT & KOREKSI DARI SHEET HASIL (Kolom H - P)
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
  } catch(e) {}

  alertEdc('✅ Sheet "' + sheet.getName() + '" berhasil disetup dan siap menerima input data audit!');
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
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
    alertEdc('✅ Data di sheet "Hasil ED Correction" telah berhasil dibersihkan.');
  } else {
    alertEdc('ℹ️ Sheet "Hasil ED Correction" memang sudah kosong.');
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
      } catch(errPhoto) {
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
            mainSheet.getRange(m + 2, 15).setValue("DONE");   // Kolom O: Status
            break;
          }
        }
      }
    } catch(eMain) {}

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Data koreksi ED berhasil dicatat!",
      sku: sku,
      timestamp: timestamp,
      photoUrl: photoUrl
    })).setMimeType(ContentService.MimeType.JSON);

  } catch(e) {
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
  } catch(e) {
    // Mode headless (Pemicu Waktu / background)
    Logger.log("[ED CORRECTION] " + msg);
    console.log("[ED CORRECTION] " + msg);
    try {
      var ss = getEdCorrectionSpreadsheet();
      if (ss && typeof ss.toast === "function") {
        ss.toast(String(msg).split("\n")[0], "ED Correction", 5);
      }
    } catch(errToast) {}
  }
}
