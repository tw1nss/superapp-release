/**
 * ==============================================================================
 * 🚀 GOOGLE APPS SCRIPT: ED SWEEPER MTG (INTEGRATED)
 * Spreadsheet Target: Dashboard STK MTG 2K26
 * ID: 1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g
 * 
 * ALUR SISTEM & NAMA SHEET:
 * 1. Sheet "Data Update ED Sweeper" = Data mentah (raw data) produk, rak, stok & tanggal kadaluarsa.
 * 2. Sheet "Main List SKU ED Sweeper" = List tugas harian! SKU diisi manual oleh supervisor 
 *    atau dimasukkan via menu otomatis (Critical & Hard Warning).
 * 3. Sheet "Hasil EDS ED Sweeper" = Merekap hasil audit petugas yang diinput melalui SuperApp MTG (doPost).
 * 4. Sheet "Backup Data ED Sweeper" = Arsip backup hasil rekapan EDS (Backup Manual & Otomatis 23:00 WIB).
 * ==============================================================================
 */

// =============================
// ⚙️ CONFIG SUPERSET ASTRODASH & EDS
// =============================
var SUPERSET_CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  TARGET_FILE_ID: "1fVQwSOoIU9pT5RHWi6-m8qCf_T0rQPZxEf_WuhlaD2g",
  DEFAULT_CHART_ID: 24592, // Slice ID ED Sweeper dari dashboard AstroDash
  DASHBOARD_PAGE_ID: "U3z99CtEM_b7ZlpM-m6TD",
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// =============================
// 📑 NAMA SHEET KHUSUS ED SWEEPER
// =============================
var EDS_SHEETS = {
  DATA_UPDATE: "Data Update ED Sweeper",
  MAIN_LIST: "Main List SKU ED Sweeper",
  HASIL: "Hasil EDS ED Sweeper",
  BACKUP: "Backup Data ED Sweeper"
};

// Helper: Ambil spreadsheet target (Bisa bound atau standalone ID)
function getEdsSpreadsheet() {
  try {
    if (SUPERSET_CONFIG.TARGET_FILE_ID) {
      return SpreadsheetApp.openById(SUPERSET_CONFIG.TARGET_FILE_ID);
    }
  } catch (e) {
    console.warn("Gagal openById EDS, menggunakan Active Spreadsheet:", e);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// 🔍 HELPER FLEKSIBEL: Cari sheet EDS dengan toleransi typo / nama lama
function getEdsSheet(type) {
  var ss = getEdsSpreadsheet();
  if (type === 'MAIN_LIST') {
    return ss.getSheetByName('Main List SKU ED Sweeper') || 
           ss.getSheetByName('Main List SKU ED Sweepe') || 
           ss.getSheetByName('Mainlist SKU ED Sweeper') || 
           ss.getSheetByName('Main List ED Sweeper') || 
           ss.getSheetByName('Main List SKU');
  }
  if (type === 'DATA_UPDATE') {
    return ss.getSheetByName('Data Update ED Sweeper') || 
           ss.getSheetByName('Data Update ED Sweepe') || 
           ss.getSheetByName('Data Update');
  }
  if (type === 'HASIL') {
    return ss.getSheetByName('Hasil EDS ED Sweeper') || 
           ss.getSheetByName('Hasil ED Sweeper') || 
           ss.getSheetByName('Hasil EDS');
  }
  if (type === 'BACKUP') {
    return ss.getSheetByName('Backup Data ED Sweeper') || 
           ss.getSheetByName('Backup ED Sweeper') || 
           ss.getSheetByName('Backup Data') || 
           ss.getSheetByName('Backup data');
  }
  return null;
}

// ── 1. MENU CUSTOM DI GOOGLE SHEETS ──
function onOpen() {
  try {
    ensureDailyBackupTrigger();
    ensureAutoSupersetTrigger();
  } catch (e) {
    console.warn('Gagal set trigger EDS:', e);
  }

  var ui = SpreadsheetApp.getUi();
  // Bangun menu Superset & DCC jika function-nya ada
  if (typeof buildSupersetMenu === 'function') buildSupersetMenu(ui);
  if (typeof buildDccMenu === 'function') buildDccMenu(ui);
  // Bangun menu ED Sweeper
  buildEdSweeperMenu(ui);
}

function buildEdSweeperMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ ED Sweeper Control')
    .addItem('🔄 Tarik Data Superset ke Data Update', 'updateDataFromSupersetManual')
    .addSeparator()
    .addSubMenu(ui.createMenu('📥 Masukkan SKU Tugas ke Main List')
      .addItem('🔥 Masukkan SKU Critical & Hard Warning', 'populateMainListCriticalAndHard')
      .addItem('🔴 Masukkan Hanya SKU Critical', 'populateMainListCriticalOnly')
      .addItem('🟠 Masukkan Hanya SKU Hard Warning', 'populateMainListHardWarningOnly')
      .addItem('🟢 Masukkan Semua Alert (Warning, Hard & Critical)', 'populateMainListAllAlerts')
    )
    .addItem('📋 Sinkronkan Detail SKU di Main List', 'syncDataUpdateToMainListManual')
    .addItem('🧹 Kosongkan / Reset Sheet Main List SKU', 'clearMainListSkuPrompt')
    .addItem('🔧 Pasang Rumus VLOOKUP (Opsional)', 'restoreMainListFormulas')
    .addSeparator()
    .addSubMenu(ui.createMenu('🎯 Filter Kategori Alert (Tampilan Saja)')
      .addItem('🔥 Critical & Hard Warning', 'filterSheetAlertCriticalAndHard')
      .addItem('🔴 Hanya Critical', 'filterSheetAlertCriticalOnly')
      .addItem('🔴 Hanya Hard Warning', 'filterSheetAlertHardWarningOnly')
      .addItem('🟡 Hanya Warning', 'filterSheetAlertWarningOnly')
      .addItem('🟢 Semua Alert (Warning, Hard Warning & Critical)', 'filterSheetAlertAllWarningCritical')
      .addSeparator()
      .addItem('🔄 Reset / Tampilkan Semua Baris', 'resetSheetAlertFilter')
    )
    .addSeparator()
    .addItem('📦 Backup Data Hasil EDS & Kosongkan Main List', 'backupHasilEdsManual')
    .addItem('🔄 Backup & Reset Total (Hasil EDS + Main List)', 'backupAndResetHasilEdsManual')
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'setSupersetCookiePrompt')
    .addItem('🎯 Set ID Chart Superset EDS', 'setSupersetChartIdPrompt')
    .addToUi();
}

