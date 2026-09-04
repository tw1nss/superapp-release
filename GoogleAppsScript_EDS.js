/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: ED SWEEPER MTG #STAR
 * Spreadsheet: https://docs.google.com/spreadsheets/d/17CgSdhmrp-pRSaiudQvtBGu7wCpWXUdnCV4aP53sK-A/edit
 * 
 * ALUR SISTEM:
 * 1. Sheet "Data Update" = Data mentah (raw data) produk, rak, stok & tanggal kadaluarsa.
 * 2. Sheet "Main List SKU" = List tugas harian! SKU diisi manual oleh supervisor, 
 *    sedangkan nama produk, rak, stok dll. otomatis dihitung lewat RUMUS.
 * 3. Sheet "Hasil EDS" = Merekap hasil audit petugas yang diinput melalui SuperApp MTG (doPost).
 * 4. Sheet "Backup Data" = Arsip backup hasil rekapan EDS (Backup Manual & Otomatis 23:00 WIB).
 * ==============================================================================
 */

// =============================
// ⚙️ CONFIG SUPERSET ASTRODASH
// =============================
var SUPERSET_CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  DEFAULT_CHART_ID: 24592, // Slice ID ED Sweeper dari link dashboard
  DASHBOARD_PAGE_ID: "U3z99CtEM_b7ZlpM-m6TD",
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// ── 1. MENU CUSTOM DI GOOGLE SHEETS ──
function onOpen() {
  try {
    ensureDailyBackupTrigger();
    ensureAutoSupersetTrigger();
  } catch (e) {
    console.warn('Gagal set trigger:', e);
  }

  const ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ ED Sweeper Control')
    .addItem('🔄 Update Data (Tarik dari Superset)', 'updateDataFromSupersetManual')
    .addItem('📋 Sinkronkan Data Update ke Main List (Bebas #ERROR!)', 'syncDataUpdateToMainListManual')
    .addItem('🔧 Pasang Rumus VLOOKUP (Sintaks Titik Koma ;)', 'restoreMainListFormulas')
    .addItem('⚡ Refresh & Sinkronisasi', 'updateDataManual')
    .addSeparator()
    .addSubMenu(ui.createMenu('🎯 Filter Kategori Alert')
      .addItem('🟢 Semua Alert (Warning, Hard Warning & Critical)', 'filterSheetAlertAllWarningCritical')
      .addItem('🔴 Hanya Critical', 'filterSheetAlertCriticalOnly')
      .addItem('🔴 Hanya Hard Warning', 'filterSheetAlertHardWarningOnly')
      .addItem('🟡 Hanya Warning', 'filterSheetAlertWarningOnly')
      .addItem('🔥 Critical & Hard Warning', 'filterSheetAlertCriticalAndHard')
      .addSeparator()
      .addItem('🔄 Reset / Tampilkan Semua Baris', 'resetSheetAlertFilter')
    )
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'setSupersetCookiePrompt')
    .addItem('🎯 Set ID Chart Superset', 'setSupersetChartIdPrompt')
    .addSeparator()
    .addItem('📦 Backup Data Hasil EDS ke "Backup Data"', 'backupHasilEdsManual')
    .addItem('🔄 Backup & Reset Sheet "Hasil EDS"', 'backupAndResetHasilEdsManual')
    .addToUi();
}

function showDeployGuidePrompt() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '📋 Panduan Pasang WebApp URL ke SuperApp MTG',
    'Langkah agar hasil audit dari SuperApp masuk ke sheet "Hasil EDS":\n\n' +
    '1. Di menu atas Apps Script ini, klik tombol biru "Terapkan" (Deploy) ➔ "Penerapan baru".\n' +
    '2. Klik ikon Gerigi (⚙️) ➔ Pilih "Aplikasi web".\n' +
    '3. Konfigurasi:\n' +
    '   - Jalankan sebagai: "Saya"\n' +
    '   - Yang memiliki akses: "Siapa saja"\n' +
    '4. Klik "Terapkan" ➔ Salin (Copy) "URL Aplikasi Web" yang berakhiran /exec.\n' +
    '5. Buka SuperApp MTG di HP ➔ Masuk menu Expired Date Sweeper ➔ Tab Scan/Input ➔ Klik banner/tombol "Koneksi WebApp" dan paste URL tersebut.\n\n' +
    '✅ Seketika setiap audit yang dikirim dari HP akan langsung masuk ke sheet "Hasil EDS" dan kolom Done otomatis terisi!',
    ui.ButtonSet.OK
  );
}

// ── 2. AUTO-BACKUP HARIAN (JAM 23:00 WIB) ──
function ensureDailyBackupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let hasDailyBackupTrigger = false;

  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyAutoBackupTask') {
      hasDailyBackupTrigger = true;
      break;
    }
  }

  if (!hasDailyBackupTrigger) {
    ScriptApp.newTrigger('dailyAutoBackupTask')
      .timeBased()
      .everyDays(1)
      .atHour(23)
      .create();
    console.log('Background Daily Backup Trigger (23:00 WIB) aktif.');
  }
}

