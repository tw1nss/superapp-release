/**
 * =========================================================================
 * 📊 SINKRONISASI ABSENSI SUPERSET TO GSHEET & AUTO-REPORT WHATSAPP (GOWA)
 * =========================================================================
 * Slice ID: 29458 (DETAIL KEHADIRAN)
 * Dashboard Page ID: xQrckAVO8OdW10dKe6SLB
 * Filter Range: Current Month (Bulan Ini)
 * Gateway WA: GoWA (https://wa.superappshub.space)
 * 
 * Update Terbaru:
 * - Jam Kirim Otomatis: Siang 15:30 WIB & Malam 23:15 WIB
 * - Diagnosa Cerdas: Otomatis mendeteksi endpoint permanen jika cache form_data_key expire (403)
 * - Zero Offset Bug: Jam dan tanggal 100% presisi sesuai tampilan Superset
 * - Urutan Otomatis: Check-in terbaru (hari ini) selalu berada di paling atas (DESCENDING)
 * - Format Tanggal Seragam: Kolom E & F menggunakan format standar "YYYY-MM-DD HH:mm:ss"
 * =========================================================================
 */

var ABSENSI_CONFIG = {
  // 🌐 Superset Configuration
  BASE_URL: "https://dash.astronauts.id/",
  SLICE_ID: "29458",
  DASHBOARD_PAGE_ID: "xQrckAVO8OdW10dKe6SLB",
  FORM_DATA_KEY: "x7HzrP0QqQgCmP7QMAeQR_sscb_GAAO1zeKEPOmU1LvWYMFLdsb2Ez5KwTGJOyXj",

  // 📱 GoWA WhatsApp Gateway Configuration
  GOWA_BASE_URL: "https://wa.superappshub.space",
  GOWA_USER: "admin",
  GOWA_PASS: "admin123",

  // Target WhatsApp Group
  DEFAULT_WA_TARGET: "120363411340088513@g.us",

  // 📑 Nama Tab Sheet
  SHEET_RAW: "Raw_Absensi",
  SHEET_REKAP: "Rekap_Hari_Ini",
  SHEET_REKAP_YESTERDAY: "Rekap_Kemarin",

  TIMEZONE: "Asia/Jakarta",
  MAX_RETRY: 2,
  RETRY_DELAY_MS: 1500,

  // Urutan Kronologis Shift Operasional Hub CWG / MTG (Sesuai Roster Resmi)
  SHIFT_ORDER: [
    "P7",     // 07:00 WIB
    "MD10",   // 10:00 WIB (Md10)
    "S13",    // 13:00 WIB
    "M18",    // 18:00 WIB
    "M21",    // 21:00 WIB
    "M22",    // 22:00 WIB
    "M23",    // 23:00 WIB
    "ROTATION",
    "SUPPORT",
    "P6", "MD8", "MD9", "MD11", "S12", "S14", "S16", "M19", "M20", "M24"
  ],

  // Jam Mulai Shift Resmi untuk Display & Validasi
  SHIFT_HOURS: {
    "P7": "07:00",
    "MD10": "10:00",
    "S13": "13:00",
    "M18": "18:00",
    "M21": "21:00",
    "M22": "22:00",
    "M23": "23:00"
  },

  // Daftar nomor yang di-tag / CC otomatis di laporan WA (contoh: ["6281234567890"])
  DEFAULT_CC_MENTIONS: []
};

// ==============================================================================
// 📋 1. MENU USER INTERFACE DI GOOGLE SPREADSHEET
// ==============================================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu("📊 Report Absensi")
    .addItem("🔄 Tarik Data & Kirim Rekap Hari Ini ke WA", "menuSyncAndSendWA")
    .addSeparator()
    .addItem("📥 1. Tarik Data Superset (Hari Ini)", "menuSyncAbsensi")
    .addItem("📲 2. Kirim Rekap Absensi Hari Ini ke WA", "menuSendReportWA")
    .addSeparator()
    .addItem("📅 3. Tarik Rekap Kemarin (H-1 Full Lengkap)", "menuSyncAbsensiYesterday")
    .addItem("📲 4. Kirim Rekap Kemarin (H-1) ke WA", "menuSendReportWAYesterday")
    .addItem("🔄 5. Tarik & Kirim Rekap Kemarin Sekaligus", "menuSyncAndSendWAYesterday")
    .addSeparator()
    .addItem("🧪 Diagnosa Koneksi Superset (Cek Respon API)", "menuDiagnosaSuperset")
    .addItem("🔑 Set / Ganti Cookie Superset", "menuSetSupersetCookie")
    .addItem("📱 Atur JID Target WhatsApp", "menuSetWaTarget")
    .addItem("👥 Atur Kontak CC / Tag (@) WhatsApp", "menuSetCcMentions")
    .addItem("🧪 Test Kirim Pesan GoWA WhatsApp", "menuTestGoWA")
    .addSeparator()
    .addItem("⏱️ Pasang Jadwal Kirim Otomatis (Pagi 08:00, Siang 15:30, Malam 23:45)", "setupAbsensiTriggers")
    .addItem("🛑 Hapus Trigger Otomatis", "removeAbsensiTriggers")
    .addToUi();
}

// ==============================================================================
// 🔑 2. PENGATURAN COOKIE & HELPER PROPERTIES
// ==============================================================================

function getCleanCookie() {
  var props = PropertiesService.getScriptProperties();
  var cookie = props.getProperty("SUPERSET_COOKIE") || props.getProperty("MY_COOKIE") || "";
  cookie = cookie.trim();
  if (!cookie) return "";

  if (cookie.indexOf("session=") === -1 && cookie.indexOf("=") === -1) {
    cookie = "session=" + cookie;
  }
  return cookie;
}

function menuSetSupersetCookie() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentCookie = getCleanCookie();
  var preview = currentCookie ? (currentCookie.substring(0, 35) + "...") : "(Belum ada cookie tersimpan)";

  var prompt = ui.prompt(
    "🔑 Set Cookie Superset (dash.astronauts.id)",
    "Status Cookie saat ini: " + preview + "\n\n" +
    "Cara ambil: Login dash.astronauts.id di Chrome ➔ Tekan F12 ➔ Tab 'Application' ➔ Cookies ➔ Salin nilai 'session'.\n\n" +
    "Paste Cookie di bawah ini:",
    ui.ButtonSet.OK_CANCEL
  );

  if (prompt.getSelectedButton() === ui.Button.OK) {
    var val = prompt.getResponseText().trim();
    if (val) {
      props.setProperty("SUPERSET_COOKIE", val);
      props.setProperty("MY_COOKIE", val);
      ui.alert("✅ Sukses", "Cookie Superset berhasil disimpan!", ui.ButtonSet.OK);
    } else {
      ui.alert("⚠️ Peringatan", "Cookie tidak boleh kosong.", ui.ButtonSet.OK);
    }
  }
}

function menuSetWaTarget() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentTarget = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;

  var prompt = ui.prompt(
    "📱 Atur Target JID WhatsApp",
    "Masukkan ID Grup WA (format: 120363xxx@g.us) atau Nomor Pribadi (format: 62812xxx@s.whatsapp.net):\n\n" +
    "Target saat ini: " + currentTarget,
    ui.ButtonSet.OK_CANCEL
  );

  if (prompt.getSelectedButton() === ui.Button.OK) {
    var val = prompt.getResponseText().trim();
    if (val) {
      props.setProperty("WA_TARGET_ABSENSI", val);
      ui.alert("✅ Sukses", "Target WhatsApp berhasil diubah menjadi: " + val, ui.ButtonSet.OK);
    }
  }
}

