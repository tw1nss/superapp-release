/**
 * =========================================================================
 * 🚀 FINAL COMBINED SCRIPT: DCC MASTER ALL-IN-ONE (CARA 2) + SUPERSET + API
 * =========================================================================
 * Spreadsheet: Dashboard STK MTG 2K26
 * URL: https://docs.google.com/spreadsheets/d/1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g/edit
 *
 * FITUR UNGGULAN:
 * 1. 📈 SUPERSET ENGINE:
 *    - Auto sync data dari Superset ke 'STOCK UPDATE', 'BAD & LOST', 'MSLTC', 'RACK UPDATE'.
 *    - Penanganan cookie expired, format tanggal, & konversi tipe angka otomatis.
 *
 * 2. 📊 DCC V3 CARA 2 (ALL-IN-ONE SYSTEM):
 *    - Sheet 'Mainlist SKU' sebagai kontrol tugas harian Supervisor (Shift 1 Pagi & Shift 2 Siang).
 *    - Target Supervisor (Kolom A-G: Navy #1E293B) & Hasil Audit (Kolom H-P: Deep Teal #0F766E).
 *    - Rumus otomatis ARRAYFORMULA + XLOOKUP (search_mode -1 = selalu ambil audit terbaru).
 *    - Status otomatis berubah jadi 'DONE' (hijau) & hitung selisih stok begitu audit masuk.
 *
 * 3. 📱 WEB APP POST & GET API (SUPERAPP MTG):
 *    - doPost: Menerima hasil scan audit dari aplikasi HP, simpan foto ke Google Drive,
 *      catat 21 kolom ke 'Hasil DCC', dan langsung update status 'DONE' di 'Mainlist SKU'.
 *    - doGet: Bulk read super cepat untuk konsumsi data API frontend (?sheet=...).
 *
 * 4. 📦 BACKUP & MAINTENANCE:
 *    - copyDccToHistorical: Backup otomatis data 'Hasil DCC' (Kolom G terisi) ke 'Historical Data'.
 *    - bersihkanBarisKosong: Bersihkan baris kosong berlebih di 'Historical Data'.
 *    - hapus: Reset/bersihkan data kolom di 'Hasil DCC'.
 *    - resetMainlistSkuPrompt: Bersihkan data tugas 'Mainlist SKU' untuk hari berikutnya.
 * =========================================================================
 */

// =============================
// ⚙️ CONFIG GLOBAL
// =============================
var CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  TARGET_FILE_ID: "1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g",
  EVIDENCE_FOLDER_ID: "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3", // 📁 Folder Google Drive Bukti Foto DCC
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// =============================
// 📊 CHART CONFIG (SUPERSET)
// =============================
var CHARTS = [
  { id: 11860, sheet: "STOCK UPDATE" },
  { id: 11861, sheet: "BAD & LOST" },
  { id: 11815, sheet: "MSLTC" },
  { id: 12422, sheet: "RACK UPDATE" },
  { id: 12077, sheet: "Mainlist Sku ED Corection" }
];

// Helper: Ambil spreadsheet target (Bisa bound atau standalone ID)
function getSpreadsheet() {
  try {
    if (CONFIG.TARGET_FILE_ID) {
      return SpreadsheetApp.openById(CONFIG.TARGET_FILE_ID);
    }
  } catch (e) {
    console.warn("Gagal openById, menggunakan Active Spreadsheet:", e);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// =============================
// 🔘 TRIGGER ON OPEN (MENU)
// =============================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  buildSupersetMenu(ui);
  buildDccMenu(ui);
  if (typeof buildEdSweeperMenu === 'function') {
    buildEdSweeperMenu(ui);
  }
  if (typeof buildEdCorrectionMenu === 'function') {
    buildEdCorrectionMenu(ui);
  }
}

function buildSupersetMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('📈 Superset Control')
    .addItem('🚀 Update Semua Data Superset', 'update_all')
    .addSeparator()
    .addItem('1. STOCK UPDATE', 'menu_stock')
    .addItem('2. BAD & LOST', 'menu_bad_lost')
    .addItem('3. MSLTC', 'menu_msltc')
    .addItem('4. RACK UPDATE', 'Menu_rack_update')
    .addItem('5. ED CORRECTION (Chart 12077)', 'menu_ed_correction')
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'setSupersetCookiePrompt')
    .addSeparator()
    .addItem('⏰ Aktifkan Pemicu Auto-Sync (Setiap Jam)', 'setupSupersetHourlyTrigger')
    .addItem('🛑 Matikan Pemicu Auto-Sync', 'removeSupersetAutoSyncTriggerPrompt')
    .addToUi();
}

function buildDccMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('📊 DCC Control')
    .addItem('🎨 Rapikan & Format Tampilan "Mainlist SKU"', 'formatMainlistSkuDcc')
    .addSeparator()
    .addItem('📥 Assign Tugas Baru (Paste SKU)', 'assignDccTaskPrompt')
    .addItem('🔧 Pecah / Perbaiki SKU Menumpuk di Cell C', 'fixClumpedSkuRows')
    .addItem('⚡ Pasang Rumus Otomatis "Mainlist SKU"', 'installDccMainlistFormulas')
    .addItem('📋 Tarik Detail SKU dari "STOCK UPDATE"', 'syncDetailSkuMainlist')
    .addSeparator()
    .addItem('📸 Generate Link Bukti Foto Drive', 'generateEvidenceLinksDCC')
    .addItem('📦 Backup DCC ke Historical', 'copyDccToHistorical')
    .addItem('🧹 Bersihkan Baris Kosong Historical', 'bersihkanBarisKosong')
    .addItem('🔧 Bersihkan Kolom Formula (Cegah #REF!)', 'repairDccFormulaColumnsManual')
    .addItem('🗑️ Clear Kolom Sheet "Hasil DCC"', 'hapus')
    .addItem('🔄 Kosongkan / Reset "Mainlist SKU"', 'resetMainlistSkuPrompt')
    .addToUi();
}

// =============================
// 🔘 MENU WRAPPERS (SUPERSET)
// =============================
function menu_stock() {
  update_single(11860, "STOCK UPDATE");
}

function Menu_rack_update() {
  update_single(12422, "RACK UPDATE");
}

function menu_bad_lost() {
  update_single(11861, "BAD & LOST");
}

function menu_msltc() {
  update_single(11815, "MSLTC");
}

function menu_ed_correction() {
  update_single(12077, "Mainlist Sku ED Corection");
}