function dailyAutoBackupTask() {
  try {
    backupHasilEdsToBackupSheet(false);
  } catch (err) {
    console.error('Error saat auto-backup harian:', err);
  }
}

// ── 3. ENGINE TARIK DATA SUPERSET ASTRODASH (REALTIME & AUTO 5 MENIT) ──

function ensureAutoSupersetTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let hasTrigger = false;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoPullSupersetBackground') {
      hasTrigger = true;
      break;
    }
  }
  if (!hasTrigger) {
    ScriptApp.newTrigger('autoPullSupersetBackground')
      .timeBased()
      .everyMinutes(5)
      .create();
    console.log('Background Auto-Pull Superset (Setiap 5 Menit) aktif.');
  }
}

function autoPullSupersetBackground() {
  try {
    pullSupersetDataToSheet('Data Update', true);
  } catch (e) {
    console.error('Background auto-pull Superset error:', e);
  }
}

function updateDataFromSupersetManual() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('⚡ Menghubungkan ke AstroDash Superset...', 'Loading', 3);
  const ok = pullSupersetDataToSheet('Data Update', false);
  if (ok) {
    updateDataManual();
  }
}

function setSupersetCookiePrompt() {
  const ui = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty('MY_COOKIE') || '';
  const resp = ui.prompt(
    '🔑 Set Cookie Superset (AstroDash)',
    'Salin nilai Cookie dari browser Anda saat membuka dash.astronauts.id lalu paste di sini:\n' +
    (current ? '(Cookie saat ini sudah terpasang. Paste yang baru jika cookie sebelumnya expired)' : ''),
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() === ui.Button.OK) {
    const cookie = resp.getResponseText().trim();
    if (cookie) {
      PropertiesService.getScriptProperties().setProperty('MY_COOKIE', cookie);
      ui.alert('Sukses', '✅ Cookie Superset berhasil disimpan! Sekarang Anda bisa menarik data kapan saja.', ui.ButtonSet.OK);
    }
  }
}

function setSupersetChartIdPrompt() {
  const ui = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty('SUPERSET_CHART_ID') || SUPERSET_CONFIG.DEFAULT_CHART_ID;
  const resp = ui.prompt(
    '🎯 Set ID Chart Superset',
    'Masukkan ID Chart (Slice ID) untuk data ED Sweeper / MSLTC (Default: ' + current + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() === ui.Button.OK) {
    const id = resp.getResponseText().trim();
    if (id) {
      PropertiesService.getScriptProperties().setProperty('SUPERSET_CHART_ID', id);
      ui.alert('Sukses', '✅ ID Chart berhasil diset ke: ' + id, ui.ButtonSet.OK);
    }
  }
}