function showDeployGuidePrompt() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '📋 Panduan Pasang WebApp URL ke SuperApp MTG',
    'Langkah agar hasil audit dari SuperApp masuk ke sheet Hasil EDS:\n\n' +
    '1. Di menu atas Apps Script ini, klik tombol biru "Terapkan" (Deploy) ➔ "Penerapan baru".\n' +
    '2. Klik ikon Gerigi (⚙️) ➔ Pilih "Aplikasi web".\n' +
    '3. Konfigurasi:\n' +
    '   - Jalankan sebagai: "Saya"\n' +
    '   - Yang memiliki akses: "Siapa saja"\n' +
    '4. Klik "Terapkan" ➔ Salin (Copy) "URL Aplikasi Web" yang berakhiran /exec.\n' +
    '5. Buka SuperApp MTG di HP ➔ Masuk menu Expired Date Sweeper ➔ Tab Scan/Input ➔ Klik banner/tombol "Koneksi WebApp" dan paste URL tersebut.\n\n' +
    '✅ Seketika setiap audit yang dikirim dari HP akan langsung masuk ke sheet Hasil EDS dan kolom Done otomatis terisi!',
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
    console.log('Background Daily Backup Trigger EDS (23:00 WIB) aktif.');
  }
}

function dailyAutoBackupTask() {
  try {
    backupHasilEdsToBackupSheet(false);
  } catch (err) {
    console.error('Error saat auto-backup harian EDS:', err);
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
    console.log('Background Auto-Pull Superset EDS (Setiap 5 Menit) aktif.');
  }
}

function autoPullSupersetBackground() {
  try {
    const updateSheet = getEdsSheet('DATA_UPDATE');
    const targetName = updateSheet ? updateSheet.getName() : EDS_SHEETS.DATA_UPDATE;
    pullSupersetDataToSheet(targetName, true);
  } catch (e) {
    console.error('Background auto-pull Superset EDS error:', e);
  }
}

function updateDataFromSupersetManual() {
  const ss = getEdsSpreadsheet();
  const updateSheet = getEdsSheet('DATA_UPDATE');
  const targetName = updateSheet ? updateSheet.getName() : EDS_SHEETS.DATA_UPDATE;
  ss.toast('⚡ Menghubungkan ke AstroDash Superset...', 'Loading', 3);
  pullSupersetDataToSheet(targetName, false);
}

function setSupersetChartIdPrompt() {
  const ui = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty('SUPERSET_CHART_ID_EDS') || SUPERSET_CONFIG.DEFAULT_CHART_ID;
  const resp = ui.prompt(
    '🎯 Set ID Chart Superset ED Sweeper',
    'Masukkan ID Chart (Slice ID) untuk data ED Sweeper (Default: ' + current + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() === ui.Button.OK) {
    const id = resp.getResponseText().trim();
    if (id) {
      PropertiesService.getScriptProperties().setProperty('SUPERSET_CHART_ID_EDS', id);
      ui.alert('Sukses', '✅ ID Chart ED Sweeper berhasil diset ke: ' + id, ui.ButtonSet.OK);
    }
  }
}

