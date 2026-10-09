/**
 * =========================================================================
 * 📦 GOOGLE APPS SCRIPT: PINJAMAN & PENGEMBALIAN BARANG CWG (HUB CAWANG) (4 ALUR LENGKAP)
 * =========================================================================
 * Spreadsheet: Dashboard STK CWG 2K26
 * URL: https://docs.google.com/spreadsheets/d/1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ/edit
 *
 * 4 ALUR TRANSAKSI:
 * 1. 📤 MTG Pinjam ke Hub Lain (MTG butuh stok, pinjam dari Hub luar)
 *    -> Dicatat ke Sheet: 'Pinjaman Barang CWG', Status: 'DIPINJAM'
 * 2. 📥 MTG Kembalikan ke Hub Lain (MTG mengembalikan barang pinjaman ke Hub luar)
 *    -> Dicatat ke Sheet: 'Pengembalian Barang CWG', Status: 'DIKEMBALIKAN'
 * 3. 🤝 MTG Pinjemin ke Hub Lain (Hub luar butuh stok, MTG meminjamkan)
 *    -> Dicatat ke Sheet: 'Pinjaman Barang CWG', Status: 'DIPINJAMKAN'
 * 4. 📦 MTG Terima Pengembalian dari Hub Lain (Hub luar kembalikan barang ke MTG)
 *    -> Dicatat ke Sheet: 'Pengembalian Barang CWG', Status: 'DITERIMA KEMBALI'
 *
 * FITUR:
 * - Upload Bukti Foto Produk otomatis ke Google Drive
 * - Mapping kolom dinamis fleksibel sesuai susunan header sheet
 * - Standalone doPost & doGet router
 * =========================================================================
 */

var PINJAMAN_CONFIG = {
  TARGET_FILE_ID: "1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ",
  EVIDENCE_FOLDER_ID: "", // Google Drive Folder Bukti
  TIMEZONE: "Asia/Jakarta"
};