function update_all() {
  console.log("🚀 [AUTO-SYNC] Memulai penarikan data Superset...");
  CHARTS.forEach(function(c) {
    update_single(c.id, c.sheet);
  });

  alertUser("✅ Semua data Superset berhasil diperbarui!");
  console.log("✅ [AUTO-SYNC] Semua data Superset berhasil diperbarui.");
}

function update_single(chartId, sheetName) {
  pullSupersetData(chartId, sheetName);
}

// ============================================================
// ⏰ TRIGGER MANAGEMENT (AUTO-SYNC PEMICU WAKTU)
// ============================================================
function setupSupersetHourlyTrigger() {
  removeSupersetAutoSyncTrigger();
  ScriptApp.newTrigger('update_all')
    .timeBased()
    .everyHours(1)
    .create();
  alertUser("✅ Pemicu Waktu Auto-Sync Superset berhasil diaktifkan!\nData Superset akan di-update otomatis setiap 1 jam sekali.");
}

function removeSupersetAutoSyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'update_all') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  return count;
}

function removeSupersetAutoSyncTriggerPrompt() {
  var deleted = removeSupersetAutoSyncTrigger();
  if (deleted > 0) {
    alertUser("🛑 Auto-sync Superset telah dinonaktifkan (" + deleted + " pemicu dihapus).");
  } else {
    alertUser("ℹ️ Tidak ada pemicu auto-sync Superset yang aktif.");
  }
}

// ============================================================
// 📡 API GET DATA UNTUK FRONTEND (BULK READ SUPER CEPAT)
// ============================================================
function doGet(e) {
  // Ambil sheet berdasarkan parameter URL (contoh: ?sheet=STOCK UPDATE). Jika kosong, default ke "Hasil DCC"
  var sheetName = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : "Hasil DCC"; 
  
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ 
      error: "Sheet '" + sheetName + "' tidak ditemukan.",
      availableSheets: ss.getSheets().map(function(s) { return s.getName(); })
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 1. BULK READ: Tarik fisik cell sekaligus ke array 2D di memori V8
  var values = sheet.getDataRange().getValues();
  var result = [];

  if (values.length > 0) {
    var headers = values[0];

    // 2. LOOPING DI MEMORI: Beroperasi pada array, mulai baris kedua (index 1)
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      
      // 3. SKIP BARIS KOSONG: Deteksi jika seluruh string baris ini kosong
      var isEmptyRow = row.join("").trim() === "";
      if (isEmptyRow) {
        continue;
      }

      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var key = headers[j];
        if (key && key.toString().trim() !== "") {
          obj[key] = row[j] !== undefined ? row[j] : "";
        }
      }
      result.push(obj);
    }
  }

  return ContentService.createTextOutput(JSON.stringify(result))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ── HELPER: Menulis ke baris kosong pertama yang sebenarnya ──