function pullSupersetDataToSheet(sheetName, isSilent) {
  const props = PropertiesService.getScriptProperties();
  const cookie = props.getProperty('MY_COOKIE');
  let chartId = props.getProperty('SUPERSET_CHART_ID_EDS') || props.getProperty('SUPERSET_CHART_ID');
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
    if (!isSilent) {
      getEdsSpreadsheet().toast('✅ Berhasil menarik ' + data.length + ' data terbaru dari AstroDash Superset ke "' + sheetName + '"!', 'Update Sukses ⚡', 5);
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
  const ss = getEdsSpreadsheet();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  if (!data || data.length === 0) return;

  // Filter alert produk
  const filteredData = data.filter(function(item) {
    const alertVal = String(item.alert || item.Alert || item.ALERT || item.status || '').toLowerCase();
    const remDaysRaw = item['remaining days'] !== undefined ? item['remaining days'] : (item.remaining_days !== undefined ? item.remaining_days : (item.remainingDays !== undefined ? item.remainingDays : ''));
    const remainingDays = (remDaysRaw !== '' && !isNaN(Number(remDaysRaw))) ? Number(remDaysRaw) : NaN;

    const isCritical = alertVal.includes('critical') || (!isNaN(remainingDays) && remainingDays <= 0);
    const isHardWarning = alertVal.includes('hard') || (!isNaN(remainingDays) && remainingDays === 1);
    const isWarning = (!alertVal.includes('hard') && alertVal.includes('warning')) || (!isNaN(remainingDays) && remainingDays >= 2 && remainingDays <= 3);

    return isCritical || isHardWarning || isWarning;
  });

  const finalData = filteredData.length > 0 ? filteredData : data;
  const headers = Object.keys(finalData[0]);

  const rows = finalData.map(function(item) {
    return headers.map(function(key) {
      const value = item[key];
      const cleanKey = key.toLowerCase();

      if (cleanKey.includes("sku")) {
        return String(value);
      }

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

// ── 4. SINKRONISASI DETAIL: DATA UPDATE ➔ MAIN LIST SKU ──

function syncDataUpdateToMainListManual() {
  syncDataUpdateToMainList(false);
}

function syncDataUpdateToMainList(isSilent) {
  const ss = getEdsSpreadsheet();
  const updateSheet = getEdsSheet('DATA_UPDATE');
  const mainSheet = getEdsSheet('MAIN_LIST');
  const hasilSheet = getEdsSheet('HASIL');

  if (!updateSheet || updateSheet.getLastRow() <= 1) {
    if (!isSilent) ss.toast('Sheet Data Update belum memiliki data. Tarik data dari Superset terlebih dahulu.', 'Perhatian', 4);
    return;
  }

  if (!mainSheet) {
    if (!isSilent) ss.toast('Sheet Main List SKU ED Sweeper tidak ditemukan.', 'Error', 4);
    return;
  }

  const lastRow = mainSheet.getLastRow();
  if (lastRow <= 1) {
    if (!isSilent) {
      ss.toast('Sheet "' + mainSheet.getName() + '" masih kosong. Silakan gunakan menu "Masukkan SKU Tugas ke Main List" terlebih dahulu.', 'Info', 5);
    }
    return;
  }

  const mainHeaders = mainSheet.getRange(1, 1, 1, Math.max(mainSheet.getLastColumn(), 20)).getValues()[0].map(function(h) {
    return String(h || '').trim().toLowerCase();
  });
  let mainSkuColIdx = mainHeaders.indexOf('sku');
  if (mainSkuColIdx === -1) mainSkuColIdx = mainHeaders.indexOf('sku_number');
  if (mainSkuColIdx === -1) mainSkuColIdx = mainHeaders.indexOf('sku number');
  if (mainSkuColIdx === -1) mainSkuColIdx = 1;

  const numRows = lastRow - 1;
  const numCols = Math.max(mainSheet.getLastColumn(), 20);
  const mainDataRange = mainSheet.getRange(2, 1, numRows, numCols);
  const mainRows = mainDataRange.getValues();

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

  const todayDate = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy");
  let matchedCount = 0;

  for (let r = 0; r < mainRows.length; r++) {
    const row = mainRows[r];
    let skuVal = String(row[mainSkuColIdx] || '').trim();
    if (!skuVal && mainSkuColIdx !== 1) skuVal = String(row[1] || '').trim();
    if (!skuVal && mainSkuColIdx !== 0) skuVal = String(row[0] || '').trim();

    if (!skuVal) continue;

    const skuKey = skuVal.toLowerCase();
    const upItem = updateDataMap.get(skuKey);
    const audit = hasilMap.get(skuKey);

    if (!row[0]) {
      row[0] = todayDate;
    }

    if (mainSkuColIdx === 1) {
      row[1] = skuVal;
    }

    if (upItem) {
      row[2] = upItem.productName;
      row[3] = upItem.rackName;
      row[4] = upItem.qtySystem;
      if (row[5] === '' || row[5] === undefined || row[5] === null) row[5] = 0;
      if (row[6] === '' || row[6] === undefined || row[6] === null) row[6] = 0;
      row[7] = upItem.hub;
      row[8] = upItem.expiryDate;
      row[9] = upItem.msltc;
      row[10] = upItem.qtySystem;
      row[11] = upItem.rackName;
      row[12] = upItem.l1Category;
      row[13] = upItem.l2Category;
      row[14] = upItem.msltcDate;
      row[15] = upItem.remainingDays;
      row[16] = upItem.alert;
      matchedCount++;
    }

    if (audit) {
      row[17] = 'Done';
      row[18] = audit.remaks;
      const qtySys = upItem ? upItem.qtySystem : (row[10] || row[4] || 0);
      row[19] = audit.fisikGood + '/' + qtySys;
    }
  }

  mainDataRange.setValues(mainRows);
  SpreadsheetApp.flush();

  if (!isSilent) {
    ss.toast('✅ Berhasil menyinkronkan detail untuk ' + matchedCount + ' SKU di "' + mainSheet.getName() + '"!', 'Sinkronisasi Sukses ⚡', 5);
  }
}

// ── 4B. FITUR OTOMATIS: MASUKKAN SKU TUGAS KE MAIN LIST EDS ──

function populateMainListCriticalAndHard() {
  populateMainListFromAlert('CRITICAL_AND_HARD', 'Critical & Hard Warning');
}

function populateMainListCriticalOnly() {
  populateMainListFromAlert('CRITICAL', 'Hanya Critical');
}

function populateMainListHardWarningOnly() {
  populateMainListFromAlert('HARD_WARNING', 'Hanya Hard Warning');
}

function populateMainListAllAlerts() {
  populateMainListFromAlert('ALL', 'Semua Alert (Warning, Hard & Critical)');
}

function populateMainListFromAlert(mode, label) {
  const ss = getEdsSpreadsheet();
  const updateSheet = getEdsSheet('DATA_UPDATE');
  const mainSheet = getEdsSheet('MAIN_LIST');
  const hasilSheet = getEdsSheet('HASIL');

  if (!updateSheet || updateSheet.getLastRow() <= 1) {
    SpreadsheetApp.getUi().alert('Data Update Kosong', 'Sheet Data Update belum memiliki data. Silakan klik menu "Tarik Data Superset" terlebih dahulu.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }

  if (!mainSheet) {
    SpreadsheetApp.getUi().alert('Error', 'Sheet Main List SKU ED Sweeper tidak ditemukan.\nPastikan nama tab berakhiran "ED Sweeper".', SpreadsheetApp.getUi().ButtonSet.OK);
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

  const todayDate = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy");
  const filteredRows = [];
  const seenSkus = new Set();

  for (let i = 1; i < upData.length; i++) {
    const row = upData[i];
    const sku = String(row[colSku] || '').trim();
    if (!sku) continue;

    const skuKey = sku.toLowerCase();
    if (seenSkus.has(skuKey)) continue;

    const remDaysRaw = row[colRemDays];
    const remainingDays = (remDaysRaw !== '' && !isNaN(Number(remDaysRaw))) ? Number(remDaysRaw) : NaN;
    const alertText = String(row[colAlert] || '').toLowerCase();

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

    if (!match) continue;

    seenSkus.add(skuKey);
    const audit = hasilMap.get(skuKey);
    const doneVal = audit ? 'Done' : '';
    const remaksVal = audit ? audit.remaks : '';
    const qtySys = (row[colQty] !== '' && !isNaN(row[colQty])) ? Number(row[colQty]) : (row[colQty] || 0);
    const fisikVal = audit ? (audit.fisikGood + '/' + qtySys) : '';

    filteredRows.push([
      todayDate,                  // Kolom A: Tanggal
      sku,                        // Kolom B: SKU
      row[colName] || '',         // Kolom C: Product Name
      row[colRack] || '',         // Kolom D: Lokasi Rack
      qtySys,                     // Kolom E: Stock Available
      0,                          // Kolom F: Stock Bad
      0,                          // Kolom G: Stock LDP
      row[colHub] || 'MTG - Menteng', // Kolom H: Hub
      row[colExp] || '',          // Kolom I: expiry_date
      row[colMsltc] || '',        // Kolom J: msltc
      qtySys,                     // Kolom K: qty_system
      row[colRack] || '',         // Kolom L: rack_name
      row[colCat1] || '',         // Kolom M: l1_category_name
      row[colCat2] || '',         // Kolom N: l2_category_name
      row[colMsDate] || '',       // Kolom O: MSLTC_date
      row[colRemDays] !== undefined ? row[colRemDays] : '', // Kolom P: remaining days
      row[colAlert] || '',        // Kolom Q: alert
      doneVal,                    // Kolom R: Done
      remaksVal,                  // Kolom S: Remaks DCC
      fisikVal                    // Kolom T: Fisik/System
    ]);
  }

  if (filteredRows.length === 0) {
    SpreadsheetApp.getUi().alert('Info', 'Tidak ditemukan produk dengan kategori alert "' + label + '" di Data Update.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }

  const confirm = SpreadsheetApp.getUi().alert(
    'Konfirmasi Masukkan Tugas SKU',
    'Ditemukan ' + filteredRows.length + ' SKU berstatus ' + label + '.\n\nApakah Anda ingin memasukkan ' + filteredRows.length + ' SKU ini ke sheet "' + mainSheet.getName() + '" sebagai daftar tugas?',
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (confirm !== SpreadsheetApp.getUi().Button.YES) return;

  // Unhide semua baris di Main List SKU ED Sweeper
  const maxRows = mainSheet.getMaxRows();
  if (maxRows > 1) {
    mainSheet.showRows(1, maxRows);
  }

  // Bersihkan baris lama di Main List SKU ED Sweeper dari baris 2 ke bawah
  const currentLastRow = mainSheet.getLastRow();
  if (currentLastRow > 1) {
    mainSheet.getRange(2, 1, currentLastRow - 1, Math.max(mainSheet.getLastColumn(), 20)).clearContent();
  }

  // Tulis baris baru yang bersih dan rapi
  mainSheet.getRange(2, 1, filteredRows.length, 20).setValues(filteredRows);
  SpreadsheetApp.flush();

  ss.setActiveSheet(mainSheet);
  ss.toast('✅ Berhasil memasukkan ' + filteredRows.length + ' SKU (' + label + ') ke "' + mainSheet.getName() + '"!', 'Sukses ⚡', 5);
}

// ── 4C. FITUR RESET / KOSONGKAN MAIN LIST SKU EDS ──

function clearMainListSkuPrompt() {
  const ui = SpreadsheetApp.getUi();
  const mainSheet = getEdsSheet('MAIN_LIST');
  if (!mainSheet) {
    ui.alert('Error', 'Sheet Main List SKU ED Sweeper tidak ditemukan.', ui.ButtonSet.OK);
    return;
  }

  const confirm = ui.alert(
    '🧹 Konfirmasi Kosongkan Main List',
    'Apakah Anda yakin ingin mengosongkan seluruh baris data tugas di sheet "' + mainSheet.getName() + '"?\n\n(Semua baris tugas akan dihapus dan disiapkan kosong kembali).',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const ss = getEdsSpreadsheet();
  const maxRows = mainSheet.getMaxRows();
  if (maxRows > 1) mainSheet.showRows(1, maxRows);
  const lastRow = mainSheet.getLastRow();
  if (lastRow > 1) {
    mainSheet.getRange(2, 1, lastRow - 1, Math.max(mainSheet.getLastColumn(), 20)).clearContent();
  }
  SpreadsheetApp.flush();
  ss.toast('✅ Sheet "' + mainSheet.getName() + '" berhasil dikosongkan!', 'Reset Berhasil', 4);
}

// ── 5. SUBMENU FILTER KATEGORI ALERT DI GOOGLE SHEET ──

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
  const mainSheet = getEdsSheet('MAIN_LIST');
  const updateSheet = getEdsSheet('DATA_UPDATE');
  const targetSheets = [mainSheet, updateSheet].filter(Boolean);

  targetSheets.forEach(function(sheet) {
    const maxRows = sheet.getMaxRows();
    if (maxRows > 1) {
      sheet.showRows(1, maxRows);
    }
  });

  SpreadsheetApp.flush();
  getEdsSpreadsheet().toast('✅ Filter di-reset! Seluruh baris kini ditampilkan kembali.', 'Reset Filter Berhasil', 4);
}

function applySheetAlertFilter(mode, label) {
  const ss = getEdsSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  const activeName = activeSheet.getName();

  const updateSheet = getEdsSheet('DATA_UPDATE');
  const mainSheet = getEdsSheet('MAIN_LIST');

  const targetSheet = (updateSheet && activeName === updateSheet.getName()) ? activeSheet : (mainSheet || activeSheet);
  const lastRow = targetSheet.getLastRow();

  if (lastRow <= 1) {
    ss.toast('Sheet belum memiliki data baris untuk difilter.', 'Info', 3);
    return;
  }

  ss.setActiveSheet(targetSheet);
  targetSheet.showRows(1, targetSheet.getMaxRows());

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
    if (!sku) continue;

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

// ── OPSIONAL: PASANG RUMUS VLOOKUP MAIN LIST EDS ──
function restoreMainListFormulas() {
  const ss = getEdsSpreadsheet();
  const mainSheet = getEdsSheet('MAIN_LIST');
  const updateSheet = getEdsSheet('DATA_UPDATE');

  if (!mainSheet) return;

  const lastRow = mainSheet.getLastRow();
  if (lastRow <= 1) {
    ss.toast('Sheet "' + mainSheet.getName() + '" masih kosong. Silakan gunakan menu "Masukkan SKU Tugas ke Main List" terlebih dahulu.', 'Perhatian', 4);
    return;
  }

  const numRows = lastRow - 1;
  const formulas = [];
  const srcSheetName = updateSheet ? updateSheet.getName() : EDS_SHEETS.DATA_UPDATE;
  const srcSheet = "'" + srcSheetName + "'!A:N";

  for (let r = 2; r <= lastRow; r++) {
    formulas.push([
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 2; 0); ""))',   // C: Product Name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 8; 0); ""))',   // D: Lokasi Rack
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 7; 0); ""))',   // E: Stock Available
      0,                                                                                      // F: Stock Bad
      0,                                                                                      // G: Stock LDP
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 3; 0); "MTG - Menteng"))', // H: Hub
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 5; 0); ""))',   // I: expiry_date
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 6; 0); ""))',   // J: msltc
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 7; 0); ""))',   // K: qty_system
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 8; 0); ""))',   // L: rack_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 9; 0); ""))',   // M: l1_category_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 10; 0); ""))',  // N: l2_category_name
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 11; 0); ""))',  // O: MSLTC_date
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 12; 0); ""))',  // P: remaining days
      '=IF(B' + r + '=""; ""; IFERROR(VLOOKUP(B' + r + '; ' + srcSheet + '; 13; 0); ""))'   // Q: alert
    ]);
  }

  mainSheet.getRange(2, 3, numRows, 15).setValues(formulas);
  SpreadsheetApp.flush();
  ss.toast('✅ Rumus VLOOKUP berhasil dipasang untuk ' + numRows + ' baris di "' + mainSheet.getName() + '"!', 'Rumus Pulih ⚡', 5);
}

