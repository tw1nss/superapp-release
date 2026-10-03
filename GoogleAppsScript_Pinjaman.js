/**
 * =========================================================================
 * 📦 GOOGLE APPS SCRIPT: PINJAMAN & PENGEMBALIAN BARANG MTG (4 ALUR LENGKAP)
 * =========================================================================
 * Spreadsheet: Dashboard STK MTG 2K26
 * URL: https://docs.google.com/spreadsheets/d/1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g/edit
 *
 * 4 ALUR TRANSAKSI:
 * 1. 📤 MTG Pinjam ke Hub Lain (MTG butuh stok, pinjam dari Hub luar)
 *    -> Dicatat ke Sheet: 'Pinjaman Barang MTG', Status: 'DIPINJAM'
 * 2. 📥 MTG Kembalikan ke Hub Lain (MTG mengembalikan barang pinjaman ke Hub luar)
 *    -> Dicatat ke Sheet: 'Pengembalian Barang MTG', Status: 'DIKEMBALIKAN'
 * 3. 🤝 MTG Pinjemin ke Hub Lain (Hub luar butuh stok, MTG meminjamkan)
 *    -> Dicatat ke Sheet: 'Pinjaman Barang MTG', Status: 'DIPINJAMKAN'
 * 4. 📦 MTG Terima Pengembalian dari Hub Lain (Hub luar kembalikan barang ke MTG)
 *    -> Dicatat ke Sheet: 'Pengembalian Barang MTG', Status: 'DITERIMA KEMBALI'
 *
 * FITUR:
 * - Upload Bukti Foto Produk otomatis ke Google Drive
 * - Mapping kolom dinamis fleksibel sesuai susunan header sheet
 * - Standalone doPost & doGet router
 * =========================================================================
 */

var PINJAMAN_CONFIG = {
  TARGET_FILE_ID: "1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g",
  EVIDENCE_FOLDER_ID: "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3", // Google Drive Folder Bukti
  TIMEZONE: "Asia/Jakarta"
};

function getPinjamanSpreadsheet() {
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
        var folderId = PINJAMAN_CONFIG.EVIDENCE_FOLDER_ID || "1RtRFC7XfgLNr7EV76rRn-hScNYW4hOb3";
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

  sheet.appendRow(rowArr);
}

// Router WebApp jika file ini di-deploy langsung
function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }
    return handlePinjamanSubmit(payload);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'success',
    message: 'Pinjaman & Pengembalian Barang MTG API Ready'
  })).setMimeType(ContentService.MimeType.JSON);
}

// Menu Action / Setup Helper
function setupPinjamanSheetsManual() {
  var ss = getPinjamanSpreadsheet();
  
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

  SpreadsheetApp.getUi().alert('✅ Sheet "Pinjaman Barang MTG" dan "Pengembalian Barang MTG" berhasil diformat (4 Alur Transaksi)!');
}