// Mencegah data terlempar ke baris 200+ jika baris atas pernah diedit/dihapus isinya saja
// Serta AMAN terhadap Header ARRAYFORMULA (seperti Fisik/System di P1 Hasil DCC) agar tidak memicu #REF!
function appendToFirstEmptyRow(sheet, rowData) {
  var maxRows = sheet.getLastRow();
  var targetRow = -1;

  if (maxRows > 1) {
    // Cek kolom 1 dan 2 dari baris 2 sampai lastRow
    var checkData = sheet.getRange(2, 1, maxRows - 1, 2).getValues();
    for (var i = 0; i < checkData.length; i++) {
      var val1 = String(checkData[i][0] || '').trim();
      var val2 = String(checkData[i][1] || '').trim();
      if (val1 === '' && val2 === '') {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow === -1) {
    targetRow = Math.max(maxRows + 1, 2);
  }

  // Cek apakah ada formula di Header (Baris 1), misalnya ArrayFormula di P1 {"Fisik/System"; ARRAYFORMULA(...)}
  var lastCol = Math.max(rowData.length, sheet.getLastColumn());
  var headerFormulas = sheet.getRange(1, 1, 1, lastCol).getFormulas()[0];

  // Bersihkan nilai lama di kolom yang memiliki ARRAYFORMULA di Baris 1 agar ekspansi rumus tidak terhalang (#REF!)
  for (var c = 0; c < rowData.length; c++) {
    var formula = String(headerFormulas[c] || '').toUpperCase();
    if (formula.indexOf('ARRAYFORMULA') !== -1 || formula.indexOf('=MAP(') !== -1 || formula.indexOf('={') === 0) {
      var colNum = c + 1;
      var totalRowsBelowHeader = Math.max(maxRows, targetRow) - 1;
      if (totalRowsBelowHeader > 0) {
        sheet.getRange(2, colNum, totalRowsBelowHeader, 1).clearContent();
      }
    }
  }

  // Tulis data baris baru:
  // Kolom dengan formula di Baris 1 dilewati (dibiarkan kosong murni)
  var startCol = -1;
  var chunk = [];
  for (var c = 0; c < rowData.length; c++) {
    var colNum = c + 1;
    var f = String(headerFormulas[c] || '').trim();
    var isHeaderFormula = f !== '';

    if (isHeaderFormula) {
      if (chunk.length > 0) {
        sheet.getRange(targetRow, startCol, 1, chunk.length).setValues([chunk]);
        chunk = [];
        startCol = -1;
      }
      sheet.getRange(targetRow, colNum).clearContent();
    } else {
      if (startCol === -1) {
        startCol = colNum;
      }
      chunk.push(rowData[c]);
    }
  }
  if (chunk.length > 0) {
    sheet.getRange(targetRow, startCol, 1, chunk.length).setValues([chunk]);
  }
}

// Helper menu DCC untuk memperbaiki kolom formula yang tertimpa data manual
function repairDccFormulaColumnsManual() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Hasil DCC') || ss.getSheetByName('MTG');
  if (!sheet) {
    alertUser('❌ Sheet Hasil DCC tidak ditemukan.');
    return;
  }
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1) {
    alertUser('ℹ️ Sheet Hasil DCC masih kosong.');
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

  if (fixedCols.length > 0) {
    alertUser('✅ Perbaikan Rumus Selesai\n\nData menimpa berhasil dibersihkan pada Kolom ' + fixedCols.join(', ') + '.\n\nRumus header (seperti Fisik/System di P1) sekarang aktif normal!');
  } else {
    alertUser('ℹ️ Info\n\nSemua kolom formula di Hasil DCC sudah bersih dan aktif normal.');
  }
}

// ============================================================
// 📡 API POST: PENERIMA AUDIT DARI SUPERAPP MTG (HP / SCANNER)
// ============================================================
function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }

    // Router jika request adalah audit ED Sweeper
    if (payload.action === 'saveEdsResult' || payload.module === 'eds' || payload.module === 'ed_sweeper') {
      if (typeof handleEdsSubmit === 'function') {
        return handleEdsSubmit(payload);
      }
    }

    // Router jika request adalah audit ED Correction
    if (payload.action === 'saveEdCorrectionResult' || payload.module === 'ed_correction' || payload.module === 'edc') {
      if (typeof handleEdCorrectionSubmit === 'function') {
        return handleEdCorrectionSubmit(payload);
      }
      return handleEdCorrectionSubmitDccFallback(payload);
    }

    var ss = getSpreadsheet();

    var skuNo = String(payload.skuNo || payload.sku || payload.sku_number || '').trim();
    var namaSku = String(payload.namaSku || payload.productName || '').trim();
    var slocExisting = String(payload.slocExisting || payload.lokasiRack || '').trim();
    var slocActual = String(payload.slocActual || 'Match').trim();
    var expiredDate = String(payload.expiredDate || '').trim();
    var fisikGood = payload.fisikGood !== undefined ? payload.fisikGood : '0';
    var fisikBad = payload.fisikBad !== undefined ? payload.fisikBad : '0';
    var sales = payload.sales !== undefined ? payload.sales : '0';
    var reasonSloc = String(payload.reasonSloc || '').trim();
    var reasonBad = String(payload.reasonBad || '').trim();
    var inputBy = String(payload.inputBy || payload.pic || payload.penginput || '').trim();
    var msltc = String(payload.msltc || '').trim();

    // ── 1. UPLOAD FOTO KE GOOGLE DRIVE JIKA ADA EVIDENCE ──
    var evidanceLink1 = '';
    var evidanceLink2 = '';
    var evidance1Name = '';
    var evidance2Name = '';

    if (payload.imageBase64) {
      try {
        var folder;
        if (CONFIG.EVIDENCE_FOLDER_ID) {
          try {
            folder = DriveApp.getFolderById(CONFIG.EVIDENCE_FOLDER_ID);
          } catch (errFId) {
            console.warn('Gagal getFolderById, fallback ke folder default:', errFId);
          }
        }
        if (!folder) {
          var folderName = 'DCC_MTG_EVIDANCE';
          var folders = DriveApp.getFoldersByName(folderName);
          if (folders.hasNext()) {
            folder = folders.next();
          } else {
            folder = DriveApp.createFolder(folderName);
            folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          }
        }

        var dateStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyyMMdd_HHmmss");
        evidance1Name = 'DCC_' + skuNo + '_1_' + dateStr + '.jpg';
        var cleanBase64_1 = payload.imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
        var decoded1 = Utilities.base64Decode(cleanBase64_1);
        var blob1 = Utilities.newBlob(decoded1, 'image/jpeg', evidance1Name);
        var file1 = folder.createFile(blob1);
        file1.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        evidanceLink1 = file1.getUrl();

        if (payload.imageBase64_2) {
          evidance2Name = 'DCC_' + skuNo + '_2_' + dateStr + '.jpg';
          var cleanBase64_2 = payload.imageBase64_2.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
          var decoded2 = Utilities.base64Decode(cleanBase64_2);
          var blob2 = Utilities.newBlob(decoded2, 'image/jpeg', evidance2Name);
          var file2 = folder.createFile(blob2);
          file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          evidanceLink2 = file2.getUrl();
        }
      } catch (errUpload) {
        console.warn('Gagal upload foto DCC:', errUpload);
      }
    }

    var timestamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "dd/MM/yyyy HH:mm:ss");

    // ── 2. TULIS KE SHEET "Hasil DCC" (21 KOLOM STANDAR) ──
    var hasilDccSheet = ss.getSheetByName('Hasil DCC') || ss.insertSheet('Hasil DCC');
    if (hasilDccSheet.getLastRow() === 0) {
      hasilDccSheet.appendRow([
        "Timestamp", "SKU Number", "Nama SKU ", "SLOC Existing", "SLOC Actual",
        "Expired Date", "Fisik Good", "Fisik Bad", "Sales (jika ada)",
        "Reason SLOC", "Reason Bad", "Evidance 1", "Evidance 2",
        "Evidance Link 1", "Evidance Link 2", "Fisik/System", "MSLTC",
        "SKU No", "Input by", "Label Barcode Product", "Label Sloc"
      ]);
    }

    var labelProduct = String(payload.labelProduct || 'Ada').trim();
    var labelSloc = String(payload.labelSloc || 'Ada').trim();
    var qtySysVal = payload.qty_system || payload.qtySistem || '';
    var fisikSystem = qtySysVal !== '' ? (fisikGood + '/' + qtySysVal) : String(fisikGood);

    var dccRowData = [
      timestamp,
      skuNo,
      namaSku,
      slocExisting,
      slocActual,
      expiredDate,
      fisikGood,
      fisikBad,
      sales,
      reasonSloc,
      reasonBad,
      evidance1Name,
      evidance2Name,
      evidanceLink1,
      evidanceLink2,
      fisikSystem,
      msltc,
      skuNo,
      inputBy,
      labelProduct,
      labelSloc
    ];

    // Simpan baris transaksi audit mentah (Raw Log) ke baris kosong pertama
    appendToFirstEmptyRow(hasilDccSheet, dccRowData);

    // ── 3. AUTO-UPDATE SHEET "Mainlist SKU" (KOLOM H - P) JIKA ADA ──
    try {
      var mainlistSheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
      if (mainlistSheet && skuNo) {
        var lastMRow = mainlistSheet.getLastRow();
        if (lastMRow > 1) {
          // JANGAN menimpa jika kolom H menggunakan formula otomatis (misal =MAP(...))
          var h2Formula = mainlistSheet.getRange(2, 8).getFormula();
          if (!h2Formula || h2Formula.trim() === '') {
            var mSkuValues = mainlistSheet.getRange(2, 3, lastMRow - 1, 1).getValues(); // Col C (SKU)
            for (var r = 0; r < mSkuValues.length; r++) {
              var rawVal = String(mSkuValues[r][0] || '').trim();
              if (rawVal && (rawVal.toLowerCase() === skuNo.toLowerCase() || rawVal.includes(skuNo))) {
                var targetRow = r + 2;
                var fg = Number(fisikGood) || 0;
                var fb = Number(fisikBad) || 0;
                var tot = fg + fb;
                var sysQty = Number(mainlistSheet.getRange(targetRow, 6).getValue()) || 0;
                var diff = tot - sysQty;
                var slocMatch = (slocActual.toLowerCase() === 'match') ? 'MATCH' : 'UNMATCH';
                var remaksVal = reasonBad || reasonSloc || payload.remaks || 'Sesuai';

                mainlistSheet.getRange(targetRow, 8).setValue(fg);          // Col H: FISIK GOOD
                mainlistSheet.getRange(targetRow, 9).setValue(fb);          // Col I: FISIK BAD
                mainlistSheet.getRange(targetRow, 10).setValue(tot);        // Col J: TOTAL FISIK
                mainlistSheet.getRange(targetRow, 11).setValue(diff);       // Col K: SELISIH
                mainlistSheet.getRange(targetRow, 12).setValue(slocActual);  // Col L: SLOC ACTUAL
                mainlistSheet.getRange(targetRow, 13).setValue(slocMatch);   // Col M: SLOC MATCH?
                mainlistSheet.getRange(targetRow, 14).setValue(inputBy);     // Col N: PETUGAS
                mainlistSheet.getRange(targetRow, 15).setValue('DONE');      // Col O: STATUS
                mainlistSheet.getRange(targetRow, 16).setValue(remaksVal);   // Col P: REMARKS
                break;
              }
            }
          }
        }
      }
    } catch (errSync) {
      console.warn('Gagal auto-update Mainlist SKU:', errSync);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data audit SKU ' + skuNo + ' berhasil disimpan ke Hasil DCC & Mainlist SKU.',
      photoUrl1: evidanceLink1,
      photoUrl2: evidanceLink2
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// 🧠 CORE ENGINE (SUPERSET DATA FETCHER)
// ============================================================
function pullSupersetData(chartId, sheetName) {
  var cookie = PropertiesService
    .getScriptProperties()
    .getProperty('MY_COOKIE');

  if (!cookie) {
    return alertUser("❌ MY_COOKIE belum di-set!\n\nGunakan menu '📈 Superset Control' ➔ '🔑 Set / Ganti Cookie Superset' untuk memasukkan cookie.");
  }

  var timestamp = new Date().getTime();

  var formDataKey = (chartId === 12077) ? "FGnMPSQjzn-IkTT_ZdewtmeAw3D7uPCz56ErrkOHEZT-KyQ5BLwbb8-QXzzmQpaL" : "";
  var pageId = (chartId === 12077) ? "OuCI-jVWZVevhI7VLi-Uh" : "";

  var urlVariants = [];
  if (formDataKey) {
    urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + "&slice_id=" + chartId + "&force=true&_t=" + timestamp);
  }
  urlVariants.push(CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp);
  if (pageId) {
    urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({ slice_id: Number(chartId), dashboard_page_id: pageId })) + "&force=true&_t=" + timestamp);
  }
  urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data={\"slice_id\":" + chartId + "}&force=true&_t=" + timestamp);

  var response;
  var data;
  var success = false;
  var lastError = "";

  for (var u = 0; u < urlVariants.length; u++) {
    for (var i = 0; i < CONFIG.MAX_RETRY; i++) {
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
          return alertUser("❌ COOKIE EXPIRED!\n\nSilakan perbarui cookie Superset Anda di menu '🔑 Set / Ganti Cookie Superset'.");
        }

        if (code !== 200) {
          lastError = "HTTP " + code;
          Utilities.sleep(CONFIG.RETRY_DELAY);
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
          processToSheet(data, sheetName);
          success = true;
          break;
        }

      } catch (e) {
        lastError = e.message;
      }
    }
    if (success) break;
  }

  if (!success) {
    alertUser("❌ Gagal tarik data (" + sheetName + ")\n" + lastError);
  }
}