function getCcMentions() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty("WA_CC_MENTIONS") || "";
  raw = raw.trim();
  if (!raw) {
    var def = ABSENSI_CONFIG.DEFAULT_CC_MENTIONS || [];
    if (def.length === 0) return [];
    raw = def.join(", ");
  }

  // Pisahkan kontak berdasarkan koma atau baris baru
  var lines = raw.split(/[,\n]/);
  var list = [];

  lines.forEach(function (line) {
    var item = line.trim();
    if (!item) return;

    if (item.toLowerCase() === "@everyone" || item.toLowerCase() === "everyone") {
      list.push({ phone: "everyone", label: "All Members" });
      return;
    }

    // Cek apakah ada label nama/role seperti "(Lead CWG)" atau "- Mas Budi"
    var label = "";
    var parenMatch = item.match(/\((.*?)\)/);
    if (parenMatch) {
      label = parenMatch[1].trim();
    } else if (item.indexOf("-") !== -1) {
      var parts = item.split("-");
      label = parts.slice(1).join("-").trim();
    }

    var numOnly = item.replace(/[^0-9]/g, "");
    if (numOnly.length >= 9) {
      if (numOnly.indexOf("08") === 0) {
        numOnly = "62" + numOnly.substring(1);
      } else if (numOnly.indexOf("8") === 0) {
        numOnly = "62" + numOnly;
      }
      list.push({ phone: numOnly, label: label });
    }
  });

  return list;
}

function menuSetCcMentions() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty("WA_CC_MENTIONS") || "";

  var prompt = ui.prompt(
    "👥 Atur Kontak CC / Tag (@) WhatsApp",
    "Masukkan nomor WhatsApp yang ingin otomatis di-tag / di-CC di laporan WA.\n" +
    "Di WhatsApp grup, tag akan otomatis menampilkan @Nama Kontak sesuai buku telepon penerima dan memicu notifikasi tag.\n\n" +
    "Contoh input yang didukung:\n" +
    "• 081234567890 (Lead CWG)\n" +
    "• 089876543210 - Mas Budi\n" +
    "• 6287711223344\n" +
    "• @everyone (tag seluruh anggota grup)\n\n" +
    "Pisahkan dengan koma atau baris baru jika lebih dari satu kontak.\n\n" +
    "Kontak CC saat ini:\n" + (current || "(Belum ada kontak CC tersimpan)"),
    ui.ButtonSet.OK_CANCEL
  );

  if (prompt.getSelectedButton() === ui.Button.OK) {
    var val = prompt.getResponseText().trim();
    props.setProperty("WA_CC_MENTIONS", val);
    
    var previewList = getCcMentions();
    var previewText = previewList.length > 0
      ? previewList.map(function(c) {
          if (c.phone === "everyone") return "• @everyone (Semua Anggota Grup)";
          return "• @" + c.phone + (c.label ? " (" + c.label + ")" : "");
        }).join("\n")
      : "(Kosong / Tidak ada kontak CC)";

    ui.alert(
      "✅ Kontak CC Disimpan",
      "Format CC yang akan muncul di laporan WhatsApp:\n\n" + previewText + "\n\n" +
      "ℹ️ Catatan:\n" +
      "WhatsApp otomatis merender format '@628...' menjadi '@Nama Kontak' berwarna biru dan mengirimkan notifikasi tag kepada yang bersangkutan.",
      ui.ButtonSet.OK
    );
  }
}

// ==============================================================================
// 🛠️ 3. KONVERSI TIMESTAMP PRESISI (MENCEGAH PERGESERAN JAM & TANGGAL)
// ==============================================================================

function extractEpochMs(val) {
  if (val === null || val === undefined || val === "" || val === "N/A" || val === 0 || val === "0") return 0;
  if (typeof val === "number") {
    return val < 10000000000 ? val * 1000 : val;
  }
  var s = String(val).trim();
  if (!isNaN(s) && s.length >= 10 && s.indexOf("-") === -1 && s.indexOf("/") === -1 && s.indexOf(":") === -1) {
    var n = Number(s);
    return n < 10000000000 ? n * 1000 : n;
  }
  var p = Date.parse(s);
  return !isNaN(p) ? p : 0;
}

function formatDateTime(val) {
  if (val === null || val === undefined || val === "" || val === "N/A" || val === 0 || val === "0") {
    return "N/A";
  }

  // 1. Jika string sudah memiliki pola tanggal & jam (misal: "2026-10-19 6:18:22" atau "2026-10-19 09:59:14")
  var s = String(val).trim();
  var match = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    var y = match[1];
    var m = match[2].length === 1 ? "0" + match[2] : match[2];
    var d = match[3].length === 1 ? "0" + match[3] : match[3];
    var hh = match[4].length === 1 ? "0" + match[4] : match[4];
    var mm = match[5];
    var ss = match[6] ? (match[6].length === 1 ? "0" + match[6] : match[6]) : "00";
    return y + "-" + m + "-" + d + " " + hh + ":" + mm + ":" + ss;
  }

  // 2. Jika angka epoch dari Superset (misal 1792365502000)
  // ⚠️ Nilai epoch dari Superset langsung mencerminkan waktu lokal di zona GMT
  if (typeof val === "number" || (!isNaN(s) && s.length >= 10 && s.indexOf("-") === -1 && s.indexOf("/") === -1 && s.indexOf(":") === -1)) {
    var num = Number(val);
    if (num < 10000000000) num *= 1000;
    var dObj = new Date(num);
    if (!isNaN(dObj.getTime())) {
      return Utilities.formatDate(dObj, "GMT", "yyyy-MM-dd HH:mm:ss");
    }
  }

  // 3. Jika nilai sudah berupa objek Date dari Google Sheets
  if (val instanceof Date) {
    return Utilities.formatDate(val, ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  }

  return s;
}

