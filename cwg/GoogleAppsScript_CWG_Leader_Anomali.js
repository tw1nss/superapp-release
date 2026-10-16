/**
 * =========================================================================
 * 🚀 DEDICATED SCRIPT: SUPERSET ANOMALI CWG (LDP, LBH & DETAIL BAD)
 * =========================================================================
 * Spreadsheet Khusus: Monitoring LDP, LBH & BAD Detail CWG
 * URL: https://docs.google.com/spreadsheets/d/1ufcERKZtENOjtRjU8m6Ov5yfkR_wmPnELO4vlrTbHdY/edit?usp=sharing
 * Spreadsheet ID: 1ufcERKZtENOjtRjU8m6Ov5yfkR_wmPnELO4vlrTbHdY
 *
 * FITUR:
 * 1. 📈 AUTO-SYNC 3 CHART SUPERSET:
 *    - BAD Detail (Slice 27941)
 *    - LDP Details CWG (Slice 27901)
 *    - LBH Details CWG (Slice 27904)
 * 2. 🔀 MERGE 1 MASTER SHEET:
 *    - Menggabungkan ketiga data ke sheet utama: "BAD & LOST"
 *    - Otomatis menandai kolom pertama "KATEGORI": BAD / LDP / LBH
 *    - Menulis juga ke tab individu: "DETAIL BAD", "LDP", "LBH" (opsional/arsip)
 * 3. 📡 API WEB APP UNTUK SUPERAPP LEADER CWG:
 *    - Endpoint doGet(?sheet=BAD %26 LOST) super cepat untuk sync ke aplikasi web & Android
 * 4. ⏰ AUTO-TRIGGER HOURLY:
 *    - Sinkronisasi otomatis dari Superset setiap 1 jam sekali
 * =========================================================================
 */

// =============================
// ⚙️ KONFIGURASI GLOBAL
// =============================
var CONFIG = {
  BASE_URL: "https://dash.astronauts.id/",
  TARGET_FILE_ID: "1ufcERKZtENOjtRjU8m6Ov5yfkR_wmPnELO4vlrTbHdY",
  MAX_RETRY: 3,
  RETRY_DELAY: 2000,
  TIMEZONE: "Asia/Jakarta"
};

// =============================
// 📊 KONFIGURASI 3 CHART CWG
// =============================
var CHARTS = {
  BAD: {
    sliceId: 27941,
    formDataKey: "YFFz0dsVcjlXbJMRnA8A_sBFUNbTa5LlUIIsq5wUAG_4k8xUHrXGC9IkDseddSLy",
    pageId: "hhwqUYiJiLP_Jl3TzYkR1",
    sheetName: "DETAIL BAD",
    categoryTag: "BAD"
  },
  LDP: {
    sliceId: 27901,
    formDataKey: "hgaR5JFRTDxyma-KTv4wjp8pkTz8S-nd0IgpfqUP4h8Ty-Ab4NpjWAChgjPY9pTc",
    pageId: "MLs5g1er3i_kCu5IcDroT",
    sheetName: "LDP",
    categoryTag: "LDP"
  },
  LBH: {
    sliceId: 27904,
    formDataKey: "7ub49RrKd0lwUbLDDoMHO_W5JWRUt7qujfikaRXlUKp2ehhyP_RnA2AfYoUUt6h3",
    pageId: "hY6QfDdXUa54wA_SXUR2B",
    sheetName: "LBH",
    categoryTag: "LBH"
  }
};

// =============================
// 🔘 MENU UTAMA SPREADSHEET
// =============================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('📈 Superset Anomali CWG')
    .addItem('🚀 Update Semua Data (BAD, LDP & LBH)', 'update_all_anomali')
    .addSeparator()
    .addItem('1. Tarik DETAIL BAD (Slice 27941)', 'menu_pull_bad')
    .addItem('2. Tarik LDP CWG (Slice 27901)', 'menu_pull_ldp')
    .addItem('3. Tarik LBH CWG (Slice 27904)', 'menu_pull_lbh')
    .addSeparator()
    .addItem('🛠️ Rapikan Format Tanggal (Kolom J)', 'fixTimestampInAllSheets')
    .addSeparator()
    .addItem('🔑 Set / Ganti Cookie Superset', 'setCookiePrompt')
    .addItem('🔗 Set Link / Slice ID Manual', 'setSliceLinksPrompt')
    .addSeparator()
    .addItem('⏰ Aktifkan Auto-Sync Tiap Jam', 'setupHourlyTrigger')
    .addItem('🛑 Matikan Auto-Sync', 'removeHourlyTrigger')
    .addToUi();
}

