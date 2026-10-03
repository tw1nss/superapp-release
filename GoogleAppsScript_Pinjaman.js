/**
 * =========================================================================
 * 📦 GOOGLE APPS SCRIPT: PINJAMAN & PENGEMBALIAN BARANG MTG
 * =========================================================================
 * Spreadsheet: Dashboard STK MTG 2K26
 * URL: https://docs.google.com/spreadsheets/d/1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g/edit
 *
 * FITUR:
 * 1. Peminjaman Barang MTG:
 *    - Catat SKU, Nama Produk, QTY, HUB Tujuan, PIC Peminjam, Status, Catatan ke sheet 'Pinjaman Barang MTG'.
 * 2. Pengembalian Barang MTG:
 *    - Catat SKU, Nama Produk, SLOC, QTY, HUB Asal/Tujuan, PIC Pengembalian, Foto Produk (Google Drive), Status, Catatan ke sheet 'Pengembalian Barang MTG'.
 * 3. Upload Bukti Foto Produk otomatis ke Google Drive.
 * 4. Auto format Header & Proteksi Row.
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

function handlePinjamanSubmit(payload) {
  try {
    var ss = getPinjamanSpreadsheet();
    var timezone = PINJAMAN_CONFIG.TIMEZONE || "Asia/Jakarta";
    var timestamp = Utilities.formatDate(new Date(), timezone, "dd/MM/yyyy HH:mm:ss");

    var isPengembalian = (payload.action === 'savePengembalianBarang') || 
                         (payload.formType === 'pengembalian') || 
                         (payload.type === 'pengembalian');

    if (isPengembalian) {
      // ── 1. FORM PENGEMBALIAN BARANG MTG ──
      var sheetKembali = ss.getSheetByName('Pengembalian Barang MTG');
      if (!sheetKembali) {
        sheetKembali = ss.insertSheet('Pengembalian Barang MTG');
      }

      // Pastikan header rapi jika sheet baru / kosong
      if (sheetKembali.getLastRow() === 0 || (sheetKembali.getLastRow() === 1 && !sheetKembali.getRange(1, 1).getValue())) {
        var headerK = [[
          'TIMESTAMP', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
          'QTY KEMBALI', 'KEMBALIKAN KE HUB', 'PIC PENGEMBALIAN', 'FOTO PRODUK (DRIVE)', 'STATUS', 'CATATAN'
        ]];
        sheetKembali.getRange(1, 1, 1, 10).setValues(headerK);
        sheetKembali.getRange(1, 1, 1, 10)
          .setBackground('#059669')
          .setFontColor('#FFFFFF')
          .setFontWeight('bold')
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');
        sheetKembali.setRowHeight(1, 36);
        sheetKembali.setFrozenRows(1);
      }

      // Upload Bukti Foto Produk jika ada
      var drivePhotoUrl = '';
      if (payload.imageBase64) {
        try {
          var folder;
          if (PINJAMAN_CONFIG.EVIDENCE_FOLDER_ID) {
            try {
              folder = DriveApp.getFolderById(PINJAMAN_CONFIG.EVIDENCE_FOLDER_ID);
            } catch (errF) {
              console.warn('Folder ID fallback:', errF);
            }
          }
          if (!folder) {
            var folderName = 'PINJAMAN_MTG_EVIDENCE';
            var folders = DriveApp.getFoldersByName(folderName);
            folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
            folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          }

          var dateStr = Utilities.formatDate(new Date(), timezone, "yyyyMMdd_HHmmss");
          var skuClean = String(payload.sku || payload.skuNo || 'NOSKU').trim();
          var fileName = 'KEMBALI_' + skuClean + '_' + dateStr + '.jpg';
          var cleanBase64 = payload.imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
          var decoded = Utilities.base64Decode(cleanBase64);
          var blob = Utilities.newBlob(decoded, 'image/jpeg', fileName);
          var file = folder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          drivePhotoUrl = file.getUrl();
        } catch (errUpload) {
          console.warn('Gagal upload foto pengembalian:', errUpload);
        }
      }

      var sku = String(payload.sku || payload.skuNo || '').trim();
      var productName = String(payload.productName || payload.namaProduk || '').trim();
      var sloc = String(payload.sloc || payload.rack || '').trim();
      var qty = Number(payload.qty || 1);
      var hub = String(payload.hub || payload.hubTujuan || '').trim();
      var pic = String(payload.pic || payload.picPengembalian || payload.petugas || '').trim();
      var status = String(payload.status || 'DIKEMBALIKAN').trim();
      var remarks = String(payload.remarks || payload.catatan || '').trim();

      var newRowK = [
        timestamp, sku, productName, sloc, qty, hub, pic, drivePhotoUrl, status, remarks
      ];

      // Gunakan helper append atau standar appendRow
      if (typeof appendToFirstEmptyRow === 'function') {
        appendToFirstEmptyRow(sheetKembali, newRowK);
      } else {
        sheetKembali.appendRow(newRowK);
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Pengembalian barang berhasil dicatat ke sheet "Pengembalian Barang MTG"!',
        sku: sku,
        productName: productName,
        sloc: sloc,
        qty: qty,
        hub: hub,
        pic: pic,
        photoUrl: drivePhotoUrl,
        timestamp: timestamp
      })).setMimeType(ContentService.MimeType.JSON);

    } else {
      // ── 2. FORM PEMINJAMAN BARANG MTG ──
      var sheetPinjam = ss.getSheetByName('Pinjaman Barang MTG');
      if (!sheetPinjam) {
        sheetPinjam = ss.insertSheet('Pinjaman Barang MTG');
      }

      // Pastikan header rapi jika sheet baru / kosong
      if (sheetPinjam.getLastRow() === 0 || (sheetPinjam.getLastRow() === 1 && !sheetPinjam.getRange(1, 1).getValue())) {
        var headerP = [[
          'TIMESTAMP', 'NOMOR SKU', 'NAMA PRODUK', 'QTY PINJAM', 
          'PINJAM KE HUB', 'PIC PEMINJAM', 'STATUS', 'CATATAN'
        ]];
        sheetPinjam.getRange(1, 1, 1, 8).setValues(headerP);
        sheetPinjam.getRange(1, 1, 1, 8)
          .setBackground('#0284c7')
          .setFontColor('#FFFFFF')
          .setFontWeight('bold')
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');
        sheetPinjam.setRowHeight(1, 36);
        sheetPinjam.setFrozenRows(1);
      }

      var pSku = String(payload.sku || payload.skuNo || '').trim();
      var pProductName = String(payload.productName || payload.namaProduk || '').trim();
      var pQty = Number(payload.qty || 1);
      var pHub = String(payload.hub || payload.hubTujuan || '').trim();
      var pPic = String(payload.pic || payload.picPeminjam || payload.petugas || '').trim();
      var pStatus = String(payload.status || 'DIPINJAM').trim();
      var pRemarks = String(payload.remarks || payload.catatan || '').trim();

      var newRowP = [
        timestamp, pSku, pProductName, pQty, pHub, pPic, pStatus, pRemarks
      ];

      if (typeof appendToFirstEmptyRow === 'function') {
        appendToFirstEmptyRow(sheetPinjam, newRowP);
      } else {
        sheetPinjam.appendRow(newRowP);
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Peminjaman barang berhasil dicatat ke sheet "Pinjaman Barang MTG"!',
        sku: pSku,
        productName: pProductName,
        qty: pQty,
        hub: pHub,
        pic: pPic,
        timestamp: timestamp
      })).setMimeType(ContentService.MimeType.JSON);
    }

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Gagal memproses data pinjaman: ' + err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Menu Action / Setup Helper
function setupPinjamanSheetsManual() {
  var ss = getPinjamanSpreadsheet();
  
  var pSheet = ss.getSheetByName('Pinjaman Barang MTG') || ss.insertSheet('Pinjaman Barang MTG');
  var headerP = [[
    'TIMESTAMP', 'NOMOR SKU', 'NAMA PRODUK', 'QTY PINJAM', 
    'PINJAM KE HUB', 'PIC PEMINJAM', 'STATUS', 'CATATAN'
  ]];
  pSheet.getRange(1, 1, 1, 8).setValues(headerP);
  pSheet.getRange(1, 1, 1, 8)
    .setBackground('#0284c7')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  pSheet.setRowHeight(1, 36);
  pSheet.setFrozenRows(1);

  var kSheet = ss.getSheetByName('Pengembalian Barang MTG') || ss.insertSheet('Pengembalian Barang MTG');
  var headerK = [[
    'TIMESTAMP', 'NOMOR SKU', 'NAMA PRODUK', 'SLOC (LOKASI RAK)', 
    'QTY KEMBALI', 'KEMBALIKAN KE HUB', 'PIC PENGEMBALIAN', 'FOTO PRODUK (DRIVE)', 'STATUS', 'CATATAN'
  ]];
  kSheet.getRange(1, 1, 1, 10).setValues(headerK);
  kSheet.getRange(1, 1, 1, 10)
    .setBackground('#059669')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  kSheet.setRowHeight(1, 36);
  kSheet.setFrozenRows(1);

  if (typeof alertUser === 'function') {
    alertUser('✅ Sheet "Pinjaman Barang MTG" dan "Pengembalian Barang MTG" berhasil diformat!');
  } else {
    SpreadsheetApp.getUi().alert('✅ Sheet "Pinjaman Barang MTG" dan "Pengembalian Barang MTG" berhasil diformat!');
  }
}
