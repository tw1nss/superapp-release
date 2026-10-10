/**
 * =========================================================================
 * GOOGLE APPS SCRIPT: KOLI INBOUND MTG
 * Spreadsheet: https://docs.google.com/spreadsheets/d/1sULhhG0_Oe2hr2B34Lum08ibDuxWJtM9buz9kitAnKg/edit
 * Dashboard Slice: https://dash.astronauts.id/explore/?dashboard_page_id=nD93Gsj9iugJfgZxwZ19I&slice_id=6318
 * 
 * ALUR SISTEM:
 * 1. Tarik data dari Superset slice 6318 menggunakan Cookie session (MY_COOKIE).
 * 2. Tulis data ke Google Spreadsheet ini secara terstruktur.
 * 3. Auto-sync otomatis berjalan setiap 3 jam sekali via time-driven trigger.
 * 4. Menyediakan endpoint doGet() untuk integrasi API SuperApp jika dideploy sebagai Web App.
 * =========================================================================
 */

// =============================
// CONFIG GLOBAL
// =============================
var CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  TARGET_FILE_ID: "1sULhhG0_Oe2hr2B34Lum08ibDuxWJtM9buz9kitAnKg",
  CHART_ID: 6318,
  SHEET_NAME: "Koli Inbound",
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// =============================
// TRIGGER ON OPEN & MENU
// PERHATIAN: Jangan gunakan nama 'onOpen' di sini agar TIDAK menimpa menu Superset, DCC, Pinjaman, dll.
// Menu Koli Inbound sudah otomatis dipanggil oleh onOpen() utama di GoogleAppsScript_CWG_DCC_Master.js
function onOpenKoliInboundStandalone() {
  try {
    ensureEvery3HoursTrigger();
  } catch (e) {
    Logger.log("Notice trigger check onOpen: " + e.message);
  }

  SpreadsheetApp.getUi()
    .createMenu('📦 Koli Inbound Control')
    .addItem('🔄 Tarik Data Sekarang (Manual)', 'pullKoliInboundManual')
    .addSeparator()
    .addItem('⏱️ Pasang Auto-Sync (Setiap 3 Jam)', 'setupTrigger3Hours')
    .addItem('🛑 Hapus Auto-Sync', 'removeAutoSyncTriggerPrompt')
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'setSupersetCookiePrompt')
    .addItem('ℹ️ Cek Status Koneksi & Trigger', 'checkStatusPrompt')
    .addToUi();
}

// Menu action manual
function pullKoliInboundManual() {
  pullSupersetKoliData(true);
}

// Background execution task (tanpa pop-up UI)
function autoPullKoliInboundTask() {
  pullSupersetKoliData(false);
}

// =============================
// TRIGGER SETUP (3 JAM SEKALI)
// =============================
function setupTrigger3Hours() {
  removeAutoSyncTrigger();

  ScriptApp.newTrigger('autoPullKoliInboundTask')
    .timeBased()
    .everyHours(3)
    .create();

  alertUser("✅ Auto-Sync berhasil diaktifkan!\nData Koli Inbound akan ditarik otomatis setiap 3 jam sekali.");
}

function removeAutoSyncTrigger() {
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

function removeAutoSyncTriggerPrompt() {
  var deleted = removeAutoSyncTrigger();
  if (deleted > 0) {
    alertUser("🛑 Auto-sync setiap 3 jam telah dinonaktifkan (" + deleted + " trigger dihapus).");
  } else {
    alertUser("ℹ️ Tidak ada trigger auto-sync yang aktif.");
  }
}

function ensureEvery3HoursTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoPullKoliInboundTask') {
      exists = true;
      break;
    }
  }
  if (!exists) {
    ScriptApp.newTrigger('autoPullKoliInboundTask')
      .timeBased()
      .everyHours(3)
      .create();
    Logger.log("Auto-Sync 3 Jam dibuat otomatis.");
  }
}

// =============================
// CORE ENGINE: SUPERSET FETCH
// =============================
function pullSupersetKoliData(isManual) {
  var cookie = PropertiesService
    .getScriptProperties()
    .getProperty('MY_COOKIE');

  if (!cookie) {
    var noCookieMsg = "❌ MY_COOKIE belum di-set!\nSilakan klik menu 'Koli Inbound Control' > 'Set / Ganti Cookie Superset'.";
    Logger.log(noCookieMsg);
    if (isManual) alertUser(noCookieMsg);
    return;
  }

  var timestamp = new Date().getTime();
  var chartId = CONFIG.CHART_ID;

  var urlVariants = [
    CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp,
    CONFIG.BASE_URL + "superset/explore_json/?form_data={\"slice_id\":" + chartId + "}&force=true&_t=" + timestamp
  ];

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
          var err401 = "❌ COOKIE EXPIRED: Sesi Superset habis.\nSilakan update cookie Superset lewat menu 'Set / Ganti Cookie Superset'.";
          Logger.log(err401);
          if (isManual) alertUser(err401);
          return;
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
          processToSheet(data);
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
    if (isManual) alertUser(successMsg);
  } else {
    var failMsg = "❌ Gagal menarik data Koli Inbound:\n" + lastError;
    Logger.log(failMsg);
    if (isManual) alertUser(failMsg);
  }
}

// =============================
// WRITE TO SPREADSHEET
// =============================
function processToSheet(data) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.TARGET_FILE_ID);
  } catch (e) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }

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

      // Pastikan identifier & SKU disimpan sebagai string murni
      if (cleanKey.includes("sku") || cleanKey.includes("koli") || cleanKey.includes("so") || cleanKey.includes("id")) {
        return value !== null && value !== undefined ? String(value) : "";
      }

      // Format Tanggal jika bernilai epoch timestamp
      if (cleanKey.includes("date") && value && !isNaN(value)) {
        try {
          return Utilities.formatDate(
            new Date(Number(value)),
            CONFIG.TIMEZONE,
            "yyyy-MM-dd HH:mm:ss"
          );
        } catch(e) {}
      }

      // Konversi kuantitas dan angka menjadi number murni
      if (cleanKey === "quantity" || cleanKey.includes("qty") || cleanKey === "price") {
        return (value !== "" && value !== null && !isNaN(value)) ? Number(value) : value;
      }

      return value !== null && value !== undefined ? value : "";
    });
  });

  sheet.clearContents();

  // Tulis Header Tebal
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight("bold");

  // Tulis Baris Data
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

// =============================
// COOKIE & STATUS PROMPT
// =============================
function setSupersetCookiePrompt() {
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

function checkStatusPrompt() {
  var ui = SpreadsheetApp.getUi();
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

  var msg = "📊 Status Koli Inbound MTG:\n\n" +
            "• Cookie Superset: " + (hasCookie ? "✅ Terpasang" : "❌ Belum Terpasang") + "\n" +
            "• Auto-Sync 3 Jam: " + (hasTrigger ? "✅ Aktif" : "❌ Tidak Aktif") + "\n" +
            "• Slice ID Superset: " + CONFIG.CHART_ID + "\n" +
            "• Sheet Target: " + CONFIG.SHEET_NAME;

  ui.alert(msg);
}

// ============================================================
// API GET DATA UNTUK FRONTEND (BULK READ)
// ============================================================
function doGet(e) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.TARGET_FILE_ID);
  } catch (err) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  var sheetName = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : CONFIG.SHEET_NAME;
  var sheet = ss.getSheetByName(sheetName) || ss.getSheets()[0];

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Sheet '" + sheetName + "' tidak ditemukan." }))
      .setMimeType(ContentService.MimeType.JSON);
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

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================
// UTILITAS UI
// =============================
function alertUser(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
}