function getSpreadsheet() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (eActive) {}

  try {
    if (CONFIG.TARGET_FILE_ID) {
      return SpreadsheetApp.openById(CONFIG.TARGET_FILE_ID);
    }
  } catch (e) {
    console.warn("Gagal openById, menggunakan Active Spreadsheet:", e);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function alertUser(msg) {
  try {
    var ui = SpreadsheetApp.getUi();
    if (ui) ui.alert(msg);
  } catch (e) {
    console.log("ALERT: " + msg);
  }
}

// ============================================================
// 🚀 SINKRONISASI UTAMA: GABUNGKAN BAD, LDP & LBH KE 1 SHEET
// ============================================================
function update_all_anomali() {
  console.log("🚀 [ANOMALI MASTER] Memulai penarikan 3 chart Superset (BAD, LDP, LBH)...");
  var props = PropertiesService.getScriptProperties();

  // 1. Param BAD Detail (27941)
  var badSlice = props.getProperty('BAD_SLICE_ID') || CHARTS.BAD.sliceId;
  var badKey = props.getProperty('BAD_FORM_DATA_KEY') || CHARTS.BAD.formDataKey;
  var badPage = props.getProperty('BAD_PAGE_ID') || CHARTS.BAD.pageId;

  // 2. Param LDP CWG (27901)
  var ldpSlice = props.getProperty('LDP_SLICE_ID') || CHARTS.LDP.sliceId;
  var ldpKey = props.getProperty('LDP_FORM_DATA_KEY') || CHARTS.LDP.formDataKey;
  var ldpPage = props.getProperty('LDP_PAGE_ID') || CHARTS.LDP.pageId;

  // 3. Param LBH CWG (27904)
  var lbhSlice = props.getProperty('LBH_SLICE_ID') || CHARTS.LBH.sliceId;
  var lbhKey = props.getProperty('LBH_FORM_DATA_KEY') || CHARTS.LBH.formDataKey;
  var lbhPage = props.getProperty('LBH_PAGE_ID') || CHARTS.LBH.pageId;

  var badData = [];
  var ldpData = [];
  var lbhData = [];
  var errors = [];

  // Tarik BAD Detail
  try {
    badData = fetchSupersetData(badSlice, badKey, badPage) || [];
    processToSheet(badData, CHARTS.BAD.sheetName);
  } catch (eBad) {
    if (eBad.message === "COOKIE_EXPIRED") return alertUser("❌ COOKIE EXPIRED!\n\nSilakan perbarui cookie Superset Anda di menu '🔑 Set / Ganti Cookie Superset'.");
    if (eBad.message === "MY_COOKIE_EMPTY") return alertUser("❌ MY_COOKIE belum di-set!\n\nGunakan menu '🔑 Set / Ganti Cookie Superset' terlebih dahulu.");
    console.warn("⚠️ Gagal tarik DETAIL BAD:", eBad.message);
    errors.push("DETAIL BAD: " + eBad.message);
  }

  // Tarik LDP
  try {
    ldpData = fetchSupersetData(ldpSlice, ldpKey, ldpPage) || [];
    processToSheet(ldpData, CHARTS.LDP.sheetName);
  } catch (eLdp) {
    if (eLdp.message === "COOKIE_EXPIRED") return alertUser("❌ COOKIE EXPIRED!\n\nSilakan perbarui cookie Superset Anda di menu '🔑 Set / Ganti Cookie Superset'.");
    if (eLdp.message === "MY_COOKIE_EMPTY") return alertUser("❌ MY_COOKIE belum di-set!\n\nGunakan menu '🔑 Set / Ganti Cookie Superset' terlebih dahulu.");
    console.warn("⚠️ Gagal tarik LDP CWG:", eLdp.message);
    errors.push("LDP CWG: " + eLdp.message);
  }

  // Tarik LBH
  try {
    lbhData = fetchSupersetData(lbhSlice, lbhKey, lbhPage) || [];
    processToSheet(lbhData, CHARTS.LBH.sheetName);
  } catch (eLbh) {
    if (eLbh.message === "COOKIE_EXPIRED") return alertUser("❌ COOKIE EXPIRED!\n\nSilakan perbarui cookie Superset Anda di menu '🔑 Set / Ganti Cookie Superset'.");
    if (eLbh.message === "MY_COOKIE_EMPTY") return alertUser("❌ MY_COOKIE belum di-set!\n\nGunakan menu '🔑 Set / Ganti Cookie Superset' terlebih dahulu.");
    console.warn("⚠️ Gagal tarik LBH CWG:", eLbh.message);
    errors.push("LBH CWG: " + eLbh.message);
  }

  if (badData.length === 0 && ldpData.length === 0 && lbhData.length === 0) {
    var is404 = errors.some(function(e) { return e.indexOf("404") !== -1; });
    if (is404) {
      return alertUser("❌ GAGAL TARIK DATA (HTTP 404 - Link/Key Expired)!\n\n" +
        "Key Superset sementara yang sebelumnya sudah kedaluwarsa di server.\n\n" +
        "👉 SOLUSI:\n" +
        "1. Buka chart 'DETAIL BAD', 'LDP CWG', dan 'LBH CWG' di dash.astronauts.id Anda.\n" +
        "2. Pastikan chart sudah tersimpan permanen.\n" +
        "3. Masukkan ke menu Google Sheets: '📈 Superset Anomali CWG' ➔ '🔗 Set Link / Slice ID Manual'.");
    }
    return alertUser("❌ Gagal menarik ketiga data anomali:\n" + errors.join("\n"));
  }

  // Gabungkan ketiga dataset dengan kolom penanda KATEGORI di kolom pertama
  var combinedData = [];

  badData.forEach(function(row) {
    combinedData.push(Object.assign({ KATEGORI: "BAD" }, row));
  });

  ldpData.forEach(function(row) {
    combinedData.push(Object.assign({ KATEGORI: "LDP" }, row));
  });

  lbhData.forEach(function(row) {
    combinedData.push(Object.assign({ KATEGORI: "LBH" }, row));
  });

  // Tulis master gabungan ke sheet utama "BAD & LOST"
  processToSheet(combinedData, "BAD & LOST");

  var msg = "✅ Berhasil menyinkronkan data anomali ke sheet 'BAD & LOST'!\n\n" +
            "• DETAIL BAD (27941): " + badData.length + " baris\n" +
            "• LDP CWG (27901): " + ldpData.length + " baris\n" +
            "• LBH CWG (27904): " + lbhData.length + " baris\n" +
            "-----------------------------------------\n" +
            "• Total Digabung: " + combinedData.length + " baris\n\n" +
            "💡 Data ini siap dikonsumsi langsung oleh Superapp Dashboard Leader CWG.";
  if (errors.length > 0) {
    msg += "\n\n⚠️ Catatan Error: " + errors.join("; ");
  }
  console.log("✅ [ANOMALI MASTER] " + msg);
  alertUser(msg);
}

// =============================
// 🔘 MENU WRAPPERS INDIVIDU
// =============================
function menu_pull_bad() {
  pullSingleChart(CHARTS.BAD);
}

function menu_pull_ldp() {
  pullSingleChart(CHARTS.LDP);
}

function menu_pull_lbh() {
  pullSingleChart(CHARTS.LBH);
}

function pullSingleChart(cfg) {
  var props = PropertiesService.getScriptProperties();
  var prefix = cfg.categoryTag;
  var sliceId = props.getProperty(prefix + '_SLICE_ID') || cfg.sliceId;
  var key = props.getProperty(prefix + '_FORM_DATA_KEY') || cfg.formDataKey;
  var page = props.getProperty(prefix + '_PAGE_ID') || cfg.pageId;

  try {
    var data = fetchSupersetData(sliceId, key, page) || [];
    processToSheet(data, cfg.sheetName);
    alertUser("✅ Berhasil menarik data " + cfg.sheetName + " (" + data.length + " baris)!");
  } catch (e) {
    if (e.message === "COOKIE_EXPIRED") return alertUser("❌ COOKIE EXPIRED! Perbarui cookie di menu '🔑 Set / Ganti Cookie Superset'.");
    alertUser("❌ Gagal menarik " + cfg.sheetName + ": " + e.message);
  }
}

// ============================================================
// 🌐 SUPERSET ENGINE (HTTP REQUEST DENGAN COOKIE & RETRY)
// ============================================================
function fetchSupersetData(chartId, formDataKey, pageId) {
  var cookie = PropertiesService.getScriptProperties().getProperty('MY_COOKIE');
  if (!cookie) {
    throw new Error("MY_COOKIE_EMPTY");
  }

  var baseUrl = (CONFIG.BASE_URL || "https://dash.astronauts.id/").replace(/\/+$/, '') + '/';
  var timestamp = new Date().getTime();
  var urlVariants = [];

  if (chartId) {
    if (pageId) {
      urlVariants.push(baseUrl + "superset/explore_json/?dashboard_page_id=" + encodeURIComponent(pageId) + "&slice_id=" + chartId + "&force=true&_t=" + timestamp);
    }
    urlVariants.push(baseUrl + "superset/explore_json/?form_data=" + encodeURIComponent(JSON.stringify({ slice_id: Number(chartId) })) + "&force=true&_t=" + timestamp);
    urlVariants.push(baseUrl + "api/v1/chart/" + chartId + "/data/?force=true&_t=" + timestamp);
  }

  if (formDataKey) {
    if (pageId) {
      urlVariants.push(baseUrl + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + "&dashboard_page_id=" + encodeURIComponent(pageId) + (chartId ? "&slice_id=" + chartId : "") + "&force=true&_t=" + timestamp);
    }
    urlVariants.push(baseUrl + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) + (chartId ? "&slice_id=" + chartId : "") + "&force=true&_t=" + timestamp);
  }

  var data = null;
  var lastError = "";

  for (var u = 0; u < urlVariants.length; u++) {
    for (var i = 0; i < CONFIG.MAX_RETRY; i++) {
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
        if (code === 401) throw new Error("COOKIE_EXPIRED");
        if (code === 302) {
          var redirectLoc = (response.getHeaders && response.getHeaders()['Location']) ? response.getHeaders()['Location'] : '';
          if (redirectLoc.indexOf('login') !== -1) {
            throw new Error("COOKIE_EXPIRED");
          }
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
        } else if (Array.isArray(json.data)) {
          data = json.data;
        } else if (Array.isArray(json)) {
          data = json;
        }

        if (data) break;
      } catch (e) {
        if (e.message === "COOKIE_EXPIRED") throw e;
        lastError = e.message;
        Utilities.sleep(CONFIG.RETRY_DELAY);
      }
    }
    if (data) break;
  }

  if (!data) {
    throw new Error(lastError || "Data tidak ditemukan atau respon bukan format JSON valid.");
  }

  return data;
}