function pullSupersetDataToSheet(sheetName, isSilent) {
  const props = PropertiesService.getScriptProperties();
  const cookie = props.getProperty('MY_COOKIE');
  let chartId = props.getProperty('SUPERSET_CHART_ID');
  if (!chartId || chartId === '11815') {
    chartId = SUPERSET_CONFIG.DEFAULT_CHART_ID;
  }

  if (!cookie) {
    if (!isSilent) {
      SpreadsheetApp.getUi().alert('❌ Cookie Belum Diset', 'Silakan klik menu:\n⚡ ED Sweeper Control ➔ 🔑 Set / Ganti Cookie Superset\nlalu paste cookie browser Anda dari dash.astronauts.id.', SpreadsheetApp.getUi().ButtonSet.OK);
    }
    return false;
  }

  const timestamp = new Date().getTime();
  const formDataPage = JSON.stringify({
    slice_id: Number(chartId),
    dashboard_page_id: SUPERSET_CONFIG.DASHBOARD_PAGE_ID
  });
  const formDataBasic = JSON.stringify({
    slice_id: Number(chartId)
  });

  const urlVariants = [
    SUPERSET_CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp,
    SUPERSET_CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(formDataPage) + "&force=true&_t=" + timestamp,
    SUPERSET_CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(formDataBasic) + "&force=true&_t=" + timestamp
  ];

  let response;
  let data;
  let success = false;
  let lastError = "";

  for (let u = 0; u < urlVariants.length; u++) {
    for (let i = 0; i < SUPERSET_CONFIG.MAX_RETRY; i++) {
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

        const code = response.getResponseCode();
        if (code === 401) {
          if (!isSilent) {
            SpreadsheetApp.getUi().alert('❌ Cookie Kadaluarsa', 'Cookie Superset Anda sudah expired (401 Unauthorized).\nSilakan ambil cookie terbaru dari browser dan simpan via menu:\n⚡ ED Sweeper Control ➔ 🔑 Set / Ganti Cookie Superset.', SpreadsheetApp.getUi().ButtonSet.OK);
          }
          return false;
        }

        if (code !== 200) {
          lastError = "HTTP " + code;
          Utilities.sleep(SUPERSET_CONFIG.RETRY_DELAY);
          continue;
        }

        const json = JSON.parse(response.getContentText());

        if (json.result && json.result[0] && json.result[0].data) {
          data = json.result[0].data;
        } else if (json.result && json.result[0] && json.result[0].records) {
          data = json.result[0].records;
        } else if (json.data && json.data.records) {
          data = json.data.records;
        } else if (json.colnames && json.data) {
          data = json.data.map(function(row) {
            const obj = {};
            json.colnames.forEach(function(col, idx) {
              obj[col] = row[idx];
            });
            return obj;
          });
        }

        if (data && data.length > 0) {
          processSupersetDataToSheet(data, sheetName);
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
    // 🚀 Auto-sync seluruh SKU dari Data Update ke Main List SKU!
    syncDataUpdateToMainList(true);

    if (!isSilent) {
      SpreadsheetApp.getActiveSpreadsheet().toast('✅ Berhasil menarik ' + data.length + ' data terbaru dari AstroDash Superset ke "' + sheetName + '" & menyinkronkan Main List SKU!', 'Update Sukses ⚡', 5);
    }
    return true;
  } else {
    if (!isSilent) {
      SpreadsheetApp.getUi().alert('Gagal Menarik Data', '❌ Gagal tarik data Superset (' + sheetName + ')\nDetail: ' + lastError + '\n\nCek apakah ID Chart (' + chartId + ') atau Cookie valid.', SpreadsheetApp.getUi().ButtonSet.OK);
    }
    return false;
  }
}

function processSupersetDataToSheet(data, sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  if (!data || data.length === 0) return;

  // 🎯 FILTER PRODUK DENGAN ALERT WARNING, HARD WARNING & CRITICAL
  const filteredData = data.filter(function(item) {
    const alertVal = String(item.alert || item.Alert || item.ALERT || item.status || '').toLowerCase();
    const remDaysRaw = item['remaining days'] !== undefined ? item['remaining days'] : (item.remaining_days !== undefined ? item.remaining_days : (item.remainingDays !== undefined ? item.remainingDays : ''));
    const remainingDays = (remDaysRaw !== '' && !isNaN(Number(remDaysRaw))) ? Number(remDaysRaw) : NaN;

    // Critical: sisa <= 0 hari atau alert mengandung critical
    const isCritical = alertVal.includes('critical') || (!isNaN(remainingDays) && remainingDays <= 0);

    // Hard Warning: sisa === 1 hari atau alert mengandung hard
    const isHardWarning = alertVal.includes('hard') || (!isNaN(remainingDays) && remainingDays === 1);

    // Warning: sisa 2 s/d 3 hari ATAU alert mengandung warning (tanpa kata hard)
    const isWarning = (!alertVal.includes('hard') && alertVal.includes('warning')) || (!isNaN(remainingDays) && remainingDays >= 2 && remainingDays <= 3);

    return isCritical || isHardWarning || isWarning;
  });

  const finalData = filteredData.length > 0 ? filteredData : data;

  const headers = Object.keys(finalData[0]);

  const rows = finalData.map(function(item) {
    return headers.map(function(key) {
      const value = item[key];
      const cleanKey = key.toLowerCase();

      // SKU wajib string agar digit awal tidak hilang
      if (cleanKey.includes("sku")) {
        return String(value);
      }

      // Format tanggal jika numeric timestamp
      if (cleanKey.includes("date") && value && !isNaN(value) && typeof value === 'number') {
        try {
          return Utilities.formatDate(
            new Date(Number(value)),
            SUPERSET_CONFIG.TIMEZONE,
            "yyyy-MM-dd"
          );
        } catch(e) {}
      }

      if (cleanKey === "quantity" || cleanKey === "reserved_quantity" || cleanKey.includes("qty") || cleanKey === "price") {
        return (value !== "" && value !== null && !isNaN(value)) ? Number(value) : value;
      }

      return value !== null && value !== undefined ? value : "";
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
  SpreadsheetApp.flush();
}

// ── 4. SINKRONISASI OTOMATIS: DATA UPDATE ➔ MAIN LIST SKU ──

function syncDataUpdateToMainListManual() {
  syncDataUpdateToMainList(false);
}

function syncDataUpdateToMainList(isSilent) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const updateSheet = ss.getSheetByName('Data Update');
  const mainSheet = ss.getSheetByName('Main List SKU');
  const hasilSheet = ss.getSheetByName('Hasil EDS');

  if (!updateSheet || updateSheet.getLastRow() <= 1) {
    if (!isSilent) ss.toast('Sheet "Data Update" belum memiliki data. Tarik data dari Superset terlebih dahulu.', 'Perhatian', 4);
    return;
  }

  if (!mainSheet) {
    if (!isSilent) ss.toast('Sheet "Main List SKU" tidak ditemukan.', 'Error', 4);
    return;
  }

  const upData = updateSheet.getDataRange().getValues();
  const upHeaders = upData[0].map(function(h) { return String(h || '').trim().toLowerCase(); });

  const colSku = upHeaders.indexOf('sku_number') !== -1 ? upHeaders.indexOf('sku_number') : (upHeaders.indexOf('sku') !== -1 ? upHeaders.indexOf('sku') : 0);
  const colName = upHeaders.indexOf('product_name') !== -1 ? upHeaders.indexOf('product_name') : 1;
  const colHub = upHeaders.indexOf('location_name') !== -1 ? upHeaders.indexOf('location_name') : 2;
  const colExp = upHeaders.indexOf('expiry_date') !== -1 ? upHeaders.indexOf('expiry_date') : 4;
  const colMsltc = upHeaders.indexOf('msltc') !== -1 ? upHeaders.indexOf('msltc') : 5;
  const colQty = upHeaders.indexOf('qty_system') !== -1 ? upHeaders.indexOf('qty_system') : 6;
  const colRack = upHeaders.indexOf('rack_name') !== -1 ? upHeaders.indexOf('rack_name') : 7;
  const colCat1 = upHeaders.indexOf('l1_category_name') !== -1 ? upHeaders.indexOf('l1_category_name') : 8;
  const colCat2 = upHeaders.indexOf('l2_category_name') !== -1 ? upHeaders.indexOf('l2_category_name') : 9;
  const colMsDate = upHeaders.indexOf('msltc_date') !== -1 ? upHeaders.indexOf('msltc_date') : 10;
  const colRemDays = upHeaders.indexOf('remaining days') !== -1 ? upHeaders.indexOf('remaining days') : (upHeaders.indexOf('remaining_days') !== -1 ? upHeaders.indexOf('remaining_days') : 11);
  const colAlert = upHeaders.indexOf('alert') !== -1 ? upHeaders.indexOf('alert') : 12;

  // Kumpulkan detail lengkap produk unik dari Data Update
  const updateDataMap = new Map();
  for (let i = 1; i < upData.length; i++) {
    const row = upData[i];
    const skuStr = String(row[colSku] || '').trim();
    if (skuStr && !updateDataMap.has(skuStr.toLowerCase())) {
      updateDataMap.set(skuStr.toLowerCase(), {
        sku: skuStr,
        productName: row[colName] || '',
        hub: row[colHub] || 'MTG - Menteng',
        expiryDate: row[colExp] || '',
        msltc: row[colMsltc] || '',
        qtySystem: (row[colQty] !== '' && !isNaN(row[colQty])) ? Number(row[colQty]) : (row[colQty] || 0),
        rackName: row[colRack] || '',
        l1Category: row[colCat1] || '',
        l2Category: row[colCat2] || '',
        msltcDate: row[colMsDate] || '',
        remainingDays: row[colRemDays] !== undefined ? row[colRemDays] : '',
        alert: row[colAlert] || ''
      });
    }
  }

  if (updateDataMap.size === 0) {
    if (!isSilent) ss.toast('Tidak ada SKU yang ditemukan di Data Update.', 'Info', 3);
    return;
  }

  // Riwayat audit yang sudah tersimpan di Hasil EDS agar status Done & Remaks tidak hilang
  const hasilMap = new Map();
  if (hasilSheet && hasilSheet.getLastRow() > 1) {
    const hRows = hasilSheet.getDataRange().getValues();
    for (let h = 1; h < hRows.length; h++) {
      const hSku = String(hRows[h][0] || hRows[h][16] || '').trim().toLowerCase();
      if (hSku) {
        hasilMap.set(hSku, {
          done: 'Done',
          remaks: hRows[h][9] || hRows[h][8] || 'Sesuai',
          fisikGood: hRows[h][5]
        });
      }
    }
  }

  // Siapkan baris data langsung (NILAI BERSIH / REAL DATA LANGSUNG DARI DATA UPDATE, BEBAS #ERROR!)
  const todayDate = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy");
  const newRows = [];

  updateDataMap.forEach(function(item) {
    const sku = item.sku;
    const audit = hasilMap.get(sku.toLowerCase());

    const doneVal = audit ? 'Done' : '';
    const remaksVal = audit ? audit.remaks : '';
    const fisikVal = audit ? (audit.fisikGood + '/' + item.qtySystem) : '';

    newRows.push([
      todayDate,                  // Kolom A: Tanggal
      sku,                        // Kolom B: SKU
      item.productName,           // Kolom C: Product Name
      item.rackName,              // Kolom D: Lokasi Rack
      item.qtySystem,             // Kolom E: Stock Available
      0,                          // Kolom F: Stock Bad
      0,                          // Kolom G: Stock LDP
      item.hub,                   // Kolom H: Hub
      item.expiryDate,            // Kolom I: expiry_date
      item.msltc,                 // Kolom J: msltc
      item.qtySystem,             // Kolom K: qty_system
      item.rackName,              // Kolom L: rack_name
      item.l1Category,            // Kolom M: l1_category_name
      item.l2Category,            // Kolom N: l2_category_name
      item.msltcDate,             // Kolom O: MSLTC_date
      item.remainingDays,         // Kolom P: remaining days
      item.alert,                 // Kolom Q: alert
      doneVal,                    // Kolom R: Done
      remaksVal,                  // Kolom S: Remaks DCC
      fisikVal                    // Kolom T: Fisik/System
    ]);
  });

  // Bersihkan data lama baris 2 ke bawah
  const currentLastRow = mainSheet.getLastRow();
  if (currentLastRow > 1) {
    mainSheet.getRange(2, 1, currentLastRow - 1, 20).clearContent();
  }

  if (newRows.length > 0) {
    mainSheet.getRange(2, 1, newRows.length, 20).setValues(newRows);
  }

  SpreadsheetApp.flush();
  if (!isSilent) {
    ss.toast('✅ Berhasil menyinkronkan ' + newRows.length + ' SKU dari Data Update ke Main List SKU! Bebas #ERROR!', 'Sinkronisasi Sukses ⚡', 5);
  }
}

// ── OPSIONAL: PASANG RUMUS VLOOKUP JIKA SUPERVISOR INGIN FORMAT RUMUS DINAMIS ──
function restoreMainListFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mainSheet = ss.getSheetByName('Main List SKU');
  if (!mainSheet) return;

  const lastRow = mainSheet.getLastRow();
  if (lastRow <= 1) {
    ss.toast('Main List SKU masih kosong. Klik menu "Sinkronkan Data Update ke Main List" terlebih dahulu.', 'Perhatian', 4);
    return;
  }

  const numRows = lastRow - 1;
  const formulas = [];

  // Menggunakan sintaks titik koma (;) dan angka 0 yang 100% didukung locale Indonesia
  for (let r = 2; r <= lastRow; r++) {
    formulas.push([
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 2; 0); ""))',   // C: Product Name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 8; 0); ""))',   // D: Lokasi Rack
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 7; 0); ""))',   // E: Stock Available
      0,                                                                                        // F: Stock Bad
      0,                                                                                        // G: Stock LDP
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 3; 0); "MTG - Menteng"))', // H: Hub
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 5; 0); ""))',   // I: expiry_date
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 6; 0); ""))',   // J: msltc
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 7; 0); ""))',   // K: qty_system
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 8; 0); ""))',   // L: rack_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 9; 0); ""))',   // M: l1_category_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 10; 0); ""))',  // N: l2_category_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 11; 0); ""))',  // O: MSLTC_date
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 12; 0); ""))',  // P: remaining days
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; \'Data Update\'!A:N; 13; 0); ""))'   // Q: alert
    ]);
  }

  mainSheet.getRange(2, 3, numRows, 15).setValues(formulas);
  SpreadsheetApp.flush();
  ss.toast('✅ Rumus VLOOKUP (sintaks regional titik koma ;) berhasil dipasang untuk ' + numRows + ' baris!', 'Rumus Pulih ⚡', 5);
}