function extractDateOnly(val) {
  if (val === null || val === undefined || val === "" || val === "N/A") return "";

  var s = String(val).trim();
  var match = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (match) {
    var y = match[1];
    var m = match[2].length === 1 ? "0" + match[2] : match[2];
    var d = match[3].length === 1 ? "0" + match[3] : match[3];
    return y + "-" + m + "-" + d;
  }

  // Jika angka epoch dari Superset
  if (typeof val === "number" || (!isNaN(s) && s.length >= 10 && s.indexOf("-") === -1 && s.indexOf("/") === -1 && s.indexOf(":") === -1)) {
    var num = Number(val);
    if (num < 10000000000) num *= 1000;
    var dObj = new Date(num);
    if (!isNaN(dObj.getTime())) {
      return Utilities.formatDate(dObj, "GMT", "yyyy-MM-dd");
    }
  }

  if (val instanceof Date) {
    return Utilities.formatDate(val, ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd");
  }

  return "";
}

function extractTimeOnly(val) {
  if (val === null || val === undefined || val === "" || val === "N/A" || val === "-") return "-";

  var s = String(val).trim();
  // Tangkap jam & menit dari string secara langsung (misal: "2026-10-19 6:18:22", "2026-10-19 9:59:14", "09:59:14")
  var match = s.match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (match) {
    var h = match[1].length === 1 ? "0" + match[1] : match[1];
    var m = match[2];
    return h + ":" + m;
  }

  // Jika berupa objek Date dari Google Sheets
  if (val instanceof Date) {
    return Utilities.formatDate(val, ABSENSI_CONFIG.TIMEZONE, "HH:mm");
  }

  // Jika angka epoch
  if (typeof val === "number" || (!isNaN(s) && s.length >= 10 && s.indexOf("-") === -1 && s.indexOf("/") === -1 && s.indexOf(":") === -1)) {
    var num = Number(val);
    if (num < 10000000000) num *= 1000;
    var dObj = new Date(num);
    if (!isNaN(dObj.getTime())) {
      return Utilities.formatDate(dObj, "GMT", "HH:mm");
    }
  }

  return s;
}

function getFieldValue(item, possibleKeys) {
  if (!item || typeof item !== "object") return "";
  var itemKeys = Object.keys(item);
  for (var p = 0; p < possibleKeys.length; p++) {
    var target = possibleKeys[p].toLowerCase();
    for (var k = 0; k < itemKeys.length; k++) {
      if (itemKeys[k].toLowerCase() === target) {
        var v = item[itemKeys[k]];
        return v !== null && v !== undefined ? v : "";
      }
    }
  }
  return "";
}

// ==============================================================================
// 🧪 4. DIAGNOSA KONEKSI SUPERSET (MULTI-ENDPOINT RESILIEN)
// ==============================================================================

function menuDiagnosaSuperset() {
  var ui = SpreadsheetApp.getUi();
  var cookie = getCleanCookie();

  if (!cookie) {
    ui.alert(
      "❌ Cookie Kosong",
      "Belum ada Cookie yang tersimpan!\n\nSilakan klik menu:\n📊 Report Absensi ➔ 🔑 Set / Ganti Cookie Superset",
      ui.ButtonSet.OK
    );
    return;
  }

  var timestamp = new Date().getTime();
  var chartId = ABSENSI_CONFIG.SLICE_ID;
  var pageId = ABSENSI_CONFIG.DASHBOARD_PAGE_ID;

  var testEndpoints = [
    {
      name: "1. API Direct Chart (Slice " + chartId + ")",
      url: ABSENSI_CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp
    },
    {
      name: "2. Explore JSON (Dinamis Bulan Ini)",
      url: ABSENSI_CONFIG.BASE_URL + "superset/explore_json/?form_data=" +
        encodeURIComponent(JSON.stringify({ slice_id: Number(chartId), dashboard_page_id: pageId, time_range: "Current month" })) +
        "&force=true&_t=" + timestamp
    }
  ];

  if (ABSENSI_CONFIG.FORM_DATA_KEY) {
    testEndpoints.push({
      name: "3. Explore JSON (Form Data Key Cache)",
      url: ABSENSI_CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(ABSENSI_CONFIG.FORM_DATA_KEY) +
        "&slice_id=" + chartId +
        "&dashboard_page_id=" + encodeURIComponent(pageId) +
        "&force=true&_t=" + timestamp
    });
  }

  var logNotes = [];
  var successDataCount = 0;
  var hasSuccess = false;

  for (var i = 0; i < testEndpoints.length; i++) {
    var ep = testEndpoints[i];
    try {
      var response = UrlFetchApp.fetch(ep.url, {
        method: "get",
        headers: {
          "Cookie": cookie,
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json"
        },
        muteHttpExceptions: true
      });

      var code = response.getResponseCode();
      var text = (response.getContentText() || "").trim();
      var isHtml = text.indexOf("<!DOCTYPE") === 0 || text.indexOf("<html") !== -1 || text.indexOf("/login/") !== -1;

      if (code === 401 || code === 302 || isHtml) {
        ui.alert(
          "❌ Cookie Expired / Tidak Valid (HTTP " + code + ")",
          "Superset menolak login Anda (di-redirect ke login).\n\nPerbarui cookie session dari dash.astronauts.id via menu 'Set Cookie'.",
          ui.ButtonSet.OK
        );
        return;
      }

      if (code === 200) {
        var json = JSON.parse(text);
        var rows = (json.result && json.result[0] && json.result[0].data) ? json.result[0].data : (json.data || []);
        hasSuccess = true;
        successDataCount = rows.length;
        logNotes.push("✅ " + ep.name + " ➔ HTTP 200 OK (" + rows.length + " data baris)");
        break; // Ditemukan endpoint aktif
      } else {
        var msg = (code === 403 && text.indexOf("no longer exists") !== -1)
          ? "Cache key sementara expired (normal)"
          : "HTTP " + code;
        logNotes.push("⚠️ " + ep.name + " ➔ " + msg);
      }
    } catch (e) {
      logNotes.push("❌ " + ep.name + " ➔ " + e.message);
    }
  }

  if (hasSuccess) {
    ui.alert(
      "✅ Koneksi Superset Normal (HTTP 200)",
      "Status Endpoint:\n" + logNotes.join("\n") + "\n\n" +
      "Koneksi berhasil dan sinkronisasi data absensi siap berjalan normal (" + successDataCount + " baris data aktif)!",
      ui.ButtonSet.OK
    );
  } else {
    ui.alert(
      "⚠️ Hasil Diagnosa Endpoint Superset",
      logNotes.join("\n\n") + "\n\n" +
      "Jika muncul 403 'The dataset associated with this chart no longer exists', itu karena kode form_data_key sementara di Superset sudah usang, namun sistem tetap otomatis beralih ke endpoint permanen.",
      ui.ButtonSet.OK
    );
  }
}

// ==============================================================================
// 📥 5. FETCH ENGINE SUPERSET (MULTI-VARIANT URL RESILIEN)
// ==============================================================================

function fetchSupersetAbsensiData() {
  var cookie = getCleanCookie();

  if (!cookie) {
    return { success: false, error: "Cookie Superset belum diset. Silakan set via menu '📊 Report Absensi ➔ 🔑 Set / Ganti Cookie Superset'." };
  }

  var timestamp = new Date().getTime();
  var chartId = ABSENSI_CONFIG.SLICE_ID;
  var pageId = ABSENSI_CONFIG.DASHBOARD_PAGE_ID;
  var formDataKey = ABSENSI_CONFIG.FORM_DATA_KEY;

  var urlVariants = [];

  // Varian 1: Direct API v1 Chart Data (Paling stabil & tidak pernah expire)
  urlVariants.push(
    ABSENSI_CONFIG.BASE_URL + "api/v1/chart/" + chartId + "/data?force=true&_t=" + timestamp
  );

  // Varian 2: Payload Dinamis form_data JSON (Current month)
  var dynamicPayload = JSON.stringify({
    slice_id: Number(chartId),
    dashboard_page_id: pageId,
    time_range: "Current month",
    extra_form_data: { time_range: "Current month" }
  });
  urlVariants.push(
    ABSENSI_CONFIG.BASE_URL + "superset/explore_json/?form_data=" + encodeURIComponent(dynamicPayload) +
    "&force=true&_t=" + timestamp
  );

  // Varian 3: Form Data Key (Jika masih ada di cache Superset)
  if (formDataKey) {
    urlVariants.push(
      ABSENSI_CONFIG.BASE_URL + "superset/explore_json/?form_data_key=" + encodeURIComponent(formDataKey) +
      "&slice_id=" + chartId +
      "&dashboard_page_id=" + encodeURIComponent(pageId) +
      "&force=true&_t=" + timestamp
    );
  }

  var lastError = "";

  for (var i = 0; i < urlVariants.length; i++) {
    for (var attempt = 1; attempt <= ABSENSI_CONFIG.MAX_RETRY; attempt++) {
      try {
        var response = UrlFetchApp.fetch(urlVariants[i], {
          method: "get",
          headers: {
            "Cookie": cookie,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json"
          },
          muteHttpExceptions: true
        });

        var code = response.getResponseCode();
        var respText = (response.getContentText() || "").trim();

        var isHtml = respText.indexOf("<!DOCTYPE") === 0 || respText.indexOf("<html") !== -1 || respText.indexOf("/login/") !== -1;
        if (code === 401 || code === 302 || isHtml) {
          return { success: false, error: "Cookie Superset kadaluarsa (Expired). Silakan perbarui cookie via menu '🔑 Set / Ganti Cookie Superset'." };
        }

        // Jika 403 dataset no longer exists pada form_data_key yang usang, lanjut ke varian berikutnya
        if (code === 403 && respText.indexOf("no longer exists") !== -1) {
          lastError = "Form data key sementara usang (melewati ke endpoint permanen)";
          break;
        }

        if (code !== 200) {
          lastError = "HTTP " + code + ": " + respText.substring(0, 150);
          Utilities.sleep(ABSENSI_CONFIG.RETRY_DELAY_MS);
          continue;
        }

        var json = JSON.parse(respText);
        var rawData = [];

        if (json.result && json.result[0] && json.result[0].data) {
          rawData = json.result[0].data;
        } else if (json.result && json.result[0] && json.result[0].records) {
          rawData = json.result[0].records;
        } else if (json.data && json.data.records) {
          rawData = json.data.records;
        } else if (json.data && Array.isArray(json.data)) {
          rawData = json.data;
        } else if (Array.isArray(json)) {
          rawData = json;
        } else if (json.colnames && json.data) {
          rawData = json.data.map(function (row) {
            var item = {};
            json.colnames.forEach(function (col, idx) {
              item[col] = row[idx];
            });
            return item;
          });
        }

        if (rawData && rawData.length > 0) {
          Logger.log("✅ Berhasil menarik " + rawData.length + " data absensi.");
          return { success: true, data: rawData };
        } else {
          lastError = "Respon HTTP 200 tetapi data kosong.";
        }
      } catch (err) {
        lastError = err.message;
        Utilities.sleep(ABSENSI_CONFIG.RETRY_DELAY_MS);
      }
    }
  }

  return { success: false, error: "Gagal mengambil data dari Superset: " + lastError };
}

// ==============================================================================
// 📅 6. AMBIL JADWAL ROSTER HARIAN (CROSS-CHECK GSHEET JADWAL)
// ==============================================================================

function getScheduledEmployeesForDate(ss, targetDateStr) {
  var scheduleMap = {};

  if (!ss) return scheduleMap;

  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var sName = sh.getName();

    if (sName === ABSENSI_CONFIG.SHEET_RAW || sName === ABSENSI_CONFIG.SHEET_REKAP) continue;

    var maxCols = sh.getLastColumn();
    var maxRows = sh.getLastRow();
    if (maxCols < 5 || maxRows < 4) continue;

    var row2 = sh.getRange(2, 1, 1, maxCols).getValues()[0];
    var targetColIdx = -1;

    for (var c = 0; c < row2.length; c++) {
      var valDate = extractDateOnly(row2[c]);
      if (valDate === targetDateStr) {
        targetColIdx = c + 1;
        break;
      }
    }

    if (targetColIdx !== -1) {
      var empData = sh.getRange(4, 1, maxRows - 3, Math.max(targetColIdx, 4)).getValues();
      for (var r = 0; r < empData.length; r++) {
        var empName = String(empData[r][1] || "").trim();
        var empRole = String(empData[r][3] || "").trim();
        var shiftCode = String(empData[r][targetColIdx - 1] || "").trim().toUpperCase();

        if (empName && shiftCode && shiftCode !== "OFF" && shiftCode !== "-" && shiftCode !== "") {
          scheduleMap[empName.toLowerCase()] = {
            name: empName,
            role: empRole,
            shift: shiftCode
          };
        }
      }
      Logger.log("✅ Ditemukan jadwal di sheet '" + sName + "' sebanyak " + Object.keys(scheduleMap).length + " karyawan bertugas.");
      return scheduleMap;
    }
  }

  return scheduleMap;
}

