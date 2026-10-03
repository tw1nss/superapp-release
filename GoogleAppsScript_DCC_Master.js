/**
 * =========================================================================
 * 🚀 FINAL COMBINED SCRIPT: DCC MASTER ALL-IN-ONE (CARA 2) + SUPERSET + API + PINJAMAN MTG
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
 * 4. 📦 PINJAMAN & PENGEMBALIAN BARANG MTG:
 *    - Form Peminjaman Barang MTG -> Sheet 'Pinjaman Barang MTG' (8 Kolom)
 *    - Form Pengembalian Barang MTG -> Sheet 'Pengembalian Barang MTG' (10 Kolom + Bukti Foto Drive)
 *
 * 5. 📦 BACKUP & MAINTENANCE:
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
  EVIDENCE_FOLDER_ID: "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3", // 📁 Folder Google Drive Bukti Foto DCC & Pinjaman
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
  buildPinjamanMenu(ui);
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
    .addItem('📥 Assign Tugas Baru (Multi-SKU Modal)', 'assignDccTaskPrompt')
    .addSeparator()
    .addItem('📦 Backup DCC ke Historical', 'copyDccToHistorical')
    .addItem('🗑️ Clear Kolom Sheet "Hasil DCC"', 'hapus')
    .addItem('🔄 Kosongkan / Reset "Mainlist SKU"', 'resetMainlistSkuPrompt')
    .addToUi();
}

function buildPinjamanMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Pinjaman MTG')
    .addItem('📋 Siapkan Format Sheet Pinjaman & Pengembalian', 'setupPinjamanSheets')
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

    // Router jika request adalah auto-complete Perbaiki Rumus ED
    if (payload.action === 'autoFillEdCorrection' || payload.action === 'perbaikiRumusEd') {
      if (typeof executeAutoFillEdCorrectionTask === 'function') {
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
    }

    // Router jika request adalah audit ED Correction
    if (payload.action === 'saveEdCorrectionResult' || payload.module === 'ed_correction' || payload.module === 'edc') {
      if (typeof handleEdCorrectionSubmit === 'function') {
        return handleEdCorrectionSubmit(payload);
      }
      return handleEdCorrectionSubmitDccFallback(payload);
    }

    // Router jika request adalah Pinjaman / Pengembalian Barang MTG
    if (payload.action === 'savePinjamanBarang' || payload.action === 'savePengembalianBarang' || payload.module === 'pinjaman') {
      return handlePinjamanSubmit(payload);
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
  var props = PropertiesService.getScriptProperties();

  // Dukungan kustom form_data_key & chart ID untuk RACK UPDATE (SLOC MASTER)
  var rackFormDataKey = props.getProperty('RACK_UPDATE_FORM_DATA_KEY') || "";
  var rackPageId = props.getProperty('RACK_UPDATE_PAGE_ID') || "";
  var rackCustomChartId = props.getProperty('RACK_UPDATE_CHART_ID');
  var effectiveChartId = (sheetName === 'RACK UPDATE' && rackCustomChartId) ? Number(rackCustomChartId) : chartId;

  var formDataKey = (effectiveChartId === 12077) 
    ? "FGnMPSQjzn-IkTT_ZdewtmeAw3D7uPCz56ErrkOHEZT-KyQ5BLwbb8-QXzzmQpaL" 
    : ((sheetName === 'RACK UPDATE' && rackFormDataKey) ? rackFormDataKey : "");

  var pageId = (effectiveChartId === 12077) 
    ? "OuCI-jVWZVevhI7VLi-Uh" 
    : ((sheetName === 'RACK UPDATE' && rackPageId) ? rackPageId : "");

  var urlVariants = [];
  if (formDataKey) {
    urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + "&slice_id=" + effectiveChartId + "&force=true&_t=" + timestamp);
    urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + "&force=true&_t=" + timestamp);
  }
  urlVariants.push(CONFIG.BASE_URL + "api/v1/chart/" + effectiveChartId + "/data?force=true&_t=" + timestamp);
  if (pageId) {
    urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({ slice_id: Number(effectiveChartId), dashboard_page_id: pageId })) + "&force=true&_t=" + timestamp);
  }
  urlVariants.push(CONFIG.BASE_URL + "superset/explore_json/?form_data={\"slice_id\":" + effectiveChartId + "}&force=true&_t=" + timestamp);

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

  // FIX KHUSUS ED CORRECTION / SUPERSET: Jika ada qr_code (SKU;DDMMYYYY) dan belum ada kolom sku_number, buat kolom sku_number otomatis
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
  // Kolom E (Lokasi Rak): Prioritaskan data rak terbaru dari 'RACK UPDATE' (Kolom C: SKU, Kolom F: Rack Name), fallback ke 'STOCK UPDATE'
  sheet.getRange('E2').setFormula("=MAP(C2:C, LAMBDA(sku, IF(sku=\"\", \"\", IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'RACK UPDATE'!C:C, 'RACK UPDATE'!F:F), IFERROR(XLOOKUP(TRIM(sku), 'RACK UPDATE'!C:C, 'RACK UPDATE'!F:F), IFERROR(XLOOKUP(VALUE(TRIM(sku)), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!D:D), IFERROR(XLOOKUP(TRIM(sku), 'STOCK UPDATE'!C:C, 'STOCK UPDATE'!D:D), \"\")))))))");
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
    alertUser('✅ Berhasil memasang rumus otomatis di "Mainlist SKU"!\n\nSemua data dari "RACK UPDATE", "STOCK UPDATE" dan "Hasil DCC" kini tersinkronisasi secara real-time.');
  }
}

// ==============================================================================
// 📋 TARIK DETAIL SKU DARI "STOCK UPDATE" & "RACK UPDATE" (OPSI HARD VALUES)
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

  // Sinkronkan lokasi rak terbaru dari 'RACK UPDATE' jika sheet tersedia
  var rackSheet = ss.getSheetByName('RACK UPDATE');
  if (rackSheet) {
    var rackData = rackSheet.getDataRange().getValues();
    for (var r = 1; r < rackData.length; r++) {
      var rSku = String(rackData[r][2] || '').trim().toLowerCase(); // Col C: SKU
      var rSloc = String(rackData[r][5] || '').trim();              // Col F: Rack Name
      if (rSku && rSloc && stockMap[rSku]) {
        stockMap[rSku].sloc = rSloc;
      }
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
// ⚙️ SET URL / SLICE ID CHART "SLOC MASTER" (RACK UPDATE)
// ==============================================================================
function setRackUpdateChartPrompt() {
  var ui = SpreadsheetApp.getUi();
  var currentKey = PropertiesService.getScriptProperties().getProperty('RACK_UPDATE_FORM_DATA_KEY') || '';
  var currentId = PropertiesService.getScriptProperties().getProperty('RACK_UPDATE_CHART_ID') || '12422';

  var response = ui.prompt(
    '⚙️ Set URL / Slice ID "SLOC MASTER" (RACK UPDATE)',
    'Paste URL Explore dari dash.astronauts.id atau form_data_key atau Slice ID chart SLOC MASTER:\n' +
    '(Contoh: https://dash.astronauts.id/explore/?form_data_key=EOF6Xz2Hw... atau masukkan angka slice_id)\n\n' +
    'Pengaturan Saat Ini:\n- Chart ID: ' + currentId + '\n- Form Data Key: ' + (currentKey ? (currentKey.substring(0, 25) + '...') : '(Default Chart 12422)'),
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var input = response.getResponseText().trim();
    if (!input) {
      ui.alert('⚠️ Input tidak boleh kosong.');
      return;
    }

    var props = PropertiesService.getScriptProperties();
    // Cek jika input adalah URL Superset
    if (input.indexOf('dash.astronauts.id') !== -1 || input.indexOf('form_data_key=') !== -1 || input.indexOf('slice_id=') !== -1) {
      var keyMatch = input.match(/form_data_key=([a-zA-Z0-9_\-]+)/);
      var sliceMatch = input.match(/slice_id=(\d+)/);
      var pageMatch = input.match(/dashboard_page_id=([a-zA-Z0-9_\-]+)/);

      if (keyMatch && keyMatch[1]) {
        props.setProperty('RACK_UPDATE_FORM_DATA_KEY', keyMatch[1]);
      }
      if (sliceMatch && sliceMatch[1]) {
        props.setProperty('RACK_UPDATE_CHART_ID', sliceMatch[1]);
      }
      if (pageMatch && pageMatch[1]) {
        props.setProperty('RACK_UPDATE_PAGE_ID', pageMatch[1]);
      }
      ui.alert('✅ Konfigurasi RACK UPDATE (SLOC MASTER) berhasil disimpan!\n\nKey: ' + (keyMatch ? keyMatch[1] : '-') + '\nSlice ID: ' + (sliceMatch ? sliceMatch[1] : currentId));
    } else if (/^\d+$/.test(input)) {
      props.setProperty('RACK_UPDATE_CHART_ID', input);
      ui.alert('✅ Chart ID RACK UPDATE berhasil diset ke: ' + input);
    } else {
      props.setProperty('RACK_UPDATE_FORM_DATA_KEY', input);
      ui.alert('✅ form_data_key RACK UPDATE berhasil disimpan!');
    }
  }
}

// ==============================================================================
// 📥 ASSIGN TUGAS BARU (POPUP DIALOG PASTE SKU UNTUK SUPERVISOR)
// ==============================================================================
/**
 * Parsing cerdas list SKU untuk DCC:
 * - Mendukung paste vertikal (enter), koma, spasi, titik koma
 * - Mendukung copas tabel multi-kolom dari Excel/Google Sheets
 * - Mendukung format QR Code (SKU;DDMMYYYY)
 * - Menyaring header dan format tanggal
 * - Menjaga leading zeros dan mencegah duplikasi
 */