function updateDataManual() {
  syncDataUpdateToMainList(false);
}

// ── 5. SUBMENU FILTER KATEGORI ALERT (WARNING, HARD WARNING, CRITICAL) DI GOOGLE SHEET ──

function filterSheetAlertAllWarningCritical() {
  applySheetAlertFilter('ALL', '🟢 Semua Alert (Warning, Hard Warning & Critical)');
}

function filterSheetAlertCriticalOnly() {
  applySheetAlertFilter('CRITICAL', '🔴 Hanya Critical (Sisa ≤ 0 Hari)');
}

function filterSheetAlertHardWarningOnly() {
  applySheetAlertFilter('HARD_WARNING', '🔴 Hanya Hard Warning (Sisa 1 Hari)');
}

function filterSheetAlertWarningOnly() {
  applySheetAlertFilter('WARNING', '🟡 Hanya Warning (Sisa 2-3 Hari)');
}

function filterSheetAlertCriticalAndHard() {
  applySheetAlertFilter('CRITICAL_AND_HARD', '🔥 Critical & Hard Warning');
}

function resetSheetAlertFilter() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheets = ['Main List SKU', 'Data Update'];
  let totalUnhidden = 0;

  targetSheets.forEach(function(sName) {
    const sheet = ss.getSheetByName(sName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.showRows(2, lastRow - 1);
      totalUnhidden += (lastRow - 1);
    }
  });

  SpreadsheetApp.flush();
  ss.toast('✅ Filter di-reset! Seluruh baris kini ditampilkan kembali.', 'Reset Filter Berhasil', 4);
}