function updateDataManual() {
  syncDataUpdateToMainList(false);
}

// ── 6. FITUR BACKUP: HASIL EDS KE SHEET BACKUP & AUTO-RESET MAIN LIST EDS ──

function backupHasilEdsManual() {
  const res = backupHasilEdsToBackupSheet(false);
  SpreadsheetApp.getUi().alert('Hasil Backup EDS', res.message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function backupAndResetHasilEdsManual() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    'Konfirmasi Backup & Reset Total ED Sweeper',
    'Semua data hasil audit EDS akan dibackup, lalu baris data pada Hasil EDS dan Main List SKU akan otomatis dikosongkan kembali untuk persiapan tugas berikutnya.\n\nLanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const res = backupHasilEdsToBackupSheet(true);
  ui.alert('Selesai', res.message, ui.ButtonSet.OK);
}

function backupHasilEdsToBackupSheet(autoClear) {
  const ss = getEdsSpreadsheet();
  const hasilSheet = getEdsSheet('HASIL');

  if (!hasilSheet || hasilSheet.getLastRow() <= 1) {
    return {
      success: false,
      message: 'Sheet Hasil EDS kosong atau belum memiliki data untuk di-backup.'
    };
  }

  let backupSheet = getEdsSheet('BACKUP');
  const headers = [
    "SKU Number", "Nama SKU", "SLOC Existing", "SLOC Actual",
    "Expired Date", "Fisik Good", "Fisik Bad", "Sales (jika ada)",
    "Reason SLOC", "Reason Bad", "Evidance 1", "Evidance 2",
    "Evidance Link 1", "Evidance Link 2", "#REF!", "MSLTC",
    "SKU No", "Input by", "Timestamp", "Waktu Backup", "Batch ID"
  ];

  if (!backupSheet) {
    backupSheet = ss.insertSheet(EDS_SHEETS.BACKUP);
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
      message: 'Tidak ada baris data valid di ' + hasilSheet.getName() + '.'
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
  const batchId = 'BATCH-EDS-' + Utilities.formatDate(now, "Asia/Jakarta", "yyyyMMdd-HHmmss");

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

  PropertiesService.getScriptProperties().setProperty('LAST_BACKUP_TIMESTAMP_EDS', waktuBackup);

  // 🧹 OTOMATIS KOSONGKAN MAIN LIST SKU EDS SETELAH BACKUP
  try {
    const mainSheet = getEdsSheet('MAIN_LIST');
    if (mainSheet) {
      const maxRows = mainSheet.getMaxRows();
      if (maxRows > 1) {
        mainSheet.showRows(1, maxRows);
      }
      const mRow = mainSheet.getLastRow();
      if (mRow > 1) {
        mainSheet.getRange(2, 1, mRow - 1, Math.max(mainSheet.getLastColumn(), 20)).clearContent();
      }
    }
  } catch(eMain) {
    console.warn('Gagal reset Main List SKU EDS saat backup:', eMain);
  }

  if (autoClear) {
    const lastRow = hasilSheet.getLastRow();
    if (lastRow > 1) {
      hasilSheet.deleteRows(2, lastRow - 1);
    }
  }

  let msg = 'Berhasil mem-backup ' + rowsToAppend.length + ' baris ke sheet "' + backupSheet.getName() + '"! (Batch: ' + batchId + ')';
  if (duplicateCount > 0) {
    msg += '\n(' + duplicateCount + ' baris telah ada sebelumnya di backup dan dilewati).';
  }
  msg += '\n\n✅ Sheet tugas Main List telah otomatis dikosongkan dan siap untuk tugas berikutnya.';
  if (autoClear) {
    msg += '\n✅ Sheet Hasil EDS kini telah bersih.';
  }

  return {
    success: true,
    message: msg,
    appendedCount: rowsToAppend.length,
    duplicateCount: duplicateCount,
    batchId: batchId
  };
}

// ── 7. HANDLER POST UNTUK ED SWEEPER ──

function handleEdsSubmit(payload) {
  try {
    const ss = getEdsSpreadsheet();
    let hasilSheet = getEdsSheet('HASIL');
    if (!hasilSheet) {
      hasilSheet = ss.insertSheet(EDS_SHEETS.HASIL);
    }

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
        console.warn('Gagal upload foto EDS:', errUpload);
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
      hasilSheet.getRange(existingRowIdx, 1, 1, rowData.length).setValues([rowData]);
    } else {
      hasilSheet.appendRow(rowData);
    }

    // Auto-update kolom Done di Main List SKU ED Sweeper
    try {
      const mainSheet = getEdsSheet('MAIN_LIST');
      if (mainSheet && skuNo) {
        const lastRow = mainSheet.getLastRow();
        if (lastRow > 1) {
          const skuColValues = mainSheet.getRange(2, 2, lastRow - 1, 1).getValues();
          for (let r = 0; r < skuColValues.length; r++) {
            const rawVal = String(skuColValues[r][0] || '').trim();
            if (rawVal && (rawVal.toLowerCase() === skuNo.toLowerCase() || rawVal.includes(skuNo))) {
              const targetRow = r + 2;
              mainSheet.getRange(targetRow, 18).setValue('Done');
              const remaksVal = reasonBad || reasonSloc || payload.remaks || 'Sesuai';
              mainSheet.getRange(targetRow, 19).setValue(remaksVal);
              const qtySys = payload.qty_system || mainSheet.getRange(targetRow, 11).getValue() || 0;
              mainSheet.getRange(targetRow, 20).setValue(fisikGood + '/' + qtySys);
              break;
            }
          }
        }
      }
    } catch (errSync) {
      console.warn('Gagal auto-update kolom R/S/T Main List SKU EDS:', errSync);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data audit SKU ' + skuNo + ' berhasil disimpan ke sheet ' + hasilSheet.getName() + '.',
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

// ── 8. HANDLER POST UNTUK DCC SCREENING (ALL-IN-ONE ROUTER) ──

function handleDccSubmit(payload) {
  try {
    const ss = getEdsSpreadsheet();
    const skuNo = String(payload.skuNo || payload.sku || payload.sku_number || '').trim();
    const namaSku = String(payload.namaSku || payload.productName || '').trim();
    const slocExisting = String(payload.slocExisting || payload.lokasiRack || '').trim();
    const slocActual = String(payload.slocActual || 'Match').trim();
    const expiredDate = String(payload.expiredDate || '').trim();
    const fisikGood = payload.fisikGood !== undefined ? payload.fisikGood : '0';
    const fisikBad = payload.fisikBad !== undefined ? payload.fisikBad : '0';
    const sales = payload.sales !== undefined ? payload.sales : '0';
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
        const folderName = 'DCC_MTG_EVIDANCE';
        let folder;
        const folders = DriveApp.getFoldersByName(folderName);
        if (folders.hasNext()) {
          folder = folders.next();
        } else {
          folder = DriveApp.createFolder(folderName);
          folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        }

        const dateStr = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyyMMdd_HHmmss");
        evidance1Name = 'DCC_' + skuNo + '_1_' + dateStr + '.jpg';
        const cleanBase64_1 = payload.imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
        const decoded1 = Utilities.base64Decode(cleanBase64_1);
        const blob1 = Utilities.newBlob(decoded1, 'image/jpeg', evidance1Name);
        const file1 = folder.createFile(blob1);
        file1.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        evidanceLink1 = file1.getUrl();

        if (payload.imageBase64_2) {
          evidance2Name = 'DCC_' + skuNo + '_2_' + dateStr + '.jpg';
          const cleanBase64_2 = payload.imageBase64_2.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
          const decoded2 = Utilities.base64Decode(cleanBase64_2);
          const blob2 = Utilities.newBlob(decoded2, 'image/jpeg', evidance2Name);
          const file2 = folder.createFile(blob2);
          file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          evidanceLink2 = file2.getUrl();
        }
      } catch (errUpload) {
        console.warn('Gagal upload foto DCC:', errUpload);
      }
    }

    const timestamp = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");
    let hasilDccSheet = ss.getSheetByName('Hasil DCC') || ss.getSheetByName('MTG') || ss.insertSheet('Hasil DCC');

    if (hasilDccSheet.getLastRow() === 0) {
      hasilDccSheet.appendRow([
        "Timestamp", "SKU Number", "Nama SKU ", "SLOC Existing", "SLOC Actual",
        "Expired Date", "Fisik Good", "Fisik Bad", "Sales (jika ada)",
        "Reason SLOC", "Reason Bad", "Evidance 1", "Evidance 2",
        "Evidance Link 1", "Evidance Link 2", "Fisik/System", "MSLTC",
        "SKU No", "Input by", "Label Barcode Product", "Label Sloc"
      ]);
    }

    const labelProduct = String(payload.labelProduct || 'Ada').trim();
    const labelSloc = String(payload.labelSloc || 'Ada').trim();
    const qtySysVal = payload.qty_system || payload.qtySistem || '';
    const fisikSystem = qtySysVal !== '' ? (fisikGood + '/' + qtySysVal) : String(fisikGood);

    const dccRowData = [
      timestamp, skuNo, namaSku, slocExisting, slocActual,
      expiredDate, fisikGood, fisikBad, sales, reasonSloc,
      reasonBad, evidance1Name, evidance2Name, evidanceLink1,
      evidanceLink2, fisikSystem, msltc, skuNo, inputBy,
      labelProduct, labelSloc
    ];

    hasilDccSheet.appendRow(dccRowData);

    // Auto-update Sheet "Mainlist SKU" (Kolom H - P)
    try {
      const mainlistSheet = ss.getSheetByName('Mainlist SKU') || ss.getSheetByName('Mainlist Sku');
      if (mainlistSheet && skuNo) {
        const lastMRow = mainlistSheet.getLastRow();
        if (lastMRow > 1) {
          const mSkuValues = mainlistSheet.getRange(2, 3, lastMRow - 1, 1).getValues();
          for (let r = 0; r < mSkuValues.length; r++) {
            const rawVal = String(mSkuValues[r][0] || '').trim();
            if (rawVal && (rawVal.toLowerCase() === skuNo.toLowerCase() || rawVal.includes(skuNo))) {
              const targetRow = r + 2;
              const fg = Number(fisikGood) || 0;
              const fb = Number(fisikBad) || 0;
              const tot = fg + fb;
              const sysQty = Number(mainlistSheet.getRange(targetRow, 6).getValue()) || 0;
              const diff = tot - sysQty;
              const slocMatch = (slocActual.toLowerCase() === 'match') ? 'MATCH' : 'UNMATCH';
              const remaksVal = reasonBad || reasonSloc || payload.remaks || 'Sesuai';

              mainlistSheet.getRange(targetRow, 8).setValue(fg);
              mainlistSheet.getRange(targetRow, 9).setValue(fb);
              mainlistSheet.getRange(targetRow, 10).setValue(tot);
              mainlistSheet.getRange(targetRow, 11).setValue(diff);
              mainlistSheet.getRange(targetRow, 12).setValue(slocMatch);
              mainlistSheet.getRange(targetRow, 13).setValue(remaksVal);
              mainlistSheet.getRange(targetRow, 14).setValue(inputBy);
              mainlistSheet.getRange(targetRow, 15).setValue('DONE');
              mainlistSheet.getRange(targetRow, 16).setValue(timestamp);
              break;
            }
          }
        }
      }
    } catch (errSync) {
      console.warn('Gagal auto-update Mainlist SKU:', errSync);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data audit SKU ' + skuNo + ' berhasil disimpan ke Hasil DCC dan Mainlist SKU.',
      photoUrl1: evidanceLink1,
      photoUrl2: evidanceLink2
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Router Fallback doPost jika doPost dipanggil dari file ini
function doPost(e) {
  try {
    let payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      payload = e.parameter;
    }

    // Jika request adalah audit ED Sweeper
    if (payload.action === 'saveEdsResult' || payload.module === 'eds' || payload.module === 'ed_sweeper') {
      return handleEdsSubmit(payload);
    }

    // Default adalah DCC Screening
    return handleDccSubmit(payload);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  var ss = getEdsSpreadsheet();
  var sheetName = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : null;
  var sheet = sheetName ? ss.getSheetByName(sheetName) : getEdsSheet('MAIN_LIST');

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: "Sheet tidak ditemukan.",
      availableSheets: ss.getSheets().map(function(s) { return s.getName(); })
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var values = sheet.getDataRange().getValues();
  var result = [];

  if (values.length > 0) {
    var headers = values[0];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (row.join("").trim() === "") continue;

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

  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
