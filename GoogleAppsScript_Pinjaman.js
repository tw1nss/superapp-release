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

    var sheetName = param.sheet || 'Pinjaman Barang MTG';
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
      name: 'Pinjaman Barang MTG',
      color: '#0284c7',
      headers: [
        'TIMESTAMP', 'JENIS TRANSAKSI', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
        'QTY', 'HUB TARGET PINJAM', 'PIC PETUGAS MTG', 'PIC / DRIVER HUB', 'BUKTI FOTO (DRIVE)', 'STATUS', 'CATATAN'
      ]
    },
    {
      name: 'Pengembalian Barang MTG',
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
    SpreadsheetApp.getUi().alert('✅ 4 Sheet Transaksi Pinjaman & Pengembalian MTG berhasil dibuat & diformat:\n1. Pinjaman Barang MTG (Biru)\n2. Pengembalian Barang MTG (Hijau)\n3. Pinjemin ke Hub Lain (Oranye)\n4. Terima Pengembalian Hub (Ungu)');
  } catch(eAlert) {}
}