// ============================================================
// 📝 PENULIS KE SHEET (AUTO-FORMAT, TEXT SKU, & FILTER CWG)
// ============================================================
function processToSheet(data, sheetName) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (!data || data.length === 0) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue("⚠️ Data kosong");
    return;
  }

  // Safety filter untuk Hub CWG jika ada location_name
  if (data.length > 0) {
    var sample = data[0];
    var locKey = null;
    for (var k in sample) {
      if (k.toLowerCase() === 'location_name' || k.toLowerCase() === 'location') {
        locKey = k;
        break;
      }
    }
    if (locKey) {
      var cwgOnly = data.filter(function(r) {
        var loc = String(r[locKey] || '').toUpperCase();
        return loc.includes('CWG') || loc.includes('CAWANG');
      });
      if (cwgOnly.length > 0) {
        data = cwgOnly;
      }
    }
  }

  // Kumpulkan header (KATEGORI tetap di kolom 1 jika ada)
  var headerSet = [];
  var seenKeys = {};
  data.forEach(function(item) {
    Object.keys(item).forEach(function(key) {
      if (!seenKeys[key]) {
        seenKeys[key] = true;
        headerSet.push(key);
      }
    });
  });
  var headers = headerSet;

  var rows = data.map(function(item) {
    return headers.map(function(key) {
      var value = item[key];
      // Format SKU wajib string
      if (key && (key.toLowerCase().includes('sku') || key.toLowerCase().includes('barcode'))) {
        return value !== null && value !== undefined ? "'" + String(value) : "";
      }
      // Format Timestamp / Tanggal & Jam (misal product_detail_updated_at dari Superset)
      if (key && (key.toLowerCase().includes('updated_at') || key.toLowerCase().includes('created_at') || key.toLowerCase().includes('date') || key.toLowerCase().includes('tanggal'))) {
        return formatTimestampToDateTime(value);
      }
      if (value === null || value === undefined) return "";
      return value;
    });
  });

  // Tulis ke sheet
  sheet.clearContents();
  var fullData = [headers].concat(rows);
  var numRows = fullData.length;
  var numCols = headers.length;

  var range = sheet.getRange(1, 1, numRows, numCols);
  range.setValues(fullData);

  // Formatting Header
  var headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange.setBackground("#1E293B"); // Deep Slate Navy
  headerRange.setFontColor("#FFFFFF");
  headerRange.setFontWeight("bold");
  sheet.setFrozenRows(1);

  // Format kolom angka / Qty & Tanggal
  headers.forEach(function(h, idx) {
    var lower = h.toLowerCase();
    var colNum = idx + 1;
    if (lower === 'stock' || lower === 'qty') {
      sheet.getRange(2, colNum, numRows - 1, 1).setNumberFormat("#,##0");
    } else if (lower.includes('cogs') || lower.includes('value') || lower.includes('price')) {
      sheet.getRange(2, colNum, numRows - 1, 1).setNumberFormat("#,##0");
    } else if (lower.includes('updated_at') || lower.includes('created_at') || lower.includes('date') || lower.includes('tanggal')) {
      sheet.getRange(2, colNum, numRows - 1, 1).setNumberFormat("@");
    }
  });

  try {
    sheet.autoResizeColumns(1, Math.min(numCols, 15));
  } catch (eResize) {}
}

