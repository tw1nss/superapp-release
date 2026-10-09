/**
 * =========================================================================
 * GOOGLE APPS SCRIPT: KOLI INBOUND CWG (HUB CAWANG)
 * Spreadsheet: https://docs.google.com/spreadsheets/d/1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ/edit
 *
 * PENTING: File ini dipasang di PROJECT YANG SAMA dengan DCC_Master.
 * Semua nama global di sini diberi awalan KOLI_ / koli agar tidak menimpa
 * fungsi DCC_Master (processToSheet, CONFIG, alertUser, onOpen, doGet).
 * Menu dibuat lewat buildKoliInboundMenu() yang dipanggil dari onOpen DCC_Master.
 *
 * ALUR SISTEM:
 * 1. Tarik data dari Superset slice 27918 menggunakan Cookie session (MY_COOKIE).
 * 2. Tulis data ke sheet "Koli Inbound".
 * 3. Auto-sync setiap 3 jam via time-driven trigger.
 * =========================================================================
 */

var KOLI_CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  TARGET_FILE_ID: "1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ",
  CHART_ID: 27918,
  FORM_DATA_KEY: "1REh3ROwg-roifIE1HTK_P290aVSDXywXIaPrz77j61Nfc0yx5Mn4cik0y2BDGv2",
  DASHBOARD_PAGE_ID: "mdjOJrcrCcf0KmLSnfXYb",
  SHEET_NAME: "Koli Inbound",
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// =============================
// 🔘 TRIGGER ON OPEN & MENU
// PERHATIAN: Jangan gunakan nama 'onOpen' di sini agar TIDAK menimpa menu Superset, DCC, Pinjaman, dll.
// Menu Koli Inbound sudah otomatis dipanggil oleh onOpen() utama di GoogleAppsScript_CWG_DCC_Master.js
function onOpenKoliInboundStandalone() {
  try {
    var ui = SpreadsheetApp.getUi();
    buildKoliInboundMenu(ui);
  } catch (e) {
    Logger.log("onOpen Koli Inbound notice: " + e.message);
  }
}

function buildKoliInboundMenu(ui) {
  if (!ui) ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Koli Inbound Control')
    .addItem('🔄 Tarik Data Sekarang (Manual)', 'pullKoliInboundManual')
    .addSeparator()
    .addItem('⏱️ Pasang Auto-Sync (Setiap 3 Jam)', 'koliSetupTrigger3Hours')
    .addItem('🛑 Hapus Auto-Sync', 'koliRemoveAutoSyncTriggerPrompt')
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'koliSetCookiePrompt')
    .addItem('ℹ️ Cek Status Koneksi & Trigger', 'koliCheckStatusPrompt')
    .addToUi();
}

function pullKoliInboundManual() {
  pullSupersetKoliData(true);
}

function autoPullKoliInboundTask() {
  pullSupersetKoliData(false);
}

// =============================
// TRIGGER SETUP (3 JAM SEKALI)
// =============================
function koliSetupTrigger3Hours() {
  koliRemoveAutoSyncTrigger();
  ScriptApp.newTrigger('autoPullKoliInboundTask')
    .timeBased()
    .everyHours(3)
    .create();
  koliAlert("✅ Auto-Sync berhasil diaktifkan!\nData Koli Inbound akan ditarik otomatis setiap 3 jam sekali.");
}

function koliRemoveAutoSyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoPullKoliInboundTask') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  return count;
}

function koliRemoveAutoSyncTriggerPrompt() {
  var deleted = koliRemoveAutoSyncTrigger();
  if (deleted > 0) {
    koliAlert("🛑 Auto-sync setiap 3 jam telah dinonaktifkan (" + deleted + " trigger dihapus).");
  } else {
    koliAlert("ℹ️ Tidak ada trigger auto-sync yang aktif.");
  }
}