// =============================
// 📋 WRITE TO SHEET (SUPERSET)
// =============================
function processToSheet(data, sheetName) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  if (!data || data.length === 0) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue("⚠️ Data kosong");
    return;
  }

  var headers = Object.keys(data[0]);

  var rows = data.map(function(item) {
    return headers.map(function(key) {
      var value = item[key];

      // FIX 1: SKU wajib format teks murni
      if (key.toLowerCase().includes("sku")) {
        return String(value);
      }

      // FIX 2: Format tanggal
      if (key.toLowerCase().includes("date") && value && !isNaN(value)) {
        try {
          return Utilities.formatDate(
            new Date(Number(value)),
            CONFIG.TIMEZONE,
            "yyyy-MM-dd HH:mm:ss"
          );
        } catch(e) {}
      }

      // FIX 3: Pastikan quantity & price bertipe number murni
      var cleanKey = key.toLowerCase();
      if (cleanKey === "quantity" || cleanKey === "reserved_quantity" || cleanKey.includes("qty") || cleanKey === "price") {
        return (value !== "" && value !== null && !isNaN(value)) ? Number(value) : value;
      }

      return value;
    });
  });

  sheet.clearContents();

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight("bold");

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

// ==============================================================================
// 🛠️ SETUP & STYLING PROFESIONAL: SHEET "Mainlist SKU" (DCC CARA 2 ALL-IN-ONE)
// ==============================================================================
function formatMainlistSkuDcc() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) {
    sheet = ss.insertSheet('Mainlist SKU');
  }

  // 1. Bersihkan seluruh format lama
  sheet.clearFormats();

  // 2. Daftar Header
  var headers = [
    ['TANGGAL', 'SHIFT', 'SKU', 'NAMA PRODUK', 'LOKASI RAK (SLOC)', 'QTY SISTEM', 'TYPE', 
     'FISIK GOOD', 'FISIK BAD', 'TOTAL FISIK', 'SELISIH', 'SLOC ACTUAL', 'SLOC MATCH?', 'PETUGAS', 'STATUS', 'REMARKS']
  ];
  
  sheet.getRange(1, 1, 1, 16).setValues(headers);

  // 3. Atur Tinggi Baris (Generous Spacing)
  sheet.setRowHeight(1, 42);
  for (var r = 2; r <= 100; r++) {
    sheet.setRowHeight(r, 28);
  }

  // 4. ATUR LEBAR SETIAP KOLOM SECARA PRESISI (Anti-Penyok)
  var columnWidths = {
    1: 110,  // A: TANGGAL
    2: 130,  // B: SHIFT
    3: 140,  // C: SKU
    4: 320,  // D: NAMA PRODUK
    5: 170,  // E: LOKASI RAK
    6: 100,  // F: QTY SISTEM
    7: 100,  // G: TYPE
    8: 100,  // H: FISIK GOOD
    9: 100,  // I: FISIK BAD
    10: 105, // J: TOTAL FISIK
    11: 100, // K: SELISIH
    12: 130, // L: SLOC ACTUAL
    13: 125, // M: SLOC MATCH?
    14: 120, // N: PETUGAS
    15: 110, // O: STATUS
    16: 220  // P: REMARKS
  };

  for (var col in columnWidths) {
    sheet.setColumnWidth(parseInt(col), columnWidths[col]);
  }

  // 5. STYLING DUA NADA (TWO-TONE LUXURY PALETTE)
  // Target Supervisor (Kolom A-G: Deep Slate Navy)
  sheet.getRange(1, 1, 1, 7)
    .setBackground('#1E293B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  // Hasil Audit Fisik (Kolom H-P: Deep Astro Teal)
  sheet.getRange(1, 8, 1, 9)
    .setBackground('#0F766E')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  // 6. GARIS TABEL & ALIGNMENT DATA (Baris 2 - 100)
  var dataRange = sheet.getRange(2, 1, 99, 16);
  dataRange
    .setFontSize(10)
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#E2E8F0', SpreadsheetApp.BorderStyle.SOLID);

  // Alignment per kolom
  sheet.getRange('A2:A100').setHorizontalAlignment('center');
  sheet.getRange('B2:B100').setHorizontalAlignment('center');
  sheet.getRange('C2:C100').setHorizontalAlignment('center').setNumberFormat('@');
  sheet.getRange('D2:D100').setHorizontalAlignment('left');
  sheet.getRange('E2:E100').setHorizontalAlignment('center');
  sheet.getRange('F2:F100').setHorizontalAlignment('center');
  sheet.getRange('G2:G100').setHorizontalAlignment('center');
  sheet.getRange('H2:K100').setHorizontalAlignment('center');
  sheet.getRange('L2:M100').setHorizontalAlignment('center');
  sheet.getRange('N2:O100').setHorizontalAlignment('center');
  sheet.getRange('P2:P100').setHorizontalAlignment('left');

  // 7. DROPDOWN SHIFT (KOLOM B)
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Shift 1 (Pagi)', 'Shift 2 (Siang)'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('B2:B100').setDataValidation(rule);

  // 8. CONDITIONAL FORMATTING (WARNA OTOMATIS)
  var rules = [];

  // Status DONE (Hijau Lembut)
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('DONE')
    .setBackground('#DCFCE7')
    .setFontColor('#166534')
    .setBold(true)
    .setRanges([sheet.getRange('O2:O100')])
    .build());

  // Status PENDING (Kuning Lembut)
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('PENDING')
    .setBackground('#FEF3C7')
    .setFontColor('#92400E')
    .setBold(true)
    .setRanges([sheet.getRange('O2:O100')])
    .build());

  // SLOC MATCH (Hijau Lembut)
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('MATCH')
    .setBackground('#DCFCE7')
    .setFontColor('#166534')
    .setBold(true)
    .setRanges([sheet.getRange('M2:M100')])
    .build());

  // SLOC UNMATCH (Merah Lembut)
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('UNMATCH')
    .setBackground('#FEE2E2')
    .setFontColor('#991B1B')
    .setBold(true)
    .setRanges([sheet.getRange('M2:M100')])
    .build());

  // SELISIH ADA BEDA (Bukan 0) -> Merah
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberNotEqualTo(0)
    .setBackground('#FEE2E2')
    .setFontColor('#991B1B')
    .setBold(true)
    .setRanges([sheet.getRange('K2:K100')])
    .build());

  sheet.setConditionalFormatRules(rules);

  // Pasang langsung rumus otomatis
  installDccMainlistFormulas(true);

  alertUser('✨ Sukses!\n\nTampilan sheet "Mainlist SKU" berhasil dirapikan secara profesional & rumus otomatis telah aktif.');
}