// ============================================================
// 📡 API GET DATA UNTUK SUPERAPP FRONTEND (BULK READ JSON)
// ============================================================
function doGet(e) {
  var param = (e && e.parameter) ? e.parameter : {};
  var sheetName = param.sheet || "BAD & LOST";

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({
      error: "Sheet '" + sheetName + "' tidak ditemukan.",
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

  return ContentService.createTextOutput(JSON.stringify(result))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// ⚙️ PENGATURAN COOKIE & LINK SUPERSET
// ============================================================
function setCookiePrompt() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentCookie = props.getProperty('MY_COOKIE') || '';
  var preview = currentCookie ? (currentCookie.substring(0, 30) + '...') : '(Belum di-set)';

  var response = ui.prompt(
    '🔑 Set / Ganti Cookie Superset',
    'Paste cookie Superset terbaru dari dash.astronauts.id Anda:\n\nSaat Ini: ' + preview,
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    var newCookie = response.getResponseText().trim();
    if (newCookie) {
      props.setProperty('MY_COOKIE', newCookie);
      ui.alert('✅ Cookie Superset berhasil disimpan!');
    } else {
      ui.alert('⚠️ Input kosong. Cookie tidak diubah.');
    }
  }
}

function setSliceLinksPrompt() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  // 1. DETAIL BAD
  var curBadId = props.getProperty('BAD_SLICE_ID') || CHARTS.BAD.sliceId;
  var resBad = ui.prompt('🔗 Set Link/Slice ID: DETAIL BAD (1/3)', 'Masukkan Slice ID atau URL Explore untuk DETAIL BAD:\nSaat ini: ' + curBadId, ui.ButtonSet.OK_CANCEL);
  if (resBad.getSelectedButton() === ui.Button.OK) {
    parseAndSaveSliceParam(resBad.getResponseText().trim(), 'BAD');
  }

  // 2. LDP CWG
  var curLdpId = props.getProperty('LDP_SLICE_ID') || CHARTS.LDP.sliceId;
  var resLdp = ui.prompt('🔗 Set Link/Slice ID: LDP CWG (2/3)', 'Masukkan Slice ID atau URL Explore untuk LDP CWG:\nSaat ini: ' + curLdpId, ui.ButtonSet.OK_CANCEL);
  if (resLdp.getSelectedButton() === ui.Button.OK) {
    parseAndSaveSliceParam(resLdp.getResponseText().trim(), 'LDP');
  }

  // 3. LBH CWG
  var curLbhId = props.getProperty('LBH_SLICE_ID') || CHARTS.LBH.sliceId;
  var resLbh = ui.prompt('🔗 Set Link/Slice ID: LBH CWG (3/3)', 'Masukkan Slice ID atau URL Explore untuk LBH CWG:\nSaat ini: ' + curLbhId, ui.ButtonSet.OK_CANCEL);
  if (resLbh.getSelectedButton() === ui.Button.OK) {
    parseAndSaveSliceParam(resLbh.getResponseText().trim(), 'LBH');
  }

  ui.alert('✅ Konfigurasi Slice ID berhasil disimpan! Silakan jalankan menu: "🚀 Update Semua Data".');
}

function parseAndSaveSliceParam(val, prefix) {
  if (!val) return;
  var props = PropertiesService.getScriptProperties();
  if (/^\d+$/.test(val)) {
    props.setProperty(prefix + '_SLICE_ID', val);
  } else {
    var kM = val.match(/form_data_key=([a-zA-Z0-9_\-]+)/);
    var sM = val.match(/slice_id=(\d+)/);
    var pM = val.match(/dashboard_page_id=([a-zA-Z0-9_\-]+)/);
    if (kM) props.setProperty(prefix + '_FORM_DATA_KEY', kM[1]);
    if (sM) props.setProperty(prefix + '_SLICE_ID', sM[1]);
    if (pM) props.setProperty(prefix + '_PAGE_ID', pM[1]);
    if (!kM && !sM) props.setProperty(prefix + '_FORM_DATA_KEY', val);
  }
}

// ============================================================
// ⏰ TRIGGER MANAGEMENT (AUTO-SYNC PER JAM)
// ============================================================
function setupHourlyTrigger() {
  removeHourlyTrigger();
  ScriptApp.newTrigger('update_all_anomali')
    .timeBased()
    .everyHours(1)
    .create();
  alertUser("✅ Auto-Sync Superset berhasil diaktifkan!\nData BAD, LDP & LBH akan di-update otomatis setiap 1 jam.");
}

function removeHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'update_all_anomali') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  if (count > 0) {
    alertUser("🛑 Auto-sync Superset telah dimatikan (" + count + " pemicu dihapus).");
  } else {
    alertUser("ℹ️ Tidak ada pemicu auto-sync yang aktif.");
  }
}