function getPinjamanSpreadsheet() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (eActive) {}

  if (PINJAMAN_CONFIG.TARGET_FILE_ID) {
    try {
      return SpreadsheetApp.openById(PINJAMAN_CONFIG.TARGET_FILE_ID);
    } catch (e) {
      console.warn("Fallback to active spreadsheet:", e);
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Handler utama pemrosesan data form 4 Alur Pinjaman & Pengembalian
 */
function handlePinjamanSubmit(payload) {
  try {
    var ss = getPinjamanSpreadsheet();
    var timezone = PINJAMAN_CONFIG.TIMEZONE || "Asia/Jakarta";
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
      sheetTargetName = ss.getSheetByName('Pinjam ke Hub Lain') ? 'Pinjam ke Hub Lain' : 'Pinjaman Barang CWG';
    } else if (isKembalikanKeHub) {
      jenisLabel = 'MTG Kembalikan ke Hub Lain';
      statusLabel = payload.status || 'DIKEMBALIKAN';
      sheetTargetName = ss.getSheetByName('Kembalikan ke Hub Lain') ? 'Kembalikan ke Hub Lain' : 'Pengembalian Barang CWG';
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

    // ── UPLOAD FOTO KE GOOGLE DRIVE JIKA ADA EVIDENCE ──
    var drivePhotoUrl = '';
    if (payload.imageBase64) {
      try {
        var folder;
        var folderId = PINJAMAN_CONFIG.EVIDENCE_FOLDER_ID || "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3";
        try {
          folder = DriveApp.getFolderById(folderId);
        } catch (errF) {}
        if (!folder) {
          var folderName = 'PINJAMAN_CWG_EVIDENCE';
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

    writePinjamanRowByHeaders(sheet, defaultHeaders, rowObj, headerColor);

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Transaksi "' + jenisLabel + '" SKU ' + sku + ' berhasil dicatat ke sheet "' + sheetTargetName + '"!',
      jenis: jenisLabel,
      sheet: sheetTargetName,
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

  sheet.appendRow(rowArr);
}

// Router WebApp jika file ini di-deploy langsung atau menimpa doPost global
function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }

    // 0. Route Recovery request jika ada
    if (payload.action === 'recoverMisplacedDcc' || payload.action === 'fixMisplacedDcc') {
      if (typeof recoverMisplacedDccFromPinjaman === 'function') {
        var recRes = recoverMisplacedDccFromPinjaman();
        return ContentService.createTextOutput(JSON.stringify(recRes)).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 1. Route ED Sweeper request jika file digabung dalam 1 project Apps Script
    if (payload.action === 'saveEdsResult' || payload.module === 'eds' || payload.module === 'ed_sweeper') {
      if (typeof handleEdsSubmit === 'function') {
        return handleEdsSubmit(payload);
      }
    }

    // 2. Route DCC Audit / Screening request
    var isDcc = (
      payload.action === 'saveDccAudit' ||
      payload.action === 'saveDccScreening' ||
      payload.module === 'dcc' ||
      payload.fisikGood !== undefined ||
      payload.slocActual !== undefined ||
      payload.expiredDate !== undefined ||
      payload.skuNumber !== undefined ||
      payload.shift === 'Task 1' ||
      payload.shift === 'Task 2'
    );

    if (isDcc) {
      if (typeof handleDccSubmit === 'function') {
        return handleDccSubmit(payload);
      } else {
        return handleDccFallbackSubmit(payload);
      }
    }

    // 3. Cek apakah ini transaksi Pinjaman yang eksplisit
    var isPinjamanExplicit = (
      payload.module === 'pinjaman' ||
      payload.action === 'savePinjamKeHub' ||
      payload.action === 'saveKembalikanKeHub' ||
      payload.action === 'savePinjeminKeHub' ||
      payload.action === 'saveTerimaKembali' ||
      payload.action === 'savePinjamanBarang' ||
      payload.action === 'savePengembalianBarang' ||
      payload.formType || payload.type
    );

    if (isPinjamanExplicit) {
      return handlePinjamanSubmit(payload);
    }

    // Jika tidak eksplisit, tapi handleDccSubmit ada, utamakan DCC
    if (typeof handleDccSubmit === 'function') {
      return handleDccSubmit(payload);
    }

    return handlePinjamanSubmit(payload);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Fallback writer ke Hasil DCC jika handleDccSubmit tidak ditemukan di scope
 */
function handleDccFallbackSubmit(payload) {
  try {
    var ss = getPinjamanSpreadsheet();
    var timezone = PINJAMAN_CONFIG.TIMEZONE || "Asia/Jakarta";
    var timestamp = Utilities.formatDate(new Date(), timezone, "dd/MM/yyyy HH:mm:ss");

    var skuNo = String(payload.skuNo || payload.sku || payload.sku_number || payload.skuNumber || '').trim();
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
    var labelProduct = String(payload.labelProduct || 'Ada').trim();
    var labelSloc = String(payload.labelSloc || 'Ada').trim();
    var msltc = String(payload.msltc || '').trim();

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
      '',
      '',
      '',
      '',
      String(fisikGood),
      msltc,
      skuNo,
      inputBy,
      labelProduct,
      labelSloc
    ];

    hasilDccSheet.appendRow(dccRowData);

    // Update Mainlist SKU
    try {
      var mainlistSheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
      if (mainlistSheet && skuNo) {
        var lastMRow = mainlistSheet.getLastRow();
        if (lastMRow > 1) {
          var mSkuValues = mainlistSheet.getRange(2, 3, lastMRow - 1, 1).getValues();
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

              mainlistSheet.getRange(targetRow, 8).setValue(fg);
              mainlistSheet.getRange(targetRow, 9).setValue(fb);
              mainlistSheet.getRange(targetRow, 10).setValue(tot);
              mainlistSheet.getRange(targetRow, 11).setValue(diff);
              mainlistSheet.getRange(targetRow, 12).setValue(slocActual);
              mainlistSheet.getRange(targetRow, 13).setValue(slocMatch);
              mainlistSheet.getRange(targetRow, 14).setValue(inputBy);
              mainlistSheet.getRange(targetRow, 15).setValue('DONE');
              mainlistSheet.getRange(targetRow, 16).setValue(remaksVal);
              break;
            }
          }
        }
      }
    } catch (errSync) {
      console.warn('Gagal auto-update Mainlist SKU di fallback Pinjaman:', errSync);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data audit SKU ' + skuNo + ' berhasil dicatat ke Hasil DCC & Mainlist SKU.'
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var ss = getPinjamanSpreadsheet();
    var param = (e && e.parameter) ? e.parameter : {};

    if (param.action === 'setupSheets' || param.action === 'setupPinjamanSheets') {
      setupPinjamanSheetsManual();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Berhasil membuat dan memformat 4 sheet Pinjaman di Google Sheets!'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var sheetName = param.sheet || 'Pinjaman Barang CWG';
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) {
      return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var results = [];

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!row[0] && !row[1] && !row[2]) continue;
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        var hName = String(headers[c] || '').trim();
        if (hName) {
          var val = row[c];
          if (val instanceof Date) {
            val = Utilities.formatDate(val, PINJAMAN_CONFIG.TIMEZONE || "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");
          }
          obj[hName] = val;
        }
      }
      results.push(obj);
    }

    return ContentService.createTextOutput(JSON.stringify(results)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// 🛠️ SETUP SHEET & MENU GOOGLE SPREADSHEET
// ============================================================

function onOpenPinjamanMenu() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('📦 PINJAMAN MTG')
      .addItem('⚡ Setup 4 Sheet Pinjaman & Pengembalian', 'setupPinjamanSheetsManual')
      .addItem('ℹ️ Cek Status & Panduan WebApp', 'showPinjamanDeployGuide')
      .addToUi();
  } catch (e) {}
}

function showPinjamanDeployGuide() {
  var ui = SpreadsheetApp.getUi();
  ui.alert(
    '📖 PANDUAN DEPLOY WEB APP PINJAMAN MTG\n\n' +
    '1. Klik tombol biru "Terapkan" (Deploy) di kanan atas editor Apps Script.\n' +
    '2. Pilih "Penerapan baru" (New deployment) atau "Kelola penerapan" (Manage deployments).\n' +
    '3. Pilih jenis: Aplikasi Web (Web App).\n' +
    '4. Jalankan sebagai: "Saya" (User me).\n' +
    '5. Siapa yang memiliki akses: "Siapa saja" (Anyone).\n' +
    '6. Klik "Terapkan" lalu salin URL Web App (/exec).\n' +
    '7. Masukkan URL tersebut ke konfigurasi Superapp MTG.'
  );
}

function setupPinjamanSheetsManual() {
  var ss = getPinjamanSpreadsheet();

  var sheetConfigs = [
    {
      name: 'Pinjaman Barang CWG',
      color: '#0284c7',
      headers: [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB TARGET PINJAM', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ]
    },
    {
      name: 'Pengembalian Barang CWG',
      color: '#059669',
      headers: [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB TARGET PENGEMBALIAN', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ]
    },
    {
      name: 'Pinjemin ke Hub Lain',
      color: '#D97706',
      headers: [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB PEMINJAM (TUJUAN)', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ]
    },
    {
      name: 'Terima Pengembalian Hub',
      color: '#7C3AED',
      headers: [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB ASAL PENGEMBALIAN', 'KONDISI BARANG', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ]
    }
  ];

  for (var i = 0; i < sheetConfigs.length; i++) {
    var conf = sheetConfigs[i];
    var sheet = ss.getSheetByName(conf.name);
    if (!sheet) {
      sheet = ss.insertSheet(conf.name);
      SpreadsheetApp.flush();
    }
    var numCols = conf.headers.length;
    sheet.getRange(1, 1, 1, numCols).setValues([conf.headers]);
    sheet.getRange(1, 1, 1, numCols)
      .setBackground(conf.color)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
    sheet.setRowHeight(1, 36);
    try { sheet.setFrozenRows(1); } catch (eF) {}
    SpreadsheetApp.flush();
  }
  try {
    SpreadsheetApp.getUi().alert('✅ 4 Sheet Transaksi Pinjaman & Pengembalian MTG berhasil dibuat & diformat:\n1. Pinjaman Barang CWG (Biru)\n2. Pengembalian Barang CWG (Hijau)\n3. Pinjemin ke Hub Lain (Oranye)\n4. Terima Pengembalian Hub (Ungu)');
  } catch(eAlert) {}
}

/**
 * 🛠️ DATA RECOVERY UTILITY:
 * Memindahkan audit DCC yang sempat salah masuk ke sheet 'Pinjaman Barang CWG'
 * kembali ke sheet 'Hasil DCC' dan update status 'DONE' di 'Mainlist SKU'.
 */
function recoverMisplacedDccFromPinjaman() {
  try {
    var ss = getPinjamanSpreadsheet();
    var pinjamSheet = ss.getSheetByName('Pinjaman Barang CWG');
    if (!pinjamSheet || pinjamSheet.getLastRow() < 2) {
      return { status: 'info', message: 'Sheet Pinjaman Barang CWG kosong atau tidak ditemukan.' };
    }

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

    var mainlistSheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
    var mainMap = {};
    if (mainlistSheet && mainlistSheet.getLastRow() > 1) {
      var mData = mainlistSheet.getRange(2, 1, mainlistSheet.getLastRow() - 1, 16).getValues();
      for (var m = 0; m < mData.length; m++) {
        var mRow = mData[m];
        var s = String(mRow[2] || '').trim().toLowerCase();
        if (s) {
          mainMap[s] = {
            rowIdx: m + 2,
            productName: String(mRow[3] || '').trim(),
            sloc: String(mRow[4] || '').trim(),
            qtySys: Number(mRow[5]) || 0
          };
        }
      }
    }

    var pinjamData = pinjamSheet.getDataRange().getValues();
    var rowsToMigrate = [];
    var rowIndicesToDelete = [];

    for (var i = 1; i < pinjamData.length; i++) {
      var row = pinjamData[i];
      var timeStr = String(row[0] || '').trim();
      var jenisStr = String(row[1] || '').trim();
      var skuStr = String(row[2] || '').trim();
      var picStr = String(row[7] || '').trim();
      var driveLink = String(row[9] || '').trim();

      if (skuStr === '999999999999' || (!skuStr && !picStr)) {
        rowIndicesToDelete.push(i + 1);
        continue;
      }

      if (jenisStr === 'MTG Pinjam ke Hub Lain' && (picStr.toLowerCase().includes('bintang') || picStr === '')) {
        var sLower = skuStr.toLowerCase();
        var itemInfo = mainMap[sLower] || {};
        var pName = itemInfo.productName || String(row[3] || '').trim();
        var sloc = itemInfo.sloc || String(row[4] || '').trim() || 'Match';
        var fisikGood = Number(row[5]) || 1;

        var dccRow = [
          timeStr || Utilities.formatDate(new Date(), PINJAMAN_CONFIG.TIMEZONE || "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss"),
          skuStr,
          pName,
          sloc,
          'Match',
          '',
          fisikGood,
          '0',
          '0',
          '',
          '',
          '',
          '',
          driveLink,
          '',
          String(fisikGood),
          '',
          skuStr,
          picStr || 'Bintang',
          'Ada',
          'Ada'
        ];

        rowsToMigrate.push({
          dccRow: dccRow,
          sku: skuStr,
          fisikGood: fisikGood,
          sloc: sloc,
          pic: picStr || 'Bintang',
          itemInfo: itemInfo
        });

        rowIndicesToDelete.push(i + 1);
      }
    }

    // 1. Tulis ke Hasil DCC
    for (var r = 0; r < rowsToMigrate.length; r++) {
      var item = rowsToMigrate[r];
      hasilDccSheet.appendRow(item.dccRow);

      // 2. Update status ke Mainlist SKU jika ada
      if (mainlistSheet && item.itemInfo && item.itemInfo.rowIdx) {
        var tRow = item.itemInfo.rowIdx;
        var fg = item.fisikGood;
        var sysQ = item.itemInfo.qtySys || 0;
        var diff = fg - sysQ;
        mainlistSheet.getRange(tRow, 8).setValue(fg);
        mainlistSheet.getRange(tRow, 9).setValue(0);
        mainlistSheet.getRange(tRow, 10).setValue(fg);
        mainlistSheet.getRange(tRow, 11).setValue(diff);
        mainlistSheet.getRange(tRow, 12).setValue(item.sloc);
        mainlistSheet.getRange(tRow, 13).setValue('MATCH');
        mainlistSheet.getRange(tRow, 14).setValue(item.pic);
        mainlistSheet.getRange(tRow, 15).setValue('DONE');
        mainlistSheet.getRange(tRow, 16).setValue('Sesuai');
      }
    }

    // 3. Hapus baris dari Pinjaman Barang CWG dari indeks terbesar
    rowIndicesToDelete.sort(function(a, b) { return b - a; });
    for (var d = 0; d < rowIndicesToDelete.length; d++) {
      pinjamSheet.deleteRow(rowIndicesToDelete[d]);
    }

    return {
      status: 'success',
      message: 'Berhasil memindahkan ' + rowsToMigrate.length + ' data audit DCC dari sheet Pinjaman Barang CWG ke sheet Hasil DCC & update Mainlist SKU!',
      migratedCount: rowsToMigrate.length
    };
  } catch (err) {
    return {
      status: 'error',
      message: 'Gagal recovery data: ' + err.toString()
    };
  }
}