// ==============================================================================
// ⚡ PASANG RUMUS OTOMATIS: SHEET "Mainlist SKU"
// ==============================================================================
function installDccMainlistFormulas(isSilent) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) {
    if (!isSilent) alertUser('❌ Sheet "Mainlist SKU" tidak ditemukan.');
    return;
  }

  // 1. Detail Produk dari 'STOCK UPDATE' (Kolom D - G)
  // MAP LAMBDA memastikan evaluasi akurat per baris untuk tipe Angka maupun Teks
  sheet.getRange('D2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!E:E), IFERROR(XLOOKUP(TRIM(sku), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!E:E), \"\")))))");
  sheet.getRange('E2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!D:D), IFERROR(XLOOKUP(TRIM(sku), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!D:D), \"\")))))");
  sheet.getRange('F2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!F:F), IFERROR(XLOOKUP(TRIM(sku), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!F:F), 0)))))");
  sheet.getRange('G2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!J:J), IFERROR(XLOOKUP(TRIM(sku), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!J:J), \"-\")))))");

  // 2. Hasil Audit dari 'Hasil DCC' (Kolom H - P)
  // XLOOKUP search_mode = -1 mengambil audit paling terbaru untuk SKU tersebut
  sheet.getRange('H2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(TRIM(sku), 'Hasil DCC'!B:B, 'Hasil DCC'!G:G, \"\", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'Hasil DCC'!B:B, 'Hasil DCC'!G:G, \"\", 0, -1), \"\")))))");
  sheet.getRange('I2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(TRIM(sku), 'Hasil DCC'!B:B, 'Hasil DCC'!H:H, \"\", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'Hasil DCC'!B:B, 'Hasil DCC'!H:H, \"\", 0, -1), \"\")))))");
  sheet.getRange('J2').setFormula("=ARRAYFORMULA(IF(C2:C=\"\", \"\", IF((H2:H=\"\")*(I2:I=\"\"), \"\", N(H2:H) + N(I2:I))))");
  sheet.getRange('K2').setFormula("=ARRAYFORMULA(IF(C2:C=\"\", \"\", IF(J2:J=\"\", \"\", N(J2:J) - N(F2:F))))");
  sheet.getRange('L2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(TRIM(sku), 'Hasil DCC'!B:B, 'Hasil DCC'!E:E, \"\", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'Hasil DCC'!B:B, 'Hasil DCC'!E:E, \"\", 0, -1), \"\")))))");
  sheet.getRange('M2').setFormula("=ARRAYFORMULA(IF(C2:C=\"\", \"\", IF(L2:L=\"\", \"\", IF(EXACT(UPPER(TRIM(E2:E)), UPPER(TRIM(L2:L))), \"MATCH\", \"UNMATCH\"))))");
  sheet.getRange('N2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(TRIM(sku), 'Hasil DCC'!B:B, 'Hasil DCC'!S:S, \"\", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'Hasil DCC'!B:B, 'Hasil DCC'!S:S, \"\", 0, -1), \"\")))))");
  sheet.getRange('O2').setFormula("=ARRAYFORMULA(IF(C2:C=\"\", \"\", IF(L2:L<>\"\", \"DONE\", \"PENDING\")))");
  sheet.getRange('P2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(TRIM(sku), 'Hasil DCC'!B:B, 'Hasil DCC'!K:K, \"\", 0, -1), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'Hasil DCC'!B:B, 'Hasil DCC'!K:K, \"\", 0, -1), \"\")))))");

  if (!isSilent) {
    alertUser('✅ Berhasil memasang rumus otomatis di "Mainlist SKU"!\n\nSemua data dari "STOCK UPDATE" dan "Hasil DCC" kini tersinkronisasi secara real-time.');
  }
}

// ==============================================================================
// 📋 TARIK DETAIL SKU DARI "STOCK UPDATE" (OPSI HARD VALUES)
// ==============================================================================
function syncDetailSkuMainlist() {
  var ss = getSpreadsheet();
  var mainSheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  var stockSheet = ss.getSheetByName('STOCK UPDATE');

  if (!mainSheet || !stockSheet) {
    return alertUser("❌ Sheet 'Mainlist SKU' atau 'STOCK UPDATE' tidak ditemukan.");
  }

  var lastRow = mainSheet.getLastRow();
  if (lastRow < 2) return alertUser("⚠️ Tidak ada SKU di 'Mainlist SKU'.");

  // Load stock update map
  var stockData = stockSheet.getDataRange().getValues();
  if (stockData.length < 2) return alertUser("⚠️ Sheet 'STOCK UPDATE' kosong.");

  var stockMap = {};
  for (var s = 1; s < stockData.length; s++) {
    var skuKey = String(stockData[s][2] || '').trim(); // Col C: SKU
    if (skuKey) {
      stockMap[skuKey.toLowerCase()] = {
        name: stockData[s][4] || '',    // Col E: Nama
        sloc: stockData[s][3] || '',    // Col D: Rack / Sloc
        qty: stockData[s][5] !== '' ? stockData[s][5] : 0, // Col F: Qty
        type: stockData[s][9] || ''     // Col J: Type
      };
    }
  }

  // Loop SKU di Mainlist
  var skuRange = mainSheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var updatedCount = 0;

  for (var i = 0; i < skuRange.length; i++) {
    var curSku = String(skuRange[i][0] || '').trim().toLowerCase();
    if (curSku && stockMap[curSku]) {
      var rowIdx = i + 2;
      var item = stockMap[curSku];
      mainSheet.getRange(rowIdx, 4).setValue(item.name);
      mainSheet.getRange(rowIdx, 5).setValue(item.sloc);
      mainSheet.getRange(rowIdx, 6).setValue(item.qty);
      mainSheet.getRange(rowIdx, 7).setValue(item.type);
      updatedCount++;
    }
  }

  alertUser("✅ Berhasil menarik detail untuk " + updatedCount + " SKU dari 'STOCK UPDATE'.");
}

// ==============================================================================
// 🔄 KOSONGKAN / RESET SHEET "Mainlist SKU"
// ==============================================================================
function resetMainlistSkuPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'Konfirmasi Reset "Mainlist SKU"',
    'Apakah Anda yakin ingin mengosongkan sheet "Mainlist SKU" untuk sesi tugas berikutnya?\n\n(Catatan: Header dan format tabel akan tetap terjaga).',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 16).clearContent();
  }

  // Pasang ulang rumus otomatis di baris 2
  installDccMainlistFormulas(true);

  alertUser('✅ Sheet "Mainlist SKU" telah bersih dan siap untuk penugasan baru!');
}

// ==============================================================================
// 📦 BACKUP DCC KE HISTORICAL DATA (KOLOM G TERISI)
// ==============================================================================
function copyDccToHistorical() {
  var ss = getSpreadsheet();
  var source = ss.getSheetByName("Hasil DCC");
  var target = ss.getSheetByName("Historical Data") || ss.insertSheet("Historical Data");

  if (!source) {
    return alertUser("❌ Sheet 'Hasil DCC' tidak ditemukan.");
  }

  var data = source.getDataRange().getValues();

  if (data.length <= 1) {
    return alertUser("⚠️ Tidak ada data di 'Hasil DCC'.");
  }

  var headers = data[0];

  // Filter hanya baris yang Kolom G (Fisik Good / index 6) terisi
  var filteredRows = data.slice(1).filter(function(row) {
    return (row[6] !== "" && row[6] !== null);
  });

  if (filteredRows.length === 0) {
    return alertUser("⚠️ Tidak ada data dengan Kolom G terisi untuk di-backup.");
  }

  // Jika sheet Historical Data masih kosong, buatkan header + kolom timestamp
  if (target.getLastRow() === 0) {
    target.appendRow(headers.concat(["BACKUP_TIME"]));
    target.getRange(1, 1, 1, headers.length + 1).setFontWeight("bold");
  }

  var now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  var rows = filteredRows.map(function(r) {
    return r.concat([now]);
  });

  // Cari baris kosong pertama di paling bawah
  var targetRow = target.getLastRow() + 1;

  target.getRange(
    targetRow,
    1,
    rows.length,
    rows[0].length
  ).setValues(rows);

  alertUser("✅ Backup DCC berhasil ditambahkan ke sheet 'Historical Data' pada baris " + targetRow + "!\nTotal: " + rows.length + " baris data.");
}

// ==============================================================================
// 📸 GENERATE EVIDENCE LINKS (DRIVE FOLDER KE SPREADSHEET)
// ==============================================================================
function generateEvidenceLinksDCC() {
  var folderId = CONFIG.EVIDENCE_FOLDER_ID || "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3";
  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    return alertUser("❌ Gagal mengakses Google Drive Folder ID: " + folderId + "\n\nPastikan ID folder benar dan akun memiliki akses ke folder tersebut.");
  }

  var ss = getSpreadsheet();
  var sheetsToProcess = ["Hasil DCC", "DCC SK", "Historical Data"];
  var totalGenerated = 0;

  sheetsToProcess.forEach(function(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    for (var row = 2; row <= lastRow; row++) {
      // 1. Cek Kolom 12 (Evidance 1) -> Tulis link ke Kolom 14 (Evidance Link 1)
      var file1Val = sheet.getRange(row, 12).getValue();
      var link1Val = sheet.getRange(row, 14).getValue();
      if (file1Val && (!link1Val || String(link1Val).indexOf("http") === -1)) {
        var fName1 = file1Val.toString().split("/").pop().trim();
        var files1 = folder.getFilesByName(fName1);
        if (files1.hasNext()) {
          var f1 = files1.next();
          f1.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          sheet.getRange(row, 14).setValue(f1.getUrl());
          totalGenerated++;
        } else {
          sheet.getRange(row, 14).setValue("NOT FOUND: " + fName1);
        }
      }

      // 2. Cek Kolom 13 (Evidance 2) -> Tulis link ke Kolom 15 (Evidance Link 2)
      var file2Val = sheet.getRange(row, 13).getValue();
      var link2Val = sheet.getRange(row, 15).getValue();
      if (file2Val && (!link2Val || String(link2Val).indexOf("http") === -1)) {
        var fName2 = file2Val.toString().split("/").pop().trim();
        var files2 = folder.getFilesByName(fName2);
        if (files2.hasNext()) {
          var f2 = files2.next();
          f2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          sheet.getRange(row, 15).setValue(f2.getUrl());
          totalGenerated++;
        } else {
          sheet.getRange(row, 15).setValue("NOT FOUND: " + fName2);
        }
      }

      // 3. Format lama sheet "DCC SK": Kolom 14 berisi path -> Tulis link ke Kolom 15
      if (sheetName === "DCC SK") {
        var pathK = sheet.getRange(row, 14).getValue();
        var linkColM = sheet.getRange(row, 15).getValue();
        if (pathK && (!linkColM || String(linkColM).indexOf("http") === -1)) {
          var fileNameK = pathK.toString().split("/").pop().trim();
          var filesK = folder.getFilesByName(fileNameK);
          if (filesK.hasNext()) {
            var fileK = filesK.next();
            fileK.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            sheet.getRange(row, 15).setValue(fileK.getUrl());
            totalGenerated++;
          } else {
            sheet.getRange(row, 15).setValue("NOT FOUND: " + fileNameK);
          }
        }
      }
    }
  });

  alertUser("✅ Selesai Sinkronisasi Bukti Foto!\n\nFolder Target: " + folder.getName() + " (" + folderId + ")\nTotal: " + totalGenerated + " link foto Google Drive berhasil diperbarui.");
}

// ==============================================================================
// 🗑️ CLEAR SHEET "Hasil DCC"
// ==============================================================================
function hapus() {
  var ui = SpreadsheetApp.getUi();

  if (ui.alert("Konfirmasi", "Apakah Anda yakin ingin membersihkan data di sheet 'Hasil DCC'?", ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    return;
  }

  var sheet = getSpreadsheet().getSheetByName("Hasil DCC");

  if (!sheet) {
    return ui.alert("❌ Sheet 'Hasil DCC' tidak ditemukan.");
  }

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return ui.alert("⚠️ Data sheet 'Hasil DCC' sudah kosong.");
  }

  var columnsToClear = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
  ];

  columnsToClear.forEach(function(col) {
    sheet.getRange(2, col, lastRow - 1, 1).clearContent();
  });

  ui.alert("✅ Sheet 'Hasil DCC' berhasil dibersihkan!");
}

// ==============================================================================
// 🧹 MENGHAPUS BARIS KOSONG DI HISTORICAL DATA
// ==============================================================================
function bersihkanBarisKosong() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("Historical Data");
  
  if (!sheet) return alertUser("❌ Sheet 'Historical Data' tidak ditemukan.");
  
  var colAValues = sheet.getRange("A:A").getValues();
  var lastRealRow = 0;
  
  for (var i = colAValues.length - 1; i >= 0; i--) {
    if (colAValues[i][0] !== "" && colAValues[i][0] !== null) {
      lastRealRow = i + 1;
      break;
    }
  }
  
  var maxRows = sheet.getMaxRows();
  var rowsToDelete = maxRows - lastRealRow;
  
  if (rowsToDelete > 0) {
    sheet.deleteRows(lastRealRow + 1, rowsToDelete);
    alertUser("✅ Berhasil menghapus " + rowsToDelete + " baris kosong!\nData kini rapi hingga baris ke-" + lastRealRow + ".");
  } else {
    alertUser("ℹ️ Tidak ada baris kosong berlebih di 'Historical Data'.");
  }
}

// ==============================================================================
// 🔑 SET COOKIE & PANDUAN DEPLOY
// ==============================================================================
function setSupersetCookiePrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
    '🔑 Set Cookie Superset Astrodash',
    'Paste Cookie Superset terbaru Anda di bawah ini:\n(Ambil dari DevTools F12 ➔ Network ➔ Cari request ➔ Copy nilai Cookie):',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var cookieVal = response.getResponseText().trim();
    if (!cookieVal) {
      ui.alert('⚠️ Cookie tidak boleh kosong!');
      return;
    }
    PropertiesService.getScriptProperties().setProperty('MY_COOKIE', cookieVal);
    ui.alert('✅ Cookie Superset berhasil diperbarui!\n\nSekarang Anda dapat menjalankan menu "🚀 Update Semua Data".');
  }
}