// ============================================================
// 🛠️ HELPER: UBAH RAW UNIX TIMESTAMP MENJADI TANGGAL & WAKTU
// ============================================================
function formatTimestampToDateTime(val) {
  if (val === null || val === undefined || val === '') return '';
  var n = Number(val);
  if (!isNaN(n) && n > 1000000000) {
    if (n < 10000000000) n = n * 1000;
    var d = new Date(n);
    if (!isNaN(d.getTime())) {
      var iso = d.toISOString(); // "2026-10-14T06:36:14.322Z"
      return iso.replace('T', ' ').slice(0, 19);
    }
  }
  return String(val);
}

// ============================================================
// 🛠️ PERBAIKI FORMAT TANGGAL & JAM DI SEMUA SHEET SAAT INI
// ============================================================
function fixTimestampInAllSheets() {
  var ss = getSpreadsheet();
  var sheets = ss.getSheets();
  var totalFixed = 0;

  sheets.forEach(function(sheet) {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    headers.forEach(function(h, idx) {
      var lower = String(h || '').toLowerCase();
      if (lower.includes('updated_at') || lower.includes('created_at') || lower.includes('date') || lower.includes('tanggal')) {
        var colNum = idx + 1;
        var range = sheet.getRange(2, colNum, lastRow - 1, 1);
        var values = range.getValues();
        var modified = false;

        for (var r = 0; r < values.length; r++) {
          var val = values[r][0];
          if (val !== null && val !== undefined && val !== "") {
            var n = Number(val);
            if (!isNaN(n) && n > 1000000000) {
              if (n < 10000000000) n = n * 1000;
              var d = new Date(n);
              if (!isNaN(d.getTime())) {
                var iso = d.toISOString();
                values[r][0] = iso.replace('T', ' ').slice(0, 19);
                totalFixed++;
                modified = true;
              }
            }
          }
        }

        if (modified) {
          range.setNumberFormat("@");
          range.setValues(values);
        }
      }
    });
  });

  alertUser("✅ Selesai! Sebanyak " + totalFixed + " nilai timestamp berhasil diubah menjadi format tanggal & waktu (YYYY-MM-DD HH:mm:ss).");
}

// ============================================================
// 🌐 WEB APP ENDPOINT: GET DATA JSON UNTUK LEADER DASHBOARD
// ============================================================
function doGet(e) {
  var sheetName = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : 'BAD & LOST';
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet tidak ditemukan: ' + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var result = dataRange.map(function(row) {
    var obj = {};
    headers.forEach(function(h, idx) {
      if (h) obj[h] = row[idx];
    });
    return obj;
  });

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