// ==============================================================================
// 📊 7. TULIS DATA KE SHEET (RAW_ABSENSI & REKAP_HARI_INI)
// ==============================================================================

function normalizeRawAbsensiList(rawList) {
  var normalizedList = [];

  rawList.forEach(function (item) {
    var sId = getFieldValue(item, ["staff_id", "staffid", "id"]);
    var sName = getFieldValue(item, ["staff_name", "staffname", "name", "nama"]);
    var sRole = getFieldValue(item, ["schedule_role", "role", "divisi", "department"]);
    var sShift = getFieldValue(item, ["shift_name", "shift", "shiftname"]);
    var rawCheckin = getFieldValue(item, ["checkin_time", "check_in_time", "checkin", "max(checkin_time)", "last_checkin_date"]);
    var rawCheckout = getFieldValue(item, ["checkout_time", "check_out_time", "checkout", "max(checkout_time)"]);
    var sStatus = getFieldValue(item, ["status", "kehadiran"]) || "HADIR";
    var sLate = getFieldValue(item, ["attendance_is_late", "is_late", "late", "keterangan_terlambat"]);
    var rawDateKey = getFieldValue(item, ["date_key", "date", "tanggal"]);

    var epochIn = extractEpochMs(rawCheckin);
    var epochOut = extractEpochMs(rawCheckout);

    var sCheckinFormatted = formatDateTime(rawCheckin);
    var sCheckoutFormatted = formatDateTime(rawCheckout);
    var sDateFormatted = extractDateOnly(rawDateKey) || extractDateOnly(rawCheckin);

    normalizedList.push({
      staff_id: sId,
      staff_name: sName,
      schedule_role: sRole,
      shift_name: String(sShift || "").toUpperCase(),
      checkin_time: sCheckinFormatted,
      checkout_time: sCheckoutFormatted,
      epoch_checkin: epochIn,
      epoch_checkout: epochOut,
      date_str: sDateFormatted,
      STATUS: sStatus,
      attendance_is_late: sLate
    });
  });

  // Urutkan dari check-in TERBARU paling atas (DESCENDING)
  normalizedList.sort(function (a, b) {
    return b.epoch_checkin - a.epoch_checkin;
  });

  return normalizedList;
}

function writeRawAbsensiToSheet(ss, normalizedList) {
  var rawSheet = ss.getSheetByName(ABSENSI_CONFIG.SHEET_RAW);
  if (!rawSheet) {
    rawSheet = ss.insertSheet(ABSENSI_CONFIG.SHEET_RAW);
  }
  rawSheet.clear();

  var headers = [
    "Staff ID",
    "Nama Karyawan",
    "Role / Divisi",
    "Shift",
    "Check-in Time",
    "Check-out Time",
    "Status",
    "Keterangan Terlambat",
    "Tanggal (Date Key)"
  ];

  var rows = normalizedList.map(function (item) {
    return [
      item.staff_id,
      item.staff_name,
      item.schedule_role,
      item.shift_name,
      item.checkin_time,
      item.checkout_time,
      item.STATUS,
      item.attendance_is_late,
      item.date_str
    ];
  });

  rawSheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight("bold")
    .setBackground("#1E293B")
    .setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  if (rows.length > 0) {
    var dataRange = rawSheet.getRange(2, 1, rows.length, headers.length);
    dataRange.setValues(rows);

    rawSheet.getRange(2, 5, rows.length, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    rawSheet.getRange(2, 9, rows.length, 1).setNumberFormat("yyyy-mm-dd");
  }

  rawSheet.setFrozenRows(1);
  rawSheet.autoResizeColumns(1, headers.length);
  return rows.length;
}

function getYesterdayDateStr() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd");
}

