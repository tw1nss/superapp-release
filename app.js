/**
 * Superapp MTG
 * ──────────────────────────────────────────
 * High-performance warehouse barcode generator & real-time MSLTC clearance checker.
 * Optimized with IndexedDB local caching + Selective Google Sheets Queries (Sub-Second Load).
 */

(function () {
  'use strict';

  // ── Config ──
  const SHEET_ID = '1AatdTplbM_Peg-pXWRihuhO0JGq3TwvaHhQ_f4sNeeo';
  // Selective column query for Master Rack
  const MASTER_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&tq=SELECT%20A,%20C,%20D,%20E,%20F,%20J`;
  // CSV Query for MSLTC sheet
  const MSLTC_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=MSLTC`;

  const MAX_HISTORY = 8;
  const DB_NAME = 'QRSLOC_DB_MTG_V2';
  const DB_VERSION = 1;
  const STORE_NAME = 'master_cache';

  // ── State ──
  let dataMap = new Map(); // Master Rack SKU → Array of { sloc, productName, masterSloc, type, left }
  let msltcMap = new Map(); // MSLTC SKU → Array of { locationName, productId, productName, rackName, type, msltcDays }
  let dataLoaded = false;
  let dataTimestamp = null;
  let totalRecords = 0;
  let mainMode = 'barcode'; // 'barcode' or 'msltc'
  let currentMode = 'sloc'; // 'sloc' or 'produk' (for barcode generator)
  let lastSearchQuery = '';
  let lastSearchExpiredDate = null; // last expired date string (DDMMYYYY) from barcode scan
  let lastSearchResults = null;
  let clockInterval = null;
  let autoSearchTimer = null; // debounce timer for auto-search

  // ── High-Performance Utilities ──
  function debounce(func, wait = 160) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function safeJsonParse(str, fallback = null) {
    if (!str) return fallback;
    try {
      return JSON.parse(str);
    } catch (e) {
      console.warn('safeJsonParse fallback:', e);
      return fallback;
    }
  }

  // ── DOM Elements ──
  const loadingOverlay = document.getElementById('loadingOverlay');
  const dataStatus = document.getElementById('dataStatus');
  const statusText = document.getElementById('statusText');
  const refreshBtn = document.getElementById('refreshBtn');
  const searchForm = document.getElementById('searchForm');
  const skuInput = document.getElementById('skuInput');
  const submitBtn = document.getElementById('submitBtn');
  const resultSection = document.getElementById('resultSection');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const tabBarcode = document.getElementById('tabBarcode');
  const tabMsltc = document.getElementById('tabMsltc');


  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB not supported'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveCache(masterArray, msltcArray, count, timestampIso) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ masterArray, msltcArray, count, timestampIso }, 'masterDataV2');
      return tx.complete;
    } catch (e) {
      console.warn('IndexedDB save failed:', e);
    }
  }

  async function getCache() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      return new Promise((resolve) => {
        const req = store.get('masterDataV2');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  // ══════════════════════════════════════════════
  //  DATA LAYER & FAST PARSING
  // ══════════════════════════════════════════════

  function parseCSV(csvText) {
    const rows = [];
    let current = '';
    let inQuotes = false;
    let row = [];

    for (let i = 0; i < csvText.length; i++) {
      const ch = csvText[i];
      const next = csvText[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(current.trim());
          current = '';
        } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
          row.push(current.trim());
          current = '';
          if (row.length > 1) rows.push(row);
          row = [];
          if (ch === '\r') i++;
        } else {
          current += ch;
        }
      }
    }

    if (current || row.length > 0) {
      row.push(current.trim());
      if (row.length > 1) rows.push(row);
    }

    return rows;
  }

  function buildMasterMap(rows) {
    const map = new Map();
    const masterArray = [];
    let count = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const left = (row[0] || '').trim();
      const masterSloc = (row[1] || '').trim();
      const sku = (row[2] || '').trim();
      const productName = (row[3] || '').trim();
      const type = (row[4] || '').trim();
      const sloc = (row[5] || '').trim();

      if (sku && sloc) {
        const item = { sku, sloc, productName, masterSloc, type, left };
        if (!map.has(sku)) {
          map.set(sku, []);
        }
        map.get(sku).push(item);
        masterArray.push([sku, item]);
        count++;
      }
    }

    for (const [, items] of map.entries()) {
      items.sort((a, b) => compareSlocNatural(a.sloc || a.masterSloc, b.sloc || b.masterSloc));
    }

    return { map, count, masterArray };
  }

  function buildMsltcMap(rows) {
    const map = new Map();
    const msltcArray = [];

    // Header: location_id, location_name, product_id, sku_number, product_name, rack_name, Product Type, msltc
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const locationName = (row[1] || '').trim();
      const productId = (row[2] || '').trim();
      const sku = (row[3] || '').trim();
      const productName = (row[4] || '').trim();
      const rackName = (row[5] || '').trim();
      const type = (row[6] || '').trim();
      const msltcDays = parseInt((row[7] || '0').trim(), 10) || 0;

      if (sku || productId) {
        const primaryKey = sku || productId;
        const item = { locationName, productId, sku: primaryKey, productName, rackName, type, msltcDays };

        if (!map.has(primaryKey)) {
          map.set(primaryKey, []);
        }
        map.get(primaryKey).push(item);
        msltcArray.push([primaryKey, item]);

        // Also index by productId if different
        if (productId && productId !== primaryKey) {
          if (!map.has(productId)) {
            map.set(productId, []);
          }
          map.get(productId).push(item);
        }
      }
    }

    for (const [, items] of map.entries()) {
      items.sort((a, b) => compareSlocNatural(a.rackName || a.locationName, b.rackName || b.locationName));
    }

    return { map, msltcArray };
  }

  async function fetchSheetData(isBackground = false) {
    if (!isBackground) {
      setStatus('loading', 'Memuat data terbaru dari Google Sheets...');
      refreshBtn.classList.add('spinning');
    }

    try {
      const [masterRes, msltcRes] = await Promise.all([
        fetch(MASTER_CSV_URL),
        fetch(MSLTC_CSV_URL)
      ]);

      if (!masterRes.ok || !msltcRes.ok) throw new Error(`HTTP fetch error`);

      const [masterCsv, msltcCsv] = await Promise.all([
        masterRes.text(),
        msltcRes.text()
      ]);

      const masterRows = parseCSV(masterCsv);
      const msltcRows = parseCSV(msltcCsv);

      const masterResult = buildMasterMap(masterRows);
      const msltcResult = buildMsltcMap(msltcRows);

      dataMap = masterResult.map;
      msltcMap = msltcResult.map;
      totalRecords = masterResult.count;
      dataLoaded = true;
      dataTimestamp = new Date();

      // Enrich DCC items if active
      if (typeof enrichAllDccListsWithSupersheet === 'function') {
        const didEnrich = enrichAllDccListsWithSupersheet();
        const dccWs = document.getElementById('dccWorkspace');
        if (didEnrich && dccWs && !dccWs.classList.contains('hidden')) {
          filterDccMainList();
        }
      }

      const timeStr = dataTimestamp.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
      });

      setStatus('loaded', `${totalRecords.toLocaleString('id-ID')} SKU dimuat · Terakhir: ${timeStr}`);
      submitBtn.disabled = false;
      if (!isBackground) skuInput.focus();

      // Cache to IndexedDB
      saveCache(masterResult.masterArray, msltcResult.msltcArray, totalRecords, dataTimestamp.toISOString());

      if (lastSearchQuery) {
        performSearch(lastSearchQuery);
      }

    } catch (err) {
      console.error('Failed to fetch sheet data:', err);
      if (!dataLoaded) {
        setStatus('error', 'Gagal memuat data. Periksa koneksi internet.');
        submitBtn.disabled = true;
      }
    } finally {
      refreshBtn.classList.remove('spinning');
      hideLoading();
    }
  }

  async function loadInitialData() {
    const cache = await getCache();

    if (cache && cache.masterArray && cache.masterArray.length > 0) {
      // Rehydrate Master Map
      const map = new Map();
      cache.masterArray.forEach(([sku, item]) => {
        if (!map.has(sku)) map.set(sku, []);
        map.get(sku).push(item);
      });
      dataMap = map;

      // Rehydrate MSLTC Map
      if (cache.msltcArray) {
        const mmap = new Map();
        cache.msltcArray.forEach(([sku, item]) => {
          if (!mmap.has(sku)) mmap.set(sku, []);
          mmap.get(sku).push(item);
        });
        msltcMap = mmap;
      }

      totalRecords = cache.count || map.size;
      dataLoaded = true;
      dataTimestamp = cache.timestampIso ? new Date(cache.timestampIso) : new Date();

      // Enrich DCC items if active
      if (typeof enrichAllDccListsWithSupersheet === 'function') {
        const didEnrich = enrichAllDccListsWithSupersheet();
        const dccWs = document.getElementById('dccWorkspace');
        if (didEnrich && dccWs && !dccWs.classList.contains('hidden')) {
          filterDccMainList();
        }
      }

      const timeStr = dataTimestamp.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
      });

      setStatus('loaded', `${totalRecords.toLocaleString('id-ID')} SKU dimuat · Terakhir: ${timeStr}`);
      submitBtn.disabled = false;
      hideLoading();
      skuInput.focus();

      // Background revalidation
      fetchSheetData(true);
    } else {
      fetchSheetData(false);
    }
  }

  // ══════════════════════════════════════════════
  //  SEARCH LOGIC & NORMALIZERS
  // ══════════════════════════════════════════════

  function normalizeEdString(rawEd) {
    if (!rawEd) return null;
    const trimmed = rawEd.trim();
    if (!trimmed) return null;

    // Handle delimited DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY
    const parts = trimmed.split(/[-/\.]/);
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      let yr = parts[2];
      if (yr.length === 2) {
        const yNum = parseInt(yr, 10);
        yr = (yNum < 50 ? 2000 + yNum : 1900 + yNum).toString();
      }
      return `${day}${month}${yr}`;
    }

    const cleanDigits = trimmed.replace(/[^0-9]/g, '');
    if (cleanDigits.length === 8) {
      return cleanDigits;
    }
    if (cleanDigits.length === 6) {
      const day = cleanDigits.substring(0, 2);
      const month = cleanDigits.substring(2, 4);
      let yNum = parseInt(cleanDigits.substring(4, 6), 10);
      const yr = (yNum < 50 ? 2000 + yNum : 1900 + yNum).toString();
      return `${day}${month}${yr}`;
    }

    return cleanDigits || trimmed;
  }

  function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let tmp, i, j, prev, val, row;
    if (a.length > b.length) { tmp = a; a = b; b = tmp; }
    row = Array(a.length + 1);
    for (i = 0; i <= a.length; i++) row[i] = i;
    for (i = 1; i <= b.length; i++) {
      prev = i;
      for (j = 1; j <= a.length; j++) {
        val = (b[i - 1] === a[j - 1]) ? row[j - 1] : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
        row[j - 1] = prev;
        prev = val;
      }
      row[a.length] = prev;
    }
    return row[a.length];
  }

  function matchProductName(pName, lowerQuery, queryWords) {
    if (!pName) return 0;
    const cleanPName = pName.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanQuery = lowerQuery.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanPName || !cleanQuery) return 0;

    // 1. Exact match
    if (cleanPName === cleanQuery) return 100;

    // 2. Full phrase match (substring)
    if (cleanPName.includes(cleanQuery)) {
      return cleanPName.startsWith(cleanQuery) ? 90 : 80;
    }

    // 3. Word Token & Fuzzy matching
    const pNameWords = cleanPName.split(' ').filter(Boolean);
    if (!queryWords || queryWords.length === 0) return 0;

    let matchScore = 0;
    for (const qWord of queryWords) {
      if (qWord.length <= 1) continue;
      
      let bestWordScore = 0;
      for (const pWord of pNameWords) {
        if (pWord === qWord) {
          bestWordScore = 1.0;
          break;
        } else if (pWord.includes(qWord) || (qWord.length >= 3 && qWord.includes(pWord))) {
          bestWordScore = Math.max(bestWordScore, 0.85);
        } else {
          const dist = levenshtein(qWord, pWord);
          const maxLen = Math.max(qWord.length, pWord.length);
          const similarity = 1 - (dist / maxLen);
          if (similarity >= 0.65) {
            bestWordScore = Math.max(bestWordScore, similarity * 0.9);
          }
        }
      }
      matchScore += bestWordScore;
    }

    if (matchScore === 0) return 0;

    const matchRatio = matchScore / queryWords.length;
    
    // Minor penalty for products with way too many extra words
    const extraWordsPenalty = Math.max(0, pNameWords.length - queryWords.length) * 0.02;
    const finalRatio = Math.max(0, matchRatio - extraWordsPenalty);

    // If all words matched perfectly
    if (matchScore >= queryWords.length * 0.98) {
      return 75;
    }

    // If at least 2 words matched or >= 50% score
    if (matchScore >= 1.5 || finalRatio >= 0.45) {
      return Math.round(finalRatio * 60);
    }

    return 0;
  }

  function searchSKU(query) {
    const cleaned = (query || '').trim();
    if (!cleaned) return null;
    const lowerQuery = cleaned.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryWords = lowerQuery.split(' ').filter(w => w.length > 0);

    // 1. Direct SKU check in Master Data map
    if (dataMap.has(cleaned)) return dataMap.get(cleaned);
    for (const [key, value] of dataMap) {
      if (key.toLowerCase().trim() === cleaned.toLowerCase()) return value;
    }

    // 2. Direct SKU check in MSLTC map
    let msltcFound = null;
    if (msltcMap.has(cleaned)) {
      msltcFound = msltcMap.get(cleaned);
    } else {
      for (const [key, value] of msltcMap) {
        if (key.toLowerCase().trim() === cleaned.toLowerCase()) {
          msltcFound = value;
          break;
        }
      }
    }

    if (msltcFound && msltcFound.length > 0) {
      const withRack = msltcFound.filter(m => m.rackName && m.rackName.trim() !== '');
      const itemsToUse = withRack.length > 0 ? withRack : msltcFound;
      return itemsToUse.map(m => ({
        sku: m.sku || m.productId || cleaned,
        sloc: m.rackName || 'Belum Ada SLOC di Sistem',
        productName: m.productName || 'Produk MSLTC',
        masterSloc: m.rackName || '',
        type: m.type || 'Fresh',
        left: m.productId || ''
      }));
    }

    // 3. Search by Product Name in Master Data map
    const masterScored = [];
    const seenMasterKeys = new Set();

    for (const [key, items] of dataMap) {
      for (const item of items) {
        const score = matchProductName(item.productName, lowerQuery, queryWords);
        if (score > 0) {
          const uniqueId = `${item.sku || key}_${item.sloc || item.masterSloc}`;
          if (!seenMasterKeys.has(uniqueId)) {
            seenMasterKeys.add(uniqueId);
            masterScored.push({
              item: { ...item, sku: item.sku || key },
              score: score
            });
          }
        }
      }
    }

    if (masterScored.length > 0) {
      masterScored.sort((a, b) => b.score - a.score || (a.item.productName || '').localeCompare(b.item.productName || ''));
      return masterScored.map(s => s.item);
    }

    // 4. Search by Product Name in MSLTC map
    const msltcScored = [];
    const seenMsltcKeys = new Set();

    for (const [key, items] of msltcMap) {
      for (const item of items) {
        const score = matchProductName(item.productName, lowerQuery, queryWords);
        if (score > 0) {
          const uniqueId = `${item.sku || key}_${item.rackName || item.locationName}`;
          if (!seenMsltcKeys.has(uniqueId)) {
            seenMsltcKeys.add(uniqueId);
            msltcScored.push({
              item: {
                sku: item.sku || item.productId || cleaned,
                sloc: item.rackName || 'Belum Ada SLOC di Sistem',
                productName: item.productName || 'Produk MSLTC',
                masterSloc: item.rackName || '',
                type: item.type || 'Fresh',
                left: item.productId || ''
              },
              score: score
            });
          }
        }
      }
    }

    if (msltcScored.length > 0) {
      msltcScored.sort((a, b) => b.score - a.score || (a.item.productName || '').localeCompare(b.item.productName || ''));
      return msltcScored.map(s => s.item);
    }

    return null;
  }

  // ══════════════════════════════════════════════
  //  AUTOCOMPLETE SEARCH SUGGESTIONS & DROPDOWN
  // ══════════════════════════════════════════════

  let activeSuggestionIndex = -1;
  let currentSuggestions = [];

  function getSearchSuggestions(rawInput) {
    if (!rawInput || !dataLoaded) return [];

    let baseQuery = rawInput;
    let expDate = null;
    if (rawInput.includes(';')) {
      const parts = rawInput.split(';');
      baseQuery = parts[0].trim();
      expDate = parts[1] ? normalizeEdString(parts[1]) : null;
    }

    const cleaned = baseQuery.trim();
    if (!cleaned) return [];
    const lowerQuery = cleaned.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryWords = lowerQuery.split(' ').filter(w => w.length > 0);

    const suggestionMap = new Map();

    // 1. Direct SKU check in dataMap
    for (const [skuKey, items] of dataMap) {
      if (skuKey.toLowerCase().trim() === cleaned.toLowerCase() && items.length > 0) {
        const firstItem = items[0] || {};
        const actualSku = firstItem.sku || skuKey;
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: firstItem.productName || skuKey,
          sloc: firstItem.sloc || firstItem.masterSloc || '',
          type: firstItem.type || '',
          expDate: expDate,
          score: 100
        });
      }
    }
    for (const [skuKey, items] of msltcMap) {
      const firstItem = items[0] || {};
      const actualSku = firstItem.sku || skuKey;
      if (skuKey.toLowerCase().trim() === cleaned.toLowerCase() && items.length > 0 && !suggestionMap.has(actualSku)) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: firstItem.productName || skuKey,
          sloc: firstItem.rackName || firstItem.locationName || '',
          type: firstItem.type || '',
          expDate: expDate,
          score: 95
        });
      }
    }

    // 2. Search by Product Name in dataMap
    for (const [skuKey, items] of dataMap) {
      const firstItem = items[0] || {};
      const actualSku = firstItem.sku || skuKey;
      if (suggestionMap.has(actualSku)) continue;
      
      const score = matchProductName(firstItem.productName, lowerQuery, queryWords);
      if (score > 0) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: firstItem.productName || skuKey,
          sloc: firstItem.sloc || firstItem.masterSloc || '',
          type: firstItem.type || '',
          expDate: expDate,
          score: score
        });
      }
    }

    // 3. Search in MSLTC map
    for (const [skuKey, items] of msltcMap) {
      const firstItem = items[0] || {};
      const actualSku = firstItem.sku || skuKey;
      if (suggestionMap.has(actualSku)) continue;

      const score = matchProductName(firstItem.productName, lowerQuery, queryWords);
      if (score > 0) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: firstItem.productName || skuKey,
          sloc: firstItem.rackName || firstItem.locationName || '',
          type: firstItem.type || '',
          expDate: expDate,
          score: score
        });
      }
    }

    const suggestions = Array.from(suggestionMap.values());
    suggestions.sort((a, b) => b.score - a.score || a.productName.localeCompare(b.productName));
    return suggestions.slice(0, 25);
  }

  function renderDropdown(suggestions, expDate) {
    const dropdown = document.getElementById('searchDropdown');
    if (!dropdown) return;

    currentSuggestions = suggestions;
    activeSuggestionIndex = -1;

    if (!suggestions || suggestions.length === 0) {
      hideDropdown();
      return;
    }

    let html = '';
    suggestions.forEach((item, idx) => {
      const typeBadgeClass = getTypeBadgeClass(item.type);
      const typeHtml = item.type ? `<span class="type-badge ${typeBadgeClass}">${escapeHtml(item.type)}</span>` : '';
      const expBadge = expDate ? `<span class="dropdown-exp-badge">📅 ED: ${escapeHtml(expDate)}</span>` : '';

      html += `
        <div class="search-dropdown-item" data-idx="${idx}" onmousedown="event.preventDefault(); selectSuggestionItem(${idx});">
          <div class="dropdown-item-main">
            <div class="dropdown-item-title">
              <span class="dropdown-product-name">${escapeHtml(item.productName)}</span>
              ${typeHtml}
              ${expBadge}
            </div>
            <div class="dropdown-item-meta">
              <span class="dropdown-meta-sku">SKU: <strong>${escapeHtml(item.sku)}</strong></span>
              ${item.sloc ? `<span class="dropdown-meta-sloc">📍 SLOC: <strong>${escapeHtml(item.sloc)}</strong></span>` : ''}
            </div>
          </div>
        </div>
      `;
    });

    dropdown.innerHTML = html;
    dropdown.style.display = 'flex';
    dropdown.classList.remove('hidden');
  }

  function hideDropdown() {
    const dropdown = document.getElementById('searchDropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
    }
    activeSuggestionIndex = -1;
    currentSuggestions = [];
  }

  function updateActiveDropdownItem() {
    const dropdown = document.getElementById('searchDropdown');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.search-dropdown-item');
    items.forEach((item, idx) => {
      if (idx === activeSuggestionIndex) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  window.selectSuggestionItem = function (index) {
    if (!currentSuggestions || !currentSuggestions[index]) return;
    const selected = currentSuggestions[index];

    let expDate = selected.expDate;
    if (!expDate && skuInput.value.includes(';')) {
      const parts = skuInput.value.split(';');
      expDate = parts[1] ? normalizeEdString(parts[1]) : null;
    } else if (expDate) {
      expDate = normalizeEdString(expDate);
    }

    skuInput.value = expDate ? `${selected.sku};${expDate}` : selected.sku;
    hideDropdown();
    if (skuInput) skuInput.blur();

    displaySelectedProduct(selected.sku, expDate);
  };

  function displaySelectedProduct(sku, expDate) {
    hideDropdown();
    lastSearchQuery = sku;
    lastSearchExpiredDate = expDate;

    let results = null;
    if (dataMap.has(sku)) {
      results = dataMap.get(sku);
    } else if (msltcMap.has(sku)) {
      const msltcFound = msltcMap.get(sku);
      results = msltcFound.map(m => ({
        sku: m.sku || m.productId || sku,
        sloc: m.rackName || 'Belum Ada SLOC di Sistem',
        productName: m.productName || 'Produk MSLTC',
        masterSloc: m.rackName || '',
        type: m.type || 'Fresh',
        left: m.productId || ''
      }));
    } else {
      results = searchSKU(sku);
    }

    lastSearchResults = results;

    if (results && results.length > 0) {
      if (mainMode === 'msltc') {
        renderMsltcResults(sku, [results[0]], expDate);
      } else {
        renderBarcodeResults(sku, results, expDate);
      }
      const historyVal = expDate ? `${sku};${expDate}` : sku;
      addToHistory(historyVal);
    } else {
      renderError(sku);
    }
  }

  function performSearch(rawInput) {
    hideDropdown();
    if (!rawInput) return;
    if (!dataLoaded) {
      alert('Data Master sedang dimuat dari Google Sheets, mohon tunggu sebentar...');
      return;
    }

    let searchQuery = rawInput;
    let scannedDateStr = null;

    if (rawInput.includes(';')) {
      const parts = rawInput.split(';');
      searchQuery = parts[0].trim();
      scannedDateStr = parts[1] ? normalizeEdString(parts[1]) : null;

      // Auto-switch only when mainMode is already msltc or date is present with msltc intent
      if (mainMode === 'msltc' && scannedDateStr) {
        // keep msltc mode
      }
    }

    lastSearchQuery = searchQuery;
    lastSearchExpiredDate = scannedDateStr;
    const results = searchSKU(searchQuery);
    lastSearchResults = results;

    if (results && results.length > 0) {
      if (mainMode === 'msltc') {
        renderMsltcResults(searchQuery, [results[0]], scannedDateStr);
      } else {
        renderBarcodeResults(searchQuery, results, scannedDateStr);
      }
      addToHistory(rawInput);
    } else {
      renderError(rawInput);
      addToHistory(rawInput);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    hideDropdown();
    const val = skuInput.value.trim();
    if (!val) return;

    if (skuInput) skuInput.blur();

    // Check if dropdown is active and an item is selected
    if (activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex]) {
      selectSuggestionItem(activeSuggestionIndex);
      return;
    }

    // Check suggestions list
    const suggestions = getSearchSuggestions(val);
    if (suggestions && suggestions.length > 0) {
      const parts = val.split(';');
      const baseQuery = parts[0].trim().toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ');
      const expDate = parts[1] ? normalizeEdString(parts[1]) : null;

      // Check for exact SKU or exact product name match (case-insensitive)
      const exactMatchIdx = suggestions.findIndex(s => 
        s.sku.toLowerCase().trim() === baseQuery || 
        s.productName.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim() === baseQuery
      );

      if (exactMatchIdx >= 0) {
        currentSuggestions = suggestions;
        selectSuggestionItem(exactMatchIdx);
      } else {
        currentSuggestions = suggestions;
        selectSuggestionItem(0);
      }
    } else {
      performSearch(val);
    }
  }

  // ══════════════════════════════════════════════
  //  BARCODE GENERATOR RENDERING
  // ══════════════════════════════════════════════

  function getTypeBadgeClass(type) {
    const t = (type || '').toLowerCase();
    if (t === 'fresh') return 'badge-fresh';
    if (t === 'frozen') return 'badge-frozen';
    return 'badge-dry';
  }

  function splitSLOC(sloc) {
    if (!sloc) return { prefix: '', highlight: '' };
    const parts = sloc.split('-');
    if (parts.length <= 2) return { prefix: '', highlight: sloc };
    const highlight = parts.slice(-2).join('-');
    const prefix = parts.slice(0, -2).join('-') + '-';
    return { prefix, highlight };
  }

  function renderBarcodeResults(searchQuery, results, expiredDateStr) {
    let html = '';

    // Parse expired date for display
    let expiredDisplayStr = '';
    let expiredDateFormatted = '';
    if (expiredDateStr && /^\d{8}$/.test(expiredDateStr)) {
      const day = expiredDateStr.substring(0, 2);
      const month = expiredDateStr.substring(2, 4);
      const year = expiredDateStr.substring(4, 8);
      expiredDisplayStr = `${day}/${month}/${year}`;
      expiredDateFormatted = `${day}-${month}-${year}`;
    }

    if (results.length > 1) {
      html += `<div class="multi-result-header">Ditemukan <strong>${results.length} hasil</strong> untuk pencarian ini</div>`;
    }

    results.forEach((item, idx) => {
      const itemSku = item.sku || searchQuery;
      const qrId = `qrCode_${idx}`;
      const typeBadge = item.type ? `<span class="type-badge ${getTypeBadgeClass(item.type)}">${escapeHtml(item.type)}</span>` : '';
      const isSlocMode = currentMode === 'sloc';

      // Barcode value: SKU;DDMMYYYY if date present, else just SKU
      const barcodeValue = expiredDateStr ? `${itemSku};${expiredDateStr}` : itemSku;

      html += `
        <div class="result-section">
          <div class="result-card">
            
            <div class="result-card-header">
              <div class="result-title-group">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                <span>${isSlocMode ? 'Barcode SLOC (Rak)' : 'Barcode Produk (SKU)'}${results.length > 1 ? ` #${idx + 1}` : ''}</span>
              </div>
              ${typeBadge}
            </div>

            <div class="card-mode-switcher">
              <button class="card-mode-btn ${isSlocMode ? 'active' : ''}" onclick="switchBarcodeMode('sloc')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                Barcode SLOC
              </button>
              <button class="card-mode-btn ${!isSlocMode ? 'active' : ''}" onclick="switchBarcodeMode('produk')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                Barcode Produk
              </button>
            </div>

            <div class="qr-wrapper is-qr zoomable-qr" id="${qrId}" title="Klik / Ketuk untuk memperbesar QR Code" onclick="openQrZoomModal('${qrId}', '${escapeAttr(isSlocMode ? (item.sloc || itemSku) : barcodeValue)}', '${escapeAttr(isSlocMode ? ('SLOC: ' + (item.sloc || itemSku)) : ('Produk SKU: ' + itemSku))}', '${escapeAttr(item.productName || '')}')"></div>
            <div class="qr-zoom-hint-wrap" onclick="openQrZoomModal('${qrId}', '${escapeAttr(isSlocMode ? (item.sloc || itemSku) : barcodeValue)}', '${escapeAttr(isSlocMode ? ('SLOC: ' + (item.sloc || itemSku)) : ('Produk SKU: ' + itemSku))}', '${escapeAttr(item.productName || '')}')">
              <span class="qr-zoom-hint">🔍 Ketuk untuk perbesar</span>
            </div>

            <div class="result-info">
              <div class="result-info-row">
                <span class="result-label">SKU</span>
                <span class="result-value">${escapeHtml(itemSku)}</span>
              </div>
              ${expiredDisplayStr && !isSlocMode ? `
              <div class="result-info-row">
                <span class="result-label">Expired</span>
                <span class="result-value" style="color: #f59e0b; font-weight: 700;">📅 ${escapeHtml(expiredDisplayStr)}</span>
              </div>` : ''}
              <div class="result-info-row">
                <span class="result-label">SLOC</span>
                <span class="result-value sloc">${escapeHtml(item.sloc || '-')}</span>
              </div>
              ${item.type ? `
              <div class="result-info-row">
                <span class="result-label">TYPE</span>
                <span class="result-value">${typeBadge}</span>
              </div>` : ''}
              ${item.productName ? `<div class="result-product-name">📦 ${escapeHtml(item.productName)}</div>` : ''}
            </div>

            <div class="result-actions">
              <button class="btn-action primary" onclick="downloadBarcode('${qrId}', '${escapeAttr(itemSku)}', '${escapeAttr(item.sloc || '')}', '${escapeAttr(item.type || '')}', '${escapeAttr(item.productName || '')}', '${escapeAttr(item.left || '')}', '${escapeAttr(expiredDateStr || '')}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Download PNG
              </button>
              <button class="btn-action" onclick="printBarcode('${qrId}', '${escapeAttr(itemSku)}', '${escapeAttr(item.sloc || '')}', '${escapeAttr(item.productName || '')}', '${escapeAttr(item.type || '')}', '${escapeAttr(item.left || '')}', '${escapeAttr(expiredDateStr || '')}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 6 2 18 2 18 9"></polyline>
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                  <rect x="6" y="14" width="12" height="8"></rect>
                </svg>
                Print
              </button>
            </div>
          </div>
        </div>
      `;
    });

    resultSection.innerHTML = html;

    results.forEach((item, idx) => {
      const itemSku = item.sku || searchQuery;
      const barcodeValue = expiredDateStr ? `${itemSku};${expiredDateStr}` : itemSku;
      const qrId = `qrCode_${idx}`;
      const container = document.getElementById(qrId);
      if (!container) return;

      container.innerHTML = '';

      const qrValue = currentMode === 'sloc' ? (item.sloc || itemSku) : barcodeValue;
      new QRCode(container, {
        text: qrValue,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
    });
  }

  // ══════════════════════════════════════════════
  //  MSLTC REALTIME EXPIRATION RENDERING
  // ══════════════════════════════════════════════

  function formatDateId(date) {
    return date.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function formatTimeRealtime(date) {
    return date.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }) + ' WIB';
  }

  function renderMsltcResults(searchQuery, results, scannedDateStr) {
    let html = '';

    results.forEach((item, idx) => {
      const itemSku = item.sku || searchQuery;
      // Get corresponding active product rack location (SLOC) from Master dataset if available
      let rack = '-';
      if (dataMap && dataMap.has(itemSku)) {
        const masterList = dataMap.get(itemSku);
        if (masterList && masterList.length > 0 && masterList[0].sloc) {
          rack = masterList[0].sloc;
        }
      }
      if (rack === '-' || !rack) {
        rack = item.sloc || item.rackName || '-';
      }
      const typeBadge = item.type ? `<span class="type-badge ${getTypeBadgeClass(item.type)}">${escapeHtml(item.type)}</span>` : '';

      const msltcDays = item.msltcDays || 30;

      html += `
        <div class="result-section">
          <div class="msltc-card">
            
            <div class="msltc-header">
              <div class="msltc-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span>Cek Masa MSLTC & Shelf Life</span>
              </div>
              <div class="realtime-clock" id="clock_${idx}">
                ${formatDateId(new Date())} ${formatTimeRealtime(new Date())}
              </div>
            </div>

            <!-- Dynamic Alert Output Container -->
            <div class="msltc-alert-box alert-safe" id="alertBox_${idx}">
              <span class="alert-badge" id="alertBadge_${idx}">MEMUAT STATUS...</span>
              <div class="alert-main-text" id="alertMain_${idx}">-</div>
              <div class="alert-sub-text" id="alertSub_${idx}">-</div>
            </div>

            <!-- Expired Date Picker -->
            <div class="msltc-date-picker-group">
              <label for="expInput_${idx}" class="date-picker-label">📅 Masukkan Tanggal Expired Produk (ED)</label>
              <div class="date-input-wrapper">
                <input type="text" id="expInput_${idx}" class="date-input" placeholder="Pilih Tanggal (DD-MM-YYYY)..." style="cursor: pointer;">
                <button type="button" id="submitEdBtn_${idx}" class="btn-submit-ed">Submit</button>
              </div>
            </div>

            <!-- Detail Grid -->
            <div class="msltc-detail-grid">
              <div class="msltc-detail-item">
                <span class="msltc-detail-label">SKU Produk</span>
                <span class="msltc-detail-value">${escapeHtml(itemSku)}</span>
              </div>
              <div class="msltc-detail-item">
                <span class="msltc-detail-label">Batas MSLTC (Clearance)</span>
                <span class="msltc-detail-value" style="color: var(--accent-primary);">${msltcDays} Hari</span>
              </div>
              <div class="msltc-detail-item" style="grid-column: span 2;">
                <span class="msltc-detail-label">Nama Produk</span>
                <span class="msltc-detail-value" style="font-family: var(--font-body); font-size: 0.9rem; word-break: break-word;">${escapeHtml(item.productName || '-')}</span>
              </div>
              <div class="msltc-detail-item" style="grid-column: span 2;">
                <span class="msltc-detail-label">Kategori / Type</span>
                <span class="msltc-detail-value">${typeBadge}</span>
              </div>
            </div>

          </div>
        </div>
      `;
    });

    resultSection.innerHTML = html;

    results.forEach((item, idx) => {
      const msltcDays = item.msltcDays || 30;
      const expInput = document.getElementById(`expInput_${idx}`);
      let selectedExpDate = new Date();
      selectedExpDate.setDate(selectedExpDate.getDate() + msltcDays + 15);

      if (scannedDateStr && /^\d{8}$/.test(scannedDateStr)) {
        const day = parseInt(scannedDateStr.substring(0, 2), 10);
        const month = parseInt(scannedDateStr.substring(2, 4), 10) - 1;
        const year = parseInt(scannedDateStr.substring(4, 8), 10);
        const parsedDate = new Date(year, month, day);
        if (!isNaN(parsedDate.getTime())) {
          selectedExpDate = parsedDate;
        }
      }

      function updateCalculation() {
        if (!selectedExpDate) return;

        const expDate = new Date(selectedExpDate);
        const alertBox = document.getElementById(`alertBox_${idx}`);
        const alertBadge = document.getElementById(`alertBadge_${idx}`);
        const alertMain = document.getElementById(`alertMain_${idx}`);
        const alertSub = document.getElementById(`alertSub_${idx}`);

        if (isNaN(expDate.getTime())) {
          if (alertBox) {
            alertBox.className = 'msltc-alert-box alert-danger';
            alertBadge.textContent = '⚠️ TANGGAL TIDAK VALID';
            alertMain.textContent = 'Format Tanggal Salah';
            alertSub.textContent = 'Masukkan tanggal dengan format DD-MM-YYYY (contoh: 05-06-2027 atau 05062027).';
          }
          return;
        }

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        expDate.setHours(0, 0, 0, 0);

        // Batas Tanggal Penarikan = Expired Date minus MSLTC Days
        const clearanceDate = new Date(expDate);
        clearanceDate.setDate(clearanceDate.getDate() - msltcDays);

        // Sisa Hari Menuju Penarikan = Clearance Date minus Today
        const diffTime = clearanceDate.getTime() - now.getTime();
        const daysLeftToClearance = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const clearanceDateStr = formatDateId(clearanceDate);
        const expDateStr = formatDateId(expDate);

        if (daysLeftToClearance <= 0) {
          // MUST BE PULLED NOW (PENARIKAN BARANG)
          alertBox.className = 'msltc-alert-box alert-danger';
          alertBadge.textContent = '🚨 OUT OF SHELF - PENARIKAN BARANG';

          const daysOver = Math.abs(daysLeftToClearance);
          alertMain.textContent = `HARUS DITARIK SEKARANG! (${daysOver === 0 ? 'Hari Ini Batas Terakhir' : 'Lewat ' + daysOver + ' Hari'})`;
          alertSub.textContent = `Produk telah memasuki batas MSLTC (${msltcDays} hari sebelum expired). Batas penarikan: ${clearanceDateStr} (Expired: ${expDateStr}).`;
        } else {
          // SAFE / COUNTDOWN
          alertBox.className = 'msltc-alert-box alert-safe';
          alertBadge.textContent = '✅ PRODUK AMAN DI RAK';
          alertMain.textContent = `${daysLeftToClearance} Hari Lagi Harus Ditarik`;
          alertSub.textContent = `Produk masuk batas penarikan MSLTC pada ${clearanceDateStr} (${msltcDays} hari sebelum expired: ${expDateStr}).`;
        }
      }

      if (expInput) {
        let fp = null;
        try {
          fp = flatpickr(expInput, {
            dateFormat: "d-m-Y",
            defaultDate: selectedExpDate,
            locale: typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.id ? "id" : "default",
            disableMobile: true, // Force custom Flatpickr styling instead of native picker on mobile
            allowInput: true, // Allow user to type manually
            onChange: function (selectedDates, dateStr, instance) {
              if (selectedDates.length > 0) {
                selectedExpDate = selectedDates[0];
                updateCalculation();
              }
            }
          });
        } catch (e) {
          console.error("Flatpickr initialization failed:", e);
        }

        // Event listener for manual typing or scanner input (e.g. 05062027, 05-06-2027, 5/6/2027)
        const handleManualInput = () => {
          const rawVal = expInput.value;
          if (!rawVal || !rawVal.trim()) return;

          const parsed = parseFlexibleDate(rawVal);
          if (parsed && !isNaN(parsed.getTime())) {
            selectedExpDate = parsed;
            if (fp) fp.setDate(parsed, false);
            updateCalculation();
          } else if (rawVal.trim().length >= 6) {
            selectedExpDate = new Date("invalid");
            updateCalculation();
          }
        };

        const commitManualInput = () => {
          handleManualInput();
          if (selectedExpDate && !isNaN(selectedExpDate.getTime())) {
            const formatted = formatDateDash(selectedExpDate);
            expInput.value = formatted;
            if (fp) {
              fp.setDate(selectedExpDate, false);
              fp.close();
            }
          }
          expInput.blur();
        };

        expInput.addEventListener('input', handleManualInput);
        expInput.addEventListener('change', commitManualInput);

        // Handle ENTER key to apply calculation and close calendar dropdown
        expInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitManualInput();
          }
        });

        // Submit Button Click
        const submitEdBtn = document.getElementById(`submitEdBtn_${idx}`);
        if (submitEdBtn) {
          submitEdBtn.addEventListener('click', () => {
            commitManualInput();
          });
        }

        updateCalculation(); // initial calculation
      }
    });

    // Start Realtime Ticking Clock
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
      const now = new Date();
      results.forEach((_, idx) => {
        const clockEl = document.getElementById(`clock_${idx}`);
        if (clockEl) {
          clockEl.textContent = `${formatDateId(now)} ${formatTimeRealtime(now)}`;
        }
      });
    }, 1000);
  }

  function renderError(query) {
    resultSection.innerHTML = `
      <div class="result-section">
        <div class="error-card">
          <div class="error-icon">🔍</div>
          <div class="error-title">Data Tidak Ditemukan</div>
          <div class="error-message">
            Pencarian <strong style="font-family: var(--font-mono);">"${escapeHtml(query)}"</strong> tidak ditemukan di database master atau sheet MSLTC.
            <br>Pastikan kode SKU atau Nama Produk benar, atau coba refresh data.
          </div>
        </div>
      </div>
    `;
  }

  // Switch Main Menu (Barcode Generator vs Cek MSLTC)
  window.switchMainMenu = function (mode) {
    hideDropdown();
    mainMode = mode;

    if (mainMode === 'barcode' && clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }

    const tabBarcodeEl = document.getElementById('tabBarcode');
    const tabMsltcEl = document.getElementById('tabMsltc');
    const inputEl = document.getElementById('skuInput');

    if (mainMode === 'barcode') {
      if (tabBarcodeEl) tabBarcodeEl.classList.add('active');
      if (tabMsltcEl) tabMsltcEl.classList.remove('active');
      if (inputEl) inputEl.placeholder = 'Ketik SKU / Nama Produk (misal: Ultra Milk;25122026)...';
    } else {
      if (tabMsltcEl) tabMsltcEl.classList.add('active');
      if (tabBarcodeEl) tabBarcodeEl.classList.remove('active');
      if (inputEl) inputEl.placeholder = 'Ketik SKU / Nama Produk untuk Cek MSLTC...';
    }

    const currentQuery = (inputEl && inputEl.value.trim()) ? inputEl.value.trim() : lastSearchQuery;
    if (currentQuery) {
      performSearch(currentQuery);
    }
  };

  // Switch Barcode Mode (SLOC vs Produk)
  window.switchBarcodeMode = function (mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    if (lastSearchQuery) {
      // Re-render with stored expired date
      const rawQuery = lastSearchExpiredDate ? `${lastSearchQuery};${lastSearchExpiredDate}` : lastSearchQuery;
      performSearch(rawQuery);
    }
  };

  // ══════════════════════════════════════════════
  //  DOWNLOAD & PRINT
  // ══════════════════════════════════════════════

  function wrapText(ctx, text, maxWidth) {
    if (!text) return [];
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  window.downloadBarcode = function (qrId, sku, sloc, type, productName, left, expiredDateStr) {
    const container = document.getElementById(qrId);
    if (!container) return;

    const barcodeCanvas = container.querySelector('canvas') || container.querySelector('img');
    if (!barcodeCanvas) return;

    const exportCanvas = document.createElement('canvas');
    const ctx = exportCanvas.getContext('2d');

    const metaParts = [];
    if (left) metaParts.push(left.replace(/-$/, ''));
    if (type) metaParts.push(type);
    const metaText = metaParts.length > 0 ? 'MTG - ' + metaParts.join(' - ') : '';

    if (currentMode === 'sloc') {
      const { prefix, highlight } = splitSLOC(sloc);
      const qrSize = 150;
      const labelW = 360;
      const totalW = qrSize + labelW + 30;
      const totalH = qrSize + 40;

      exportCanvas.width = totalW;
      exportCanvas.height = totalH;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, totalW, totalH);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, totalW - 2, totalH - 2);

      ctx.drawImage(barcodeCanvas, 10, 10, qrSize, qrSize);

      const textX = qrSize + 20;
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'middle';

      ctx.font = '600 22px Arial, sans-serif';
      const prefixW = ctx.measureText(prefix).width;
      ctx.fillText(prefix, textX, 35);

      ctx.font = '900 30px Arial, sans-serif';
      ctx.fillText(highlight, textX + prefixW, 35);

      let yPos = 70;
      if (metaText) {
        ctx.font = '600 13px Arial, sans-serif';
        ctx.fillStyle = '#333';
        ctx.fillText(metaText, textX, yPos);
        yPos += 18;
      }

      if (productName) {
        ctx.font = '400 11px Arial, sans-serif';
        ctx.fillStyle = '#555';
        const pnLines = wrapText(ctx, productName, labelW - 20);
        pnLines.slice(0, 3).forEach((line) => {
          ctx.fillText(line, textX, yPos);
          yPos += 14;
        });
      }

      ctx.font = '500 12px Arial, sans-serif';
      ctx.fillStyle = '#333';
      ctx.fillText('SKU : ' + sku, textX, Math.max(yPos + 4, 140));

    } else {
      // Format expired date for display
      let expiredDisplayLine = '';
      if (expiredDateStr && /^\d{8}$/.test(expiredDateStr)) {
        const dd = expiredDateStr.substring(0, 2);
        const mm = expiredDateStr.substring(2, 4);
        const yyyy = expiredDateStr.substring(4, 8);
        expiredDisplayLine = `ED: ${dd}/${mm}/${yyyy}`;
      }

      const qrSize = 150;
      const labelW = 360;
      const totalW = qrSize + labelW + 30;
      const totalH = qrSize + 40;

      exportCanvas.width = totalW;
      exportCanvas.height = totalH;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, totalW, totalH);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, totalW - 2, totalH - 2);

      ctx.drawImage(barcodeCanvas, 10, 10, qrSize, qrSize);

      const textX = qrSize + 20;
      let yPos = 24;
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'top';

      if (productName) {
        ctx.font = 'bold 13px Arial, sans-serif';
        const lines = wrapText(ctx, productName, labelW - 20);
        lines.slice(0, 2).forEach(line => {
          ctx.fillText(line, textX, yPos);
          yPos += 18;
        });
      }

      ctx.font = 'bold 15px Arial, sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText('SKU : ' + sku, textX, yPos + 4);
      yPos += 22;

      if (sloc && sloc !== '-') {
        ctx.font = '600 13px Arial, sans-serif';
        ctx.fillStyle = '#333';
        ctx.fillText('SLOC ID : ' + sloc, textX, yPos + 2);
        yPos += 18;
      }

      if (expiredDisplayLine) {
        ctx.font = 'bold 13px Arial, sans-serif';
        ctx.fillStyle = '#b45309';
        ctx.fillText(expiredDisplayLine, textX, yPos + 2);
        yPos += 18;
      }

      if (metaText) {
        ctx.font = '600 11px Arial, sans-serif';
        ctx.fillStyle = '#555';
        ctx.fillText(metaText, textX, yPos + 2);
      }
    }

    exportCanvas.toBlob(function (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentMode === 'sloc' ? `Barcode_SLOC_${sloc}.png` : `QR_Produk_${sku}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  window.printBarcode = function (qrId, sku, sloc, productName, type, left, expiredDateStr) {
    if (currentMode === 'produk') {
      // Show modal for produk mode — user picks ED and MFG before printing
      showPrintProdukModal(qrId, sku, sloc, productName, type, left, expiredDateStr);
      return;
    }

    // ── SLOC mode: print directly ──
    const container = document.getElementById(qrId);
    if (!container) return;

    const canvas = container.querySelector('canvas');
    const imgSrc = canvas
      ? canvas.toDataURL('image/png')
      : (container.querySelector('img') || {}).src;

    if (!imgSrc) return;

    const { prefix, highlight } = splitSLOC(sloc);
    const metaParts = [];
    if (left) metaParts.push(left.replace(/-$/, ''));
    if (type) metaParts.push(type);
    const metaText = metaParts.length > 0 ? 'MTG - ' + metaParts.join(' - ') : '';

    const printWindow = window.open('', '_blank', 'width=600,height=350');
    const htmlContent = `
      <div class="label-container sloc-layout">
        <div class="label-qr">
          <img src="${imgSrc}" alt="Super App MTG">
        </div>
        <div class="label-info">
          <div class="sloc-line">
            <span class="sloc-prefix">${prefix}</span><span class="sloc-highlight">${highlight}</span>
          </div>
          ${metaText ? `<div class="meta-line">${metaText}</div>` : ''}
          ${productName ? `<div class="product-line">${productName}</div>` : ''}
          <div class="sku-line">SKU : ${sku}</div>
        </div>
      </div>
    `;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print SLOC - ${sloc}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&family=JetBrains+Mono:wght@500;700&display=swap');
          * { margin: 0; padding: 0; box-sizing: border-box; }
          @page { size: auto; margin: 4mm; }
          body { font-family: 'Inter', Arial, sans-serif; }
          .label-container { border: 2px solid #000; width: 100%; max-width: 500px; background: #fff; color: #000; }
          .sloc-layout { display: flex; align-items: stretch; }
          .label-qr { flex-shrink: 0; display: flex; align-items: center; justify-content: center; padding: 10px; border-right: 2px solid #000; }
          .label-qr img { width: 115px; height: 115px; display: block; }
          .label-info { flex: 1; padding: 10px 14px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
          .sloc-line { font-size: 22px; font-weight: 600; line-height: 1.2; display: flex; align-items: baseline; flex-wrap: wrap; }
          .sloc-prefix { font-weight: 600; }
          .sloc-highlight { font-weight: 900; font-size: 28px; background: #000; color: #fff; padding: 2px 8px; display: inline-block; }
          .meta-line { font-size: 11px; font-weight: 600; color: #444; margin-top: 2px; }
          .product-line { font-size: 10px; color: #444; line-height: 1.4; max-width: 280px; word-wrap: break-word; }
          .sku-line { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #444; }
        </style>
      </head>
      <body>${htmlContent}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.onload = function () { setTimeout(function () { printWindow.print(); }, 400); };
  };

  // ── Print Produk Modal helpers ──
  let _printProdukParams = {};
  let _fpPrintEd = null;
  let _fpPrintMfg = null;

  function formatMonthShort(date) {
    // Returns DD-Mon-YYYY e.g. 18-Jul-2027
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  }

  function showPrintProdukModal(qrId, sku, sloc, productName, type, left, expiredDateStr) {
    _printProdukParams = { qrId, sku, sloc, productName, type, left, expiredDateStr };
    const modal = document.getElementById('printProdukModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const edInput = document.getElementById('printEdInput');
    const mfgInput = document.getElementById('printMfgInput');
    const productAgeEl = document.getElementById('printProductAge');

    let initialEd = null;
    if (expiredDateStr && /^\d{8}$/.test(expiredDateStr)) {
      const d = expiredDateStr.substring(0, 2);
      const m = expiredDateStr.substring(2, 4);
      const y = expiredDateStr.substring(4, 8);
      initialEd = new Date(+y, +m - 1, +d);
    }

    if (_fpPrintEd) { try { _fpPrintEd.destroy(); } catch (e) { } _fpPrintEd = null; }
    if (_fpPrintMfg) { try { _fpPrintMfg.destroy(); } catch (e) { } _fpPrintMfg = null; }

    function recalcProductAge() {
      const edDate = _fpPrintEd && _fpPrintEd.selectedDates[0];
      const mfgDate = _fpPrintMfg && _fpPrintMfg.selectedDates[0];
      if (edDate && mfgDate && !isNaN(edDate) && !isNaN(mfgDate)) {
        const diffDays = Math.round((edDate - mfgDate) / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          const years = Math.floor(diffDays / 365);
          const months = Math.floor((diffDays % 365) / 30);
          const days = diffDays % 30;
          let ageStr = '';
          if (years > 0) ageStr += years + ' thn ';
          if (months > 0) ageStr += months + ' bln ';
          ageStr += days + ' hari';
          productAgeEl.textContent = ageStr.trim() + ' (' + diffDays + ' hari total)';
        } else {
          productAgeEl.textContent = 'MFG harus sebelum ED';
        }
      } else {
        productAgeEl.textContent = '-';
      }
    }

    _fpPrintEd = flatpickr(edInput, {
      dateFormat: 'd-m-Y',
      defaultDate: initialEd || null,
      disableMobile: true,
      allowInput: true,
      locale: typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.id ? 'id' : 'default',
      onChange: recalcProductAge
    });
    _fpPrintMfg = flatpickr(mfgInput, {
      dateFormat: 'd-m-Y',
      disableMobile: true,
      allowInput: true,
      locale: typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.id ? 'id' : 'default',
      onChange: recalcProductAge
    });

    const setupPrintManualInput = (inputElem, fpInstance) => {
      if (!inputElem) return;
      const handleInput = () => {
        const parsed = parseFlexibleDate(inputElem.value);
        if (parsed && fpInstance) {
          fpInstance.setDate(parsed, false);
          inputElem.value = formatDateDash(parsed);
          recalcProductAge();
        }
      };
      inputElem.addEventListener('change', handleInput);
      inputElem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleInput();
          if (fpInstance) fpInstance.close();
          inputElem.blur();
        }
      });
    };

    setupPrintManualInput(edInput, _fpPrintEd);
    setupPrintManualInput(mfgInput, _fpPrintMfg);

    if (initialEd) recalcProductAge();
  }

  function closePrintProdukModal() {
    const modal = document.getElementById('printProdukModal');
    if (modal) modal.classList.add('hidden');
  }

  function executePrintProduk() {
    const { sku, sloc, productName, type, left } = _printProdukParams;
    const edDate = _fpPrintEd && _fpPrintEd.selectedDates[0];
    const mfgDate = _fpPrintMfg && _fpPrintMfg.selectedDates[0];
    const qty = parseInt(document.getElementById('printQtyInput').value, 10) || 1;

    let edDDMMYYYY = '';
    let edDisplay = '';
    if (edDate && !isNaN(edDate)) {
      const dd = String(edDate.getDate()).padStart(2, '0');
      const mm = String(edDate.getMonth() + 1).padStart(2, '0');
      const yyyy = edDate.getFullYear();
      edDDMMYYYY = dd + mm + yyyy;
      edDisplay = formatMonthShort(edDate);
    }
    let mfgDisplay = '';
    if (mfgDate && !isNaN(mfgDate)) {
      mfgDisplay = formatMonthShort(mfgDate);
    }

    const barcodeValue = edDDMMYYYY ? (sku + ';' + edDDMMYYYY) : sku;
    const metaParts = [];
    if (left) metaParts.push(left.replace(/-$/, ''));
    if (type) metaParts.push(type);
    const metaText = metaParts.length > 0 ? 'MTG - ' + metaParts.join(' - ') : 'MTG';

    const barcodeCanvas = document.createElement('canvas');
    try {
      JsBarcode(barcodeCanvas, barcodeValue, {
        format: 'CODE128', width: 2, height: 60,
        displayValue: true, fontSize: 12, fontOptions: 'bold',
        margin: 8, background: '#ffffff', lineColor: '#000000'
      });
    } catch (e) { console.warn('Barcode gen failed:', e); }

    const qrWrapper = document.createElement('div');
    qrWrapper.style.cssText = 'position:absolute;left:-9999px;top:0;width:120px;height:120px;';
    document.body.appendChild(qrWrapper);
    new QRCode(qrWrapper, {
      text: barcodeValue, width: 120, height: 120,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });

    // Load app logo as data URL so it renders in the print window
    function getLogoDataUrl() {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          try {
            const c = document.createElement('canvas');
            c.width = 80; c.height = 80;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 80, 80);
            resolve(c.toDataURL('image/jpeg', 0.92));
          } catch (e) { resolve(''); }
        };
        img.onerror = function () { resolve(''); };
        img.src = 'astro-logo.png?' + Date.now();
      });
    }

    getLogoDataUrl().then(function (logoSrc) {
      setTimeout(() => {
        const qrImg = qrWrapper.querySelector('img') || qrWrapper.querySelector('canvas');
        const qrSrc = qrImg ? (qrImg.src || (qrImg.toDataURL ? qrImg.toDataURL() : '')) : '';
        const bcSrc = barcodeCanvas.toDataURL ? barcodeCanvas.toDataURL() : '';
        document.body.removeChild(qrWrapper);

        let labelsHtml = '';
        for (let i = 0; i < Math.min(qty, 50); i++) {
          labelsHtml += buildAstroLabelHtml(logoSrc, qrSrc, bcSrc, sku, productName, metaText, edDisplay, mfgDisplay);
        }

        const printWindow = window.open('', '_blank', 'width=700,height=500');
        printWindow.document.write('<!DOCTYPE html><html><head><title>Barcode Produk - ' + sku + '</title><style>\n'
          + "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap');\n"
          + '* { margin:0; padding:0; box-sizing:border-box; }\n'
          + '@page { size:auto; margin:4mm; }\n'
          + "body { font-family:'Inter',Arial,sans-serif; background:#fff; }\n"
          + '.page-labels { display:flex; flex-direction:column; gap:6px; padding:4px; }\n'
          // outer border only — no inner partitions
          + '.astro-label { border:2px solid #000; background:#fff; max-width:520px; width:100%; page-break-inside:avoid; }\n'
          // ── HEADER: logo | product name — no border between them
          + '.astro-top { display:flex; align-items:center; padding:6px 10px; border-bottom:1px solid #ccc; gap:10px; }\n'
          + '.astro-logo-cell { flex-shrink:0; display:flex; align-items:center; justify-content:center; }\n'
          + '.astro-logo-cell img { max-width:80px; max-height:36px; object-fit:contain; display:block; }\n'
          + '.astro-logo-cell .brand-text { font-size:16px; font-weight:900; font-style:italic; letter-spacing:-0.04em; }\n'
          + '.astro-product-name { font-size:10.5px; font-weight:600; color:#111; line-height:1.4; word-break:break-word; flex:1; }\n'
          // ── BODY: QR left | info right — no borders between
          + '.astro-body { display:flex; align-items:center; padding:8px 10px; gap:12px; }\n'
          + '.astro-qr { flex-shrink:0; }\n'
          + '.astro-qr img { width:110px; height:110px; display:block; }\n'
          + '.astro-info { flex:1; display:flex; flex-direction:column; gap:4px; }\n'
          + '.info-line { font-size:10.5px; color:#222; font-weight:500; line-height:1.45; }\n'
          + '.info-line strong { font-weight:800; }\n'
          + '.info-line.ed { font-size:13px; font-weight:700; color:#000; }\n'
          + '.info-line.mfg { font-size:10px; font-weight:600; color:#555; }\n'
          + '</style></head><body><div class="page-labels">' + labelsHtml + '</div></body></html>');
        printWindow.document.close();
        printWindow.onload = function () { setTimeout(function () { printWindow.print(); }, 500); };
        closePrintProdukModal();
      }, 300);
    });
  }

  // ── Builds one Astro-format label HTML ──
  // Layout matches the reference label image:
  // TOP:  [ASTRO LOGO] | [Product Name text]
  // BODY: [QR Code]    | [ExpDate / ProdBy / Barcode / MFG]
  function buildAstroLabelHtml(logoSrc, qrSrc, bcSrc, sku, productName, metaText, edDisplay, mfgDisplay) {
    // Logo: image if loaded, fallback to italic ASTRO text
    const logoHtml = logoSrc
      ? '<img src="' + logoSrc + '" alt="ASTRO">'
      : '<span class="brand-text">ASTRO</span>';
    // QR code only — no linear barcode
    const qrHtml = qrSrc
      ? '<img src="' + qrSrc + '" alt="QR">'
      : '<div style="width:110px;height:110px;border:1px solid #ccc;"></div>';
    const edHtml = edDisplay
      ? '<div class="info-line ed">ExpDate <strong>' + edDisplay + '</strong></div>'
      : '';
    const mfgHtml = mfgDisplay
      ? '<div class="info-line mfg">MFG ' + mfgDisplay + '</div>'
      : '';

    return '<div class="astro-label">'
      // ── HEADER: [Logo image] + [Product Name] ──
      + '<div class="astro-top">'
      + '<div class="astro-logo-cell">' + logoHtml + '</div>'
      + '<div class="astro-product-name">' + (productName || sku) + '</div>'
      + '</div>'
      // ── BODY: [QR Code only on left] + [Info text right] ──
      + '<div class="astro-body">'
      + '<div class="astro-qr">' + qrHtml + '</div>'
      + '<div class="astro-info">'
      + edHtml
      + '<div class="info-line">Prod By : <strong>null</strong></div>'
      + mfgHtml
      + '</div>'
      + '</div>'
      + '</div>';
  }

  // ══════════════════════════════════════════════
  //  QR ZOOM / LIGHTBOX MODAL
  // ══════════════════════════════════════════════

  window.openQrZoomModal = function (qrId, qrText, title, productName) {
    const modal = document.getElementById('qrZoomModal');
    const container = document.getElementById('qrZoomContainer');
    const titleEl = document.getElementById('qrZoomTitle');
    const subEl = document.getElementById('qrZoomSubtitle');
    const prodEl = document.getElementById('qrZoomProduct');
    if (!modal || !container) return;

    if (titleEl) titleEl.innerText = title ? `QR Code: ${title}` : 'QR Code Preview';
    if (subEl) subEl.innerText = qrText || '';
    if (prodEl) {
      if (productName) {
        prodEl.innerText = `📦 ${productName}`;
        prodEl.classList.remove('hidden');
      } else {
        prodEl.innerText = '';
        prodEl.classList.add('hidden');
      }
    }

    container.innerHTML = '';
    new QRCode(container, {
      text: qrText,
      width: 260,
      height: 260,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });

    modal.classList.remove('hidden');
  };

  window.closeQrZoomModal = function (e) {
    if (e && e.target && e.target.closest('.qr-zoom-card') && !e.target.classList.contains('btn-close-qr-zoom') && !e.target.classList.contains('btn-close-zoom-action')) {
      return;
    }
    const modal = document.getElementById('qrZoomModal');
    if (modal) modal.classList.add('hidden');
  };

  // ══════════════════════════════════════════════
  //  SEARCH HISTORY
  // ══════════════════════════════════════════════

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem('qrsloc_history') || '[]');
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem('qrsloc_history', JSON.stringify(history));
    } catch { }
  }

  function addToHistory(sku) {
    let history = getHistory();
    history = history.filter(h => h !== sku);
    history.unshift(sku);
    history = history.slice(0, MAX_HISTORY);
    saveHistory(history);
    renderHistory();
  }

  function renderHistory() {
    const history = getHistory();
    if (history.length === 0) {
      historySection.classList.add('hidden');
      return;
    }

    historySection.classList.remove('hidden');
    historyList.innerHTML = history
      .map(sku => `<button class="history-chip" onclick="useHistory('${escapeAttr(sku)}')">${escapeHtml(sku)}</button>`)
      .join('');
  }

  window.useHistory = function (sku) {
    hideDropdown();
    skuInput.value = sku;
    performSearch(sku);
  };

  // ══════════════════════════════════════════════
  //  UI HELPERS & EVENT LISTENERS
  // ══════════════════════════════════════════════

  function setStatus(state, text) {
    dataStatus.className = `data-status ${state}`;
    statusText.textContent = text;
  }

  function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.add('fade-out');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
    }, 450);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function compareSlocNatural(a, b) {
    const sA = String(a || '').trim();
    const sB = String(b || '').trim();
    if (!sA && !sB) return 0;
    if (!sA) return 1;
    if (!sB) return -1;
    return sA.localeCompare(sB, 'id', { numeric: true, sensitivity: 'base' });
  }

  function parseFlexibleDate(rawStr) {
    if (!rawStr) return null;
    const clean = String(rawStr).trim();
    if (!clean) return null;

    // 1. Pure digits (8 digits: DDMMYYYY or 6 digits: DDMMYY)
    const digitsOnly = clean.replace(/[^0-9]/g, '');
    if (/^\d{8}$/.test(digitsOnly)) {
      const day = parseInt(digitsOnly.substring(0, 2), 10);
      const month = parseInt(digitsOnly.substring(2, 4), 10) - 1;
      const year = parseInt(digitsOnly.substring(4, 8), 10);
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === month && year >= 1970 && year <= 2100) {
        return d;
      }
    }
    if (/^\d{6}$/.test(digitsOnly)) {
      const day = parseInt(digitsOnly.substring(0, 2), 10);
      const month = parseInt(digitsOnly.substring(2, 4), 10) - 1;
      let yr = parseInt(digitsOnly.substring(4, 6), 10);
      yr = yr < 50 ? 2000 + yr : 1900 + yr;
      const d = new Date(yr, month, day);
      if (!isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === month) {
        return d;
      }
    }

    // 2. Separated by -, /, ., or space
    const parts = clean.split(/[-/\.\s]+/);
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      let yr = parseInt(parts[2], 10);
      if (parts[2].length === 2) {
        yr = yr < 50 ? 2000 + yr : 1900 + yr;
      }
      if (!isNaN(day) && !isNaN(month) && !isNaN(yr)) {
        const d = new Date(yr, month, day);
        if (!isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === month) {
          return d;
        }
      }
    }

    return null;
  }

  function formatDateDash(d) {
    if (!d || isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // Print Produk Modal event wiring
  const closePrintProdukBtn = document.getElementById('closePrintProdukBtn');
  const executePrintProdukBtn = document.getElementById('executePrintProdukBtn');
  const printProdukBackdrop = document.getElementById('printProdukBackdrop');

  if (closePrintProdukBtn) closePrintProdukBtn.addEventListener('click', closePrintProdukModal);
  if (printProdukBackdrop) printProdukBackdrop.addEventListener('click', closePrintProdukModal);
  if (executePrintProdukBtn) executePrintProdukBtn.addEventListener('click', executePrintProduk);

  searchForm.addEventListener('submit', handleSearch);

  refreshBtn.addEventListener('click', function () {
    fetchSheetData(false);
  });

  tabBarcode.addEventListener('click', function () {
    switchMainMenu('barcode');
  });

  tabMsltc.addEventListener('click', function () {
    switchMainMenu('msltc');
  });

  const debouncedSearchSuggestions = debounce((val) => {
    const parts = val.split(';');
    const expDate = parts[1] ? parts[1].trim() : null;
    const suggestions = getSearchSuggestions(val);
    renderDropdown(suggestions, expDate);
  }, 150);

  skuInput.addEventListener('input', function () {
    const val = this.value.trim();
    submitBtn.disabled = !val;

    if (!val) {
      hideDropdown();
      resultSection.innerHTML = '';
      return;
    }

    debouncedSearchSuggestions(val);
  });

  skuInput.addEventListener('keydown', function (e) {
    const dropdown = document.getElementById('searchDropdown');
    const isDropdownOpen = dropdown && !dropdown.classList.contains('hidden');

    if (e.key === 'ArrowDown') {
      if (isDropdownOpen && currentSuggestions.length > 0) {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
        updateActiveDropdownItem();
      }
    } else if (e.key === 'ArrowUp') {
      if (isDropdownOpen && currentSuggestions.length > 0) {
        e.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        updateActiveDropdownItem();
      }
    } else if (e.key === 'Enter') {
      if (isDropdownOpen && activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex]) {
        e.preventDefault();
        selectSuggestionItem(activeSuggestionIndex);
      } else if (isDropdownOpen && currentSuggestions.length === 1) {
        e.preventDefault();
        selectSuggestionItem(0);
      } else if (isDropdownOpen && currentSuggestions.length > 1) {
        e.preventDefault();
        selectSuggestionItem(0);
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.input-with-scan')) {
      hideDropdown();
    }
  });

  // ══════════════════════════════════════════════
  //  CAMERA BARCODE & QR SCANNER (PRO ENGINE)
  // ══════════════════════════════════════════════

  const scanBtn = document.getElementById('scanBtn');
  const scannerModal = document.getElementById('scannerModal');
  const scannerBackdrop = document.getElementById('scannerBackdrop');
  const closeScannerBtn = document.getElementById('closeScannerBtn');

  let html5QrcodeScanner = null;
  let isScanning = false;
  let activeScanCallback = null;
  let currentVideoTrack = null;
  let isTorchOn = false;
  let availableRearCameras = [];
  let currentRearCameraIndex = 0;

  // ══════════════════════════════════════════════
  //  AUDIO & HAPTIC FEEDBACK ENGINE (PRO SOUNDS)
  // ══════════════════════════════════════════════
  let sharedAudioCtx = null;
  function getAudioContext() {
    if (!sharedAudioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        sharedAudioCtx = new AudioCtxClass();
      }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }

  // 1. Sukses Scan / Valid: Nada tinggi jernih (1200Hz, 120ms) + Vibrate pendek
  function playSuccessBeep() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (e) {}
      }
    } catch (e) {}
  }

  // 2. Warning Tone: 2x Nada sedang berurutan (850Hz) + Double Vibrate (Near Expiry / Sloc Missing)
  function playWarningBeep() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      [now, now + 0.11].forEach(time => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(850, time);
        gain.gain.setValueAtTime(0.28, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.08);
      });
      if (navigator.vibrate) {
        try { navigator.vibrate([50, 40, 50]); } catch (e) {}
      }
    } catch (e) {}
  }

  // 3. Error / Expired Buzzer: Nada rendah tegas (320Hz, 280ms) + Vibrate panjang
  function playErrorBuzzer() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      gain.gain.setValueAtTime(0.32, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.28);
      if (navigator.vibrate) {
        try { navigator.vibrate(260); } catch (e) {}
      }
    } catch (e) {}
  }

  // 4. Save Success Chime: Melodic 2-tone chime (880Hz -> 1320Hz)
  function playSaveSuccessChime() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const notes = [
        { f: 880, start: now, dur: 0.1 },
        { f: 1320, start: now + 0.1, dur: 0.2 }
      ];
      notes.forEach(n => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.f, n.start);
        gain.gain.setValueAtTime(0.25, n.start);
        gain.gain.exponentialRampToValueAtTime(0.0001, n.start + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(n.start);
        osc.stop(n.start + n.dur);
      });
      if (navigator.vibrate) {
        try { navigator.vibrate([40, 30, 80]); } catch (e) {}
      }
    } catch (e) {}
  }

  // Backward-compatible alias
  function playBeepSound() {
    playSuccessBeep();
  }

  window.applyScannerZoom = async function (zoomVal) {
    const zoomNum = parseFloat(zoomVal) || 1.0;

    // 1. Update active button UI immediately
    document.querySelectorAll('.scanner-zoom-btn').forEach(btn => {
      const bZoom = parseFloat(btn.getAttribute('data-zoom')) || 1.0;
      btn.classList.toggle('active', Math.abs(bZoom - zoomNum) < 0.05);
    });

    // 2. Optical Digital Smooth Video Zoom (Instant visual zoom on 100% of Android & iOS devices)
    const videoEl = document.querySelector('#qr-reader video');
    if (videoEl) {
      videoEl.style.transform = `scale(${zoomNum})`;
      videoEl.style.transformOrigin = 'center center';
    }

    // 3. Hardware Camera Zoom (if supported by device driver)
    if (currentVideoTrack) {
      try {
        const caps = currentVideoTrack.getCapabilities ? currentVideoTrack.getCapabilities() : {};
        if (caps.zoom) {
          const target = Math.max(caps.zoom.min, Math.min(zoomNum, caps.zoom.max));
          await currentVideoTrack.applyConstraints({ advanced: [{ zoom: target }] });
        }
      } catch (e) {
        console.warn('Hardware zoom not supported:', e);
      }
    }
  };

  window.toggleScannerTorch = async function () {
    if (!currentVideoTrack) return;
    try {
      const caps = currentVideoTrack.getCapabilities ? currentVideoTrack.getCapabilities() : {};
      if (caps.torch) {
        isTorchOn = !isTorchOn;
        await currentVideoTrack.applyConstraints({ advanced: [{ torch: isTorchOn }] });
        const torchBtn = document.getElementById('scannerTorchBtn');
        if (torchBtn) {
          torchBtn.classList.toggle('active', isTorchOn);
          torchBtn.textContent = isTorchOn ? '🔦 Senter ON' : '🔦 Senter';
        }
      } else {
        alert('Fitur senter/flashlight tidak didukung pada kamera ini.');
      }
    } catch (e) {
      console.warn('Torch error:', e);
    }
  };

  window.switchScannerCamera = async function () {
    if (availableRearCameras.length <= 1) {
      alert('Hanya 1 lensa kamera belakang yang terdeteksi.');
      return;
    }
    currentRearCameraIndex = (currentRearCameraIndex + 1) % availableRearCameras.length;
    const nextCamId = availableRearCameras[currentRearCameraIndex].id;

    if (html5QrcodeScanner && isScanning) {
      try {
        await html5QrcodeScanner.stop();
        html5QrcodeScanner.clear();
        await startScannerWithCameraId(nextCamId);
      } catch (e) {
        console.warn('Switch camera error:', e);
      }
    }
  };

  async function openUniversalScanner(onSuccess) {
    if (typeof Html5Qrcode === 'undefined') {
      alert('Kamera Scanner library gagal dimuat. Periksa koneksi internet Anda.');
      return;
    }

    if (isScanning) return;
    activeScanCallback = onSuccess;
    scannerModal.classList.remove('hidden');
    isScanning = true;
    isTorchOn = false;

    // Reset controls UI
    const torchBtn = document.getElementById('scannerTorchBtn');
    if (torchBtn) {
      torchBtn.classList.remove('active');
      torchBtn.textContent = '🔦 Senter';
    }

    try {
      // 1. Enumerate cameras and filter out 0.5x ultra-wide
      availableRearCameras = [];
      try {
        const cameras = await Html5Qrcode.getCameras();
        if (cameras && cameras.length > 0) {
          const scored = cameras.map(cam => {
            const label = (cam.label || '').toLowerCase();
            let score = 0;
            // Rear cameras
            if (label.includes('back') || label.includes('rear') || label.includes('environment')) score += 100;
            if (label.includes('0 (back)') || label.includes('camera2 0')) score += 40;
            if (label.includes('main') || label.includes('primary') || label.includes('standard') || label.includes('1x')) score += 80;
            // Heavily penalize ultra-wide / 0.5x
            if (label.includes('ultra') || label.includes('wide') || label.includes('0.5') || label.includes('0,5') || label.includes('uw') || label.includes('macro')) score -= 150;
            // Heavily penalize front/selfie
            if (label.includes('front') || label.includes('selfie') || label.includes('user')) score -= 300;
            return { cam, score };
          });
          scored.sort((a, b) => b.score - a.score);
          availableRearCameras = scored.filter(s => s.score > -200).map(s => s.cam);
        }
      } catch (enumErr) {
        console.warn('[Camera] Enumeration fallback:', enumErr);
      }

      let selectedCameraConstraint = { facingMode: { ideal: 'environment' } };
      if (availableRearCameras.length > 0) {
        selectedCameraConstraint = availableRearCameras[0].id;
        currentRearCameraIndex = 0;
      }

      await startScannerWithCameraId(selectedCameraConstraint);

    } catch (err) {
      console.error('Gagal membuka scanner kamera:', err);
      alert('Gagal mengakses kamera. Pastikan izin kamera telah diberikan di browser HP Anda.');
      closeUniversalScanner();
    }
  }

  async function startScannerWithCameraId(cameraIdConstraint) {
    if (!html5QrcodeScanner) {
      html5QrcodeScanner = new Html5Qrcode('qr-reader');
    }

    const config = {
      fps: 30,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const w = Math.min(viewfinderWidth - 20, 320);
        const h = Math.min(viewfinderHeight - 20, 200);
        return { width: Math.max(w, 220), height: Math.max(h, 140) };
      },
      aspectRatio: 1.0,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    await html5QrcodeScanner.start(
      cameraIdConstraint,
      config,
      (decodedText) => {
        playBeepSound();
        if (navigator.vibrate) {
          try { navigator.vibrate([40, 30, 40]); } catch (e) { }
        }
        const scannedVal = decodedText.trim();
        closeUniversalScanner();
        if (typeof activeScanCallback === 'function') {
          activeScanCallback(scannedVal);
        }
      },
      () => { /* Ignore frame scan noise */ }
    );

    // Post-start hardware tuning: force standard 1.0x - 1.25x zoom & continuous focus
    setTimeout(async () => {
      try {
        const videoEl = document.querySelector('#qr-reader video');
        if (videoEl && videoEl.srcObject) {
          const tracks = videoEl.srcObject.getVideoTracks();
          if (tracks.length > 0) {
            currentVideoTrack = tracks[0];
            const caps = currentVideoTrack.getCapabilities ? currentVideoTrack.getCapabilities() : {};

            // Fix 0.5x Ultra-wide: if min zoom < 1.0, force zoom to 1.0 or 1.25 for crisp barcode focus
            if (caps.zoom) {
              const minZ = caps.zoom.min || 1;
              const maxZ = caps.zoom.max || 1;
              let targetZoom = 1.0;
              if (minZ < 1.0) {
                targetZoom = Math.min(maxZ, Math.max(1.0, 1.25));
              } else {
                targetZoom = Math.max(minZ, Math.min(1.0, maxZ));
              }
              await currentVideoTrack.applyConstraints({ advanced: [{ zoom: targetZoom }] });
            }

            // Continuous auto-focus for sharp barcode reading
            if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
              await currentVideoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
          }
        }
      } catch (postErr) {
        console.warn('[Camera] Post-start track constraints:', postErr);
      }
    }, 450);
  }

  function closeUniversalScanner() {
    if (!isScanning) return;
    isScanning = false;
    scannerModal.classList.add('hidden');

    const videoEl = document.querySelector('#qr-reader video');
    if (videoEl) {
      videoEl.style.transform = 'scale(1)';
    }

    if (currentVideoTrack) {
      if (isTorchOn) {
        try { currentVideoTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) { }
      }
      currentVideoTrack = null;
    }
    isTorchOn = false;

    if (html5QrcodeScanner) {
      try {
        html5QrcodeScanner.stop().catch(() => { }).then(() => {
          try { html5QrcodeScanner.clear(); } catch (e) { }
          html5QrcodeScanner = null;
        });
      } catch (e) {
        html5QrcodeScanner = null;
      }
    }
  }

  // Bind Main Search Bar Scanner button
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      openUniversalScanner((decodedText) => {
        skuInput.value = decodedText;
        submitBtn.disabled = false;
        performSearch(decodedText);
      });
    });
  }

  // Bind DCC Screening Scan SKU button
  window.startDccCameraScan = function () {
    openUniversalScanner((decodedText) => {
      let raw = (decodedText || '').trim();
      let sku = raw;
      let scannedDate = null;
      if (raw.includes(';')) {
        const parts = raw.split(';');
        sku = parts[0].trim();
        if (parts[1]) {
          scannedDate = parseFlexibleDate(parts[1].trim());
        }
      }
      const skuInput = document.getElementById('dccSkuInput');
      if (skuInput) {
        skuInput.value = sku;
        lookupDccSku(sku);
      }
      if (scannedDate) {
        const expInput = document.getElementById('dccExpiredDate');
        if (expInput) {
          expInput.value = formatDateDash(scannedDate);
          if (dccFlatpickr) dccFlatpickr.setDate(scannedDate, false);
          calculateDccMsltcStatus();
        }
      }
      showDccToast('info', 'SKU Dipindai', `SKU: ${sku}${scannedDate ? ' (Exp: ' + formatDateDash(scannedDate) + ')' : ''}`);
    });
  };

  if (closeScannerBtn) {
    closeScannerBtn.addEventListener('click', closeUniversalScanner);
  }
  if (scannerBackdrop) {
    scannerBackdrop.addEventListener('click', closeUniversalScanner);
  }

  // ══════════════════════════════════════════════
  //  PWA & SERVICE WORKER INSTALLATION (ANDROID)
  // ══════════════════════════════════════════════

  let deferredPrompt = null;
  const pwaInstallBanner = document.getElementById('pwaInstallBanner');
  const pwaInstallBtn = document.getElementById('pwaInstallBtn');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('[PWA] Service Worker registered:', reg.scope))
        .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (pwaInstallBanner) {
      pwaInstallBanner.classList.remove('hidden');
    }
  });

  if (pwaInstallBtn) {
    pwaInstallBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      console.log('[PWA] User choice:', choice);
      deferredPrompt = null;
      if (pwaInstallBanner) {
        pwaInstallBanner.classList.add('hidden');
      }
    });
  }

  // ══════════════════════════════════════════════
  //  HOME MENU NAVIGATION
  // ══════════════════════════════════════════════

  window.openAppMenu = function (menu) {
    // Reset window & document scroll immediately to prevent sticking at bottom
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    // Clear background ticking clock timer when leaving barcode/MSLTC view
    if (menu !== 'barcode' && clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }

    if (menu === 'barcode') {
      document.getElementById('homeMenuSection').classList.add('hidden');
      document.getElementById('appWorkspace').classList.remove('hidden');
      document.getElementById('dccWorkspace').classList.add('hidden');
      document.getElementById('slipGajiWorkspace').classList.add('hidden');
      document.getElementById('mpScheduleWorkspace').classList.add('hidden');
      document.getElementById('backToMenuBtn').classList.remove('hidden');
    } else if (menu === 'dcc') {
      openDccLockModal();
    } else if (menu === 'ed_sweeper') {
      document.getElementById('homeMenuSection').classList.add('hidden');
      document.getElementById('appWorkspace').classList.add('hidden');
      document.getElementById('dccWorkspace').classList.add('hidden');
      const edsWs = document.getElementById('edSweeperWorkspace');
      if (edsWs) {
        edsWs.classList.remove('hidden');
        edsWs.scrollTop = 0;
      }
      document.getElementById('slipGajiWorkspace').classList.add('hidden');
      document.getElementById('mpScheduleWorkspace').classList.add('hidden');
      document.getElementById('backToMenuBtn').classList.remove('hidden');

      if (typeof switchEdsTab === 'function') switchEdsTab('main');
      if (typeof initEdsFlatpickr === 'function') initEdsFlatpickr();
      if (typeof fetchEdSweeperData === 'function') fetchEdSweeperData(true);
    } else if (menu === 'slip_gaji') {
      document.getElementById('homeMenuSection').classList.add('hidden');
      document.getElementById('appWorkspace').classList.add('hidden');
      document.getElementById('dccWorkspace').classList.add('hidden');
      const edsWs = document.getElementById('edSweeperWorkspace');
      if (edsWs) edsWs.classList.add('hidden');
      document.getElementById('slipGajiWorkspace').classList.remove('hidden');
      document.getElementById('mpScheduleWorkspace').classList.add('hidden');
      document.getElementById('backToMenuBtn').classList.remove('hidden');
      fetchSlipGajiData();
    } else if (menu === 'mp_schedule') {
      document.getElementById('homeMenuSection').classList.add('hidden');
      document.getElementById('appWorkspace').classList.add('hidden');
      document.getElementById('dccWorkspace').classList.add('hidden');
      const edsWs = document.getElementById('edSweeperWorkspace');
      if (edsWs) edsWs.classList.add('hidden');
      document.getElementById('slipGajiWorkspace').classList.add('hidden');
      document.getElementById('mpScheduleWorkspace').classList.remove('hidden');
      document.getElementById('backToMenuBtn').classList.remove('hidden');
      
      const mpsWs = document.getElementById('mpScheduleWorkspace');
      if (mpsWs) mpsWs.scrollTop = 0;
      window.closeMpScheduleDetail();
      switchMpsTab('manpower');
      fetchMpScheduleData();
    } else {
      alert('Fitur ini akan di-develop menyusul.');
    }
  };

  window.goBackToMenu = function () {
    // Clear ticking clock timer when returning to home
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }

    document.getElementById('homeMenuSection').classList.remove('hidden');
    document.getElementById('appWorkspace').classList.add('hidden');
    document.getElementById('dccWorkspace').classList.add('hidden');
    const edsWs = document.getElementById('edSweeperWorkspace');
    if (edsWs) edsWs.classList.add('hidden');
    document.getElementById('slipGajiWorkspace').classList.add('hidden');
    document.getElementById('mpScheduleWorkspace').classList.add('hidden');
    document.getElementById('backToMenuBtn').classList.add('hidden');

    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  // ── Android Hardware Back Button Handler ──
  window.handleAndroidBackPressed = function () {
    // -0.5. Close App Update modal if open (and not forceUpdate)
    const appUpdateModal = document.getElementById('appUpdateModal');
    if (appUpdateModal && !appUpdateModal.classList.contains('hidden')) {
      if (currentUpdateData && currentUpdateData.forceUpdate) {
        return true; // Block back button during force update
      }
      dismissAppUpdate();
      return true;
    }

    // -0.2. Close Photo Viewer modal if open
    const photoViewerModal = document.getElementById('dccPhotoViewerModal');
    if (photoViewerModal && !photoViewerModal.classList.contains('hidden')) {
      closePhotoViewerModal();
      return true;
    }

    // -0.15 Close EDS Setup Modal if open
    const edsSetupModal = document.getElementById('edsSetupModal');
    if (edsSetupModal && !edsSetupModal.classList.contains('hidden')) {
      if (typeof closeEdsSetupModal === 'function') closeEdsSetupModal();
      return true;
    }

    // -0.1. Close MSLTC Info modal if open
    const msltcInfoModal = document.getElementById('dccMsltcInfoModal');
    if (msltcInfoModal && !msltcInfoModal.classList.contains('hidden')) {
      closeMsltcInfoModal();
      return true;
    }

    // 0. Close DCC Lock modal if open
    const dccLockModal = document.getElementById('dccLockModal');
    if (dccLockModal && !dccLockModal.classList.contains('hidden')) {
      closeDccLockModal();
      return true;
    }

    // 1. Close scanner modal if open
    const scannerModal = document.getElementById('scannerModal');
    if (scannerModal && !scannerModal.classList.contains('hidden')) {
      closeUniversalScanner();
      return true;
    }

    // 2. Close print modal if open
    const printModal = document.getElementById('printProdukModal');
    if (printModal && !printModal.classList.contains('hidden')) {
      closePrintProdukModal();
      return true;
    }

    // 2.5 Close QR zoom modal if open
    const qrModal = document.getElementById('qrZoomModal');
    if (qrModal && !qrModal.classList.contains('hidden')) {
      closeQrZoomModal();
      return true;
    }

    // 2.6 Close MP Schedule detail if open
    const mpsDetail = document.getElementById('mpsDetailSection');
    if (mpsDetail && !mpsDetail.classList.contains('hidden')) {
      closeMpScheduleDetail();
      return true;
    }

    // 3. Khusus DCC Workspace: Jika sedang di tab Scan atau Report, kembali ke Main List!
    const dccWorkspace = document.getElementById('dccWorkspace');
    if (dccWorkspace && !dccWorkspace.classList.contains('hidden')) {
      if (currentDccTab !== 'main') {
        switchDccTab('main');
        return true;
      }
      goBackToMenu();
      return true;
    }

    // 3.5 Khusus Expired Date Sweeper Workspace: Jika sedang di tab Scan atau Report, kembali ke Main List!
    const edsWorkspace = document.getElementById('edSweeperWorkspace');
    if (edsWorkspace && !edsWorkspace.classList.contains('hidden')) {
      if (typeof currentEdsTab !== 'undefined' && currentEdsTab !== 'main') {
        if (typeof switchEdsTab === 'function') switchEdsTab('main');
        return true;
      }
      goBackToMenu();
      return true;
    }

    // 4. Return to Home Menu if currently inside a workspace
    const homeSection = document.getElementById('homeMenuSection');
    if (homeSection && homeSection.classList.contains('hidden')) {
      goBackToMenu();
      return true;
    }

    // 5. Currently on Home screen -> return false to show native Exit Dialog
    return false;
  };

  // ══════════════════════════════════════════════
  //  DCC SCREENING LOGIC (HIGH SPEED CACHING)
  // ══════════════════════════════════════════════

  const DCC_BASE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1ci0s4A65NAFv041_tS0ycTvvSPwzsVx1vALd0fbMRv0/gviz/tq?tqx=out:csv';
  const DCC_TASK1_URL = DCC_BASE_SHEET_URL + '&sheet=Task%201';
  const DCC_TASK2_URL = DCC_BASE_SHEET_URL + '&sheet=Task%202';
  const DCC_HASIL1_URL = DCC_BASE_SHEET_URL + '&sheet=Hasil%20Task%201';
  const DCC_HASIL2_URL = DCC_BASE_SHEET_URL + '&sheet=Hasil%20Task%202';
  const DCC_MAIN_SHEET_URL = DCC_BASE_SHEET_URL + '&sheet=Main%20List%20SKU';
  const DCC_MTG_SHEET_URL = DCC_BASE_SHEET_URL + '&sheet=MTG';
  const DCC_REPORT_URL = DCC_BASE_SHEET_URL + '&sheet=Report';
  const DCC_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzRrR_j-8bV29djmaLl85Uhe3KOHd8PsW_7GQWAYIIciNvDeDoYrTtPs0377F63stid0Q/exec';

  const DCC_MAIN_CACHE_KEY = 'DCC_MAIN_CACHE_MTG_V8';
  const DCC_REPORT_CACHE_KEY = 'DCC_REPORT_CACHE_MTG_V8';
  const DCC_SUBMITTED_CACHE_KEY = 'DCC_SUBMITTED_CACHE_MTG_V8';
  const DCC_PETUGAS2_KEY = 'DCC_PETUGAS2_NAME_V1';
  const DCC_PIN_KEY = 'DCC_AUTH_PIN_KEY_V1';
  const DCC_PIN_DEFAULT = '071107';

  let currentDccTab = 'main';
  let currentDccTaskFilter = 'all'; // 'all' | 'task1' | 'task2'
  let currentDccStatusFilter = 'all'; // 'all' | 'submitted' | 'pending'
  let selectedDccShift = 'pagi';   // 'pagi' | 'siang'
  let isDccFetching = false;
  let isDccReportFetching = false;

  let dccTask1List = [];
  let dccTask2List = [];
  let dccSubmittedTask1Set = new Set();
  let dccSubmittedTask2Set = new Set();
  let dccHasil1Rows = [];
  let dccHasil2Rows = [];

  // ══════════════════════════════════════════════
  //  DCC OFFLINE QUEUE & AUTO-SYNC ENGINE
  // ══════════════════════════════════════════════
  const OFFLINE_DB_NAME = 'DCC_OFFLINE_DB_MTG_V1';
  const OFFLINE_STORE_NAME = 'queue';
  let isSyncingOfflineQueue = false;

  function openOfflineDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(OFFLINE_DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
            db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function addToOfflineQueue(payload) {
    try {
      const db = await openOfflineDb();
      const itemToSave = { ...payload, queuedAt: Date.now() };
      if (!db) {
        const list = safeJsonParse(localStorage.getItem('DCC_OFFLINE_QUEUE_LOCAL'), []);
        itemToSave.id = Date.now();
        list.push(itemToSave);
        localStorage.setItem('DCC_OFFLINE_QUEUE_LOCAL', JSON.stringify(list));
        updateOfflineQueueBadge();
        return;
      }
      const tx = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(OFFLINE_STORE_NAME);
      store.add(itemToSave);
      tx.oncomplete = () => {
        updateOfflineQueueBadge();
      };
    } catch (e) {
      console.warn('Gagal menyimpan ke offline queue:', e);
    }
  }

  async function getOfflineQueueItems() {
    try {
      const db = await openOfflineDb();
      if (!db) {
        return safeJsonParse(localStorage.getItem('DCC_OFFLINE_QUEUE_LOCAL'), []);
      }
      return new Promise((resolve) => {
        const tx = db.transaction([OFFLINE_STORE_NAME], 'readonly');
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  async function removeOfflineQueueItem(id) {
    try {
      const db = await openOfflineDb();
      if (!db) {
        let list = safeJsonParse(localStorage.getItem('DCC_OFFLINE_QUEUE_LOCAL'), []);
        list = list.filter(i => i.id !== id);
        localStorage.setItem('DCC_OFFLINE_QUEUE_LOCAL', JSON.stringify(list));
        updateOfflineQueueBadge();
        return;
      }
      const tx = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
      tx.objectStore(OFFLINE_STORE_NAME).delete(id);
      tx.oncomplete = () => {
        updateOfflineQueueBadge();
      };
    } catch (e) {}
  }

  async function updateOfflineQueueBadge() {
    const items = await getOfflineQueueItems();
    const count = items.length;
    const badge = document.getElementById('dccOfflineQueueBadge');
    if (badge) {
      if (count > 0) {
        badge.classList.remove('hidden');
        badge.innerHTML = `⚡ <strong>${count}</strong> Data Offline (Sync)`;
        badge.title = `${count} data tersimpan di HP. Klik untuk kirim ke Google Sheet sekarang.`;
      } else {
        badge.classList.add('hidden');
        badge.innerHTML = '';
      }
    }
  }

  // Triggered automatically on 'online' or manually by tapping the badge
  window.syncDccOfflineQueue = async function (isManual = false) {
    if (isSyncingOfflineQueue) return;
    const items = await getOfflineQueueItems();
    if (items.length === 0) {
      if (isManual) {
        showDccToast('info', 'Semua Data Terkirim', 'Tidak ada data antrean offline yang tertunda.');
      }
      return;
    }

    if (!navigator.onLine) {
      if (isManual) {
        playWarningBeep();
        showDccToast('warning', 'Masih Offline', 'Koneksi internet belum tersedia. Data Anda tetap aman tersimpan.');
      }
      return;
    }

    isSyncingOfflineQueue = true;
    const badge = document.getElementById('dccOfflineQueueBadge');
    if (badge) badge.innerHTML = `🔄 Mengirim ${items.length} data...`;

    let successCount = 0;
    for (const item of items) {
      try {
        const payloadToSend = { ...item };
        delete payloadToSend.id;
        delete payloadToSend.queuedAt;

        await fetch(DCC_WEBAPP_URL, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payloadToSend)
        });

        await removeOfflineQueueItem(item.id);
        successCount++;
      } catch (err) {
        console.warn('Sync item failed:', err);
        break; // Pause if network drops mid-sync
      }
    }

    isSyncingOfflineQueue = false;
    await updateOfflineQueueBadge();

    if (successCount > 0) {
      playSaveSuccessChime();
      showDccToast('success', 'Auto-Sync Berhasil!', `${successCount} data screening offline berhasil dicatat ke Sheet MTG.`);
    }
  };

  // Auto-listen to connection restore & periodic check
  window.addEventListener('online', () => {
    console.log('[DCC] Sinyal internet terhubung kembali. Memulai auto-sync offline queue...');
    syncDccOfflineQueue();
  });
  setInterval(() => {
    if (navigator.onLine) {
      syncDccOfflineQueue();
    }
  }, 25000);

  // Initialize queue badge on startup
  setTimeout(updateOfflineQueueBadge, 1500);

  // ── Helper: Resolve SLOC from Master Rack & MSLTC ("Supersheet") ──
  function getSuperSheetSloc(sku) {
    if (!sku) return '';
    const cleanSku = String(sku).trim();

    // 1. Search in Master Rack dataMap
    if (dataMap) {
      if (dataMap.has(cleanSku)) {
        const items = dataMap.get(cleanSku);
        for (const it of items) {
          const s = (it.sloc || it.masterSloc || '').trim();
          if (s && s !== 'Belum Ada SLOC di Sistem' && s !== 'Belum ada SLOC') return s;
        }
      }
      const noZero = cleanSku.replace(/^0+/, '');
      if (noZero && noZero !== cleanSku && dataMap.has(noZero)) {
        const items = dataMap.get(noZero);
        for (const it of items) {
          const s = (it.sloc || it.masterSloc || '').trim();
          if (s && s !== 'Belum Ada SLOC di Sistem' && s !== 'Belum ada SLOC') return s;
        }
      }
    }

    // 2. Search in MSLTC msltcMap
    if (msltcMap) {
      if (msltcMap.has(cleanSku)) {
        const items = msltcMap.get(cleanSku);
        for (const it of items) {
          const r = (it.rackName || it.locationName || '').trim();
          if (r && r !== 'Belum Ada SLOC di Sistem' && r !== 'Belum ada SLOC') return r;
        }
      }
      const noZero = cleanSku.replace(/^0+/, '');
      if (noZero && noZero !== cleanSku && msltcMap.has(noZero)) {
        const items = msltcMap.get(noZero);
        for (const it of items) {
          const r = (it.rackName || it.locationName || '').trim();
          if (r && r !== 'Belum Ada SLOC di Sistem' && r !== 'Belum ada SLOC') return r;
        }
      }
    }

    return '';
  }

  function enrichDccItemWithSupersheet(item) {
    if (!item) return item;
    const cur = (item.slocExisting || '').trim();
    if (!cur || cur === 'Belum ada SLOC' || cur === 'Belum Ada SLOC di Sistem') {
      const superSloc = getSuperSheetSloc(item.sku);
      if (superSloc) {
        item.slocExisting = superSloc;
      }
    }
    return item;
  }

  function enrichAllDccListsWithSupersheet() {
    let updated = false;
    [dccTask1List, dccTask2List, dccMainListData].forEach(list => {
      if (!list || !Array.isArray(list)) return;
      list.forEach(item => {
        const oldSloc = item.slocExisting;
        enrichDccItemWithSupersheet(item);
        if (oldSloc !== item.slocExisting) updated = true;
      });
    });
    return updated;
  }

  window.setDccStatusFilter = function (status) {
    currentDccStatusFilter = status;
    document.querySelectorAll('.dcc-status-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-status') === status);
    });
    filterDccMainList();
  };

  function parseTaskSheetRows(csvText, defaultAssign, taskType) {
    const rows = parseCSV(csvText);
    if (!rows || rows.length <= 1) return [];

    const headers = rows[0].map(h => h.toLowerCase().trim());
    let skuIdx = headers.findIndex(h => (h === 'sku' || h === 'sku no' || h === 'sku number') && !h.includes('/'));
    if (skuIdx === -1) skuIdx = 1;
    const nameIdx = headers.findIndex(h => h === 'product name' || h.includes('product') || h.includes('nama'));
    const slocIdx = headers.findIndex(h => h.includes('lokasi') || h.includes('rack') || (h.includes('sloc') && !h.includes('/')));
    const stockIdx = headers.findIndex(h => h.includes('stock available') || h.includes('stock') || h.includes('stk'));

    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      let rawSku = skuIdx >= 0 ? (row[skuIdx] || '') : (row[1] || row[0] || '');
      let cleanSku = rawSku.includes('|') ? rawSku.split('|')[0].trim() : rawSku.trim();
      const name = nameIdx >= 0 ? (row[nameIdx] || '') : (row[2] || '');
      let sloc = slocIdx >= 0 ? (row[slocIdx] || '') : (row[3] || '');
      const stock = stockIdx >= 0 ? (row[stockIdx] || '') : (row[4] || '');

      if (!cleanSku) continue;

      let cleanSloc = sloc.trim();
      if (!cleanSloc || cleanSloc === 'Belum Ada SLOC di Sistem' || cleanSloc === 'Belum ada SLOC') {
        const superSloc = getSuperSheetSloc(cleanSku);
        if (superSloc) cleanSloc = superSloc;
      }

      list.push({
        sku: cleanSku,
        productName: name.trim(),
        slocExisting: cleanSloc,
        stock: stock.trim(),
        assign: defaultAssign,
        task: taskType
      });
    }
    return list;
  }

  function parseHasilSheetRows(csvText) {
    const rows = parseCSV(csvText);
    if (!rows || rows.length <= 1) return { skuSet: new Set(), rows: [] };

    const skuSet = new Set();
    const cleanRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const sku1 = (row[1] || '').trim().toLowerCase();
      const sku17 = (row[17] || '').trim().toLowerCase();
      const clean1 = sku1.includes('|') ? sku1.split('|')[0].trim() : sku1;
      const clean17 = sku17.includes('|') ? sku17.split('|')[0].trim() : sku17;
      const name = (row[2] || '').trim().toLowerCase();

      if (clean1) skuSet.add(clean1);
      if (clean17) skuSet.add(clean17);
      if (name) skuSet.add(name);

      cleanRows.push(row);
    }
    return { skuSet, rows: cleanRows };
  }

  // ── DCC Security Lock & Shift Selection ──
  window.openDccLockModal = function () {
    const modal = document.getElementById('dccLockModal');
    const pinInput = document.getElementById('dccPinInput');
    const pinError = document.getElementById('dccPinError');
    if (pinError) pinError.classList.add('hidden');
    if (pinInput) {
      pinInput.value = '';
      if (!pinInput.dataset.enterBound) {
        pinInput.dataset.enterBound = 'true';
        pinInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            verifyAndEnterDcc();
          }
        });
      }
      setTimeout(() => pinInput.focus(), 150);
    }


    // Otomatis tentukan shift default berdasarkan jam sistem
    const hr = new Date().getHours();
    if (hr >= 12) {
      selectDccShift('siang');
    } else {
      selectDccShift('pagi');
    }

    if (modal) modal.classList.remove('hidden');
  };

  window.closeDccLockModal = function (e) {
    if (e && e.target !== e.currentTarget && !e.target.classList.contains('dcc-lock-btn-cancel')) return;
    const modal = document.getElementById('dccLockModal');
    if (modal) modal.classList.add('hidden');
  };

  window.selectDccShift = function (shift) {
    selectedDccShift = shift;
    const cardPagi = document.getElementById('shiftCardPagi');
    const cardSiang = document.getElementById('shiftCardMalam');
    if (cardPagi) cardPagi.classList.toggle('selected', shift === 'pagi');
    if (cardSiang) cardSiang.classList.toggle('selected', shift === 'siang');
  };

  window.toggleDccPinVisibility = function () {
    const pinInput = document.getElementById('dccPinInput');
    const eyeBtn = document.getElementById('dccPinEyeBtn');
    if (!pinInput) return;
    if (pinInput.type === 'password') {
      pinInput.type = 'text';
      if (eyeBtn) eyeBtn.textContent = '🔒';
    } else {
      pinInput.type = 'password';
      if (eyeBtn) eyeBtn.textContent = '👁️';
    }
  };

  window.verifyAndEnterDcc = function () {
    const pinInput = document.getElementById('dccPinInput');
    const pinError = document.getElementById('dccPinError');
    const enteredPin = (pinInput ? pinInput.value : '').trim();

    try {
      localStorage.setItem(DCC_PIN_KEY, '071107');
    } catch (e) {}

    // PIN baru 071107
    if (enteredPin !== '071107') {
      if (pinError) {
        pinError.textContent = '❌ PIN salah! Silakan coba lagi.';
        pinError.classList.remove('hidden');
      }
      if (pinInput) {
        pinInput.focus();
        pinInput.classList.add('shake');
        setTimeout(() => pinInput.classList.remove('shake'), 400);
      }
      return;
    }

    if (pinError) pinError.classList.add('hidden');
    closeDccLockModal();

    // Buka DCC Workspace
    document.getElementById('homeMenuSection').classList.add('hidden');
    document.getElementById('appWorkspace').classList.add('hidden');
    document.getElementById('dccWorkspace').classList.remove('hidden');
    document.getElementById('slipGajiWorkspace').classList.add('hidden');
    document.getElementById('mpScheduleWorkspace').classList.add('hidden');
    document.getElementById('backToMenuBtn').classList.remove('hidden');

    applyDccShift(selectedDccShift);
    fetchDccMainList();
  };

  window.updateDccPicDisplay = function () {
    const iconEl = document.getElementById('dccActivePicIcon');
    const nameEl = document.getElementById('dccActivePicName');
    const tagEl = document.getElementById('dccActiveShiftTag');
    const isPagi = (selectedDccShift === 'pagi');
    const p2 = getDccPetugas2Name();

    if (isPagi) {
      if (iconEl) iconEl.textContent = '☀️';
      if (nameEl) nameEl.textContent = 'Bintang';
      if (tagEl) tagEl.textContent = 'Shift Pagi (Task 1)';
    } else {
      if (iconEl) iconEl.textContent = '🌤️';
      if (nameEl) nameEl.textContent = p2 || 'Belum Diset (Klik Ganti PIC)';
      if (tagEl) tagEl.textContent = 'Shift Siang (Task 2)';
    }
  };

  window.toggleDccCustomPicInput = function () {
    const group = document.getElementById('dccCustomInputByGroup');
    const input = document.getElementById('dccCustomInputByName');
    if (group) {
      const isHidden = group.classList.contains('hidden');
      if (isHidden) {
        group.classList.remove('hidden');
        if (input) {
          const currentP2 = getDccPetugas2Name();
          input.value = (selectedDccShift === 'pagi') ? 'Bintang' : currentP2;
          input.focus();
          input.select();
        }
      } else {
        group.classList.add('hidden');
      }
    }
  };

  window.applyDccShift = function (shift) {
    selectedDccShift = shift;
    const shiftBadge = document.getElementById('dccActiveShiftBadge');
    const reportShiftLabel = document.getElementById('dccReportShiftLabel');

    if (shift === 'pagi') {
      if (shiftBadge) {
        shiftBadge.innerHTML = '☀️ Shift Pagi';
        shiftBadge.className = 'dcc-shift-badge-btn pagi';
      }
      if (reportShiftLabel) reportShiftLabel.textContent = 'Shift Pagi (Task 1)';
      setDccTaskFilter('task1');
      updateDccPicDisplay();
      filterDccMainList();
      renderShiftSpecificReport();
      if (typeof showDccToast === 'function') {
        showDccToast('success', '☀️ Shift Pagi Aktif', `Menampilkan ${dccTask1List.length || 0} SKU Task 1`);
      }
    } else {
      const p2 = getDccPetugas2Name();
      if (shiftBadge) {
        shiftBadge.innerHTML = '🌤️ Shift Siang';
        shiftBadge.className = 'dcc-shift-badge-btn malam';
      }
      if (reportShiftLabel) reportShiftLabel.textContent = 'Shift Siang (Task 2)';
      setDccTaskFilter('task2');
      updateDccPicDisplay();
      filterDccMainList();
      renderShiftSpecificReport();
      if (typeof showDccToast === 'function') {
        const picMsg = p2 ? `PIC: ${p2}` : 'PIC belum diset';
        showDccToast('success', '🌤️ Shift Siang Aktif', `Menampilkan ${dccTask2List.length || 0} SKU Task 2 (${picMsg})`);
      }
    }
  };

  window.openDccShiftSelectorOnly = function () {
    // Quick toggle shift dari dalam DCC
    if (selectedDccShift === 'pagi') {
      applyDccShift('siang');
    } else {
      applyDccShift('pagi');
    }
  };

  function getDccPetugas2Name() {
    try {
      return (localStorage.getItem(DCC_PETUGAS2_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function setDccPetugas2Name(name) {
    try {
      localStorage.setItem(DCC_PETUGAS2_KEY, (name || '').trim());
    } catch (e) {}
    updateDccPetugas2Options();
    updateDccPicDisplay();
  }

  function updateDccPetugas2Options() {
    const p2 = getDccPetugas2Name();
    const labelTask2Btn = document.getElementById('labelTask2Btn');
    if (labelTask2Btn) {
      labelTask2Btn.textContent = p2 ? `👤 Task 2 (${p2})` : '👤 Task 2 (Siang)';
    }
  }

  function isItemTask1(item) {
    if (item.task === 'task1') return true;
    const a = (item.assign || '').toLowerCase().trim();
    return a.includes('bintang') || a === 'task 1' || a === 'task1';
  }

  function isItemTask2(item) {
    if (item.task === 'task2') return true;
    const a = (item.assign || '').toLowerCase().trim();
    if (!a) return false;
    return !a.includes('bintang') || a === 'task 2' || a === 'task2';
  }

  window.setDccTaskFilter = function (filterType) {
    currentDccTaskFilter = filterType;
    document.querySelectorAll('.dcc-task-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-task') === filterType);
    });
    filterDccMainList();
  };

  window.saveDccPetugas2Name = function () {
    const customInput = document.getElementById('dccCustomInputByName');
    const name = customInput ? customInput.value.trim() : '';
    if (!name) {
      showDccToast('warning', 'Nama Kosong', 'Silakan ketik nama petugas terlebih dahulu.');
      if (customInput) customInput.focus();
      return;
    }
    setDccPetugas2Name(name);
    updateDccPicDisplay();
    const customGroup = document.getElementById('dccCustomInputByGroup');
    if (customGroup) customGroup.classList.add('hidden');
    showDccToast('success', 'PIC Disimpan', `Petugas aktif: ${name}`);
    filterDccMainList();
  };

  // ── DCC Submitted SKU Set (to auto-hide submitted items) ──
  let dccSubmittedSkuSet = new Set();

  function getDccSubmittedCount(list) {
    if (!list || list.length === 0) return 0;
    let count = 0;
    for (const item of list) {
      const skuClean = (item.sku || '').trim().toLowerCase();
      const nameClean = (item.productName || '').trim().toLowerCase();
      if (dccSubmittedSkuSet.has(skuClean) || (nameClean && dccSubmittedSkuSet.has(nameClean))) {
        count++;
      }
    }
    return count;
  }

  window.refreshDccData = function () {
    if (currentDccTab === 'report') {
      fetchDccReport(true);
    } else {
      fetchDccMainList(true);
    }
  };

  window.switchDccTab = function (tabName) {
    currentDccTab = tabName;

    // Hide all tabs
    document.getElementById('dccTabMainList').classList.add('hidden');
    document.getElementById('dccTabScan').classList.add('hidden');
    document.getElementById('dccTabReport').classList.add('hidden');
    document.getElementById('dccTabMainList').classList.remove('active');
    document.getElementById('dccTabScan').classList.remove('active');
    document.getElementById('dccTabReport').classList.remove('active');

    // Remove active from nav items
    document.getElementById('navDccMain').classList.remove('active');
    document.getElementById('navDccScan').classList.remove('active');
    document.getElementById('navDccReport').classList.remove('active');

    // Show active tab
    if (tabName === 'main') {
      document.getElementById('dccTabMainList').classList.remove('hidden');
      document.getElementById('dccTabMainList').classList.add('active');
      document.getElementById('navDccMain').classList.add('active');
      fetchDccMainList(false);
    } else if (tabName === 'scan') {
      document.getElementById('dccTabScan').classList.remove('hidden');
      document.getElementById('dccTabScan').classList.add('active');
      document.getElementById('navDccScan').classList.add('active');
      initDccDatePicker();
    } else if (tabName === 'report') {
      document.getElementById('dccTabReport').classList.remove('hidden');
      document.getElementById('dccTabReport').classList.add('active');
      document.getElementById('navDccReport').classList.add('active');
      fetchDccReport(false);
    }
  };

  window.handleDccBackPressed = function () {
    if (currentDccTab !== 'main') {
      switchDccTab('main');
      return;
    }
    goBackToMenu();
  };

  window.handleDccCancelScan = function () {
    resetDccForm();
    switchDccTab('main');
  };

  // ── Fetch & Render Sheet Report (Instant Warm Cache) ──
  // ── Fetch & Render Shift-Specific Report ──
  window.fetchDccReport = async function (forceRefresh = false) {
    if (isDccReportFetching) return;
    isDccReportFetching = true;

    try {
      if (forceRefresh || (dccTask1List.length === 0 && dccTask2List.length === 0)) {
        await fetchDccMainList(forceRefresh);
      }
      renderShiftSpecificReport();
    } catch (e) {
      console.error('Fetch report error:', e);
    } finally {
      isDccReportFetching = false;
    }
  };

  function renderShiftSpecificReport() {
    const isPagi = selectedDccShift === 'pagi';
    const shiftTitle = isPagi ? 'Shift Pagi (Task 1)' : 'Shift Siang (Task 2)';
    const taskList = isPagi ? dccTask1List : dccTask2List;
    const submittedSet = isPagi ? dccSubmittedTask1Set : dccSubmittedTask2Set;
    const hasilRows = isPagi ? dccHasil1Rows : dccHasil2Rows;

    const reportShiftLabel = document.getElementById('dccReportShiftLabel');
    if (reportShiftLabel) reportShiftLabel.textContent = shiftTitle;

    // 1. Total SKU from task list
    const totalSku = taskList.length;

    // 2. Total QTY from sum of stock in task list
    let totalQty = 0;
    taskList.forEach(item => {
      totalQty += parseFloat(item.stock) || 0;
    });

    // 3. Counted SKUs: check how many items from taskList exist in submittedSet
    let skuCounted = 0;
    taskList.forEach(item => {
      const skuClean = (item.sku || '').trim().toLowerCase();
      const nameClean = (item.productName || '').trim().toLowerCase();
      if (submittedSet.has(skuClean) || (nameClean && submittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean)) {
        skuCounted++;
      }
    });

    const skuNotCounted = Math.max(0, totalSku - skuCounted);

    // 4. QTY Counted & QTY Sales & SLOC Match/Unmatch from hasilRows
    let qtyGood = 0;
    let qtyBad = 0;
    let qtySales = 0;
    let slocMatchCount = 0;
    let slocUnmatchCount = 0;

    hasilRows.forEach(row => {
      if (!row || row.length < 5) return;
      const matchVal = (row[4] || '').trim().toLowerCase();
      if (matchVal === 'match') slocMatchCount++;
      else if (matchVal === 'unmatch') slocUnmatchCount++;

      qtyGood += parseFloat(row[6]) || 0;
      qtyBad += parseFloat(row[7]) || 0;
      qtySales += parseFloat(row[8]) || 0;
    });

    const qtyCounted = qtyGood + qtyBad;
    const qtyNotCounted = totalQty - qtyCounted;

    const totalSubmissions = slocMatchCount + slocUnmatchCount;
    let slocMatchPct = '0,00%';
    let slocUnmatchPct = '0,00%';
    if (totalSubmissions > 0) {
      slocMatchPct = ((slocMatchCount / totalSubmissions) * 100).toFixed(2).replace('.', ',') + '%';
      slocUnmatchPct = ((slocUnmatchCount / totalSubmissions) * 100).toFixed(2).replace('.', ',') + '%';
    }

    let progressPct = '0,00%';
    if (totalSku > 0) {
      progressPct = ((skuCounted / totalSku) * 100).toFixed(2).replace('.', ',') + '%';
    }

    // Render into DOM elements
    const elTanggal = document.getElementById('dccReportTanggal');
    const elHub = document.getElementById('dccReportHub');
    const elProgress = document.getElementById('dccReportProgress');
    const elBarFill = document.getElementById('dccProgressBarFill');
    const elMatch = document.getElementById('dccReportSlocMatch');
    const elUnmatch = document.getElementById('dccReportSlocUnmatch');
    const elTotalSku = document.getElementById('dccReportTotalSku');
    const elTotalQty = document.getElementById('dccReportTotalQty');
    const elSkuCounted = document.getElementById('dccReportSkuCounted');
    const elSkuNotCounted = document.getElementById('dccReportSkuNotCounted');
    const elQtyCounted = document.getElementById('dccReportQtyCounted');
    const elQtyNotCounted = document.getElementById('dccReportQtyNotCounted');
    const elQtySales = document.getElementById('dccReportQtySales');
    const elFefo = document.getElementById('dccReportFefo');
    const tableBody = document.getElementById('dccReportTableBody');

    const nowStr = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    if (elTanggal) elTanggal.textContent = nowStr;
    if (elHub) elHub.textContent = 'MTG - Menteng';
    if (elProgress) elProgress.textContent = progressPct;
    if (elMatch) elMatch.textContent = slocMatchPct;
    if (elUnmatch) elUnmatch.textContent = slocUnmatchPct;
    if (elTotalSku) elTotalSku.textContent = String(totalSku);
    if (elTotalQty) elTotalQty.textContent = String(totalQty);
    if (elSkuCounted) elSkuCounted.textContent = String(skuCounted);
    if (elSkuNotCounted) elSkuNotCounted.textContent = String(skuNotCounted);
    if (elQtyCounted) elQtyCounted.textContent = String(qtyCounted);
    if (elQtyNotCounted) elQtyNotCounted.textContent = String(qtyNotCounted);
    if (elQtySales) elQtySales.textContent = String(qtySales);
    if (elFefo) elFefo.textContent = totalSubmissions > 0 ? '100%' : '-';

    if (elBarFill) {
      const numVal = parseFloat(progressPct.replace(',', '.').replace('%', '')) || 0;
      elBarFill.style.width = `${Math.min(100, Math.max(0, numVal))}%`;
    }

    // Build Detailed Table
    if (tableBody) {
      const metrics = [
        { label: 'Shift Kerja', val: shiftTitle },
        { label: 'Nama Hub', val: 'MTG - Menteng' },
        { label: 'Tanggal Screening', val: nowStr },
        { label: 'Total Target SKU', val: String(totalSku) },
        { label: 'Total Target QTY', val: String(totalQty) },
        { label: 'SKU Sudah Diinput (Counted)', val: String(skuCounted) },
        { label: 'SKU Belum Diinput (Not Counted)', val: String(skuNotCounted) },
        { label: 'QTY Fisik Good', val: String(qtyGood) },
        { label: 'QTY Fisik Bad', val: String(qtyBad) },
        { label: 'QTY Sales', val: String(qtySales) },
        { label: '% SLOC Match', val: slocMatchPct },
        { label: '% SLOC Unmatch', val: slocUnmatchPct },
        { label: '% Counting Progress', val: progressPct }
      ];

      tableBody.innerHTML = metrics.map(m => `
        <tr>
          <td style="font-weight: 500;">${escapeHtml(m.label)}</td>
          <td style="text-align: right; font-weight: 700; font-family: var(--font-mono); color: var(--accent-primary);">${escapeHtml(m.val)}</td>
        </tr>
      `).join('');
    }
  }

  // ── DCC Report Export & Share Engine ──
  window.exportDccReportToExcel = function () {
    const isPagi = selectedDccShift === 'pagi';
    const shiftLabel = isPagi ? 'Shift_Pagi' : 'Shift_Siang';
    const hasilRows = isPagi ? dccHasil1Rows : dccHasil2Rows;
    const taskList = isPagi ? dccTask1List : dccTask2List;

    const todayStr = new Date().toLocaleDateString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(/\//g, '-');
    const filename = `Laporan_DCC_${shiftLabel}_${todayStr}.csv`;

    const totalSku = taskList.length;
    let qtyGood = 0;
    let qtyBad = 0;
    let qtySales = 0;
    let slocMatchCount = 0;
    let slocUnmatchCount = 0;

    hasilRows.forEach(row => {
      if (!row || row.length < 5) return;
      const m = (row[4] || '').trim().toLowerCase();
      if (m === 'match') slocMatchCount++;
      else if (m === 'unmatch') slocUnmatchCount++;
      qtyGood += parseFloat(row[6]) || 0;
      qtyBad += parseFloat(row[7]) || 0;
      qtySales += parseFloat(row[8]) || 0;
    });

    const skuCounted = hasilRows.length;
    const totalSub = slocMatchCount + slocUnmatchCount;
    const matchPct = totalSub > 0 ? ((slocMatchCount / totalSub) * 100).toFixed(2) + '%' : '0%';
    const unmatchPct = totalSub > 0 ? ((slocUnmatchCount / totalSub) * 100).toFixed(2) + '%' : '0%';
    const progressPct = totalSku > 0 ? ((skuCounted / totalSku) * 100).toFixed(2) + '%' : '0%';

    // Build CSV with UTF-8 BOM for Microsoft Excel / Google Sheets
    let csvContent = '\uFEFF';
    csvContent += `LAPORAN DAILY CYCLE COUNT (DCC) - ASTRO HUB MTG\r\n`;
    csvContent += `Tanggal,${todayStr}\r\n`;
    csvContent += `Shift,${isPagi ? 'Shift Pagi (Task 1)' : 'Shift Siang (Task 2)'}\r\n`;
    csvContent += `Hub,MTG - Menteng\r\n`;
    csvContent += `Progress Counting,${skuCounted}/${totalSku} (${progressPct})\r\n`;
    csvContent += `SLOC Match,${matchPct}\r\n`;
    csvContent += `SLOC Unmatch,${unmatchPct}\r\n`;
    csvContent += `Total Fisik Good,${qtyGood}\r\n`;
    csvContent += `Total Fisik Bad,${qtyBad}\r\n`;
    csvContent += `Total Sales,${qtySales}\r\n\r\n`;

    csvContent += `No,Timestamp,SKU,Nama Produk,SLOC Existing,SLOC Actual,Reason SLOC,Expired Date,Fisik Good,Fisik Bad,Sales,Reason Bad,Evidance / Catatan,PIC Penginput,Label Produk,Label SLOC\r\n`;

    hasilRows.forEach((row, idx) => {
      const ts = `"${(row[0] || '').replace(/"/g, '""')}"`;
      const sku = `"${(row[1] || '').replace(/"/g, '""')}"`;
      const name = `"${(row[2] || '').replace(/"/g, '""')}"`;
      const slocEx = `"${(row[3] || '').replace(/"/g, '""')}"`;
      const slocAct = `"${(row[4] || '').replace(/"/g, '""')}"`;
      const expDate = `"${(row[5] || '').replace(/"/g, '""')}"`;
      const fGood = row[6] || 0;
      const fBad = row[7] || 0;
      const sales = row[8] || 0;
      const rSloc = `"${(row[9] || '').replace(/"/g, '""')}"`;
      const rBad = `"${(row[10] || '').replace(/"/g, '""')}"`;
      const ev = `"${(row[11] || '').replace(/"/g, '""')}"`;
      const pic = `"${(row[18] || '').replace(/"/g, '""')}"`;
      const lProd = `"${(row[19] || 'Ada').replace(/"/g, '""')}"`;
      const lSloc = `"${(row[20] || 'Ada').replace(/"/g, '""')}"`;

      csvContent += `${idx + 1},${ts},${sku},${name},${slocEx},${slocAct},${rSloc},${expDate},${fGood},${fBad},${sales},${rBad},${ev},${pic},${lProd},${lSloc}\r\n`;
    });

    playSuccessBeep();

    // Check Android Bridge for direct folder saving
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.saveFileToDownloads === 'function') {
      try {
        const base64 = btoa(unescape(encodeURIComponent(csvContent)));
        window.AndroidUpdateBridge.saveFileToDownloads(filename, base64, 'text/csv');
        showDccToast('success', 'Excel Terunduh', `File tersimpan di folder Download: ${filename}`);
        return;
      } catch (e) {
        console.warn('Bridge save error, fallback to blob:', e);
      }
    }

    // Web Blob Download fallback
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showDccToast('success', 'Excel Terunduh', `Laporan berhasil diunduh: ${filename}`);
  };

  window.shareDccReportWhatsApp = function () {
    const isPagi = selectedDccShift === 'pagi';
    const shiftLabel = isPagi ? 'Shift Pagi (Task 1)' : 'Shift Siang (Task 2)';
    const hasilRows = isPagi ? dccHasil1Rows : dccHasil2Rows;
    const taskList = isPagi ? dccTask1List : dccTask2List;

    const todayStr = new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const totalSku = taskList.length;
    let qtyGood = 0;
    let qtyBad = 0;
    let qtySales = 0;
    let slocMatchCount = 0;
    let slocUnmatchCount = 0;

    hasilRows.forEach(row => {
      if (!row || row.length < 5) return;
      const m = (row[4] || '').trim().toLowerCase();
      if (m === 'match') slocMatchCount++;
      else if (m === 'unmatch') slocUnmatchCount++;
      qtyGood += parseFloat(row[6]) || 0;
      qtyBad += parseFloat(row[7]) || 0;
      qtySales += parseFloat(row[8]) || 0;
    });

    const skuCounted = hasilRows.length;
    const totalSub = slocMatchCount + slocUnmatchCount;
    const matchPct = totalSub > 0 ? ((slocMatchCount / totalSub) * 100).toFixed(1) + '%' : '0%';
    const unmatchPct = totalSub > 0 ? ((slocUnmatchCount / totalSub) * 100).toFixed(1) + '%' : '0%';
    const progressPct = totalSku > 0 ? ((skuCounted / totalSku) * 100).toFixed(1) + '%' : '0%';

    const activePic = isPagi ? 'Bintang' : (getDccPetugas2Name() || 'Petugas Siang');

    const message = `📊 *RINGKASAN DAILY CYCLE COUNT (DCC)*\n` +
      `🏢 *Hub:* MTG - Menteng\n` +
      `📅 *Hari/Tanggal:* ${todayStr}\n` +
      `⏱️ *Shift:* ${shiftLabel}\n` +
      `👤 *PIC Penginput:* ${activePic}\n` +
      `-----------------------------------------\n` +
      `📈 *Progress Counting:* ${skuCounted} / ${totalSku} SKU (${progressPct})\n` +
      `✅ *SLOC Match:* ${slocMatchCount} SKU (${matchPct})\n` +
      `⚠️ *SLOC Unmatch:* ${slocUnmatchCount} SKU (${unmatchPct})\n` +
      `📦 *Total Fisik Good:* ${qtyGood} pcs\n` +
      `❌ *Total Fisik Bad:* ${qtyBad} pcs\n` +
      `🛒 *Total Sales:* ${qtySales} pcs\n` +
      `-----------------------------------------\n` +
      `_Dilaporkan otomatis via Super App MTG v1.0.6_`;

    playSuccessBeep();

    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.shareReport === 'function') {
      window.AndroidUpdateBridge.shareReport('Ringkasan DCC MTG', message);
      return;
    }

    if (navigator.share) {
      navigator.share({ title: 'Ringkasan DCC MTG', text: message }).catch(() => {});
    } else {
      const waUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
      window.open(waUrl, '_blank');
    }
  };

  // ── Universal Native Print Engine (Guarantees no blank PDF & responsive bridge) ──
  window.triggerNativePrint = function (printModeClass, documentTitle = 'SuperApp_MTG') {
    playSuccessBeep();
    document.body.classList.remove('print-mode-dcc', 'print-mode-mps-matrix', 'print-mode-mps-daily', 'print-mode-slip', 'print-mode-eds');
    if (printModeClass) {
      document.body.classList.add(printModeClass);
    }
    const oldTitle = document.title;
    if (documentTitle) {
      document.title = documentTitle;
    }

    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.printDocumentWithTitle === 'function') {
      window.AndroidUpdateBridge.printDocumentWithTitle(documentTitle);
    } else if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.printDocument === 'function') {
      window.AndroidUpdateBridge.printDocument();
    } else {
      window.print();
    }

    setTimeout(() => {
      document.title = oldTitle;
      document.body.classList.remove('print-mode-dcc', 'print-mode-mps-matrix', 'print-mode-mps-daily', 'print-mode-slip', 'print-mode-eds');
    }, 3000);
  };

  window.printDccReport = function () {
    const todayStr = new Date().toLocaleDateString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(/\//g, '-');
    triggerNativePrint('print-mode-dcc', `Laporan_DCC_${selectedDccShift}_${todayStr}`);
  };

  // ── DCC Main List Cache (for search & auto-fill) ──
  let dccMainListData = [];
  let currentDccSort = 'none';

  window.toggleDccSort = function (sortType) {
    const buttons = document.querySelectorAll('.dcc-sort-btn');

    if (currentDccSort === sortType) {
      currentDccSort = 'none';
      buttons.forEach(btn => btn.classList.remove('active'));
      filterDccMainList();
      return;
    }

    currentDccSort = sortType;
    buttons.forEach(btn => btn.classList.remove('active'));

    const activeBtnMap = {
      'name_asc': 'sortNameAsc',
      'name_desc': 'sortNameDesc',
      'sloc_asc': 'sortSlocAsc',
      'stock_desc': 'sortStockDesc'
    };

    const targetBtn = document.getElementById(activeBtnMap[sortType]);
    if (targetBtn) targetBtn.classList.add('active');

    filterDccMainList();
  };

  function sortDccList(list, sortType) {
    const sorted = [...list];
    if (sortType === 'name_asc') {
      sorted.sort((a, b) => (a.productName || '').localeCompare(b.productName || '', 'id', { sensitivity: 'base' }));
    } else if (sortType === 'name_desc') {
      sorted.sort((a, b) => (b.productName || '').localeCompare(a.productName || '', 'id', { sensitivity: 'base' }));
    } else if (sortType === 'sloc_asc' || sortType === 'none') {
      sorted.sort((a, b) => compareSlocNatural(a.slocExisting, b.slocExisting));
    } else if (sortType === 'stock_desc') {
      sorted.sort((a, b) => (parseFloat(b.stock) || 0) - (parseFloat(a.stock) || 0));
    }
    return sorted;
  }

  let currentDccRenderLimit = 50;
  let currentDccListCache = [];

  function renderDccMainListCards(list, totalUnfilteredCount, isLoadMore = false) {
    const container = document.getElementById('dccCardContainer');
    const badge = document.getElementById('dccListCountBadge');

    const isPagi = selectedDccShift === 'pagi';
    const activeShiftList = isPagi ? dccTask1List : dccTask2List;
    const activeSubmittedSet = isPagi ? dccSubmittedTask1Set : dccSubmittedTask2Set;
    const shiftLabel = isPagi ? 'Shift Pagi (Task 1)' : 'Shift Siang (Task 2)';

    let submittedCount = 0;
    activeShiftList.forEach(item => {
      const skuClean = (item.sku || '').trim().toLowerCase();
      const nameClean = (item.productName || '').trim().toLowerCase();
      if (activeSubmittedSet.has(skuClean) || (nameClean && activeSubmittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean)) {
        submittedCount++;
      }
    });

    if (badge) {
      const totalCount = activeShiftList.length || (totalUnfilteredCount !== undefined ? totalUnfilteredCount : (list ? list.length : 0));
      badge.textContent = `${submittedCount} Selesai / ${totalCount} SKU • ${shiftLabel}`;
    }

    if (!container) return;

    if (!isLoadMore) {
      currentDccListCache = list || [];
      currentDccRenderLimit = 50;
    }

    if (!currentDccListCache || currentDccListCache.length === 0) {
      let emptyMsg = `Tidak ada SKU untuk ${escapeHtml(shiftLabel)}.`;
      if (currentDccStatusFilter === 'submitted') {
        emptyMsg = `Belum ada SKU yang berstatus Sudah Diinput untuk ${escapeHtml(shiftLabel)}.`;
      } else if (currentDccStatusFilter === 'pending') {
        emptyMsg = `Semua SKU sudah selesai diinput untuk ${escapeHtml(shiftLabel)}! 🎉`;
      }
      container.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">${emptyMsg}</div>`;
      return;
    }

    const itemsToRender = currentDccListCache.slice(0, currentDccRenderLimit);
    const cardsHtml = itemsToRender.map(item => {
      const stockVal = item.stock !== undefined && item.stock !== '' ? item.stock : '0';
      const slocVal = item.slocExisting || 'Belum ada SLOC';
      const skuClean = (item.sku || '').trim().toLowerCase();
      const nameClean = (item.productName || '').trim().toLowerCase();
      const isSubmitted = activeSubmittedSet.has(skuClean) || (nameClean && activeSubmittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean);

      const statusBadge = isSubmitted
        ? `<span class="dcc-card-status-badge submitted">✅ Sudah Diinput</span>`
        : `<span class="dcc-card-status-badge pending">⏳ Belum Diinput</span>`;

      const isBintang = isItemTask1(item);
      const activeP2 = getDccPetugas2Name() || 'Petugas Siang';
      const displayAssign = isBintang ? 'Bintang' : (activeP2 || item.assign || 'Petugas Siang');
      const assignBadge = `<span class="dcc-card-assign-badge ${isBintang ? 'bintang' : 'petugas2'}" title="Ditugaskan ke: ${escapeAttr(displayAssign)}">
            👤 ${escapeHtml(displayAssign)}
           </span>`;

      return `
        <div class="dcc-sku-card ${isSubmitted ? 'is-submitted' : ''}">
          <div class="dcc-card-top">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="dcc-card-sku-badge">SKU: ${escapeHtml(item.sku)}</span>
              ${assignBadge}
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
              ${statusBadge}
              <span class="dcc-card-stock-badge">Stk: ${escapeHtml(stockVal)}</span>
            </div>
          </div>
          <div class="dcc-card-name">${escapeHtml(item.productName || 'Tanpa Nama Produk')}</div>
          <div class="dcc-card-bottom">
            <span class="dcc-card-sloc-pill" title="Lokasi Rack / SLOC">
              📍 ${escapeHtml(slocVal)}
            </span>
            <button type="button" class="dcc-card-action-btn" onclick="quickFillDccSku('${escapeAttr(item.sku)}', '${isBintang ? 'pagi' : 'siang'}')">
              <span>Input SKU</span> &rarr;
            </button>
          </div>
        </div>
      `;
    }).join('');

    const remaining = currentDccListCache.length - currentDccRenderLimit;
    let loadMoreBtn = '';
    if (remaining > 0) {
      const nextBatch = Math.min(remaining, 50);
      loadMoreBtn = `
        <div style="text-align:center; padding: 18px 0;" id="dccLoadMoreBox">
          <button type="button" class="btn-load-more" onclick="loadMoreDccCards()" style="background: rgba(6, 214, 160, 0.12); border: 1px solid rgba(6, 214, 160, 0.35); color: #06d6a0; padding: 12px 24px; border-radius: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; width: 100%; max-width: 340px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
            ⚡ Tampilkan ${nextBatch} SKU Lagi (${remaining} tersisa)
          </button>
        </div>
      `;
    }

    container.innerHTML = cardsHtml + loadMoreBtn;
  }

  window.loadMoreDccCards = function () {
    currentDccRenderLimit += 50;
    renderDccMainListCards(currentDccListCache, undefined, true);
  };

  window.quickFillDccSku = function (sku, assignOrShift) {
    if (!sku) return;
    switchDccTab('scan');
    const input = document.getElementById('dccSkuInput');
    if (input) {
      input.value = sku;
      lookupDccSku(sku);
    }

    // Auto-select shift based on assignment / task (NEVER overwrite device's saved PIC name!)
    if (assignOrShift) {
      const str = String(assignOrShift).toLowerCase();
      if (str.includes('bintang') || str.includes('pagi') || str === 'task 1' || str === 'task1') {
        selectedDccShift = 'pagi';
      } else {
        selectedDccShift = 'siang';
      }
      updateDccPicDisplay();
    }
  };

  window.fetchDccMainList = async function (forceRefresh = false) {
    const container = document.getElementById('dccCardContainer');
    updateDccPetugas2Options();

    // 1. Instant Cache Hit (0 ms)
    if (!forceRefresh && (dccTask1List.length > 0 || dccTask2List.length > 0)) {
      enrichAllDccListsWithSupersheet();
      filterDccMainList();
      renderShiftSpecificReport();
      return;
    }

    if (!forceRefresh && dccTask1List.length === 0 && dccTask2List.length === 0) {
      try {
        const cached = localStorage.getItem(DCC_MAIN_CACHE_KEY);
        if (cached) {
          const parsed = safeJsonParse(cached, null);
          if (parsed && (parsed.task1 || parsed.task2)) {
            dccTask1List = parsed.task1 || [];
            dccTask2List = parsed.task2 || [];
            dccSubmittedTask1Set = new Set(parsed.submitted1 || []);
            dccSubmittedTask2Set = new Set(parsed.submitted2 || []);
            dccHasil1Rows = parsed.hasil1 || [];
            dccHasil2Rows = parsed.hasil2 || [];
            dccMainListData = [...dccTask1List, ...dccTask2List];
            enrichAllDccListsWithSupersheet();
            filterDccMainList();
            renderShiftSpecificReport();
          }
        }
      } catch (e) {}
    }

    if (dccTask1List.length === 0 && dccTask2List.length === 0 && container) {
      container.innerHTML = '<div style="text-align:center; padding: 30px; color: var(--text-muted);">Memuat data Task 1 & Task 2 dari Google Sheets...</div>';
    }

    if (isDccFetching) return;
    isDccFetching = true;

    try {
      const p2 = getDccPetugas2Name() || 'Petugas Siang';

      // Fetch Task 1, Task 2, Hasil 1, Hasil 2, and MTG in parallel
      const [resTask1, resTask2, resHasil1, resHasil2, resMtg, resMain] = await Promise.all([
        fetch(DCC_TASK1_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_TASK2_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_HASIL1_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_HASIL2_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_MTG_SHEET_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_MAIN_SHEET_URL + '&_t=' + Date.now()).catch(() => null)
      ]);

      // 1. Parse Task 1
      if (resTask1 && resTask1.ok) {
        const textTask1 = await resTask1.text();
        dccTask1List = parseTaskSheetRows(textTask1, 'Bintang', 'task1');
      }

      // 2. Parse Task 2
      if (resTask2 && resTask2.ok) {
        const textTask2 = await resTask2.text();
        dccTask2List = parseTaskSheetRows(textTask2, p2, 'task2');
      }

      // 3. Parse Hasil Task 1
      if (resHasil1 && resHasil1.ok) {
        const textHasil1 = await resHasil1.text();
        const parsedHasil1 = parseHasilSheetRows(textHasil1);
        dccSubmittedTask1Set = parsedHasil1.skuSet;
        dccHasil1Rows = parsedHasil1.rows;
      }

      // 4. Parse Hasil Task 2
      if (resHasil2 && resHasil2.ok) {
        const textHasil2 = await resHasil2.text();
        const parsedHasil2 = parseHasilSheetRows(textHasil2);
        dccSubmittedTask2Set = parsedHasil2.skuSet;
        dccHasil2Rows = parsedHasil2.rows;
      }

      // 5. Parse MTG sheet for submitted items (cross-check)
      if (resMtg && resMtg.ok) {
        try {
          const csvMtg = await resMtg.text();
          const rowsMtg = parseCSV(csvMtg);
          for (let r = 1; r < rowsMtg.length; r++) {
            const row = rowsMtg[r];
            const timestamp = (row[0] || '').trim();
            if (timestamp) {
              let sku1 = (row[1] || '').trim().toLowerCase();
              if (sku1.includes('|')) sku1 = sku1.split('|')[0].trim();
              let sku17 = (row[17] || '').trim().toLowerCase();
              if (sku17.includes('|')) sku17 = sku17.split('|')[0].trim();
              const name2 = (row[2] || '').trim().toLowerCase();
              const inputBy = (row[18] || '').trim().toLowerCase();

              if (inputBy.includes('bintang')) {
                if (sku1) dccSubmittedTask1Set.add(sku1);
                if (sku17) dccSubmittedTask1Set.add(sku17);
                if (name2) dccSubmittedTask1Set.add(name2);
              } else if (inputBy) {
                if (sku1) dccSubmittedTask2Set.add(sku1);
                if (sku17) dccSubmittedTask2Set.add(sku17);
                if (name2) dccSubmittedTask2Set.add(name2);
              }

              if (sku1) dccSubmittedSkuSet.add(sku1);
              if (sku17) dccSubmittedSkuSet.add(sku17);
              if (name2) dccSubmittedSkuSet.add(name2);
            }
          }
        } catch (mtgErr) {
          console.warn('Could not parse MTG submitted rows:', mtgErr);
        }
      }

      // 6. Fallback to Main List SKU if Task 1 or Task 2 is empty
      if (dccTask1List.length === 0 && dccTask2List.length === 0 && resMain && resMain.ok) {
        const textMain = await resMain.text();
        const fallbackRows = parseCSV(textMain);
        if (fallbackRows && fallbackRows.length > 1) {
          const headers = fallbackRows[0].map(h => h.toLowerCase().trim());
          let skuIdx = headers.findIndex(h => (h === 'sku no' || h === 'sku number' || h === 'sku') && !h.includes('/'));
          if (skuIdx === -1) skuIdx = 1;
          const nameIdx = headers.findIndex(h => h === 'product name' || h.includes('product') || h.includes('nama'));
          const slocIdx = headers.findIndex(h => h.includes('lokasi') || h.includes('rack') || (h.includes('sloc') && !h.includes('/')));
          const stockIdx = headers.findIndex(h => h.includes('stock available') || h.includes('stock') || h.includes('stk'));
          const assignIdx = headers.findIndex(h => h.includes('assign') || h.includes('pic') || h.includes('petugas') || h.includes('task'));

          for (let i = 1; i < fallbackRows.length; i++) {
            const row = fallbackRows[i];
            let rawSku = skuIdx >= 0 ? (row[skuIdx] || '') : (row[1] || row[0] || '');
            let cleanSku = rawSku.includes('|') ? rawSku.split('|')[0].trim() : rawSku.trim();
            const name = nameIdx >= 0 ? (row[nameIdx] || '') : (row[2] || '');
            const sloc = slocIdx >= 0 ? (row[slocIdx] || '') : (row[3] || '');
            const stock = stockIdx >= 0 ? (row[stockIdx] || '') : (row[4] || '');
            let assign = assignIdx >= 0 ? (row[assignIdx] || '') : '';
            if (!cleanSku) continue;

            const item = {
              sku: cleanSku,
              productName: name.trim(),
              slocExisting: sloc.trim(),
              stock: stock.trim(),
              assign: assign.trim() || 'Bintang',
              task: isItemTask1({ assign }) ? 'task1' : 'task2'
            };

            if (item.task === 'task1') dccTask1List.push(item);
            else dccTask2List.push(item);
          }
        }
      }

      dccMainListData = [...dccTask1List, ...dccTask2List];
      enrichAllDccListsWithSupersheet();

      // Save cache
      try {
        localStorage.setItem(DCC_MAIN_CACHE_KEY, JSON.stringify({
          task1: dccTask1List,
          task2: dccTask2List,
          submitted1: Array.from(dccSubmittedTask1Set),
          submitted2: Array.from(dccSubmittedTask2Set),
          hasil1: dccHasil1Rows,
          hasil2: dccHasil2Rows
        }));
      } catch (e) {}

      filterDccMainList();
      renderShiftSpecificReport();

    } catch (e) {
      console.error('Fetch DCC Main error:', e);
      if (dccMainListData.length === 0 && container) {
        container.innerHTML = '<div style="text-align:center; padding: 30px; color: #ef4444;">Gagal memuat data. Periksa koneksi internet.</div>';
      }
    } finally {
      isDccFetching = false;
    }
  };

  // ── Filter & Search for Main List (Shift Isolated) ──
  window.filterDccMainList = function () {
    const input = document.getElementById('dccFilterInput');
    const clearBtn = document.getElementById('dccFilterClearBtn');
    const query = (input ? input.value : '').toLowerCase().trim();

    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !query);
    }

    // Select active shift list
    const isPagi = selectedDccShift === 'pagi';
    const baseList = isPagi ? dccTask1List : dccTask2List;
    const activeSubmittedSet = isPagi ? dccSubmittedTask1Set : dccSubmittedTask2Set;
    const shiftLabel = isPagi ? 'Shift Pagi (Task 1)' : 'Shift Siang (Task 2)';

    // Count submitted & pending for active shift
    let countSubmitted = 0;
    baseList.forEach(item => {
      const skuClean = (item.sku || '').trim().toLowerCase();
      const nameClean = (item.productName || '').trim().toLowerCase();
      if (activeSubmittedSet.has(skuClean) || (nameClean && activeSubmittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean)) {
        countSubmitted++;
      }
    });
    const countTotal = baseList.length;
    const countPending = Math.max(0, countTotal - countSubmitted);

    // Update filter status counter chips
    const elCountAll = document.getElementById('dccStatusCountAll');
    const elCountSubmitted = document.getElementById('dccStatusCountSubmitted');
    const elCountPending = document.getElementById('dccStatusCountPending');
    if (elCountAll) elCountAll.textContent = String(countTotal);
    if (elCountSubmitted) elCountSubmitted.textContent = String(countSubmitted);
    if (elCountPending) elCountPending.textContent = String(countPending);

    // Update Progress summary info
    const progressBadge = document.getElementById('dccListCountBadge');
    if (progressBadge) {
      const pct = countTotal > 0 ? ((countSubmitted / countTotal) * 100).toFixed(0) : 0;
      progressBadge.textContent = `${countSubmitted}/${countTotal} Selesai (${pct}%) • ${shiftLabel}`;
    }

    // Filter by Status (all | submitted | pending)
    let filtered = baseList;
    if (currentDccStatusFilter === 'submitted') {
      filtered = filtered.filter(item => {
        const skuClean = (item.sku || '').trim().toLowerCase();
        const nameClean = (item.productName || '').trim().toLowerCase();
        return activeSubmittedSet.has(skuClean) || (nameClean && activeSubmittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean);
      });
    } else if (currentDccStatusFilter === 'pending') {
      filtered = filtered.filter(item => {
        const skuClean = (item.sku || '').trim().toLowerCase();
        const nameClean = (item.productName || '').trim().toLowerCase();
        const isDone = activeSubmittedSet.has(skuClean) || (nameClean && activeSubmittedSet.has(nameClean)) || dccSubmittedSkuSet.has(skuClean);
        return !isDone;
      });
    }

    // Filter by Search Query
    if (query) {
      filtered = filtered.filter(item => {
        const matchSku = (item.sku || '').toLowerCase().includes(query);
        const matchName = (item.productName || '').toLowerCase().includes(query);
        const matchSloc = (item.slocExisting || '').toLowerCase().includes(query);
        const matchAssign = (item.assign || '').toLowerCase().includes(query);
        return matchSku || matchName || matchSloc || matchAssign;
      });
    }

    // Apply active sort
    const sortedResult = sortDccList(filtered, currentDccSort);
    renderDccMainListCards(sortedResult, baseList.length);
  };

  window.clearDccFilter = function () {
    const input = document.getElementById('dccFilterInput');
    if (input) {
      input.value = '';
      input.focus();
    }
    filterDccMainList();
  };

  // Setup search input listener with debounce
  (function initDccFilterListener() {
    const input = document.getElementById('dccFilterInput');
    if (input) {
      input.addEventListener('input', debounce(filterDccMainList, 160));
    }
    updateDccPetugas2Options();
  })();

  // Setup live PIC input sync on typing/enter
  (function initDccPicInputListener() {
    const input = document.getElementById('dccCustomInputByName');
    if (input) {
      input.addEventListener('input', function () {
        const val = input.value.trim();
        if (selectedDccShift !== 'pagi' && val) {
          try {
            localStorage.setItem(DCC_PETUGAS2_KEY, val);
          } catch (e) {}
          const nameEl = document.getElementById('dccActivePicName');
          if (nameEl) nameEl.textContent = val;
          updateDccPetugas2Options();
        }
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveDccPetugas2Name();
        }
      });
    }
  })();

  // ── Auto-lookup SKU when typing/scanning in Submit tab ──
  (function initDccSkuLookup() {
    const dccSkuInput = document.getElementById('dccSkuInput');
    if (dccSkuInput) {
      let dccLookupTimer = null;
      dccSkuInput.addEventListener('input', function () {
        clearTimeout(dccLookupTimer);
        dccLookupTimer = setTimeout(() => {
          lookupDccSku(dccSkuInput.value.trim());
        }, 300);
      });
      dccSkuInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(dccLookupTimer);
          lookupDccSku(dccSkuInput.value.trim());
        }
      });
    }
  })();

  function lookupDccSku(rawSku) {
    const namaInput = document.getElementById('dccNamaSku');
    const slocInput = document.getElementById('dccSlocExisting');
    const expInput = document.getElementById('dccExpiredDate');

    if (!rawSku) {
      namaInput.value = '';
      slocInput.value = '';
      calculateDccMsltcStatus();
      return;
    }

    let sku = rawSku.trim();
    if (sku.includes('|')) {
      sku = sku.split('|')[0].trim();
    }
    let scannedDate = null;
    if (sku.includes(';')) {
      const parts = sku.split(';');
      sku = parts[0].trim();
      if (parts[1]) {
        scannedDate = parseFlexibleDate(parts[1].trim());
      }
    }

    if (scannedDate && expInput) {
      expInput.value = formatDateDash(scannedDate);
      if (dccFlatpickr) dccFlatpickr.setDate(scannedDate, false);
    }

    // Search in dccMainListData cache
    const found = dccMainListData.find(item => item.sku === sku || item.sku.toLowerCase() === sku.toLowerCase());
    let resolvedSloc = (found && found.slocExisting && found.slocExisting !== 'Belum ada SLOC' && found.slocExisting !== 'Belum Ada SLOC di Sistem')
      ? found.slocExisting
      : '';
    if (!resolvedSloc) {
      resolvedSloc = getSuperSheetSloc(sku);
    }

    if (found) {
      namaInput.value = found.productName || '';
      slocInput.value = resolvedSloc || 'SKU Tidak ada di Hub';
      if ((!found.slocExisting || found.slocExisting === 'Belum ada SLOC') && resolvedSloc) {
        found.slocExisting = resolvedSloc;
      }
      playSuccessBeep();
    } else {
      // Fallback: search in master Barcode dataMap / MSLTC
      if (dataMap && dataMap.has(sku)) {
        const masterItem = dataMap.get(sku)[0];
        namaInput.value = masterItem.productName || '';
        slocInput.value = resolvedSloc || masterItem.sloc || 'SKU Tidak ada di Hub';
        playSuccessBeep();
      } else if (msltcMap && msltcMap.has(sku)) {
        const msltcItem = msltcMap.get(sku)[0];
        namaInput.value = msltcItem.productName || '';
        slocInput.value = resolvedSloc || msltcItem.rackName || 'SKU Tidak ada di Hub';
        playSuccessBeep();
      } else {
        namaInput.value = '';
        slocInput.value = resolvedSloc || 'SKU Tidak ada di Hub';
        if (resolvedSloc) {
          playSuccessBeep();
        } else {
          playWarningBeep();
        }
      }
    }

    // Trigger real-time MSLTC calculation for this SKU
    calculateDccMsltcStatus();
  }

  // ── MSLTC Lookup & Shelf-Life Calculator Engine ──
  function getMsltcInfo(sku) {
    if (!sku || !msltcMap) return null;
    let cleanSku = String(sku).trim();
    if (cleanSku.includes('|')) cleanSku = cleanSku.split('|')[0].trim();
    if (cleanSku.includes(';')) cleanSku = cleanSku.split(';')[0].trim();

    // 1. Direct match
    if (msltcMap.has(cleanSku)) {
      return msltcMap.get(cleanSku)[0];
    }
    // 2. Without leading zeros
    const noZero = cleanSku.replace(/^0+/, '');
    if (noZero && msltcMap.has(noZero)) {
      return msltcMap.get(noZero)[0];
    }
    // 3. Search all entries
    for (const [key, items] of msltcMap.entries()) {
      if (key.toLowerCase() === cleanSku.toLowerCase() || (noZero && key.toLowerCase() === noZero.toLowerCase())) {
        return items[0];
      }
    }
    return null;
  }

  function calculateDccMsltcStatus() {
    const skuInput = document.getElementById('dccSkuInput');
    const expInput = document.getElementById('dccExpiredDate');
    const badgeEl = document.getElementById('dccMsltcCalcBadge');
    if (!badgeEl) return;

    const rawSku = skuInput ? skuInput.value.trim() : '';
    const expVal = expInput ? expInput.value.trim() : '';

    if (!rawSku) {
      badgeEl.className = 'dcc-msltc-badge hidden';
      badgeEl.innerHTML = '';
      return;
    }

    const msltcInfo = getMsltcInfo(rawSku);
    const msltcDays = msltcInfo ? (msltcInfo.msltcDays || 0) : null;
    const prodType = msltcInfo ? (msltcInfo.type || '') : '';

    if (!expVal) {
      if (msltcDays !== null && msltcDays > 0) {
        badgeEl.className = 'dcc-msltc-badge info';
        badgeEl.innerHTML = `
          <div class="dcc-msltc-badge-header">
            <span class="dcc-msltc-badge-icon">ℹ️</span>
            <span class="dcc-msltc-badge-title">Standar MSLTC: <strong>${msltcDays} Hari</strong> ${prodType ? '(' + prodType + ')' : ''}</span>
          </div>
          <div class="dcc-msltc-badge-desc">Pilih tanggal expired untuk kalkulasi sisa umur simpan otomatis.</div>
        `;
      } else {
        badgeEl.className = 'dcc-msltc-badge hidden';
        badgeEl.innerHTML = '';
      }
      return;
    }

    const expDate = parseFlexibleDate(expVal);
    if (!expDate || isNaN(expDate.getTime())) {
      badgeEl.className = 'dcc-msltc-badge warning';
      badgeEl.innerHTML = `
        <div class="dcc-msltc-badge-header">
          <span class="dcc-msltc-badge-icon">⚠️</span>
          <span class="dcc-msltc-badge-title">Format Tanggal Belum Lengkap</span>
        </div>
      `;
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expZero = new Date(expDate);
    expZero.setHours(0, 0, 0, 0);

    const diffMs = expZero.getTime() - today.getTime();
    const remainingDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (remainingDays <= 0) {
      // EXPIRED
      playErrorBuzzer();
      badgeEl.className = 'dcc-msltc-badge danger';
      badgeEl.innerHTML = `
        <div class="dcc-msltc-badge-header">
          <span class="dcc-msltc-badge-icon">⛔</span>
          <span class="dcc-msltc-badge-title">BARANG EXPIRED / REJECT!</span>
        </div>
        <div class="dcc-msltc-badge-desc">
          Sisa Hari: <strong>${remainingDays === 0 ? 'Hari ini (0 hari)' : (Math.abs(remainingDays) + ' hari lewat')}</strong>
          ${msltcDays !== null ? ` | Batas MSLTC: ${msltcDays} hari` : ''}
          <div class="dcc-msltc-badge-alert">Produk ini sudah lewat tanggal kedaluwarsa dan dilarang display!</div>
        </div>
      `;
    } else if (msltcDays !== null && msltcDays > 0) {
      if (remainingDays < msltcDays) {
        // NEAR EXPIRY / BELOW MSLTC THRESHOLD
        playWarningBeep();
        const selisih = msltcDays - remainingDays;
        badgeEl.className = 'dcc-msltc-badge warning';
        badgeEl.innerHTML = `
          <div class="dcc-msltc-badge-header">
            <span class="dcc-msltc-badge-icon">⚠️</span>
            <span class="dcc-msltc-badge-title">NEAR EXPIRY (Di Bawah Batas MSLTC)</span>
          </div>
          <div class="dcc-msltc-badge-desc">
            Sisa Hari: <strong>${remainingDays} hari</strong> | Standar MSLTC: <strong>${msltcDays} hari</strong>
            <div class="dcc-msltc-badge-alert">Kurang <strong>${selisih} hari</strong> dari batas minimum shelf-life MTG.</div>
          </div>
        `;
      } else {
        // AMAN / CLEARANCE OK
        playSuccessBeep();
        const surplus = remainingDays - msltcDays;
        badgeEl.className = 'dcc-msltc-badge success';
        badgeEl.innerHTML = `
          <div class="dcc-msltc-badge-header">
            <span class="dcc-msltc-badge-icon">✅</span>
            <span class="dcc-msltc-badge-title">CLEARANCE AMAN (Memenuhi Standar)</span>
          </div>
          <div class="dcc-msltc-badge-desc">
            Sisa Hari: <strong>${remainingDays} hari</strong> | Standar MSLTC: <strong>${msltcDays} hari</strong>
            <span class="dcc-msltc-badge-surplus">(+${surplus} hari aman)</span>
          </div>
        `;
      }
    } else {
      // No specific MSLTC data
      badgeEl.className = 'dcc-msltc-badge neutral';
      badgeEl.innerHTML = `
        <div class="dcc-msltc-badge-header">
          <span class="dcc-msltc-badge-icon">📅</span>
          <span class="dcc-msltc-badge-title">Sisa Umur Simpan: <strong>${remainingDays} Hari</strong></span>
        </div>
        <div class="dcc-msltc-badge-desc">SKU ini tidak memiliki batas hari spesifik di tabel MSLTC.</div>
      `;
    }
  }

  window.openMsltcInfoModal = function () {
    const m = document.getElementById('dccMsltcInfoModal');
    if (m) m.classList.remove('hidden');
  };
  window.closeMsltcInfoModal = function () {
    const m = document.getElementById('dccMsltcInfoModal');
    if (m) m.classList.add('hidden');
  };

  // ── Toggle Buttons (Match/Unmatch) ──
  window.setDccToggle = function (groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const btns = group.querySelectorAll('.dcc-toggle-btn');
    btns.forEach(btn => {
      btn.classList.toggle('selected', btn.getAttribute('data-value') === value);
    });

    // Show/hide Reason SLOC when Unmatch is selected
    if (groupId === 'dccSlocActualGroup') {
      const reasonGroup = document.getElementById('dccReasonSlocGroup');
      if (value === 'Unmatch') {
        reasonGroup.classList.remove('hidden');
      } else {
        reasonGroup.classList.add('hidden');
      }
    }
  };

  // ── Multi-Photo Evidence Logic (Max 3 Photos) ──
  let dccPhotoList = [];
  const MAX_DCC_PHOTOS = 3;

  window.handleDccImageUpload = function (event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (dccPhotoList.length >= MAX_DCC_PHOTOS) {
      showDccToast('warning', 'Maksimal 3 Foto', 'Anda sudah mengambil 3 foto bukti. Hapus salah satu foto jika ingin mengganti.');
      event.target.value = '';
      return;
    }

    const file = files[0];
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to lightweight JPEG Base64 (~35-50KB)
        const photoBase64 = canvas.toDataURL('image/jpeg', 0.70);
        dccPhotoList.push(photoBase64);
        renderDccPhotoPreviews();
        playSuccessBeep();

        event.target.value = '';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.removeDccPhoto = function (index) {
    if (typeof index === 'number') {
      dccPhotoList.splice(index, 1);
    } else {
      dccPhotoList = [];
    }
    renderDccPhotoPreviews();
    const camInput = document.getElementById('dccCameraInput');
    const galInput = document.getElementById('dccGalleryInput');
    if (camInput) camInput.value = '';
    if (galInput) galInput.value = '';
  };

  function renderDccPhotoPreviews() {
    const container = document.getElementById('dccPhotoThumbnailsGrid');
    const countBadge = document.getElementById('dccPhotoCountBadge');
    const camBtn = document.getElementById('dccCameraBtn');
    const galBtn = document.getElementById('dccGalleryBtn');

    if (countBadge) {
      countBadge.textContent = `${dccPhotoList.length}/${MAX_DCC_PHOTOS} Foto`;
    }

    if (container) {
      if (dccPhotoList.length === 0) {
        container.innerHTML = '<div class="dcc-no-photo-hint">Belum ada foto bukti yang diambil</div>';
      } else {
        container.innerHTML = dccPhotoList.map((photo, idx) => `
          <div class="dcc-photo-thumb-card">
            <img src="${photo}" alt="Evidence ${idx + 1}" class="dcc-photo-thumb-img" onclick="openPhotoViewerModal('${photo}')" />
            <span class="dcc-photo-thumb-num">#${idx + 1}</span>
            <button type="button" class="dcc-photo-thumb-del" onclick="removeDccPhoto(${idx})" title="Hapus foto ini">✕</button>
          </div>
        `).join('');
      }
    }

    const isFull = dccPhotoList.length >= MAX_DCC_PHOTOS;
    if (camBtn) camBtn.disabled = isFull;
    if (galBtn) galBtn.disabled = isFull;
  }

  window.openPhotoViewerModal = function (src) {
    const modal = document.getElementById('dccPhotoViewerModal');
    const img = document.getElementById('dccPhotoViewerImg');
    if (modal && img) {
      img.src = src;
      modal.classList.remove('hidden');
    }
  };

  window.closePhotoViewerModal = function () {
    const modal = document.getElementById('dccPhotoViewerModal');
    const img = document.getElementById('dccPhotoViewerImg');
    if (modal) {
      modal.classList.add('hidden');
      if (img) img.src = '';
    }
  };

  // ── Number Adjusters ──
  window.adjustDccNumber = function (inputId, delta) {
    const input = document.getElementById(inputId);
    if (!input) return;
    let val = parseInt(input.value, 10) || 0;
    val = Math.max(0, val + delta);
    input.value = val;

    // Show/hide Reason Bad & Photo Evidence when Fisik Bad > 0
    if (inputId === 'dccFisikBad') {
      const reasonBadGroup = document.getElementById('dccReasonBadGroup');
      const photoGroup = document.getElementById('dccPhotoEvidenceGroup');
      if (val > 0) {
        if (reasonBadGroup) reasonBadGroup.classList.remove('hidden');
        if (photoGroup) photoGroup.classList.remove('hidden');
      } else {
        if (reasonBadGroup) reasonBadGroup.classList.add('hidden');
        if (photoGroup) photoGroup.classList.add('hidden');
        removeDccPhoto();
      }
    }
  };

  // ── DCC Floating Toast Notification ──
  let dccToastTimer = null;
  window.showDccToast = function (type, title, message) {
    const toast = document.getElementById('dccToast');
    const icon = document.getElementById('dccToastIcon');
    const titleEl = document.getElementById('dccToastTitle');
    const msgEl = document.getElementById('dccToastMessage');

    if (!toast) return;

    clearTimeout(dccToastTimer);

    toast.className = 'dcc-toast';
    if (type === 'error') {
      toast.classList.add('toast-error');
      icon.textContent = '❌';
    } else if (type === 'warning') {
      toast.classList.add('toast-warning');
      icon.textContent = '⚠️';
    } else {
      icon.textContent = '✅';
    }

    titleEl.textContent = title;
    msgEl.textContent = message;

    toast.classList.remove('hidden');

    dccToastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  };

  window.handleDccInputByChange = function (val) {
    const customGroup = document.getElementById('dccCustomInputByGroup');
    const customInput = document.getElementById('dccCustomInputByName');
    if (val === 'custom') {
      if (customGroup) customGroup.classList.remove('hidden');
      const p2 = getDccPetugas2Name();
      if (customInput) {
        if (p2 && !customInput.value) customInput.value = p2;
        customInput.focus();
      }
    } else if (val === 'petugas2') {
      const p2 = getDccPetugas2Name();
      if (!p2) {
        const sel = document.getElementById('dccInputBySelect');
        if (sel) sel.value = 'custom';
        if (customGroup) customGroup.classList.remove('hidden');
        if (customInput) customInput.focus();
      } else {
        if (customGroup) customGroup.classList.add('hidden');
      }
    } else {
      if (customGroup) customGroup.classList.add('hidden');
    }
  };

  // ── Reset Form ──
  window.resetDccForm = function () {
    document.getElementById('dccSkuInput').value = '';
    document.getElementById('dccNamaSku').value = '';
    document.getElementById('dccSlocExisting').value = '';
    document.getElementById('dccExpiredDate').value = '';
    document.getElementById('dccFisikGood').value = '0';
    document.getElementById('dccFisikBad').value = '0';
    document.getElementById('dccSales').value = '0';
    document.getElementById('dccReasonSloc').value = '';
    document.getElementById('dccReasonBad').value = '';
    document.getElementById('dccEvidance').value = '';

    // Keep the active PIC selected and refreshed
    const customGroup = document.getElementById('dccCustomInputByGroup');
    if (customGroup) customGroup.classList.add('hidden');
    updateDccPicDisplay();

    // Remove photo
    removeDccPhoto();

    // Reset MSLTC badge
    const msltcBadge = document.getElementById('dccMsltcCalcBadge');
    if (msltcBadge) {
      msltcBadge.className = 'dcc-msltc-badge hidden';
      msltcBadge.innerHTML = '';
    }

    // Reset toggles
    const slocGroup = document.getElementById('dccSlocActualGroup');
    if (slocGroup) {
      slocGroup.querySelectorAll('.dcc-toggle-btn').forEach(b => b.classList.remove('selected'));
    }

    // Reset label toggles to default "Ada"
    setDccToggle('dccLabelProductGroup', 'Ada');
    setDccToggle('dccLabelSlocGroup', 'Ada');

    // Hide conditional fields
    const reasonSloc = document.getElementById('dccReasonSlocGroup');
    const reasonBad = document.getElementById('dccReasonBadGroup');
    const photoGroup = document.getElementById('dccPhotoEvidenceGroup');
    if (reasonSloc) reasonSloc.classList.add('hidden');
    if (reasonBad) reasonBad.classList.add('hidden');
    if (photoGroup) photoGroup.classList.add('hidden');

    if (dccFlatpickr) dccFlatpickr.clear();
  };

  // ── Flatpickr for Expired Date ──
  let dccFlatpickr = null;
  function initDccDatePicker() {
    if (dccFlatpickr) return;
    const el = document.getElementById('dccExpiredDate');
    if (!el) return;
    try {
      dccFlatpickr = flatpickr(el, {
        dateFormat: 'd-m-Y',
        locale: typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.id ? 'id' : 'default',
        disableMobile: true,
        allowInput: true,
        onChange: function () {
          calculateDccMsltcStatus();
        }
      });

      const handleDccManualInput = () => {
        const raw = el.value.trim();
        if (!raw) {
          calculateDccMsltcStatus();
          return;
        }
        const parsed = parseFlexibleDate(raw);
        if (parsed && !isNaN(parsed.getTime())) {
          if (dccFlatpickr) dccFlatpickr.setDate(parsed, false);
          calculateDccMsltcStatus();
        }
      };

      const commitDccManualInput = () => {
        const raw = el.value.trim();
        if (!raw) {
          calculateDccMsltcStatus();
          return;
        }
        const parsed = parseFlexibleDate(raw);
        if (parsed && !isNaN(parsed.getTime())) {
          el.value = formatDateDash(parsed);
          if (dccFlatpickr) {
            dccFlatpickr.setDate(parsed, false);
            dccFlatpickr.close();
          }
          calculateDccMsltcStatus();
        }
        el.blur();
      };

      el.addEventListener('input', handleDccManualInput);
      el.addEventListener('change', commitDccManualInput);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitDccManualInput();
        }
      });
    } catch (e) {
      console.warn('DCC Flatpickr init failed:', e);
    }
  }

  // ── Submit to MTG Sheet (With Offline Queue Fallback & Multi-Photo) ──
  window.submitDccData = async function () {
    const btn = document.getElementById('dccSubmitBtn');

    let skuNo = document.getElementById('dccSkuInput').value.trim();
    if (skuNo.includes('|')) {
      skuNo = skuNo.split('|')[0].trim();
    }
    const namaSku = document.getElementById('dccNamaSku').value.trim();
    const slocExisting = document.getElementById('dccSlocExisting').value.trim();

    // Get SLOC Actual toggle value
    const slocActualBtn = document.querySelector('#dccSlocActualGroup .dcc-toggle-btn.selected');
    const slocActual = slocActualBtn ? slocActualBtn.getAttribute('data-value') : '';

    const expiredDate = document.getElementById('dccExpiredDate').value.trim();
    const fisikGood = document.getElementById('dccFisikGood').value.trim() || '0';
    const fisikBad = document.getElementById('dccFisikBad').value.trim() || '0';
    const sales = document.getElementById('dccSales').value.trim() || '0';
    const reasonSloc = document.getElementById('dccReasonSloc').value.trim();
    const evidance = document.getElementById('dccEvidance').value.trim();

    // Guaranteed bulletproof PIC determination
    let inputByVal = '';
    if (selectedDccShift === 'pagi') {
      inputByVal = 'Bintang';
    } else {
      const customPicEl = document.getElementById('dccCustomInputByName');
      const customPicTyped = customPicEl ? customPicEl.value.trim() : '';
      if (customPicTyped) {
        setDccPetugas2Name(customPicTyped);
        inputByVal = customPicTyped;
      } else {
        inputByVal = getDccPetugas2Name();
      }
    }

    // Strict PIC validation for Shift Siang: require PIC name
    if (!inputByVal) {
      playWarningBeep();
      showDccToast('warning', 'PIC Wajib Diisi', 'Silakan masukkan nama PIC penginput untuk Shift Siang.');
      toggleDccCustomPicInput();
      return;
    }

    // Reason Bad validation with strict select dropdown
    const reasonBadSelect = document.getElementById('dccReasonBad');
    const reasonBad = reasonBadSelect ? reasonBadSelect.value.trim() : '';

    // Get Label Product & Label Sloc toggles
    const labelProductBtn = document.querySelector('#dccLabelProductGroup .dcc-toggle-btn.selected');
    const labelProduct = labelProductBtn ? labelProductBtn.getAttribute('data-value') : 'Ada';

    const labelSlocBtn = document.querySelector('#dccLabelSlocGroup .dcc-toggle-btn.selected');
    const labelSloc = labelSlocBtn ? labelSlocBtn.getAttribute('data-value') : 'Ada';

    // ── Strict Form Validation ──
    if (!skuNo) {
      playWarningBeep();
      showDccToast('warning', 'SKU Wajib Diisi', 'Silakan ketik atau scan nomor SKU produk.');
      document.getElementById('dccSkuInput').focus();
      return;
    }

    if (!namaSku) {
      playErrorBuzzer();
      showDccToast('error', 'SKU Tidak Valid', 'Nomor SKU tidak terdaftar dalam database atau belum selesai dimuat.');
      return;
    }

    if (!slocActual) {
      playWarningBeep();
      showDccToast('warning', 'SLOC Actual Belum Dipilih', 'Pilih Match jika lokasi sesuai atau Unmatch jika berbeda.');
      return;
    }

    if (!expiredDate) {
      playWarningBeep();
      showDccToast('warning', 'Expired Date Wajib Diisi', 'Silakan pilih tanggal expired produk pada kalender.');
      document.getElementById('dccExpiredDate').focus();
      return;
    }

    if (slocActual === 'Unmatch' && !reasonSloc) {
      playWarningBeep();
      showDccToast('warning', 'Reason SLOC Wajib Diisi', 'Karena SLOC Unmatch, mohon masukkan alasan pada kolom Reason SLOC.');
      document.getElementById('dccReasonSloc').focus();
      return;
    }

    const badCount = parseInt(fisikBad, 10) || 0;
    if (badCount > 0) {
      if (!reasonBad) {
        playWarningBeep();
        showDccToast('warning', 'Pilih Reason Bad', 'Karena ada barang Fisik Bad, mohon pilih alasan kerusakan pada dropdown.');
        if (reasonBadSelect) reasonBadSelect.focus();
        return;
      }
      if (dccPhotoList.length === 0) {
        playWarningBeep();
        showDccToast('warning', 'Foto Evidence Wajib Diambil', 'Karena ada barang Fisik Bad, wajib foto bukti fisik barang rusak.');
        return;
      }
    }

    // Safe Reason SLOC & Evidance mapping
    let safeReasonSloc = '';
    let finalEvidance = evidance;
    if (slocActual === 'Unmatch') {
      safeReasonSloc = 'Unmatch';
      if (reasonSloc) {
        finalEvidance = finalEvidance ? `${finalEvidance} | Alasan SLOC: ${reasonSloc}` : `Alasan SLOC: ${reasonSloc}`;
      }
    }

    const timestamp = new Date().toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const payload = {
      timestamp: timestamp,
      skuNumber: skuNo,
      sku: skuNo,
      skuNo: skuNo,
      namaSku: namaSku,
      slocExisting: slocExisting,
      slocActual: slocActual,
      expiredDate: expiredDate,
      fisikGood: fisikGood,
      fisikBad: fisikBad,
      sales: sales,
      reasonSloc: safeReasonSloc,
      reasonBad: reasonBad,
      evidance: finalEvidance,
      inputBy: inputByVal,
      input_by: inputByVal,
      pic: inputByVal,
      namaPic: inputByVal,
      penginput: inputByVal,
      grupS: inputByVal,
      "Input by": inputByVal,
      shift: selectedDccShift === 'pagi' ? 'Task 1' : 'Task 2',
      task: selectedDccShift === 'pagi' ? 'task1' : 'task2',
      labelProduct: labelProduct,
      labelSloc: labelSloc,
      imageBase64: dccPhotoList[0] || '',
      imageBase64_2: dccPhotoList[1] || '',
      imageBase64_3: dccPhotoList[2] || '',
      photoCount: dccPhotoList.length
    };

    btn.disabled = true;
    btn.textContent = 'Menyimpan...';

    // Helper: update local table records & sets
    const updateLocalState = () => {
      if (selectedDccShift === 'pagi') {
        dccSubmittedTask1Set.add(skuNo.toLowerCase());
        if (namaSku) dccSubmittedTask1Set.add(namaSku.toLowerCase());
        dccHasil1Rows.push([timestamp, skuNo, namaSku, slocExisting, slocActual, expiredDate, fisikGood, fisikBad, sales, safeReasonSloc, reasonBad, finalEvidance, '', '', '', '', '', skuNo, inputByVal, labelProduct, labelSloc]);
      } else {
        dccSubmittedTask2Set.add(skuNo.toLowerCase());
        if (namaSku) dccSubmittedTask2Set.add(namaSku.toLowerCase());
        dccHasil2Rows.push([timestamp, skuNo, namaSku, slocExisting, slocActual, expiredDate, fisikGood, fisikBad, sales, safeReasonSloc, reasonBad, finalEvidance, '', '', '', '', '', skuNo, inputByVal, labelProduct, labelSloc]);
      }
      dccSubmittedSkuSet.add(skuNo.toLowerCase());
      if (namaSku) dccSubmittedSkuSet.add(namaSku.toLowerCase());

      try {
        localStorage.setItem(DCC_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(dccSubmittedSkuSet)));
      } catch (e) { }

      filterDccMainList();
      renderShiftSpecificReport();
    };

    // If completely offline right now, store directly into IndexedDB queue
    if (!navigator.onLine) {
      await addToOfflineQueue(payload);
      updateLocalState();
      playSaveSuccessChime();
      showDccToast('info', 'Disimpan Offline (Antrean)', `SKU ${skuNo} berhasil disimpan di HP. Otomatis dikirim begitu sinyal kembali.`);
      resetDccForm();
      btn.disabled = false;
      btn.textContent = 'Save';
      return;
    }

    try {
      // Send as POST payload
      await fetch(DCC_WEBAPP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      updateLocalState();
      playSaveSuccessChime();
      showDccToast('success', 'Data Berhasil Disimpan!', `SKU ${skuNo} (${namaSku}) oleh ${inputByVal} telah dicatat ke sheet MTG.`);
      resetDccForm();

    } catch (e) {
      console.warn('POST failed, storing in offline queue...', e);
      await addToOfflineQueue(payload);
      updateLocalState();
      playSaveSuccessChime();
      showDccToast('info', 'Tersimpan Offline (Sinyal Lemah)', `Koneksi tidak stabil. Data SKU ${skuNo} diamankan di memori HP dan akan otomatis dikirim ulang.`);
      resetDccForm();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  };

  // ══════════════════════════════════════════════
  //  SLIP GAJI MANPOWER LOGIC
  // ══════════════════════════════════════════════

  const SLIP_GAJI_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1UjL8SxYOd98nrgh7FZ5XkyQTA322k6E3A9wKFUa67iA/gviz/tq?tqx=out:csv&gid=65153336';
  const SLIP_GAJI_CACHE_KEY = 'SLIP_GAJI_CACHE_MTG_V1';

  let slipGajiList = [];
  let currentActiveMpId = null;
  let isSlipGajiFetching = false;

  function formatJoinDate(val) {
    if (!val || val === '-' || val === '') return '-';
    // If it's a numeric timestamp (epoch ms)
    const num = Number(val);
    if (!isNaN(num) && num > 10000000000) {
      const d = new Date(num);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
      }
    }
    // Try standard date parsing
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    return String(val);
  }

  window.fetchSlipGajiData = async function (forceRefresh = false) {
    // 1. Instant Memory Cache Hit (0 ms)
    if (!forceRefresh && slipGajiList.length > 0) {
      filterSlipGajiList();
      return;
    }

    const cardContainer = document.getElementById('sgCardContainer');
    const refreshBtn = document.querySelector('.sg-refresh-btn');

    // 2. Instant LocalStorage Warm Cache Hit (0 ms)
    if (!forceRefresh && slipGajiList.length === 0) {
      try {
        const cached = localStorage.getItem(SLIP_GAJI_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            slipGajiList = parsed;
            filterSlipGajiList();
            updateSlipGajiMeta(slipGajiList.length, 'Cached');
          }
        }
      } catch (e) {
        console.warn('Failed to load Slip Gaji cache:', e);
      }
    }

    if (slipGajiList.length === 0 && cardContainer) {
      cardContainer.innerHTML = `
        <div class="sg-loading-placeholder">
          <div class="loading-spinner" style="width:32px;height:32px;margin:0 auto 12px auto;"></div>
          <div>Mengambil data Slip Gaji dari Google Sheets...</div>
        </div>
      `;
    }

    if (isSlipGajiFetching) return;
    isSlipGajiFetching = true;
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      const response = await fetch(SLIP_GAJI_SHEET_URL + '&_t=' + Date.now());
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      const csvText = await response.text();
      const rows = parseCSV(csvText);

      if (rows.length <= 1) {
        throw new Error('Data spreadsheet kosong atau format tidak sesuai.');
      }

      // First row is header: Hub, ID, Name, mode_roles, Join Date, amount_hk_shift, #HK, OT 2-4, OT >4, #Alfa, #Off, GAPOK, IPP, TOTAL GAPOK, HO1, HO2
      const list = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 3 || !r[2]) continue; // Skip invalid rows

        const item = {
          hub: (r[0] || 'MTG').trim(),
          id: (r[1] || '').trim(),
          name: (r[2] || '').trim(),
          role: (r[3] || 'QA_HUB_FRESH').trim(),
          joinDateRaw: (r[4] || '').trim(),
          joinDate: formatJoinDate((r[4] || '').trim()),
          amountHkShift: (r[5] || 'Rp130,44').trim(),
          hk: (r[6] || '0').trim(),
          ot24: (r[7] || '0').trim(),
          otOver4: (r[8] || '0').trim(),
          alfa: (r[9] || '0').trim(),
          off: (r[10] || '0').trim(),
          gapok: (r[11] || 'Rp0').trim(),
          ipp: (r[12] || '-').trim(),
          totalGapok: (r[13] || 'Rp0').trim(),
          ho1: (r[14] || '0').trim(),
          ho2: (r[15] || '0').trim()
        };
        list.push(item);
      }

      // Sort alphabetically by name
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      slipGajiList = list;
      try {
        localStorage.setItem(SLIP_GAJI_CACHE_KEY, JSON.stringify(list));
      } catch (e) {
        console.warn('LocalStorage save failed:', e);
      }

      filterSlipGajiList();
      updateSlipGajiMeta(slipGajiList.length, 'Live Sync');

      if (forceRefresh) {
        showDccToast('success', 'Data Disinkronkan!', `Berhasil memuat ${slipGajiList.length} data Slip Gaji.`);
      }

      // If active MP was open, re-render it with fresh data
      if (currentActiveMpId) {
        window.showSlipGajiDetail(currentActiveMpId);
      }

    } catch (err) {
      console.error('Error fetching Slip Gaji data:', err);
      if (slipGajiList.length === 0 && cardContainer) {
        cardContainer.innerHTML = `
          <div class="sg-error-box">
            <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
            <div style="font-weight: 600; margin-bottom: 4px;">Gagal Memuat Data Slip Gaji</div>
            <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">${err.message || 'Koneksi ke Google Sheets gagal'}</div>
            <button type="button" class="btn-submit" style="display:inline-flex; width:auto; padding: 8px 18px;" onclick="fetchSlipGajiData(true)">
              Coba Lagi
            </button>
          </div>
        `;
      } else if (forceRefresh) {
        showDccToast('error', 'Gagal Memuat Data', err.message || 'Periksa koneksi internet Anda.');
      }
    } finally {
      isSlipGajiFetching = false;
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  };

  window.refreshSlipGajiData = function () {
    fetchSlipGajiData(true);
  };

  function updateSlipGajiMeta(count, status) {
    const countBadge = document.getElementById('sgListCountBadge');
    const syncBadge = document.getElementById('sgLastSyncBadge');
    if (countBadge) countBadge.textContent = `${count} Manpower`;
    if (syncBadge) syncBadge.textContent = status || 'Live Google Sheets';
  }

  window.clearSlipGajiFilter = function () {
    const filterInput = document.getElementById('sgFilterInput');
    const clearBtn = document.getElementById('sgFilterClearBtn');
    if (filterInput) filterInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    window.closeSlipGajiDetail();
    filterSlipGajiList();
  };

  function filterSlipGajiList() {
    const filterInput = document.getElementById('sgFilterInput');
    const query = filterInput ? filterInput.value.trim().toLowerCase() : '';
    const clearBtn = document.getElementById('sgFilterClearBtn');
    if (clearBtn) {
      if (query.length > 0) clearBtn.classList.remove('hidden');
      else clearBtn.classList.add('hidden');
    }

    if (!query) {
      window.closeSlipGajiDetail();
      renderSlipGajiCards([]); // Empty state / prompt
      const countBadge = document.getElementById('sgListCountBadge');
      if (countBadge) countBadge.textContent = `${slipGajiList.length} Manpower`;
      return;
    }

    const filtered = slipGajiList.filter(mp => {
      return (
        mp.name.toLowerCase().includes(query) ||
        mp.id.toLowerCase().includes(query) ||
        mp.role.toLowerCase().includes(query) ||
        mp.hub.toLowerCase().includes(query)
      );
    });

    renderSlipGajiCards(filtered, query);
    const countBadge = document.getElementById('sgListCountBadge');
    if (countBadge) {
      countBadge.textContent = `${filtered.length} dari ${slipGajiList.length} MP`;
    }
  }

  // Setup search input listener
  const sgFilterInputElem = document.getElementById('sgFilterInput');
  if (sgFilterInputElem) {
    let debounceTimer = null;
    sgFilterInputElem.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        filterSlipGajiList();
      }, 150);
    });
  }

  function renderSlipGajiCards(list, query = '') {
    const container = document.getElementById('sgCardContainer');
    if (!container) return;

    // Initial state: nothing searched yet
    if (!query) {
      container.innerHTML = `
        <div class="sg-empty-state">
          <div style="font-size: 38px; margin-bottom: 10px;">🔍</div>
          <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary); margin-bottom: 6px;">
            Cari Slip Gaji Manpower
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; max-width: 340px; margin: 0 auto;">
            Ketik nama Manpower atau ID pada kolom pencarian di atas untuk melihat rincian slip gaji.
          </div>
        </div>
      `;
      return;
    }

    // Search performed but no match
    if (!list || list.length === 0) {
      container.innerHTML = `
        <div class="sg-empty-state">
          <div style="font-size: 38px; margin-bottom: 10px;">❌</div>
          <div style="font-weight: 700; font-size: 1rem; color: var(--text-primary); margin-bottom: 6px;">
            Data Manpower Tidak Ditemukan
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">
            Tidak ada Manpower dengan kata kunci "<strong>${escapeHtml(query)}</strong>".
          </div>
        </div>
      `;
      return;
    }

    // Render only matching items
    let html = '';
    list.forEach(mp => {
      const isLead = mp.role.toUpperCase().includes('LEAD');
      const roleBadgeClass = isLead ? 'sg-badge-lead' : 'sg-badge-fresh';
      const identifier = mp.id || mp.name;

      const ot24Num = Number(mp.ot24) || 0;
      const otOver4Num = Number(mp.otOver4) || 0;
      const totalOtCount = ot24Num + otOver4Num;
      let otDisplayText = '0 Kali';
      if (totalOtCount > 0) {
        if (ot24Num > 0 && otOver4Num > 0) {
          otDisplayText = `${totalOtCount}x (${ot24Num}x 2-4j, ${otOver4Num}x >4j)`;
        } else if (otOver4Num > 0) {
          otDisplayText = `${otOver4Num} Kali (>4 Jam)`;
        } else if (ot24Num > 0) {
          otDisplayText = `${ot24Num} Kali (2-4 Jam)`;
        }
      }

      html += `
        <div class="sg-card" onclick="showSlipGajiDetail('${identifier}')">
          <div class="sg-card-top">
            <div class="sg-card-info">
              <div class="sg-card-name">${escapeHtml(mp.name)}</div>
              <div class="sg-card-meta">
                <span class="sg-card-id">ID: ${escapeHtml(mp.id || '-')}</span>
                <span class="sg-card-hub">${escapeHtml(mp.hub)}</span>
              </div>
            </div>
            <span class="sg-role-badge ${roleBadgeClass}">${escapeHtml(mp.role)}</span>
          </div>

          <div class="sg-card-stats-grid">
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Hari Kerja</span>
              <span class="sg-stat-val">${escapeHtml(mp.hk)} Hari</span>
            </div>
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Rate / Shift</span>
              <span class="sg-stat-val">${escapeHtml(mp.amountHkShift)}</span>
            </div>
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Jumlah Lembur</span>
              <span class="sg-stat-val ${totalOtCount > 0 ? 'font-accent' : ''}">${escapeHtml(otDisplayText)}</span>
            </div>
            <div class="sg-stat-box sg-stat-highlight">
              <span class="sg-stat-lbl">Total Gapok</span>
              <span class="sg-stat-val font-accent">${escapeHtml(mp.totalGapok)}</span>
            </div>
          </div>

          <div class="sg-card-footer">
            <span class="sg-view-btn">
              <span>Buka Slip Gaji</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  window.showSlipGajiDetail = function (identifier) {
    const mp = slipGajiList.find(item => item.id === identifier || item.name === identifier);
    if (!mp) return;

    currentActiveMpId = identifier;
    const detailSection = document.getElementById('sgDetailSection');
    if (!detailSection) return;

    const isLead = mp.role.toUpperCase().includes('LEAD');
    const roleBadgeClass = isLead ? 'sg-badge-lead' : 'sg-badge-fresh';

    detailSection.innerHTML = `
      <div class="sg-slip-paper" id="sgPrintableArea">
        <!-- Watermark ASTRO -->
        <div class="sg-paper-watermark">ASTRO MTG</div>

        <!-- Slip Header -->
        <div class="sg-slip-header">
          <div class="sg-brand-block">
            <div class="sg-logo-wrap">
              <img src="app-logo.jpg" alt="Logo" class="sg-slip-logo">
            </div>
            <div>
              <div class="sg-company-title">ASTRO QA HUB</div>
              <div class="sg-company-sub">Sistem Penggajian Manpower — Hub ${escapeHtml(mp.hub)}</div>
            </div>
          </div>
          <div class="sg-slip-badge-wrapper">
            <span class="sg-slip-type-badge">SLIP GAJI RESMI</span>
            <button type="button" class="sg-close-detail-btn" onclick="closeSlipGajiDetail()" title="Tutup Rincian">✕</button>
          </div>
        </div>

        <!-- Employee Info Section -->
        <div class="sg-emp-section">
          <div class="sg-emp-name-row">
            <div class="sg-emp-name">${escapeHtml(mp.name)}</div>
            <span class="sg-role-badge ${roleBadgeClass}">${escapeHtml(mp.role)}</span>
          </div>
          <div class="sg-emp-grid">
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">ID Manpower</span>
              <span class="sg-emp-val mono-font">${escapeHtml(mp.id || '-')}</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Hub Lokasi</span>
              <span class="sg-emp-val">${escapeHtml(mp.hub)}</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Join Date</span>
              <span class="sg-emp-val">${escapeHtml(mp.joinDate)}</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Rate per Shift</span>
              <span class="sg-emp-val mono-font">${escapeHtml(mp.amountHkShift)}</span>
            </div>
          </div>
        </div>

        <!-- Attendance & Overtime Breakdown -->
        <div class="sg-section-card">
          <div class="sg-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span>Rincian Kehadiran & Shift</span>
          </div>
          <div class="sg-table-responsive">
            <table class="sg-breakdown-table">
              <thead>
                <tr>
                  <th>Keterangan</th>
                  <th style="text-align:right;">Jumlah</th>
                  <th style="text-align:right;">Satuan</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Total Hari Kerja (HK)</td>
                  <td style="text-align:right;" class="font-bold">${escapeHtml(mp.hk)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Hari</td>
                </tr>
                <tr>
                  <td>Lembur OT (2 - 4 Jam)</td>
                  <td style="text-align:right;">${escapeHtml(mp.ot24)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Kali</td>
                </tr>
                <tr>
                  <td>Lembur OT (> 4 Jam)</td>
                  <td style="text-align:right;">${escapeHtml(mp.otOver4)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Kali</td>
                </tr>
                <tr style="background: rgba(6, 214, 160, 0.05);">
                  <td style="font-weight: 600; color: var(--accent-primary);">Total Jumlah Lembur</td>
                  <td style="text-align:right; font-weight: 700; color: var(--accent-primary);">${(Number(mp.ot24) || 0) + (Number(mp.otOver4) || 0)}</td>
                  <td style="text-align:right; color: var(--accent-primary); font-weight: 600;">Kali</td>
                </tr>
                <tr>
                  <td>Hari Libur (Off)</td>
                  <td style="text-align:right;">${escapeHtml(mp.off)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Hari</td>
                </tr>
                <tr>
                  <td>Ketidakhadiran (Alfa)</td>
                  <td style="text-align:right; color: ${mp.alfa !== '0' ? 'var(--color-error)' : 'inherit'};">${escapeHtml(mp.alfa)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Hari</td>
                </tr>
                ${(mp.ho1 !== '0' || mp.ho2 !== '0') ? `
                <tr>
                  <td>Holiday Overtime (HO 1 / HO 2)</td>
                  <td style="text-align:right;">${escapeHtml(mp.ho1)} / ${escapeHtml(mp.ho2)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Shift</td>
                </tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Financial & Earnings Breakdown -->
        <div class="sg-section-card">
          <div class="sg-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="1" x2="12" y2="23"></line>
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
            </svg>
            <span>Rincian Pendapatan</span>
          </div>
          <div class="sg-earnings-list">
            <div class="sg-earning-row">
              <span class="sg-earning-lbl">Gaji Pokok (GAPOK)</span>
              <span class="sg-earning-val mono-font">${escapeHtml(mp.gapok)}</span>
            </div>
            ${mp.ipp && mp.ipp !== '-' && mp.ipp !== '0' ? `
            <div class="sg-earning-row">
              <span class="sg-earning-lbl">Insentif / Penyesuaian (IPP)</span>
              <span class="sg-earning-val mono-font">${escapeHtml(mp.ipp)}</span>
            </div>` : ''}

            <!-- Grand Total Highlight -->
            <div class="sg-grand-total-row">
              <div>
                <div class="sg-grand-lbl">TOTAL PENERIMAAN</div>
                <div class="sg-grand-sub">Take Home Pay</div>
              </div>
              <div class="sg-grand-val mono-font">${escapeHtml(mp.totalGapok)}</div>
            </div>
          </div>
        </div>

        <!-- Action Buttons (Print & WhatsApp Share) -->
        <div class="sg-actions-bar no-print">
          <button type="button" class="sg-btn-action sg-btn-whatsapp" onclick="copySlipGajiText('${escapeHtml(mp.id || mp.name)}')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Salin Rincian Slip</span>
          </button>
          <button type="button" class="sg-btn-action sg-btn-print" onclick="printSlipGaji()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 6 2 18 2 18 9"></polyline>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
              <rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            <span>Cetak / Simpan PDF</span>
          </button>
        </div>

      </div>
    `;

    detailSection.classList.remove('hidden');

    // Smooth scroll to the payslip detail
    setTimeout(() => {
      detailSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  window.closeSlipGajiDetail = function () {
    currentActiveMpId = null;
    const detailSection = document.getElementById('sgDetailSection');
    if (detailSection) detailSection.classList.add('hidden');
  };

  window.copySlipGajiText = function (identifier) {
    const mp = slipGajiList.find(item => item.id === identifier || item.name === identifier);
    if (!mp) return;

    const totalOtCount = (Number(mp.ot24) || 0) + (Number(mp.otOver4) || 0);

    const lines = [
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `📄 *SLIP GAJI MANPOWER ASTRO*`,
      `🏢 Hub Lokasi: *${mp.hub}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 *Nama*: ${mp.name}`,
      `🆔 *ID MP*: ${mp.id || '-'}`,
      `🏷️ *Jabatan/Role*: ${mp.role}`,
      `📅 *Join Date*: ${mp.joinDate}`,
      `💵 *Rate HK/Shift*: ${mp.amountHkShift}`,
      `───────────────────────`,
      `📊 *RINCIAN KEHADIRAN*:`,
      `• Hari Kerja (HK) : *${mp.hk} Hari*`,
      `• Total Lembur    : *${totalOtCount} Kali* (2-4j: ${mp.ot24}x, >4j: ${mp.otOver4}x)`,
      `• Libur (Off)      : ${mp.off} Hari`,
      `• Ketidakhadiran   : ${mp.alfa} Hari`,
      `───────────────────────`,
      `💰 *RINCIAN PENDAPATAN*:`,
      `• Gaji Pokok : ${mp.gapok}`,
      (mp.ipp && mp.ipp !== '-' && mp.ipp !== '0' ? `• Insentif/IPP : ${mp.ipp}` : null),
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `💵 *TOTAL DITERIMA : ${mp.totalGapok}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `_Generated via Super App MTG_`
    ].filter(Boolean).join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(() => {
        showDccToast('success', 'Rincian Slip Disalin!', `Data ${mp.name} berhasil disalin ke clipboard.`);
      }).catch(() => {
        fallbackCopyText(lines, mp.name);
      });
    } else {
      fallbackCopyText(lines, mp.name);
    }
  };

  function fallbackCopyText(text, name) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      showDccToast('success', 'Rincian Slip Disalin!', `Data ${name} berhasil disalin.`);
    } catch (e) {
      showDccToast('error', 'Gagal Menyalin', 'Salin manual teks slip gaji.');
    }
    document.body.removeChild(ta);
  }

  window.printSlipGaji = function () {
    triggerNativePrint('print-mode-slip', 'Slip_Gaji_MTG');
  };

  // ══════════════════════════════════════════════
  //  MP SCHEDULE LOGIC (GOOGLE SHEETS INTEGRATION)
  // ══════════════════════════════════════════════

  const MP_SCHEDULE_PROXY_URL = '/api/mp-schedule-csv';
  const MP_SCHEDULE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1UoslCg_8Rtjcqo3hJ6nL9WoLVhWYEOww0YBkYRgLo4w/gviz/tq?tqx=out:csv&sheet=%282026%29%20SCHEDULE%20MTG';
  const MP_SCHEDULE_CACHE_KEY = 'MP_SCHEDULE_CACHE_MTG_V6';

  const SHIFT_TIME_MAP = {
    'P5': '05:00 - 13:00',
    'P6': '06:00 - 14:00',
    'P7': '07:00 - 15:00',
    'MD8': '08:00 - 16:00',
    'MD9': '09:00 - 17:00',
    'MD10': '10:00 - 18:00',
    'MD11': '11:00 - 19:00',
    'S12': '12:00 - 20:00',
    'S13': '13:00 - 21:00',
    'S14': '14:00 - 22:00',
    'S15': '15:00 - 23:00',
    'S16': '16:00 - 24:00',
    'S17': '17:00 - 01:00',
    'M18': '18:00 - 02:00',
    'M19': '19:00 - 03:00',
    'M20': '20:00 - 04:00',
    'M21': '21:00 - 05:00',
    'M22': '22:00 - 06:00',
    'M23': '23:00 - 07:00',
    'M24': '00:00 - 08:00',
    'OFF': 'Libur',
    'OFF DAY': 'Libur'
  };

  let mpScheduleList = [];
  let mpScheduleDateCols = [];
  let mpScheduleSummaryList = [];
  let currentActiveMpScheduleId = null;
  let currentMpsRoleFilter = 'all';
  let currentMpsTab = 'manpower';
  let selectedDateColIdx = null;
  let isMpScheduleFetching = false;

  function formatShiftFull(code) {
    if (!code || code === '-' || code === '' || code === '#N/A') return '-';
    const clean = String(code).trim();
    const upper = clean.toUpperCase();
    if (upper === 'OFF' || upper === 'OFF DAY') return 'Off Day';
    if (clean.includes('(')) return clean;
    const time = SHIFT_TIME_MAP[upper];
    if (time) return `${upper} (${time})`;
    return clean;
  }

  function getShiftCategory(shiftText) {
    if (!shiftText || shiftText === '' || shiftText === '-' || shiftText === '#N/A') return 'empty';
    const s = String(shiftText).toLowerCase().trim();
    if (s.includes('off') || s.includes('libur') || s === 'off day') return 'off';
    if (s.startsWith('p') || s.startsWith('md') || s.includes('07:00') || s.includes('09:00') || s.includes('10:00') || s.includes('08:00') || s.includes('11:00') || s.includes('pagi')) return 'pagi';
    if (s.startsWith('s') || s.includes('12:00') || s.includes('13:00') || s.includes('14:00') || s.includes('15:00') || s.includes('16:00') || s.includes('17:00') || s.includes('siang')) return 'siang';
    if (s.startsWith('m') || s.includes('18:00') || s.includes('19:00') || s.includes('20:00') || s.includes('21:00') || s.includes('22:00') || s.includes('23:00') || s.includes('00:00') || s.includes('05:00') || s.includes('malam')) return 'malam';
    return 'pagi';
  }

  function getShiftBadgeClass(category) {
    if (category === 'off') return 'mps-shift-off';
    if (category === 'pagi') return 'mps-shift-pagi';
    if (category === 'siang') return 'mps-shift-siang';
    if (category === 'malam') return 'mps-shift-malam';
    return 'mps-shift-empty';
  }

  function getRoleBadgeClass(role) {
    const r = (role || '').toUpperCase();
    if (r.includes('LEAD')) return 'sg-badge-lead';
    return 'sg-badge-fresh';
  }

  const DAY_NAME_ID_MAP = {
    'mon': 'Senin', 'monday': 'Senin', 'senin': 'Senin',
    'tue': 'Selasa', 'tuesday': 'Selasa', 'selasa': 'Selasa',
    'wed': 'Rabu', 'wednesday': 'Rabu', 'rabu': 'Rabu',
    'thu': 'Kamis', 'thursday': 'Kamis', 'kamis': 'Kamis',
    'fri': 'Jumat', 'friday': 'Jumat', 'jumat': 'Jumat',
    'sat': 'Sabtu', 'saturday': 'Sabtu', 'sabtu': 'Sabtu',
    'sun': 'Minggu', 'sunday': 'Minggu', 'minggu': 'Minggu'
  };

  const DAY_NAME_EN_MAP = {
    'mon': 'Mon', 'monday': 'Mon', 'senin': 'Mon',
    'tue': 'Tue', 'tuesday': 'Tue', 'selasa': 'Tue',
    'wed': 'Wed', 'wednesday': 'Wed', 'rabu': 'Wed',
    'thu': 'Thu', 'thursday': 'Thu', 'kamis': 'Thu',
    'fri': 'Fri', 'friday': 'Fri', 'jumat': 'Fri',
    'sat': 'Sat', 'saturday': 'Sat', 'sabtu': 'Sat',
    'sun': 'Sun', 'sunday': 'Sun', 'minggu': 'Sun'
  };

  function extractScheduleDateColumns(rows) {
    if (!rows || rows.length < 3) return [];
    const row0 = rows[0] || [];
    const row1 = rows[1] || [];
    const row2 = rows[2] || [];

    // Cari kolom 'Senin' yang memiliki data shift aktif di bawahnya
    // Roster aktif mingguan adalah 7 hari berturut-turut (Senin s/d Minggu)
    let startCol = -1;
    const maxCols = Math.min(row2.length, 25);

    for (let c = 0; c < maxCols; c++) {
      const r0 = (row0[c] || '').trim().toLowerCase();
      const r1 = (row1[c] || '').trim().toLowerCase();
      const isSenin = r0 === 'senin' || r1 === 'mon' || r0 === 'mon';
      if (!isSenin) continue;

      // Cek apakah kolom ini punya data shift
      let hasData = 0;
      for (let r = 3; r < Math.min(rows.length, 25); r++) {
        const val = (rows[r][c] || '').trim();
        if (val && val !== '-' && val !== '') hasData++;
      }

      if (hasData >= 5) {
        startCol = c;
        break;
      }
    }

    // Jika ketemu kolom Senin aktif, ambil 7 hari berturut-turut (Senin s/d Minggu)
    const targetCols = [];
    if (startCol !== -1) {
      for (let offset = 0; offset < 7; offset++) {
        targetCols.push(startCol + offset);
      }
    } else {
      // Default: kolom J s/d P (index 9 s/d 15)
      targetCols.push(9, 10, 11, 12, 13, 14, 15);
    }

    return targetCols.map(c => {
      const r0 = (row0[c] || '').trim();
      const r1 = (row1[c] || '').trim();
      const r2 = (row2[c] || '').trim();

      const dayId = DAY_NAME_ID_MAP[r0.toLowerCase()] || DAY_NAME_ID_MAP[r1.toLowerCase()] || r0 || 'Senin';
      const dayEn = DAY_NAME_EN_MAP[r1.toLowerCase()] || DAY_NAME_EN_MAP[r0.toLowerCase()] || r1 || 'Mon';
      const dateLabel = r2 || '';
      const fullLabel = dayId && dateLabel ? `${dayId}, ${dateLabel}` : (dateLabel || dayId);

      return {
        colIndex: c,
        dateStr: dateLabel,
        dayNameId: dayId,
        dayNameEn: dayEn,
        fullLabel: fullLabel
      };
    });
  }

  function findTodayDateColIndex(dateCols) {
    if (!dateCols || dateCols.length === 0) return null;
    const now = new Date();
    const todayDay = now.getDate(); // e.g. 25
    const todayDayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, ...
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthNameEn = monthNames[now.getMonth()].toLowerCase(); // 'aug'
    const monthNameId = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'][now.getMonth()];

    // 1. Check if dateStr matches today's day number and month (e.g. "25-Aug", "25 Aug", "25-Agu", "25/08")
    for (const dc of dateCols) {
      const raw = (dc.dateStr || '').toLowerCase();
      if (raw.includes(String(todayDay)) && (raw.includes(monthNameEn) || raw.includes(monthNameId) || raw.includes(String(now.getMonth() + 1)))) {
        return dc.colIndex;
      }
    }

    // 2. Check if dateStr contains day number exactly (e.g. "25" in "25-Aug")
    for (const dc of dateCols) {
      const raw = (dc.dateStr || '').toLowerCase();
      const match = raw.match(/\b(\d{1,2})\b/);
      if (match && parseInt(match[1], 10) === todayDay) {
        return dc.colIndex;
      }
    }

    // 3. Match day of week (e.g. Tuesday / Selasa)
    const dayNamesEn = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayNamesId = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
    const curEn = dayNamesEn[todayDayOfWeek];
    const curId = dayNamesId[todayDayOfWeek];

    for (const dc of dateCols) {
      const dEn = (dc.dayNameEn || '').toLowerCase();
      const dId = (dc.dayNameId || '').toLowerCase();
      if (dEn.includes(curEn) || dId.includes(curId)) {
        return dc.colIndex;
      }
    }

    return dateCols[0]?.colIndex || null;
  }

  function computeScheduleSummaryMetrics(list, dateCols, rawSummaryRows) {
    const shiftTypes = [
      'P5', 'P6', 'P7', 'MD8', 'MD9', 'MD10', 'MD11',
      'S12', 'S13', 'S14', 'S15', 'S16', 'S17',
      'M18', 'M19', 'M20', 'M21', 'M22', 'M23', 'M24',
      'Off Day', 'Total Per-Day', 'Total Manpower'
    ];

    const summary = [];

    shiftTypes.forEach(label => {
      const isOff = label.toLowerCase() === 'off day';
      const isPerDay = label.toLowerCase() === 'total per-day';
      const isTotalMp = label.toLowerCase() === 'total manpower';

      const values = {};
      dateCols.forEach(dc => {
        let count = 0;
        list.forEach(mp => {
          const rawShift = (mp.shifts[dc.colIndex] || '').trim();
          const cat = getShiftCategory(rawShift);
          const shiftUpper = rawShift.toUpperCase();

          if (isTotalMp) {
            count++;
          } else if (isPerDay) {
            if (cat !== 'off' && cat !== 'empty') count++;
          } else if (isOff) {
            if (cat === 'off') count++;
          } else {
            const codeUpper = label.toUpperCase();
            if (shiftUpper === codeUpper || shiftUpper.startsWith(codeUpper + ' ') || shiftUpper.startsWith(codeUpper + '(')) {
              count++;
            }
          }
        });
        values[dc.colIndex] = String(count);
      });

      summary.push({
        label: label,
        values: values
      });
    });

    return summary;
  }

  window.fetchMpScheduleData = async function (forceRefresh = false) {
    // 1. Instant Memory Cache Hit (0 ms)
    if (!forceRefresh && mpScheduleList.length > 0) {
      renderActiveMpsTab();
      return;
    }

    const cardContainer = document.getElementById('mpsCardContainer');
    const refreshBtn = document.querySelector('.mps-refresh-btn');

    // 2. Instant LocalStorage Warm Cache Hit (0 ms)
    if (!forceRefresh && mpScheduleList.length === 0) {
      try {
        const cached = localStorage.getItem(MP_SCHEDULE_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.list) && parsed.list.length > 0) {
            mpScheduleList = parsed.list;
            mpScheduleDateCols = parsed.dateCols || [];
            mpScheduleSummaryList = parsed.summaryList || [];
            selectedDateColIdx = parsed.selectedDateColIdx || (mpScheduleDateCols[0] ? mpScheduleDateCols[0].colIndex : null);
            updateMpScheduleMeta(mpScheduleList.length, 'Cached');
            renderActiveMpsTab();
          }
        }
      } catch (e) {
        console.warn('Failed to load MP Schedule cache:', e);
      }
    }

    if (mpScheduleList.length === 0 && cardContainer) {
      cardContainer.innerHTML = `
        <div class="mps-loading-placeholder">
          <div class="loading-spinner" style="width:32px;height:32px;margin:0 auto 12px auto;"></div>
          <div>Mengambil jadwal Manpower dari Google Sheets...</div>
        </div>
      `;
    }

    if (isMpScheduleFetching) return;
    isMpScheduleFetching = true;
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      // Direct Sheet Fetch (Instant, skips invalid proxy timeout)
      const resDirect = await fetch(MP_SCHEDULE_SHEET_URL + '&_t=' + Date.now());
      if (!resDirect.ok) throw new Error(`HTTP Error ${resDirect.status}`);
      const csvText = await resDirect.text();

      const rows = parseCSV(csvText);
      if (rows.length <= 2) {
        throw new Error('Data spreadsheet kosong atau format tidak sesuai.');
      }

      // ── Dynamically Detect Active Schedule Date Columns ──
      const dateCols = extractScheduleDateColumns(rows);
      if (dateCols.length === 0) {
        throw new Error('Kolom tanggal jadwal tidak terdeteksi pada spreadsheet.');
      }

      // ── Extract Manpower Rows and Summary Rows ──
      const list = [];
      const rawSummaryList = [];

      for (let r = 3; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length === 0) continue;

        const col0 = (row[0] || '').trim();
        const col1 = (row[1] || '').trim();
        const col2 = (row[2] || '').trim();
        const col3 = (row[3] || '').trim();
        const col4 = (row[4] || '').trim();
        const col17 = (row[17] || '').trim();

        if (!col1 && !col2) continue;

        // Skip title/header subrow (e.g. Eko Suwandi / SHIFT / LEMBUR header rows)
        if (row.some(cell => String(cell).includes('SHIFT') || String(cell).includes('LEMBUR'))) {
          continue;
        }

        // Check if this is a summary row at the bottom
        const isSummaryLabel = /^(p\d|md\d|s\d|m\d|off day|total per-day|total manpower|inbound)/i.test(col2);
        if (!col1 && isSummaryLabel) {
          const sumValues = {};
          dateCols.forEach(dc => {
            sumValues[dc.colIndex] = (row[dc.colIndex] || '').trim();
          });
          rawSummaryList.push({
            label: col2,
            values: sumValues
          });
          continue;
        }

        // It's a Manpower row
        const shifts = {};
        let hkCount = 0;
        let offCount = 0;

        dateCols.forEach(dc => {
          const rawVal = (row[dc.colIndex] || '').trim();
          shifts[dc.colIndex] = rawVal;
          const cat = getShiftCategory(rawVal);
          if (cat === 'off') offCount++;
          else if (cat !== 'empty') hkCount++;
        });

        list.push({
          no: col0,
          id: col1,
          name: col2,
          jobDesk: col3 || '-',
          role: col4 || col17 || 'QA_HUB_FRESH',
          shifts: shifts,
          hkCount: hkCount,
          offCount: offCount
        });
      }

      // Sort alphabetically by name
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      // Compute clean, live summary metrics based on actual manpower shift counts
      const computedSummary = computeScheduleSummaryMetrics(list, dateCols, rawSummaryList);

      mpScheduleList = list;
      mpScheduleDateCols = dateCols;
      mpScheduleSummaryList = computedSummary;

      // Select default date: dynamically select TODAY's date
      const todayColIdx = findTodayDateColIndex(dateCols);
      selectedDateColIdx = todayColIdx !== null ? todayColIdx : (dateCols[0]?.colIndex || null);

      // Save to cache
      try {
        localStorage.setItem(MP_SCHEDULE_CACHE_KEY, JSON.stringify({
          list: mpScheduleList,
          dateCols: mpScheduleDateCols,
          summaryList: mpScheduleSummaryList,
          selectedDateColIdx: selectedDateColIdx
        }));
      } catch (e) {
        console.warn('LocalStorage save failed:', e);
      }

      updateMpScheduleMeta(mpScheduleList.length, 'Live Sync');
      renderActiveMpsTab();

      if (forceRefresh) {
        showDccToast('success', 'Jadwal Disinkronkan!', `Berhasil memuat ${mpScheduleList.length} Manpower.`);
      }

      if (currentActiveMpScheduleId) {
        window.showMpScheduleDetail(currentActiveMpScheduleId);
      }

    } catch (err) {
      console.error('Error fetching MP Schedule data:', err);
      if (mpScheduleList.length === 0 && cardContainer) {
        cardContainer.innerHTML = `
          <div class="mps-loading-placeholder">
            <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
            <div style="font-weight: 700; margin-bottom: 4px;">Gagal Memuat Jadwal MP</div>
            <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">${err.message || 'Koneksi ke Google Sheets gagal'}</div>
            <button type="button" class="btn-submit" style="display:inline-flex; width:auto; padding: 8px 18px;" onclick="fetchMpScheduleData(true)">
              Coba Lagi
            </button>
          </div>
        `;
      } else if (forceRefresh) {
        showDccToast('error', 'Gagal Memuat Data', err.message || 'Periksa koneksi internet Anda.');
      }
    } finally {
      isMpScheduleFetching = false;
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  };

  window.refreshMpScheduleData = function () {
    fetchMpScheduleData(true);
  };

  function updateMpScheduleMeta(count, status) {
    const countBadge = document.getElementById('mpsListCountBadge');
    const syncBadge = document.getElementById('mpsLastSyncBadge');
    if (countBadge) countBadge.textContent = `${count} Manpower`;
    if (syncBadge) syncBadge.textContent = status || 'Live Google Sheets';
  }

  // ── Sub-Tab Switching ──
  window.switchMpsTab = function (tabName) {
    currentMpsTab = tabName;

    // Toggle button active states
    document.getElementById('tabMpsManpower').classList.toggle('active', tabName === 'manpower');
    document.getElementById('tabMpsDaily').classList.toggle('active', tabName === 'daily');
    document.getElementById('tabMpsMatrix').classList.toggle('active', tabName === 'matrix');

    // Toggle pane active states
    const paneMp = document.getElementById('mpsTabContentManpower');
    const paneDaily = document.getElementById('mpsTabContentDaily');
    const paneMatrix = document.getElementById('mpsTabContentMatrix');

    if (paneMp) {
      paneMp.classList.toggle('hidden', tabName !== 'manpower');
      paneMp.classList.toggle('active', tabName === 'manpower');
    }
    if (paneDaily) {
      paneDaily.classList.toggle('hidden', tabName !== 'daily');
      paneDaily.classList.toggle('active', tabName === 'daily');
    }
    if (paneMatrix) {
      paneMatrix.classList.toggle('hidden', tabName !== 'matrix');
      paneMatrix.classList.toggle('active', tabName === 'matrix');
    }

    renderActiveMpsTab();
  };

  function renderActiveMpsTab() {
    if (currentMpsTab === 'manpower') {
      filterMpScheduleList();
    } else if (currentMpsTab === 'daily') {
      renderMpDailyRoster();
    } else if (currentMpsTab === 'matrix') {
      renderMpMatrixView();
    }
  }

  // ── Role Filter ──
  window.setMpsRoleFilter = function (role) {
    currentMpsRoleFilter = role;
    const chips = document.querySelectorAll('#mpsRoleChips .mps-chip-btn');
    chips.forEach(chip => {
      chip.classList.toggle('active', chip.getAttribute('data-role') === role);
    });
    filterMpScheduleList();
  };

  window.clearMpScheduleFilter = function () {
    const input = document.getElementById('mpsFilterInput');
    const clearBtn = document.getElementById('mpsFilterClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    window.closeMpScheduleDetail();
    filterMpScheduleList();
  };

  function filterMpScheduleList() {
    const input = document.getElementById('mpsFilterInput');
    const query = input ? input.value.trim().toLowerCase() : '';
    const clearBtn = document.getElementById('mpsFilterClearBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', query.length === 0);

    let list = mpScheduleList;

    // Apply role filter
    if (currentMpsRoleFilter === 'lead') {
      list = list.filter(mp => (mp.role || '').toUpperCase().includes('LEAD'));
    } else if (currentMpsRoleFilter === 'fresh') {
      list = list.filter(mp => (mp.role || '').toUpperCase().includes('FRESH'));
    } else if (currentMpsRoleFilter === 'stockkeeper') {
      list = list.filter(mp => (mp.jobDesk || '').toLowerCase().includes('stock') || (mp.role || '').toLowerCase().includes('stock'));
    }

    // Apply text search
    if (query) {
      list = list.filter(mp => {
        const nameMatch = mp.name.toLowerCase().includes(query);
        const idMatch = mp.id.toLowerCase().includes(query);
        const jobMatch = (mp.jobDesk || '').toLowerCase().includes(query);
        const roleMatch = (mp.role || '').toLowerCase().includes(query);
        // Also check if any shift matches
        const shiftMatch = Object.values(mp.shifts || {}).some(s => (s || '').toLowerCase().includes(query));
        return nameMatch || idMatch || jobMatch || roleMatch || shiftMatch;
      });
    }

    renderMpScheduleCards(list, query);

    const countBadge = document.getElementById('mpsListCountBadge');
    if (countBadge) {
      countBadge.textContent = query || currentMpsRoleFilter !== 'all'
        ? `${list.length} dari ${mpScheduleList.length} MP`
        : `${mpScheduleList.length} Manpower`;
    }
  }

  // Init search input listener
  const mpsFilterInputElem = document.getElementById('mpsFilterInput');
  if (mpsFilterInputElem) {
    let debounceTimer = null;
    mpsFilterInputElem.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        filterMpScheduleList();
      }, 150);
    });
  }

  // ── Render Manpower Cards ──
  function renderMpScheduleCards(list, query = '') {
    const container = document.getElementById('mpsCardContainer');
    if (!container) return;

    if (!list || list.length === 0) {
      container.innerHTML = `
        <div class="mps-empty-state">
          <div style="font-size: 36px; margin-bottom: 8px;">🔍</div>
          <div style="font-weight: 700; font-size: 1rem; color: var(--text-primary); margin-bottom: 4px;">
            Manpower Tidak Ditemukan
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">
            Tidak ada data yang cocok dengan kriteria pencarian.
          </div>
        </div>
      `;
      return;
    }

    let html = '';
    list.forEach(mp => {
      const initial = (mp.name || 'M').charAt(0).toUpperCase();
      const roleBadgeClass = getRoleBadgeClass(mp.role);
      const identifier = mp.id || mp.name;

      // Build timeline preview for dates with shifts
      let timelineHtml = '';
      mpScheduleDateCols.forEach(dc => {
        const shiftVal = mp.shifts[dc.colIndex] || '-';
        const cat = getShiftCategory(shiftVal);
        const badgeClass = getShiftBadgeClass(cat);
        const displayShift = shiftVal === '' || shiftVal === '-' ? '-' : (shiftVal.length > 8 ? shiftVal.split(' ')[0] : shiftVal);

        timelineHtml += `
          <div class="mps-timeline-day" title="${escapeHtml(dc.fullLabel)}: ${escapeHtml(shiftVal)}">
            <span class="mps-tday-date">${escapeHtml(dc.dateStr || dc.dayNameId || '-')}</span>
            <span class="mps-tday-name">${escapeHtml(dc.dayNameEn || dc.dayNameId || '')}</span>
            <span class="mps-shift-badge ${badgeClass}">${escapeHtml(displayShift)}</span>
          </div>
        `;
      });

      html += `
        <div class="mps-card" onclick="showMpScheduleDetail('${escapeAttr(identifier)}')">
          <div class="mps-card-top">
            <div class="mps-avatar">${escapeHtml(initial)}</div>
            <div class="mps-card-info">
              <div class="mps-card-name">${escapeHtml(mp.name)}</div>
              <div class="mps-card-meta">
                <span class="mps-card-id">ID: ${escapeHtml(mp.id || '-')}</span>
                <span class="sg-role-badge ${roleBadgeClass}">${escapeHtml(mp.role)}</span>
              </div>
            </div>
          </div>

          <div class="mps-card-jobdesk">
            <strong>Job Desk:</strong> ${escapeHtml(mp.jobDesk || '-')}
          </div>

          <div class="mps-timeline-preview">
            ${timelineHtml}
          </div>

          <div class="mps-card-bottom">
            <div class="mps-card-stats">
              <span class="mps-stat-hk">💼 ${mp.hkCount} Hari Kerja</span>
              <span class="mps-stat-off">🏖️ ${mp.offCount} Off Day</span>
            </div>
            <span class="mps-view-btn">
              <span>Rincian</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // ── Show MP Schedule Detail ──
  window.showMpScheduleDetail = function (identifier) {
    const mp = mpScheduleList.find(item => item.id === identifier || item.name === identifier);
    if (!mp) return;

    currentActiveMpScheduleId = identifier;
    const detailSection = document.getElementById('mpsDetailSection');
    if (!detailSection) return;

    const roleBadgeClass = getRoleBadgeClass(mp.role);

    // Build breakdown table rows
    let tableRows = '';
    mpScheduleDateCols.forEach(dc => {
      const shiftVal = mp.shifts[dc.colIndex] || '-';
      const formattedShift = formatShiftFull(shiftVal);
      const cat = getShiftCategory(shiftVal);
      const badgeClass = getShiftBadgeClass(cat);

      tableRows += `
        <tr>
          <td style="font-weight: 700; color: var(--text-primary);">${escapeHtml(dc.fullLabel)}</td>
          <td><span class="mps-shift-badge ${badgeClass}">${escapeHtml(formattedShift)}</span></td>
          <td style="text-align: right; color: var(--text-muted); font-size: 0.8rem;">-</td>
        </tr>
      `;
    });

    detailSection.innerHTML = `
      <div class="mps-schedule-paper">
        <div class="mps-paper-watermark">SCHEDULE MTG</div>

        <div class="mps-paper-header">
          <div class="mps-brand-block">
            <div class="sg-logo-wrap">
              <img src="app-logo.jpg" alt="Logo" class="sg-slip-logo">
            </div>
            <div>
              <div class="mps-paper-title">${escapeHtml(mp.name)}</div>
              <div class="mps-paper-sub">ID: ${escapeHtml(mp.id || '-')} &bull; Hub MTG 2026</div>
            </div>
          </div>
          <div class="sg-slip-badge-wrapper">
            <span class="sg-role-badge ${roleBadgeClass}">${escapeHtml(mp.role)}</span>
            <button type="button" class="mps-close-detail-btn" onclick="closeMpScheduleDetail()" title="Tutup Rincian">✕</button>
          </div>
        </div>

        <div class="sg-emp-section" style="margin-bottom: 16px;">
          <div class="sg-emp-grid">
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Job Desk</span>
              <span class="sg-emp-val">${escapeHtml(mp.jobDesk || '-')}</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Total Hari Kerja (HK)</span>
              <span class="sg-emp-val" style="color: #06d6a0;">${mp.hkCount} Hari</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Total Off Day (Libur)</span>
              <span class="sg-emp-val" style="color: #f87171;">${mp.offCount} Hari</span>
            </div>
            <div class="sg-emp-item">
              <span class="sg-emp-lbl">Status Sinkronisasi</span>
              <span class="sg-emp-val" style="color: #38bdf8;">Aktif (Live Sheet)</span>
            </div>
          </div>
        </div>

        <!-- Schedule Table Breakdown -->
        <div class="sg-section-card">
          <div class="sg-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span>Rincian Jadwal Shift Kerja</span>
          </div>
          <div class="sg-table-responsive">
            <table class="sg-breakdown-table">
              <thead>
                <tr>
                  <th>Hari & Tanggal</th>
                  <th>Jadwal Shift</th>
                  <th style="text-align: right;">Lemburan</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="sg-actions-bar no-print">
          <button type="button" class="sg-btn-action sg-btn-whatsapp" onclick="copyMpScheduleText('${escapeAttr(identifier)}')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Salin Jadwal WhatsApp</span>
          </button>
          <button type="button" class="sg-btn-action sg-btn-print" onclick="printMpSchedule()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 6 2 18 2 18 9"></polyline>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
              <rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            <span>Cetak Jadwal</span>
          </button>
        </div>
      </div>
    `;

    detailSection.classList.remove('hidden');
    setTimeout(() => {
      detailSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  window.closeMpScheduleDetail = function () {
    currentActiveMpScheduleId = null;
    const detailSection = document.getElementById('mpsDetailSection');
    if (detailSection) detailSection.classList.add('hidden');
  };

  // ── Render Daily Roster (Tab 2) ──
  function renderMpDailyRoster(dateColIdx = null) {
    if (dateColIdx !== null) {
      selectedDateColIdx = dateColIdx;
    }
    if (selectedDateColIdx === null && mpScheduleDateCols.length > 0) {
      selectedDateColIdx = findTodayDateColIndex(mpScheduleDateCols);
    }

    const scrollContainer = document.getElementById('mpsDateScrollContainer');
    const rosterContainer = document.getElementById('mpsDailyRosterContainer');
    const dateTitleEl = document.getElementById('mpsDailyDateTitle');
    const totalDutyEl = document.getElementById('mpsDailyTotalDuty');
    const pagiCountEl = document.getElementById('mpsDailyPagiCount');
    const siangCountEl = document.getElementById('mpsDailySiangCount');
    const malamCountEl = document.getElementById('mpsDailyMalamCount');
    const offCountEl = document.getElementById('mpsDailyOffCount');

    // Build Date Chips
    if (scrollContainer && mpScheduleDateCols.length > 0) {
      const todayColIndex = findTodayDateColIndex(mpScheduleDateCols);
      scrollContainer.innerHTML = mpScheduleDateCols.map(dc => {
        const isActive = dc.colIndex === selectedDateColIdx;
        const isToday = dc.colIndex === todayColIndex;
        return `
          <div class="mps-date-chip ${isActive ? 'active' : ''} ${isToday ? 'is-today' : ''}" onclick="selectDailyDate(${dc.colIndex})">
            ${isToday ? '<span class="mps-today-pill">Hari Ini</span>' : ''}
            <div class="dchip-day">${escapeHtml(dc.dayNameEn || dc.dayNameId || '')}</div>
            <div class="dchip-date">${escapeHtml(dc.dateStr || '-')}</div>
          </div>
        `;
      }).join('');

      // Auto-center active chip into view on mobile
      setTimeout(() => {
        const activeChip = scrollContainer.querySelector('.mps-date-chip.active');
        if (activeChip) {
          activeChip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      }, 80);
    }

    const activeDateMeta = mpScheduleDateCols.find(dc => dc.colIndex === selectedDateColIdx) || mpScheduleDateCols[0];
    if (!activeDateMeta) return;

    if (dateTitleEl) dateTitleEl.textContent = activeDateMeta.fullLabel;

    // Group MPs by shift category
    const pagiList = [];
    const siangList = [];
    const malamList = [];
    const offList = [];

    mpScheduleList.forEach(mp => {
      const shiftVal = mp.shifts[activeDateMeta.colIndex] || '';
      const cat = getShiftCategory(shiftVal);
      const item = { ...mp, activeShift: shiftVal || 'Off Day' };

      if (cat === 'pagi') pagiList.push(item);
      else if (cat === 'siang') siangList.push(item);
      else if (cat === 'malam') malamList.push(item);
      else offList.push(item);
    });

    const totalDuty = pagiList.length + siangList.length + malamList.length;

    if (totalDutyEl) totalDutyEl.textContent = `${totalDuty} MP Bertugas`;
    if (pagiCountEl) pagiCountEl.textContent = pagiList.length;
    if (siangCountEl) siangCountEl.textContent = siangList.length;
    if (malamCountEl) malamCountEl.textContent = malamList.length;
    if (offCountEl) offCountEl.textContent = offList.length;

    // Helper to render group body with responsive, tidy mobile layout
    function buildGroupHtml(title, icon, badgeText, badgeClass, list) {
      if (list.length === 0) {
        return `
          <div class="mps-shift-group-card">
            <div class="mps-group-header">
              <div class="mps-group-title">${icon} ${title}</div>
              <span class="mps-group-badge ${badgeClass}">0 MP</span>
            </div>
            <div class="mps-group-body" style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 16px;">
              Tidak ada MP pada shift ini
            </div>
          </div>
        `;
      }

      const itemsHtml = list.map((mp, idx) => {
        const rawShift = (mp.activeShift || '').trim();
        const cat = getShiftCategory(rawShift);
        const isOff = cat === 'off';

        let shortBadge = rawShift;
        let shiftTimeDesc = '';

        if (isOff || rawShift.toUpperCase().includes('OFF')) {
          shortBadge = 'OFF';
          shiftTimeDesc = 'Libur';
        } else {
          const cleanUpper = rawShift.toUpperCase().split(' ')[0];
          shortBadge = cleanUpper;
          const timeFromMap = SHIFT_TIME_MAP[cleanUpper];
          if (timeFromMap) {
            shiftTimeDesc = timeFromMap;
          } else if (rawShift.includes('(')) {
            const m = rawShift.match(/\((.*?)\)/);
            if (m) shiftTimeDesc = m[1];
          } else {
            shiftTimeDesc = rawShift;
          }
        }

        return `
          <div class="mps-roster-item" onclick="showMpScheduleDetail('${escapeAttr(mp.id || mp.name)}')">
            <div class="mps-roster-left">
              <span class="mps-roster-num">${idx + 1}</span>
              <div class="mps-roster-info">
                <div class="mps-roster-name">${escapeHtml(mp.name)}</div>
                <div class="mps-roster-sub">
                  <span class="mps-roster-job">${escapeHtml(mp.jobDesk || mp.role)}</span>
                  ${shiftTimeDesc ? `<span class="mps-roster-dot">•</span><span class="mps-roster-time">${escapeHtml(shiftTimeDesc)}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="mps-roster-right">
              <span class="mps-shift-badge ${badgeClass}">${escapeHtml(shortBadge)}</span>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="mps-shift-group-card">
          <div class="mps-group-header">
            <div class="mps-group-title">${icon} ${title}</div>
            <span class="mps-group-badge ${badgeClass}">${list.length} MP</span>
          </div>
          <div class="mps-group-body">
            ${itemsHtml}
          </div>
        </div>
      `;
    }

    if (rosterContainer) {
      rosterContainer.innerHTML = `
        ${buildGroupHtml('Shift Pagi & Middle Day', '☀️', `${pagiList.length} MP`, 'mps-shift-pagi', pagiList)}
        ${buildGroupHtml('Shift Siang', '🌤️', `${siangList.length} MP`, 'mps-shift-siang', siangList)}
        ${buildGroupHtml('Shift Malam', '🌙', `${malamList.length} MP`, 'mps-shift-malam', malamList)}
        ${buildGroupHtml('Off Day / Libur', '🏖️', `${offList.length} MP`, 'mps-shift-off', offList)}
      `;
    }
  }

  window.selectDailyDate = function (colIndex) {
    renderMpDailyRoster(colIndex);
  };

  window.selectTodayDate = function () {
    const todayCol = findTodayDateColIndex(mpScheduleDateCols);
    if (todayCol !== null) {
      selectedDateColIdx = todayCol;
      renderMpDailyRoster(todayCol);
      const scrollContainer = document.getElementById('mpsDateScrollContainer');
      const activeChip = scrollContainer ? scrollContainer.querySelector('.mps-date-chip.active') : null;
      if (activeChip) activeChip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  // ── Render Matrix View (Tab 3) ──
  function renderMpMatrixView() {
    const matrixContainer = document.getElementById('mpsMatrixContainer');
    const summaryContainer = document.getElementById('mpsSummaryMatrixContainer');

    if (!matrixContainer) return;

    if (mpScheduleList.length === 0 || mpScheduleDateCols.length === 0) {
      matrixContainer.innerHTML = '<div style="text-align:center; padding: 24px; color: var(--text-muted);">Memuat data matrix...</div>';
      return;
    }

    // Build Main Matrix Table
    let thCols = '<th class="sticky-col">Nama Manpower</th>';
    mpScheduleDateCols.forEach(dc => {
      thCols += `<th>${escapeHtml(dc.dateStr || dc.dayNameId)}<br><small style="color:var(--text-muted);">${escapeHtml(dc.dayNameEn || dc.dayNameId)}</small></th>`;
    });

    let trRows = '';
    mpScheduleList.forEach(mp => {
      let tdCols = `<td class="sticky-col"><strong>${escapeHtml(mp.name)}</strong><br><small style="color:var(--text-muted); font-size:0.72rem;">${escapeHtml(mp.role)}</small></td>`;
      mpScheduleDateCols.forEach(dc => {
        const shiftVal = mp.shifts[dc.colIndex] || '-';
        const cat = getShiftCategory(shiftVal);
        const badgeClass = getShiftBadgeClass(cat);
        const displayShift = shiftVal === '' ? '-' : (shiftVal.length > 8 ? shiftVal.split(' ')[0] : shiftVal);

        tdCols += `<td><span class="mps-shift-badge ${badgeClass}" title="${escapeHtml(shiftVal)}">${escapeHtml(displayShift)}</span></td>`;
      });
      trRows += `<tr>${tdCols}</tr>`;
    });

    matrixContainer.innerHTML = `
      <table class="mps-matrix-table">
        <thead>
          <tr>${thCols}</tr>
        </thead>
        <tbody>
          ${trRows}
        </tbody>
      </table>
    `;

    // Build Summary Matrix Table
    if (summaryContainer && mpScheduleSummaryList.length > 0) {
      let sumTh = '<th class="sticky-col">Kategori Shift / Metrik</th>';
      mpScheduleDateCols.forEach(dc => {
        sumTh += `<th>${escapeHtml(dc.dateStr || dc.dayNameId)}<br><small style="color:var(--text-muted);">${escapeHtml(dc.dayNameEn || dc.dayNameId)}</small></th>`;
      });

      let sumRows = '';
      mpScheduleSummaryList.forEach(item => {
        const isOffDay = /^off day/i.test(item.label);
        const isTotalPerDay = /^total per-day/i.test(item.label);
        const isTotalMP = /^total manpower/i.test(item.label);

        let rowStyle = '';
        let labelStyle = 'font-weight: 600;';

        if (isTotalPerDay) {
          rowStyle = 'background: rgba(16, 185, 129, 0.12); font-weight: 700;';
          labelStyle = 'font-weight: 700; color: #34d399;';
        } else if (isTotalMP) {
          rowStyle = 'background: rgba(56, 189, 248, 0.12); font-weight: 700;';
          labelStyle = 'font-weight: 700; color: #38bdf8;';
        } else if (isOffDay) {
          rowStyle = 'background: rgba(248, 113, 113, 0.10); font-weight: 700;';
          labelStyle = 'font-weight: 700; color: #f87171;';
        }

        let tdCols = `<td class="sticky-col" style="${labelStyle}">${escapeHtml(item.label)}</td>`;
        mpScheduleDateCols.forEach(dc => {
          const val = item.values[dc.colIndex] || '0';
          const isNA = val === '#N/A' || val === '';
          let cellDisplay = isNA ? '-' : val;

          if (isTotalPerDay && !isNA) {
            cellDisplay = `<span style="display:inline-block; padding:3px 10px; border-radius:12px; background:rgba(16,185,129,0.25); color:#34d399; font-weight:700;">${val} MP</span>`;
          } else if (isTotalMP && !isNA) {
            cellDisplay = `<span style="display:inline-block; padding:3px 10px; border-radius:12px; background:rgba(56,189,248,0.25); color:#38bdf8; font-weight:700;">${val} MP</span>`;
          } else if (isOffDay && !isNA) {
            cellDisplay = `<span style="display:inline-block; padding:3px 10px; border-radius:12px; background:rgba(248,113,113,0.25); color:#f87171; font-weight:700;">${val}</span>`;
          }

          tdCols += `<td style="font-family:var(--font-mono); font-weight:${isTotalPerDay || isTotalMP || isOffDay ? '700' : 'normal'}; text-align:center;">${cellDisplay}</td>`;
        });

        sumRows += `<tr style="${rowStyle}">${tdCols}</tr>`;
      });

      summaryContainer.innerHTML = `
        <table class="mps-matrix-table">
          <thead>
            <tr>${sumTh}</tr>
          </thead>
          <tbody>
            ${sumRows}
          </tbody>
        </table>
      `;
    }
  }

  window.exportMatrixToPdf = function () {
    switchMpsTab('matrix');
    setTimeout(() => {
      triggerNativePrint('print-mode-mps-matrix', 'Matrix_Jadwal_MTG');
    }, 200);
  };

  // ── Copy WhatsApp Messages ──
  window.copyMpScheduleText = function (identifier) {
    const mp = mpScheduleList.find(item => item.id === identifier || item.name === identifier);
    if (!mp) return;

    let scheduleLines = [];
    mpScheduleDateCols.forEach(dc => {
      const rawShift = mp.shifts[dc.colIndex] || 'OFF';
      const formatted = formatShiftFull(rawShift);
      scheduleLines.push(`• *${dc.fullLabel}*: ${formatted}`);
    });

    const lines = [
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `📅 *JADWAL SHIFT KERJA MANPOWER MTG*`,
      `🏢 Hub Lokasi: *MTG - Menteng 2026*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 *Nama*: ${mp.name}`,
      `🆔 *ID*: ${mp.id || '-'}`,
      `🏷️ *Jabatan*: ${mp.role}`,
      `📌 *Job Desk*: ${mp.jobDesk}`,
      `💼 *Total Hari Kerja*: ${mp.hkCount} Hari`,
      `🏖️ *Total Off Day*: ${mp.offCount} Hari`,
      `───────────────────────`,
      `📋 *RINCIAN JADWAL*:`,
      ...scheduleLines,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `_Generated via Super App MTG_`
    ].join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(() => {
        showDccToast('success', 'Jadwal MP Disalin!', `Jadwal ${mp.name} berhasil disalin ke clipboard.`);
      }).catch(() => {
        fallbackCopyText(lines, mp.name);
      });
    } else {
      fallbackCopyText(lines, mp.name);
    }
  };

  window.copyDailyRosterText = function () {
    const activeDateMeta = mpScheduleDateCols.find(dc => dc.colIndex === selectedDateColIdx) || mpScheduleDateCols[0];
    if (!activeDateMeta) return;

    const pagi = [];
    const siang = [];
    const malam = [];
    const off = [];

    mpScheduleList.forEach(mp => {
      const shiftVal = mp.shifts[activeDateMeta.colIndex] || 'OFF';
      const cat = getShiftCategory(shiftVal);
      const formatted = formatShiftFull(shiftVal);
      const line = `  - ${mp.name} (${formatted})`;

      if (cat === 'pagi') pagi.push(line);
      else if (cat === 'siang') siang.push(line);
      else if (cat === 'malam') malam.push(line);
      else off.push(`  - ${mp.name}`);
    });

    const lines = [
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `📋 *DAILY ROSTER OPERASIONAL MTG*`,
      `📅 *Tanggal: ${activeDateMeta.fullLabel}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `☀️ *SHIFT PAGI & MID (${pagi.length} MP)*:`,
      pagi.length > 0 ? pagi.join('\n') : '  -(Tidak ada)-',
      ``,
      `🌤️ *SHIFT SIANG (${siang.length} MP)*:`,
      siang.length > 0 ? siang.join('\n') : '  -(Tidak ada)-',
      ``,
      `🌙 *SHIFT MALAM (${malam.length} MP)*:`,
      malam.length > 0 ? malam.join('\n') : '  -(Tidak ada)-',
      ``,
      `🏖️ *OFF DAY / LIBUR (${off.length} MP)*:`,
      off.length > 0 ? off.join('\n') : '  -(Tidak ada)-',
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 *Total Bertugas: ${pagi.length + siang.length + malam.length} MP*`,
      `_Generated via Super App MTG_`
    ].join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(() => {
        showDccToast('success', 'Roster Harian Disalin!', `Roster ${activeDateMeta.fullLabel} berhasil disalin.`);
      }).catch(() => {
        fallbackCopyText(lines, 'Roster Harian');
      });
    } else {
      fallbackCopyText(lines, 'Roster Harian');
    }
  };

  window.printMpSchedule = function () {
    triggerNativePrint('print-mode-mps-daily', 'Roster_Harian_MTG');
  };

  // ══════════════════════════════════════════════
  //  IN-APP UPDATE & VERSION CHECKING ENGINE
  // ══════════════════════════════════════════════

  const APP_VERSION_CODE = 17; // Local current version code (v1.2.2 Master OTA)
  const APP_VERSION_NAME = '1.2.2';
  const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/tw1nss/superapp-release/main/version.json';

  let currentUpdateData = null;
  let isCheckingUpdate = false;

  function getLocalAppVersion() {
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.getAppVersionCode === 'function') {
      try {
        const code = window.AndroidUpdateBridge.getAppVersionCode();
        const name = window.AndroidUpdateBridge.getAppVersionName() || APP_VERSION_NAME;
        return { versionCode: code, versionName: name, isNativeAndroid: true };
      } catch (e) {
        console.warn('Error reading native version:', e);
      }
    }
    return { versionCode: APP_VERSION_CODE, versionName: APP_VERSION_NAME, isNativeAndroid: false };
  }

  function updateHomeVersionDisplay() {
    const local = getLocalAppVersion();
    const el = document.getElementById('homeAppVersionText');
    if (el) {
      el.textContent = `v${local.versionName}`;
    }
  }

  window.checkForAppUpdates = async function (isManual = false) {
    if (isCheckingUpdate) return;
    isCheckingUpdate = true;

    const chip = document.querySelector('.home-version-chip');
    const dot = chip ? chip.querySelector('.home-version-dot') : null;
    const versionTextEl = document.getElementById('homeAppVersionText');

    try {
      const local = getLocalAppVersion();
      updateHomeVersionDisplay();

      if (isManual) {
        if (dot) dot.style.animation = 'pulse-dot 0.6s infinite alternate';
        if (versionTextEl) versionTextEl.textContent = 'Memeriksa...';
        showGlobalToast('info', 'Memeriksa Pembaruan', 'Menghubungi server rilis GitHub...');
      }

      let manifest = null;

      // 1. Coba fetch dari jsDelivr CDN (zero cache latency)
      try {
        const jsdRes = await fetch(`https://cdn.jsdelivr.net/gh/tw1nss/superapp-release@main/version.json?_t=${Date.now()}`, { cache: 'no-store' });
        if (jsdRes.ok) {
          manifest = await jsdRes.json();
        }
      } catch (e) { }

      // 2. Fallback ke GitHub REST API (realtime commit contents)
      if (!manifest || !manifest.versionCode) {
        try {
          const apiRes = await fetch(`https://api.github.com/repos/tw1nss/superapp-release/contents/version.json?_t=${Date.now()}`, { cache: 'no-store' });
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData && apiData.content) {
              manifest = JSON.parse(atob(apiData.content.replace(/\s/g, '')));
            }
          }
        } catch (e) { }
      }

      // 3. Fallback ke raw github
      if (!manifest || !manifest.versionCode) {
        try {
          const res = await fetch(`${UPDATE_MANIFEST_URL}?_t=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            manifest = await res.json();
          }
        } catch (e) { }
      }

      if (!manifest || !manifest.versionCode) {
        if (isManual) {
          showGlobalToast('warning', 'Gagal Memeriksa', 'Tidak dapat terhubung ke server pembaruan.');
        }
        return;
      }

      currentUpdateData = manifest;

      const remoteCode = parseInt(manifest.versionCode, 10) || 0;
      const localCode = local.versionCode;

      if (remoteCode > localCode) {
        // Update available!
        showAppUpdateModal(manifest, local);
      } else {
        if (isManual) {
          showAppAlreadyLatestModal(manifest, local);
        }
      }
    } catch (err) {
      console.warn('Check update error:', err);
      if (isManual) {
        showGlobalToast('error', 'Koneksi Gagal', 'Periksa koneksi internet Anda.');
      }
    } finally {
      isCheckingUpdate = false;
      if (dot) dot.style.animation = '';
      if (versionTextEl && isManual) {
        updateHomeVersionDisplay();
      }
    }
  };

  function showAppAlreadyLatestModal(manifest, local) {
    const modal = document.getElementById('appAlreadyLatestModal');
    if (!modal) {
      showGlobalToast('success', 'Versi Terbaru', `Aplikasi Anda (v${local.versionName}) sudah versi terbaru!`);
      return;
    }
    const badge = document.getElementById('alreadyLatestBadge');
    const sub = document.getElementById('alreadyLatestSubtitle');
    if (badge) badge.textContent = `Versi Aktif: v${local.versionName} (Build ${local.versionCode})`;
    if (sub) sub.textContent = manifest.title || 'Super App MTG sudah versi paling mutakhir';
    modal.classList.remove('hidden');
  }

  window.closeAppAlreadyLatestModal = function () {
    const m = document.getElementById('appAlreadyLatestModal');
    if (m) m.classList.add('hidden');
  };

  window.forceDownloadLatestApk = function () {
    const apkUrl = (currentUpdateData && currentUpdateData.apkUrl) || 'https://github.com/tw1nss/superapp-release/raw/main/app-debug.apk';
    closeAppAlreadyLatestModal();
    showGlobalToast('info', 'Mengunduh APK', 'Memulai pengunduhan APK terbaru otomatis...');
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.startDownloadAndInstall === 'function') {
      window.AndroidUpdateBridge.startDownloadAndInstall(apkUrl);
    } else {
      const link = document.createElement('a');
      link.href = apkUrl;
      link.download = 'SuperAppMTG_latest.apk';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  function showAppUpdateModal(manifest, local) {
    const modal = document.getElementById('appUpdateModal');
    if (!modal) return;

    const titleEl = document.getElementById('updateModalTitle');
    const badgeNew = document.getElementById('updateBadgeNew');
    const badgeCur = document.getElementById('updateBadgeCurrent');
    const changelogEl = document.getElementById('updateChangelogList');
    const btnDismiss = document.getElementById('btnUpdateDismiss');
    const btnNow = document.getElementById('btnUpdateNow');
    const progressWrap = document.getElementById('updateDownloadProgressWrap');
    const progressBar = document.getElementById('updateProgressBarFill');

    if (titleEl) titleEl.textContent = manifest.title || 'Pembaruan Tersedia!';
    if (badgeNew) badgeNew.textContent = `Versi Baru: v${manifest.versionName || 'Terbaru'}`;
    if (badgeCur) badgeCur.textContent = `Versi Anda: v${local.versionName}`;

    if (progressWrap) progressWrap.classList.add('hidden');
    if (progressBar) {
      progressBar.classList.remove('is-determinate');
      progressBar.style.width = '0%';
    }

    if (btnNow) {
      btnNow.disabled = false;
      btnNow.innerHTML = '<span>Update Sekarang</span> &rarr;';
    }

    if (changelogEl) {
      const items = Array.isArray(manifest.changelog) && manifest.changelog.length > 0
        ? manifest.changelog
        : ['Peningkatan performa dan kestabilan sistem.'];
      changelogEl.innerHTML = items.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    }

    // If forceUpdate is true, hide dismiss button
    if (btnDismiss) {
      btnDismiss.classList.toggle('hidden', !!manifest.forceUpdate);
    }

    modal.classList.remove('hidden');
  }

  window.dismissAppUpdate = function () {
    const modal = document.getElementById('appUpdateModal');
    if (modal) modal.classList.add('hidden');
  };

  // ── Callbacks dipanggil otomatis oleh AndroidUpdateBridge (Native) ──
  window.onUpdateDownloadProgress = function (percent, text) {
    const progressWrap = document.getElementById('updateDownloadProgressWrap');
    const progressBar = document.getElementById('updateProgressBarFill');
    const progressText = document.getElementById('updateProgressText');
    const btnNow = document.getElementById('btnUpdateNow');

    if (progressWrap) progressWrap.classList.remove('hidden');
    if (progressBar && percent >= 0) {
      progressBar.classList.add('is-determinate');
      progressBar.style.width = Math.min(Math.max(percent, 0), 100) + '%';
    }
    if (progressText) {
      progressText.textContent = text ? `Mengunduh: ${text}` : `Mengunduh... ${percent}%`;
    }
    if (btnNow) {
      btnNow.disabled = true;
      btnNow.innerHTML = `<span>Mengunduh (${percent >= 0 ? percent + '%' : '...'})</span>`;
    }
  };

  window.onUpdateDownloadComplete = function () {
    const progressBar = document.getElementById('updateProgressBarFill');
    const progressText = document.getElementById('updateProgressText');
    const btnNow = document.getElementById('btnUpdateNow');

    if (progressBar) {
      progressBar.classList.add('is-determinate');
      progressBar.style.width = '100%';
    }
    if (progressText) {
      progressText.innerHTML = '✅ <strong>Unduhan Selesai 100%!</strong> Membuka installer Android...';
    }
    if (btnNow) {
      btnNow.disabled = true;
      btnNow.innerHTML = '<span>✅ Membuka Installer...</span>';
    }
  };

  window.onUpdateDownloadError = function (errorMsg) {
    const progressText = document.getElementById('updateProgressText');
    const btnNow = document.getElementById('btnUpdateNow');

    if (progressText) {
      progressText.innerHTML = `<span style="color:#ef4444;">❌ Gagal: ${errorMsg || 'Koneksi terputus'}</span>`;
    }
    if (btnNow) {
      btnNow.disabled = false;
      btnNow.innerHTML = '<span>Coba Lagi</span> &rarr;';
    }
    showGlobalToast('error', 'Gagal Mengunduh', errorMsg || 'Gagal mengunduh berkas APK pembaruan.');
  };

  window.triggerAppUpdate = function () {
    if (!currentUpdateData || !currentUpdateData.apkUrl) {
      alert('Tautan pembaruan tidak tersedia.');
      return;
    }

    const apkUrl = currentUpdateData.apkUrl;
    const progressWrap = document.getElementById('updateDownloadProgressWrap');
    const progressBar = document.getElementById('updateProgressBarFill');
    const btnNow = document.getElementById('btnUpdateNow');
    const progressText = document.getElementById('updateProgressText');

    if (progressWrap) progressWrap.classList.remove('hidden');
    if (progressBar) {
      progressBar.classList.remove('is-determinate');
      progressBar.style.width = '100%';
    }
    if (progressText) progressText.textContent = 'Memulai pengunduhan APK otomatis...';
    if (btnNow) {
      btnNow.disabled = true;
      btnNow.innerHTML = '<span>Menghubungkan...</span>';
    }

    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.startDownloadAndInstall === 'function') {
      try {
        window.AndroidUpdateBridge.startDownloadAndInstall(apkUrl);
      } catch (e) {
        console.error('Bridge call error:', e);
        window.location.href = apkUrl;
      }
    } else {
      // Browser / PWA fallback
      if (progressText) progressText.textContent = 'Mengunduh APK via peramban web...';
      const link = document.createElement('a');
      link.href = apkUrl;
      link.download = 'SuperAppMTG_latest.apk';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => {
        if (progressText) progressText.textContent = 'Berkas sedang diunduh. Silakan buka file APK setelah selesai.';
        if (btnNow) {
          btnNow.disabled = false;
          btnNow.innerHTML = '<span>Unduh Lagi</span>';
        }
      }, 1500);
    }
  };

  let globalToastTimeout = null;
  function showGlobalToast(type, title, message) {
    const toast = document.getElementById('globalToast');
    const iconEl = document.getElementById('globalToastIcon');
    const titleEl = document.getElementById('globalToastTitle');
    const msgEl = document.getElementById('globalToastMessage');

    if (toast && iconEl && titleEl && msgEl) {
      const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
      };
      iconEl.textContent = icons[type] || 'ℹ️';
      titleEl.textContent = title;
      msgEl.textContent = message;

      toast.classList.remove('hidden');
      if (globalToastTimeout) clearTimeout(globalToastTimeout);
      globalToastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
      }, 4000);
      return;
    }

    if (typeof showDccToast === 'function') {
      showDccToast(type, title, message);
    } else {
      alert(`${title}: ${message}`);
    }
  }

  // ══════════════════════════════════════════════
  //  EXPIRED DATE SWEEPER (EDS) MODULE ENGINE
  // ══════════════════════════════════════════════

  const EDS_SPREADSHEET_ID = '17CgSdhmrp-pRSaiudQvtBGu7wCpWXUdnCV4aP53sK-A';
  const EDS_BASE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${EDS_SPREADSHEET_ID}/gviz/tq?tqx=out:csv`;
  const EDS_MAIN_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Main List SKU');
  const EDS_HASIL_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Hasil EDS');
  const EDS_UPDATE_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Data Update');
  const EDS_REPORT_URL = EDS_BASE_SHEET_URL + '&sheet=Report';
  const EDS_DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbztOsGIAVVfd2SjvkW_euEa7PyU76A4_PJ0HdJgw80eUOHe4XuRuLKoftL9ZxgrDfFLcw/exec';

  const EDS_MAIN_CACHE_KEY = 'EDS_MAIN_CACHE_MTG_V3';
  const EDS_SUBMITTED_CACHE_KEY = 'EDS_SUBMITTED_CACHE_MTG_V3';
  const EDS_PIC_KEY = 'EDS_DEFAULT_PIC_V2';
  const EDS_WEBAPP_KEY = 'EDS_CUSTOM_WEBAPP_URL_V3';

  // Bersihkan cache usang V2 agar tidak ada status Done hantu yang nyangkut
  try {
    localStorage.removeItem('EDS_MAIN_CACHE_MTG_V2');
    localStorage.removeItem('EDS_SUBMITTED_CACHE_MTG_V2');
    localStorage.removeItem('EDS_MAIN_CACHE_MTG');
    localStorage.removeItem('EDS_SUBMITTED_CACHE_MTG');
    localStorage.removeItem('EDS_CUSTOM_WEBAPP_URL_V2');
    localStorage.removeItem('EDS_OFFLINE_QUEUE_LOCAL');
  } catch (e) { }

  let currentEdsTab = 'main'; // 'main' | 'scan' | 'report'
  let currentEdsStatusFilter = 'all'; // 'all' | 'submitted' | 'pending'
  let currentEdsAlertFilter = 'all'; // 'all' | 'warning' | 'safe'
  let currentEdsCategoryFilter = 'all';
  let currentEdsSort = 'days_asc'; // 'days_asc' | 'name_asc' | 'sloc_asc' | 'stock_desc'
  let isEdsFetching = false;

  let edsMainListData = [];
  let edsSubmittedSkuSet = new Set();
  let edsAuditResultsMap = new Map(); // sku -> { done, remaks, fisikGood, fisikBad, actualSloc, expiredDate, pic, timestamp }
  let edsHasilRows = [];
  let edsPhotoList = [];
  let selectedEdsSku = null;
  let edsFlatpickrInstance = null;

  // ── Helper: Excel Serial Date to YYYY-MM-DD / DD-MM-YYYY ──
  function excelDateToDateStr(val) {
    if (!val) return '';
    const num = Number(val);
    if (!isNaN(num) && num > 30000 && num < 60000) {
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const [d, m, y] = str.split('/');
      return `${y}-${m}-${d}`;
    }
    return str;
  }

  function formatEdsDateDisplay(val) {
    if (!val) return '-';
    const standard = excelDateToDateStr(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(standard)) {
      const [y, m, d] = standard.split('-');
      return `${d}/${m}/${y}`;
    }
    return standard;
  }

  function getEdsWebappUrl() {
    try {
      localStorage.removeItem(EDS_WEBAPP_KEY);
    } catch (e) { }
    return EDS_DEFAULT_WEBAPP_URL;
  }

  function updateEdsWebappBannerStatus() {
    const url = getEdsWebappUrl();
    const banner = document.getElementById('edsWebappBanner');
    const statusEl = document.getElementById('edsWebappBannerStatus');
    if (!banner || !statusEl) return;

    if (url && url.startsWith('https://script.google.com/macros/s/')) {
      banner.className = 'eds-webapp-banner connected';
      statusEl.innerHTML = '✅ <span style="color:#34d399; font-weight:600;">Terhubung Otomatis ke Spreadsheet Hasil EDS</span>';
    } else {
      banner.className = 'eds-webapp-banner not-connected';
      statusEl.innerHTML = '⚠️ <span style="color:#fbbf24; font-weight:600;">Belum Disambungkan</span>';
    }
  }

  window.saveEdsWebappUrl = function () {
    const input = document.getElementById('edsWebappUrlInput');
    if (!input) return;
    const url = input.value.trim();
    if (!url) {
      localStorage.removeItem(EDS_WEBAPP_KEY);
      showDccToast('info', 'Reset WebApp URL', 'URL WebApp telah dihapus.');
    } else {
      if (!url.startsWith('https://script.google.com/macros/s/')) {
        showDccToast('warning', 'Format URL Salah', 'URL WebApp harus berawalan: https://script.google.com/macros/s/...');
        return;
      }
      localStorage.setItem(EDS_WEBAPP_KEY, url);
      showDccToast('success', 'URL Disimpan!', 'WebApp spreadsheet Hasil EDS berhasil tersambung!');
    }
    updateEdsWebappBannerStatus();
    closeEdsSetupModal();
  };

  window.openEdsSetupModal = function () {
    const modal = document.getElementById('edsSetupModal');
    const input = document.getElementById('edsWebappUrlInput');
    if (modal) {
      modal.classList.remove('hidden');
      if (input) input.value = getEdsWebappUrl();
    }
  };

  window.closeEdsSetupModal = function () {
    const modal = document.getElementById('edsSetupModal');
    if (modal) modal.classList.add('hidden');
  };

  // ── EDS Offline Queue & Auto-Sync Engine ──
  const EDS_OFFLINE_DB_NAME = 'EDS_OFFLINE_DB_MTG_V1';
  const EDS_OFFLINE_STORE = 'queue';
  let isSyncingEdsOfflineQueue = false;

  function openEdsOfflineDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(EDS_OFFLINE_DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(EDS_OFFLINE_STORE)) {
            db.createObjectStore(EDS_OFFLINE_STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function addToEdsOfflineQueue(payload) {
    try {
      const db = await openEdsOfflineDb();
      const itemToSave = { ...payload, queuedAt: Date.now() };
      if (!db) {
        const list = safeJsonParse(localStorage.getItem('EDS_OFFLINE_QUEUE_LOCAL'), []);
        itemToSave.id = Date.now();
        list.push(itemToSave);
        localStorage.setItem('EDS_OFFLINE_QUEUE_LOCAL', JSON.stringify(list));
        updateEdsOfflineQueueBadge();
        return;
      }
      const tx = db.transaction([EDS_OFFLINE_STORE], 'readwrite');
      const store = tx.objectStore(EDS_OFFLINE_STORE);
      store.add(itemToSave);
      tx.oncomplete = () => {
        updateEdsOfflineQueueBadge();
      };
    } catch (e) {
      console.warn('Gagal menyimpan ke offline queue EDS:', e);
    }
  }

  async function getEdsOfflineQueueItems() {
    try {
      const db = await openEdsOfflineDb();
      if (!db) {
        return safeJsonParse(localStorage.getItem('EDS_OFFLINE_QUEUE_LOCAL'), []);
      }
      return new Promise((resolve) => {
        const tx = db.transaction([EDS_OFFLINE_STORE], 'readonly');
        const store = tx.objectStore(EDS_OFFLINE_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  async function removeEdsOfflineQueueItem(id) {
    try {
      const db = await openEdsOfflineDb();
      if (!db) {
        let list = safeJsonParse(localStorage.getItem('EDS_OFFLINE_QUEUE_LOCAL'), []);
        list = list.filter(i => i.id !== id);
        localStorage.setItem('EDS_OFFLINE_QUEUE_LOCAL', JSON.stringify(list));
        updateEdsOfflineQueueBadge();
        return;
      }
      const tx = db.transaction([EDS_OFFLINE_STORE], 'readwrite');
      tx.objectStore(EDS_OFFLINE_STORE).delete(id);
      tx.oncomplete = () => {
        updateEdsOfflineQueueBadge();
      };
    } catch (e) { }
  }

  async function updateEdsOfflineQueueBadge() {
    const items = await getEdsOfflineQueueItems();
    const count = items.length;
    const badge = document.getElementById('edsOfflineQueueBadge');
    if (badge) {
      if (count > 0) {
        badge.classList.remove('hidden');
        badge.innerHTML = `⚡ <strong>${count}</strong> Data Offline (Sync)`;
        badge.title = `${count} data tersimpan di HP. Klik untuk kirim ke Google Sheet sekarang.`;
      } else {
        badge.classList.add('hidden');
        badge.innerHTML = '';
      }
    }
  }

  window.syncEdsOfflineQueue = async function (isManual = false) {
    if (isSyncingEdsOfflineQueue) return;
    const items = await getEdsOfflineQueueItems();
    if (items.length === 0) {
      if (isManual) {
        showDccToast('info', 'Semua Data Terkirim', 'Tidak ada antrean audit offline yang tertunda.');
      }
      return;
    }

    if (!navigator.onLine) {
      if (isManual) {
        playWarningBeep();
        showDccToast('warning', 'Masih Offline', 'Koneksi internet belum tersedia. Data Anda tetap tersimpan di memori HP.');
      }
      return;
    }

    isSyncingEdsOfflineQueue = true;
    const badge = document.getElementById('edsOfflineQueueBadge');
    if (badge) badge.innerHTML = `🔄 Mengirim ${items.length} data...`;

    let successCount = 0;
    for (const item of items) {
      try {
        const payloadToSend = { ...item };
        delete payloadToSend.id;
        delete payloadToSend.queuedAt;

        await fetch(getEdsWebappUrl(), {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payloadToSend)
        });

        await removeEdsOfflineQueueItem(item.id);
        successCount++;
      } catch (err) {
        console.warn('Sync EDS item failed:', err);
        break;
      }
    }

    isSyncingEdsOfflineQueue = false;
    await updateEdsOfflineQueueBadge();

    if (successCount > 0) {
      playSaveSuccessChime();
      showDccToast('success', 'Auto-Sync Berhasil!', `${successCount} data audit expired date berhasil disinkronkan ke Sheet MTG.`);
    }
  };

  window.addEventListener('online', () => {
    syncEdsOfflineQueue();
  });
  setInterval(() => {
    if (navigator.onLine) syncEdsOfflineQueue();
  }, 25000);
  setTimeout(updateEdsOfflineQueueBadge, 1500);

  // ── Tab Switcher ──
  window.switchEdsTab = function (tabName) {
    currentEdsTab = tabName;
    document.querySelectorAll('.eds-tab-content').forEach(tab => {
      tab.classList.remove('active');
      tab.classList.remove('hidden');
    });
    document.querySelectorAll('.eds-nav-item').forEach(nav => nav.classList.remove('active'));

    if (tabName === 'main') {
      const el = document.getElementById('edsTabMainList');
      if (el) el.classList.add('active');
      const nav = document.getElementById('navEdsMain');
      if (nav) nav.classList.add('active');
    } else if (tabName === 'scan') {
      const el = document.getElementById('edsTabScan');
      if (el) {
        el.classList.add('active');
        el.scrollTop = 0;
      }
      const nav = document.getElementById('navEdsScan');
      if (nav) nav.classList.add('active');
      initEdsFlatpickr();
      loadEdsSavedPic();
      updateEdsWebappBannerStatus();
      window.scrollTo({ top: 0, behavior: 'instant' });
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      const ws = document.getElementById('edSweeperWorkspace');
      if (ws) ws.scrollTop = 0;
    } else if (tabName === 'report') {
      const el = document.getElementById('edsTabReport');
      if (el) el.classList.add('active');
      const nav = document.getElementById('navEdsReport');
      if (nav) nav.classList.add('active');
      renderEdsReport();
    }
  };

  window.handleEdsBackPressed = function () {
    if (currentEdsTab !== 'main') {
      switchEdsTab('main');
      return;
    }
    goBackToMenu();
  };

  // ── Real-Time MSLTC & Expired Date Calculation Helper ──
  function updateEdsMsltcHelperFromDate(dateVal) {
    const helper = document.getElementById('edsMsltcHelper');
    if (!helper) return;

    if (!dateVal) {
      helper.textContent = '';
      return;
    }

    const cleanDateStr = excelDateToDateStr(dateVal);
    let expObj = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDateStr)) {
      const [y, m, d] = cleanDateStr.split('-').map(Number);
      expObj = new Date(y, m - 1, d);
    } else if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
      expObj = new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate());
    }

    if (!expObj) {
      helper.textContent = '';
      return;
    }

    const skuInput = document.getElementById('edsSkuInput');
    const sku = (skuInput?.value || selectedEdsSku || '').trim().toLowerCase();
    const item = edsMainListData.find(i => i.sku.toLowerCase() === sku) || {};

    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Hitung Sisa Hari menuju Expired
    const daysToExpire = Math.round((expObj.getTime() - todayMid.getTime()) / 86400000);

    // Standar MSLTC produk (ambil dari data sheet, atau default 7 hari)
    let msltcDays = 7;
    if (item.msltc !== undefined && item.msltc !== null && item.msltc !== '' && !isNaN(Number(item.msltc))) {
      msltcDays = Number(item.msltc);
    } else if (item.msltcDays && !isNaN(Number(item.msltcDays))) {
      msltcDays = Number(item.msltcDays);
    }

    // Hitung Batas Tanggal MSLTC (Expired Date minus Standar MSLTC)
    const msltcDateObj = new Date(expObj.getTime() - (msltcDays * 86400000));
    const daysToMsltc = Math.round((msltcDateObj.getTime() - todayMid.getTime()) / 86400000);

    const expText = daysToExpire >= 0 ? `${daysToExpire} hari` : `${Math.abs(daysToExpire)} hari lewat`;
    const msText = daysToMsltc >= 0 ? `${daysToMsltc} hari` : `${Math.abs(daysToMsltc)} hari lewat`;

    const my = msltcDateObj.getFullYear();
    const mm = String(msltcDateObj.getMonth() + 1).padStart(2, '0');
    const md = String(msltcDateObj.getDate()).padStart(2, '0');
    const msDateFormatted = `${md}/${mm}/${my}`;

    const ey = expObj.getFullYear();
    const em = String(expObj.getMonth() + 1).padStart(2, '0');
    const ed = String(expObj.getDate()).padStart(2, '0');
    const expDateFormatted = `${ed}/${em}/${ey}`;

    let msColor = '#38bdf8';
    if (daysToMsltc <= 0) {
      msColor = '#f87171'; // Critical
    } else if (daysToMsltc === 1) {
      msColor = '#fb923c'; // Hard warning
    } else if (daysToMsltc <= 3) {
      msColor = '#fde047'; // Warning
    }

    helper.innerHTML = `<span style="color:${msColor}; font-weight:700;">MSLTC: ${msDateFormatted} (${msText})</span> | <span style="color:#93c5fd; font-weight:600;">Expired: ${expDateFormatted} (${expText})</span>`;
  }

  // ── Flatpickr Initialization ──
  function initEdsFlatpickr() {
    const input = document.getElementById('edsExpiredDate');
    if (!input) return;

    if (!edsFlatpickrInstance && typeof flatpickr !== 'undefined') {
      try {
        edsFlatpickrInstance = flatpickr(input, {
          dateFormat: 'Y-m-d',
          altInput: true,
          altFormat: 'd/m/Y',
          allowInput: true,
          locale: typeof flatpickr.l10ns !== 'undefined' && flatpickr.l10ns.id ? flatpickr.l10ns.id : 'default',
          onChange: function (selectedDates, dateStr) {
            updateEdsMsltcHelperFromDate(dateStr || (selectedDates[0] ? selectedDates[0] : ''));
          }
        });
      } catch (e) {
        console.warn('Flatpickr init error:', e);
      }
    }

    // Input listeners for direct typing or change
    input.removeEventListener('change', handleEdsExpiredDateInput);
    input.removeEventListener('input', handleEdsExpiredDateInput);
    input.addEventListener('change', handleEdsExpiredDateInput);
    input.addEventListener('input', handleEdsExpiredDateInput);
  }

  function handleEdsExpiredDateInput(e) {
    updateEdsMsltcHelperFromDate(e.target.value);
  }

  // ── Data Fetching Engine ──
  window.refreshEdsData = async function () {
    const btn = document.querySelector('.eds-refresh-btn');
    if (btn) btn.classList.add('spinning');
    try {
      showDccToast('info', 'Menyinkronkan...', 'Mengambil data terbaru dari Google Sheets...');
      await fetchEdSweeperData(true);
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  };

  async function fetchEdSweeperData(forceRefresh = false) {
    if (isEdsFetching) return;
    isEdsFetching = true;

    // Load from cache first for zero-wait rendering
    if (forceRefresh) {
      try {
        localStorage.removeItem(EDS_MAIN_CACHE_KEY);
      } catch (e) { }
    } else {
      try {
        const cached = localStorage.getItem(EDS_MAIN_CACHE_KEY);
        const subCached = localStorage.getItem(EDS_SUBMITTED_CACHE_KEY);
        if (subCached) {
          edsSubmittedSkuSet = new Set(safeJsonParse(subCached, []));
        }
        if (cached) {
          edsMainListData = safeJsonParse(cached, []);
          filterEdSweeperList();
          renderEdsReport();
        }
      } catch (e) { }
    }

    const container = document.getElementById('edsCardContainer');
    if (edsMainListData.length === 0 && container) {
      container.innerHTML = '<div style="text-align:center; padding: 35px; color: #fbbf24;">⚡ Menghubungkan ke Spreadsheet ED Sweeper MTG...</div>';
    }

    try {
      const t = Date.now();
      const nonce = Math.floor(Math.random() * 1000000);
      const fetchOpts = {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      };
      const [hasilRes, mainRes, updateRes] = await Promise.all([
        fetch(`${EDS_HASIL_URL}&_t=${t}&_r=${nonce}`, fetchOpts).then(r => r.ok ? r.text() : '').catch(() => ''),
        fetch(`${EDS_MAIN_URL}&_t=${t}&_r=${nonce}`, fetchOpts).then(r => r.ok ? r.text() : '').catch(() => ''),
        fetch(`${EDS_UPDATE_URL}&_t=${t}&_r=${nonce}`, fetchOpts).then(r => r.ok ? r.text() : '').catch(() => '')
      ]);

      // 1. Parse Data Update untuk fallback referensi jika rumus Main List #ERROR!
      const updateDataLookupMap = new Map();
      if (updateRes) {
        const updateLines = parseCSV(updateRes);
        if (updateLines && updateLines.length > 1) {
          const upHeader = updateLines[0].map(h => String(h || '').trim().toLowerCase());
          const colSku = upHeader.indexOf('sku_number') !== -1 ? upHeader.indexOf('sku_number') : 0;
          const colName = upHeader.indexOf('product_name') !== -1 ? upHeader.indexOf('product_name') : 1;
          const colLoc = upHeader.indexOf('location_name') !== -1 ? upHeader.indexOf('location_name') : 2;
          const colExp = upHeader.indexOf('expiry_date') !== -1 ? upHeader.indexOf('expiry_date') : 4;
          const colMsltc = upHeader.indexOf('msltc') !== -1 ? upHeader.indexOf('msltc') : 5;
          const colQty = upHeader.indexOf('qty_system') !== -1 ? upHeader.indexOf('qty_system') : 6;
          const colRack = upHeader.indexOf('rack_name') !== -1 ? upHeader.indexOf('rack_name') : 7;
          const colCat1 = upHeader.indexOf('l1_category_name') !== -1 ? upHeader.indexOf('l1_category_name') : 8;
          const colCat2 = upHeader.indexOf('l2_category_name') !== -1 ? upHeader.indexOf('l2_category_name') : 9;
          const colMsDate = upHeader.indexOf('msltc_date') !== -1 ? upHeader.indexOf('msltc_date') : 10;
          const colRemDays = upHeader.indexOf('remaining days') !== -1 ? upHeader.indexOf('remaining days') : 11;
          const colAlert = upHeader.indexOf('alert') !== -1 ? upHeader.indexOf('alert') : 12;

          for (let u = 1; u < updateLines.length; u++) {
            const uRow = updateLines[u];
            if (!uRow || uRow.length === 0) continue;
            const uSku = String(uRow[colSku] || '').trim().toLowerCase();
            if (uSku) {
              updateDataLookupMap.set(uSku, {
                productName: uRow[colName] || '',
                hub: uRow[colLoc] || '',
                expiryDateRaw: uRow[colExp],
                msltcDays: uRow[colMsltc] || '',
                qtySystem: Number(uRow[colQty]) || 0,
                rackName: uRow[colRack] || '',
                l1Category: uRow[colCat1] || '',
                l2Category: uRow[colCat2] || '',
                msltcDateRaw: uRow[colMsDate],
                remainingDays: Number(uRow[colRemDays]) || 999,
                alertText: uRow[colAlert] || ''
              });
            }
          }
        }
      }

      // 2. Parse Hasil EDS (Dedup: 1 SKU hanya 1 catatan terbaru)
      edsAuditResultsMap.clear();
      edsHasilRows = [];
      edsSubmittedSkuSet.clear();
      if (hasilRes) {
        const hasilLines = parseCSV(hasilRes);
        if (hasilLines && hasilLines.length > 1) {
          const deduplicatedMap = new Map();
          for (let i = 1; i < hasilLines.length; i++) {
            const row = hasilLines[i];
            if (!row || row.length === 0) continue;
            const sku = String(row[0] || row[16] || '').trim();
            if (!sku) continue;

            const auditObj = {
              sku: sku,
              namaSku: row[1] || '',
              slocExisting: row[2] || '',
              slocActual: row[3] || 'Match',
              expiredDate: excelDateToDateStr(row[4]),
              fisikGood: row[5] !== '' && row[5] !== undefined ? Number(row[5]) : 0,
              fisikBad: row[6] !== '' && row[6] !== undefined ? Number(row[6]) : 0,
              sales: row[7] || '',
              reasonSloc: row[8] || '',
              reasonBad: row[9] || '',
              evidanceLink1: row[12] || '',
              evidanceLink2: row[13] || '',
              inputBy: row[17] || '',
              timestamp: row[18] || '',
              remaks: row[9] || row[8] || 'Sesuai'
            };

            // Simpan ke map agar SKU yang sama di-update (menimpa baris lama)
            deduplicatedMap.set(sku.toLowerCase(), auditObj);
          }

          edsHasilRows = Array.from(deduplicatedMap.values()).reverse();
          deduplicatedMap.forEach((val, key) => {
            edsAuditResultsMap.set(key, val);
            edsSubmittedSkuSet.add(key);
          });
        }
      }

      // 3. Parse Main List SKU (Hanya menampilkan SKU tugas yang ada di Main List)
      if (mainRes) {
        const mainLines = parseCSV(mainRes);
        if (mainLines && mainLines.length > 1) {
          const list = [];
          for (let i = 1; i < mainLines.length; i++) {
            const row = mainLines[i];
            if (!row || row.length === 0) continue;
            const cleanSku = String(row[1] || '').trim();
            // FILTER HANYA SKU YANG VALID DI MAIN LIST (Abaikan baris kosong, header, error)
            if (!cleanSku || cleanSku.toLowerCase() === 'sku' || cleanSku.toLowerCase() === 'tanggal' || cleanSku.includes('#ERROR') || cleanSku.length < 3) {
              continue;
            }

            const fallback = updateDataLookupMap.get(cleanSku.toLowerCase()) || {};

            let name = (row[2] || '').trim();
            if (!name || name === '#ERROR!' || name === '#REF!' || name === '#N/A') {
              name = fallback.productName || `SKU ${cleanSku}`;
            }

            let lokasiRack = (row[3] || row[11] || '').trim();
            if (!lokasiRack || lokasiRack === '#ERROR!' || lokasiRack === '#REF!') {
              lokasiRack = fallback.rackName || '-';
            }

            let stockAvail = Number(row[4]);
            if (isNaN(stockAvail) || (row[4] && String(row[4]).includes('#ERROR'))) {
              stockAvail = fallback.qtySystem || 0;
            }

            const stockBad = Number(row[5]) || 0;
            const stockLdp = Number(row[6]) || 0;
            const hub = (row[7] || fallback.hub || 'MTG - Menteng').trim();

            let expiryDateRaw = row[8];
            if (!expiryDateRaw || String(expiryDateRaw).includes('#ERROR')) {
              expiryDateRaw = fallback.expiryDateRaw || '';
            }

            let msltcDays = row[9] || fallback.msltcDays || '';
            let qtySystem = Number(row[10]);
            if (isNaN(qtySystem) || (row[10] && String(row[10]).includes('#ERROR'))) {
              qtySystem = fallback.qtySystem || stockAvail;
            }

            let l1Category = (row[12] || fallback.l1Category || '').trim();
            let l2Category = (row[13] || fallback.l2Category || '').trim();
            let msltcDateRaw = row[14] || fallback.msltcDateRaw || '';

            let remainingDays = Number(row[15]);
            if (isNaN(remainingDays) || (row[15] && String(row[15]).includes('#ERROR'))) {
              remainingDays = fallback.remainingDays !== undefined ? fallback.remainingDays : 999;
            }

            let alertText = (row[16] || '').trim();
            if (!alertText || alertText.includes('#ERROR')) {
              alertText = fallback.alertText || (remainingDays <= 0 ? '🔴 CRITICAL' : (remainingDays === 1 ? '🔴 HARD WARNING' : (remainingDays <= 3 ? '🟡 WARNING' : '🟢 SAFE')));
            }

            // 🎯 FILTER PRODUK DENGAN ALERT WARNING, HARD WARNING, & CRITICAL
            const alertClean = alertText.toLowerCase();
            const isCritical = alertClean.includes('critical') || remainingDays <= 0;
            const isHardWarning = alertClean.includes('hard warning') || alertClean.includes('hard_warning') || remainingDays === 1;
            const isWarning = alertClean.includes('warning') || remainingDays <= 3;
            if (!isCritical && !isHardWarning && !isWarning) {
              continue;
            }

            const sheetDone = (row[17] || '').trim();
            const sheetRemaks = (row[18] || '').trim();
            const sheetFisik = (row[19] || '').trim();

            // ── STATUS HANYA DONE JIKA SKU BENAR-BENAR TERCATAT DI HASIL EDS ──
            let isDone = false;
            let doneVal = 'Belum';
            let remaksVal = '-';
            let fisikSystemVal = '-';

            if (edsAuditResultsMap.has(cleanSku.toLowerCase())) {
              const audit = edsAuditResultsMap.get(cleanSku.toLowerCase());
              isDone = true;
              doneVal = 'Done';
              remaksVal = audit.reasonBad || audit.reasonSloc || audit.remaks || 'Sesuai';
              fisikSystemVal = `${audit.fisikGood}/${qtySystem}`;
              edsSubmittedSkuSet.add(cleanSku.toLowerCase());
            }

            const expDateClean = excelDateToDateStr(expiryDateRaw);
            const msltcDateClean = excelDateToDateStr(msltcDateRaw);

            // Hitung sisa hari dinamis terhadap hari ini
            const now = new Date();
            const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());

            let daysToExpire = null;
            if (expDateClean && /^\d{4}-\d{2}-\d{2}$/.test(expDateClean)) {
              const [ey, em, ed] = expDateClean.split('-').map(Number);
              const expObj = new Date(ey, em - 1, ed);
              daysToExpire = Math.round((expObj.getTime() - todayMid.getTime()) / 86400000);
            }

            let daysToMsltc = remainingDays;
            if (msltcDateClean && /^\d{4}-\d{2}-\d{2}$/.test(msltcDateClean)) {
              const [my, mm, md] = msltcDateClean.split('-').map(Number);
              const msObj = new Date(my, mm - 1, md);
              daysToMsltc = Math.round((msObj.getTime() - todayMid.getTime()) / 86400000);
            } else if (!isNaN(remainingDays)) {
              daysToMsltc = remainingDays;
            }

            if (daysToExpire === null) {
              const msDaysNum = Number(msltcDays) || 0;
              daysToExpire = !isNaN(daysToMsltc) ? (daysToMsltc + msDaysNum) : remainingDays;
            }

            list.push({
              index: i,
              tanggal: row[0] || '',
              sku: cleanSku,
              productName: name,
              lokasiRack: lokasiRack,
              stockAvailable: stockAvail,
              stockBad: stockBad,
              stockLdp: stockLdp,
              hub: hub,
              expiryDate: expDateClean,
              expiryDateRaw: expiryDateRaw,
              msltc: msltcDays,
              qty_system: qtySystem,
              rackName: lokasiRack,
              l1Category: l1Category,
              l2Category: l2Category,
              msltcDate: msltcDateClean,
              remainingDays: daysToMsltc,
              daysToMsltc: daysToMsltc,
              daysToExpire: daysToExpire,
              alert: alertText,
              isDone: isDone,
              doneVal: doneVal,
              remaksVal: remaksVal,
              fisikSystemVal: fisikSystemVal
            });
          }

          if (list.length === 0 && updateDataLookupMap.size > 0) {
            // Fallback: jika Main List SKU di spreadsheet belum diisi supervisor,
            // tampilkan seluruh SKU dari Data Update otomatis agar petugas tetap dapat bertugas
            let idxCounter = 1;
            updateDataLookupMap.forEach((fallback, uSku) => {
              const remDays = fallback.remainingDays !== undefined ? fallback.remainingDays : 999;
              const alertText = fallback.alertText || (remDays <= 0 ? '🔴 CRITICAL' : (remDays === 1 ? '🔴 HARD WARNING' : (remDays <= 3 ? '🟡 WARNING' : '🟢 SAFE')));

              const alertClean = alertText.toLowerCase();
              const isCritical = alertClean.includes('critical') || remDays <= 0;
              const isHardWarning = alertClean.includes('hard') || remDays === 1;
              const isWarning = alertClean.includes('warning') || remDays <= 3;
              if (!isCritical && !isHardWarning && !isWarning) return;

              const isDone = edsAuditResultsMap.has(uSku);
              const audit = isDone ? edsAuditResultsMap.get(uSku) : null;
              const expDateClean = excelDateToDateStr(fallback.expiryDateRaw);
              const msltcDateClean = excelDateToDateStr(fallback.msltcDateRaw);

              const now = new Date();
              const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              let daysToExpire = null;
              if (expDateClean && /^\d{4}-\d{2}-\d{2}$/.test(expDateClean)) {
                const [ey, em, ed] = expDateClean.split('-').map(Number);
                daysToExpire = Math.round((new Date(ey, em - 1, ed) - todayMid) / 86400000);
              }
              let daysToMsltc = remDays;
              if (msltcDateClean && /^\d{4}-\d{2}-\d{2}$/.test(msltcDateClean)) {
                const [my, mm, md] = msltcDateClean.split('-').map(Number);
                daysToMsltc = Math.round((new Date(my, mm - 1, md) - todayMid) / 86400000);
              }

              list.push({
                index: idxCounter++,
                tanggal: '',
                sku: uSku,
                productName: fallback.productName,
                lokasiRack: fallback.rackName,
                stockAvailable: fallback.qtySystem,
                stockBad: 0,
                stockLdp: 0,
                hub: fallback.hub,
                expiryDate: expDateClean,
                expiryDateRaw: fallback.expiryDateRaw,
                msltc: fallback.msltcDays,
                qty_system: fallback.qtySystem,
                rackName: fallback.rackName,
                l1Category: fallback.l1Category,
                l2Category: fallback.l2Category,
                msltcDate: msltcDateClean,
                remainingDays: daysToMsltc,
                daysToMsltc: daysToMsltc,
                daysToExpire: daysToExpire,
                alert: alertText,
                isDone: isDone,
                doneVal: isDone ? 'Done' : 'Belum',
                remaksVal: audit ? (audit.reasonBad || audit.reasonSloc || audit.remaks || 'Sesuai') : '-',
                fisikSystemVal: audit ? `${audit.fisikGood}/${fallback.qtySystem}` : '-'
              });
            });
          }

          if (list.length > 0) {
            edsMainListData = list;
            try {
              localStorage.setItem(EDS_MAIN_CACHE_KEY, JSON.stringify(list));
              localStorage.setItem(EDS_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(edsSubmittedSkuSet)));
            } catch (e) { }
          }
        }
      }

      filterEdSweeperList();
      renderEdsReport();
      if (forceRefresh) {
        showDccToast('success', 'Data Diperbarui', `Berhasil memuat ${edsMainListData.length} SKU tugas dari Main List.`);
      }
    } catch (err) {
      console.warn('Gagal fetch EDS data:', err);
      if (edsMainListData.length === 0 && container) {
        container.innerHTML = '<div style="text-align:center; padding: 30px; color: #ef4444;">Gagal memuat data dari Spreadsheet. Pastikan koneksi internet aktif.</div>';
      }
    } finally {
      isEdsFetching = false;
    }
  }

  // ── Filters & Sorter ──
  window.setEdsStatusFilter = function (status) {
    currentEdsStatusFilter = status;
    document.querySelectorAll('.eds-status-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-status') === status);
    });
    filterEdSweeperList();
  };

  window.setEdsAlertFilter = function (alert) {
    currentEdsAlertFilter = alert;
    document.querySelectorAll('.eds-alert-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-alert') === alert);
    });
    filterEdSweeperList();
  };

  window.setEdsCategoryFilter = function (category) {
    currentEdsCategoryFilter = category;
    document.querySelectorAll('.eds-cat-chip').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-cat') === category);
    });
    filterEdSweeperList();
  };

  window.toggleEdsSort = function (sortKey) {
    currentEdsSort = sortKey;
    document.querySelectorAll('.eds-sort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === 'edsSort' + sortKey.charAt(0).toUpperCase() + sortKey.slice(1).replace('_', ''));
    });
    filterEdSweeperList();
  };

  window.clearEdsFilter = function () {
    const input = document.getElementById('edsFilterInput');
    if (input) {
      input.value = '';
      document.getElementById('edsFilterClearBtn')?.classList.add('hidden');
    }
    filterEdSweeperList();
  };

  // Search input listener with debounce
  const debouncedFilterEds = debounce(filterEdSweeperList, 160);
  document.getElementById('edsFilterInput')?.addEventListener('input', function (e) {
    const val = e.target.value.trim();
    const clearBtn = document.getElementById('edsFilterClearBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', val.length === 0);
    debouncedFilterEds();
  });

  function filterEdSweeperList() {
    const query = (document.getElementById('edsFilterInput')?.value || '').toLowerCase().trim();
    let list = [...edsMainListData];

    // Status filter
    if (currentEdsStatusFilter === 'submitted') {
      list = list.filter(item => item.isDone);
    } else if (currentEdsStatusFilter === 'pending') {
      list = list.filter(item => !item.isDone);
    }


    // Category filter
    if (currentEdsCategoryFilter !== 'all') {
      list = list.filter(item => item.l1Category === currentEdsCategoryFilter);
    }

    // Query search
    if (query) {
      list = list.filter(item => {
        return item.sku.toLowerCase().includes(query) ||
          item.productName.toLowerCase().includes(query) ||
          item.lokasiRack.toLowerCase().includes(query) ||
          item.l1Category.toLowerCase().includes(query) ||
          item.l2Category.toLowerCase().includes(query);
      });
    }

    // Sorting
    list.sort((a, b) => {
      if (currentEdsSort === 'days_asc') {
        const aVal = a.daysToMsltc !== undefined ? a.daysToMsltc : a.remainingDays;
        const bVal = b.daysToMsltc !== undefined ? b.daysToMsltc : b.remainingDays;
        return aVal - bVal;
      }
      if (currentEdsSort === 'name_asc') return a.productName.localeCompare(b.productName);
      if (currentEdsSort === 'sloc_asc') return a.lokasiRack.localeCompare(b.lokasiRack);
      if (currentEdsSort === 'stock_desc') return b.stockAvailable - a.stockAvailable;
      return 0;
    });

    // Update Counter Badges
    const total = edsMainListData.length;
    const doneCount = edsMainListData.filter(i => i.isDone).length;
    const pendingCount = total - doneCount;
    const percentage = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    const countAll = document.getElementById('edsStatusCountAll');
    if (countAll) countAll.textContent = total;
    const countSub = document.getElementById('edsStatusCountSubmitted');
    if (countSub) countSub.textContent = doneCount;
    const countPend = document.getElementById('edsStatusCountPending');
    if (countPend) countPend.textContent = pendingCount;

    const metaBadge = document.getElementById('edsListCountBadge');
    if (metaBadge) metaBadge.textContent = `${doneCount} Selesai / ${total} SKU (${percentage}%)`;
    const barFill = document.getElementById('edsProgressBarFill');
    if (barFill) barFill.style.width = `${percentage}%`;

    renderEdSweeperCards(list);
  }

  let currentEdsRenderLimit = 50;
  let currentEdsListCache = [];

  function renderEdSweeperCards(list, isLoadMore = false) {
    const container = document.getElementById('edsCardContainer');
    if (!container) return;

    if (!isLoadMore) {
      currentEdsListCache = list || [];
      currentEdsRenderLimit = 50;
    }

    if (!currentEdsListCache || currentEdsListCache.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 40px 20px; background: rgba(15,23,42,0.6); border-radius: 16px; border: 1px dashed rgba(255,255,255,0.15);">
          <div style="font-size: 2rem; margin-bottom: 8px;">🔍</div>
          <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">Tidak ada SKU ditemukan</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">Coba ubah kata kunci pencarian atau sesuaikan filter status di atas.</div>
        </div>
      `;
      return;
    }

    const itemsToRender = currentEdsListCache.slice(0, currentEdsRenderLimit);
    const html = itemsToRender.map(item => {
      const isDone = item.isDone;

      // ── DETEKSI ALERT PERSIS DARI SPREADSHEET (🔴 CRITICAL, 🔴 HARD WARNING, 🟡 WARNING, 🟢 SAFE) ──
      const rawAlert = (item.alert || '').toUpperCase();
      let alertIcon = '🟢 SAFE';
      let alertClass = 'safe';

      const msltcVal = item.daysToMsltc !== undefined ? item.daysToMsltc : item.remainingDays;
      if (rawAlert.includes('CRITICAL') || msltcVal <= 0) {
        alertIcon = '🔴 CRITICAL';
        alertClass = 'critical';
      } else if (rawAlert.includes('HARD WARNING') || rawAlert.includes('HARD') || msltcVal === 1) {
        alertIcon = '🔴 HARD WARNING';
        alertClass = 'hard-warning';
      } else if (rawAlert.includes('WARNING') || msltcVal <= 3) {
        alertIcon = '🟡 WARNING';
        alertClass = 'warning';
      } else {
        alertIcon = '🟢 SAFE';
        alertClass = 'safe';
      }

      const doneBadge = isDone
        ? '<span class="eds-badge-done done">✅ Done</span>'
        : '<span class="eds-badge-done pending">⏳ Belum</span>';

      const ratioBadge = `<span class="eds-chip-ratio" title="Fisik / Stok Sistem">📦 Fisik/System: <strong>${item.fisikSystemVal}</strong></span>`;
      const remaksBadge = item.remaksVal && item.remaksVal !== '-'
        ? `<span class="eds-chip-remaks" title="Remaks: ${item.remaksVal}">💬 ${item.remaksVal}</span>`
        : '';

      const msltcDiffText = item.daysToMsltc !== undefined
        ? (item.daysToMsltc >= 0 ? `${item.daysToMsltc} Hari` : `${Math.abs(item.daysToMsltc)} Hari Lewat`)
        : `${item.remainingDays} Hari`;

      const expDiffText = item.daysToExpire !== undefined
        ? `${item.daysToExpire} Hari`
        : `${item.remainingDays} Hari`;

      return `
        <div class="eds-card ${isDone ? 'is-done' : ''}" onclick="selectEdsItemForInput('${item.sku}')">
          <div class="eds-card-header">
            <span class="eds-sku-tag">SKU: ${item.sku}</span>
            <div class="eds-card-header-right">
              <span class="eds-alert-pill ${alertClass}">${alertIcon}</span>
            </div>
          </div>

          <div class="eds-card-title">${item.productName}</div>

          <div class="eds-card-meta-row">
            <span class="eds-rack-pill">📍 Rack: <strong>${item.lokasiRack || 'Belum Ada Sloc'}</strong></span>
            <span class="eds-days-pill" title="Sisa ${expDiffText} menuju Expired | Batas MSLTC: ${msltcDiffText}">
              ⏳ Exp: <strong>${expDiffText}</strong> <small style="opacity:0.9; font-size:0.7rem; font-weight:700; margin-left:3px;">(MSLTC: ${msltcDiffText})</small>
            </span>
          </div>

          <div class="eds-card-grid-info">
            <div class="eds-grid-item">
              <span class="eds-grid-lbl">Qty Sistem</span>
              <span class="eds-grid-val">${item.qty_system} pcs</span>
            </div>
            <div class="eds-grid-item">
              <span class="eds-grid-lbl">MSLTC Date</span>
              <span class="eds-grid-val">${formatEdsDateDisplay(item.msltcDate)} <small style="font-size:0.7rem; font-weight:700; color:${msltcVal <= 0 ? '#fca5a5' : (msltcVal === 1 ? '#fde68a' : '#93c5fd')};">(${msltcDiffText})</small></span>
            </div>
            <div class="eds-grid-item">
              <span class="eds-grid-lbl">Expired Date</span>
              <span class="eds-grid-val">${formatEdsDateDisplay(item.expiryDate)} <small style="font-size:0.7rem; font-weight:700; color:#93c5fd;">(${expDiffText})</small></span>
            </div>
          </div>

          <div class="eds-status-strip">
            ${doneBadge}
            ${ratioBadge}
            ${remaksBadge}
          </div>
        </div>
      `;
    }).join('');

    const remaining = currentEdsListCache.length - currentEdsRenderLimit;
    let loadMoreBtn = '';
    if (remaining > 0) {
      const nextBatch = Math.min(remaining, 50);
      loadMoreBtn = `
        <div style="text-align:center; padding: 18px 0;" id="edsLoadMoreBox">
          <button type="button" class="btn-load-more" onclick="loadMoreEdsCards()" style="background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; padding: 12px 24px; border-radius: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; width: 100%; max-width: 340px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
            ⚡ Tampilkan ${nextBatch} SKU Lagi (${remaining} tersisa)
          </button>
        </div>
      `;
    }

    container.innerHTML = html + loadMoreBtn;
  }

  window.loadMoreEdsCards = function () {
    currentEdsRenderLimit += 50;
    renderEdSweeperCards(currentEdsListCache, true);
  };

  // ── Form Input SKU & Scan ──
  window.selectEdsItemForInput = function (sku) {
    selectedEdsSku = sku;
    lookupEdsSku(sku);

    const banner = document.getElementById('edsSelectedBanner');
    const title = document.getElementById('edsSelectedTitle');
    const item = edsMainListData.find(i => i.sku === sku);

    if (banner && title && item) {
      banner.classList.remove('hidden');
      title.textContent = `${item.sku} - ${item.productName}`;
    }

    switchEdsTab('scan');
  };

  window.clearEdsSelectedSku = function () {
    selectedEdsSku = null;
    document.getElementById('edsSelectedBanner')?.classList.add('hidden');
    resetEdsForm();
  };

  function lookupEdsSku(sku) {
    if (!sku) return;
    const clean = String(sku).trim();
    const item = edsMainListData.find(i => i.sku.toLowerCase() === clean.toLowerCase());

    const skuInput = document.getElementById('edsSkuInput');
    const namaInput = document.getElementById('edsNamaSku');
    const slocInput = document.getElementById('edsSlocExisting');
    const qtyInput = document.getElementById('edsQtySystem');
    const dateInput = document.getElementById('edsExpiredDate');
    const msltcHelper = document.getElementById('edsMsltcHelper');

    if (skuInput) skuInput.value = clean;

    if (item) {
      if (namaInput) namaInput.value = item.productName;
      if (slocInput) slocInput.value = item.lokasiRack;
      if (qtyInput) qtyInput.value = `${item.qty_system} pcs`;
      if (item.expiryDate) {
        if (edsFlatpickrInstance) {
          edsFlatpickrInstance.setDate(item.expiryDate);
        } else if (dateInput) {
          dateInput.value = item.expiryDate;
        }
        updateEdsMsltcHelperFromDate(item.expiryDate);
      } else {
        updateEdsMsltcHelperFromDate(dateInput ? dateInput.value : '');
      }

      // If already audited, prefill previous values
      if (edsAuditResultsMap.has(clean.toLowerCase())) {
        const audit = edsAuditResultsMap.get(clean.toLowerCase());
        const fg = document.getElementById('edsFisikGood');
        const fb = document.getElementById('edsFisikBad');
        const sales = document.getElementById('edsSales');
        const rBad = document.getElementById('edsReasonBad');
        const rSloc = document.getElementById('edsReasonSloc');

        if (fg) fg.value = audit.fisikGood;
        if (fb) fb.value = audit.fisikBad;
        if (sales) sales.value = audit.sales || '';
        if (rBad && audit.reasonBad) rBad.value = audit.reasonBad;
        if (rSloc && audit.reasonSloc) rSloc.value = audit.reasonSloc;
        setEdsToggle('edsSlocActualGroup', audit.slocActual || 'Match');
      } else {
        const fg = document.getElementById('edsFisikGood');
        if (fg) fg.value = item.qty_system || item.stockAvailable || 0;
      }
    } else {
      if (namaInput) namaInput.value = '';
      if (slocInput) slocInput.value = '';
      if (qtyInput) qtyInput.value = '0';
      if (msltcHelper) msltcHelper.textContent = '';
    }
  }

  const debouncedLookupEds = debounce((val) => lookupEdsSku(val), 180);
  document.getElementById('edsSkuInput')?.addEventListener('input', function (e) {
    debouncedLookupEds(e.target.value.trim());
  });

  window.startEdsCameraScan = function () {
    openUniversalScanner((decodedText) => {
      let raw = (decodedText || '').trim();
      let sku = raw;
      let scannedDate = null;

      if (raw.includes(';')) {
        const parts = raw.split(';');
        sku = parts[0].trim();
        if (parts[1]) {
          scannedDate = parseFlexibleDate(parts[1].trim());
        }
      }

      const skuInput = document.getElementById('edsSkuInput');
      if (skuInput) skuInput.value = sku;
      lookupEdsSku(sku);

      if (scannedDate) {
        const formatted = formatDateToYMD(scannedDate);
        if (edsFlatpickrInstance) {
          edsFlatpickrInstance.setDate(formatted);
        } else {
          const dateInput = document.getElementById('edsExpiredDate');
          if (dateInput) dateInput.value = formatted;
        }
      }

      playBarcodeBeep();
      showDccToast('success', 'Barcode Terbaca', `SKU: ${sku}`);
    });
  };

  window.setEdsToggle = function (groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.eds-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });

    if (groupId === 'edsSlocActualGroup') {
      const reasonGroup = document.getElementById('edsReasonSlocGroup');
      if (reasonGroup) {
        reasonGroup.classList.toggle('hidden', value === 'Match');
      }
    }
  };

  window.stepEdsValue = function (id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    let cur = parseInt(el.value, 10) || 0;
    cur += delta;
    if (cur < 0) cur = 0;
    el.value = cur;
  };

  // ── Photo Upload Handlers ──
  window.captureEdsPhoto = function (source) {
    if (edsPhotoList.length >= 2) {
      showDccToast('warning', 'Maksimal 2 Foto', 'Hanya dapat melampirkan 2 foto evidance.');
      return;
    }
    if (source === 'camera') {
      document.getElementById('edsPhotoCameraInput')?.click();
    } else {
      document.getElementById('edsPhotoGalleryInput')?.click();
    }
  };

  window.handleEdsPhotoFile = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const maxDim = 1200;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.75);

        if (edsPhotoList.length < 2) {
          edsPhotoList.push(compressedBase64);
          renderEdsPhotoPreviews();
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  window.removeEdsPhoto = function (index) {
    edsPhotoList.splice(index, 1);
    renderEdsPhotoPreviews();
  };

  function renderEdsPhotoPreviews() {
    const grid = document.getElementById('edsPhotoPreviewList');
    if (!grid) return;
    grid.innerHTML = edsPhotoList.map((photo, idx) => `
      <div class="eds-photo-thumb-wrap">
        <img src="${photo}" alt="Evidance ${idx + 1}">
        <button type="button" class="eds-photo-delete-btn" onclick="removeEdsPhoto(${idx})">✕</button>
      </div>
    `).join('');
  }

  function loadEdsSavedPic() {
    const saved = localStorage.getItem(EDS_PIC_KEY);
    const input = document.getElementById('edsInputBy');
    if (saved && input && !input.value) {
      input.value = saved;
    }
  }

  function getEdsSavedPic() {
    return (localStorage.getItem(EDS_PIC_KEY) || document.getElementById('edsInputBy')?.value || '').trim();
  }

  window.saveEdsDefaultPic = function () {
    const input = document.getElementById('edsInputBy');
    if (!input || !input.value.trim()) {
      showDccToast('warning', 'Nama Kosong', 'Ketik nama PIC terlebih dahulu.');
      return;
    }
    localStorage.setItem(EDS_PIC_KEY, input.value.trim());
    showDccToast('success', 'PIC Tersimpan', `Nama "${input.value.trim()}" akan otomatis terisi pada sesi berikutnya.`);
  };

  function resetEdsForm() {
    const skuInput = document.getElementById('edsSkuInput');
    if (skuInput) skuInput.value = '';
    const namaInput = document.getElementById('edsNamaSku');
    if (namaInput) namaInput.value = '';
    const slocInput = document.getElementById('edsSlocExisting');
    if (slocInput) slocInput.value = '';
    const qtyInput = document.getElementById('edsQtySystem');
    if (qtyInput) qtyInput.value = '0';
    const fg = document.getElementById('edsFisikGood');
    if (fg) fg.value = '0';
    const fb = document.getElementById('edsFisikBad');
    if (fb) fb.value = '0';
    const sales = document.getElementById('edsSales');
    if (sales) sales.value = '';
    const rBad = document.getElementById('edsReasonBad');
    if (rBad) rBad.value = '';
    const rSloc = document.getElementById('edsReasonSloc');
    if (rSloc) rSloc.value = '';
    const remaks = document.getElementById('edsRemaksInput');
    if (remaks) remaks.value = '';
    const helper = document.getElementById('edsMsltcHelper');
    if (helper) helper.textContent = '';

    if (edsFlatpickrInstance) edsFlatpickrInstance.clear();
    setEdsToggle('edsSlocActualGroup', 'Match');
    edsPhotoList = [];
    renderEdsPhotoPreviews();
    selectedEdsSku = null;
    document.getElementById('edsSelectedBanner')?.classList.add('hidden');
    loadEdsSavedPic();

    // Reset scroll ke paling atas
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    const scanTab = document.getElementById('edsTabScan');
    if (scanTab) scanTab.scrollTop = 0;
    const ws = document.getElementById('edSweeperWorkspace');
    if (ws) ws.scrollTop = 0;
  }

  window.proceedEdsConfirmedSubmit = function () {
    const modal = document.getElementById('edsConfirmEditModal');
    if (modal) modal.classList.add('hidden');
    window.__edsBypassConfirmEdit = true;
    submitEdsForm();
  };

  window.closeEdsConfirmEditModal = function () {
    const modal = document.getElementById('edsConfirmEditModal');
    if (modal) modal.classList.add('hidden');
    window.__edsBypassConfirmEdit = false;
  };

  // ── SUBMISSION HANDLER & AUTO-FILL COLS R, S, T ──
  window.submitEdsForm = async function () {
    const btn = document.getElementById('edsSubmitBtn');
    const skuNo = (document.getElementById('edsSkuInput')?.value || '').trim();
    const namaSku = (document.getElementById('edsNamaSku')?.value || '').trim();
    const slocExisting = (document.getElementById('edsSlocExisting')?.value || '').trim();
    const slocActual = document.querySelector('#edsSlocActualGroup .eds-toggle-btn.active')?.getAttribute('data-value') || 'Match';
    const expiredDate = (document.getElementById('edsExpiredDate')?.value || '').trim();
    const fisikGood = parseInt(document.getElementById('edsFisikGood')?.value, 10) || 0;
    const fisikBad = parseInt(document.getElementById('edsFisikBad')?.value, 10) || 0;
    const sales = (document.getElementById('edsSales')?.value || '').trim();
    const reasonSloc = (document.getElementById('edsReasonSloc')?.value || '').trim();
    const reasonBad = (document.getElementById('edsReasonBad')?.value || '').trim();
    const inputBy = (document.getElementById('edsInputBy')?.value || '').trim();
    const customRemaks = (document.getElementById('edsRemaksInput')?.value || '').trim();

    // Validasi
    if (!skuNo) {
      playWarningBeep();
      showDccToast('warning', 'SKU Wajib Diisi', 'Silakan scan atau ketik nomor SKU produk.');
      document.getElementById('edsSkuInput')?.focus();
      return;
    }

    if (!expiredDate) {
      playWarningBeep();
      showDccToast('warning', 'Expired Date Wajib', 'Silakan pilih tanggal Expired Date produk.');
      document.getElementById('edsExpiredDate')?.focus();
      return;
    }

    if (slocActual === 'Unmatch' && !reasonSloc) {
      playWarningBeep();
      showDccToast('warning', 'Alasan SLOC Wajib', 'Pilih alasan mengapa SLOC Actual Unmatch.');
      document.getElementById('edsReasonSloc')?.focus();
      return;
    }

    if (fisikBad > 0 && !reasonBad) {
      playWarningBeep();
      showDccToast('warning', 'Reason Bad Wajib', 'Jumlah Fisik Bad terisi, silakan pilih alasan kerusakan.');
      document.getElementById('edsReasonBad')?.focus();
      return;
    }

    // 📸 Validasi Wajib Foto jika Fisik Bad > 0
    if (fisikBad > 0 && edsPhotoList.length === 0) {
      playWarningBeep();
      showDccToast('warning', 'Foto Produk Wajib', 'Terdapat stok Fisik Bad (>0). Anda wajib menyertakan minimal 1 foto bukti fisik produk.');
      const photoEl = document.getElementById('edsPhotoPreviewList')?.closest('.eds-field-group');
      if (photoEl) {
        photoEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    if (!inputBy) {
      playWarningBeep();
      showDccToast('warning', 'Nama PIC Wajib', 'Masukkan nama petugas / PIC yang melakukan audit.');
      document.getElementById('edsInputBy')?.focus();
      return;
    }

    // ⚠️ POPUP KONFIRMASI JIKA MENGEDIT SKU YANG SUDAH PERNAH DIINPUT
    const cleanSku = skuNo.toLowerCase();
    const isAlreadyAudited = edsAuditResultsMap.has(cleanSku);
    if (isAlreadyAudited && !window.__edsBypassConfirmEdit) {
      const modal = document.getElementById('edsConfirmEditModal');
      const desc = document.getElementById('edsConfirmEditDesc');
      if (modal && desc) {
        desc.innerHTML = `Produk <strong>${namaSku || skuNo}</strong> (SKU: <code>${skuNo}</code>) sudah pernah diinput sebelumnya.<br><br>Apakah Anda yakin ingin <strong>menambahkan / mengedit</strong> data audit produk ini?`;
        modal.classList.remove('hidden');
        return;
      }
    }
    window.__edsBypassConfirmEdit = false;

    // Lookup item details for qty_system
    const item = edsMainListData.find(i => i.sku.toLowerCase() === skuNo.toLowerCase()) || {};
    const qtySystem = item.qty_system !== undefined ? item.qty_system : (item.stockAvailable || 0);

    // ── AUTO-COMPUTE VALUES FOR COLUMNS R, S, T ──
    const autoDoneVal = 'Done';
    const autoRemaksVal = reasonBad || reasonSloc || customRemaks || 'Sesuai';
    const autoFisikSystemVal = `${fisikGood}/${qtySystem}`;

    const timestamp = new Date().toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const payload = {
      action: 'saveEdsResult',
      skuNo: skuNo,
      sku: skuNo,
      sku_number: skuNo,
      namaSku: namaSku,
      slocExisting: slocExisting,
      slocActual: slocActual,
      expiredDate: expiredDate,
      fisikGood: fisikGood,
      fisikBad: fisikBad,
      sales: sales,
      reasonSloc: reasonSloc,
      reasonBad: reasonBad,
      inputBy: inputBy,
      input_by: inputBy,
      pic: inputBy,
      msltc: item.msltc || '',
      remaks: autoRemaksVal,
      qty_system: qtySystem,
      imageBase64: edsPhotoList[0] || '',
      imageBase64_2: edsPhotoList[1] || '',
      timestamp: timestamp
    };

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
    }

    // ── OPTIMISTIC LOCAL STATE UPDATE ──
    const updateLocalEdsState = () => {
      edsSubmittedSkuSet.add(skuNo.toLowerCase());
      try {
        localStorage.setItem(EDS_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(edsSubmittedSkuSet)));
      } catch (e) { }

      edsAuditResultsMap.set(skuNo.toLowerCase(), {
        sku: skuNo,
        namaSku: namaSku,
        slocExisting: slocExisting,
        slocActual: slocActual,
        expiredDate: expiredDate,
        fisikGood: fisikGood,
        fisikBad: fisikBad,
        sales: sales,
        reasonSloc: reasonSloc,
        reasonBad: reasonBad,
        inputBy: inputBy,
        timestamp: timestamp,
        remaks: autoRemaksVal
      });

      // Update item(s) in edsMainListData
      edsMainListData.forEach(it => {
        if (it.sku.toLowerCase() === skuNo.toLowerCase()) {
          it.isDone = true;
          it.doneVal = autoDoneVal;
          it.remaksVal = autoRemaksVal;
          it.fisikSystemVal = autoFisikSystemVal;
          if (expiredDate) {
            it.expiryDate = expiredDate;
            const now = new Date();
            const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const [ey, em, ed] = expiredDate.split('-').map(Number);
            if (ey && em && ed) {
              const expObj = new Date(ey, em - 1, ed);
              it.daysToExpire = Math.round((expObj.getTime() - todayMid.getTime()) / 86400000);
              const msltcDays = Number(it.msltc) || 7;
              const msltcObj = new Date(expObj.getTime() - (msltcDays * 86400000));
              it.daysToMsltc = Math.round((msltcObj.getTime() - todayMid.getTime()) / 86400000);
              it.msltcDate = msltcObj.toISOString().slice(0, 10);
            }
          }
        }
      });

      try {
        localStorage.setItem(EDS_MAIN_CACHE_KEY, JSON.stringify(edsMainListData));
      } catch (e) { }

      // Update or add to edsHasilRows (1 SKU = 1 Catatan, Update In-Place)
      const existingIdx = edsHasilRows.findIndex(r => r.sku && String(r.sku).trim().toLowerCase() === skuNo.toLowerCase());
      const newAuditItem = {
        sku: skuNo,
        namaSku: namaSku,
        slocExisting: slocExisting,
        slocActual: slocActual,
        expiredDate: expiredDate,
        fisikGood: Number(fisikGood) || 0,
        fisikBad: Number(fisikBad) || 0,
        sales: sales,
        reasonSloc: reasonSloc,
        reasonBad: reasonBad,
        inputBy: inputBy,
        timestamp: timestamp,
        remaks: autoRemaksVal
      };

      if (existingIdx !== -1) {
        edsHasilRows.splice(existingIdx, 1);
      }
      edsHasilRows.unshift(newAuditItem);

      filterEdSweeperList();
      renderEdsReport();
    };

    // Offline check
    if (!navigator.onLine) {
      await addToEdsOfflineQueue(payload);
      updateLocalEdsState();
      playSaveSuccessChime();
      showDccToast('info', 'Tersimpan Offline', `Audit SKU ${skuNo} aman di memori HP. Otomatis dikirim begitu sinyal terhubung.`);
      resetEdsForm();
      switchEdsTab('main');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Simpan Hasil Sweeper';
      }
      return;
    }

    // Online submission
    const webappUrl = getEdsWebappUrl();
    if (!webappUrl) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Simpan Hasil Sweeper';
      }
      playWarningBeep();
      showDccToast('warning', 'WebApp Belum Disambungkan', 'Silakan masukkan URL WebApp spreadsheet ED Sweeper Anda terlebih dahulu agar data masuk ke sheet Hasil EDS.');
      openEdsSetupModal();
      return;
    }

    try {
      await fetch(webappUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      updateLocalEdsState();
      playSaveSuccessChime();
      showDccToast('success', 'Audit Berhasil Disimpan!', `SKU ${skuNo} (${namaSku}) selesai di-audit. Kolom Done, Remaks, dan Fisik/System otomatis terisi.`);
      resetEdsForm();
      switchEdsTab('main');
    } catch (err) {
      console.warn('POST failed, storing in offline queue...', err);
      await addToEdsOfflineQueue(payload);
      updateLocalEdsState();
      playSaveSuccessChime();
      showDccToast('info', 'Tersimpan Offline (Sinyal Lemah)', `Koneksi tersendat. Data SKU ${skuNo} diamankan di antrean lokal HP.`);
      resetEdsForm();
      switchEdsTab('main');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Simpan Hasil Sweeper';
      }
    }
  };

  // ── Report & Export Engine ──
  function renderEdsReport() {
    renderEdsPrintTable();

    const total = edsMainListData.length;
    const doneCount = edsMainListData.filter(i => i.isDone).length;
    const pendingCount = total - doneCount;
    let totalBad = 0;
    edsHasilRows.forEach(r => {
      totalBad += (parseInt(r.fisikBad, 10) || 0);
    });

    const elTotal = document.getElementById('edsStatTotal');
    const elDone = document.getElementById('edsStatDone');
    const elPending = document.getElementById('edsStatPending');
    const elBad = document.getElementById('edsStatBad');

    if (elTotal) elTotal.textContent = total;
    if (elDone) elDone.textContent = doneCount;
    if (elPending) elPending.textContent = pendingCount;
    if (elBad) elBad.textContent = totalBad;

    const listContainer = document.getElementById('edsReportTableContainer');
    if (!listContainer) return;

    if (edsHasilRows.length === 0) {
      listContainer.innerHTML = '<div style="text-align:center; padding: 25px; color: var(--text-muted);">Belum ada riwayat audit yang tercatat hari ini.</div>';
      return;
    }

    const html = edsHasilRows.map((r, idx) => `
      <div class="eds-report-item">
        <div class="eds-report-item-left">
          <div class="eds-report-item-title">${idx + 1}. [${r.sku}] ${r.namaSku || 'Produk'}</div>
          <div class="eds-report-item-sub">
            Rack: ${r.slocExisting || '-'} (${r.slocActual}) • ED: ${formatEdsDateDisplay(r.expiredDate)} • PIC: <strong>${r.inputBy || '-'}</strong>
          </div>
        </div>
        <div style="text-align: right; flex-shrink: 0;">
          <div style="font-size: 0.85rem; font-weight: 700; color: #34d399;">Good: ${r.fisikGood}</div>
          ${r.fisikBad > 0 ? `<div style="font-size: 0.75rem; font-weight: 700; color: #f87171;">Bad: ${r.fisikBad} (${r.reasonBad})</div>` : ''}
        </div>
      </div>
    `).join('');

    listContainer.innerHTML = html;
  }

  function renderEdsPrintTable() {
    const tbody = document.getElementById('edsPrintTableBody');
    if (!tbody) return;

    let list = edsMainListData;
    if (!list || list.length === 0) {
      try {
        const cached = localStorage.getItem(EDS_MAIN_CACHE_KEY);
        if (cached) {
          list = JSON.parse(cached);
          edsMainListData = list;
        }
      } catch (e) { }
    }

    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding: 20px; color: #64748b;">Belum ada data produk di Main List SKU. Silakan refresh data.</td></tr>';
      return;
    }

    const rows = list.map((item, idx) => {
      const audit = edsAuditResultsMap.get(item.sku.toLowerCase()) || {};
      const isDone = item.isDone;
      const statusBadge = isDone
        ? `<span class="eds-status-pill done" style="background:rgba(16,185,129,0.2); color:#10b981; font-weight:700; padding:2px 8px; border-radius:12px; font-size:0.75rem;">Done</span>`
        : `<span class="eds-status-pill pending" style="background:rgba(245,158,11,0.2); color:#f59e0b; font-weight:700; padding:2px 8px; border-radius:12px; font-size:0.75rem;">Belum</span>`;

      const alertBadge = `<span style="font-size:0.75rem; font-weight:700;">${escapeHtml(item.alert || '-')}</span>`;
      const fisikGood = audit.fisikGood !== undefined ? audit.fisikGood : (isDone ? item.stockAvailable : '-');
      const fisikBad = audit.fisikBad !== undefined ? audit.fisikBad : (isDone ? '0' : '-');
      const remaks = audit.reasonBad || audit.reasonSloc || audit.remaks || (isDone ? item.remaksVal : '-');

      return `
        <tr>
          <td style="text-align:center; font-weight:700;">${idx + 1}</td>
          <td style="font-family:var(--font-mono, monospace); font-weight:700;">${escapeHtml(item.sku)}</td>
          <td style="font-weight:600;">${escapeHtml(item.productName)}</td>
          <td style="text-align:center;">${escapeHtml(item.lokasiRack || '-')}</td>
          <td style="text-align:center; font-weight:700;">${item.qty_system || item.stockAvailable || 0}</td>
          <td style="text-align:center;">${formatEdsDateDisplay(audit.expiredDate || item.expiryDate)}</td>
          <td style="text-align:center; font-weight:700;">${item.remainingDays !== 999 ? item.remainingDays : '-'}</td>
          <td style="text-align:center;">${alertBadge}</td>
          <td style="text-align:center;">${statusBadge}</td>
          <td style="text-align:center; color:#10b981; font-weight:700;">${fisikGood}</td>
          <td style="text-align:center; ${Number(fisikBad) > 0 ? 'color:#ef4444; font-weight:700;' : ''}">${fisikBad}</td>
          <td style="font-size:0.78rem;">${escapeHtml(remaks || '-')}</td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = rows;
  }

  window.shareEdsToWhatsApp = function () {
    const total = edsMainListData.length;
    const doneCount = edsMainListData.filter(i => i.isDone).length;
    const pendingCount = total - doneCount;
    let totalBad = 0;
    let totalGood = 0;
    let totalSales = 0;
    let slocMatchCount = 0;
    let slocUnmatchCount = 0;

    edsHasilRows.forEach(r => {
      totalBad += (parseInt(r.fisikBad, 10) || 0);
      totalGood += (parseInt(r.fisikGood, 10) || 0);
      totalSales += (parseInt(r.sales, 10) || 0);
      if (r.slocActual === 'Match') slocMatchCount++;
      else if (r.slocActual === 'Unmatch') slocUnmatchCount++;
    });

    const progressPct = total > 0 ? ((doneCount / total) * 100).toFixed(1) + '%' : '0%';
    const todayStr = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const activePic = getEdsSavedPic() || (edsHasilRows.length > 0 ? edsHasilRows[edsHasilRows.length - 1].inputBy : 'Petugas MTG');

    let text = `📊 *RINGKASAN EXPIRED DATE SWEEPER (EDS)*\n` +
      `🏢 *Hub:* MTG - Menteng\n` +
      `📅 *Hari/Tanggal:* ${todayStr}\n` +
      `👤 *PIC Penginput:* ${activePic}\n` +
      `-----------------------------------------\n` +
      `📈 *Progress Sweeping:* ${doneCount} / ${total} SKU (${progressPct})\n` +
      `✅ *Sudah Diperiksa:* ${doneCount} SKU\n` +
      `⏳ *Belum Diperiksa:* ${pendingCount} SKU\n` +
      `📦 *Total Fisik Good:* ${totalGood} pcs\n` +
      `❌ *Total Fisik Bad:* ${totalBad} pcs\n` +
      `🛒 *Total Sales:* ${totalSales} pcs\n` +
      `📍 *SLOC Match / Unmatch:* ${slocMatchCount} / ${slocUnmatchCount}\n` +
      `-----------------------------------------\n`;

    if (edsHasilRows.length > 0) {
      text += `*Daftar Temuan / Hasil Audit Terbaru:* \n`;
      edsHasilRows.slice(-15).reverse().forEach((r, idx) => {
        text += `${idx + 1}. [${r.sku}] ${r.namaSku}\n   📍 Rack: ${r.slocExisting || '-'} (${r.slocActual}) | ED: ${formatEdsDateDisplay(r.expiredDate)}\n   📦 Good: ${r.fisikGood} | ❌ Bad: ${r.fisikBad}${r.reasonBad ? ` (${r.reasonBad})` : ''} | 👤 ${r.inputBy || '-'}\n`;
      });
      if (edsHasilRows.length > 15) {
        text += `...dan ${edsHasilRows.length - 15} SKU lainnya.\n`;
      }
      text += `-----------------------------------------\n`;
    }

    text += `_Dilaporkan otomatis via Super App MTG_`;

    playSuccessBeep();

    // Copy to clipboard as quick backup
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }

    // 1. Android Native Share Bridge
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.shareReport === 'function') {
      try {
        window.AndroidUpdateBridge.shareReport('Ringkasan EDS MTG', text);
        showDccToast('success', 'Buka WhatsApp', 'Membuka pilihan aplikasi untuk membagikan laporan EDS.');
        return;
      } catch (e) {
        console.warn('Bridge share error:', e);
      }
    }

    // 2. Web Share API
    if (navigator.share) {
      navigator.share({ title: 'Ringkasan EDS MTG', text: text })
        .then(() => showDccToast('success', 'Berbagi', 'Laporan berhasil dibagikan.'))
        .catch(() => {
          const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
          window.open(waUrl, '_blank');
        });
    } else {
      // 3. Fallback direct WhatsApp URL
      const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(waUrl, '_blank');
      showDccToast('success', 'Buka WhatsApp', 'Membuka WhatsApp web/app.');
    }
  };

  window.exportEdsToExcel = function () {
    if (edsHasilRows.length === 0 && edsMainListData.length === 0) {
      showDccToast('warning', 'Data Kosong', 'Tidak ada data audit untuk diekspor.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `Hasil_ED_Sweeper_MTG_${dateStr}.csv`;

    let csvContent = '\uFEFF'; // UTF-8 BOM
    csvContent += 'No,SKU,Nama Produk,Rack SLOC,Stok Sistem,Fisik Good,Fisik Bad,SLOC Actual,Expired Date,Reason Bad,PIC,Status Done,Fisik/System\r\n';

    let rowIdx = 1;
    if (edsHasilRows.length > 0) {
      edsHasilRows.forEach(r => {
        const row = [
          rowIdx++,
          `"${r.sku || ''}"`,
          `"${(r.namaSku || '').replace(/"/g, '""')}"`,
          `"${r.slocExisting || ''}"`,
          r.sales || 0,
          r.fisikGood || 0,
          r.fisikBad || 0,
          `"${r.slocActual || 'Match'}"`,
          `"${formatEdsDateDisplay(r.expiredDate)}"`,
          `"${(r.reasonBad || '').replace(/"/g, '""')}"`,
          `"${r.inputBy || ''}"`,
          `"Done"`,
          `"${(parseInt(r.fisikGood, 10) || 0) + (parseInt(r.fisikBad, 10) || 0)}"`
        ];
        csvContent += row.join(',') + '\r\n';
      });
    } else {
      edsMainListData.forEach(item => {
        const audit = edsAuditResultsMap.get(item.sku.toLowerCase()) || {};
        const row = [
          rowIdx++,
          `"${item.sku}"`,
          `"${(item.productName || '').replace(/"/g, '""')}"`,
          `"${item.lokasiRack || ''}"`,
          item.qty_system || item.stockAvailable || 0,
          audit.fisikGood !== undefined ? audit.fisikGood : (item.isDone ? item.stockAvailable : ''),
          audit.fisikBad !== undefined ? audit.fisikBad : '',
          `"${audit.slocActual || 'Match'}"`,
          `"${formatEdsDateDisplay(audit.expiredDate || item.expiryDate)}"`,
          `"${audit.reasonBad || ''}"`,
          `"${audit.inputBy || ''}"`,
          `"${item.doneVal || (item.isDone ? 'Done' : '')}"`,
          `"${item.fisikSystemVal || ''}"`
        ];
        csvContent += row.join(',') + '\r\n';
      });
    }

    playSuccessBeep();

    // 1. Android Native Bridge Download to /Downloads folder
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.saveFileToDownloads === 'function') {
      try {
        const base64 = btoa(unescape(encodeURIComponent(csvContent)));
        window.AndroidUpdateBridge.saveFileToDownloads(filename, base64, 'text/csv');
        showDccToast('success', 'Excel/CSV Terunduh', `File tersimpan di folder Download: ${filename}`);
        return;
      } catch (e) {
        console.warn('Bridge save error, fallback to blob:', e);
      }
    }

    // 2. Web Blob Download Fallback
    try {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showDccToast('success', 'Excel/CSV Terunduh', `Laporan berhasil diunduh: ${filename}`);
    } catch (e) {
      console.error('Download error:', e);
      showDccToast('error', 'Gagal Mengunduh', 'Browser tidak mengizinkan unduhan file.');
    }
  };

  window.printEdsPdf = function () {
    renderEdsPrintTable();
    const todayStr = new Date().toLocaleDateString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(/\//g, '-');
    setTimeout(() => {
      triggerNativePrint('print-mode-eds', `Laporan_ED_Sweeper_MTG_${todayStr}`);
    }, 120);
  };

  // ── Init
  (function init() {
    renderHistory();
    loadInitialData();
    updateHomeVersionDisplay();

    // Check for updates automatically in background
    setTimeout(() => {
      checkForAppUpdates(false);
    }, 1500);

    // Safety fallback: ensure loading screen disappears after 3.5s even on slow connection
    setTimeout(() => {
      hideLoading();
    }, 3500);

    // Auto-refresh data every 5 minutes in the background (only when document is active and online to save battery)
    setInterval(() => {
      if (!document.hidden && navigator.onLine) {
        fetchSheetData(true);
      }
    }, 5 * 60 * 1000);

    // Refresh automatically if returning to app after > 10 minutes in background
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && navigator.onLine && dataTimestamp) {
        if (Date.now() - dataTimestamp.getTime() > 10 * 60 * 1000) {
          fetchSheetData(true);
        }
      }
    });
  })();

})();