function applySheetAlertFilter(mode, label) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  const activeName = activeSheet.getName();

  // Jika sedang membuka Data Update, filter sheet tersebut; jika tidak, gunakan Main List SKU
  const targetSheet = (activeName === 'Data Update') ? activeSheet : (ss.getSheetByName('Main List SKU') || activeSheet);
  const lastRow = targetSheet.getLastRow();

  if (lastRow <= 1) {
    ss.toast('Sheet belum memiliki data baris untuk difilter.', 'Info', 3);
    return;
  }

  ss.setActiveSheet(targetSheet);
  targetSheet.showRows(2, lastRow - 1);

  // Deteksi kolom secara dinamis berdasarkan header di Baris 1
  const headerCols = targetSheet.getRange(1, 1, 1, targetSheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim().toLowerCase();
  });

  const skuColIdx = headerCols.indexOf('sku') !== -1 ? headerCols.indexOf('sku') : (headerCols.indexOf('sku_number') !== -1 ? headerCols.indexOf('sku_number') : 1);
  const remDaysIdx = headerCols.indexOf('remaining days') !== -1 ? headerCols.indexOf('remaining days') : (headerCols.indexOf('remaining_days') !== -1 ? headerCols.indexOf('remaining_days') : 15);
  const alertIdx = headerCols.indexOf('alert') !== -1 ? headerCols.indexOf('alert') : 16;

  const dataRange = targetSheet.getRange(2, 1, lastRow - 1, targetSheet.getLastColumn()).getValues();
  let matchedCount = 0;
  let hiddenCount = 0;

  for (let r = 0; r < dataRange.length; r++) {
    const row = dataRange[r];
    const sku = String(row[skuColIdx] || '').trim();
    if (!sku) continue; // lewati baris kosong

    const remDaysRaw = row[remDaysIdx];
    const remainingDays = (remDaysRaw !== '' && !isNaN(Number(remDaysRaw))) ? Number(remDaysRaw) : NaN;
    const alertText = String(row[alertIdx] || '').toLowerCase();

    const isCritical = alertText.includes('critical') || (!isNaN(remainingDays) && remainingDays <= 0);
    const isHard = alertText.includes('hard') || (!isNaN(remainingDays) && remainingDays === 1);
    const isWarn = (!alertText.includes('hard') && alertText.includes('warning')) || (!isNaN(remainingDays) && remainingDays >= 2 && remainingDays <= 3);

    let match = false;
    if (mode === 'ALL') {
      match = isCritical || isHard || isWarn;
    } else if (mode === 'CRITICAL') {
      match = isCritical;
    } else if (mode === 'HARD_WARNING') {
      match = isHard;
    } else if (mode === 'WARNING') {
      match = isWarn;
    } else if (mode === 'CRITICAL_AND_HARD') {
      match = isCritical || isHard;
    }

    const rowNumber = r + 2;
    if (match) {
      matchedCount++;
    } else {
      targetSheet.hideRows(rowNumber);
      hiddenCount++;
    }
  }

  SpreadsheetApp.flush();
  if (matchedCount === 0) {
    ss.toast('Filter ' + label + ' aktif: Tidak ada SKU dengan status tersebut saat ini (' + hiddenCount + ' baris disembunyikan).', 'Info Filter', 5);
  } else {
    ss.toast('Filter ' + label + ' aktif! Menampilkan ' + matchedCount + ' SKU (' + hiddenCount + ' baris disembunyikan).', 'Filter Diterapkan 🎯', 5);
  }
}