// ==============================================================================
// 📥 ASSIGN TUGAS BARU (POPUP DIALOG PASTE SKU UNTUK SUPERVISOR)
// ==============================================================================
function assignDccTaskPrompt() {
  var ui = SpreadsheetApp.getUi();

  // 1. Pilih Shift
  var shiftResp = ui.alert(
    'Pilih Shift Penugasan DCC',
    'Apakah tugas ini untuk SHIFT 1 (Pagi)?\n\n- Klik YES = Shift 1 (Pagi)\n- Klik NO = Shift 2 (Siang)',
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (shiftResp === ui.Button.CANCEL) return;
  var shiftLabel = (shiftResp === ui.Button.YES) ? 'Shift 1 (Pagi)' : 'Shift 2 (Siang)';

  // 2. Input Box untuk Paste Daftar SKU
  var skuPrompt = ui.prompt(
    '📥 Assign Tugas DCC (' + shiftLabel + ')',
    'Silakan Paste daftar nomor SKU di bawah ini:\n(Bisa copas dari Excel/kolom, pisahkan baris/enter/koma):',
    ui.ButtonSet.OK_CANCEL
  );

  if (skuPrompt.getSelectedButton() !== ui.Button.OK) return;

  var skuText = skuPrompt.getResponseText();
  if (!skuText || !skuText.trim()) {
    ui.alert('⚠️ Peringatan', 'Tidak ada SKU yang dimasukkan!', ui.ButtonSet.OK);
    return;
  }

  // Parsing SKU: split berdasarkan spasi, newline, tab, koma, titik-koma, atau pipe
  var rawSkus = skuText.trim().split(/[\s,;|]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
  var skus = [];
  var seen = {};
  for (var k = 0; k < rawSkus.length; k++) {
    var sk = rawSkus[k];
    if (!seen[sk]) {
      seen[sk] = true;
      skus.push(sk);
    }
  }

  if (skus.length === 0) {
    ui.alert('⚠️ Peringatan', 'Format SKU tidak valid!', ui.ButtonSet.OK);
    return;
  }

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) {
    ui.alert('❌ Error', 'Sheet "Mainlist SKU" tidak ditemukan!', ui.ButtonSet.OK);
    return;
  }

  // Cari baris kosong pertama di Kolom C (SKU)
  var data = sheet.getRange('C2:C1000').getValues();
  var nextRow = 2;
  for (var i = 0; i < data.length; i++) {
    if (!data[i][0] || data[i][0].toString().trim() === '') {
      nextRow = i + 2;
      break;
    }
  }

  var todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
  var rowsToAdd = [];
  for (var j = 0; j < skus.length; j++) {
    rowsToAdd.push([todayStr, shiftLabel, String(skus[j]).trim()]);
  }

  // Tulis Tanggal (Col A), Shift (Col B), SKU (Col C)
  sheet.getRange(nextRow, 1, rowsToAdd.length, 3).setValues(rowsToAdd);
  sheet.getRange(nextRow, 3, rowsToAdd.length, 1).setNumberFormat('@');

  // Pastikan tinggi baris rapi
  for (var r = nextRow; r < nextRow + rowsToAdd.length; r++) {
    sheet.setRowHeight(r, 28);
  }

  // Pastikan rumus otomatis terpasang
  installDccMainlistFormulas(true);

  ui.alert(
    '✅ Berhasil Assign Tugas!',
    'Berhasil menambahkan ' + rowsToAdd.length + ' SKU untuk ' + shiftLabel + ' mulai baris ' + nextRow + '.\n\nDetail nama produk, lokasi rak, qty sistem, dan status PENDING sudah otomatis terisi!',
    ui.ButtonSet.OK
  );
}

// ==============================================================================
// 🔧 PERBAIKI SKU MENUMPUK DI CELL C (AUTO SPLIT KE BARIS-BARIS)
// ==============================================================================
function fixClumpedSkuRows() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) {
    alertUser('❌ Sheet "Mainlist SKU" tidak ditemukan.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    alertUser('⚠️ Tidak ada data di sheet "Mainlist SKU".');
    return;
  }

  var rangeValues = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // Col A (Date), B (Shift), C (SKU)
  var newRows = [];
  var hasClumped = false;

  for (var i = 0; i < rangeValues.length; i++) {
    var dateVal = rangeValues[i][0] || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
    var shiftVal = rangeValues[i][1] || 'Shift 1 (Pagi)';
    var skuRaw = String(rangeValues[i][2] || '').trim();

    if (!skuRaw) continue;

    // Cek apakah cell ini berisi banyak SKU (terpisah spasi / koma / titik koma)
    var parts = skuRaw.split(/[\s,;|]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    if (parts.length > 1) {
      hasClumped = true;
      for (var p = 0; p < parts.length; p++) {
        newRows.push([dateVal, shiftVal, parts[p]]);
      }
    } else {
      newRows.push([dateVal, shiftVal, skuRaw]);
    }
  }

  if (!hasClumped) {
    alertUser('ℹ️ Semua SKU sudah berada di barisnya masing-masing secara rapi.');
    return;
  }

  // Bersihkan kolom A, B, C lama
  sheet.getRange(2, 1, Math.max(lastRow - 1, newRows.length), 3).clearContent();

  // Tulis baris-baris baru yang sudah terpecah rapi
  sheet.getRange(2, 1, newRows.length, 3).setValues(newRows);
  sheet.getRange(2, 3, newRows.length, 1).setNumberFormat('@');

  // Pastikan tinggi baris rapi
  for (var r = 2; r <= newRows.length + 1; r++) {
    sheet.setRowHeight(r, 28);
  }

  // Pasang ulang rumus otomatis agar langsung menarik data dari STOCK UPDATE
  installDccMainlistFormulas(true);

  alertUser('✅ Berhasil Memperbaiki SKU Menumpuk!\n\n' + newRows.length + ' SKU kini telah dipecah menjadi baris-baris terpisah secara rapi.\nNama Produk, Lokasi Rak, Qty Sistem, dan Status PENDING sudah langsung muncul!');
}

// ==============================================================================
// ⚡ AUTO-SPLIT ON EDIT: JIKA USER PASTE LANGSUNG KE CELL DI KOLOM C
// ==============================================================================
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var sheetName = sheet.getName();
    if (sheetName !== 'Mainlist SKU' && sheetName !== 'Mainlist Sku') return;

    var col = e.range.getColumn();
    var row = e.range.getRow();

    // Jika diedit di Kolom C (SKU) dan bukan baris header
    if (col === 3 && row >= 2) {
      var val = String(e.value || e.range.getValue() || '').trim();
      if (!val) return;

      var parts = val.split(/[\s,;|]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      if (parts.length > 1) {
        var dateVal = sheet.getRange(row, 1).getValue() || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
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
        installDccMainlistFormulas(true);
      }
    }
  } catch (errEdit) {
    console.warn("onEdit auto-split error:", errEdit);
  }
}

