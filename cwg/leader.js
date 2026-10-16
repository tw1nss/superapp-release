/**
 * ==========================================================================
 * CWG LEADER COMMAND CENTER — JAVASCRIPT LOGIC
 * System: SuperApp MTG / Hub CWG (Cawang)
 * Menus: ALL, LDP, LBH, BADSTOCK
 * ==========================================================================
 */

(function () {
  'use strict';

  // ─── CONFIGURATION & SECURITY ───
  const REQUIRED_LEADER_PIN = '030507';
  const AUTH_SESSION_KEY = 'CWG_LEADER_AUTH_SESSION_V1';
  const LOCAL_STORAGE_DATA_KEY = 'CWG_LEADER_ANOMALY_DATA_V1';
  const SPREADSHEET_ID = '1ufcERKZtENOjtRjU8m6Ov5yfkR_wmPnELO4vlrTbHdY';
  const SPREADSHEET_SHEET_NAME = 'BAD & LOST';
  const DCC_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbygTPu8soPeO8j0l88UMUcBQrSi7WFCjSe-G2PJV5vg_JLsEim1q2mHuaV9nT6GSQj3sw/exec';

  // ─── INITIAL SEED DATA (Hub CWG Cawang) ───
  const INITIAL_CWG_DATA = [
    // ── LDP (Lost Damage Problem) ──
    {
      id: 'LDP-CWG-101',
      sku: '147060',
      productName: 'Roti Gandum Kupas 10 Slices A Basics',
      category: 'LDP',
      qty: 2,
      rack: 'L2-AMD-G6-T5-2',
      zone: 'Ambient',
      reason: 'Hilang saat picking shift siang',
      pic: 'Dian CWG',
      shift: 'Shift Siang',
      status: 'Investigasi',
      date: '2026-10-14',
      time: '11:20',
      lossValue: 36000,
      notes: 'Leader verifikasi CCTV koridor G6'
    },
    {
      id: 'LDP-CWG-102',
      sku: '10000000004854',
      productName: 'Mangga Kweni Astro Farm',
      category: 'LDP',
      qty: 4,
      rack: 'L1-AMF-RF5-T4-3',
      zone: 'Fresh',
      reason: 'Selisih fisik vs koli inbound vendor',
      pic: 'Rizky CWG',
      shift: 'Shift Pagi',
      status: 'Pending',
      date: '2026-10-14',
      time: '08:45',
      lossValue: 52000,
      notes: 'Menunggu konfirmasi driver inbound'
    },
    {
      id: 'LDP-CWG-103',
      sku: '8886020223054',
      productName: 'Bagus Micromate Twist Mop Set 1 pcs',
      category: 'LDP',
      qty: 1,
      rack: 'L3-AMD-RAK-SAPU-6',
      zone: 'Tata Rumah',
      reason: 'Rusak handle patah saat loading troli',
      pic: 'Asep CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-13',
      time: '14:10',
      lossValue: 85000,
      notes: 'Sudah diajukan klaim vendor'
    },
    {
      id: 'LDP-CWG-104',
      sku: '8993993981185',
      productName: 'SIH Telur Ayam Negeri Nabati',
      category: 'LDP',
      qty: 3,
      rack: 'L1-AMD-A3-T3-2',
      zone: 'Ambient',
      reason: 'Pecah di tray rak penyimpanan',
      pic: 'Budi Leader',
      shift: 'Shift Siang',
      status: 'Selesai',
      date: '2026-10-14',
      time: '13:00',
      lossValue: 78000,
      notes: 'Telah dihapus dari stock available'
    },
    {
      id: 'LDP-CWG-105',
      sku: '472728',
      productName: 'Paket Masak Sapo Tahu Astro Goods',
      category: 'LDP',
      qty: 2,
      rack: 'L1-CHL-DC23-T3-9',
      zone: 'Chiller',
      reason: 'Kemasan sobek & cairan tumpah di rak chiller',
      pic: 'Fajar CWG',
      shift: 'Shift Pagi',
      status: 'Pending',
      date: '2026-10-14',
      time: '09:15',
      lossValue: 46000,
      notes: 'Butuh approval write-off supervisor'
    },
    {
      id: 'LDP-CWG-106',
      sku: '1168888204831',
      productName: 'BOLDe Super Mop Tornado Pel Lantai',
      category: 'LDP',
      qty: 1,
      rack: 'L3-AMD-RAK-SAPU-5',
      zone: 'Tata Rumah',
      reason: 'Kardus robek & komponen ember retak',
      pic: 'Dian CWG',
      shift: 'Shift Siang',
      status: 'Investigasi',
      date: '2026-10-12',
      time: '15:30',
      lossValue: 195000,
      notes: 'Investigasi tim penerimaan inbound'
    },
    {
      id: 'LDP-CWG-107',
      sku: '745125242361',
      productName: 'Bluder Cokro Bluder Keju Single',
      category: 'LDP',
      qty: 5,
      rack: 'L2-AMD-G4-T5-4',
      zone: 'Ambient',
      reason: 'Tertinggal di tote box audit',
      pic: 'Rizky CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-13',
      time: '10:05',
      lossValue: 65000,
      notes: 'Barang sudah direlokasi ke rak asal'
    },
    {
      id: 'LDP-CWG-108',
      sku: '990689',
      productName: 'Sapu Nilon Kipas A Basics 1 pcs',
      category: 'LDP',
      qty: 2,
      rack: 'L3-AMD-RAK-SAPU-4',
      zone: 'Tata Rumah',
      reason: 'Fisik tidak ditemukan di rak SAPU-4',
      pic: 'Asep CWG',
      shift: 'Shift Pagi',
      status: 'Investigasi',
      date: '2026-10-14',
      time: '07:50',
      lossValue: 48000,
      notes: 'Pencarian di area staging outbound'
    },

    // ── LBH (Barang Lebih / Overstock / Surplus) ──
    {
      id: 'LBH-CWG-201',
      sku: '8992907952273',
      productName: 'Sari Roti Sobek Cokelat Blueberry',
      category: 'LBH',
      qty: 6,
      rack: 'L2-AMD-G5-T6-4',
      zone: 'Ambient',
      reason: 'Kelebihan kirim koli inbound DC',
      pic: 'Fajar CWG',
      shift: 'Shift Pagi',
      status: 'Pending',
      date: '2026-10-14',
      time: '08:10',
      lossValue: 0,
      notes: 'Verifikasi surat jalan supplier sari roti'
    },
    {
      id: 'LBH-CWG-202',
      sku: '10000000000133',
      productName: 'Kain Pel A Basics 1 pcs',
      category: 'LBH',
      qty: 3,
      rack: 'L3-AMD-RAK-SAPU-3',
      zone: 'Tata Rumah',
      reason: 'Fisik lebih 3 pcs vs data sistem DCC',
      pic: 'Dian CWG',
      shift: 'Shift Siang',
      status: 'Selesai',
      date: '2026-10-13',
      time: '16:40',
      lossValue: 0,
      notes: 'Sudah di-adjust masuk ke stock available'
    },
    {
      id: 'LBH-CWG-203',
      sku: '8994046010104',
      productName: 'My Roti Tawar Gandum High Fiber 10 Slice',
      category: 'LBH',
      qty: 4,
      rack: 'L2-AMD-G6-T6-3',
      zone: 'Ambient',
      reason: 'Retur customer batal belum potong sistem',
      pic: 'Budi Leader',
      shift: 'Shift Siang',
      status: 'Investigasi',
      date: '2026-10-14',
      time: '12:30',
      lossValue: 0,
      notes: 'Cek nomor resi cancel order'
    },
    {
      id: 'LBH-CWG-204',
      sku: '8992806000334',
      productName: '3M Scotch-Brite Sapu Nylon Kipas ID-471',
      category: 'LBH',
      qty: 2,
      rack: 'L3-AMD-RAK-SAPU-1',
      zone: 'Tata Rumah',
      reason: 'Salah scan barcode varian kembar',
      pic: 'Rizky CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-13',
      time: '11:15',
      lossValue: 0,
      notes: 'Koreksi barcode di sistem selesai'
    },
    {
      id: 'LBH-CWG-205',
      sku: '10000000000240',
      productName: 'Roti Tawar: Shokupan Inspired A Basics 6pcs',
      category: 'LBH',
      qty: 5,
      rack: 'L2-AMD-G6-T6-2',
      zone: 'Ambient',
      reason: 'Salah letak di rak tetangga G6-T6-1',
      pic: 'Fajar CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-14',
      time: '09:40',
      lossValue: 0,
      notes: 'Sudah dipindahkan ke lokasi rak benar'
    },
    {
      id: 'LBH-CWG-206',
      sku: '418381',
      productName: 'Raw Pet Gourmet Minis Salmon & Spinach',
      category: 'LBH',
      qty: 4,
      rack: 'L1-FRZ-CF13-T2-K3-7',
      zone: 'Frozen',
      reason: 'Selisih koli inbound +4 pack chiller',
      pic: 'Asep CWG',
      shift: 'Shift Siang',
      status: 'Investigasi',
      date: '2026-10-12',
      time: '17:00',
      lossValue: 0,
      notes: 'Pengecekan PO Supplier pet food'
    },

    // ── BADSTOCK (Bad Stock / Rusak / Expired) ──
    {
      id: 'BAD-CWG-301',
      sku: '149794',
      productName: 'Bayam Hijau Konvensional Astro Farm',
      category: 'BADSTOCK',
      qty: 8,
      rack: 'L1-CHL-DC4-T3-3',
      zone: 'Chiller',
      reason: 'Layu & busuk daun (Expired Date)',
      pic: 'Dian CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-14',
      time: '08:00',
      lossValue: 64000,
      notes: 'Telah dibuang sesuai SOP pemusnahan fresh'
    },
    {
      id: 'BAD-CWG-302',
      sku: '10000000004914',
      productName: 'Kacang Panjang Organik',
      category: 'BADSTOCK',
      qty: 6,
      rack: 'L1-CHL-DC7-T4-7',
      zone: 'Chiller',
      reason: 'Berlendir & aroma asam (Expired Date)',
      pic: 'Rizky CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-14',
      time: '08:20',
      lossValue: 72000,
      notes: 'BA Pemusnahan ditandatangani Leader'
    },
    {
      id: 'BAD-CWG-303',
      sku: '737712',
      productName: 'Fumak Astro Farm Fresh Vegetables',
      category: 'BADSTOCK',
      qty: 5,
      rack: 'L1-CHL-DC6-T3-3',
      zone: 'Chiller',
      reason: 'Daun menguning sweeper EDS temuan',
      pic: 'Fajar CWG',
      shift: 'Shift Siang',
      status: 'Selesai',
      date: '2026-10-13',
      time: '14:45',
      lossValue: 55000,
      notes: 'Audit EDS shift siang'
    },
    {
      id: 'BAD-CWG-304',
      sku: '532573',
      productName: 'Daun Pepaya Astro Farm Fresh',
      category: 'BADSTOCK',
      qty: 4,
      rack: 'L1-CHL-DC6-T4-4',
      zone: 'Chiller',
      reason: 'Melewati batas MSLTC tanggal 29 Sep',
      pic: 'Dian CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-14',
      time: '09:00',
      lossValue: 40000,
      notes: 'Pemusnahan tercatat di EDS log'
    },
    {
      id: 'BAD-CWG-305',
      sku: '8992907001957',
      productName: 'Sari Roti Tawar Gandum Kupas',
      category: 'BADSTOCK',
      qty: 7,
      rack: 'L2-AMD-G4-T2-4',
      zone: 'Ambient',
      reason: 'Bercak jamur hijau sebelum tanggal ED',
      pic: 'Budi Leader',
      shift: 'Shift Siang',
      status: 'Investigasi',
      date: '2026-10-14',
      time: '13:15',
      lossValue: 126000,
      notes: 'Lapor QA untuk klaim kualitas batch roti'
    },
    {
      id: 'BAD-CWG-306',
      sku: '0764460907971',
      productName: 'IKOCA Sapu Lidi Kasur Premium 1 pcs',
      category: 'BADSTOCK',
      qty: 2,
      rack: 'L3-AMD-RAK-SAPU-2',
      zone: 'Tata Rumah',
      reason: 'Gagang rotan patah & anyaman lepas',
      pic: 'Asep CWG',
      shift: 'Shift Pagi',
      status: 'Selesai',
      date: '2026-10-12',
      time: '10:30',
      lossValue: 38000,
      notes: 'Retur supplier disetujui'
    },
    {
      id: 'BAD-CWG-307',
      sku: '8886020223276',
      productName: 'Bagus Type 372 Sikat Sapu Lantai 1 pcs',
      category: 'BADSTOCK',
      qty: 3,
      rack: 'L3-AMD-RAK-SAPU-7',
      zone: 'Tata Rumah',
      reason: 'Bulu sikat rontok cacat produksi pabrik',
      pic: 'Fajar CWG',
      shift: 'Shift Siang',
      status: 'Pending',
      date: '2026-10-14',
      time: '14:20',
      lossValue: 69000,
      notes: 'Menunggu penjemputan retur supplier'
    }
  ];

  // ─── STATE MANAGEMENT ───
  let allAnomalies = [];
  let filteredAnomalies = [];
  let activeSidebarMenu = 'ALL'; // ALL, LDP, LBH, BADSTOCK
  let currentSlicers = {
    category: 'ALL',
    status: 'ALL',
    zone: 'ALL',
    shift: 'ALL',
    pic: 'ALL', // ALL, EXCLUDE_WIMS, ONLY_WIMS, or exact PIC name
    picExclude: false, // if true, excludes currentSlicers.pic
    dateRange: 'ALL'
  };
  let currentSearchQuery = '';
  let activeBottomTab = 'overview';
  let pinEnteredDigits = '';

  // ─── DOM ELEMENTS REFERENCE ───
  const dom = {
    // PIN Lock
    pinLockOverlay: document.getElementById('pinLockOverlay'),
    pinInputField: document.getElementById('pinInputField'),
    pinEyeToggleBtn: document.getElementById('pinEyeToggleBtn'),
    pinDots: document.querySelectorAll('.pin-dot'),
    pinErrorMsg: document.getElementById('pinErrorMsg'),
    keypadBtns: document.querySelectorAll('.keypad-btn'),
    pinSubmitBtn: document.getElementById('pinSubmitBtn'),

    // Sidebar
    sidebarNavBtns: document.querySelectorAll('.sidebar-nav-btn'),
    sidebarLockBtn: document.getElementById('sidebarLockBtn'),
    badgeCountAll: document.getElementById('badgeCountAll'),
    badgeCountLdp: document.getElementById('badgeCountLdp'),
    badgeCountLbh: document.getElementById('badgeCountLbh'),
    badgeCountBad: document.getElementById('badgeCountBad'),
    miniLossValue: document.getElementById('miniLossValue'),

    // Top Header
    headerTitle: document.getElementById('headerTitle'),
    headerSubtitle: document.getElementById('headerSubtitle'),
    btnSyncCloud: document.getElementById('btnSyncCloud'),
    btnInputAnomali: document.getElementById('btnInputAnomali'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnPrintReport: document.getElementById('btnPrintReport'),
    btnTopLock: document.getElementById('btnTopLock'),

    // KPI Cards
    kpiTotalCount: document.getElementById('kpiTotalCount'),
    kpiTotalQty: document.getElementById('kpiTotalQty'),
    kpiLdpCount: document.getElementById('kpiLdpCount'),
    kpiLdpQty: document.getElementById('kpiLdpQty'),
    kpiLbhCount: document.getElementById('kpiLbhCount'),
    kpiLbhQty: document.getElementById('kpiLbhQty'),
    kpiBadCount: document.getElementById('kpiBadCount'),
    kpiLossValue: document.getElementById('kpiLossValue'),
    kpiLossLabel: document.getElementById('kpiLossLabel'),
    kpiLossSub: document.getElementById('kpiLossSub'),
    kpiResolvedRate: document.getElementById('kpiResolvedRate'),

    // Charts Containers
    chartDonutContainer: document.getElementById('chartDonutContainer'),
    chartRackBarContainer: document.getElementById('chartRackBarContainer'),
    chartStatusContainer: document.getElementById('chartStatusContainer'),
    chartTop5Container: document.getElementById('chartTop5Container'),
    chartBottom5Container: document.getElementById('chartBottom5Container'),

    // Table
    tableTitle: document.getElementById('tableTitle'),
    tableCountPill: document.getElementById('tableCountPill'),
    tableSearchInput: document.getElementById('tableSearchInput'),
    tableClearSearchBtn: document.getElementById('tableClearSearchBtn'),
    tableBody: document.getElementById('tableBody'),
    tableEmptyState: document.getElementById('tableEmptyState'),

    // Slicers
    slicerChips: document.querySelectorAll('.slicer-chip-btn'),
    slicerPicSelect: document.getElementById('slicerPicSelect'),
    slicerPicExcludeCheck: document.getElementById('slicerPicExcludeCheck'),
    btnResetSlicers: document.getElementById('btnResetSlicers'),

    // Bottom Tabs
    bottomTabs: document.querySelectorAll('.bottom-tab-item'),

    // Modals
    modalNewAnomaly: document.getElementById('modalNewAnomaly'),
    modalDetailAnomaly: document.getElementById('modalDetailAnomaly'),
    newAnomalyForm: document.getElementById('newAnomalyForm'),
    modalCloseBtns: document.querySelectorAll('.modal-close-btn')
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PIN SECURITY ENGINE
  // ══════════════════════════════════════════════════════════════════════════
  function initPinLockEngine() {
    const isAuthed = sessionStorage.getItem(AUTH_SESSION_KEY) === REQUIRED_LEADER_PIN;
    if (isAuthed) {
      dom.pinLockOverlay.classList.add('unlocked');
    } else {
      dom.pinLockOverlay.classList.remove('unlocked');
      setTimeout(() => dom.pinInputField.focus(), 250);
    }

    // Keypad clicks
    dom.keypadBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'clear') {
          clearPinDigits();
        } else if (key === 'backspace') {
          pinEnteredDigits = pinEnteredDigits.slice(0, -1);
          updatePinVisuals();
        } else if (pinEnteredDigits.length < 6) {
          pinEnteredDigits += key;
          updatePinVisuals();
          if (pinEnteredDigits.length === 6) {
            validateLeaderPin();
          }
        }
      });
    });

    // Direct input field
    dom.pinInputField.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '').slice(0, 6);
      pinEnteredDigits = val;
      updatePinVisuals();
      if (pinEnteredDigits.length === 6) {
        validateLeaderPin();
      }
    });

    dom.pinInputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        validateLeaderPin();
      }
    });

    // Eye button toggle
    dom.pinEyeToggleBtn.addEventListener('click', () => {
      const isPassword = dom.pinInputField.type === 'password';
      dom.pinInputField.type = isPassword ? 'text' : 'password';
      dom.pinEyeToggleBtn.textContent = isPassword ? '🔒' : '👁️';
    });

    // Submit button
    dom.pinSubmitBtn.addEventListener('click', validateLeaderPin);

    // Lock buttons
    if (dom.sidebarLockBtn) dom.sidebarLockBtn.addEventListener('click', lockDashboard);
    if (dom.btnTopLock) dom.btnTopLock.addEventListener('click', lockDashboard);
  }

  function updatePinVisuals(clearError = true) {
    dom.pinInputField.value = pinEnteredDigits;
    dom.pinDots.forEach((dot, idx) => {
      dot.classList.toggle('filled', idx < pinEnteredDigits.length);
    });
    if (clearError) {
      dom.pinErrorMsg.textContent = '';
    }
    dom.pinInputField.classList.remove('shake');
  }

  function clearPinDigits(keepError = false) {
    pinEnteredDigits = '';
    updatePinVisuals(!keepError);
  }

  function validateLeaderPin() {
    if (pinEnteredDigits === REQUIRED_LEADER_PIN) {
      sessionStorage.setItem(AUTH_SESSION_KEY, REQUIRED_LEADER_PIN);
      dom.pinLockOverlay.classList.add('unlocked');
      clearPinDigits();
      renderAll();
    } else {
      dom.pinInputField.classList.add('shake');
      dom.pinErrorMsg.textContent = '❌ PIN Akses Salah! Silakan coba lagi.';
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      setTimeout(() => {
        clearPinDigits(true);
        dom.pinInputField.focus();
      }, 700);
    }
  }

  function lockDashboard() {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    clearPinDigits();
    dom.pinLockOverlay.classList.remove('unlocked');
    setTimeout(() => dom.pinInputField.focus(), 250);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. DATA INITIALIZATION & LOCAL STORAGE
  // ══════════════════════════════════════════════════════════════════════════
  function loadData() {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_DATA_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          allAnomalies = parsed;
          return;
        }
      }
    } catch (e) {
      console.warn('Gagal memuat local storage:', e);
    }
    allAnomalies = [...INITIAL_CWG_DATA];
    saveDataToLocalStorage();
  }

  function saveDataToLocalStorage() {
    try {
      localStorage.setItem(LOCAL_STORAGE_DATA_KEY, JSON.stringify(allAnomalies));
    } catch (e) {
      console.error('Gagal menyimpan ke local storage:', e);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function populatePicDropdown() {
    if (!dom.slicerPicSelect) return;
    const picCounts = {};
    allAnomalies.forEach(item => {
      const p = (item.pic || '').trim() || '(Tanpa PIC)';
      picCounts[p] = (picCounts[p] || 0) + 1;
    });

    const sortedPics = Object.keys(picCounts).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    let optionsHtml = '<option value="ALL">-- Semua Petugas --</option>';
    sortedPics.forEach(pic => {
      const count = picCounts[pic];
      optionsHtml += `<option value="${escapeHtml(pic)}">${escapeHtml(pic)} (${count} items)</option>`;
    });

    dom.slicerPicSelect.innerHTML = optionsHtml;
    if (currentSlicers.pic && currentSlicers.pic !== 'EXCLUDE_WIMS' && currentSlicers.pic !== 'ONLY_WIMS') {
      dom.slicerPicSelect.value = currentSlicers.pic;
    } else {
      dom.slicerPicSelect.value = 'ALL';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. FILTERING & SEARCH PIPELINE
  // ══════════════════════════════════════════════════════════════════════════
  function applyFilters() {
    filteredAnomalies = allAnomalies.filter(item => {
      // 1. Sidebar Category filter (ALL, LDP, LBH, BADSTOCK)
      if (activeSidebarMenu !== 'ALL' && item.category !== activeSidebarMenu) {
        return false;
      }

      // 2. Right Slicer Category (if not ALL)
      if (currentSlicers.category !== 'ALL' && item.category !== currentSlicers.category) {
        return false;
      }

      // 3. Slicer Status
      if (currentSlicers.status !== 'ALL' && item.status.toUpperCase() !== currentSlicers.status.toUpperCase()) {
        return false;
      }

      // 4. Slicer Zone
      if (currentSlicers.zone !== 'ALL' && item.zone.toUpperCase() !== currentSlicers.zone.toUpperCase()) {
        return false;
      }

      // 5. Slicer Shift
      if (currentSlicers.shift !== 'ALL' && item.shift.toUpperCase() !== currentSlicers.shift.toUpperCase()) {
        return false;
      }

      // 6. Slicer Petugas / PIC
      const itemPic = (item.pic || '').trim();
      const isWims = itemPic.toLowerCase().includes('admin wims');

      if (currentSlicers.pic === 'EXCLUDE_WIMS') {
        if (isWims) return false;
      } else if (currentSlicers.pic === 'ONLY_WIMS') {
        if (!isWims) return false;
      } else if (currentSlicers.pic !== 'ALL') {
        const isMatch = itemPic.toLowerCase() === currentSlicers.pic.toLowerCase();
        if (currentSlicers.picExclude) {
          if (isMatch) return false;
        } else {
          if (!isMatch) return false;
        }
      }

      // 7. Search Query
      if (currentSearchQuery) {
        const q = currentSearchQuery.toLowerCase();
        const matchSku = (item.sku || '').toLowerCase().includes(q);
        const matchName = (item.productName || '').toLowerCase().includes(q);
        const matchRack = (item.rack || '').toLowerCase().includes(q);
        const matchPic = (item.pic || '').toLowerCase().includes(q);
        const matchReason = (item.reason || '').toLowerCase().includes(q);
        if (!matchSku && !matchName && !matchRack && !matchPic && !matchReason) {
          return false;
        }
      }

      return true;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. KPI TELEMETRY METRICS
  // ══════════════════════════════════════════════════════════════════════════
  function renderKpiMetrics() {
    const data = filteredAnomalies;
    const totalCount = data.length;
    const ldpItems = data.filter(i => i.category === 'LDP');
    const lbhItems = data.filter(i => i.category === 'LBH');
    const badItems = data.filter(i => i.category === 'BADSTOCK');

    const totalQty = data.reduce((acc, cur) => acc + (Number(cur.qty) || 0), 0);
    const ldpQty = ldpItems.reduce((acc, cur) => acc + (Number(cur.qty) || 0), 0);
    const lbhQty = lbhItems.reduce((acc, cur) => acc + (Number(cur.qty) || 0), 0);
    const badQty = badItems.reduce((acc, cur) => acc + (Number(cur.qty) || 0), 0);

    // Loss calculations: Only LDP and BADSTOCK are losses. LBH is physical surplus.
    const ldpLossTotal = ldpItems.reduce((acc, cur) => acc + (Number(cur.lossValue) || 0), 0);
    const badLossTotal = badItems.reduce((acc, cur) => acc + (Number(cur.lossValue) || 0), 0);
    const totalLoss = data.reduce((acc, cur) => acc + (Number(cur.lossValue) || 0), 0);
    const totalSurplus = lbhItems.reduce((acc, cur) => acc + (Number(cur.surplusValue) || 0), 0);

    const resolvedCount = data.filter(i => i.status === 'Selesai').length;
    const resolvedRate = totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0;

    // Update KPI Card DOM (Top Row)
    if (dom.kpiTotalCount) dom.kpiTotalCount.textContent = totalCount;
    if (dom.kpiTotalQty) dom.kpiTotalQty.textContent = `${totalQty} pcs`;
    if (dom.kpiLdpCount) dom.kpiLdpCount.textContent = ldpItems.length;
    if (dom.kpiLdpQty) dom.kpiLdpQty.textContent = `${ldpQty} pcs`;
    if (dom.kpiLbhCount) dom.kpiLbhCount.textContent = lbhItems.length;
    if (dom.kpiLbhQty) dom.kpiLbhQty.textContent = `${lbhQty} pcs`;
    if (dom.kpiBadCount) dom.kpiBadCount.textContent = badItems.length;
    if (dom.kpiBadQty) dom.kpiBadQty.textContent = `${badQty} pcs`;
    if (dom.kpiResolvedRate) dom.kpiResolvedRate.textContent = `${resolvedRate}%`;

    // Dynamic Loss / Value Card
    if (activeSidebarMenu === 'LDP' || (ldpItems.length > 0 && badItems.length === 0 && lbhItems.length === 0)) {
      if (dom.kpiLossLabel) dom.kpiLossLabel.textContent = 'VALUE LDP (LOSS)';
      if (dom.kpiLossValue) dom.kpiLossValue.textContent = `Rp ${ldpLossTotal.toLocaleString('id-ID')}`;
      if (dom.kpiLossSub) {
        const frozenLoss = ldpItems.filter(i => i.zone === 'Frozen').reduce((s, i) => s + (i.lossValue || 0), 0);
        const freshLoss = ldpItems.filter(i => i.zone === 'Fresh').reduce((s, i) => s + (i.lossValue || 0), 0);
        dom.kpiLossSub.textContent = `Frozen: Rp ${(frozenLoss / 1e6).toFixed(2)}M | Fresh: Rp ${(freshLoss / 1e6).toFixed(2)}M`;
      }
    } else if (activeSidebarMenu === 'LBH') {
      if (dom.kpiLossLabel) dom.kpiLossLabel.textContent = 'NILAI SURPLUS (LBH)';
      if (dom.kpiLossValue) dom.kpiLossValue.textContent = `+Rp ${totalSurplus.toLocaleString('id-ID')}`;
      if (dom.kpiLossSub) dom.kpiLossSub.textContent = 'Surplus Fisik (Bukan Kerugian)';
    } else if (activeSidebarMenu === 'BADSTOCK') {
      if (dom.kpiLossLabel) dom.kpiLossLabel.textContent = 'VALUE BADSTOCK (LOSS)';
      if (dom.kpiLossValue) dom.kpiLossValue.textContent = `Rp ${badLossTotal.toLocaleString('id-ID')}`;
      if (dom.kpiLossSub) dom.kpiLossSub.textContent = 'Kerugian Barang Rusak & Kadaluarsa';
    } else {
      if (dom.kpiLossLabel) dom.kpiLossLabel.textContent = 'TOTAL LOSS (LDP & BAD)';
      if (dom.kpiLossValue) dom.kpiLossValue.textContent = `Rp ${totalLoss.toLocaleString('id-ID')}`;
      if (dom.kpiLossSub) {
        dom.kpiLossSub.textContent = `LDP: Rp ${(ldpLossTotal / 1e6).toFixed(2)}M | Bad: Rp ${(badLossTotal / 1e3).toFixed(0)}k`;
      }
    }

    // Sidebar navigation badges (Master warehouse count)
    if (dom.badgeCountAll) dom.badgeCountAll.textContent = allAnomalies.length;
    if (dom.badgeCountLdp) dom.badgeCountLdp.textContent = allAnomalies.filter(i => i.category === 'LDP').length;
    if (dom.badgeCountLbh) dom.badgeCountLbh.textContent = allAnomalies.filter(i => i.category === 'LBH').length;
    if (dom.badgeCountBad) dom.badgeCountBad.textContent = allAnomalies.filter(i => i.category === 'BADSTOCK').length;
    
    // Bottom left mini loss widget (Real loss from LDP + BADSTOCK only)
    if (dom.miniLossValue) dom.miniLossValue.textContent = `Rp ${(totalLoss / 1000).toFixed(0)}k`;

    // Subtitle indicator
    if (dom.headerSubtitle) {
      if (filteredAnomalies.length === allAnomalies.length) {
        dom.headerSubtitle.textContent = `Hub CWG Cawang • Live Spreadsheet (${allAnomalies.length} data)`;
      } else {
        dom.headerSubtitle.textContent = `Hub CWG Cawang • Menampilkan ${filteredAnomalies.length} dari ${allAnomalies.length} data terfilter`;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. CHARTS RENDERING (CUSTOM HIGH-PRECISION SVG)
  // Matches user screenshot: Donut, Horiz Bars, Status Col, Top 5 & Bottom 5
  // ══════════════════════════════════════════════════════════════════════════

  // ── Chart 1: Donut Chart (Minimalist & Monochrome Telemetry) ──
  function renderDonutChart() {
    if (!dom.chartDonutContainer) return;

    const ldpCount = filteredAnomalies.filter(i => i.category === 'LDP').length;
    const lbhCount = filteredAnomalies.filter(i => i.category === 'LBH').length;
    const badCount = filteredAnomalies.filter(i => i.category === 'BADSTOCK').length;
    const total = ldpCount + lbhCount + badCount;

    if (total === 0) {
      dom.chartDonutContainer.innerHTML = '<div style="color:#64748b;font-size:0.8rem;">Tidak ada data produk</div>';
      return;
    }

    const pLdp = (ldpCount / total) * 100;
    const pLbh = (lbhCount / total) * 100;
    const pBad = (badCount / total) * 100;

    const r = 48;
    const circumference = 2 * Math.PI * r;

    const arcLdp = (pLdp / 100) * circumference;
    const arcLbh = (pLbh / 100) * circumference;
    const arcBad = (pBad / 100) * circumference;

    const offsetLdp = 0;
    const offsetLbh = -arcLdp;
    const offsetBad = -(arcLdp + arcLbh);

    const svgHtml = `
      <div style="display:flex;align-items:center;justify-content:center;width:100%;gap:18px;">
        <svg width="140" height="140" viewBox="0 0 130 130" class="svg-chart">
          <circle cx="65" cy="65" r="${r}" fill="transparent" stroke="rgba(255,255,255,0.05)" stroke-width="15"/>
          
          <!-- LDP Arc (Solar Amber) -->
          <circle cx="65" cy="65" r="${r}" fill="transparent" stroke="#f59e0b" stroke-width="15"
            stroke-dasharray="${arcLdp} ${circumference}"
            stroke-dashoffset="${offsetLdp}"
            transform="rotate(-90 65 65)" />

          <!-- LBH Arc (Astro Sky) -->
          <circle cx="65" cy="65" r="${r}" fill="transparent" stroke="#38bdf8" stroke-width="15"
            stroke-dasharray="${arcLbh} ${circumference}"
            stroke-dashoffset="${offsetLbh}"
            transform="rotate(-90 65 65)" />

          <!-- BADSTOCK Arc (Crimson Alert) -->
          <circle cx="65" cy="65" r="${r}" fill="transparent" stroke="#f43f5e" stroke-width="15"
            stroke-dasharray="${arcBad} ${circumference}"
            stroke-dashoffset="${offsetBad}"
            transform="rotate(-90 65 65)" />

          <!-- Center Text -->
          <text x="65" y="62" text-anchor="middle" font-size="20" font-weight="700" fill="#f8fafc" font-family="JetBrains Mono">${total}</text>
          <text x="65" y="78" text-anchor="middle" font-size="8.5" fill="#64748b" font-family="Inter" font-weight="600" letter-spacing="0.08em">PRODUK</text>
        </svg>

        <div class="donut-legend">
          <div class="legend-row">
            <span style="display:flex;align-items:center;gap:7px;color:#94a3b8;">
              <span class="legend-indicator" style="background:#f59e0b;"></span> LDP
            </span>
            <span class="legend-val">${ldpCount} <span style="font-size:0.7rem;color:#64748b;font-weight:500;">(${Math.round(pLdp)}%)</span></span>
          </div>
          <div class="legend-row">
            <span style="display:flex;align-items:center;gap:7px;color:#94a3b8;">
              <span class="legend-indicator" style="background:#38bdf8;"></span> LBH
            </span>
            <span class="legend-val">${lbhCount} <span style="font-size:0.7rem;color:#64748b;font-weight:500;">(${Math.round(pLbh)}%)</span></span>
          </div>
          <div class="legend-row">
            <span style="display:flex;align-items:center;gap:7px;color:#94a3b8;">
              <span class="legend-indicator" style="background:#f43f5e;"></span> BADSTOCK
            </span>
            <span class="legend-val">${badCount} <span style="font-size:0.7rem;color:#64748b;font-weight:500;">(${Math.round(pBad)}%)</span></span>
          </div>
        </div>
      </div>
    `;

    dom.chartDonutContainer.innerHTML = svgHtml;
  }

  // ── Chart 2: Horizontal Bar Chart (Monochrome Slate Distribution) ──
  function renderRackBarChart() {
    if (!dom.chartRackBarContainer) return;

    // Aggregate by Zone
    const zoneCounts = {};
    filteredAnomalies.forEach(i => {
      const z = i.zone || 'Lainnya';
      zoneCounts[z] = (zoneCounts[z] || 0) + (Number(i.qty) || 1);
    });

    const entries = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      dom.chartRackBarContainer.innerHTML = '<div style="color:#64748b;font-size:0.8rem;">Data zona kosong</div>';
      return;
    }

    const maxVal = Math.max(...entries.map(e => e[1])) || 1;

    let barsHtml = '<div style="display:flex;flex-direction:column;gap:10px;width:100%;">';
    entries.slice(0, 5).forEach(([zone, qty]) => {
      const pct = Math.round((qty / maxVal) * 100);
      barsHtml += `
        <div style="display:flex;align-items:center;gap:12px;font-size:0.75rem;">
          <span style="width:75px;color:#94a3b8;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${zone}</span>
          <div style="flex:1;background:rgba(255,255,255,0.04);height:16px;border-radius:3px;overflow:hidden;position:relative;">
            <div style="width:${pct}%;height:100%;background:#334155;border-radius:3px;transition:width 0.25s ease;"></div>
          </div>
          <span style="width:36px;font-family:JetBrains Mono;font-weight:600;color:#f8fafc;text-align:right;">${qty}</span>
        </div>
      `;
    });
    barsHtml += '</div>';

    dom.chartRackBarContainer.innerHTML = barsHtml;
  }

  // ── Chart 3: Vertical Column Chart (Semantic Status Accents Only) ──
  function renderStatusChart() {
    if (!dom.chartStatusContainer) return;

    const counts = {
      'Pending': filteredAnomalies.filter(i => i.status === 'Pending').length,
      'Investigasi': filteredAnomalies.filter(i => i.status === 'Investigasi').length,
      'Selesai': filteredAnomalies.filter(i => i.status === 'Selesai').length
    };

    const maxVal = Math.max(...Object.values(counts)) || 1;

    let colsHtml = `
      <div style="display:flex;align-items:flex-end;justify-content:space-around;width:100%;height:160px;padding-top:16px;border-bottom:1px solid rgba(255,255,255,0.06);">
    `;

    Object.entries(counts).forEach(([status, count]) => {
      const heightPct = Math.max(12, Math.round((count / maxVal) * 110));
      let colColor = '#10b981'; // Selesai = Emerald
      if (status === 'Pending') colColor = '#f43f5e'; // Pending = Rose Alert
      if (status === 'Investigasi') colColor = '#f59e0b'; // Investigasi = Solar Amber

      colsHtml += `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:28%;">
          <span style="font-family:JetBrains Mono;font-size:0.75rem;font-weight:700;color:#f8fafc;">${count}</span>
          <div style="width:100%;max-width:38px;height:${heightPct}px;background:${colColor};border-radius:4px 4px 0 0;transition:height 0.25s ease;"></div>
          <span style="font-size:0.72rem;color:#94a3b8;font-weight:600;margin-top:4px;">${status}</span>
        </div>
      `;
    });

    colsHtml += '</div>';
    dom.chartStatusContainer.innerHTML = colsHtml;
  }

  // ── Chart 4: Top 5 SKU Bermasalah (Alert Accent for Problems) ──
  function renderTop5Chart() {
    if (!dom.chartTop5Container) return;

    const sorted = [...filteredAnomalies].sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0)).slice(0, 5);
    if (sorted.length === 0) {
      dom.chartTop5Container.innerHTML = '<div style="color:#64748b;font-size:0.8rem;">Data Top 5 kosong</div>';
      return;
    }

    const maxQty = Math.max(...sorted.map(s => Number(s.qty) || 0)) || 1;

    let chartHtml = `
      <div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;height:150px;padding-top:16px;border-bottom:1px solid rgba(255,255,255,0.06);">
    `;

    sorted.forEach((item) => {
      const hPct = Math.max(14, Math.round((item.qty / maxQty) * 100));
      const shortName = item.productName.length > 12 ? item.productName.slice(0, 10) + '..' : item.productName;

      chartHtml += `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;max-width:65px;">
          <span style="font-family:JetBrains Mono;font-size:0.74rem;font-weight:700;color:#fbbf24;">${item.qty} pcs</span>
          <div style="width:70%;height:${hPct}px;background:#d97706;border-radius:4px 4px 0 0;"></div>
          <span style="font-size:0.68rem;color:#94a3b8;text-align:center;line-height:1.2;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;" title="${item.productName}">
            ${shortName}
          </span>
        </div>
      `;
    });

    chartHtml += '</div>';
    dom.chartTop5Container.innerHTML = chartHtml;
  }

  // ── Chart 5: Bottom 5 / Lowest Discrepancy (Calm Neutral Slate) ──
  function renderBottom5Chart() {
    if (!dom.chartBottom5Container) return;

    const sorted = [...filteredAnomalies].sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0)).slice(0, 5);
    if (sorted.length === 0) {
      dom.chartBottom5Container.innerHTML = '<div style="color:#64748b;font-size:0.8rem;">Data Bottom 5 kosong</div>';
      return;
    }

    const maxQty = Math.max(...sorted.map(s => Number(s.qty) || 0)) || 1;

    let chartHtml = `
      <div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;height:150px;padding-top:16px;border-bottom:1px solid rgba(255,255,255,0.06);">
    `;

    sorted.forEach((item) => {
      const hPct = Math.max(14, Math.round((item.qty / maxQty) * 100));
      const shortName = item.productName.length > 12 ? item.productName.slice(0, 10) + '..' : item.productName;

      chartHtml += `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;max-width:65px;">
          <span style="font-family:JetBrains Mono;font-size:0.74rem;font-weight:600;color:#94a3b8;">${item.qty} pcs</span>
          <div style="width:70%;height:${hPct}px;background:#334155;border-radius:4px 4px 0 0;"></div>
          <span style="font-size:0.68rem;color:#64748b;text-align:center;line-height:1.2;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;" title="${item.productName}">
            ${shortName}
          </span>
        </div>
      `;
    });

    chartHtml += '</div>';
    dom.chartBottom5Container.innerHTML = chartHtml;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. TABLE RENDERING & ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  function renderTable() {
    if (!dom.tableBody) return;

    if (dom.tableCountPill) {
      dom.tableCountPill.textContent = `${filteredAnomalies.length} items`;
    }

    if (dom.tableTitle) {
      const titles = {
        'ALL': 'Semua Produk (LDP, LBH & BADSTOCK)',
        'LDP': 'Daftar Produk LDP (Lost & Damage)',
        'LBH': 'Daftar Produk LBH (Lebih & Surplus)',
        'BADSTOCK': 'Daftar Produk BADSTOCK (Rusak & Expired)'
      };
      dom.tableTitle.textContent = titles[activeSidebarMenu] || 'Daftar Temuan Produk CWG';
    }

    if (filteredAnomalies.length === 0) {
      dom.tableBody.innerHTML = '';
      if (dom.tableEmptyState) dom.tableEmptyState.style.display = 'block';
      return;
    }

    if (dom.tableEmptyState) dom.tableEmptyState.style.display = 'none';

    let html = '';
    filteredAnomalies.forEach((item, index) => {
      let catClass = 'ldp';
      if (item.category === 'LBH') catClass = 'lbh';
      if (item.category === 'BADSTOCK') catClass = 'badstock';

      let statusClass = 'pending';
      if (item.status === 'Investigasi') statusClass = 'investigasi';
      if (item.status === 'Selesai') statusClass = 'selesai';

      html += `
        <tr>
          <td class="td-no">${index + 1}</td>
          <td class="td-sku">${item.sku}</td>
          <td class="td-product-name" title="${item.productName}">
            <div class="product-title">${item.productName}</div>
            <div class="product-subtext">${item.reason}</div>
          </td>
          <td>
            <span class="cat-badge ${catClass}">
              ${item.category}
            </span>
          </td>
          <td class="td-qty">${item.qty}</td>
          <td>
            <span class="status-pill ${statusClass}">
              <span class="status-dot-mini"></span>
              <span>${item.status}</span>
            </span>
          </td>
          <td class="td-pic" title="Klik untuk filter petugas ini" style="cursor: pointer; text-decoration: underline dotted;" onclick="window.cwgLeaderApp.filterByPic('${escapeHtml(item.pic)}')">${item.pic}</td>
          <td class="td-datetime">${item.date} ${item.time}</td>
          <td style="text-align: right;">
            <button class="btn-row-action" onclick="window.cwgLeaderApp.openDetailModal('${item.id}')">
              Detail ▾
            </button>
          </td>
        </tr>
      `;
    });

    dom.tableBody.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. EVENT LISTENERS (SIDEBAR, SLICERS, TABS, SEARCH)
  // ══════════════════════════════════════════════════════════════════════════
  function initEventListeners() {
    // ── Sidebar Menu Navigation (ALL, LDP, LBH, BADSTOCK) ──
    dom.sidebarNavBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetMenu = btn.dataset.menu; // ALL, LDP, LBH, BADSTOCK
        activeSidebarMenu = targetMenu;

        dom.sidebarNavBtns.forEach(b => b.classList.toggle('active', b === btn));

        // Sync right slicer category button
        currentSlicers.category = targetMenu;
        dom.slicerChips.forEach(chip => {
          if (chip.dataset.slicerGroup === 'category') {
            chip.classList.toggle('active', chip.dataset.slicerVal === targetMenu);
          }
        });

        // Sync header
        updateHeaderTitles();

        renderAll();
      });
    });

    // ── Right Slicer Chips Click ──
    dom.slicerChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const group = chip.dataset.slicerGroup; // category, status, zone, shift, pic, dateRange
        const val = chip.dataset.slicerVal;

        // Toggle active within group
        dom.slicerChips.forEach(c => {
          if (c.dataset.slicerGroup === group) {
            c.classList.toggle('active', c === chip);
          }
        });

        currentSlicers[group] = val;

        // If category slicer clicked, sync sidebar
        if (group === 'category') {
          activeSidebarMenu = val;
          dom.sidebarNavBtns.forEach(b => {
            b.classList.toggle('active', b.dataset.menu === val);
          });
          updateHeaderTitles();
        }

        // If pic preset clicked, sync dropdown and checkbox
        if (group === 'pic') {
          if (dom.slicerPicSelect) dom.slicerPicSelect.value = 'ALL';
          if (dom.slicerPicExcludeCheck) dom.slicerPicExcludeCheck.checked = false;
          currentSlicers.picExclude = false;
        }

        renderAll();
      });
    });

    // ── Right Slicer PIC Dropdown & Exclude Checkbox ──
    if (dom.slicerPicSelect) {
      dom.slicerPicSelect.addEventListener('change', () => {
        const val = dom.slicerPicSelect.value;
        currentSlicers.pic = val;

        // Sync chip buttons
        dom.slicerChips.forEach(c => {
          if (c.dataset.slicerGroup === 'pic') {
            c.classList.toggle('active', val === 'ALL' && c.dataset.slicerVal === 'ALL');
          }
        });

        renderAll();
      });
    }

    if (dom.slicerPicExcludeCheck) {
      dom.slicerPicExcludeCheck.addEventListener('change', () => {
        currentSlicers.picExclude = dom.slicerPicExcludeCheck.checked;
        renderAll();
      });
    }

    // Reset Slicers button
    if (dom.btnResetSlicers) {
      dom.btnResetSlicers.addEventListener('click', () => {
        currentSlicers = {
          category: 'ALL',
          status: 'ALL',
          zone: 'ALL',
          shift: 'ALL',
          pic: 'ALL',
          picExclude: false,
          dateRange: 'ALL'
        };
        activeSidebarMenu = 'ALL';
        dom.sidebarNavBtns.forEach(b => b.classList.toggle('active', b.dataset.menu === 'ALL'));
        dom.slicerChips.forEach(chip => {
          chip.classList.toggle('active', chip.dataset.slicerVal === 'ALL');
        });
        if (dom.slicerPicSelect) dom.slicerPicSelect.value = 'ALL';
        if (dom.slicerPicExcludeCheck) dom.slicerPicExcludeCheck.checked = false;
        currentSearchQuery = '';
        if (dom.tableSearchInput) dom.tableSearchInput.value = '';
        updateHeaderTitles();
        renderAll();
      });
    }

    // ── Live Table Search ──
    if (dom.tableSearchInput) {
      dom.tableSearchInput.addEventListener('input', (e) => {
        currentSearchQuery = e.target.value.trim();
        if (dom.tableClearSearchBtn) {
          dom.tableClearSearchBtn.style.display = currentSearchQuery ? 'block' : 'none';
        }
        renderAll();
      });
    }

    if (dom.tableClearSearchBtn) {
      dom.tableClearSearchBtn.addEventListener('click', () => {
        dom.tableSearchInput.value = '';
        currentSearchQuery = '';
        dom.tableClearSearchBtn.style.display = 'none';
        renderAll();
      });
    }

    // ── Bottom Tabs ──
    dom.bottomTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        dom.bottomTabs.forEach(t => t.classList.toggle('active', t === tab));
        const tabTarget = tab.dataset.tab;
        activeBottomTab = tabTarget;

        if (tabTarget === 'ldp' || tabTarget === 'lbh' || tabTarget === 'badstock') {
          const menuKey = tabTarget.toUpperCase();
          activeSidebarMenu = menuKey;
          dom.sidebarNavBtns.forEach(b => b.classList.toggle('active', b.dataset.menu === menuKey));
          applyFilters();
          renderAllCharts();
          renderTable();
        } else if (tabTarget === 'all' || tabTarget === 'overview') {
          activeSidebarMenu = 'ALL';
          dom.sidebarNavBtns.forEach(b => b.classList.toggle('active', b.dataset.menu === 'ALL'));
          applyFilters();
          renderAllCharts();
          renderTable();
        } else if (tabTarget === 'input_manual') {
          openNewAnomalyModal();
        }
      });
    });

    // ── Header Action Buttons ──
    if (dom.btnInputAnomali) {
      dom.btnInputAnomali.addEventListener('click', openNewAnomalyModal);
    }

    if (dom.btnExportCsv) {
      dom.btnExportCsv.addEventListener('click', exportCsvReport);
    }

    if (dom.btnPrintReport) {
      dom.btnPrintReport.addEventListener('click', () => window.print());
    }

    if (dom.btnSyncCloud) {
      dom.btnSyncCloud.addEventListener('click', syncCloudData);
    }

    // Modal Close
    dom.modalCloseBtns.forEach(btn => {
      btn.addEventListener('click', closeAllModals);
    });

    // New Anomaly Submit
    if (dom.newAnomalyForm) {
      dom.newAnomalyForm.addEventListener('submit', handleNewAnomalySubmit);
    }
  }

  function updateHeaderTitles() {
    if (!dom.headerTitle) return;
    const map = {
      'ALL': 'CWG Leader Command Center',
      'LDP': 'Leader Console: Lost Damage Problem (LDP)',
      'LBH': 'Leader Console: Barang Lebih / Surplus (LBH)',
      'BADSTOCK': 'Leader Console: BADSTOCK & Defect'
    };
    dom.headerTitle.innerHTML = `👑 ${map[activeSidebarMenu] || 'CWG Leader Command Center'}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. MODAL HANDLERS & CRUD
  // ══════════════════════════════════════════════════════════════════════════
  function openNewAnomalyModal() {
    if (dom.modalNewAnomaly) {
      dom.modalNewAnomaly.classList.remove('hidden');
    }
  }

  function closeAllModals() {
    if (dom.modalNewAnomaly) dom.modalNewAnomaly.classList.add('hidden');
    if (dom.modalDetailAnomaly) dom.modalDetailAnomaly.classList.add('hidden');
  }

  function handleNewAnomalySubmit(e) {
    e.preventDefault();
    const sku = document.getElementById('inputSku').value.trim();
    const productName = document.getElementById('inputProductName').value.trim();
    const category = document.getElementById('inputCategory').value;
    const qty = parseInt(document.getElementById('inputQty').value, 10) || 1;
    const elRack = document.getElementById('inputRack');
    const rack = elRack ? elRack.value.trim() : '-';
    const zone = document.getElementById('inputZone').value;
    const shift = document.getElementById('inputShift').value;
    const reason = document.getElementById('inputReason').value.trim();
    const pic = document.getElementById('inputPic').value.trim() || 'Leader CWG';
    const notes = document.getElementById('inputNotes').value.trim();

    if (!sku || !productName) {
      alert('Harap lengkapi SKU dan Nama Produk!');
      return;
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().slice(0, 5);

    const newItem = {
      id: `${category}-CWG-${Date.now().toString().slice(-4)}`,
      sku,
      productName,
      category,
      qty,
      rack,
      zone,
      shift,
      reason,
      pic,
      status: 'Pending',
      date: dateStr,
      time: timeStr,
      lossValue: category === 'LBH' ? 0 : qty * 15000,
      notes
    };

    allAnomalies.unshift(newItem);
    saveDataToLocalStorage();

    closeAllModals();
    dom.newAnomalyForm.reset();

    applyFilters();
    renderKpiMetrics();
    renderAllCharts();
    renderTable();

    alert(`✅ Data produk ${category} [${sku}] berhasil ditambahkan!`);
  }

  function openDetailModal(itemId) {
    const item = allAnomalies.find(i => i.id === itemId);
    if (!item) return;

    const modal = dom.modalDetailAnomaly;
    if (!modal) return;

    document.getElementById('detailSku').textContent = item.sku;
    document.getElementById('detailName').textContent = item.productName;
    document.getElementById('detailCategory').textContent = item.category;
    document.getElementById('detailQty').textContent = `${item.qty} pcs`;
    const elDetailRack = document.getElementById('detailRack');
    if (elDetailRack) elDetailRack.textContent = item.rack;
    document.getElementById('detailZone').textContent = item.zone;
    document.getElementById('detailShift').textContent = item.shift;
    document.getElementById('detailPic').textContent = item.pic;
    document.getElementById('detailReason').textContent = item.reason;
    document.getElementById('detailNotes').textContent = item.notes || '-';
    document.getElementById('detailStatus').value = item.status;

    // Attach save action
    const btnSaveStatus = document.getElementById('btnSaveDetailStatus');
    if (btnSaveStatus) {
      btnSaveStatus.onclick = () => {
        const newStatus = document.getElementById('detailStatus').value;
        item.status = newStatus;
        saveDataToLocalStorage();
        closeAllModals();
        applyFilters();
        renderKpiMetrics();
        renderAllCharts();
        renderTable();
      };
    }

    modal.classList.remove('hidden');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. CLOUD SYNC & EXPORT
  // ══════════════════════════════════════════════════════════════════════════
  function fetchFromSpreadsheetGviz() {
    return new Promise((resolve, reject) => {
      // 1. Coba proxy internal server lokal terlebih dahulu jika sedang berjalan
      fetch('/api/cwg-anomali-json')
        .then(res => res.json())
        .then(res => {
          if (res.success && Array.isArray(res.data) && res.data.length > 0) {
            resolve(res.data);
          } else {
            throw new Error(res.error || 'Empty proxy data');
          }
        })
        .catch(() => {
          // 2. Fallback direct JSONP ke Google Spreadsheet resmi
          const callbackName = 'onCwgGvizLoaded_' + Math.floor(Math.random() * 1000000);
          const script = document.createElement('script');
          const timeout = setTimeout(() => {
            delete window[callbackName];
            if (script.parentNode) script.parentNode.removeChild(script);
            reject(new Error('Timeout memuat data dari Spreadsheet Google'));
          }, 12000);

          window[callbackName] = function(gvizData) {
            clearTimeout(timeout);
            delete window[callbackName];
            if (script.parentNode) script.parentNode.removeChild(script);

            try {
              if (!gvizData || !gvizData.table || !Array.isArray(gvizData.table.rows)) {
                return reject(new Error('Struktur Gviz tidak valid'));
              }
              const rows = gvizData.table.rows;
              const records = rows.map((r, idx) => {
                const getVal = (i) => (r.c && r.c[i] ? (r.c[i].v !== null && r.c[i].v !== undefined ? r.c[i].v : r.c[i].f) : '');
                const rawCat = String(getVal(0) || 'BADSTOCK').toUpperCase();
                let category = 'BADSTOCK';
                if (rawCat.includes('LDP') || rawCat === 'LOST') category = 'LDP';
                else if (rawCat.includes('LBH') || rawCat.includes('LEBIH') || rawCat.includes('SURPLUS')) category = 'LBH';
                else if (rawCat.includes('BAD')) category = 'BADSTOCK';

                const sku = String(getVal(2) || '');
                const productName = String(getVal(3) || 'Produk CWG');
                const qty = parseInt(getVal(4) || 1, 10);
                const cogs = parseFloat(getVal(5) || 0);

                // Loss calculation: Only LDP and BADSTOCK are actual losses. LBH is surplus (not a loss).
                let rawVal = parseFloat(getVal(6) || 0);
                if (!rawVal && cogs) rawVal = cogs * qty;
                let lossVal = 0;
                let surplusVal = 0;
                if (category === 'LDP' || category === 'BADSTOCK') {
                  lossVal = Math.round(rawVal);
                } else if (category === 'LBH') {
                  surplusVal = Math.round(rawVal);
                }

                const rackName = String(getVal(7) || '');
                const pic = String(getVal(8) || 'Petugas CWG');
                const detailStatus = String(getVal(9) || '');
                const rawDate = String(getVal(10) || '');
                const reason = String(getVal(11) || detailStatus || 'Anomali Stock CWG');

                // Zone: from column 12 (product_type_name) or fallback to rackName
                let zone = String(getVal(12) || '').trim();
                if (!zone) {
                  if (rackName.toUpperCase().includes('FROZEN')) zone = 'Frozen';
                  else if (rackName.toUpperCase().includes('FRESH')) zone = 'Fresh';
                  else if (rackName.toUpperCase().includes('CHILL')) zone = 'Chiller';
                  else zone = 'Ambient';
                }

                const isGantung = reason.toLowerCase().includes('dalam pencarian') ||
                                  reason.toLowerCase().includes('investigasi') ||
                                  detailStatus.toLowerCase().includes('investigasi') ||
                                  detailStatus.toLowerCase() === 'pending';

                const datePart = rawDate && rawDate.includes(' ') ? rawDate.split(' ')[0] : (rawDate || new Date().toISOString().slice(0, 10));
                const timePart = rawDate && rawDate.includes(' ') ? rawDate.split(' ')[1].slice(0, 5) : '12:00';

                return {
                  id: 'CWG-ROW-' + (idx + 1),
                  sku,
                  productName,
                  category,
                  qty: isNaN(qty) ? 1 : qty,
                  rack: 'CWG-FLOOR',
                  zone: zone || 'Ambient',
                  shift: 'Shift Siang',
                  reason: reason,
                  pic: pic,
                  status: isGantung ? 'Investigasi' : 'Selesai',
                  date: datePart,
                  time: timePart,
                  lossValue: lossVal,
                  surplusValue: surplusVal,
                  notes: 'Sinkronisasi Spreadsheet Hub CWG Cawang'
                };
              });
              resolve(records);
            } catch (err) {
              reject(err);
            }
          };

          script.src = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=responseHandler:${callbackName}&sheet=${encodeURIComponent(SPREADSHEET_SHEET_NAME)}&_t=${Date.now()}`;
          script.onerror = () => {
            clearTimeout(timeout);
            delete window[callbackName];
            if (script.parentNode) script.parentNode.removeChild(script);
            reject(new Error('Gagal request script Gviz Google Sheet'));
          };
          document.body.appendChild(script);
        });
    });
  }

  function syncCloudData(isSilent = false) {
    if (dom.btnSyncCloud) {
      dom.btnSyncCloud.textContent = '🔄 Menyinkronkan...';
      dom.btnSyncCloud.disabled = true;
    }

    fetchFromSpreadsheetGviz()
      .then(records => {
        if (Array.isArray(records) && records.length > 0) {
          console.log(`✅ Berhasil mengambil ${records.length} data dari Google Sheet: ${SPREADSHEET_SHEET_NAME}`);
          allAnomalies = records;
          saveDataToLocalStorage();
          populatePicDropdown();
          applyFilters();
          renderKpiMetrics();
          renderAllCharts();
          renderTable();
          if (dom.headerSubtitle) {
            dom.headerSubtitle.textContent = `Hub CWG Cawang • Live Spreadsheet (${records.length} data)`;
          }
          if (!isSilent) {
            alert(`✅ Sinkronisasi Berhasil!\n\nSebanyak ${records.length} data aktual (LDP, LBH, BADSTOCK) berhasil ditarik dari Google Sheet CWG.`);
          }
        } else {
          if (!isSilent) alert('ℹ️ Tidak ada data yang ditemukan di sheet.');
        }
      })
      .catch(err => {
        console.warn('Gagal sync ke spreadsheet:', err);
        if (!isSilent) {
          alert('⚠️ Gagal terhubung ke Google Sheet live. Menggunakan database lokal.');
        }
      })
      .finally(() => {
        if (dom.btnSyncCloud) {
          dom.btnSyncCloud.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            <span>Sync Cloud</span>
          `;
          dom.btnSyncCloud.disabled = false;
        }
      });
  }

  function exportCsvReport() {
    if (filteredAnomalies.length === 0) {
      alert('Tidak ada data untuk diekspor!');
      return;
    }

    const headers = ['ID', 'SKU', 'Nama Produk', 'Kategori', 'Qty', 'Zona', 'Shift', 'Penyebab', 'Petugas PIC', 'Status', 'Tanggal', 'Jam', 'Estimasi Loss (Rp)', 'Catatan Leader'];
    const rows = filteredAnomalies.map(item => [
      item.id,
      item.sku,
      `"${item.productName.replace(/"/g, '""')}"`,
      item.category,
      item.qty,
      item.zone,
      item.shift,
      `"${(item.reason || '').replace(/"/g, '""')}"`,
      item.pic,
      item.status,
      item.date,
      item.time,
      item.lossValue || 0,
      `"${(item.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `REKAP_LEADER_CWG_${activeSidebarMenu}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. MASTER RENDER PIPELINE
  // ══════════════════════════════════════════════════════════════════════════
  function renderAllCharts() {
    renderDonutChart();
    renderRackBarChart();
    renderStatusChart();
    renderTop5Chart();
    renderBottom5Chart();
  }

  function renderAll() {
    applyFilters();
    renderKpiMetrics();
    renderAllCharts();
    renderTable();
  }

  function filterByPic(picName) {
    if (!picName) return;
    currentSlicers.pic = picName;
    currentSlicers.picExclude = false;
    if (dom.slicerPicSelect) dom.slicerPicSelect.value = picName;
    if (dom.slicerPicExcludeCheck) dom.slicerPicExcludeCheck.checked = false;
    dom.slicerChips.forEach(c => {
      if (c.dataset.slicerGroup === 'pic') {
        c.classList.remove('active');
      }
    });
    renderAll();
  }

  // ── INIT ──
  function init() {
    loadData();
    initPinLockEngine();
    populatePicDropdown();
    initEventListeners();
    renderAll();
    syncCloudData(true); // Otomatis sync data live dari Google Sheet saat dibuka
  }

  // Expose methods for row actions
  window.cwgLeaderApp = {
    openDetailModal,
    openNewAnomalyModal,
    lockDashboard,
    filterByPic
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