function syncAbsensiToSheet() {
  var fetchResult = fetchSupersetAbsensiData();
  if (!fetchResult.success) {
    Logger.log("❌ Gagal: " + fetchResult.error);
    return fetchResult;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    return { success: false, error: "Tidak dapat mengakses Google Spreadsheet aktif." };
  }

  var normalizedList = normalizeRawAbsensiList(fetchResult.data);
  var rowCount = writeRawAbsensiToSheet(ss, normalizedList);

  // Olah Summary Rekap Hari Ini
  var todayDateStr = Utilities.formatDate(new Date(), ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd");
  var scheduleMap = getScheduledEmployeesForDate(ss, todayDateStr);
  var summary = generateDetailedAttendanceSummary(normalizedList, todayDateStr, scheduleMap);

  writeDetailedSummaryToSheet(ss, summary, ABSENSI_CONFIG.SHEET_REKAP, "📊 REKAP KEHADIRAN HARIAN PER SHIFT (HARI INI)");

  return { success: true, count: rowCount, summary: summary };
}

function syncAbsensiYesterdayToSheet() {
  var fetchResult = fetchSupersetAbsensiData();
  if (!fetchResult.success) {
    Logger.log("❌ Gagal: " + fetchResult.error);
    return fetchResult;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    return { success: false, error: "Tidak dapat mengakses Google Spreadsheet aktif." };
  }

  var normalizedList = normalizeRawAbsensiList(fetchResult.data);
  var rowCount = writeRawAbsensiToSheet(ss, normalizedList);

  // Olah Summary Rekap Kemarin (H-1 Full Lengkap)
  var yesterdayDateStr = getYesterdayDateStr();
  var scheduleMap = getScheduledEmployeesForDate(ss, yesterdayDateStr);
  var summary = generateDetailedAttendanceSummary(normalizedList, yesterdayDateStr, scheduleMap);

  writeDetailedSummaryToSheet(ss, summary, ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY, "📊 REKAP KEHADIRAN RESMI PER SHIFT (H-1 KEMARIN)");

  return { success: true, count: rowCount, summary: summary };
}

function menuSyncAbsensi() {
  var ui = SpreadsheetApp.getUi();
  var res = syncAbsensiToSheet();
  if (res.success) {
    ui.alert(
      "✅ Sinkronisasi Hari Ini Berhasil",
      "Total Data Masuk: " + res.count + " baris absensi bulan ini.\n\n" +
      "Ringkasan Kehadiran Hari Ini (" + res.summary.dateStr + "):\n" +
      "• Total Hadir: " + res.summary.totalHadir + " orang\n" +
      "• Total Tidak Hadir: " + res.summary.totalTidakHadir + " orang\n" +
      "• Terlambat: " + res.summary.totalTerlambat + " orang\n\n" +
      "Data check-in dan tanggal shift sudah 100% presisi!",
      ui.ButtonSet.OK
    );
  } else {
    ui.alert("❌ Gagal Sinkronisasi", res.error, ui.ButtonSet.OK);
  }
}

function menuSyncAbsensiYesterday() {
  var ui = SpreadsheetApp.getUi();
  var res = syncAbsensiYesterdayToSheet();
  if (res.success) {
    ui.alert(
      "✅ Rekap Kemarin (H-1) Berhasil Ditarik",
      "Tanggal Rekap: " + res.summary.dateStr + " (H-1 Kemarin)\n\n" +
      "Ringkasan Kehadiran Kemarin:\n" +
      "• Total Hadir: " + res.summary.totalHadir + " orang\n" +
      "• Total Tidak Hadir: " + res.summary.totalTidakHadir + " orang\n" +
      "• Terlambat: " + res.summary.totalTerlambat + " orang\n\n" +
      "Data lengkap telah ditulis ke tab '" + ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY + "'!\n\n" +
      "Silakan cek tab '" + ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY + "' atau klik menu '📲 4. Kirim Rekap Kemarin ke WA' untuk mengirim laporan audit ke WA.",
      ui.ButtonSet.OK
    );
  } else {
    ui.alert("❌ Gagal Sinkronisasi Kemarin", res.error, ui.ButtonSet.OK);
  }
}

// ==============================================================================
// 🧮 8. KALKULASI DETAIL ABSENSI PER SHIFT (HADIR & TIDAK HADIR)
// ==============================================================================

function generateDetailedAttendanceSummary(records, targetDateStr, scheduleMap) {
  var targetDateNorm = extractDateOnly(targetDateStr) || targetDateStr;

  var todayRecords = records.filter(function (item) {
    var dStr = extractDateOnly(item.date_str) || extractDateOnly(item.checkin_time);
    return dStr === targetDateNorm;
  });

  var usedDateStr = targetDateNorm;

  if (todayRecords.length === 0 && records.length > 0) {
    for (var r = 0; r < records.length; r++) {
      var cand = extractDateOnly(records[r].date_str) || extractDateOnly(records[r].checkin_time);
      if (cand) {
        usedDateStr = cand;
        break;
      }
    }
    todayRecords = records.filter(function (item) {
      var dStr = extractDateOnly(item.date_str) || extractDateOnly(item.checkin_time);
      return dStr === usedDateStr;
    });
  }

  var shiftsData = {};
  var attendanceByName = {};

  todayRecords.forEach(function (item) {
    var name = String(item.staff_name || "").trim();
    if (!name) return;

    var shift = (item.shift_name || "LAINNYA").toUpperCase();
    var status = String(item.STATUS || "").toUpperCase();
    var isPresent = status === "HADIR" || (item.checkin_time !== "N/A" && item.checkin_time !== "" && item.checkin_time !== "-");

    var lateStr = String(item.attendance_is_late || "").toLowerCase();
    var isLate = lateStr.indexOf("terlambat") !== -1 || lateStr.indexOf("late") !== -1;

    var displayCheckin = formatDateTime(item.checkin_time);
    if (displayCheckin === "N/A" || !displayCheckin) {
      displayCheckin = item.checkin_time || "-";
    }

    var role = item.schedule_role || "-";
    var fullNameWithRole = name + (role && role !== "-" ? " (" + role + ")" : "");

    attendanceByName[name.toLowerCase()] = {
      name: name,
      role: role,
      fullNameWithRole: fullNameWithRole,
      shift: shift,
      checkin: displayCheckin,
      isPresent: isPresent,
      isLate: isLate
    };
  });

  // 1. Masukkan karyawan yang dijadwalkan dari GSheet Jadwal
  for (var key in scheduleMap) {
    var sch = scheduleMap[key];
    var sCode = sch.shift;

    if (!shiftsData[sCode]) {
      shiftsData[sCode] = { hadir: [], tidakHadir: [] };
    }

    var record = attendanceByName[key];
    if (record && record.isPresent) {
      shiftsData[sCode].hadir.push(record);
    } else {
      var schRole = sch.role || "-";
      var schFullName = sch.name + (schRole && schRole !== "-" ? " (" + schRole + ")" : "");
      shiftsData[sCode].tidakHadir.push({
        name: sch.name,
        role: schRole,
        fullNameWithRole: schFullName,
        shift: sCode,
        checkin: "Belum Tap",
        isPresent: false,
        isLate: false
      });
    }
  }

  // 2. Masukkan staf yang hadir di Superset (yang belum tercakup di jadwal)
  for (var nameKey in attendanceByName) {
    var rec = attendanceByName[nameKey];
    var shiftCode = rec.shift;

    if (!shiftsData[shiftCode]) {
      shiftsData[shiftCode] = { hadir: [], tidakHadir: [] };
    }

    var alreadyAdded = shiftsData[shiftCode].hadir.some(function (h) {
      return h.name.toLowerCase() === rec.name.toLowerCase();
    });

    if (!alreadyAdded) {
      if (rec.isPresent) {
        shiftsData[shiftCode].hadir.push(rec);
      } else {
        shiftsData[shiftCode].tidakHadir.push(rec);
      }
    }
  }

  // Urutkan shift sesuai SHIFT_ORDER
  var orderedShifts = [];
  ABSENSI_CONFIG.SHIFT_ORDER.forEach(function (s) {
    if (shiftsData[s] && (shiftsData[s].hadir.length > 0 || shiftsData[s].tidakHadir.length > 0)) {
      orderedShifts.push({
        shift: s,
        hadir: shiftsData[s].hadir,
        tidakHadir: shiftsData[s].tidakHadir
      });
      delete shiftsData[s];
    }
  });

  for (var extraShift in shiftsData) {
    if (shiftsData[extraShift].hadir.length > 0 || shiftsData[extraShift].tidakHadir.length > 0) {
      orderedShifts.push({
        shift: extraShift,
        hadir: shiftsData[extraShift].hadir,
        tidakHadir: shiftsData[extraShift].tidakHadir
      });
    }
  }

  var totalHadir = 0;
  var totalTidakHadir = 0;
  var totalTerlambat = 0;

  orderedShifts.forEach(function (item) {
    totalHadir += item.hadir.length;
    totalTidakHadir += item.tidakHadir.length;
    item.hadir.forEach(function (h) {
      if (h.isLate) totalTerlambat++;
    });
  });

  return {
    dateStr: usedDateStr,
    totalHadir: totalHadir,
    totalTidakHadir: totalTidakHadir,
    totalTerlambat: totalTerlambat,
    shifts: orderedShifts
  };
}

function writeDetailedSummaryToSheet(ss, summary, targetSheetName, titleText) {
  var sheetName = targetSheetName || ABSENSI_CONFIG.SHEET_REKAP;
  var title = titleText || "📊 REKAP KEHADIRAN HARIAN PER SHIFT";
  var rekapSheet = ss.getSheetByName(sheetName);
  if (!rekapSheet) {
    rekapSheet = ss.insertSheet(sheetName);
  }
  rekapSheet.clear();

  var data = [
    [title, "", "", ""],
    ["Tanggal Laporan", summary.dateStr, "", ""],
    ["Waktu Update", Utilities.formatDate(new Date(), ABSENSI_CONFIG.TIMEZONE, "HH:mm:ss 'WIB'"), "", ""],
    ["", "", "", ""],
    ["RINGKASAN TOTAL", "JUMLAH", "", ""],
    ["Total Hadir", summary.totalHadir, "", ""],
    ["Total Tidak Hadir", summary.totalTidakHadir, "", ""],
    ["Total Terlambat", summary.totalTerlambat, "", ""],
    ["", "", "", ""],
    ["SHIFT", "STATUS", "NAMA KARYAWAN", "JAM MASUK / KETERANGAN"]
  ];

  summary.shifts.forEach(function (sData) {
    sData.hadir.forEach(function (h) {
      var displayName = h.fullNameWithRole || (h.name + (h.role && h.role !== "-" ? " (" + h.role + ")" : ""));
      data.push([
        sData.shift,
        "✅ HADIR" + (h.isLate ? " (TERLAMBAT)" : ""),
        displayName,
        h.checkin
      ]);
    });

    sData.tidakHadir.forEach(function (th) {
      var displayName = th.fullNameWithRole || (th.name + (th.role && th.role !== "-" ? " (" + th.role + ")" : ""));
      data.push([
        sData.shift,
        "❌ TIDAK HADIR",
        displayName,
        "Belum Ada Tap Masuk"
      ]);
    });
  });

  rekapSheet.getRange(1, 1, data.length, 4).setValues(data);
  rekapSheet.getRange(1, 1, 1, 4).merge().setFontWeight("bold").setFontSize(12).setBackground("#0284C7").setFontColor("#FFFFFF");
  rekapSheet.getRange(5, 1, 1, 2).setFontWeight("bold").setBackground("#F1F5F9");
  rekapSheet.getRange(10, 1, 1, 4).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
  rekapSheet.autoResizeColumns(1, 4);
}

// ==============================================================================
// 📖 8B. BACA SUMMARY LANGSUNG DARI TAB REKAP (REKAP_HARI_INI / REKAP_KEMARIN)
// ==============================================================================

function getSummaryFromRekapSheet(ss, targetSheetName) {
  var sheetName = targetSheetName || ABSENSI_CONFIG.SHEET_REKAP;
  var rekapSheet = ss.getSheetByName(sheetName);
  if (!rekapSheet || rekapSheet.getLastRow() < 11) {
    return null;
  }

  var dateVal = rekapSheet.getRange(2, 2).getValue();
  var dateStr = extractDateOnly(dateVal) || Utilities.formatDate(new Date(), ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd");

  var totalHadirVal = Number(rekapSheet.getRange(6, 2).getValue()) || 0;
  var totalTidakHadirVal = Number(rekapSheet.getRange(7, 2).getValue()) || 0;
  var totalTerlambatVal = Number(rekapSheet.getRange(8, 2).getValue()) || 0;

  var lastRow = rekapSheet.getLastRow();
  var rows = rekapSheet.getRange(11, 1, lastRow - 10, 4).getValues();

  var shiftsMap = {};

  for (var i = 0; i < rows.length; i++) {
    var shiftName = String(rows[i][0] || "").trim().toUpperCase();
    var statusStr = String(rows[i][1] || "").trim().toUpperCase();
    var nameWithRole = String(rows[i][2] || "").trim();
    var jamOrKet = rows[i][3];

    if (!shiftName || !nameWithRole) continue;

    if (!shiftsMap[shiftName]) {
      shiftsMap[shiftName] = { hadir: [], tidakHadir: [] };
    }

    var isHadir = statusStr.indexOf("HADIR") !== -1 && statusStr.indexOf("TIDAK") === -1;
    var isLate = statusStr.indexOf("TERLAMBAT") !== -1 || statusStr.indexOf("LATE") !== -1;

    var sName = nameWithRole;
    var sRole = "-";
    var roleMatch = nameWithRole.match(/^(.*?)\s*\((.*?)\)$/);
    if (roleMatch) {
      sName = roleMatch[1].trim();
      sRole = roleMatch[2].trim();
    }

    if (isHadir) {
      shiftsMap[shiftName].hadir.push({
        name: sName,
        role: sRole,
        fullNameWithRole: nameWithRole,
        shift: shiftName,
        checkin: jamOrKet,
        isPresent: true,
        isLate: isLate
      });
    } else {
      shiftsMap[shiftName].tidakHadir.push({
        name: sName,
        role: sRole,
        fullNameWithRole: nameWithRole,
        shift: shiftName,
        checkin: "Belum Tap",
        isPresent: false,
        isLate: false
      });
    }
  }

  var orderedShifts = [];
  ABSENSI_CONFIG.SHIFT_ORDER.forEach(function (s) {
    if (shiftsMap[s]) {
      orderedShifts.push({
        shift: s,
        hadir: shiftsMap[s].hadir,
        tidakHadir: shiftsMap[s].tidakHadir
      });
      delete shiftsMap[s];
    }
  });

  for (var extra in shiftsMap) {
    orderedShifts.push({
      shift: extra,
      hadir: shiftsMap[extra].hadir,
      tidakHadir: shiftsMap[extra].tidakHadir
    });
  }

  var calcHadir = 0;
  var calcTidakHadir = 0;
  var calcTerlambat = 0;
  orderedShifts.forEach(function (s) {
    calcHadir += s.hadir.length;
    calcTidakHadir += s.tidakHadir.length;
    s.hadir.forEach(function (h) {
      if (h.isLate) calcTerlambat++;
    });
  });

  return {
    dateStr: dateStr,
    totalHadir: calcHadir || totalHadirVal,
    totalTidakHadir: calcTidakHadir || totalTidakHadirVal,
    totalTerlambat: calcTerlambat || totalTerlambatVal,
    shifts: orderedShifts
  };
}

// ==============================================================================
// 💬 9. FORMAT PESAN LENGKAP & PENGIRIMAN REPORT KE WHATSAPP (GOWA)
// ==============================================================================

function buildDetailedWhatsAppMessage(summary, isYesterday) {
  var now = new Date();
  var dateFormatted = Utilities.formatDate(now, ABSENSI_CONFIG.TIMEZONE, "EEEE, dd MMMM yyyy");
  var timeFormatted = Utilities.formatDate(now, ABSENSI_CONFIG.TIMEZONE, "HH:mm");

  var headerTitle = isYesterday ? "📊 *REKAP ABSENSI RESMI (H-1 / KEMARIN)*\n" : "📊 *REKAP ABSENSI HARIAN HUB CWG / MTG*\n";
  var subTitle = isYesterday
    ? ("📅 Tanggal: " + summary.dateStr + " | Final Audit Data Astro (" + timeFormatted + " WIB)\n")
    : ("📅 " + dateFormatted + " | Update: " + timeFormatted + " WIB\n");

  var msg = headerTitle;
  msg += subTitle;
  msg += "━━━━━━━━━━━━━━━━━━━━━\n";
  msg += "👥 *TOTAL OPERASIONAL:*\n";
  msg += "• Hadir       : *" + summary.totalHadir + " Orang* ✅\n";
  msg += "• Tidak Hadir : *" + summary.totalTidakHadir + " Orang* ❌\n";
  if (summary.totalTerlambat > 0) {
    msg += "• Terlambat   : *" + summary.totalTerlambat + " Orang* ⚠️\n";
  }
  msg += "━━━━━━━━━━━━━━━━━━━━━\n\n";

  msg += "📋 *RINCIAN KEHADIRAN PER SHIFT:*\n\n";

  if (summary.shifts.length === 0) {
    msg += "_Belum ada data shift untuk tanggal ini._\n\n";
  } else {
    summary.shifts.forEach(function (sData) {
      var icon = sData.shift.indexOf("P") === 0 ? "🌅" :
        (sData.shift.indexOf("MD") === 0 ? "☀️" :
          (sData.shift.indexOf("S") === 0 ? "🌤️" :
            (sData.shift.indexOf("M") === 0 ? "🌙" : "🔄")));

      msg += icon + " *SHIFT " + sData.shift + "*\n";
      msg += "• Hadir: " + sData.hadir.length + " org | Tidak Hadir: " + sData.tidakHadir.length + " org\n";

      // Daftar Hadir
      if (sData.hadir.length > 0) {
        msg += "✅ *Hadir:*\n";
        sData.hadir.forEach(function (h, idx) {
          var jam = extractTimeOnly(h.checkin);
          var displayName = h.fullNameWithRole || (h.name + (h.role && h.role !== "-" ? " (" + h.role + ")" : ""));
          var lateTag = h.isLate ? " ⚠️ _(Terlambat)_" : "";
          msg += "  " + (idx + 1) + ". " + displayName + " (" + jam + " WIB)" + lateTag + "\n";
        });
      }

      // Daftar Tidak Hadir
      if (sData.tidakHadir.length > 0) {
        msg += "❌ *Tidak Hadir:*\n";
        sData.tidakHadir.forEach(function (th, idx) {
          var displayName = th.fullNameWithRole || (th.name + (th.role && th.role !== "-" ? " (" + th.role + ")" : ""));
          msg += "  " + (idx + 1) + ". " + displayName + " _(Belum Tap)_\n";
        });
      }

      msg += "\n";
    });
  }

  // Kontak CC / Tagging Otomatis
  var ccList = getCcMentions();
  if (ccList && ccList.length > 0) {
    msg += "━━━━━━━━━━━━━━━━━━━━━\n";
    if (ccList.length === 1 && !ccList[0].label) {
      msg += "👥 CC: @" + ccList[0].phone + "\n";
    } else {
      msg += "👥 *CC:*\n";
      ccList.forEach(function (cc) {
        if (cc.phone === "everyone") {
          msg += "• @everyone\n";
        } else {
          var labelStr = cc.label ? " (" + cc.label + ")" : "";
          msg += "• @" + cc.phone + labelStr + "\n";
        }
      });
    }
  }

  msg += "━━━━━━━━━━━━━━━━━━━━━\n";
  msg += isYesterday ? "_Laporan rekap resmi kemarin (H-1) dikirim oleh SuperApp Bot_" : "_Laporan otomatis dikirim oleh SuperApp Bot_";

  return msg;
}

function sendWhatsAppMessage(target, message, customMentions) {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = props.getProperty("GOWA_BASE_URL") || ABSENSI_CONFIG.GOWA_BASE_URL;
  var user = props.getProperty("GOWA_USER") || ABSENSI_CONFIG.GOWA_USER;
  var pass = props.getProperty("GOWA_PASS") || ABSENSI_CONFIG.GOWA_PASS;

  var url = baseUrl.replace(/\/$/, "") + "/send/message";
  var payload = {
    "phone": target,
    "message": message
  };

  var ccList = customMentions || getCcMentions();
  if (ccList && ccList.length > 0) {
    var mentionJids = [];
    ccList.forEach(function (item) {
      var phone = typeof item === "object" ? item.phone : item;
      phone = String(phone).trim();
      if (phone === "everyone" || phone === "@everyone") {
        mentionJids.push("@everyone");
      } else {
        var clean = phone.replace(/[^0-9]/g, "");
        if (clean.length >= 9) {
          mentionJids.push(clean + "@s.whatsapp.net");
        }
      }
    });

    if (mentionJids.length > 0) {
      payload["mentions"] = mentionJids;
    }
  }

  var headers = {
    "Content-Type": "application/json"
  };

  if (user && pass) {
    headers["Authorization"] = "Basic " + Utilities.base64Encode(user + ":" + pass);
  }

  var options = {
    "method": "post",
    "contentType": "application/json",
    "headers": headers,
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var respText = response.getContentText();

    if (code === 200) {
      return { success: true, text: respText };
    } else {
      return { success: false, error: "HTTP " + code + ": " + respText };
    }
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function menuSendReportWA() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Coba ambil summary langsung dari tab Rekap_Hari_Ini jika sudah ada data
  var summary = getSummaryFromRekapSheet(ss);

  // 2. Jika tab Rekap_Hari_Ini belum ada atau kosong, generate dari Raw_Absensi atau Sync
  if (!summary) {
    var rawSheet = ss.getSheetByName(ABSENSI_CONFIG.SHEET_RAW);
    if (!rawSheet || rawSheet.getLastRow() < 2) {
      ui.alert("⚠️ Data Kosong", "Silakan klik menu '📥 1. Tarik Data Superset (Bulan Ini)' terlebih dahulu sebelum kirim WA.", ui.ButtonSet.OK);
      return;
    }

    var values = rawSheet.getDataRange().getValues();
    var rawList = [];

    for (var i = 1; i < values.length; i++) {
      rawList.push({
        staff_id: values[i][0],
        staff_name: values[i][1],
        schedule_role: values[i][2],
        shift_name: values[i][3],
        checkin_time: values[i][4],
        checkout_time: values[i][5],
        STATUS: values[i][6],
        attendance_is_late: values[i][7],
        date_str: extractDateOnly(values[i][8]) || extractDateOnly(values[i][4])
      });
    }

    var todayDateStr = Utilities.formatDate(new Date(), ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd");
    var scheduleMap = getScheduledEmployeesForDate(ss, todayDateStr);
    summary = generateDetailedAttendanceSummary(rawList, todayDateStr, scheduleMap);
    writeDetailedSummaryToSheet(ss, summary);
  }

  var message = buildDetailedWhatsAppMessage(summary);
  var props = PropertiesService.getScriptProperties();
  var target = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;

  var confirm = ui.alert(
    "📲 Konfirmasi Pengiriman WhatsApp",
    "Target: " + target + "\n\nIsi Pesan:\n\n" + message + "\n\nKirim sekarang?",
    ui.ButtonSet.YES_NO
  );

  if (confirm === ui.Button.YES) {
    var sendRes = sendWhatsAppMessage(target, message);
    if (sendRes.success) {
      ui.alert("✅ Sukses", "Laporan absensi berhasil dikirim ke WhatsApp!", ui.ButtonSet.OK);
    } else {
      ui.alert("❌ Gagal Kirim", "Error: " + sendRes.error, ui.ButtonSet.OK);
    }
  }
}

function menuSendReportWAYesterday() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Coba ambil summary langsung dari tab Rekap_Kemarin jika sudah ada data
  var summary = getSummaryFromRekapSheet(ss, ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY);

  // 2. Jika tab Rekap_Kemarin belum ada atau kosong, generate otomatis
  if (!summary) {
    var syncRes = syncAbsensiYesterdayToSheet();
    if (!syncRes.success) {
      ui.alert("⚠️ Gagal Menyiapkan Rekap Kemarin", syncRes.error, ui.ButtonSet.OK);
      return;
    }
    summary = syncRes.summary;
  }

  var message = buildDetailedWhatsAppMessage(summary, true);
  var props = PropertiesService.getScriptProperties();
  var target = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;

  var confirm = ui.alert(
    "📲 Konfirmasi Kirim Rekap Kemarin (H-1)",
    "Target: " + target + "\n\nIsi Pesan:\n\n" + message + "\n\nKirim sekarang?",
    ui.ButtonSet.YES_NO
  );

  if (confirm === ui.Button.YES) {
    var sendRes = sendWhatsAppMessage(target, message);
    if (sendRes.success) {
      ui.alert("✅ Sukses", "Laporan absensi kemarin (H-1) berhasil dikirim ke WhatsApp!", ui.ButtonSet.OK);
    } else {
      ui.alert("❌ Gagal Kirim", "Error: " + sendRes.error, ui.ButtonSet.OK);
    }
  }
}

function menuSyncAndSendWAYesterday() {
  syncAndSendYesterdayReport(false);
}

function syncAndSendYesterdayReport(isSilent) {
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (_) { }

  var syncRes = syncAbsensiYesterdayToSheet();
  if (!syncRes.success) {
    Logger.log("❌ Gagal Sync Kemarin: " + syncRes.error);
    if (!isSilent && ui) {
      ui.alert(
        "❌ Gagal Menarik Data Kemarin dari Superset",
        syncRes.error,
        ui.ButtonSet.OK
      );
    }
    return syncRes;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary = getSummaryFromRekapSheet(ss, ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY) || syncRes.summary;

  var message = buildDetailedWhatsAppMessage(summary, true);
  var props = PropertiesService.getScriptProperties();
  var target = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;

  var sendRes = sendWhatsAppMessage(target, message);
  Logger.log("Send WhatsApp Yesterday result: " + JSON.stringify(sendRes));

  if (!isSilent && ui) {
    if (sendRes.success) {
      ui.alert(
        "✅ Berhasil!",
        "Data absensi kemarin (H-1) tanggal " + summary.dateStr + " berhasil ditarik dan dikirim ke " + target + "!",
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "⚠️ Data Masuk ke Sheet, Tapi Gagal Kirim WA",
        "Data tersimpan di tab '" + ABSENSI_CONFIG.SHEET_REKAP_YESTERDAY + "', tapi gagal kirim WA: " + sendRes.error,
        ui.ButtonSet.OK
      );
    }
  }

  return sendRes;
}

function menuSyncAndSendWA() {
  syncAndSendWhatsAppReport(false);
}

function syncAndSendWhatsAppReport(isSilent) {
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (_) { }

  var syncRes = syncAbsensiToSheet();
  if (!syncRes.success) {
    Logger.log("❌ Gagal Sync: " + syncRes.error);
    if (!isSilent && ui) {
      ui.alert(
        "❌ Gagal Menarik Data Superset",
        syncRes.error + "\n\nCoba jalankan menu:\n'📊 Report Absensi ➔ 🧪 Diagnosa Koneksi Superset' untuk melihat detail respon server.",
        ui.ButtonSet.OK
      );
    }
    return syncRes;
  }

  // Ambil summary dari tab Rekap_Hari_Ini yang baru saja di-write agar 100% konsisten
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary = getSummaryFromRekapSheet(ss, ABSENSI_CONFIG.SHEET_REKAP) || syncRes.summary;

  var message = buildDetailedWhatsAppMessage(summary, false);
  var props = PropertiesService.getScriptProperties();
  var target = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;

  var sendRes = sendWhatsAppMessage(target, message);
  Logger.log("Send WhatsApp result: " + JSON.stringify(sendRes));

  if (!isSilent && ui) {
    if (sendRes.success) {
      ui.alert(
        "✅ Berhasil!",
        "Data absensi (" + syncRes.count + " baris) berhasil ditarik dan laporan WA telah terkirim ke " + target + "!",
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "⚠️ Data Masuk ke Sheet, Tapi Gagal Kirim WA",
        "Data berhasil di-sync ke tab 'Raw_Absensi' & 'Rekap_Hari_Ini'.\n\nTetapi pengiriman WA gagal: " + sendRes.error,
        ui.ButtonSet.OK
      );
    }
  }

  return sendRes;
}

function menuTestGoWA() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var target = props.getProperty("WA_TARGET_ABSENSI") || ABSENSI_CONFIG.DEFAULT_WA_TARGET;
  var ccList = getCcMentions();

  var testMsg = "🤖 *TEST KONEKSI GOWA GATEWAY*\n\n" +
    "Koneksi bot WhatsApp SuperApp absensi berhasil tersambung!\n" +
    "🕒 Waktu: " + Utilities.formatDate(new Date(), ABSENSI_CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss") + " WIB\n";

  if (ccList.length > 0) {
    testMsg += "\n👥 *Test Mention CC:*\n";
    ccList.forEach(function (c) {
      if (c.phone === "everyone") {
        testMsg += "• @everyone\n";
      } else {
        testMsg += "• @" + c.phone + (c.label ? " (" + c.label + ")" : "") + "\n";
      }
    });
  }

  var res = sendWhatsAppMessage(target, testMsg);

  if (res.success) {
    var mentionSummary = ccList.length > 0 
      ? "\n\n👥 Kontak CC yang di-tag:\n" + ccList.map(function(c){ return "• @" + c.phone + (c.label ? " (" + c.label + ")" : ""); }).join("\n")
      : "\n\n(Belum ada kontak CC yang diatur. Silakan atur lewat menu '👥 Atur Kontak CC / Tag (@) WhatsApp')";

    ui.alert("✅ Terkirim!", "Pesan uji coba berhasil terkirim ke: " + target + mentionSummary, ui.ButtonSet.OK);
  } else {
    ui.alert("❌ Gagal", "Pesan uji coba gagal: " + res.error, ui.ButtonSet.OK);
  }
}

// ==============================================================================
// ⏱️ 10. PENGATURAN TRIGGER OTOMATIS (TIME-DRIVEN)
// ==============================================================================

function setupAbsensiTriggers() {
  removeAbsensiTriggers();

  // Pengiriman otomatis harian:
  // 1. Pagi (08:00 WIB): Rekap Audit Resmi Kemarin (H-1 Full Lengkap dari batch Astro)
  // 2. Siang (15:30 WIB): Rekap Shift Pagi s/d Siang Hari Ini (P7, MD10, S13)
  // 3. Malam (23:45 WIB): Rekap Shift Malam Hari Ini (s/d M23)
  var scheduleConfigs = [
    { handler: "autoTriggerYesterdayReport", hour: 8, minute: 0 },
    { handler: "autoTriggerAbsensiReport", hour: 15, minute: 30 },
    { handler: "autoTriggerAbsensiReport", hour: 23, minute: 45 }
  ];

  scheduleConfigs.forEach(function (item) {
    ScriptApp.newTrigger(item.handler)
      .timeBased()
      .atHour(item.hour)
      .nearMinute(item.minute)
      .everyDays(1)
      .inTimezone(ABSENSI_CONFIG.TIMEZONE)
      .create();
  });

  var ui = SpreadsheetApp.getUi();
  ui.alert(
    "⏱️ Trigger Berhasil Dipasang",
    "Jadwal otomatis pengiriman laporan ke WhatsApp:\n\n" +
    "• 08:00 WIB ➔ Rekap Audit Resmi Kemarin (H-1 Full Lengkap)\n" +
    "• 15:30 WIB ➔ Rekap Shift Pagi s/d Siang Hari Ini (P7, MD10, S13)\n" +
    "• 23:45 WIB ➔ Rekap Shift Malam Hari Ini (s/d M23)",
    ui.ButtonSet.OK
  );
}

function autoTriggerYesterdayReport() {
  syncAndSendYesterdayReport(true);
}

function autoTriggerAbsensiReport() {
  syncAndSendWhatsAppReport(true);
}

function removeAbsensiTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) {
    var fn = trigger.getHandlerFunction();
    if (fn === "autoTriggerAbsensiReport" || fn === "autoTriggerYesterdayReport" || fn === "syncAndSendWhatsAppReport" || fn === "syncAndSendYesterdayReport") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