function parseDccSkuInput(rawText) {
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
      var cols = line.split('\t').map(function(c) { return c.trim(); }).filter(function(c) { return c.length > 0; });
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

    // Case 2: Multi-SKU pada baris yang sama
    var tokens = line.split(/[\s,\|]+/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (tok.indexOf(';') !== -1) {
        var parts = tok.split(';').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
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
 */
function assignDccTaskPrompt() {
  try {
    showAssignDccTaskDialog();
  } catch (err) {
    Logger.log('Gagal membuka modal dialog DCC, beralih ke prompt cepat: ' + err);
    assignDccTaskQuickPrompt();
  }
}

/**
 * Menampilkan Modal Dialog HTML Multi-SKU untuk DCC
 */
function showAssignDccTaskDialog() {
  var html = HtmlService.createHtmlOutput(getAssignTaskDialogHtmlDcc())
    .setWidth(520)
    .setHeight(570)
    .setTitle('📥 Assign Tugas DCC');
  SpreadsheetApp.getUi().showModalDialog(html, '📥 Assign Tugas DCC');
}

/**
 * Eksekutor backend penugasan SKU DCC
 */
function executeAssignDccTask(shiftLabel, assignDate, rawSkuText) {
  var skus = parseDccSkuInput(rawSkuText);

  if (!skus || skus.length === 0) {
    return {
      success: false,
      message: 'Tidak ada SKU valid yang ditemukan.'
    };
  }

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
  if (!sheet) {
    return {
      success: false,
      message: 'Sheet "Mainlist SKU" tidak ditemukan!'
    };
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

  var todayStr = assignDate || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
  var shiftText = shiftLabel || 'Shift 1 (Pagi)';
  var rowsToAdd = [];
  for (var j = 0; j < skus.length; j++) {
    rowsToAdd.push([todayStr, shiftText, String(skus[j]).trim()]);
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

  return {
    success: true,
    count: skus.length,
    startRow: nextRow,
    sheetName: sheet.getName(),
    shift: shiftText,
    date: todayStr,
    skus: skus
  };
}

/**
 * Prompt fallback cepat jika supervisor berada di perangkat tanpa modal dialog
 */
function assignDccTaskQuickPrompt() {
  var ui = SpreadsheetApp.getUi();

  var shiftResp = ui.alert(
    'Pilih Shift Penugasan DCC',
    'Apakah tugas ini untuk SHIFT 1 (Pagi)?\n\n- Klik YES = Shift 1 (Pagi)\n- Klik NO = Shift 2 (Siang)',
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (shiftResp === ui.Button.CANCEL) return;
  var shiftLabel = (shiftResp === ui.Button.YES) ? 'Shift 1 (Pagi)' : 'Shift 2 (Siang)';

  var skuPrompt = ui.prompt(
    '📥 Assign Tugas DCC (' + shiftLabel + ')',
    'Silakan Paste daftar nomor SKU di bawah ini (pisahkan enter, koma, spasi):',
    ui.ButtonSet.OK_CANCEL
  );

  if (skuPrompt.getSelectedButton() !== ui.Button.OK) return;

  var skuText = skuPrompt.getResponseText();
  if (!skuText || !skuText.trim()) {
    ui.alert('⚠️ Peringatan', 'Tidak ada SKU yang dimasukkan!', ui.ButtonSet.OK);
    return;
  }

  var res = executeAssignDccTask(shiftLabel, null, skuText);
  if (!res.success) {
    ui.alert('⚠️ Peringatan', res.message, ui.ButtonSet.OK);
    return;
  }

  ui.alert(
    '✅ Berhasil Assign Tugas!',
    'Berhasil menambahkan ' + res.count + ' SKU untuk ' + res.shift + ' mulai baris ' + res.startRow + '.\n\nDetail nama produk, lokasi rak, qty sistem, dan status PENDING sudah otomatis terisi!',
    ui.ButtonSet.OK
  );
}

/**
 * HTML UI untuk Modal Dialog Multi-SKU DCC
 */
function getAssignTaskDialogHtmlDcc() {
  var todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');

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
    '        <div class="header-title">Assign Tugas DCC</div>',
    '        <div class="header-sub">Paste banyak SKU sekaligus untuk penugasan shift DCC</div>',
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
    '        <input type="text" id="assignDate" class="input-date" value="' + todayStr + '">',
    '      </div>',
    '    </div>',
    '    <div class="form-group">',
    '      <div class="textarea-header">',
    '        <label class="form-label" style="margin-bottom:0;">Daftar SKU Tugas</label>',
    '        <div class="textarea-actions">',
    '          <a class="text-link" onclick="clearTextarea()">Bersihkan</a>',
    '        </div>',
    '      </div>',
    '      <textarea id="skuInput" class="sku-textarea" placeholder="Paste daftar SKU di sini (bisa dari Excel / Notepad)...\nContoh 1 kolom SKU:\n493711\n493712\n\nAtau copas tabel multi-kolom Excel langsung."></textarea>',
    '      <div class="status-bar">',
    '        <span id="badgeCount" class="badge-count">⚪ Menunggu input SKU...</span>',
    '        <span id="subCount" style="color:#64748b;">0 item</span>',
    '      </div>',
    '      <div id="previewBox" class="preview-box">',
    '        <span class="preview-empty">Preview SKU yang terdeteksi akan muncul di sini...</span>',
    '      </div>',
    '      <div class="tip-box">💡 <em>Mendukung paste dari tabel Excel, format QR (SKU;ED), maupun enter/koma/spasi. Tanggal & header otomatis difilter.</em></div>',
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
    '      <div style="margin-top:6px; color:#10b981; font-weight:600;">✨ Detail nama produk, rak, qty sistem & rumus otomatis sudah aktif!</div>',
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
    '        .executeAssignDccTask(shift, date, raw);',
    '    }',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');

  return html;
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

    var isClumped = (skuRaw.indexOf('\n') !== -1 || skuRaw.indexOf('\r') !== -1 || 
                     skuRaw.indexOf('\t') !== -1 || skuRaw.indexOf(',') !== -1 || 
                     skuRaw.indexOf(';') !== -1 || skuRaw.indexOf(' ') !== -1 ||
                     skuRaw.length > 25);

    if (isClumped) {
      hasClumped = true;
      var extracted = parseDccSkuInput(skuRaw);
      if (extracted.length > 0) {
        for (var p = 0; p < extracted.length; p++) {
          newRows.push([dateVal, shiftVal, extracted[p]]);
        }
      } else {
        newRows.push([dateVal, shiftVal, skuRaw]);
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
    var isDcc = (sheetName === 'Mainlist SKU' || sheetName === 'Mainlist Sku');
    var isEdc = (sheetName === 'Mainlist Sku ED Corection' || sheetName === 'Mainlist Sku ED Correction');
    if (!isDcc && !isEdc) return;

    var col = e.range.getColumn();
    var row = e.range.getRow();

    // Jika diedit di Kolom C (SKU) dan bukan baris header
    if (col === 3 && row >= 2) {
      var val = String(e.value || e.range.getValue() || '').trim();
      if (!val) return;

      var parts = parseDccSkuInput(val);
      if (!parts || parts.length === 0) {
        parts = val.split(/[\s,;|]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      }

      if (parts.length > 1) {
        var todayFormatted = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, isEdc ? 'yyyy-MM-dd' : 'dd/MM/yyyy');
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
        
        if (isDcc && typeof installDccMainlistFormulas === 'function') {
          installDccMainlistFormulas(true);
        } else if (isEdc && typeof installEdCorrectionMainlistFormulas === 'function') {
          installEdCorrectionMainlistFormulas(true);
        }
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

    // Auto update status di Main List jika ada
    try {
      var mainSheet = ss.getSheetByName('Mainlist Sku ED Corection') || 
                      ss.getSheetByName('Main List SKU ED Correction') || 
                      ss.getSheetByName('Main List ED Correction');
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
            break;
          }
        }
      }
    } catch(eMain) {}

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

// ==============================================================================
// 📦 PINJAMAN & PENGEMBALIAN BARANG MTG (4 ALUR LENGKAP)
// ==============================================================================
/**
 * 1. MTG Pinjam ke Hub Lain
 * 2. MTG Kembalikan ke Hub Lain
 * 3. MTG Pinjemin ke Hub Lain (Keluar)
 * 4. MTG Terima Pengembalian dari Hub Lain (Masuk Kembali)
 */
function handlePinjamanSubmit(payload) {
  try {
    var ss = getSpreadsheet();
    var timezone = (CONFIG && CONFIG.TIMEZONE) ? CONFIG.TIMEZONE : "Asia/Jakarta";
    var timestamp = Utilities.formatDate(new Date(), timezone, "dd/MM/yyyy HH:mm:ss");

    var action = String(payload.action || '').trim();
    var formType = String(payload.formType || '').trim();
    var transType = String(payload.type || '').trim();

    // Deteksi 4 Flow Transaksi:
    var isPinjamKeHub = (action === 'savePinjamKeHub' || action === 'savePinjamanBarang' || formType === 'pinjam' || transType === 'pinjam');
    var isKembalikanKeHub = (action === 'saveKembalikanKeHub' || action === 'savePengembalianBarang' || formType === 'kembali' || transType === 'kembali');
    var isPinjeminKeHub = (action === 'savePinjeminKeHub' || formType === 'pinjemin' || transType === 'pinjemin');
    var isTerimaKembali = (action === 'saveTerimaKembali' || formType === 'terima' || transType === 'terima');

    // Default fallback jika tidak ada yang cocok
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
      sheetTargetName = 'Pinjaman Barang MTG';
    } else if (isKembalikanKeHub) {
      jenisLabel = 'MTG Kembalikan ke Hub Lain';
      statusLabel = payload.status || 'DIKEMBALIKAN';
      sheetTargetName = 'Pengembalian Barang MTG';
    } else if (isPinjeminKeHub) {
      jenisLabel = 'MTG Pinjemin ke Hub Lain';
      statusLabel = payload.status || 'DIPINJAMKAN';
      sheetTargetName = 'Pinjaman Barang MTG';
    } else if (isTerimaKembali) {
      jenisLabel = 'MTG Terima Pengembalian dari Hub Lain';
      statusLabel = payload.status || 'DITERIMA KEMBALI';
      sheetTargetName = 'Pengembalian Barang MTG';
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

    // ── UPLOAD FOTO KE GOOGLE DRIVE JIKA ADA EVIDENCE ──
    var drivePhotoUrl = '';
    if (payload.imageBase64) {
      try {
        var folder;
        var folderId = (CONFIG && CONFIG.EVIDENCE_FOLDER_ID) || "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3";
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

    var headerColor = (sheetTargetName === 'Pinjaman Barang MTG') ? '#0284C7' : '#059669';
    var defaultHeaders = (sheetTargetName === 'Pinjaman Barang MTG') ? [
      'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
      'QTY', 'HUB TARGET / ASAL', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
    ] : [
      'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
      'QTY', 'HUB TARGET / ASAL', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
    ];

    writePinjamanRowByHeaders(sheet, defaultHeaders, rowObj, headerColor);

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

/**
 * Helper fleksibel menulis baris Pinjaman sesuai header sheet yang aktif
 */
function writePinjamanRowByHeaders(sheet, headerDefs, rowObj, headerBgColor) {
  // Jika sheet masih kosong
  if (sheet.getLastRow() === 0 || (sheet.getLastRow() === 1 && !sheet.getRange(1, 1).getValue())) {
    sheet.getRange(1, 1, 1, headerDefs.length).setValues([headerDefs]);
    sheet.getRange(1, 1, 1, headerDefs.length)
      .setBackground(headerBgColor || '#0284c7')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
  }

  var curHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headerDefs.length)).getValues()[0];

  // Jika kolom header lama lebih sedikit dari header baru, perbarui baris 1
  if (curHeaders.filter(Boolean).length < headerDefs.length) {
    sheet.getRange(1, 1, 1, headerDefs.length).setValues([headerDefs]);
    sheet.getRange(1, 1, 1, headerDefs.length)
      .setBackground(headerBgColor || '#0284c7')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
    curHeaders = headerDefs;
  }

  var rowArr = [];
  for (var c = 0; c < curHeaders.length; c++) {
    var h = String(curHeaders[c] || '').trim().toUpperCase();
    if (!h) {
      rowArr.push('');
      continue;
    }
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

  appendToFirstEmptyRow(sheet, rowArr);
}

// Helper Setup Header Manual jika dibutuhkan dari Menu Google Sheets
function setupPinjamanSheets() {
  var ss = getSpreadsheet();
  
  // 1. Setup Pinjaman Barang MTG (12 Kolom)
  var pSheet = ss.getSheetByName('Pinjaman Barang MTG') || ss.insertSheet('Pinjaman Barang MTG');
  var headerP = [[
    'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
    'QTY', 'HUB TARGET / ASAL', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
  ]];
  pSheet.getRange(1, 1, 1, 12).setValues(headerP);
  pSheet.getRange(1, 1, 1, 12)
    .setBackground('#0284c7')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  pSheet.setRowHeight(1, 36);
  pSheet.setFrozenRows(1);

  // 2. Setup Pengembalian Barang MTG (13 Kolom)
  var kSheet = ss.getSheetByName('Pengembalian Barang MTG') || ss.insertSheet('Pengembalian Barang MTG');
  var headerK = [[
    'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
    'QTY', 'HUB TARGET / ASAL', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
  ]];
  kSheet.getRange(1, 1, 1, 13).setValues(headerK);
  kSheet.getRange(1, 1, 1, 13)
    .setBackground('#059669')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  kSheet.setRowHeight(1, 36);
  kSheet.setFrozenRows(1);

  alertUser('✅ Berhasil menyiapkan format header untuk sheet "Pinjaman Barang MTG" dan "Pengembalian Barang MTG"!');
}