// ── 5. FITUR BACKUP: HASIL EDS KE SHEET "Backup Data" ──

function backupHasilEdsManual() {
  const res = backupHasilEdsToBackupSheet(false);
  SpreadsheetApp.getUi().alert('Hasil Backup', res.message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function backupAndResetHasilEdsManual() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    'Konfirmasi Backup & Reset',
    'Semua data di "Hasil EDS" akan dibackup ke sheet "Backup Data", lalu baris data pada "Hasil EDS" akan dikosongkan untuk persiapan shift/hari berikutnya.\n\nLanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const res = backupHasilEdsToBackupSheet(true);
  ui.alert('Selesai', res.message, ui.ButtonSet.OK);
}

function backupHasilEdsToBackupSheet(autoClear) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hasilSheet = ss.getSheetByName('Hasil EDS');

  if (!hasilSheet || hasilSheet.getLastRow() <= 1) {
    return {
      success: false,
      message: 'Sheet "Hasil EDS" kosong atau belum memiliki data untuk di-backup.'
    };
  }

  let backupSheet = ss.getSheetByName('Backup Data') || ss.getSheetByName('Backup data');
  const headers = [
    "SKU Number", "Nama SKU", "SLOC Existing", "SLOC Actual",
    "Expired Date", "Fisik Good", "Fisik Bad", "Sales (jika ada)",
    "Reason SLOC", "Reason Bad", "Evidance 1", "Evidance 2",
    "Evidance Link 1", "Evidance Link 2", "#REF!", "MSLTC",
    "SKU No", "Input by", "Timestamp", "Waktu Backup", "Batch ID"
  ];

  if (!backupSheet) {
    backupSheet = ss.insertSheet('Backup Data');
    backupSheet.appendRow(headers);
    backupSheet.getRange(1, 1, 1, headers.length)
      .setBackground('#1e293b')
      .setFontColor('#fbbf24')
      .setFontWeight('bold');
    backupSheet.setFrozenRows(1);
  } else if (backupSheet.getLastRow() === 0) {
    backupSheet.appendRow(headers);
  }

  const hasilData = hasilSheet.getDataRange().getValues();
  const dataRows = hasilData.slice(1).filter(r => String(r[0] || r[16] || '').trim() !== '');

  if (dataRows.length === 0) {
    return {
      success: false,
      message: 'Tidak ada baris data valid di Hasil EDS.'
    };
  }

  const existingBackup = backupSheet.getLastRow() > 1 ? backupSheet.getDataRange().getValues() : [];
  const existingKeys = new Set();
  for (let i = 1; i < existingBackup.length; i++) {
    const bSku = String(existingBackup[i][0] || existingBackup[i][16] || '').trim().toLowerCase();
    const bTime = String(existingBackup[i][18] || '').trim();
    if (bSku) {
      existingKeys.add(bSku + '___' + bTime);
    }
  }

  const now = new Date();
  const waktuBackup = Utilities.formatDate(now, "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");
  const batchId = 'BATCH-' + Utilities.formatDate(now, "Asia/Jakarta", "yyyyMMdd-HHmmss");

  const rowsToAppend = [];
  let duplicateCount = 0;

  for (let j = 0; j < dataRows.length; j++) {
    const row = dataRows[j];
    const sku = String(row[0] || row[16] || '').trim().toLowerCase();
    const time = String(row[18] || '').trim();
    const key = sku + '___' + time;

    if (!existingKeys.has(key)) {
      const fullRow = row.slice(0, 19);
      while (fullRow.length < 19) fullRow.push('');
      fullRow.push(waktuBackup);
      fullRow.push(batchId);
      rowsToAppend.push(fullRow);
      existingKeys.add(key);
    } else {
      duplicateCount++;
    }
  }

  if (rowsToAppend.length > 0) {
    const startRow = backupSheet.getLastRow() + 1;
    backupSheet.getRange(startRow, 1, rowsToAppend.length, headers.length).setValues(rowsToAppend);
  }

  PropertiesService.getScriptProperties().setProperty('LAST_BACKUP_TIMESTAMP', waktuBackup);

  if (autoClear) {
    const lastRow = hasilSheet.getLastRow();
    if (lastRow > 1) {
      hasilSheet.deleteRows(2, lastRow - 1);
    }
    try {
      const mainSheet = ss.getSheetByName('Main List SKU');
      if (mainSheet && mainSheet.getLastRow() > 1) {
        mainSheet.getRange(2, 18, mainSheet.getLastRow() - 1, 3).clearContent();
      }
    } catch(eMain) {
      console.warn('Gagal reset kolom Done di Main List SKU:', eMain);
    }
  }

  let msg = 'Berhasil mem-backup ' + rowsToAppend.length + ' baris ke sheet "Backup Data"! (Batch: ' + batchId + ')';
  if (duplicateCount > 0) {
    msg += '\n(' + duplicateCount + ' baris telah ada sebelumnya di backup dan dilewati).';
  }
  if (autoClear) {
    msg += '\nSheet "Hasil EDS" kini telah bersih dan siap digunakan untuk sesi berikutnya.';
  }

  return {
    success: true,
    message: msg,
    appendedCount: rowsToAppend.length,
    duplicateCount: duplicateCount,
    batchId: batchId
  };
}