// =============================
// CORE ENGINE: SUPERSET FETCH
// =============================
function pullSupersetKoliData(isManual) {
  var cookie = PropertiesService.getScriptProperties().getProperty('MY_COOKIE');

  if (!cookie) {
    var noCookieMsg = "❌ MY_COOKIE belum di-set!\nSilakan klik menu '📈 Superset Control' > '🔑 Set / Ganti Cookie Superset'.";
    Logger.log(noCookieMsg);
    if (isManual) koliAlert(noCookieMsg);
    return;
  }

  var timestamp = new Date().getTime();
  var chartId = KOLI_CONFIG.CHART_ID;

  var urlVariants = [];
  if (KOLI_CONFIG.FORM_DATA_KEY) {
    urlVariants.push(KOLI_CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(KOLI_CONFIG.FORM_DATA_KEY) + "&slice_id=" + chartId + "&force=true&_t=" + timestamp);
  }
  if (KOLI_CONFIG.DASHBOARD_PAGE_ID) {
    urlVariants.push(KOLI_CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({ slice_id: chartId, dashboard_page_id: KOLI_CONFIG.DASHBOARD_PAGE_ID })) + "&force=true&_t=" + timestamp);
  }
  urlVariants.push(KOLI_CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data/?force=true&_t=" + timestamp);
  urlVariants.push(KOLI_CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({ slice_id: chartId })) + "&force=true&_t=" + timestamp);

  var data;
  var success = false;
  var lastError = "";

  for (var u = 0; u < urlVariants.length; u++) {
    for (var i = 0; i < KOLI_CONFIG.MAX_RETRY; i++) {
      try {
        var response = UrlFetchApp.fetch(urlVariants[u], {
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
          var err401 = "❌ COOKIE EXPIRED: Sesi Superset habis.\nUpdate cookie lewat menu '📈 Superset Control' > '🔑 Set / Ganti Cookie Superset'.";
          Logger.log(err401);
          if (isManual) koliAlert(err401);
          return;
        }

        if (code !== 200) {
          lastError = "HTTP " + code;
          Utilities.sleep(KOLI_CONFIG.RETRY_DELAY);
          continue;
        }

        data = koliExtractRows(JSON.parse(response.getContentText()));

        if (data && data.length > 0) {
          koliWriteToSheet(data);
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
    var successMsg = "✅ Berhasil memperbarui data Koli Inbound!\nTotal: " + data.length + " baris data tersinkronisasi.";
    Logger.log(successMsg);
    if (isManual) koliAlert(successMsg);
  } else {
    var failMsg = "❌ Gagal menarik data Koli Inbound:\n" + lastError;
    Logger.log(failMsg);
    if (isManual) koliAlert(failMsg);
  }
}

function koliExtractRows(json) {
  if (json.result && json.result[0] && json.result[0].data) return json.result[0].data;
  if (json.result && json.result[0] && json.result[0].records) return json.result[0].records;
  if (json.data && json.data.records) return json.data.records;
  if (json.colnames && Array.isArray(json.data)) {
    return json.data.map(function(row) {
      var obj = {};
      json.colnames.forEach(function(col, idx) { obj[col] = row[idx]; });
      return obj;
    });
  }
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json)) return json;
  return null;
}

// =============================
// WRITE TO SPREADSHEET
// =============================
function koliWriteToSheet(data) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(KOLI_CONFIG.TARGET_FILE_ID);
  } catch (e) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  var sheet = ss.getSheetByName(KOLI_CONFIG.SHEET_NAME) || ss.insertSheet(KOLI_CONFIG.SHEET_NAME);

  if (!data || data.length === 0) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue("⚠️ Data kosong dari Superset");
    return;
  }

  var headers = Object.keys(data[0]);

  var rows = data.map(function(item) {
    return headers.map(function(key) {
      var value = item[key];
      var cleanKey = String(key).toLowerCase();

      if (cleanKey.includes("sku") || cleanKey.includes("koli") || cleanKey.includes("so") || cleanKey.includes("id")) {
        return value !== null && value !== undefined ? String(value) : "";
      }

      if (cleanKey.includes("date") && value && !isNaN(value)) {
        try {
          return Utilities.formatDate(new Date(Number(value)), KOLI_CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
        } catch (e) {}
      }

      if (cleanKey === "quantity" || cleanKey.includes("qty") || cleanKey === "price") {
        return (value !== "" && value !== null && !isNaN(value)) ? Number(value) : value;
      }

      return value !== null && value !== undefined ? value : "";
    });
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
}

// =============================
// STATUS
// =============================
function koliCheckStatusPrompt() {
  var cookie = PropertiesService.getScriptProperties().getProperty('MY_COOKIE');
  var hasCookie = cookie && cookie.length > 10;

  var triggers = ScriptApp.getProjectTriggers();
  var hasTrigger = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoPullKoliInboundTask') {
      hasTrigger = true;
      break;
    }
  }

  koliAlert("📊 Status Koli Inbound CWG:\n\n" +
            "• Cookie Superset: " + (hasCookie ? "✅ Terpasang" : "❌ Belum Terpasang") + "\n" +
            "• Auto-Sync 3 Jam: " + (hasTrigger ? "✅ Aktif" : "❌ Tidak Aktif") + "\n" +
            "• Slice ID Superset: " + KOLI_CONFIG.CHART_ID + "\n" +
            "• Sheet Target: " + KOLI_CONFIG.SHEET_NAME);
}

function koliAlert(msg) {
  try {
    SpreadsheetApp.flush();
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
}

function setSupersetCookiePrompt() {
  koliSetCookiePrompt();
}

function koliSetCookiePrompt() {
  var ui = SpreadsheetApp.getUi();
  var currentCookie = PropertiesService.getScriptProperties().getProperty('MY_COOKIE');
  var hasCookie = currentCookie && currentCookie.length > 10;

  var prompt = ui.prompt(
    '🔑 Set / Ganti Cookie Superset',
    'Paste cookie session dari browser (dash.astronauts.id):\n' +
    (hasCookie ? 'Status: Cookie sudah terpasang.' : 'Status: Belum ada cookie.'),
    ui.ButtonSet.OK_CANCEL
  );

  if (prompt.getSelectedButton() === ui.Button.OK) {
    var inputCookie = prompt.getResponseText().trim();
    if (inputCookie) {
      PropertiesService.getScriptProperties().setProperty('MY_COOKIE', inputCookie);
      ui.alert('✅ Cookie berhasil disimpan!');
    } else {
      ui.alert('⚠️ Input kosong, cookie tidak diubah.');
    }
  }
}