// =============================
// 🔔 UTIL
// =============================
function alertUser(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // Aman saat dipanggil dari Pemicu Waktu (Time-driven Trigger / Background tanpa UI)
    Logger.log("[AUTO-SYNC / TRIGGER] " + msg);
    console.log("[AUTO-SYNC / TRIGGER] " + msg);
    try {
      var ss = getSpreadsheet();
      if (ss && typeof ss.toast === "function") {
        ss.toast(String(msg).split("\n")[0], "DCC / Superset Auto-Sync", 5);
      }
    } catch (errToast) {}
  }
}

/**
 * Fallback handler untuk ED Correction submit ke Backup ED Corection
 */
function handleEdCorrectionSubmitDccFallback(payload) {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName('Hasil ED Correction') || 
                ss.getSheetByName('Hasil ED Corection') || 
                ss.getSheetByName('Hasil EDC') || 
                ss.getSheetByName('Backup ED Corection') || 
                ss.getSheetByName('Backup Data ED Correction');

    if (!sheet) {
      sheet = ss.insertSheet('Hasil ED Correction');
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
    var timestamp = Utilities.formatDate(now, CONFIG.TIMEZONE || "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");

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

    var rowData = [
      timestamp, sku, productName, rackSystem, rackActual,
      rackMatch, edSystem, edActual, edStatus,
      fisikGood, fisikBad, totalFisik, selisih, petugas, shift,
      photoUrl, remarks
    ];

    sheet.appendRow(rowData);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Data koreksi ED berhasil disimpan di Backup ED Corection!",
      sku: sku,
      timestamp: timestamp
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: "Gagal menyimpan data EDC: " + err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