// ── 6. WEB APP ENDPOINT (POST DARI SUPERAPP MTG) ──

function doPost(e) {
  try {
    let payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hasilSheet = ss.getSheetByName('Hasil EDS') || ss.insertSheet('Hasil EDS');

    if (hasilSheet.getLastRow() === 0) {
      hasilSheet.appendRow([
        "SKU Number", "Nama SKU", "SLOC Existing", "SLOC Actual",
        "Expired Date", "Fisik Good", "Fisik Bad", "Sales (jika ada)",
        "Reason SLOC", "Reason Bad", "Evidance 1", "Evidance 2",
        "Evidance Link 1", "Evidance Link 2", "#REF!", "MSLTC",
        "SKU No", "Input by", "Timestamp"
      ]);
    }

    const skuNo = String(payload.skuNo || payload.sku || payload.sku_number || '').trim();
    const namaSku = String(payload.namaSku || payload.productName || '').trim();
    const slocExisting = String(payload.slocExisting || payload.lokasiRack || '').trim();
    const slocActual = String(payload.slocActual || 'Match').trim();
    const expiredDate = String(payload.expiredDate || '').trim();
    const fisikGood = payload.fisikGood !== undefined ? payload.fisikGood : '';
    const fisikBad = payload.fisikBad !== undefined ? payload.fisikBad : '';
    const sales = payload.sales !== undefined ? payload.sales : '';
    const reasonSloc = String(payload.reasonSloc || '').trim();
    const reasonBad = String(payload.reasonBad || '').trim();
    const inputBy = String(payload.inputBy || payload.pic || payload.penginput || '').trim();
    const msltc = String(payload.msltc || '').trim();

    let evidanceLink1 = '';
    let evidanceLink2 = '';
    let evidance1Name = '';
    let evidance2Name = '';

    if (payload.imageBase64) {
      try {
        const folderName = 'ED_SWEEPER_MTG_EVIDANCE';
        let folder;
        const folders = DriveApp.getFoldersByName(folderName);
        if (folders.hasNext()) {
          folder = folders.next();
        } else {
          folder = DriveApp.createFolder(folderName);
          folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        }

        const dateStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyyMMdd_HHmmss");
        evidance1Name = 'EDS_' + skuNo + '_1_' + dateStr + '.jpg';
        const cleanBase64_1 = payload.imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
        const decoded1 = Utilities.base64Decode(cleanBase64_1);
        const blob1 = Utilities.newBlob(decoded1, 'image/jpeg', evidance1Name);
        const file1 = folder.createFile(blob1);
        file1.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        evidanceLink1 = file1.getUrl();

        if (payload.imageBase64_2) {
          evidance2Name = 'EDS_' + skuNo + '_2_' + dateStr + '.jpg';
          const cleanBase64_2 = payload.imageBase64_2.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
          const decoded2 = Utilities.base64Decode(cleanBase64_2);
          const blob2 = Utilities.newBlob(decoded2, 'image/jpeg', evidance2Name);
          const file2 = folder.createFile(blob2);
          file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          evidanceLink2 = file2.getUrl();
        }
      } catch (errUpload) {
        console.warn('Gagal upload foto:', errUpload);
      }
    }

    const timestamp = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");

    const rowData = [
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
      "",
      msltc,
      skuNo,
      inputBy,
      timestamp
    ];

    // ── CEK APAKAH SKU SUDAH ADA DI HASIL EDS (MODE UPDATE / EDIT) ──
    let existingRowIdx = -1;
    const lastRowHasil = hasilSheet.getLastRow();
    if (lastRowHasil > 1) {
      const existingSkus = hasilSheet.getRange(2, 1, lastRowHasil - 1, 1).getValues();
      for (let r = 0; r < existingSkus.length; r++) {
        const sVal = String(existingSkus[r][0] || '').trim().toLowerCase();
        if (sVal && (sVal === skuNo.toLowerCase() || sVal.includes(skuNo.toLowerCase()))) {
          existingRowIdx = r + 2;
          break;
        }
      }
    }

    if (existingRowIdx !== -1) {
      // Update baris yang sudah ada (tidak membuat baris duplikat)
      hasilSheet.getRange(existingRowIdx, 1, 1, rowData.length).setValues([rowData]);
    } else {
      // Tambah baris baru jika memang SKU baru
      hasilSheet.appendRow(rowData);
    }

    // ── AUTO-UPDATE MAIN LIST SKU (KOLOM R, S, T) ──
    try {
      const mainSheet = ss.getSheetByName('Main List SKU');
      if (mainSheet && skuNo) {
        const lastRow = mainSheet.getLastRow();
        if (lastRow > 1) {
          const skuColValues = mainSheet.getRange(2, 2, lastRow - 1, 1).getValues(); // Col B (SKU)
          for (let r = 0; r < skuColValues.length; r++) {
            const rawVal = String(skuColValues[r][0] || '').trim();
            if (rawVal && (rawVal.toLowerCase() === skuNo.toLowerCase() || rawVal.includes(skuNo))) {
              const targetRow = r + 2;
              mainSheet.getRange(targetRow, 18).setValue('Done'); // Col R: Done
              const remaksVal = reasonBad || reasonSloc || payload.remaks || 'Sesuai';
              mainSheet.getRange(targetRow, 19).setValue(remaksVal); // Col S: Remaks DCC
              const qtySys = payload.qty_system || mainSheet.getRange(targetRow, 11).getValue() || 0;
              mainSheet.getRange(targetRow, 20).setValue(fisikGood + '/' + qtySys); // Col T: Fisik/System
              break;
            }
          }
        }
      }
    } catch (errSync) {
      console.warn('Gagal auto-update kolom R/S/T Main List SKU:', errSync);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data audit SKU ' + skuNo + ' berhasil disimpan ke sheet Hasil EDS.',
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

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'success',
    message: 'ED Sweeper Web App is Active & Ready.'
  })).setMimeType(ContentService.MimeType.JSON);
}
