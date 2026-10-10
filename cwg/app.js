/**
 * Superapp MTG
 * ──────────────────────────────────────────
 * High-performance warehouse barcode generator & real-time MSLTC clearance checker.
 * Optimized with IndexedDB local caching + Selective Google Sheets Queries (Sub-Second Load).
 */

(function () {
  'use strict';

  // 🏢 Auto-set preferred hub to CWG
  try {
    localStorage.setItem('astro_preferred_hub', 'cwg');
  } catch (e) {}

  // ── Config CWG ──
  const SHEET_ID = '1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ';
  // Selective column query for Master Rack (from 'SLOC MASTER' and 'STOCK UPDATE' - real-time latest SLOC from Superset)
  // Kolom SLOC MASTER: A=location_name, C=sku_number, D=product_name, F=rack_name, I=stock
  const SLOC_MASTER_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('SLOC MASTER')}&tq=${encodeURIComponent("SELECT A, C, D, F, I WHERE F IS NOT NULL AND F != ''")}`;
  // Kolom STOCK UPDATE: A=location_name, C=sku_number, D=product_name, F=rack_name, I=stock, J=l1_category_name
  const STOCK_UPDATE_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('STOCK UPDATE')}&tq=${encodeURIComponent("SELECT A, C, D, F, I, J WHERE F IS NOT NULL AND F != ''")}`;
  // CSV Query for MSLTC sheet (for shelf-life days validation)
  const MSLTC_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=MSLTC`;

  const MAX_HISTORY = 8;
  const DB_NAME = 'QRSLOC_DB_CWG_V2';
  const DB_VERSION = 2;
  const STORE_NAME = 'master_cache';

  // Wipe legacy V1 cache to prevent stale Menteng data
  if (typeof window !== 'undefined' && window.indexedDB && window.indexedDB.deleteDatabase) {
    try { window.indexedDB.deleteDatabase('QRSLOC_DB_CWG_V1'); } catch (e) {}
  }

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
      store.put({ masterArray, msltcArray, count, timestampIso }, 'masterDataV4');
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
        const req = store.get('masterDataV4');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function clearCache() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      return tx.complete;
    } catch (e) {
      console.warn('IndexedDB clear failed:', e);
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

  function inferCategoryFromSloc(sloc) {
    if (!sloc) return '';
    const upper = sloc.toUpperCase();
    if (upper.includes('CHL') || upper.includes('CHILLER')) return 'Fresh';
    if (upper.includes('FRZ') || upper.includes('FREEZER')) return 'Frozen';
    if (upper.includes('AMD') || upper.includes('AMBIENT')) return 'Ambient';
    return '';
  }

  function buildMasterMap(slocRows, stockRows = []) {
    const map = new Map();
    const masterArray = [];
    let count = 0;
    if (!slocRows || slocRows.length < 2) return { map, count, masterArray };

    // 1. Process SLOC MASTER rows (9,000+ mapped SKUs for Hub CWG)
    const header = slocRows[0].map(h => (h || '').toLowerCase().trim());
    let skuIdx = header.findIndex(h => h === 'sku_number' || h === 'sku' || h.includes('sku'));
    let slocIdx = header.findIndex(h => h === 'rack_name' || h === 'sloc sistem' || h === 'sloc' || h.includes('rack') || h.includes('sloc'));
    let prodIdx = header.findIndex(h => h === 'product_name' || h === 'nama produk' || h.includes('product') || h.includes('nama'));
    let typeIdx = header.findIndex(h => h === 'product_type_name' || h === 'type' || h.includes('type') || h.includes('kategori') || h.includes('category'));
    let masterSlocIdx = header.findIndex(h => h === 'master sloc' || h === 'master_sloc');
    let leftIdx = header.findIndex(h => h === 'left' || h === 'location_name');
    let qtyIdx = header.findIndex(h => h === 'quantity' || h === 'qty' || h.includes('stok') || h.includes('stock'));

    if (skuIdx === -1) skuIdx = 1;
    if (slocIdx === -1) slocIdx = 3;
    if (prodIdx === -1) prodIdx = 2;

    for (let i = 1; i < slocRows.length; i++) {
      const row = slocRows[i];
      const sku = (row[skuIdx] || '').trim();
      const sloc = (row[slocIdx] || '').trim();
      const productName = prodIdx !== -1 ? (row[prodIdx] || '').trim() : '';
      let type = typeIdx !== -1 ? (row[typeIdx] || '').trim() : '';
      if (!type) type = inferCategoryFromSloc(sloc);
      const masterSloc = masterSlocIdx !== -1 && row[masterSlocIdx] ? row[masterSlocIdx].trim() : sloc;

      let left = '';
      if (sloc) {
        const m = sloc.match(/^L\d+-/i);
        if (m) left = m[0];
      }
      if (!left && leftIdx !== -1) {
        left = (row[leftIdx] || '').trim();
      }

      const qty = qtyIdx !== -1 ? (row[qtyIdx] || '').trim() : '';

      if (sku && sloc) {
        const item = { sku, sloc, productName, masterSloc, type, left, qty };
        if (!map.has(sku)) {
          map.set(sku, []);
          count++;
        }
        map.get(sku).push(item);
        masterArray.push([sku, item]);
      }
    }

    // 2. Process STOCK UPDATE rows (Enrich with latest active stock & categories)
    if (stockRows && stockRows.length > 1) {
      const sHeader = stockRows[0].map(h => (h || '').toLowerCase().trim());
      let sSkuIdx = sHeader.findIndex(h => h === 'sku_number' || h === 'sku' || h.includes('sku'));
      let sSlocIdx = sHeader.findIndex(h => h === 'rack_name' || h === 'sloc sistem' || h === 'sloc' || h.includes('rack') || h.includes('sloc'));
      let sProdIdx = sHeader.findIndex(h => h === 'product_name' || h === 'nama produk' || h.includes('product') || h.includes('nama'));
      let sTypeIdx = sHeader.findIndex(h => h === 'product_type_name' || h === 'type' || h.includes('type') || h.includes('kategori') || h.includes('category') || h === 'l1_category_name');
      let sQtyIdx = sHeader.findIndex(h => h === 'quantity' || h === 'qty' || h.includes('stok') || h.includes('stock'));

      if (sSkuIdx === -1) sSkuIdx = 1;
      if (sSlocIdx === -1) sSlocIdx = 3;
      if (sProdIdx === -1) sProdIdx = 2;

      for (let i = 1; i < stockRows.length; i++) {
        const row = stockRows[i];
        const sku = (row[sSkuIdx] || '').trim();
        const sloc = (row[sSlocIdx] || '').trim();
        const productName = sProdIdx !== -1 ? (row[sProdIdx] || '').trim() : '';
        const cat = sTypeIdx !== -1 ? (row[sTypeIdx] || '').trim() : '';
        const type = cat || inferCategoryFromSloc(sloc);
        const qty = sQtyIdx !== -1 ? (row[sQtyIdx] || '').trim() : '';

        if (sku && sloc) {
          let left = '';
          const m = sloc.match(/^L\d+-/i);
          if (m) left = m[0];

          if (!map.has(sku)) {
            const item = { sku, sloc, productName, masterSloc: sloc, type, left, qty };
            map.set(sku, [item]);
            masterArray.push([sku, item]);
            count++;
          } else {
            const items = map.get(sku);
            const match = items.find(it => it.sloc === sloc);
            if (match) {
              if (qty) match.qty = qty;
              if (type) match.type = type;
              if (productName && (!match.productName || match.productName.length < productName.length)) {
                match.productName = productName;
              }
            } else {
              const item = { sku, sloc, productName, masterSloc: sloc, type, left, qty };
              items.push(item);
              masterArray.push([sku, item]);
            }
          }
        }
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
    if (!rows || rows.length < 2) return { map, msltcArray };

    // Header: location_id, location_name, product_id, sku_number, product_name, rack_name, Product Type, msltc
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const locationName = (row[1] || '').trim();
      const productId = (row[2] || '').trim();
      const sku = (row[3] || '').trim();
      const productName = (row[4] || '').trim();
      // For Hub CWG: If data comes from MTG / Menteng, do NOT use Menteng's rack or Menteng's location name as CWG SLOC!
      const isMtg = locationName.toUpperCase().includes('MTG') || locationName.toUpperCase().includes('MENTENG');
      const rackName = isMtg ? '' : (row[5] || '').trim();
      const type = (row[6] || '').trim();
      const msltcDays = parseInt((row[7] || '0').trim(), 10) || 0;

      if (sku || productId) {
        const primaryKey = sku || productId;
        const item = {
          locationName: isMtg ? 'CWG - Cawang' : locationName,
          productId,
          sku: primaryKey,
          productName,
          rackName,
          type,
          msltcDays
        };

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
      items.sort((a, b) => compareSlocNatural(a.rackName, b.rackName));
    }

    return { map, msltcArray };
  }

  // ── MSLTC Lookup & Shelf-Life Calculator Engine (Centralized & Fast O(1)) ──
  function getMsltcInfo(sku, productName = '') {
    if (!msltcMap || (!sku && !productName)) return null;

    let cleanSku = String(sku || '').trim();
    if (cleanSku.includes('|')) cleanSku = cleanSku.split('|')[0].trim();
    if (cleanSku.includes(';')) cleanSku = cleanSku.split(';')[0].trim();

    // 1. Direct match by SKU
    if (cleanSku && msltcMap.has(cleanSku)) {
      const found = msltcMap.get(cleanSku);
      if (found && found.length > 0) return found[0];
    }
    // 2. Without leading zeros
    const noZero = cleanSku ? cleanSku.replace(/^0+/, '') : '';
    if (noZero && msltcMap.has(noZero)) {
      const found = msltcMap.get(noZero);
      if (found && found.length > 0) return found[0];
    }
    // 3. Search entries by SKU / Product ID
    if (cleanSku) {
      for (const [key, items] of msltcMap.entries()) {
        if (key.toLowerCase() === cleanSku.toLowerCase() || (noZero && key.toLowerCase() === noZero.toLowerCase())) {
          if (items && items.length > 0) return items[0];
        }
      }
    }
    // 4. Fast Substring Product Name Match (Lightweight & Safe)
    if (productName) {
      const cleanName = productName.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
      if (cleanName && cleanName.length >= 3) {
        for (const [, items] of msltcMap.entries()) {
          for (const item of items) {
            if (item && item.productName) {
              const itemClean = item.productName.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
              if (itemClean === cleanName || itemClean.includes(cleanName) || cleanName.includes(itemClean)) {
                return item;
              }
            }
          }
        }
      }
    }
    return null;
  }
  window.getMsltcInfo = getMsltcInfo;

  async function fetchSheetData(isBackground = false) {
    if (!isBackground) {
      setStatus('loading', 'Memuat data terbaru dari Google Sheets...');
      refreshBtn.classList.add('spinning');
    }

    try {
      const fetchTime = Date.now();
      const slocUrlWithTs = SLOC_MASTER_CSV_URL + '&_nocache=' + fetchTime;
      const stockUrlWithTs = STOCK_UPDATE_CSV_URL + '&_nocache=' + fetchTime;
      const msltcUrlWithTs = MSLTC_CSV_URL + '&_nocache=' + fetchTime;
      const [slocRes, stockRes, msltcRes] = await Promise.all([
        fetch(slocUrlWithTs, { cache: 'no-store' }),
        fetch(stockUrlWithTs, { cache: 'no-store' }),
        fetch(msltcUrlWithTs, { cache: 'no-store' })
      ]);

      if (!slocRes.ok && !stockRes.ok) throw new Error(`HTTP fetch error`);

      const [slocCsv, stockCsv, msltcCsv] = await Promise.all([
        slocRes.ok ? slocRes.text() : Promise.resolve(''),
        stockRes.ok ? stockRes.text() : Promise.resolve(''),
        msltcRes.ok ? msltcRes.text() : Promise.resolve('')
      ]);

      const slocRows = slocCsv ? parseCSV(slocCsv) : [];
      const stockRows = stockCsv ? parseCSV(stockCsv) : [];
      const msltcRows = msltcCsv ? parseCSV(msltcCsv) : [];

      const masterResult = buildMasterMap(slocRows, stockRows);
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

      // Re-enrich open DCC workspace if active
      if (typeof enrichAllDccListsWithSupersheet === 'function') {
        const didEnrich = enrichAllDccListsWithSupersheet();
        const dccWs = document.getElementById('dccWorkspace');
        if (didEnrich && dccWs && !dccWs.classList.contains('hidden') && typeof filterDccMainList === 'function') {
          filterDccMainList();
        }
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
    if (dataMap.has(cleaned)) {
      const items = [...dataMap.get(cleaned)].map(it => {
        const msInfo = getMsltcInfo(it.sku || cleaned, it.productName);
        return {
          ...it,
          msltcDays: (msInfo && msInfo.msltcDays !== undefined && msInfo.msltcDays !== null) ? msInfo.msltcDays : (it.msltcDays || 0),
          type: (msInfo && msInfo.type) ? msInfo.type : (it.type || 'Fresh')
        };
      });
      items.sort((a, b) => compareSlocNatural(a.sloc || a.masterSloc, b.sloc || b.masterSloc));
      return items;
    }
    for (const [key, value] of dataMap) {
      if (key.toLowerCase().trim() === cleaned.toLowerCase()) {
        const items = [...value].map(it => {
          const msInfo = getMsltcInfo(it.sku || key, it.productName);
          return {
            ...it,
            msltcDays: (msInfo && msInfo.msltcDays !== undefined && msInfo.msltcDays !== null) ? msInfo.msltcDays : (it.msltcDays || 0),
            type: (msInfo && msInfo.type) ? msInfo.type : (it.type || 'Fresh')
          };
        });
        items.sort((a, b) => compareSlocNatural(a.sloc || a.masterSloc, b.sloc || b.masterSloc));
        return items;
      }
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
      const mapped = itemsToUse.map(m => ({
        sku: m.sku || m.productId || cleaned,
        sloc: m.rackName || 'Belum Ada SLOC di CWG',
        productName: m.productName || 'Produk MSLTC',
        masterSloc: m.rackName || '',
        type: m.type || 'Fresh',
        left: m.productId || '',
        msltcDays: (m.msltcDays !== undefined && m.msltcDays !== null) ? m.msltcDays : 0
      }));
      mapped.sort((a, b) => compareSlocNatural(a.sloc, b.sloc));
      return mapped;
    }

    // 2b. Search by SLOC (Lokasi Rak) in Master Data (SLOC MASTER) & MSLTC
    const rawLower = cleaned.toLowerCase();
    const noHyphenQuery = rawLower.replace(/[^a-z0-9]/g, '');
    const slocMatches = [];
    const seenSlocKeys = new Set();

    if (cleaned.length >= 2) {
      // Cari di dataMap (SLOC MASTER)
      for (const [key, items] of dataMap) {
        for (const item of items) {
          const sloc = (item.sloc || item.masterSloc || '').trim();
          if (!sloc) continue;
          const lowerSloc = sloc.toLowerCase();
          const noHyphenSloc = lowerSloc.replace(/[^a-z0-9]/g, '');

          let isMatch = false;
          let isExact = false;

          if (lowerSloc === rawLower || noHyphenSloc === noHyphenQuery) {
            isMatch = true;
            isExact = true;
          } else if (lowerSloc.startsWith(rawLower) || noHyphenSloc.startsWith(noHyphenQuery)) {
            isMatch = true;
          } else if (cleaned.length >= 3 && (lowerSloc.includes(rawLower) || (noHyphenQuery.length >= 3 && noHyphenSloc.includes(noHyphenQuery)))) {
            isMatch = true;
          }

          if (isMatch) {
            const actualSku = item.sku || key;
            const uniqueId = `${actualSku}_${sloc}`;
            if (!seenSlocKeys.has(uniqueId)) {
              seenSlocKeys.add(uniqueId);
              const msInfo = getMsltcInfo(actualSku, item.productName);
              slocMatches.push({
                item: {
                  ...item,
                  sku: actualSku,
                  msltcDays: (msInfo && msInfo.msltcDays !== undefined && msInfo.msltcDays !== null) ? msInfo.msltcDays : (item.msltcDays || 0),
                  type: (msInfo && msInfo.type) ? msInfo.type : (item.type || 'Fresh')
                },
                isExact: isExact
              });
            }
          }
        }
      }

      // Cari di msltcMap
      for (const [key, items] of msltcMap) {
        for (const item of items) {
          const sloc = (item.rackName || '').trim();
          if (!sloc) continue;
          const lowerSloc = sloc.toLowerCase();
          const noHyphenSloc = lowerSloc.replace(/[^a-z0-9]/g, '');

          let isMatch = false;
          let isExact = false;

          if (lowerSloc === rawLower || noHyphenSloc === noHyphenQuery) {
            isMatch = true;
            isExact = true;
          } else if (lowerSloc.startsWith(rawLower) || noHyphenSloc.startsWith(noHyphenQuery)) {
            isMatch = true;
          } else if (cleaned.length >= 3 && (lowerSloc.includes(rawLower) || (noHyphenQuery.length >= 3 && noHyphenSloc.includes(noHyphenQuery)))) {
            isMatch = true;
          }

          if (isMatch) {
            const actualSku = item.sku || item.productId || cleaned;
            const uniqueId = `${actualSku}_${sloc}`;
            if (!seenSlocKeys.has(uniqueId)) {
              seenSlocKeys.add(uniqueId);
              slocMatches.push({
                item: {
                  sku: actualSku,
                  sloc: sloc,
                  productName: item.productName || 'Produk MSLTC',
                  masterSloc: sloc,
                  type: item.type || 'Fresh',
                  left: item.productId || '',
                  msltcDays: (item.msltcDays !== undefined && item.msltcDays !== null) ? item.msltcDays : 0
                },
                isExact: isExact
              });
            }
          }
        }
      }
    }

    if (slocMatches.length > 0) {
      slocMatches.sort((a, b) => (b.isExact ? 1 : 0) - (a.isExact ? 1 : 0) || compareSlocNatural(a.item.sloc, b.item.sloc) || (a.item.productName || '').localeCompare(b.item.productName || ''));
      return slocMatches.map(s => s.item);
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
            const msInfo = getMsltcInfo(item.sku || key, item.productName);
            masterScored.push({
              item: {
                ...item,
                sku: item.sku || key,
                msltcDays: (msInfo && msInfo.msltcDays !== undefined && msInfo.msltcDays !== null) ? msInfo.msltcDays : (item.msltcDays || 0),
                type: (msInfo && msInfo.type) ? msInfo.type : (item.type || 'Fresh')
              },
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
          const uniqueId = `${item.sku || key}_${item.rackName || ''}`;
          if (!seenMsltcKeys.has(uniqueId)) {
            seenMsltcKeys.add(uniqueId);
            msltcScored.push({
              item: {
                sku: item.sku || item.productId || cleaned,
                sloc: item.rackName || 'Belum Ada SLOC di CWG',
                productName: item.productName || 'Produk MSLTC',
                masterSloc: item.rackName || '',
                type: item.type || 'Fresh',
                left: item.productId || '',
                msltcDays: (item.msltcDays !== undefined && item.msltcDays !== null) ? item.msltcDays : 0
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
        const bestItem = items.find(it => !isBadSloc(it.sloc || it.masterSloc)) || items[0] || {};
        const actualSku = bestItem.sku || skuKey;
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: bestItem.productName || skuKey,
          sloc: bestItem.sloc || bestItem.masterSloc || '',
          type: bestItem.type || '',
          expDate: expDate,
          score: 100
        });
      }
    }
    for (const [skuKey, items] of msltcMap) {
      const bestItem = items.find(it => it.rackName && !isBadSloc(it.rackName)) || items[0] || {};
      const actualSku = bestItem.sku || skuKey;
      if (skuKey.toLowerCase().trim() === cleaned.toLowerCase() && items.length > 0 && !suggestionMap.has(actualSku)) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: bestItem.productName || skuKey,
          sloc: bestItem.rackName || '',
          type: bestItem.type || '',
          expDate: expDate,
          score: 95
        });
      }
    }

    // 1b. Search by SLOC (Rak) in dataMap (SLOC MASTER) & MSLTC
    const rawLower = cleaned.toLowerCase();
    const noHyphenQuery = rawLower.replace(/[^a-z0-9]/g, '');

    if (cleaned.length >= 2) {
      for (const [skuKey, items] of dataMap) {
        for (const item of items) {
          const sloc = (item.sloc || item.masterSloc || '').trim();
          if (!sloc) continue;
          const lowerSloc = sloc.toLowerCase();
          const noHyphenSloc = lowerSloc.replace(/[^a-z0-9]/g, '');

          let slocScore = 0;
          if (lowerSloc === rawLower || noHyphenSloc === noHyphenQuery) {
            slocScore = 98;
          } else if (lowerSloc.startsWith(rawLower) || noHyphenSloc.startsWith(noHyphenQuery)) {
            slocScore = 92;
          } else if (cleaned.length >= 3 && (lowerSloc.includes(rawLower) || (noHyphenQuery.length >= 3 && noHyphenSloc.includes(noHyphenQuery)))) {
            slocScore = 86;
          }

          if (slocScore > 0) {
            const actualSku = item.sku || skuKey;
            const existing = suggestionMap.get(actualSku);
            if (!existing || slocScore > existing.score) {
              suggestionMap.set(actualSku, {
                sku: actualSku,
                productName: item.productName || skuKey,
                sloc: sloc,
                type: item.type || '',
                expDate: expDate,
                score: slocScore,
                matchedBy: 'sloc'
              });
            }
          }
        }
      }

      for (const [skuKey, items] of msltcMap) {
        for (const item of items) {
          const sloc = (item.rackName || '').trim();
          if (!sloc) continue;
          const lowerSloc = sloc.toLowerCase();
          const noHyphenSloc = lowerSloc.replace(/[^a-z0-9]/g, '');

          let slocScore = 0;
          if (lowerSloc === rawLower || noHyphenSloc === noHyphenQuery) {
            slocScore = 97;
          } else if (lowerSloc.startsWith(rawLower) || noHyphenSloc.startsWith(noHyphenQuery)) {
            slocScore = 91;
          } else if (cleaned.length >= 3 && (lowerSloc.includes(rawLower) || (noHyphenQuery.length >= 3 && noHyphenSloc.includes(noHyphenQuery)))) {
            slocScore = 85;
          }

          if (slocScore > 0) {
            const actualSku = item.sku || skuKey;
            const existing = suggestionMap.get(actualSku);
            if (!existing || slocScore > existing.score) {
              suggestionMap.set(actualSku, {
                sku: actualSku,
                productName: item.productName || skuKey,
                sloc: sloc,
                type: item.type || '',
                expDate: expDate,
                score: slocScore,
                matchedBy: 'sloc'
              });
            }
          }
        }
      }
    }

    // 2. Search by Product Name in dataMap
    for (const [skuKey, items] of dataMap) {
      const bestItem = items.find(it => !isBadSloc(it.sloc || it.masterSloc)) || items[0] || {};
      const actualSku = bestItem.sku || skuKey;
      if (suggestionMap.has(actualSku)) continue;
      
      const score = matchProductName(bestItem.productName, lowerQuery, queryWords);
      if (score > 0) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: bestItem.productName || skuKey,
          sloc: bestItem.sloc || bestItem.masterSloc || '',
          type: bestItem.type || '',
          expDate: expDate,
          score: score
        });
      }
    }

    // 3. Search in MSLTC map
    for (const [skuKey, items] of msltcMap) {
      const bestItem = items.find(it => it.rackName && !isBadSloc(it.rackName)) || items[0] || {};
      const actualSku = bestItem.sku || skuKey;
      if (suggestionMap.has(actualSku)) continue;

      const score = matchProductName(bestItem.productName, lowerQuery, queryWords);
      if (score > 0) {
        suggestionMap.set(actualSku, {
          sku: actualSku,
          productName: bestItem.productName || skuKey,
          sloc: bestItem.rackName || '',
          type: bestItem.type || '',
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
              ${item.sloc ? `<span class="dropdown-meta-sloc" ${item.matchedBy === 'sloc' ? 'style="color: #38bdf8; background: rgba(56, 189, 248, 0.14); padding: 1px 6px; border-radius: 4px; font-weight: 700;"' : ''}>📍 SLOC: <strong>${escapeHtml(item.sloc)}</strong>${item.matchedBy === 'sloc' ? ' ✨' : ''}</span>` : ''}
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
      results = [...dataMap.get(sku)].map(it => {
        const msInfo = getMsltcInfo(it.sku || sku, it.productName);
        return {
          ...it,
          msltcDays: (msInfo && msInfo.msltcDays !== undefined && msInfo.msltcDays !== null) ? msInfo.msltcDays : (it.msltcDays || 0),
          type: (msInfo && msInfo.type) ? msInfo.type : (it.type || 'Fresh')
        };
      });
    } else if (msltcMap.has(sku)) {
      const msltcFound = msltcMap.get(sku);
      results = msltcFound.map(m => ({
        sku: m.sku || m.productId || sku,
        sloc: m.rackName || 'Belum Ada SLOC di CWG',
        productName: m.productName || 'Produk MSLTC',
        masterSloc: m.rackName || '',
        type: m.type || 'Fresh',
        left: m.productId || '',
        msltcDays: (m.msltcDays !== undefined && m.msltcDays !== null) ? m.msltcDays : 0
      }));
    } else {
      results = searchSKU(sku);
    }

    if (results && Array.isArray(results)) {
      results.sort((a, b) => compareSlocNatural(a.sloc || a.masterSloc, b.sloc || b.masterSloc));
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
    if (results && Array.isArray(results)) {
      results.sort((a, b) => compareSlocNatural(a.sloc || a.masterSloc, b.sloc || b.masterSloc));
    }
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
      } else if (suggestions.some(s => s.matchedBy === 'sloc')) {
        // Jika pencarian menggunakan SLOC / Lokasi Rak, tampilkan seluruh hasil produk pada rak tersebut
        performSearch(val);
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

            <div class="qr-wrapper is-qr zoomable-qr" id="${qrId}" title="Klik / Ketuk untuk memperbesar QR Code" onclick="openQrZoomModal('${qrId}', '${escapeAttr(isSlocMode ? ((item.sloc && !isPlaceholderSloc(item.sloc)) ? item.sloc : itemSku) : barcodeValue)}', '${escapeAttr(isSlocMode ? ('SLOC: ' + ((item.sloc && !isPlaceholderSloc(item.sloc)) ? item.sloc : itemSku)) : ('Produk SKU: ' + itemSku))}', '${escapeAttr(item.productName || '')}')"></div>
            <div class="qr-zoom-hint-wrap" onclick="openQrZoomModal('${qrId}', '${escapeAttr(isSlocMode ? ((item.sloc && !isPlaceholderSloc(item.sloc)) ? item.sloc : itemSku) : barcodeValue)}', '${escapeAttr(isSlocMode ? ('SLOC: ' + ((item.sloc && !isPlaceholderSloc(item.sloc)) ? item.sloc : itemSku)) : ('Produk SKU: ' + itemSku))}', '${escapeAttr(item.productName || '')}')">
              <span class="qr-zoom-hint">🔍 Ketuk untuk perbesar</span>
            </div>
            ${!isSlocMode ? `
            <div class="product-barcode-1d-wrap">
              <svg id="bc1d_${idx}"></svg>
              <span class="product-barcode-1d-label">Barcode 1D Linear (Code 128)</span>
            </div>` : ''}

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

      const hasValidSloc = item.sloc && !isPlaceholderSloc(item.sloc);
      const qrValue = currentMode === 'sloc' ? (hasValidSloc ? item.sloc : itemSku) : barcodeValue;
      renderBarcodeToContainer(container, qrValue, 200);

      // Render 1D barcode in product mode
      if (currentMode !== 'sloc') {
        const bcSvg = document.getElementById(`bc1d_${idx}`);
        if (bcSvg && typeof JsBarcode !== 'undefined') {
          try {
            JsBarcode(bcSvg, itemSku, {
              format: 'CODE128',
              width: 1.6,
              height: 44,
              displayValue: true,
              fontSize: 12,
              fontOptions: 'bold',
              margin: 4,
              background: '#ffffff',
              lineColor: '#000000'
            });
          } catch (e) {
            console.warn('1D barcode render warning:', e);
          }
        }
      }
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
        if (masterList && masterList.length > 0) {
          const best = masterList.find(m => m.sloc && !isBadSloc(m.sloc)) || masterList[0];
          if (best && best.sloc) rack = best.sloc;
        }
      }
      if (rack === '-' || !rack || isBadSloc(rack)) {
        const candidate = item.sloc || item.rackName;
        if (candidate && (!isBadSloc(candidate) || rack === '-')) {
          rack = candidate;
        }
      }

      // Ambil data MSLTC rill dari engine DCC (msltcMap)
      const msltcInfo = getMsltcInfo(itemSku, item.productName);
      const msltcDays = (msltcInfo && msltcInfo.msltcDays !== undefined && msltcInfo.msltcDays !== null && Number(msltcInfo.msltcDays) > 0)
        ? Number(msltcInfo.msltcDays)
        : (item.msltcDays !== undefined && item.msltcDays !== null && Number(item.msltcDays) > 0 ? Number(item.msltcDays) : 0);

      const effectiveType = (msltcInfo && msltcInfo.type) ? msltcInfo.type : (item.type || 'Fresh');
      const typeBadge = effectiveType ? `<span class="type-badge ${getTypeBadgeClass(effectiveType)}">${escapeHtml(effectiveType)}</span>` : '';

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
                <span class="msltc-detail-value" style="color: var(--accent-primary);">${msltcDays > 0 ? msltcDays + ' Hari' : 'Tidak Ada (0 Hari)'}</span>
              </div>
              <div class="msltc-detail-item" style="grid-column: span 2;">
                <span class="msltc-detail-label">Nama Produk</span>
                <span class="msltc-detail-value" style="font-family: var(--font-body); font-size: 0.9rem; word-break: break-word;">${escapeHtml(item.productName || (msltcInfo ? msltcInfo.productName : '-'))}</span>
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
      const itemSku = item.sku || searchQuery;
      const msltcInfo = getMsltcInfo(itemSku, item.productName);
      const msltcDays = (msltcInfo && msltcInfo.msltcDays !== undefined && msltcInfo.msltcDays !== null && Number(msltcInfo.msltcDays) > 0)
        ? Number(msltcInfo.msltcDays)
        : (item.msltcDays !== undefined && item.msltcDays !== null && Number(item.msltcDays) > 0 ? Number(item.msltcDays) : 0);

      const expInput = document.getElementById(`expInput_${idx}`);
      let selectedExpDate = new Date();
      selectedExpDate.setDate(selectedExpDate.getDate() + (msltcDays > 0 ? msltcDays + 3 : 7));

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

        const diffMs = expDate.getTime() - now.getTime();
        const remainingDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const expDateStr = formatDateId(expDate);

        if (remainingDays <= 0) {
          // EXPIRED / REJECT
          alertBox.className = 'msltc-alert-box alert-danger';
          alertBadge.textContent = '⛔ BARANG EXPIRED / REJECT';
          const daysOver = Math.abs(remainingDays);
          alertMain.textContent = `SUDAH EXPIRED! (${daysOver === 0 ? 'Hari Ini Kedaluwarsa' : 'Lewat ' + daysOver + ' Hari'})`;
          alertSub.textContent = `Produk telah melewati tanggal expired (${expDateStr}). Dilarang dipajang/dijual!`;
          return;
        }

        if (msltcDays > 0) {
          // Batas Tanggal Penarikan = Expired Date minus MSLTC Days
          const clearanceDate = new Date(expDate);
          clearanceDate.setDate(clearanceDate.getDate() - msltcDays);

          // Sisa Hari Menuju Penarikan = Clearance Date minus Today
          const diffTime = clearanceDate.getTime() - now.getTime();
          const daysLeftToClearance = Math.round(diffTime / (1000 * 60 * 60 * 24));
          const clearanceDateStr = formatDateId(clearanceDate);

          if (daysLeftToClearance <= 0) {
            // OUT OF SHELF - PENARIKAN BARANG
            alertBox.className = 'msltc-alert-box alert-danger';
            alertBadge.textContent = '🚨 OUT OF SHELF - PENARIKAN BARANG';
            const daysOver = Math.abs(daysLeftToClearance);
            alertMain.textContent = `HARUS DITARIK SEKARANG! (${daysOver === 0 ? 'Hari Ini Batas Terakhir' : 'Lewat ' + daysOver + ' Hari'})`;
            alertSub.textContent = `Produk telah memasuki batas penarikan MSLTC (${msltcDays} hari sebelum expired). Batas penarikan: ${clearanceDateStr} (Expired: ${expDateStr}).`;
          } else {
            // PRODUK AMAN DI RAK (CLEARANCE OK)
            alertBox.className = 'msltc-alert-box alert-safe';
            alertBadge.textContent = '✅ PRODUK AMAN DI RAK';
            alertMain.textContent = `${daysLeftToClearance} Hari Lagi Harus Ditarik`;
            alertSub.textContent = `Produk aman di rak sampai ${clearanceDateStr} (Standar MSLTC: ${msltcDays} hari sebelum expired: ${expDateStr}). Sisa masa ED: ${remainingDays} Hari.`;
          }
        } else {
          // Produk tanpa standar MSLTC khusus di sheet MSLTC
          alertBox.className = 'msltc-alert-box alert-safe';
          alertBadge.textContent = '✅ PRODUK AMAN DI RAK';
          alertMain.textContent = `Sisa ${remainingDays} Hari Menuju Expired`;
          alertSub.textContent = `Produk belum memiliki standar batas MSLTC di sistem. Expired: ${expDateStr}.`;
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
        const canvas = qrWrapper.querySelector('canvas');
        const img = qrWrapper.querySelector('img');
        let qrSrc = '';
        if (canvas && canvas.toDataURL) {
          try { qrSrc = canvas.toDataURL('image/png'); } catch (e) {}
        }
        if (!qrSrc && img && img.src && !img.src.startsWith('data:image/gif')) {
          qrSrc = img.src;
        }
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

    renderBarcodeToContainer(container, qrText, 260);

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
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function isBadSloc(sloc) {
    if (!sloc) return true;
    const s = String(sloc).trim().toLowerCase();
    if (!s || s === '-' || s === 'none' || s === 'null' || s === 'undefined') return true;
    if (s.includes('belum ada') || s.includes('tidak ada')) return true;

    // Bad racks: badfresh, bad inbound, badinbound, bad-fresh, bad_fresh, bad stock, etc.
    if (/^bad[\s\-_]*/i.test(s) || /\bbad\b/i.test(s) || s.includes('badfresh') || s.includes('badinbound') || s.includes('badstock')) {
      return true;
    }

    // Reject, rusak, damage, quarantine, retur, hold, afkir
    if (/^(reject|rusak|damage|damaged|quarantine|karantina|retur|return|hold|afkir)/i.test(s) ||
        /\b(reject|rusak|damage|damaged|quarantine|karantina|retur|afkir)\b/i.test(s)) {
      return true;
    }

    return false;
  }

  function getSlocScore(sloc) {
    if (!sloc) return 999;
    const s = String(sloc).trim().toLowerCase();
    if (!s || s === '-' || s === 'none' || s.includes('belum ada') || s.includes('tidak ada')) {
      return 999;
    }

    // 1. Defect "bad..." racks go to bottom
    if (/^bad[\s\-_]*/i.test(s) || /\bbad\b/i.test(s) || s.includes('badfresh') || s.includes('badinbound') || s.includes('badstock')) {
      return 900;
    }

    // 2. Reject, rusak, damage, quarantine, retur
    if (/^(reject|rusak|damage|damaged|quarantine|karantina|retur|return|hold|afkir)/i.test(s) ||
        /\b(reject|rusak|damage|damaged|quarantine|karantina|retur|afkir)\b/i.test(s)) {
      return 800;
    }

    // 3. Staging, transit, temporary, inbound/outbound
    if (/^(staging|transit|temp|temporary|inbound|outbound)/i.test(s)) {
      return 100;
    }

    // 4. Physical standard racks (e.g. CH-01-A-01, FR-02-B-01, DR-01-A-01, AM-01, RK-01, ST-01, etc.)
    if (/^[a-z]{1,5}-\d+/i.test(s) || /^[a-z]\d+-\d+/i.test(s)) {
      return 10;
    }

    // 5. Any other legitimate rack name
    return 20;
  }

  function isPlaceholderSloc(str) {
    if (!str) return true;
    const s = String(str).trim().toLowerCase();
    return !s || s === '-' || s.includes('belum ada') || s.includes('tidak ada');
  }

  function compareSlocNatural(a, b) {
    const sA = String(a || '').trim();
    const sB = String(b || '').trim();
    if (!sA && !sB) return 0;
    if (!sA) return 1;
    if (!sB) return -1;

    const scoreA = getSlocScore(sA);
    const scoreB = getSlocScore(sB);

    if (scoreA !== scoreB) {
      return scoreA - scoreB;
    }

    return sA.localeCompare(sB, 'id', { numeric: true, sensitivity: 'base' });
  }

  function renderBarcodeToContainer(container, value, size = 200) {
    if (!container) return;
    container.innerHTML = '';

    const cleanVal = String(value || '').trim();
    if (!cleanVal) {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${size}px;height:${size}px;color:#64748b;font-size:0.8rem;text-align:center;padding:10px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom:6px;opacity:0.6;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Barcode tidak tersedia</span>
        </div>`;
      return;
    }

    let rendered = false;

    // 1. Try QRCode.js
    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(container, {
          text: cleanVal,
          width: size,
          height: size,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H,
        });

        const canvas = container.querySelector('canvas');
        const img = container.querySelector('img');

        if (canvas) {
          canvas.style.display = 'block';
          canvas.style.width = `${size}px`;
          canvas.style.height = `${size}px`;
          canvas.style.margin = '0 auto';
          canvas.style.borderRadius = '4px';

          // Try converting canvas to data URL for img
          try {
            const dataUrl = canvas.toDataURL('image/png');
            if (img && dataUrl && dataUrl.length > 50) {
              img.src = dataUrl;
            }
          } catch (e) {}

          if (img) {
            img.style.display = 'none';
          }
          rendered = true;
        } else if (img && img.src && !img.src.startsWith('data:image/gif')) {
          img.style.display = 'block';
          img.style.width = `${size}px`;
          img.style.height = `${size}px`;
          img.style.margin = '0 auto';
          rendered = true;
        }
      } catch (err) {
        console.warn('QRCode JS generation warning, falling back to image:', err);
      }
    }

    // 2. Fallback: If not rendered or canvas missing, use reliable QR Image API
    if (!rendered) {
      container.innerHTML = `
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(cleanVal)}" 
             alt="QR Code" 
             style="display:block;width:${size}px;height:${size}px;margin:0 auto;border-radius:4px;object-fit:contain;"
             onerror="this.onerror=null;this.parentElement.innerHTML='<span style=\\'color:#ef4444;font-size:0.8rem;padding:10px;display:block;text-align:center;\\'>Gagal memuat barcode</span>';" />
      `;
    }
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

  refreshBtn.addEventListener('click', async function () {
    await clearCache();
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
    window.openUniversalScanner = openUniversalScanner;
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
      navigator.serviceWorker.register('./sw.js?v=108')
        .then(reg => {
          console.log('[PWA] Service Worker registered:', reg.scope);
          try { reg.update(); } catch(e) {}
        })
        .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
    });
  }

  // Auto Cache Buster: Bersihkan semua cache lama yang tidak relevan secara otomatis
  if ('caches' in window) {
    caches.keys().then(keys => {
      keys.forEach(key => {
        if (key !== 'superapp-pwa-v108') {
          console.log('[Cache] Clearing old cache:', key);
          caches.delete(key);
        }
      });
    }).catch(e => console.warn('[Cache] Error cleaning caches:', e));
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

    // 🛡️ Guard: Fitur dinonaktifkan sementara khusus Hub CWG
    if (menu === 'complain' || menu === 'slip_gaji' || menu === 'hk' || menu === 'pinjaman') {
      if (typeof showDccToast === 'function') {
        showDccToast('info', 'Menu Dinonaktifkan', 'Fitur ini dinonaktifkan sementara khusus untuk Hub Cawang.');
      } else {
        alert('Fitur ini dinonaktifkan sementara khusus untuk Hub Cawang.');
      }
      return;
    }

    const hideAllWorkspaces = () => {
      const workspaces = [
        'homeMenuSection',
        'appWorkspace',
        'dccWorkspace',
        'slipGajiWorkspace',
        'mpScheduleWorkspace',
        'edSweeperWorkspace',
        'complainWorkspace',
        'koliInboundWorkspace',
        'edCorrectionWorkspace',
        'pinjamanWorkspace'
      ];
      workspaces.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
    };

    if (menu === 'barcode') {
      hideAllWorkspaces();
      const ws = document.getElementById('appWorkspace');
      if (ws) ws.classList.remove('hidden');
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');
    } else if (menu === 'dcc') {
      hideAllWorkspaces();
      const dccWs = document.getElementById('dccWorkspace');
      if (dccWs) {
        dccWs.classList.remove('hidden');
        dccWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');

      const hr = new Date().getHours();
      if (!selectedDccShift) {
        selectedDccShift = (hr >= 12) ? 'siang' : 'pagi';
      }
      applyDccShift(selectedDccShift);
      fetchDccMainList();
    } else if (menu === 'ed_sweeper') {
      hideAllWorkspaces();
      const edsWs = document.getElementById('edSweeperWorkspace');
      if (edsWs) {
        edsWs.classList.remove('hidden');
        edsWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');

      if (typeof switchEdsTab === 'function') switchEdsTab('main');
      if (typeof initEdsFlatpickr === 'function') initEdsFlatpickr();
      if (typeof fetchEdSweeperData === 'function') fetchEdSweeperData(true);
    } else if (menu === 'slip_gaji' || menu === 'hk') {
      hideAllWorkspaces();
      const sgWs = document.getElementById('slipGajiWorkspace');
      if (sgWs) sgWs.classList.remove('hidden');
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');
      if (typeof fetchSlipGajiData === 'function') fetchSlipGajiData();
    } else if (menu === 'mp_schedule') {
      hideAllWorkspaces();
      const mpsWs = document.getElementById('mpScheduleWorkspace');
      if (mpsWs) {
        mpsWs.classList.remove('hidden');
        mpsWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');

      if (typeof window.closeMpScheduleDetail === 'function') window.closeMpScheduleDetail();
      if (typeof switchMpsTab === 'function') switchMpsTab('manpower');
      if (typeof fetchMpScheduleData === 'function') fetchMpScheduleData();
    } else if (menu === 'complain') {
      hideAllWorkspaces();
      const cplWs = document.getElementById('complainWorkspace');
      if (cplWs) cplWs.classList.remove('hidden');
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');
      if (typeof fetchComplainData === 'function') fetchComplainData();
    } else if (menu === 'koli_inbound') {
      hideAllWorkspaces();
      const koliWs = document.getElementById('koliInboundWorkspace');
      if (koliWs) {
        koliWs.classList.remove('hidden');
        koliWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');
      if (typeof window.fetchKoliInboundData === 'function') {
        window.fetchKoliInboundData();
      }
    } else if (menu === 'ed_correction' || menu === 'edc') {
      hideAllWorkspaces();
      const edcWs = document.getElementById('edCorrectionWorkspace');
      if (edcWs) {
        edcWs.classList.remove('hidden');
        edcWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.remove('hidden');

      if (typeof window.switchEdcTab === 'function') window.switchEdcTab('main');
      if (typeof window.initEdcFlatpickr === 'function') window.initEdcFlatpickr();
      if (typeof window.initEdcInputListeners === 'function') window.initEdcInputListeners();
      if (typeof window.fetchEdCorrectionData === 'function') window.fetchEdCorrectionData(true);
    } else if (menu === 'pinjaman') {
      hideAllWorkspaces();
      const pnjWs = document.getElementById('pinjamanWorkspace');
      if (pnjWs) {
        pnjWs.classList.remove('hidden');
        pnjWs.scrollTop = 0;
      }
      const bBtn = document.getElementById('backToMenuBtn');
      if (bBtn) bBtn.classList.add('hidden'); // Pinjaman workspace memiliki top-bar back button tersendiri

      if (typeof window.initPinjamanModule === 'function') {
        window.initPinjamanModule();
      }
    } else if (menu === 'retur') {
      alert('Fitur Retur Task sedang disiapkan.');
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
    const edcWs = document.getElementById('edCorrectionWorkspace');
    if (edcWs) edcWs.classList.add('hidden');
    document.getElementById('slipGajiWorkspace').classList.add('hidden');
    document.getElementById('mpScheduleWorkspace').classList.add('hidden');
    document.getElementById('complainWorkspace').classList.add('hidden');
    const koliWs = document.getElementById('koliInboundWorkspace');
    if (koliWs) koliWs.classList.add('hidden');
    const pnjWs = document.getElementById('pinjamanWorkspace');
    if (pnjWs) pnjWs.classList.add('hidden');
    document.getElementById('backToMenuBtn').classList.add('hidden');
    closeComplainDetail();
    if (typeof window.closeKoliDetailModal === 'function') {
      window.closeKoliDetailModal();
    }

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

    // 2.7 Close HK detail if open
    const sgDetail = document.getElementById('sgDetailSection');
    if (sgDetail && !sgDetail.classList.contains('hidden')) {
      closeSlipGajiDetail();
      return true;
    }

    // 2.8 Close Complain detail if open
    const cplDetail = document.getElementById('cplDetailSection');
    if (cplDetail && !cplDetail.classList.contains('hidden')) {
      closeComplainDetail();
      return true;
    }

    // 2.9 Close Koli Inbound detail if open
    const koliDetail = document.getElementById('koliDetailModal');
    if (koliDetail && !koliDetail.classList.contains('hidden')) {
      if (typeof window.closeKoliDetailModal === 'function') {
        window.closeKoliDetailModal();
      }
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

    // 3.6 Khusus ED Correction Workspace: Jika sedang di tab Scan atau Report, kembali ke Main List!
    const edcConfirmModal = document.getElementById('edcConfirmEditModal');
    if (edcConfirmModal && !edcConfirmModal.classList.contains('hidden')) {
      closeEdcConfirmEditModal();
      return true;
    }
    const edcSetupModal = document.getElementById('edcSetupModal');
    if (edcSetupModal && !edcSetupModal.classList.contains('hidden')) {
      closeEdcSetupModal();
      return true;
    }
    const edcWorkspace = document.getElementById('edCorrectionWorkspace');
    if (edcWorkspace && !edcWorkspace.classList.contains('hidden')) {
      if (typeof currentEdcTab !== 'undefined' && currentEdcTab !== 'main') {
        if (typeof switchEdcTab === 'function') switchEdcTab('main');
        return true;
      }
      goBackToMenu();
      return true;
    }

    const pnjWorkspace = document.getElementById('pinjamanWorkspace');
    if (pnjWorkspace && !pnjWorkspace.classList.contains('hidden')) {
      if (typeof currentPinjamanTab !== 'undefined' && currentPinjamanTab !== 'pinjam') {
        if (typeof switchPinjamanTab === 'function') switchPinjamanTab('pinjam');
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

  const DCC_SPREADSHEET_ID = '1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ';
  const DCC_BASE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DCC_SPREADSHEET_ID}/gviz/tq?tqx=out:csv`;
  const DCC_MAIN_SHEET_URL = DCC_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Mainlist SKU');
  const DCC_HASIL_SHEET_URL = DCC_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Hasil DCC');
  const DCC_TASK1_URL = DCC_BASE_SHEET_URL + '&sheet=Task%201';
  const DCC_TASK2_URL = DCC_BASE_SHEET_URL + '&sheet=Task%202';
  const DCC_HASIL1_URL = DCC_BASE_SHEET_URL + '&sheet=Hasil%20Task%201';
  const DCC_HASIL2_URL = DCC_BASE_SHEET_URL + '&sheet=Hasil%20Task%202';
  const DCC_MTG_SHEET_URL = DCC_BASE_SHEET_URL + '&sheet=Hasil%20DCC';
  const DCC_REPORT_URL = DCC_BASE_SHEET_URL + '&sheet=Report';
  const DCC_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbygTPu8soPeO8j0l88UMUcBQrSi7WFCjSe-G2PJV5vg_JLsEim1q2mHuaV9nT6GSQj3sw/exec';

  const DCC_MAIN_CACHE_KEY = 'DCC_MAIN_CACHE_CWG_V2';
  const DCC_REPORT_CACHE_KEY = 'DCC_REPORT_CACHE_CWG_V1';
  const DCC_SUBMITTED_CACHE_KEY = 'DCC_SUBMITTED_CACHE_CWG_V1';
  const DCC_PETUGAS2_KEY = 'DCC_PETUGAS2_NAME_CWG_V1';
  const DCC_PIN_KEY = 'DCC_AUTH_PIN_KEY_CWG_V1';
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
      const candidates = [];
      if (dataMap.has(cleanSku)) {
        candidates.push(...dataMap.get(cleanSku));
      }
      const noZero = cleanSku.replace(/^0+/, '');
      if (noZero && noZero !== cleanSku && dataMap.has(noZero)) {
        candidates.push(...dataMap.get(noZero));
      }

      if (candidates.length > 0) {
        const good = candidates.find(it => {
          const s = (it.sloc || it.masterSloc || '').trim();
          return s && !isBadSloc(s);
        });
        if (good) return (good.sloc || good.masterSloc || '').trim();

        for (const it of candidates) {
          const s = (it.sloc || it.masterSloc || '').trim();
          if (s && s !== 'Belum Ada SLOC di Sistem' && s !== 'Belum ada SLOC') return s;
        }
      }
    }

    // 2. Search in MSLTC msltcMap
    if (msltcMap) {
      const candidates = [];
      if (msltcMap.has(cleanSku)) {
        candidates.push(...msltcMap.get(cleanSku));
      }
      const noZero = cleanSku.replace(/^0+/, '');
      if (noZero && noZero !== cleanSku && msltcMap.has(noZero)) {
        candidates.push(...msltcMap.get(noZero));
      }

      if (candidates.length > 0) {
        const good = candidates.find(it => {
          const r = (it.rackName || '').trim();
          return r && !isBadSloc(r);
        });
        if (good) return (good.rackName || '').trim();

        for (const it of candidates) {
          const r = (it.rackName || '').trim();
          if (r && r !== 'Belum Ada SLOC di Sistem' && r !== 'Belum ada SLOC' && r !== 'Belum Ada SLOC di CWG') return r;
        }
      }
    }

    return '';
  }

  function enrichDccItemWithSupersheet(item) {
    if (!item) return item;
    const cleanSku = String(item.sku || '').trim();
    const noZero = cleanSku.replace(/^0+/, '');

    // 1. Detect shifted row fields (e.g. from sheet where Col D had 'available')
    let curName = (item.productName || '').trim();
    let curSloc = (item.slocExisting || '').trim();
    let curStock = String(item.stock !== undefined && item.stock !== null ? item.stock : '').trim();

    // If curName is "available", then curSloc is probably the actual product name and curStock is the rack
    if (curName.toLowerCase() === 'available') {
      if (curSloc && curSloc.length > 3 && !/^[A-Z0-9]{1,4}-[A-Z0-9\-]+$/i.test(curSloc)) {
        item.productName = curSloc;
        curName = curSloc;
        if (/^[A-Z0-9]{1,4}-[A-Z0-9\-]+$/i.test(curStock)) {
          item.slocExisting = curStock;
          curSloc = curStock;
          item.stock = '0';
        } else {
          item.slocExisting = '';
          curSloc = '';
        }
      } else {
        item.productName = '';
        curName = '';
      }
    }

    // 2. Resolve Product Name if missing or "Tanpa Nama Produk"
    const isBadName = !curName || 
      curName.toLowerCase() === 'available' || 
      curName.toLowerCase() === 'tanpa nama produk' || 
      curName.toLowerCase() === 'null' || 
      curName.toLowerCase() === 'undefined' ||
      curName.toLowerCase() === '-';

    if (isBadName) {
      let foundName = '';
      // Search in dataMap (Master Rack)
      if (dataMap) {
        const cands = (dataMap.has(cleanSku) ? dataMap.get(cleanSku) : [])
          .concat(noZero && noZero !== cleanSku && dataMap.has(noZero) ? dataMap.get(noZero) : []);
        const candWithName = cands.find(c => c && c.productName && c.productName.trim().length > 2);
        if (candWithName) foundName = candWithName.productName.trim();
      }
      // Search in msltcMap
      if (!foundName && msltcMap) {
        const info = typeof getMsltcInfo === 'function' ? getMsltcInfo(cleanSku) : null;
        if (info && info.productName && info.productName.trim().length > 2) {
          foundName = info.productName.trim();
        }
      }
      // Search in edsDataList or updateDataLookupMap
      if (!foundName && typeof edsDataList !== 'undefined' && Array.isArray(edsDataList)) {
        const edsItem = edsDataList.find(e => (e.sku || '').trim() === cleanSku || (noZero && (e.sku || '').trim() === noZero));
        if (edsItem && edsItem.productName && edsItem.productName.trim().length > 2) {
          foundName = edsItem.productName.trim();
        }
      }
      if (foundName) {
        item.productName = foundName;
        curName = foundName;
      }
    }

    // 3. Resolve Rack / SLOC
    const isBadRack = !curSloc || 
      curSloc === '0' || 
      curSloc === '-' || 
      curSloc === 'Belum ada SLOC' || 
      curSloc === 'Belum Ada SLOC di Sistem' || 
      curSloc === 'Belum Ada SLOC di CWG' || 
      isBadSloc(curSloc) || 
      (curName && curSloc.toLowerCase() === curName.toLowerCase());

    if (isBadRack) {
      const superSloc = getSuperSheetSloc(cleanSku);
      if (superSloc && !isBadSloc(superSloc)) {
        item.slocExisting = superSloc;
        curSloc = superSloc;
      } else {
        const info = typeof getMsltcInfo === 'function' ? getMsltcInfo(cleanSku) : null;
        if (info && info.rackName && !isBadSloc(info.rackName)) {
          item.slocExisting = info.rackName;
          curSloc = info.rackName;
        }
      }
    }

    // 4. Resolve Stock (if stock is 0 or empty or looks like a rack)
    if (!item.stock || item.stock === '0' || isNaN(Number(item.stock))) {
      // If stock has rack pattern and slocExisting was missing, heal it
      if (typeof item.stock === 'string' && /^[A-Z0-9]{1,4}-[A-Z0-9\-]+$/i.test(item.stock.trim())) {
        if (!item.slocExisting || isBadSloc(item.slocExisting)) {
          item.slocExisting = item.stock.trim();
        }
        item.stock = '0';
      }
      // Look up stock from dataMap
      if (dataMap) {
        const cands = (dataMap.has(cleanSku) ? dataMap.get(cleanSku) : [])
          .concat(noZero && noZero !== cleanSku && dataMap.has(noZero) ? dataMap.get(noZero) : []);
        const candWithQty = cands.find(c => c && c.qty && !isNaN(Number(c.qty)) && Number(c.qty) > 0);
        if (candWithQty) {
          item.stock = String(candWithQty.qty);
        }
      }
    }

    return item;
  }

  function enrichAllDccListsWithSupersheet() {
    let updated = false;
    [dccTask1List, dccTask2List, dccMainListData].forEach(list => {
      if (!list || !Array.isArray(list)) return;
      list.forEach(item => {
        const oldName = item.productName;
        const oldSloc = item.slocExisting;
        const oldStock = item.stock;
        enrichDccItemWithSupersheet(item);
        if (oldName !== item.productName || oldSloc !== item.slocExisting || oldStock !== item.stock) {
          updated = true;
        }
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

      cleanRows.push(row);
    }
    return { skuSet, rows: cleanRows };
  }

  // ── DCC Security Lock & Shift Selection (PIN DIHAPUS KHUSUS CWG) ──
  window.openDccLockModal = function () {
    const modal = document.getElementById('dccLockModal');
    if (modal) modal.classList.add('hidden');
    window.openAppMenu('dcc');
  };

  window.closeDccLockModal = function () {
    const modal = document.getElementById('dccLockModal');
    if (modal) modal.classList.add('hidden');
  };

  window.selectDccShift = function (shift) {
    selectedDccShift = shift;
    const cardPagi = document.getElementById('shiftCardPagi');
    const cardSiang = document.getElementById('shiftCardMalam');
    if (cardPagi) cardPagi.classList.toggle('selected', shift === 'pagi');
    if (cardSiang) cardSiang.classList.toggle('selected', shift === 'siang');
    applyDccShift(shift);
  };

  window.toggleDccPinVisibility = function () {
    // PIN sudah dihapus di Hub CWG
  };

  window.verifyAndEnterDcc = function () {
    const modal = document.getElementById('dccLockModal');
    if (modal) modal.classList.add('hidden');
    window.openAppMenu('dcc');
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
      if (dccSubmittedSkuSet.has(skuClean)) {
        count++;
      }
    }
    return count;
  }

  window.refreshDccData = function () {
    try {
      localStorage.removeItem(DCC_MAIN_CACHE_KEY);
      localStorage.removeItem(DCC_SUBMITTED_CACHE_KEY);
    } catch (e) {}
    dccTask1List = [];
    dccTask2List = [];
    dccSubmittedTask1Set = new Set();
    dccSubmittedTask2Set = new Set();
    dccSubmittedSkuSet = new Set();
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
      if (activeSubmittedSet.has(skuClean) || dccSubmittedSkuSet.has(skuClean)) {
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
      const isSubmitted = activeSubmittedSet.has(skuClean) || dccSubmittedSkuSet.has(skuClean);

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

      // Fetch Mainlist SKU and Hasil DCC in parallel
      const [resMain, resHasilDcc] = await Promise.all([
        fetch(DCC_MAIN_SHEET_URL + '&_t=' + Date.now()).catch(() => null),
        fetch(DCC_HASIL_SHEET_URL + '&_t=' + Date.now()).catch(() => null)
      ]);

      let parsedFromMainlist = false;

      // 1. Primary: Parse Mainlist SKU (Master Sheet unified layout: Shift 1 Pagi vs Shift 2 Siang)
      if (resMain && resMain.ok) {
        const textMain = await resMain.text();
        const mainRows = parseCSV(textMain);
        if (mainRows && mainRows.length > 1) {
          const headers = mainRows[0].map(h => (h || '').toLowerCase().trim());
          const sampleRows = mainRows.slice(1, Math.min(mainRows.length, 12));

          // 1. Shift Column: Detect by header OR sample row values containing shift/pagi/siang
          let shiftIdx = headers.findIndex(h => h === 'shift' || h === 'shift_name' || (h.startsWith('shift') && !h.includes('date')));
          if (shiftIdx === -1) {
            shiftIdx = headers.findIndex((_, colIdx) => sampleRows.some(r => /shift\s*[12]|pagi|siang/i.test((r[colIdx] || '').trim())));
          }

          // 2. SKU Column: Detect by header OR sample row numeric digits (4-15 chars)
          let skuIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && (h === 'sku' || h === 'sku no' || h === 'sku number' || h === 'sku_id' || h === 'item_code') && !h.includes('/'));
          if (skuIdx === -1) {
            skuIdx = headers.findIndex((_, colIdx) => colIdx !== shiftIdx && sampleRows.filter(r => /^\d{4,15}$/.test((r[colIdx] || '').trim())).length >= Math.ceil(sampleRows.length * 0.7));
          }
          if (skuIdx === -1) {
            skuIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && (h === 'location_name' || h === 'sku'));
          }
          if (skuIdx === -1) skuIdx = 2;

          // 3. SLOC / Rack Column: Detect by rack pattern (e.g. L1-AMF-RF3-T5-2) or header
          let slocIdx = headers.findIndex((_, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && sampleRows.some(r => /^[A-Z0-9]{1,4}-[A-Z0-9\-]+$/i.test((r[colIdx] || '').trim())));
          if (slocIdx === -1) {
            slocIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && (h.includes('lokasi') || h.includes('rack') || h.includes('sloc') || h.includes('bin')) && !h.includes('/') && sampleRows.some(r => (r[colIdx] || '').trim().length > 0));
          }
          if (slocIdx === -1) slocIdx = 4;

          // 4. Product Name Column: Detect text column with descriptive names, avoiding shift, sku, sloc, dates
          let nameIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && colIdx !== slocIdx && (h === 'nama produk' || h === 'product name' || h === 'nama_produk' || h === 'nama barang' || h === 'item_name' || h === 'deskripsi'));
          if (nameIdx === -1) {
            nameIdx = headers.findIndex((h, colIdx) => 
              colIdx !== shiftIdx && colIdx !== skuIdx && colIdx !== slocIdx &&
              h !== 'datenow' && !h.includes('date') && !h.includes('status') && !h.includes('qty') &&
              sampleRows.some(r => {
                const val = (r[colIdx] || '').trim();
                return val.length > 3 && /[a-zA-Z]/.test(val) && !/shift\s*[12]|pagi|siang/i.test(val);
              })
            );
          }
          if (nameIdx === -1) nameIdx = 3;

          // 5. Stock / Qty Column
          let stockIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && colIdx !== slocIdx && colIdx !== nameIdx && (h.includes('qty') || h.includes('stock') || h === 'system_qty' || h === 'qty_system'));
          if (stockIdx === -1) stockIdx = 5;

          // 6. Type Column
          const typeIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && colIdx !== slocIdx && colIdx !== nameIdx && colIdx !== stockIdx && (h === 'type' || h.includes('type') || h === 'expiry_date' || h === 'fresh'));

          // 7. Petugas / PIC Column
          const petugasIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && colIdx !== slocIdx && colIdx !== nameIdx && (h.includes('petugas') || h.includes('pic') || h.includes('assign')));

          // 8. Status Column
          let statusIdx = headers.findIndex((_, colIdx) => sampleRows.some(r => /^(?:PENDING|DONE|CANCEL|SELESAI)$/i.test((r[colIdx] || '').trim())));
          if (statusIdx === -1) {
            statusIdx = headers.findIndex((h, colIdx) => colIdx !== shiftIdx && colIdx !== skuIdx && (h === 'status' || h.endsWith('_status') || h === 'status_notes_name'));
          }

          dccTask1List = [];
          dccTask2List = [];
          dccSubmittedTask1Set = new Set();
          dccSubmittedTask2Set = new Set();
          dccSubmittedSkuSet = new Set();

          for (let i = 1; i < mainRows.length; i++) {
            const row = mainRows[i];
            let rawSku = (row[skuIdx] || '').trim();
            let cleanSku = rawSku.includes('|') ? rawSku.split('|')[0].trim() : rawSku;
            if (!cleanSku) continue;

            let name = (row[nameIdx] || '').trim();
            let sloc = (row[slocIdx] || '').trim();
            let stock = (row[stockIdx] || '').trim();
            let typeVal = typeIdx !== -1 ? (row[typeIdx] || '').trim() : '';
            const shiftStr = shiftIdx !== -1 ? (row[shiftIdx] || '').toLowerCase().trim() : '';
            const statusVal = statusIdx !== -1 ? (row[statusIdx] || '').toUpperCase().trim() : '';
            const petugasVal = petugasIdx !== -1 ? (row[petugasIdx] || '').trim() : '';

            // 🛡️ Auto-Detect Column Shifting (e.g. if Col D/row[3] is 'available')
            if (name.toLowerCase() === 'available' || (row[3] && String(row[3]).trim().toLowerCase() === 'available')) {
              name = (row[4] || '').trim();
              sloc = (row[5] || '').trim();
              stock = (row[6] && !isNaN(Number(row[6]))) ? String(row[6]).trim() : '0';
              if (row[6] && isNaN(Number(row[6]))) typeVal = String(row[6]).trim();
            }

            const isPagi = shiftStr.includes('2') || shiftStr.includes('siang')
              ? false
              : (shiftStr.includes('1') || shiftStr.includes('pagi') || (!shiftStr && isItemTask1({ assign: petugasVal })));
            const assign = petugasVal || (isPagi ? 'Bintang' : p2);

            const item = {
              sku: cleanSku,
              productName: name,
              slocExisting: sloc,
              stock: stock,
              type: typeVal,
              assign: assign,
              shift: isPagi ? 'Shift 1 (Pagi)' : 'Shift 2 (Siang)',
              task: isPagi ? 'task1' : 'task2',
              status: statusVal
            };

            enrichDccItemWithSupersheet(item);

            if (isPagi) {
              dccTask1List.push(item);
              if (statusVal === 'DONE') {
                dccSubmittedTask1Set.add(cleanSku.toLowerCase());
              }
            } else {
              dccTask2List.push(item);
              if (statusVal === 'DONE') {
                dccSubmittedTask2Set.add(cleanSku.toLowerCase());
              }
            }
            if (statusVal === 'DONE') {
              dccSubmittedSkuSet.add(cleanSku.toLowerCase());
            }
          }

          if (dccTask1List.length > 0 || dccTask2List.length > 0) {
            parsedFromMainlist = true;
          }
        }
      }

      // 2. Primary: Parse Hasil DCC (Unified audit submission output)
      if (resHasilDcc && resHasilDcc.ok) {
        const textHasilDcc = await resHasilDcc.text();
        const parsedHasilDcc = parseHasilSheetRows(textHasilDcc);
        dccHasil1Rows = [];
        dccHasil2Rows = [];

        // Fast lookup for items explicitly marked as PENDING in Mainlist SKU
        const pendingSkuMap = new Set();
        if (parsedFromMainlist) {
          [...dccTask1List, ...dccTask2List].forEach(it => {
            if (it.status === 'PENDING') {
              if (it.sku) pendingSkuMap.add(it.sku.toLowerCase());
            }
          });
        }

        for (const row of parsedHasilDcc.rows) {
          const sku1 = (row[1] || '').trim().toLowerCase();
          const sku17 = (row[17] || '').trim().toLowerCase();
          const inputBy = (row[18] || '').trim().toLowerCase();

          const isExplicitPending = pendingSkuMap.has(sku1) || (sku17 && pendingSkuMap.has(sku17));

          const isTask1Item = inputBy.includes('bintang') || (sku1 && dccTask1List.some(it => it.sku.toLowerCase() === sku1));
          if (isTask1Item) {
            dccHasil1Rows.push(row);
            if (!isExplicitPending) {
              if (sku1) dccSubmittedTask1Set.add(sku1);
              if (sku17) dccSubmittedTask1Set.add(sku17);
            }
          } else {
            dccHasil2Rows.push(row);
            if (!isExplicitPending) {
              if (sku1) dccSubmittedTask2Set.add(sku1);
              if (sku17) dccSubmittedTask2Set.add(sku17);
            }
          }
          if (!isExplicitPending) {
            if (sku1) dccSubmittedSkuSet.add(sku1);
            if (sku17) dccSubmittedSkuSet.add(sku17);
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
      if (activeSubmittedSet.has(skuClean) || dccSubmittedSkuSet.has(skuClean)) {
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
        return activeSubmittedSet.has(skuClean) || dccSubmittedSkuSet.has(skuClean);
      });
    } else if (currentDccStatusFilter === 'pending') {
      filtered = filtered.filter(item => {
        const skuClean = (item.sku || '').trim().toLowerCase();
        const isDone = activeSubmittedSet.has(skuClean) || dccSubmittedSkuSet.has(skuClean);
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

  // Note: getMsltcInfo is centralized at top of script with SKU + product name matching

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
      action: 'saveDccAudit',
      module: 'dcc',
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
      const skuLower = skuNo.toLowerCase();
      const allDccItems = [...dccTask1List, ...dccTask2List];
      const foundItem = allDccItems.find(it => it.sku.toLowerCase() === skuLower);
      if (foundItem) {
        foundItem.status = 'DONE';
      }

      if (selectedDccShift === 'pagi') {
        dccSubmittedTask1Set.add(skuLower);
        dccHasil1Rows.push([timestamp, skuNo, namaSku, slocExisting, slocActual, expiredDate, fisikGood, fisikBad, sales, safeReasonSloc, reasonBad, finalEvidance, '', '', '', '', '', skuNo, inputByVal, labelProduct, labelSloc]);
      } else {
        dccSubmittedTask2Set.add(skuLower);
        dccHasil2Rows.push([timestamp, skuNo, namaSku, slocExisting, slocActual, expiredDate, fisikGood, fisikBad, sales, safeReasonSloc, reasonBad, finalEvidance, '', '', '', '', '', skuNo, inputByVal, labelProduct, labelSloc]);
      }
      dccSubmittedSkuSet.add(skuLower);

      try {
        localStorage.setItem(DCC_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(dccSubmittedSkuSet)));
        localStorage.setItem(DCC_MAIN_CACHE_KEY, JSON.stringify({
          task1: dccTask1List,
          task2: dccTask2List,
          submitted1: Array.from(dccSubmittedTask1Set),
          submitted2: Array.from(dccSubmittedTask2Set),
          hasil1: dccHasil1Rows,
          hasil2: dccHasil2Rows
        }));
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
          <div>Mengambil data HK Manpower dari Google Sheets...</div>
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
        showDccToast('success', 'Data Disinkronkan!', `Berhasil memuat ${slipGajiList.length} data HK Manpower.`);
      }

      // If active MP was open, re-render it with fresh data
      if (currentActiveMpId) {
        window.showSlipGajiDetail(currentActiveMpId);
      }

    } catch (err) {
      console.error('Error fetching HK data:', err);
      if (slipGajiList.length === 0 && cardContainer) {
        cardContainer.innerHTML = `
          <div class="sg-error-box">
            <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
            <div style="font-weight: 600; margin-bottom: 4px;">Gagal Memuat Data HK Manpower</div>
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
            Cari Data HK Manpower
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; max-width: 340px; margin: 0 auto;">
            Ketik nama Manpower atau ID pada kolom pencarian di atas untuk melihat rincian Hari Kerja (HK).
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
            <div class="sg-stat-box sg-stat-highlight">
              <span class="sg-stat-lbl">Total Hari Kerja</span>
              <span class="sg-stat-val font-accent">${escapeHtml(mp.hk)} Hari</span>
            </div>
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Jumlah Lembur</span>
              <span class="sg-stat-val ${totalOtCount > 0 ? 'font-accent' : ''}">${escapeHtml(otDisplayText)}</span>
            </div>
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Hari Libur (Off)</span>
              <span class="sg-stat-val">${escapeHtml(mp.off)} Hari</span>
            </div>
            <div class="sg-stat-box">
              <span class="sg-stat-lbl">Ketidakhadiran (Alfa)</span>
              <span class="sg-stat-val" style="${mp.alfa !== '0' ? 'color: var(--color-error); font-weight: 700;' : ''}">${escapeHtml(mp.alfa)} Hari</span>
            </div>
          </div>

          <div class="sg-card-footer">
            <span class="sg-view-btn">
              <span>Lihat Rincian HK</span>
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
    const totalOtCount = (Number(mp.ot24) || 0) + (Number(mp.otOver4) || 0);

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
              <div class="sg-company-sub">Rekap Kehadiran & HK Manpower — Hub ${escapeHtml(mp.hub)}</div>
            </div>
          </div>
          <div class="sg-slip-badge-wrapper">
            <span class="sg-slip-type-badge">REKAP HK RESMI</span>
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
              <span class="sg-emp-lbl">Status Kehadiran</span>
              <span class="sg-emp-val font-accent" style="font-weight: 700;">${escapeHtml(mp.hk)} HK Aktif</span>
            </div>
          </div>
        </div>

        <!-- Grand Total HK Highlight Box -->
        <div class="sg-grand-total-row" style="margin-top: 0; margin-bottom: 18px;">
          <div>
            <div class="sg-grand-lbl">TOTAL HARI KERJA (HK)</div>
            <div class="sg-grand-sub">Total shift kerja yang tercatat periode ini</div>
          </div>
          <div class="sg-grand-val mono-font">${escapeHtml(mp.hk)} <span style="font-size: 1rem; font-weight: 700; opacity: 0.85;">HARI</span></div>
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
                <tr style="background: rgba(6, 214, 160, 0.08);">
                  <td style="font-weight: 700; color: var(--accent-primary);">Total Hari Kerja (HK)</td>
                  <td style="text-align:right; font-weight: 800; color: var(--accent-primary); font-size: 1.05rem;">${escapeHtml(mp.hk)}</td>
                  <td style="text-align:right; color: var(--accent-primary); font-weight: 600;">Hari</td>
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
                <tr style="background: rgba(0, 180, 216, 0.05);">
                  <td style="font-weight: 600; color: var(--accent-secondary);">Total Jumlah Lembur</td>
                  <td style="text-align:right; font-weight: 700; color: var(--accent-secondary);">${totalOtCount}</td>
                  <td style="text-align:right; color: var(--accent-secondary); font-weight: 600;">Kali</td>
                </tr>
                <tr>
                  <td>Hari Libur (Off)</td>
                  <td style="text-align:right;">${escapeHtml(mp.off)}</td>
                  <td style="text-align:right; color: var(--text-muted);">Hari</td>
                </tr>
                <tr>
                  <td>Ketidakhadiran (Alfa)</td>
                  <td style="text-align:right; color: ${mp.alfa !== '0' ? 'var(--color-error)' : 'inherit'}; font-weight: ${mp.alfa !== '0' ? '700' : 'normal'};">${escapeHtml(mp.alfa)}</td>
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

        <!-- Action Buttons (Print & WhatsApp Share) -->
        <div class="sg-actions-bar no-print">
          <button type="button" class="sg-btn-action sg-btn-whatsapp" onclick="copySlipGajiText('${escapeHtml(mp.id || mp.name)}')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Salin Rincian HK</span>
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
      `📋 *REKAP HARI KERJA (HK) MANPOWER ASTRO*`,
      `🏢 Hub Lokasi: *${mp.hub}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 *Nama*: ${mp.name}`,
      `🆔 *ID MP*: ${mp.id || '-'}`,
      `🏷️ *Jabatan/Role*: ${mp.role}`,
      `📅 *Join Date*: ${mp.joinDate}`,
      `───────────────────────`,
      `📊 *RINCIAN KEHADIRAN & HK*:`,
      `• Total Hari Kerja (HK) : *${mp.hk} Hari*`,
      `• Total Lembur          : *${totalOtCount} Kali* (2-4j: ${mp.ot24}x, >4j: ${mp.otOver4}x)`,
      `• Libur (Off)           : ${mp.off} Hari`,
      `• Ketidakhadiran (Alfa) : ${mp.alfa} Hari`,
      (mp.ho1 !== '0' || mp.ho2 !== '0' ? `• Holiday Overtime      : HO1=${mp.ho1}, HO2=${mp.ho2}` : null),
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `⭐ *TOTAL HK : ${mp.hk} HARI*`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      `_Generated via Super App MTG_`
    ].filter(Boolean).join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(() => {
        showDccToast('success', 'Rincian HK Disalin!', `Data ${mp.name} berhasil disalin ke clipboard.`);
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
      showDccToast('success', 'Rincian HK Disalin!', `Data ${name} berhasil disalin.`);
    } catch (e) {
      showDccToast('error', 'Gagal Menyalin', 'Salin manual teks rincian HK.');
    }
    document.body.removeChild(ta);
  }

  window.printSlipGaji = function () {
    const activeMp = slipGajiList.find(item => item.id === currentActiveMpId || item.name === currentActiveMpId);
    const safeName = activeMp ? activeMp.name.replace(/\s+/g, '_') : 'Manpower';
    triggerNativePrint('print-mode-slip', `Rekap_HK_${safeName}`);
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

  const APP_VERSION_CODE = 29; // Local current version code (v1.3.3 CWG Master Data Fix)
  const APP_VERSION_NAME = '1.3.3';
  const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/tw1nss/superapp-release/main/version.json';

  let currentUpdateData = null;
  let isCheckingUpdate = false;

  function getLocalAppVersion() {
    let nativeCode = null;
    let nativeName = null;
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.getAppVersionCode === 'function') {
      try {
        nativeCode = window.AndroidUpdateBridge.getAppVersionCode();
        nativeName = window.AndroidUpdateBridge.getAppVersionName();
      } catch (e) {
        console.warn('Error reading native version:', e);
      }
    }
    return {
      versionCode: APP_VERSION_CODE,
      versionName: APP_VERSION_NAME,
      nativeVersionCode: nativeCode,
      nativeVersionName: nativeName,
      isNativeAndroid: (nativeCode !== null)
    };
  }

  function updateHomeVersionDisplay() {
    const el = document.getElementById('homeAppVersionText');
    if (el) {
      el.textContent = `v${APP_VERSION_NAME}`;
    }
  }

  // Auto-initialize version text on startup
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateHomeVersionDisplay);
  } else {
    updateHomeVersionDisplay();
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

      // 1. Coba fetch langsung dari live domain resmi (selalu fresh tanpa delay CDN)
      try {
        const liveRes = await fetch(`https://superappshub.space/version.json?_t=${Date.now()}`, { cache: 'no-store' });
        if (liveRes.ok) {
          manifest = await liveRes.json();
        }
      } catch (e) { }

      // 2. Fallback ke GitHub REST API (realtime commit contents langsung dari repo)
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

      // 4. Fallback ke jsDelivr CDN
      if (!manifest || !manifest.versionCode) {
        try {
          const jsdRes = await fetch(`https://cdn.jsdelivr.net/gh/tw1nss/superapp-release@main/version.json?_t=${Date.now()}`, { cache: 'no-store' });
          if (jsdRes.ok) {
            manifest = await jsdRes.json();
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
      const runningCode = APP_VERSION_CODE;
      const nativeCode = local.nativeVersionCode !== null ? local.nativeVersionCode : runningCode;

      if (manifest.forceUpdate && nativeCode < remoteCode) {
        showAppUpdateModal(manifest, local);
      } else if (remoteCode > runningCode) {
        showAppUpdateModal(manifest, local);
      } else if (isManual) {
        if (local.isNativeAndroid && nativeCode < remoteCode) {
          showAppUpdateModal(manifest, local);
        } else {
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
      showGlobalToast('success', 'Versi Terbaru', `Aplikasi Anda (v${APP_VERSION_NAME}) sudah versi terbaru!`);
      return;
    }
    const badge = document.getElementById('alreadyLatestBadge');
    const sub = document.getElementById('alreadyLatestSubtitle');
    const liveTitle = document.getElementById('alreadyLatestLiveTitle');
    const dlBtn = document.getElementById('alreadyLatestDownloadBtn');
    const changelog = document.getElementById('alreadyLatestChangelog');
    if (badge) badge.textContent = `Versi Aktif: v${APP_VERSION_NAME} (Build ${APP_VERSION_CODE})`;
    if (sub) sub.textContent = manifest.title || `Super App MTG v${APP_VERSION_NAME} sudah aktif`;
    if (liveTitle) liveTitle.textContent = `🚀 Pembaruan Sistem v${APP_VERSION_NAME} Sudah Aktif (Live OTA)`;
    if (dlBtn) dlBtn.textContent = `📥 Unduh & Pasang APK v${manifest.versionName || APP_VERSION_NAME} Terbaru`;
    if (changelog && Array.isArray(manifest.changelog) && manifest.changelog.length > 0) {
      changelog.innerHTML = manifest.changelog.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    }
    modal.classList.remove('hidden');
  }

  window.closeAppAlreadyLatestModal = function () {
    const m = document.getElementById('appAlreadyLatestModal');
    if (m) m.classList.add('hidden');
  };

  window.purgeAppCacheAndReload = async function () {
    try {
      showGlobalToast('info', 'Membersihkan Cache', 'Menghapus data cache lokal...');
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.clearAppCache === 'function') {
        window.AndroidUpdateBridge.clearAppCache();
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
          await registration.unregister();
        }
      }
      localStorage.removeItem('cachedAppManifest');
      sessionStorage.clear();
      showGlobalToast('success', 'Cache Bersih', 'Memuat ulang aplikasi...');
      setTimeout(() => {
        window.location.href = window.location.origin + window.location.pathname + '?_t=' + Date.now();
      }, 500);
    } catch (e) {
      console.warn('Purge cache error:', e);
      window.location.reload(true);
    }
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

  const EDS_SPREADSHEET_ID = '1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ';
  const EDS_BASE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${EDS_SPREADSHEET_ID}/gviz/tq?tqx=out:csv`;
  const EDS_MAIN_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Main List SKU ED Sweeper');
  const EDS_HASIL_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Hasil EDS ED Sweeper');
  const EDS_UPDATE_URL = EDS_BASE_SHEET_URL + '&sheet=' + encodeURIComponent('Data Update ED Sweeper');
  const EDS_REPORT_URL = EDS_BASE_SHEET_URL + '&sheet=Report';
  const EDS_DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbygTPu8soPeO8j0l88UMUcBQrSi7WFCjSe-G2PJV5vg_JLsEim1q2mHuaV9nT6GSQj3sw/exec';

  const EDS_MAIN_CACHE_KEY = 'EDS_MAIN_CACHE_CWG_V1';
  const EDS_SUBMITTED_CACHE_KEY = 'EDS_SUBMITTED_CACHE_CWG_V1';
  const EDS_LOCAL_AUDITS_KEY = 'EDS_LOCAL_AUDITS_CWG_V1';
  const EDS_PIC_KEY = 'EDS_DEFAULT_PIC_CWG_V1';
  const EDS_WEBAPP_KEY = 'EDS_CUSTOM_WEBAPP_URL_CWG_V1';

  // Bersihkan cache usang V2 & V3 agar tidak ada status Done hantu yang nyangkut
  try {
    localStorage.removeItem('EDS_MAIN_CACHE_MTG_V2');
    localStorage.removeItem('EDS_SUBMITTED_CACHE_MTG_V2');
    localStorage.removeItem('EDS_MAIN_CACHE_MTG_V3');
    localStorage.removeItem('EDS_SUBMITTED_CACHE_MTG_V3');
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
  let edsUpdateDataMap = new Map(); // Global lookup from Data Update (AstroDash Superset pull)
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
      const saved = (localStorage.getItem(EDS_WEBAPP_KEY) || '').trim();
      if (saved && !saved.includes('AKfycbzRhVQZEv3TJwTfUhKKV0QtzexKvMS8mfz-iE72LiVRLKulE4_IlU4IW10rII8k7ICpLQ') && !saved.includes('AKfycbzRrR_j-8bV29djmaLl85Uhe3KOHd8PsW_7GQWAYIIciNvDeDoYrTtPs0377F63stid0Q')) {
        if (saved.startsWith('https://script.google.com/macros/s/')) return saved;
      } else if (saved) {
        localStorage.removeItem(EDS_WEBAPP_KEY);
      }
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

    // Cari item di edsMainListData, edsUpdateDataMap, atau master MSLTC
    let item = edsMainListData.find(i => i.sku.toLowerCase() === sku);
    if (!item && edsUpdateDataMap && edsUpdateDataMap.has(sku)) {
      const u = edsUpdateDataMap.get(sku);
      item = {
        sku: u.sku,
        productName: u.productName,
        msltc: u.msltcDays,
        msltcDays: u.msltcDays,
        msltcDate: excelDateToDateStr(u.msltcDateRaw),
        remainingDays: u.remainingDays
      };
    }
    const masterInfo = typeof getMsltcInfo === 'function' ? getMsltcInfo(sku) : null;

    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Hitung Sisa Hari menuju Expired
    const daysToExpire = Math.round((expObj.getTime() - todayMid.getTime()) / 86400000);

    // Standar MSLTC produk:
    // Prioritas: item.msltc -> item.msltcDays -> masterInfo.msltcDays -> default 1 hari (H-1 sebelum ED)
    let msltcDays = 1;
    if (item && item.msltc !== undefined && item.msltc !== null && item.msltc !== '' && !isNaN(Number(item.msltc))) {
      msltcDays = Number(item.msltc);
    } else if (item && item.msltcDays !== undefined && item.msltcDays !== null && item.msltcDays !== '' && !isNaN(Number(item.msltcDays))) {
      msltcDays = Number(item.msltcDays);
    } else if (masterInfo && masterInfo.msltcDays !== undefined && masterInfo.msltcDays !== null && !isNaN(Number(masterInfo.msltcDays))) {
      msltcDays = Number(masterInfo.msltcDays);
    }

    // Hitung Batas Tanggal MSLTC (Expired Date minus Standar MSLTC H-X)
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
    } else {
      msColor = '#38bdf8'; // Normal
    }

    helper.innerHTML = `<span style="color:${msColor}; font-weight:700;">MSLTC (H-${msltcDays}): ${msDateFormatted} (${msText})</span> | <span style="color:#93c5fd; font-weight:600;">Expired: ${expDateFormatted} (${expText})</span>`;
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
        const auditsCached = localStorage.getItem(EDS_LOCAL_AUDITS_KEY);
        if (subCached) {
          edsSubmittedSkuSet = new Set(safeJsonParse(subCached, []));
        }
        if (auditsCached) {
          const mapData = safeJsonParse(auditsCached, {});
          Object.keys(mapData).forEach(k => edsAuditResultsMap.set(k.toLowerCase(), mapData[k]));
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

      // 1. Parse Data Update untuk fallback referensi & sinkronisasi data live Superset
      edsUpdateDataMap.clear();
      const updateDataLookupMap = new Map();
      if (updateRes) {
        const updateLines = parseCSV(updateRes);
        if (updateLines && updateLines.length > 1) {
          const upHeader = updateLines[0].map(h => String(h || '').trim().toLowerCase());
          const colSku = upHeader.indexOf('sku_number') !== -1 ? upHeader.indexOf('sku_number') : (upHeader.indexOf('sku') !== -1 ? upHeader.indexOf('sku') : 0);
          const colName = upHeader.indexOf('product_name') !== -1 ? upHeader.indexOf('product_name') : 1;
          const colLoc = upHeader.indexOf('location_name') !== -1 ? upHeader.indexOf('location_name') : 2;
          const colExp = upHeader.indexOf('expiry_date') !== -1 ? upHeader.indexOf('expiry_date') : 4;
          const colMsltc = upHeader.indexOf('msltc') !== -1 ? upHeader.indexOf('msltc') : 5;
          const colQty = upHeader.indexOf('qty_system') !== -1 ? upHeader.indexOf('qty_system') : 6;
          const colRack = upHeader.indexOf('rack_name') !== -1 ? upHeader.indexOf('rack_name') : 7;
          const colCat1 = upHeader.indexOf('l1_category_name') !== -1 ? upHeader.indexOf('l1_category_name') : 8;
          const colCat2 = upHeader.indexOf('l2_category_name') !== -1 ? upHeader.indexOf('l2_category_name') : 9;
          const colMsDate = upHeader.indexOf('msltc_date') !== -1 ? upHeader.indexOf('msltc_date') : 10;
          const colRemDays = upHeader.indexOf('remaining days') !== -1 ? upHeader.indexOf('remaining days') : (upHeader.indexOf('remaining_days') !== -1 ? upHeader.indexOf('remaining_days') : 11);
          const colAlert = upHeader.indexOf('alert') !== -1 ? upHeader.indexOf('alert') : 12;

          for (let u = 1; u < updateLines.length; u++) {
            const uRow = updateLines[u];
            if (!uRow || uRow.length === 0) continue;
            const uSku = String(uRow[colSku] || '').trim().toLowerCase();
            if (uSku) {
              const uObj = {
                sku: String(uRow[colSku] || '').trim(),
                productName: uRow[colName] || '',
                hub: uRow[colLoc] || '',
                expiryDateRaw: uRow[colExp],
                msltcDays: uRow[colMsltc] !== undefined && uRow[colMsltc] !== null && String(uRow[colMsltc]).trim() !== '' ? String(uRow[colMsltc]).trim() : '1',
                qtySystem: Number(uRow[colQty]) || 0,
                rackName: uRow[colRack] || '',
                l1Category: uRow[colCat1] || '',
                l2Category: uRow[colCat2] || '',
                msltcDateRaw: uRow[colMsDate],
                remainingDays: Number(uRow[colRemDays]) || 999,
                alertText: uRow[colAlert] || ''
              };
              updateDataLookupMap.set(uSku, uObj);
              edsUpdateDataMap.set(uSku, uObj);
            }
          }
        }
      }

      // 2. Parse Hasil EDS (Dedup: 1 SKU hanya 1 catatan terbaru)
      if (hasilRes) {
        const hasilLines = parseCSV(hasilRes);
        if (hasilLines && hasilLines.length > 1) {
          const hRow = hasilLines[0].map(h => String(h || '').trim().toLowerCase());
          // Pastikan bukan sheet katalog produk mentah
          if (hRow.indexOf('location_id') === -1) {
            const colSku = hRow.indexOf('sku number') !== -1 ? hRow.indexOf('sku number') : (hRow.indexOf('sku') !== -1 ? hRow.indexOf('sku') : 0);
            const colName = hRow.indexOf('nama sku') !== -1 ? hRow.indexOf('nama sku') : 1;
            const colSlocEx = hRow.indexOf('sloc existing') !== -1 ? hRow.indexOf('sloc existing') : 2;
            const colSlocAc = hRow.indexOf('sloc actual') !== -1 ? hRow.indexOf('sloc actual') : 3;
            const colExp = hRow.indexOf('expired date') !== -1 ? hRow.indexOf('expired date') : 4;
            const colFg = hRow.indexOf('fisik good') !== -1 ? hRow.indexOf('fisik good') : 5;
            const colFb = hRow.indexOf('fisik bad') !== -1 ? hRow.indexOf('fisik bad') : 6;
            const colSales = hRow.indexOf('sales') !== -1 ? hRow.indexOf('sales') : 7;
            const colRSloc = hRow.indexOf('reason sloc') !== -1 ? hRow.indexOf('reason sloc') : 8;
            const colRBad = hRow.indexOf('reason bad') !== -1 ? hRow.indexOf('reason bad') : 9;
            const colLink1 = hRow.indexOf('evidance link 1') !== -1 ? hRow.indexOf('evidance link 1') : 12;
            const colLink2 = hRow.indexOf('evidance link 2') !== -1 ? hRow.indexOf('evidance link 2') : 13;
            const colInputBy = hRow.indexOf('input by') !== -1 ? hRow.indexOf('input by') : 17;
            const colTime = hRow.indexOf('timestamp') !== -1 ? hRow.indexOf('timestamp') : 18;

            for (let i = 1; i < hasilLines.length; i++) {
              const row = hasilLines[i];
              if (!row || row.length === 0) continue;
              const sku = String(row[colSku] || row[16] || '').trim();
              if (!sku || sku.toLowerCase() === 'sku' || sku.toLowerCase() === 'sku number') continue;

              const auditObj = {
                sku: sku,
                namaSku: row[colName] || '',
                slocExisting: row[colSlocEx] || '',
                slocActual: row[colSlocAc] || 'Match',
                expiredDate: excelDateToDateStr(row[colExp]),
                fisikGood: row[colFg] !== '' && row[colFg] !== undefined ? Number(row[colFg]) : 0,
                fisikBad: row[colFb] !== '' && row[colFb] !== undefined ? Number(row[colFb]) : 0,
                sales: row[colSales] || '',
                reasonSloc: row[colRSloc] || '',
                reasonBad: row[colRBad] || '',
                evidanceLink1: row[colLink1] || '',
                evidanceLink2: row[colLink2] || '',
                inputBy: row[colInputBy] || '',
                timestamp: row[colTime] || '',
                remaks: row[colRBad] || row[colRSloc] || 'Sesuai'
              };

              edsAuditResultsMap.set(sku.toLowerCase(), auditObj);
              edsSubmittedSkuSet.add(sku.toLowerCase());
            }
          }
        }
      }
      edsHasilRows = Array.from(edsAuditResultsMap.values()).reverse();

      // 3. Bangun List Tugas EDS (Sinkronisasi Data Tarik Superset / Data Update + Main List SKU)
      const list = [];
      const processedSkuSet = new Set();
      let idxCounter = 1;
      const now = new Date();
      const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      function addEdsItemToList(rawItem) {
        const skuKey = String(rawItem.sku || '').trim().toLowerCase();
        if (!skuKey || processedSkuSet.has(skuKey)) return;

        // Ambil data fresh dari Data Update jika tersedia
        const updateInfo = updateDataLookupMap.get(skuKey) || {};
        const masterInfo = typeof getMsltcInfo === 'function' ? getMsltcInfo(skuKey) : null;

        const skuClean = rawItem.sku || updateInfo.sku || skuKey;
        const name = updateInfo.productName || rawItem.productName || (masterInfo ? masterInfo.productName : `SKU ${skuClean}`);
        const lokasiRack = updateInfo.rackName || rawItem.lokasiRack || rawItem.rackName || (masterInfo ? masterInfo.rackName : '-');
        const qtySystem = updateInfo.qtySystem !== undefined ? updateInfo.qtySystem : (rawItem.qty_system !== undefined ? rawItem.qty_system : (rawItem.stockAvailable || 0));
        const hub = updateInfo.hub || rawItem.hub || 'MTG - Menteng';
        const l1Category = updateInfo.l1Category || rawItem.l1Category || '';
        const l2Category = updateInfo.l2Category || rawItem.l2Category || '';

        const expiryDateRaw = updateInfo.expiryDateRaw || rawItem.expiryDateRaw || rawItem.expiryDate || '';
        const expDateClean = excelDateToDateStr(expiryDateRaw);

        // Standar MSLTC produk (Prioritas: Data Update -> Main List -> Master MSLTC -> Default 1 hari / H-1 sebelum ED)
        let msltcDays = 1;
        if (updateInfo.msltcDays !== undefined && updateInfo.msltcDays !== null && updateInfo.msltcDays !== '' && !isNaN(Number(updateInfo.msltcDays))) {
          msltcDays = Number(updateInfo.msltcDays);
        } else if (rawItem.msltcDays !== undefined && rawItem.msltcDays !== null && rawItem.msltcDays !== '' && !isNaN(Number(rawItem.msltcDays))) {
          msltcDays = Number(rawItem.msltcDays);
        } else if (rawItem.msltc !== undefined && rawItem.msltc !== null && rawItem.msltc !== '' && !isNaN(Number(rawItem.msltc))) {
          msltcDays = Number(rawItem.msltc);
        } else if (masterInfo && masterInfo.msltcDays !== undefined && masterInfo.msltcDays !== null && !isNaN(Number(masterInfo.msltcDays))) {
          msltcDays = Number(masterInfo.msltcDays);
        }

        let daysToExpire = null;
        let daysToMsltc = null;
        let computedMsltcDateClean = '';

        if (expDateClean && /^\d{4}-\d{2}-\d{2}$/.test(expDateClean)) {
          const [ey, em, ed] = expDateClean.split('-').map(Number);
          const expObj = new Date(ey, em - 1, ed);
          daysToExpire = Math.round((expObj.getTime() - todayMid.getTime()) / 86400000);

          // Hitung Batas Tanggal MSLTC: Expired Date minus Standar MSLTC (H-X)
          const msObj = new Date(expObj.getTime() - (msltcDays * 86400000));
          daysToMsltc = Math.round((msObj.getTime() - todayMid.getTime()) / 86400000);
          const my = msObj.getFullYear();
          const mm = String(msObj.getMonth() + 1).padStart(2, '0');
          const md = String(msObj.getDate()).padStart(2, '0');
          computedMsltcDateClean = `${my}-${mm}-${md}`;
        } else {
          const msRaw = updateInfo.msltcDateRaw || rawItem.msltcDateRaw || rawItem.msltcDate || '';
          computedMsltcDateClean = excelDateToDateStr(msRaw);
          if (computedMsltcDateClean && /^\d{4}-\d{2}-\d{2}$/.test(computedMsltcDateClean)) {
            const [my, mm, md] = computedMsltcDateClean.split('-').map(Number);
            daysToMsltc = Math.round((new Date(my, mm - 1, md) - todayMid) / 86400000);
          } else {
            daysToMsltc = updateInfo.remainingDays !== undefined ? updateInfo.remainingDays : (rawItem.remainingDays || 999);
          }
        }

        // Tentukan Alert: Sesuai SOP SuperApp & GSheet, HANYA CRITICAL dan HARD WARNING (TIDAK ADA ALERT WARNING!)
        let rawAlert = (rawItem.alert || updateInfo.alertText || '').trim();
        const alertLower = rawAlert.toLowerCase();

        // Filter ketat: HANYA CRITICAL dan HARD WARNING! Jangan pernah masukkan ALERT WARNING!
        const isCritical = alertLower.includes('critical') || (daysToMsltc !== null && daysToMsltc <= 0);
        const isHard = alertLower.includes('hard') || (daysToMsltc !== null && daysToMsltc === 1);
        if (!isCritical && !isHard) {
          return;
        }

        const alertText = isCritical ? '🔴 CRITICAL' : '🔴 HARD WARNING';

        // Status Done dari riwayat Hasil EDS, kolom sheet Main List, atau audit lokal
        let isDone = false;
        let doneVal = 'Belum';
        let remaksVal = '-';
        let fisikSystemVal = '-';

        const isSheetDone = (rawItem.sheetDone && rawItem.sheetDone.toLowerCase() === 'done') || (rawItem.doneVal && rawItem.doneVal.toLowerCase() === 'done');
        const isLocallyDone = edsSubmittedSkuSet.has(skuKey);

        if (edsAuditResultsMap.has(skuKey) || isSheetDone || isLocallyDone) {
          const audit = edsAuditResultsMap.get(skuKey);
          isDone = true;
          doneVal = 'Done';
          remaksVal = audit ? (audit.reasonBad || audit.reasonSloc || audit.remaks || 'Sesuai') : (rawItem.sheetRemaks || rawItem.remaksVal || 'Sesuai');
          fisikSystemVal = audit ? `${audit.fisikGood}/${qtySystem}` : (rawItem.sheetFisik || rawItem.fisikSystemVal || `${qtySystem}/${qtySystem}`);
          edsSubmittedSkuSet.add(skuKey);
        }

        list.push({
          index: idxCounter++,
          tanggal: rawItem.tanggal || '',
          sku: skuClean,
          productName: name,
          lokasiRack: lokasiRack,
          stockAvailable: qtySystem,
          stockBad: 0,
          stockLdp: 0,
          hub: hub,
          expiryDate: expDateClean,
          expiryDateRaw: expiryDateRaw,
          msltc: msltcDays,
          qty_system: qtySystem,
          rackName: lokasiRack,
          l1Category: l1Category,
          l2Category: l2Category,
          msltcDate: computedMsltcDateClean,
          remainingDays: daysToMsltc,
          daysToMsltc: daysToMsltc,
          daysToExpire: daysToExpire,
          alert: alertText,
          isDone: isDone,
          doneVal: doneVal,
          remaksVal: remaksVal,
          fisikSystemVal: fisikSystemVal
        });

        processedSkuSet.add(skuKey);
      }

      // Prioritas Utama: BACA PERSIS DARI SHEET "Main List SKU" (Hasil filter supervisor di GSheet)
      if (mainRes) {
        const mainLines = parseCSV(mainRes);
        if (mainLines && mainLines.length > 1) {
          for (let i = 1; i < mainLines.length; i++) {
            const row = mainLines[i];
            if (!row || row.length === 0) continue;
            const cleanSku = String(row[1] || '').trim();
            if (!cleanSku || cleanSku.toLowerCase() === 'sku' || cleanSku.toLowerCase() === 'tanggal' || cleanSku.includes('#ERROR') || cleanSku.length < 3) {
              continue;
            }

            addEdsItemToList({
              tanggal: row[0] || '',
              sku: cleanSku,
              productName: (row[2] || '').trim(),
              lokasiRack: (row[3] || row[11] || '').trim(),
              stockAvailable: Number(row[4]) || 0,
              hub: (row[7] || '').trim(),
              expiryDateRaw: row[8],
              msltcDays: row[9],
              qty_system: Number(row[10]) || 0,
              rackName: (row[3] || row[11] || '').trim(),
              l1Category: (row[12] || '').trim(),
              l2Category: (row[13] || '').trim(),
              msltcDateRaw: row[14],
              remainingDays: Number(row[15]),
              alert: (row[16] || '').trim(),
              sheetDone: (row[17] || '').trim(),
              sheetRemaks: (row[18] || '').trim(),
              sheetFisik: (row[19] || '').trim()
            });
          }
        }
      }

      // Fallback HANYA jika sheet Main List SKU di spreadsheet benar-benar belum diisi supervisor:
      if (list.length === 0 && updateDataLookupMap.size > 0) {
        updateDataLookupMap.forEach(upItem => {
          addEdsItemToList({
            sku: upItem.sku,
            productName: upItem.productName,
            lokasiRack: upItem.rackName,
            stockAvailable: upItem.qtySystem,
            hub: upItem.hub,
            expiryDateRaw: upItem.expiryDateRaw,
            msltcDays: upItem.msltcDays,
            qty_system: upItem.qtySystem,
            rackName: upItem.rackName,
            l1Category: upItem.l1Category,
            l2Category: upItem.l2Category,
            msltcDateRaw: upItem.msltcDateRaw,
            remainingDays: upItem.remainingDays,
            alert: upItem.alertText
          });
        });
      }

      if (list.length > 0) {
        edsMainListData = list;
        try {
          localStorage.setItem(EDS_MAIN_CACHE_KEY, JSON.stringify(list));
          localStorage.setItem(EDS_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(edsSubmittedSkuSet)));
          localStorage.setItem(EDS_LOCAL_AUDITS_KEY, JSON.stringify(Object.fromEntries(edsAuditResultsMap)));
        } catch (e) { }
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

      // ── DETEKSI ALERT PERSIS DARI SPREADSHEET (🔴 CRITICAL, 🔴 HARD WARNING) ──
      const rawAlert = (item.alert || '').toUpperCase();
      let alertIcon = '🔴 HARD WARNING';
      let alertClass = 'hard-warning';

      const msltcVal = item.daysToMsltc !== undefined ? item.daysToMsltc : item.remainingDays;
      if (rawAlert.includes('CRITICAL') || msltcVal <= 0) {
        alertIcon = '🔴 CRITICAL';
        alertClass = 'critical';
      } else {
        alertIcon = '🔴 HARD WARNING';
        alertClass = 'hard-warning';
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
    let item = edsMainListData.find(i => i.sku.toLowerCase() === clean.toLowerCase());
    if (!item && edsUpdateDataMap && edsUpdateDataMap.has(clean.toLowerCase())) {
      const u = edsUpdateDataMap.get(clean.toLowerCase());
      item = {
        sku: u.sku,
        productName: u.productName,
        lokasiRack: u.rackName,
        qty_system: u.qtySystem,
        expiryDate: excelDateToDateStr(u.expiryDateRaw),
        msltc: u.msltcDays,
        msltcDays: u.msltcDays,
        msltcDate: excelDateToDateStr(u.msltcDateRaw),
        remainingDays: u.remainingDays
      };
    }
    if (!item) {
      const master = typeof getMsltcInfo === 'function' ? getMsltcInfo(clean) : null;
      if (master) {
        item = {
          sku: clean,
          productName: master.productName,
          lokasiRack: master.rackName || '-',
          qty_system: 0,
          expiryDate: '',
          msltc: master.msltcDays,
          msltcDays: master.msltcDays,
          msltcDate: '',
          remainingDays: 999
        };
      }
    }

    const skuInput = document.getElementById('edsSkuInput');
    const namaInput = document.getElementById('edsNamaSku');
    const slocInput = document.getElementById('edsSlocExisting');
    const qtyInput = document.getElementById('edsQtySystem');
    const dateInput = document.getElementById('edsExpiredDate');
    const msltcHelper = document.getElementById('edsMsltcHelper');

    if (skuInput) skuInput.value = clean;

    if (item) {
      if (namaInput) namaInput.value = item.productName || '';
      if (slocInput) slocInput.value = item.lokasiRack || '-';
      if (qtyInput) qtyInput.value = `${item.qty_system || 0} pcs`;
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

      try {
        localStorage.setItem(EDS_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(edsSubmittedSkuSet)));
        localStorage.setItem(EDS_LOCAL_AUDITS_KEY, JSON.stringify(Object.fromEntries(edsAuditResultsMap)));
      } catch (e) { }

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
              const msltcDays = Number(it.msltc) || 1;
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

  // ══════════════════════════════════════════════
  //  ED CORRECTION (EDC) MODULE ENGINE
  // ══════════════════════════════════════════════

  const EDC_SPREADSHEET_ID_DEFAULT = '1T6YcctafqzppSyblW17Gm8zXBrwyXJKi81niF66CXCQ';
  const EDC_WEBAPP_KEY = 'EDC_CUSTOM_WEBAPP_URL_CWG_V1';
  const EDC_SPREADSHEET_KEY = 'EDC_CUSTOM_SPREADSHEET_URL_CWG_V1';
  const EDC_MAIN_CACHE_KEY = 'EDC_MAIN_CACHE_CWG_V1';
  const EDC_SUBMITTED_CACHE_KEY = 'EDC_SUBMITTED_CACHE_CWG_V1';
  const EDC_PIC_KEY = 'EDC_DEFAULT_PIC_CWG_V1';
  const EDC_OFFLINE_KEY = 'EDC_OFFLINE_QUEUE_CWG_LOCAL';

  try {
    localStorage.removeItem('EDC_MAIN_CACHE_MTG_V1');
    localStorage.removeItem('EDC_SUBMITTED_CACHE_MTG_V1');
    localStorage.removeItem('EDC_MAIN_CACHE_MTG_V2');
    localStorage.removeItem('EDC_SUBMITTED_CACHE_MTG_V2');
  } catch(e) {}

  let currentEdcTab = 'main'; // 'main' | 'scan' | 'report'
  let currentEdcStatusFilter = 'all'; // 'all' | 'submitted' | 'pending'
  let currentEdcSort = 'default'; // 'default' | 'name_asc' | 'sloc_asc' | 'stock_desc'
  let isEdcFetching = false;

  let edcMainListData = [];
  let edcSubmittedSkuSet = new Set();
  let edcAuditResultsMap = new Map(); // sku -> audit object
  let edcCatalogMap = new Map(); // sku -> { productName, rack, productType, msltc } (auxiliary lookup)
  let edcHasilRows = [];
  let edcPhotoList = [];
  let selectedEdcSku = null;
  let edcFlatpickrInstance = null;
  let pendingEdcSubmitPayload = null;
  let edcInputListenersAttached = false;

  function resolveEdcProductInfo(sku, fallbackName = '', fallbackRack = '') {
    let name = String(fallbackName || '').trim();
    let rack = String(fallbackRack || '').trim();
    let type = '';
    let msltc = 0;

    const clean = String(sku || '').trim();
    if (!clean) return { name: name || 'Nama produk belum disinkron', rack: rack || '-', type, msltc };
    const cleanLower = clean.toLowerCase();
    const noZero = clean.replace(/^0+/, '');

    // 1. Auxiliary catalog from Superset/Hasil dump if present
    if (edcCatalogMap && (edcCatalogMap.has(cleanLower) || (noZero && edcCatalogMap.has(noZero.toLowerCase())))) {
      const c = edcCatalogMap.get(cleanLower) || edcCatalogMap.get(noZero.toLowerCase());
      if (c) {
        if (!name && c.productName) name = c.productName;
        if ((!rack || rack === '-') && c.rack) rack = c.rack;
        if (c.productType) type = c.productType;
        if (c.msltc) msltc = c.msltc;
      }
    }

    // 2. dataMap (Master Rack SKU)
    if ((!name || !rack || rack === '-') && typeof dataMap !== 'undefined' && dataMap) {
      const d = dataMap.get(clean) || (noZero ? dataMap.get(noZero) : null);
      if (d && d.length > 0) {
        if (!name && d[0].productName) name = d[0].productName;
        if ((!rack || rack === '-') && (d[0].sloc || d[0].masterSloc)) rack = d[0].sloc || d[0].masterSloc;
        if (!type && d[0].type) type = d[0].type;
      }
    }

    // 3. msltcMap (Master MSLTC)
    if ((!name || !rack || rack === '-') && typeof msltcMap !== 'undefined' && msltcMap) {
      const m = msltcMap.get(clean) || (noZero ? msltcMap.get(noZero) : null);
      if (m && m.length > 0) {
        if (!name && m[0].productName) name = m[0].productName;
        if ((!rack || rack === '-') && m[0].rackName) rack = m[0].rackName;
        if (!type && m[0].type) type = m[0].type;
        if (!msltc && m[0].msltcDays) msltc = m[0].msltcDays;
      }
    }

    // 4. getMsltcInfo
    if ((!name || !rack || rack === '-') && typeof getMsltcInfo === 'function') {
      const info = getMsltcInfo(clean);
      if (info) {
        if (!name && info.productName) name = info.productName;
        if ((!rack || rack === '-') && info.rackName) rack = info.rackName;
        if (!type && info.type) type = info.type;
        if (!msltc && info.msltcDays) msltc = info.msltcDays;
      }
    }

    // 5. edsUpdateDataMap
    if ((!name || !rack || rack === '-') && typeof edsUpdateDataMap !== 'undefined' && edsUpdateDataMap && (edsUpdateDataMap.has(cleanLower) || (noZero && edsUpdateDataMap.has(noZero.toLowerCase())))) {
      const u = edsUpdateDataMap.get(cleanLower) || edsUpdateDataMap.get(noZero.toLowerCase());
      if (u) {
        if (!name && u.productName) name = u.productName;
        if ((!rack || rack === '-') && u.rackName) rack = u.rackName;
        if (!msltc && u.msltcDays) msltc = u.msltcDays;
      }
    }

    return { name: name || 'Nama produk belum disinkron', rack: rack || '-', type, msltc };
  }

  window.initEdcInputListeners = function() {
    const skuInput = document.getElementById('edcSkuInput');
    if (!skuInput) return;
    if (edcInputListenersAttached) return;
    edcInputListenersAttached = true;

    const debouncedLookup = debounce((val) => {
      let raw = String(val || '').trim();
      if (!raw) return;
      let sku = raw;
      let scannedDate = null;
      if (raw.includes(';')) {
        const parts = raw.split(';');
        sku = parts[0].trim();
        if (parts[1]) {
          scannedDate = parseFlexibleDate(parts[1].trim());
        }
        skuInput.value = sku;
      }
      const formatted = scannedDate ? formatDateToYMD(scannedDate) : null;
      lookupEdcSku(sku, formatted);
      if (formatted && edcFlatpickrInstance) {
        edcFlatpickrInstance.setDate(formatted);
        updateEdcStatusHelper();
      }
    }, 180);

    skuInput.addEventListener('input', function(e) {
      debouncedLookup(e.target.value);
    });

    skuInput.addEventListener('change', function(e) {
      debouncedLookup(e.target.value);
    });

    skuInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        debouncedLookup(e.target.value);
        skuInput.blur();
      }
    });
  };

  function getEdcSpreadsheetId() {
    try {
      const custom = localStorage.getItem(EDC_SPREADSHEET_KEY) || '';
      if (custom) {
        const m = custom.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (m && m[1]) return m[1].trim();
        if (!custom.includes('/') && custom.length > 20) return custom.trim();
      }
    } catch(e) {}
    return EDC_SPREADSHEET_ID_DEFAULT;
  }

  function getEdcBaseSheetUrl() {
    const id = getEdcSpreadsheetId();
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
  }

  function getEdcWebappUrl() {
    try {
      const custom = localStorage.getItem(EDC_WEBAPP_KEY);
      if (custom && custom.trim().startsWith('http')) return custom.trim();
    } catch(e) {}
    return EDS_DEFAULT_WEBAPP_URL;
  }

  // ── Modal Setup & Config Spreadsheet ──
  window.openEdcSetupModal = function() {
    const modal = document.getElementById('edcSetupModal');
    if (!modal) return;
    const urlInput = document.getElementById('edcSpreadsheetUrlInput');
    if (urlInput) {
      urlInput.value = localStorage.getItem(EDC_SPREADSHEET_KEY) || `https://docs.google.com/spreadsheets/d/${getEdcSpreadsheetId()}/edit`;
    }
    const webappInput = document.getElementById('edcWebappUrlInput');
    if (webappInput) {
      webappInput.value = localStorage.getItem(EDC_WEBAPP_KEY) || getEdcWebappUrl();
    }
    modal.classList.remove('hidden');
  };

  window.closeEdcSetupModal = function() {
    const modal = document.getElementById('edcSetupModal');
    if (modal) modal.classList.add('hidden');
  };

  window.saveEdcSpreadsheetUrl = function() {
    const input = document.getElementById('edcSpreadsheetUrlInput');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
      showDccToast('warning', 'Input Kosong', 'Silakan masukkan Link atau ID Google Sheets.');
      return;
    }
    localStorage.setItem(EDC_SPREADSHEET_KEY, val);
    showDccToast('success', 'Tersimpan', 'Link Spreadsheet ED Correction berhasil diperbarui!');
    closeEdcSetupModal();
    fetchEdCorrectionData(true);
  };

  window.saveEdcWebappUrl = function() {
    const input = document.getElementById('edcWebappUrlInput');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
      showDccToast('warning', 'Input Kosong', 'Silakan masukkan URL WebApp Apps Script.');
      return;
    }
    localStorage.setItem(EDC_WEBAPP_KEY, val);
    showDccToast('success', 'Tersimpan', 'WebApp URL ED Correction berhasil diperbarui!');
    closeEdcSetupModal();
  };

  // ── Tab Switcher ──
  window.switchEdcTab = function (tabName) {
    currentEdcTab = tabName;
    const ws = document.getElementById('edCorrectionWorkspace');
    if (!ws) return;

    ws.querySelectorAll('.eds-tab-content').forEach(tab => {
      tab.classList.remove('active');
    });
    ws.querySelectorAll('.eds-nav-item').forEach(nav => nav.classList.remove('active'));

    if (tabName === 'main') {
      const el = document.getElementById('edcTabMainList');
      if (el) el.classList.add('active');
      const nav = document.getElementById('navEdcMain');
      if (nav) nav.classList.add('active');
    } else if (tabName === 'scan') {
      const el = document.getElementById('edcTabScan');
      if (el) {
        el.classList.add('active');
        el.scrollTop = 0;
      }
      const nav = document.getElementById('navEdcScan');
      if (nav) nav.classList.add('active');
      initEdcFlatpickr();
      loadEdcSavedPic();
      if (typeof window.initEdcInputListeners === 'function') window.initEdcInputListeners();
      ws.scrollTop = 0;
    } else if (tabName === 'report') {
      const el = document.getElementById('edcTabReport');
      if (el) el.classList.add('active');
      const nav = document.getElementById('navEdcReport');
      if (nav) nav.classList.add('active');
      renderEdcReport();
    }
  };

  window.handleEdcBackPressed = function () {
    if (currentEdcTab !== 'main') {
      switchEdcTab('main');
    } else {
      goBackToMenu();
    }
  };

  // ── Fetch & Sync Data ED Correction ──
  window.refreshEdcData = async function () {
    const btn = document.querySelector('.edc-refresh-btn');
    if (btn) btn.classList.add('spinning');
    try {
      await fetchEdCorrectionData(true);
      showDccToast('success', 'Data Diperbarui', 'Data ED Correction berhasil disinkronkan!');
    } catch (e) {
      showDccToast('error', 'Gagal Sinkron', e.message || 'Periksa koneksi internet Anda.');
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  };

  window.fetchEdCorrectionData = async function (forceRefresh = false) {
    if (isEdcFetching) return;
    isEdcFetching = true;

    // Load from cache first for fast render
    if (!forceRefresh) {
      try {
        const cached = localStorage.getItem(EDC_MAIN_CACHE_KEY);
        const subCached = localStorage.getItem(EDC_SUBMITTED_CACHE_KEY);
        if (subCached) edcSubmittedSkuSet = new Set(safeJsonParse(subCached, []));
        if (cached) {
          edcMainListData = safeJsonParse(cached, []);
          filterEdCorrectionList();
          renderEdcReport();
        }
      } catch (e) {}
    }

    const container = document.getElementById('edcCardContainer');
    if (edcMainListData.length === 0 && container) {
      container.innerHTML = '<div style="text-align:center; padding: 35px; color: #c084fc;">⚡ Menghubungkan ke Spreadsheet ED Correction...</div>';
    }

    try {
      const baseUrl = getEdcBaseSheetUrl();
      const t = Date.now();
      const nonce = Math.floor(Math.random() * 1000000);
      const fetchOpts = {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
      };

      const mainSheetName = 'Mainlist Sku ED Corection';
      const hasilCandidates = ['Hasil ED Correction', 'Hasil ED Corection', 'Backup ED Corection'];
      const mainUrl = `${baseUrl}&sheet=${encodeURIComponent(mainSheetName)}&_t=${t}&_r=${nonce}`;

      // Ambil Mainlist dan coba ambil Hasil ED Correction dengan fallback kandidat nama sheet
      const [mainRes, hasilRes] = await Promise.all([
        fetch(mainUrl, fetchOpts).then(r => r.ok ? r.text() : '').catch(() => ''),
        (async () => {
          for (const cand of hasilCandidates) {
            try {
              const candUrl = `${baseUrl}&sheet=${encodeURIComponent(cand)}&_t=${t}&_r=${nonce}`;
              const r = await fetch(candUrl, fetchOpts);
              if (r.ok) {
                const txt = await r.text();
                if (txt && !txt.includes('<!DOCTYPE html>') && txt.trim().length > 10) {
                  return txt;
                }
              }
            } catch (err) {}
          }
          return '';
        })()
      ]);

      // 1. Parse Hasil ED Correction (Hasil Audit Sebelumnya)
      edcAuditResultsMap.clear();
      edcCatalogMap.clear();
      edcHasilRows = [];
      edcSubmittedSkuSet.clear();

      if (hasilRes) {
        const hasilLines = parseCSV(hasilRes);
        if (hasilLines && hasilLines.length > 1) {
          const hHeaders = hasilLines[0].map(h => String(h || '').trim().toLowerCase());
          const isRawSuperset = hHeaders.includes('location_id') || hHeaders.includes('product_id') || hHeaders.includes('product type');
          const hasAuditColumns = hHeaders.some(h => (h.includes('koreksi') || h.includes('fisik')) && h.includes('ed')) ||
                                  hHeaders.some(h => h.includes('petugas') || h.includes('pic')) ||
                                  hHeaders.some(h => h === 'status ed');

          if (isRawSuperset || !hasAuditColumns) {
            // Sheet Hasil berisi dump data katalog produk / Superset.
            // Gunakan hanya sebagai kamus metadata katalog bantu, BUKAN sebagai hasil audit.
            const cSkuIdx = hHeaders.findIndex(h => h === 'sku_number' || h === 'sku' || h === 'barcode');
            const cNameIdx = hHeaders.findIndex(h => h === 'product_name' || h === 'nama produk' || h === 'nama');
            const cRackIdx = hHeaders.findIndex(h => h === 'rack_name' || h.includes('rak') || h.includes('sloc'));
            const cTypeIdx = hHeaders.findIndex(h => h === 'product type' || h === 'kategori' || h === 'type');
            const cMsltcIdx = hHeaders.findIndex(h => h === 'msltc' || h === 'masa ed');

            const actualSkuIdx = cSkuIdx >= 0 ? cSkuIdx : 3;
            for (let i = 1; i < hasilLines.length; i++) {
              const row = hasilLines[i];
              if (!row || row.length === 0) continue;
              const sku = String(row[actualSkuIdx] || '').trim();
              if (!sku) continue;
              edcCatalogMap.set(sku.toLowerCase(), {
                productName: cNameIdx >= 0 ? String(row[cNameIdx] || '').trim() : '',
                rack: cRackIdx >= 0 ? String(row[cRackIdx] || '').trim() : '',
                productType: cTypeIdx >= 0 ? String(row[cTypeIdx] || '').trim() : '',
                msltc: cMsltcIdx >= 0 ? (Number(row[cMsltcIdx]) || 0) : 0
              });
            }
          } else {
            // Sheet Hasil berisi data audit otentik (17 kolom standar)
            const hSkuIdx = hHeaders.findIndex(h => h === 'sku' || h === 'sku_number' || h === 'sku no');
            const hNameIdx = hHeaders.findIndex(h => h.includes('nama'));
            const hRackSysIdx = hHeaders.findIndex(h => (h.includes('rack') || h.includes('sloc')) && !h.includes('actual'));
            const hRackActIdx = hHeaders.findIndex(h => h.includes('actual') || h === 'sloc actual');
            const hEdSysIdx = hHeaders.findIndex(h => h.includes('sistem') && h.includes('ed'));
            const hEdActIdx = hHeaders.findIndex(h => (h.includes('fisik') || h.includes('koreksi')) && h.includes('ed'));
            const hStatusEdIdx = hHeaders.findIndex(h => h.includes('status ed'));
            const hGoodIdx = hHeaders.findIndex(h => h.includes('good'));
            const hBadIdx = hHeaders.findIndex(h => h.includes('bad'));
            const hPetugasIdx = hHeaders.findIndex(h => h.includes('petugas') || h.includes('pic'));
            const hRemarksIdx = hHeaders.findIndex(h => h.includes('remarks') || h.includes('catatan') || h.includes('keterangan'));

            const actualSkuIdx = hSkuIdx >= 0 ? hSkuIdx : 1;

            for (let i = 1; i < hasilLines.length; i++) {
              const row = hasilLines[i];
              if (!row || row.length === 0) continue;
              const sku = String(row[actualSkuIdx] || '').trim();
              if (!sku) continue;

              const edActualRaw = hEdActIdx >= 0 ? row[hEdActIdx] : row[7];
              const edActualClean = edActualRaw ? excelDateToDateStr(edActualRaw) : '';
              const petugasClean = hPetugasIdx >= 0 ? String(row[hPetugasIdx] || '').trim() : String(row[13] || '').trim();
              const goodQty = Number(hGoodIdx >= 0 ? row[hGoodIdx] : row[9]) || 0;
              const badQty = Number(hBadIdx >= 0 ? row[hBadIdx] : row[10]) || 0;

              // Hanya baris yang benar-benar ada data audit (ED aktual terisi atau ada nama petugas / fisik)
              const hasAuditData = edActualClean.length > 3 || petugasClean.length > 0 || (goodQty + badQty) > 0;
              if (!hasAuditData) continue;

              const auditObj = {
                timestamp: row[0] || '',
                sku: sku,
                productName: hNameIdx >= 0 ? (row[hNameIdx] || '') : (row[2] || ''),
                rackSystem: hRackSysIdx >= 0 ? (row[hRackSysIdx] || '') : (row[3] || ''),
                rackActual: hRackActIdx >= 0 ? (row[hRackActIdx] || 'Match') : (row[4] || 'Match'),
                rackMatch: row[5] || 'MATCH',
                edSystem: excelDateToDateStr(hEdSysIdx >= 0 ? row[hEdSysIdx] : row[6]),
                edActual: edActualClean,
                edStatus: hStatusEdIdx >= 0 ? (row[hStatusEdIdx] || 'MATCH') : (row[8] || 'MATCH'),
                fisikGood: goodQty,
                fisikBad: badQty,
                totalFisik: Number(row[11]) || (goodQty + badQty),
                selisih: Number(row[12]) || 0,
                petugas: petugasClean,
                shift: row[14] || '',
                photoUrl: row[15] || '',
                remarks: hRemarksIdx >= 0 ? (row[hRemarksIdx] || '') : (row[16] || '')
              };

              const key = sku.toLowerCase();
              edcAuditResultsMap.set(key, auditObj);
              edcSubmittedSkuSet.add(key);
              edcHasilRows.push(auditObj);
            }
          }
        }
      }

      // 2. Parse Mainlist Sku ED Corection
      if (mainRes) {
        const mainLines = parseCSV(mainRes);
        if (mainLines && mainLines.length > 1) {
          const mHeaders = mainLines[0].map(h => String(h || '').trim().toLowerCase());
          
          // Deteksi dinamis kolom berdasarkan sheet Mainlist Sku ED Corection
          let qrCodeIdx = mHeaders.findIndex(h => h === 'qr_code' || h === 'qrcode' || h === 'qr code');
          let skuIdx = mHeaders.findIndex(h => h === 'sku' || h === 'sku_number' || h === 'barcode' || h === 'sku no' || h === 'sku_code' || h === 'sku_id');
          let prodIdIdx = mHeaders.findIndex(h => h === 'product_id' || h === 'item_id' || h === 'product id');
          let nameIdx = mHeaders.findIndex(h => h === 'nama produk' || h === 'product_name' || h === 'nama sku' || h === 'nama');
          let rackIdx = mHeaders.findIndex(h => h.includes('rak') || h.includes('sloc') || h === 'rack' || h === 'rack_name' || h === 'lokasi');
          let qtyIdx = mHeaders.findIndex(h => h === 'qty_system' || h === 'qty sistem' || h.includes('qty') || h.includes('stok') || h.includes('stock'));
          let edSysIdx = mHeaders.findIndex(h => h === 'expiry_date' || h === 'expired_date' || h.includes('expiry') || h.includes('expired') || h.includes('ed sistem') || (h.includes('ed') && (h.includes('lama') || h.includes('sistem') || h.includes('system'))));
          let edActIdx = mHeaders.findIndex(h => (h.includes('fisik') || h.includes('koreksi')) && h.includes('ed'));
          let edStatusIdx = mHeaders.findIndex(h => h.includes('status ed'));
          let goodIdx = mHeaders.findIndex(h => h.includes('good'));
          let badIdx = mHeaders.findIndex(h => h.includes('bad'));
          let totalIdx = mHeaders.findIndex(h => h.includes('total'));
          let selisihIdx = mHeaders.findIndex(h => h.includes('selisih'));
          let petugasIdx = mHeaders.findIndex(h => h.includes('petugas') || h.includes('pic'));
          let statusIdx = mHeaders.findIndex(h => h === 'status' || h === 'status tugas' || h === 'status_tugas' || h === 'status audit');
          let remarksIdx = mHeaders.findIndex(h => h.includes('remarks') || h.includes('catatan') || h.includes('keterangan'));
          let typeIdx = mHeaders.findIndex(h => h === 'product type' || h === 'product_type' || h === 'kategori' || h === 'type');
          let msltcIdx = mHeaders.findIndex(h => h === 'msltc' || h === 'masa ed' || h === 'sisa hari');
          let locIdx = mHeaders.findIndex(h => h === 'location_name' || h === 'hub');
          let shiftIdx = mHeaders.findIndex(h => h.includes('shift'));
          let dateIdx = mHeaders.findIndex(h => h.includes('tanggal') || h.includes('date') || h === 'datenow');

          const list = [];
          for (let m = 1; m < mainLines.length; m++) {
            const row = mainLines[m];
            if (!row || row.length === 0) continue;

            let sku = '';
            let rowScannedEd = '';

            // Prioritas 1: Format QR Code (SKU;DDMMYYYY) dari kolom qr_code
            if (qrCodeIdx >= 0 && row[qrCodeIdx]) {
              const rawQr = String(row[qrCodeIdx]).trim();
              if (rawQr.includes(';')) {
                const parts = rawQr.split(';');
                sku = parts[0].trim();
                if (parts[1]) rowScannedEd = parseFlexibleDate(parts[1].trim());
              } else {
                sku = rawQr;
              }
            }

            // Prioritas 2: Kolom SKU / Barcode khusus
            if (!sku && skuIdx >= 0 && row[skuIdx]) {
              const raw = String(row[skuIdx]).trim();
              if (raw.includes(';')) {
                const parts = raw.split(';');
                sku = parts[0].trim();
                if (parts[1] && !rowScannedEd) rowScannedEd = parseFlexibleDate(parts[1].trim());
              } else {
                sku = raw;
              }
            }

            // Prioritas 3: Kolom product_id
            if (!sku && prodIdIdx >= 0 && row[prodIdIdx]) {
              sku = String(row[prodIdIdx]).trim();
            }

            // Prioritas 4: Kolom C pada format sheet manual jika bukan nama lokasi
            if (!sku && row[2]) {
              const col2Val = String(row[2]).trim();
              if (!col2Val.toLowerCase().includes('menteng') && !col2Val.toLowerCase().includes('hub')) {
                sku = col2Val;
              }
            }

            if (!sku) continue;

            // Proteksi khusus: Cegah string 'MTG - Menteng' atau nama hub menjadi SKU
            if (sku.toLowerCase().includes('menteng') || sku.toLowerCase().includes('hub')) {
              continue;
            }

            const skuKey = sku.toLowerCase();
            const audit = edcAuditResultsMap.get(skuKey);

            // Validasi akurat status pengerjaan tugas
            let sheetStatus = '';
            if (statusIdx >= 0 && row[statusIdx]) {
              const sVal = String(row[statusIdx]).trim().toUpperCase();
              if (sVal === 'DONE' || sVal === 'SELESAI') {
                sheetStatus = sVal;
              }
            }

            const rawEdActual = edActIdx >= 0 ? String(row[edActIdx] || '').trim() : '';
            const sheetEdActual = rawEdActual ? excelDateToDateStr(rawEdActual) : '';
            const sheetPetugas = petugasIdx >= 0 ? String(row[petugasIdx] || '').trim() : '';

            const hasValidAudit = audit && (audit.edActual || audit.petugas || audit.totalFisik > 0);
            const isDone = sheetStatus === 'DONE' || 
                           sheetStatus === 'SELESAI' || 
                           sheetEdActual.length > 3 || 
                           !!hasValidAudit;

            // Resolusi nama & rak produk jika di sheet kosong
            let rawName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
            let rawRack = rackIdx >= 0 ? String(row[rackIdx] || '').trim() : '';
            const resolved = resolveEdcProductInfo(sku, rawName, rawRack);

            // Resolusi ED sistem
            let edSystem = '';
            if (edSysIdx >= 0 && row[edSysIdx]) {
              edSystem = excelDateToDateStr(row[edSysIdx]);
            }
            if (!edSystem && rowScannedEd) {
              edSystem = rowScannedEd;
            }
            if (!edSystem) edSystem = '-';

            const item = {
              sku: sku,
              productName: resolved.name,
              rack: resolved.rack,
              productType: typeIdx >= 0 && row[typeIdx] ? String(row[typeIdx]).trim() : resolved.type,
              msltc: msltcIdx >= 0 && row[msltcIdx] ? (Number(row[msltcIdx]) || 0) : resolved.msltc,
              locationName: locIdx >= 0 ? String(row[locIdx] || '').trim() : '',
              qtySystem: qtyIdx >= 0 ? (Number(row[qtyIdx]) || 0) : 0,
              edSystem: edSystem,
              shift: shiftIdx >= 0 ? String(row[shiftIdx] || '').trim() : '',
              date: dateIdx >= 0 ? String(row[dateIdx] || '').trim() : '',
              edActual: sheetEdActual || (audit ? audit.edActual : ''),
              edStatus: edStatusIdx >= 0 && row[edStatusIdx] ? String(row[edStatusIdx]).trim() : (audit ? audit.edStatus : ''),
              fisikGood: goodIdx >= 0 && row[goodIdx] !== '' ? (Number(row[goodIdx]) || 0) : (audit ? audit.fisikGood : 0),
              fisikBad: badIdx >= 0 && row[badIdx] !== '' ? (Number(row[badIdx]) || 0) : (audit ? audit.fisikBad : 0),
              totalFisik: totalIdx >= 0 && row[totalIdx] !== '' ? (Number(row[totalIdx]) || 0) : (audit ? audit.totalFisik : 0),
              selisih: selisihIdx >= 0 && row[selisihIdx] !== '' ? (Number(row[selisihIdx]) || 0) : (audit ? audit.selisih : 0),
              petugas: sheetPetugas || (audit ? audit.petugas : ''),
              status: isDone ? 'DONE' : 'PENDING',
              remarks: remarksIdx >= 0 ? String(row[remarksIdx] || '').trim() : (audit ? audit.remarks : '')
            };

            if (isDone) edcSubmittedSkuSet.add(skuKey);
            list.push(item);
          }

          edcMainListData = list;
          try {
            localStorage.setItem(EDC_MAIN_CACHE_KEY, JSON.stringify(list));
            localStorage.setItem(EDC_SUBMITTED_CACHE_KEY, JSON.stringify(Array.from(edcSubmittedSkuSet)));
          } catch(e) {}
        }
      }

      filterEdCorrectionList();
      renderEdcReport();

    } catch(err) {
      console.error('Fetch ED Correction error:', err);
      if (container && edcMainListData.length === 0) {
        container.innerHTML = `
          <div style="text-align:center; padding: 35px 20px;">
            <div style="font-size:2rem; margin-bottom:10px;">⚠️</div>
            <div style="font-weight:700; color:#f87171; margin-bottom:8px;">Gagal Menghubungkan ke Spreadsheet</div>
            <div style="font-size:0.85rem; color:#94a3b8; line-height:1.5; margin-bottom:16px;">
              Pastikan sheet <b>"Mainlist Sku ED Corection"</b> sudah ada dan link spreadsheet valid.
            </div>
            <button type="button" class="btn" style="background: linear-gradient(135deg, #a855f7, #7c3aed); color:#fff; padding:10px 18px; border-radius:12px; border:none; cursor:pointer;" onclick="fetchEdCorrectionData(true)">
              🔄 Coba Muat Ulang
            </button>
          </div>
        `;
      }
    } finally {
      isEdcFetching = false;
    }
  };

  // ── Filter & Sort Main List ──
  window.setEdcStatusFilter = function (status) {
    currentEdcStatusFilter = status;
    const ws = document.getElementById('edCorrectionWorkspace');
    if (!ws) return;
    ws.querySelectorAll('.edc-status-btn, .eds-status-btn').forEach(btn => {
      if (btn.getAttribute('data-status') === status) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    filterEdCorrectionList();
  };

  window.toggleEdcSort = function (sortType) {
    currentEdcSort = sortType;
    const ws = document.getElementById('edCorrectionWorkspace');
    if (!ws) return;
    ws.querySelectorAll('.eds-sort-btn').forEach(btn => btn.classList.remove('active'));
    if (sortType === 'default') {
      const b = document.getElementById('edcSortDefault');
      if (b) b.classList.add('active');
    } else if (sortType === 'name_asc') {
      const b = document.getElementById('edcSortNameAsc');
      if (b) b.classList.add('active');
    } else if (sortType === 'sloc_asc') {
      const b = document.getElementById('edcSortSlocAsc');
      if (b) b.classList.add('active');
    } else if (sortType === 'stock_desc') {
      const b = document.getElementById('edcSortStockDesc');
      if (b) b.classList.add('active');
    }
    filterEdCorrectionList();
  };

  window.clearEdcFilter = function () {
    const input = document.getElementById('edcFilterInput');
    if (input) {
      input.value = '';
      input.focus();
    }
    const clearBtn = document.getElementById('edcFilterClearBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    filterEdCorrectionList();
  };

  let currentEdcRenderLimit = 50;
  let currentEdcListCache = [];

  function filterEdCorrectionList() {
    const searchInput = document.getElementById('edcFilterInput');
    const q = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const clearBtn = document.getElementById('edcFilterClearBtn');
    if (clearBtn) {
      if (q) clearBtn.classList.remove('hidden');
      else clearBtn.classList.add('hidden');
    }

    let totalDone = 0;
    let totalPending = 0;

    for (let i = 0; i < edcMainListData.length; i++) {
      const item = edcMainListData[i];
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      if (isDone) totalDone++;
      else totalPending++;
    }

    // Update counts
    const countAll = document.getElementById('edcStatusCountAll');
    if (countAll) countAll.textContent = edcMainListData.length;
    const countSub = document.getElementById('edcStatusCountSubmitted');
    if (countSub) countSub.textContent = totalDone;
    const countPen = document.getElementById('edcStatusCountPending');
    if (countPen) countPen.textContent = totalPending;

    // Progress bar
    const pct = edcMainListData.length > 0 ? Math.round((totalDone / edcMainListData.length) * 100) : 0;
    const pFill = document.getElementById('edcProgressBarFill');
    if (pFill) pFill.style.width = `${pct}%`;
    const pBadge = document.getElementById('edcListCountBadge');
    if (pBadge) pBadge.textContent = `${totalDone} Selesai / ${edcMainListData.length} SKU (${pct}%)`;

    // Filter items
    let filtered = edcMainListData.filter(item => {
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      if (currentEdcStatusFilter === 'submitted' && !isDone) return false;
      if (currentEdcStatusFilter === 'pending' && isDone) return false;

      if (q) {
        const text = `${item.sku} ${item.productName} ${item.rack} ${item.productType} ${item.locationName}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    // Sorting
    filtered.sort((a, b) => {
      if (currentEdcSort === 'name_asc') {
        return (a.productName || '').localeCompare(b.productName || '');
      } else if (currentEdcSort === 'sloc_asc') {
        return (a.rack || '').localeCompare(b.rack || '');
      } else if (currentEdcSort === 'stock_desc') {
        return (b.msltc || b.qtySystem || 0) - (a.msltc || a.qtySystem || 0);
      }
      return 0;
    });

    renderEdcMainListCards(filtered, false);
  }

  function renderEdcMainListCards(items, isLoadMore = false) {
    const container = document.getElementById('edcCardContainer');
    if (!container) return;

    if (!isLoadMore) {
      currentEdcListCache = items || [];
      currentEdcRenderLimit = 50;
    }

    if (!currentEdcListCache || currentEdcListCache.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 45px 20px; color: var(--text-muted); background: rgba(15,23,42,0.6); border-radius: 16px; border: 1px dashed rgba(255,255,255,0.15);">
          <div style="font-size:2rem; margin-bottom:10px;">📋</div>
          <div style="font-weight:600; color:#e2e8f0; margin-bottom:6px;">Tidak ada SKU tugas yang cocok</div>
          <div style="font-size:0.82rem; color:#94a3b8;">Coba ubah kata kunci pencarian atau sesuaikan filter status di atas.</div>
        </div>
      `;
      return;
    }

    const itemsToRender = currentEdcListCache.slice(0, currentEdcRenderLimit);
    let html = '';

    for (let i = 0; i < itemsToRender.length; i++) {
      const item = itemsToRender[i];
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      const audit = edcAuditResultsMap.get(item.sku.toLowerCase());

      const statusBadge = isDone
        ? '<span style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.35); padding:3px 9px; border-radius:6px; font-weight:700; font-size:0.75rem;">✅ DONE</span>'
        : '<span style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); padding:3px 9px; border-radius:6px; font-weight:700; font-size:0.75rem;">⏳ PENDING</span>';

      let edBadge = '';
      if (item.edActual) {
        const isMatch = item.edStatus === 'MATCH' || item.edActual === item.edSystem;
        edBadge = isMatch
          ? `<span class="edc-badge-match" style="padding:2px 7px; border-radius:5px; font-size:0.72rem; font-weight:700;">Koreksi: ${formatEdsDateDisplay(item.edActual)} (MATCH)</span>`
          : `<span class="edc-badge-revisi" style="padding:2px 7px; border-radius:5px; font-size:0.72rem; font-weight:700;">Koreksi: ${formatEdsDateDisplay(item.edActual)} (REVISI)</span>`;
      }

      html += `
        <div class="eds-card edc-card ${isDone ? 'status-done' : 'status-pending'}" onclick="selectEdcSkuForScan('${escapeHtml(item.sku)}', '${escapeHtml(item.edSystem)}')">
          <div class="eds-card-header">
            <span class="eds-card-sku">${escapeHtml(item.sku)}</span>
            <div style="display:flex; gap:6px; align-items:center;">
              ${statusBadge}
            </div>
          </div>
          <div class="eds-card-title">${escapeHtml(item.productName || 'Nama produk belum disinkron')}</div>
          <div class="eds-card-meta">
            <span>📍 Rak: <b>${escapeHtml(item.rack || '-')}</b></span>
            ${item.productType ? `<span>🏷️ Tipe: <b>${escapeHtml(item.productType)}</b></span>` : ''}
            ${item.msltc ? `<span>⏱️ MSLTC: <b>${item.msltc} Hari</b></span>` : ''}
            ${item.qtySystem ? `<span>📦 Stok: <b>${item.qtySystem}</b></span>` : ''}
            ${item.edSystem && item.edSystem !== '-' ? `<span>📅 ED Sistem: <b>${formatEdsDateDisplay(item.edSystem)}</b></span>` : ''}
          </div>
          ${edBadge ? `<div style="margin-top:8px;">${edBadge}</div>` : ''}
          ${audit && audit.remarks ? `<div style="font-size:0.75rem; color:#94a3b8; margin-top:6px; font-style:italic;">💬 "${escapeHtml(audit.remarks)}"</div>` : ''}
        </div>
      `;
    }

    const remaining = currentEdcListCache.length - currentEdcRenderLimit;
    let loadMoreBtn = '';
    if (remaining > 0) {
      const nextBatch = Math.min(remaining, 50);
      loadMoreBtn = `
        <div style="text-align:center; padding: 18px 0;" id="edcLoadMoreBox">
          <button type="button" class="btn-load-more" onclick="loadMoreEdcCards()" style="background: rgba(192, 132, 252, 0.15); border: 1px solid rgba(192, 132, 252, 0.4); color: #c084fc; padding: 12px 24px; border-radius: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; width: 100%; max-width: 340px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
            ⚡ Tampilkan ${nextBatch} SKU Lagi (${remaining} tersisa)
          </button>
        </div>
      `;
    }

    container.innerHTML = html + loadMoreBtn;
  }

  window.loadMoreEdcCards = function () {
    currentEdcRenderLimit += 50;
    renderEdcMainListCards(currentEdcListCache, true);
  };

  // ── Input & Scanning Logic ──
  window.selectEdcSkuForScan = function(sku, edSystem = null) {
    if (!sku) return;
    const cleanSku = String(sku).trim();
    selectedEdcSku = cleanSku;

    const banner = document.getElementById('edcSelectedBanner');
    const title = document.getElementById('edcSelectedTitle');
    if (banner && title) {
      banner.classList.remove('hidden');
      title.textContent = `SKU: ${cleanSku}${edSystem && edSystem !== '-' ? ' • ' + formatEdsDateDisplay(edSystem) : ''}`;
    }

    const skuInput = document.getElementById('edcSkuInput');
    if (skuInput) skuInput.value = cleanSku;

    lookupEdcSku(cleanSku, edSystem);
    switchEdcTab('scan');
  };

  window.clearEdcSelectedSku = function() {
    selectedEdcSku = null;
    const banner = document.getElementById('edcSelectedBanner');
    if (banner) banner.classList.add('hidden');
    resetEdcForm();
  };

  window.startEdcCameraScan = function() {
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

      const skuInput = document.getElementById('edcSkuInput');
      if (skuInput) skuInput.value = sku;
      
      const formattedDate = scannedDate ? formatDateToYMD(scannedDate) : null;
      lookupEdcSku(sku, formattedDate);

      if (formattedDate && edcFlatpickrInstance) {
        edcFlatpickrInstance.setDate(formattedDate);
        updateEdcStatusHelper();
      }

      playBarcodeBeep();
      showDccToast('success', 'Barcode Terbaca', `SKU: ${sku}`);
    });
  };

  function lookupEdcSku(sku, targetDate = null) {
    if (!sku) return;
    const cleanSku = String(sku).trim().toLowerCase();
    const noZero = cleanSku.replace(/^0+/, '');
    
    // Cari semua item di main list yang cocok dengan nomor SKU ini
    const matchingItems = edcMainListData.filter(i => {
      const s = String(i.sku || '').trim().toLowerCase();
      return s === cleanSku || (noZero && s === noZero);
    });

    let item = null;
    if (matchingItems.length > 0) {
      if (targetDate) {
        const stdTarget = excelDateToDateStr(targetDate);
        item = matchingItems.find(i => {
          const sys = excelDateToDateStr(i.edSystem);
          return sys === stdTarget || i.edSystem === targetDate;
        });
      }
      if (!item) {
        item = matchingItems.find(i => i.status !== 'DONE' && !edcSubmittedSkuSet.has(i.sku.toLowerCase()));
      }
      if (!item) {
        item = matchingItems[0];
      }
    }

    if (!item) {
      const resolved = resolveEdcProductInfo(sku);
      if (resolved && resolved.name && resolved.name !== 'Nama produk belum disinkron') {
        item = {
          sku: String(sku).trim(),
          productName: resolved.name,
          rack: resolved.rack,
          qtySystem: 0,
          edSystem: targetDate || '-',
          status: 'PENDING'
        };
      }
    }

    const nameInput = document.getElementById('edcNamaSku');
    const slocInput = document.getElementById('edcSlocExisting');
    const qtyInput = document.getElementById('edcQtySystem');
    const edSysInput = document.getElementById('edcExpiredDateSystem');

    if (item) {
      if (nameInput) nameInput.value = item.productName || '';
      if (slocInput) slocInput.value = item.rack || '';
      if (qtyInput) qtyInput.value = item.qtySystem || 0;
      if (edSysInput) edSysInput.value = (item.edSystem && item.edSystem !== '-') ? formatEdsDateDisplay(item.edSystem) : '-';

      // If already audited, pre-fill
      const audit = edcAuditResultsMap.get(cleanSku) || (noZero ? edcAuditResultsMap.get(noZero) : null);
      if (audit && (audit.edActual || audit.petugas || audit.totalFisik > 0)) {
        if (edcFlatpickrInstance && audit.edActual) {
          edcFlatpickrInstance.setDate(audit.edActual);
        }
        const goodInput = document.getElementById('edcFisikGood');
        if (goodInput) goodInput.value = audit.fisikGood || 0;
        const badInput = document.getElementById('edcFisikBad');
        if (badInput) badInput.value = audit.fisikBad || 0;
        const remInput = document.getElementById('edcRemaksInput');
        if (remInput) remInput.value = audit.remarks || '';
      }
    } else {
      if (nameInput) nameInput.value = '';
      if (slocInput) slocInput.value = '';
      if (qtyInput) qtyInput.value = '0';
      if (edSysInput) edSysInput.value = '-';
    }

    updateEdcStatusHelper();
  }

  window.stepEdcValue = function(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    let val = parseInt(el.value, 10) || 0;
    val = Math.max(0, val + delta);
    el.value = val;
  };

  window.setEdcToggle = function(groupId, val) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.eds-toggle-btn').forEach(btn => {
      if (btn.getAttribute('data-value') === val) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  };

  function initEdcFlatpickr() {
    const input = document.getElementById('edcExpiredDateNew');
    if (!input) return;

    if (!edcFlatpickrInstance && typeof flatpickr !== 'undefined') {
      try {
        edcFlatpickrInstance = flatpickr(input, {
          dateFormat: 'Y-m-d',
          altInput: true,
          altFormat: 'd/m/Y',
          allowInput: true,
          locale: typeof flatpickr.l10ns !== 'undefined' && flatpickr.l10ns.id ? flatpickr.l10ns.id : 'default',
          onChange: function() {
            updateEdcStatusHelper();
          }
        });
      } catch(e) {}
    }

    input.removeEventListener('change', updateEdcStatusHelper);
    input.removeEventListener('input', updateEdcStatusHelper);
    input.addEventListener('change', updateEdcStatusHelper);
    input.addEventListener('input', updateEdcStatusHelper);
  }

  function updateEdcStatusHelper() {
    const helper = document.getElementById('edcStatusHelper');
    const dateInput = document.getElementById('edcExpiredDateNew');
    const sysInput = document.getElementById('edcExpiredDateSystem');
    if (!helper || !dateInput) return;

    const actualDate = dateInput.value.trim();
    if (!actualDate) {
      helper.innerHTML = '';
      return;
    }

    const sysDateStr = sysInput ? sysInput.value.trim() : '';
    const stdActual = excelDateToDateStr(actualDate);
    const stdSys = excelDateToDateStr(sysDateStr);

    const todayStr = new Date().toISOString().split('T')[0];
    const isExpired = stdActual < todayStr;

    if (isExpired) {
      helper.innerHTML = '<span class="edc-badge-expired" style="padding:2px 8px; border-radius:5px; font-weight:700;">⚠️ EXPIRED (Lewat Tanggal)</span>';
    } else if (stdSys && stdActual === stdSys) {
      helper.innerHTML = '<span class="edc-badge-match" style="padding:2px 8px; border-radius:5px; font-weight:700;">✅ MATCH (Sama dengan Sistem)</span>';
    } else {
      helper.innerHTML = '<span class="edc-badge-revisi" style="padding:2px 8px; border-radius:5px; font-weight:700;">⚡ REVISI (Berbeda dengan Sistem)</span>';
    }
  }

  // ── Photo Upload Logic ──
  window.captureEdcPhoto = function(type) {
    if (type === 'camera') {
      const el = document.getElementById('edcPhotoCameraInput');
      if (el) el.click();
    } else {
      const el = document.getElementById('edcPhotoGalleryInput');
      if (el) el.click();
    }
  };

  window.handleEdcPhotoFile = function(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    const reader = new FileReader();
    reader.onload = function(evt) {
      const dataUrl = evt.target.result;
      compressImage(dataUrl, 800, 0.75, (compressed) => {
        edcPhotoList = [compressed];
        renderEdcPhotoPreviews();
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  function renderEdcPhotoPreviews() {
    const container = document.getElementById('edcPhotoPreviewList');
    if (!container) return;
    if (edcPhotoList.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div style="position:relative; display:inline-block; margin-top:8px;">
        <img src="${edcPhotoList[0]}" style="width:110px; height:110px; object-fit:cover; border-radius:12px; border:2px solid #a855f7;">
        <button type="button" onclick="removeEdcPhoto(0)" style="position:absolute; top:-6px; right:-6px; background:#ef4444; color:#fff; border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; font-weight:bold; display:flex; align-items:center; justify-content:center;">✕</button>
      </div>
    `;
  }

  window.removeEdcPhoto = function(idx) {
    edcPhotoList.splice(idx, 1);
    renderEdcPhotoPreviews();
  };

  window.saveEdcDefaultPic = function() {
    const input = document.getElementById('edcInputBy');
    if (!input || !input.value.trim()) {
      showDccToast('warning', 'Input Kosong', 'Ketik nama Anda terlebih dahulu.');
      return;
    }
    localStorage.setItem(EDC_PIC_KEY, input.value.trim());
    showDccToast('success', 'PIC Disimpan', `Nama "${input.value.trim()}" akan selalu otomatis terisi.`);
  };

  function loadEdcSavedPic() {
    const saved = localStorage.getItem(EDC_PIC_KEY);
    const input = document.getElementById('edcInputBy');
    if (saved && input && !input.value) {
      input.value = saved;
    }
  }

  // ── Form Submission ──
  window.submitEdcForm = function() {
    const skuInput = document.getElementById('edcSkuInput');
    const sku = skuInput ? skuInput.value.trim() : '';
    if (!sku) {
      showDccToast('warning', 'SKU Wajib Diisi', 'Silakan scan atau ketik nomor SKU.');
      return;
    }

    const edInput = document.getElementById('edcExpiredDateNew');
    const edActual = edInput ? edInput.value.trim() : '';
    if (!edActual) {
      showDccToast('warning', 'Tanggal ED Wajib Diisi', 'Silakan pilih tanggal Expired Date fisik produk.');
      return;
    }

    const picInput = document.getElementById('edcInputBy');
    const pic = picInput ? picInput.value.trim() : '';
    if (!pic) {
      showDccToast('warning', 'Nama PIC Wajib Diisi', 'Silakan masukkan nama petugas pemeriksa.');
      return;
    }

    const skuKey = sku.toLowerCase();
    if (edcSubmittedSkuSet.has(skuKey)) {
      pendingEdcSubmitPayload = buildEdcPayload();
      const modal = document.getElementById('edcConfirmEditModal');
      const desc = document.getElementById('edcConfirmEditDesc');
      if (desc) desc.textContent = `SKU ${sku} sudah pernah diinput sebelumnya. Apakah Anda ingin memperbarui data koreksi ED produk ini?`;
      if (modal) modal.classList.remove('hidden');
      return;
    }

    executeEdcSubmit(buildEdcPayload());
  };

  window.closeEdcConfirmEditModal = function() {
    const modal = document.getElementById('edcConfirmEditModal');
    if (modal) modal.classList.add('hidden');
    pendingEdcSubmitPayload = null;
  };

  window.proceedEdcConfirmedSubmit = function() {
    closeEdcConfirmEditModal();
    if (pendingEdcSubmitPayload) {
      executeEdcSubmit(pendingEdcSubmitPayload);
      pendingEdcSubmitPayload = null;
    }
  };

  function buildEdcPayload() {
    const sku = (document.getElementById('edcSkuInput')?.value || '').trim();
    const productName = (document.getElementById('edcNamaSku')?.value || '').trim();
    const rackSystem = (document.getElementById('edcSlocExisting')?.value || '').trim();
    const qtySystem = Number(document.getElementById('edcQtySystem')?.value) || 0;
    const edSystem = (document.getElementById('edcExpiredDateSystem')?.value || '-').trim();

    let rackActual = 'Match';
    const activeToggle = document.querySelector('#edcSlocActualGroup .eds-toggle-btn.active');
    if (activeToggle) rackActual = activeToggle.getAttribute('data-value') || 'Match';

    const edActual = (document.getElementById('edcExpiredDateNew')?.value || '').trim();
    const fisikGood = Number(document.getElementById('edcFisikGood')?.value) || 0;
    const fisikBad = Number(document.getElementById('edcFisikBad')?.value) || 0;
    const pic = (document.getElementById('edcInputBy')?.value || '').trim();
    const remarks = (document.getElementById('edcRemaksInput')?.value || '').trim();

    const stdActual = excelDateToDateStr(edActual);
    const stdSys = excelDateToDateStr(edSystem);
    let edStatus = 'MATCH';
    if (stdActual < new Date().toISOString().split('T')[0]) {
      edStatus = 'EXPIRED';
    } else if (stdSys && stdActual !== stdSys) {
      edStatus = 'REVISI';
    }

    return {
      action: 'saveEdCorrectionResult',
      module: 'ed_correction',
      sku: sku,
      productName: productName,
      rackSystem: rackSystem,
      rackActual: rackActual,
      qtySystem: qtySystem,
      edSystem: edSystem,
      edActual: edActual,
      edStatus: edStatus,
      fisikGood: fisikGood,
      fisikBad: fisikBad,
      totalFisik: fisikGood + fisikBad,
      selisih: (fisikGood + fisikBad) - qtySystem,
      petugas: pic,
      remarks: remarks,
      photoBase64: edcPhotoList.length > 0 ? edcPhotoList[0] : '',
      timestamp: new Date().toLocaleString('id-ID')
    };
  }

  async function executeEdcSubmit(payload) {
    const submitBtn = document.getElementById('edcSubmitBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>Mengirim Data... ⏳</span>';
    }

    const skuKey = payload.sku.toLowerCase();

    // Update local state immediately
    edcSubmittedSkuSet.add(skuKey);
    edcAuditResultsMap.set(skuKey, payload);
    edcHasilRows.unshift(payload);

    // Update main list item if present
    const item = edcMainListData.find(i => i.sku.toLowerCase() === skuKey);
    if (item) {
      item.status = 'DONE';
      item.edActual = payload.edActual;
      item.edStatus = payload.edStatus;
      item.fisikGood = payload.fisikGood;
      item.fisikBad = payload.fisikBad;
      item.totalFisik = payload.totalFisik;
      item.selisih = payload.selisih;
      item.petugas = payload.petugas;
      item.remarks = payload.remarks;
    }

    // Try sending to WebApp
    const webappUrl = getEdcWebappUrl();
    let sentOnline = false;

    if (navigator.onLine && webappUrl) {
      try {
        await fetch(webappUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        sentOnline = true;
      } catch (err) {
        console.warn('Gagal POST online EDC, simpan offline:', err);
      }
    }

    if (!sentOnline) {
      queueEdcOffline(payload);
    }

    playBarcodeBeep();
    showDccToast('success', 'Koreksi Disimpan!', `SKU ${payload.sku} berhasil disimpan (${sentOnline ? 'Online' : 'Tersimpan Offline'}).`);

    resetEdcForm();
    filterEdCorrectionList();
    renderEdcReport();
    switchEdcTab('main');

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span>Simpan Hasil Koreksi ED</span>
      `;
    }
  }

  function queueEdcOffline(payload) {
    try {
      const q = safeJsonParse(localStorage.getItem(EDC_OFFLINE_KEY), []);
      q.push(payload);
      localStorage.setItem(EDC_OFFLINE_KEY, JSON.stringify(q));
      updateEdcOfflineBadge();
    } catch(e) {}
  }

  function updateEdcOfflineBadge() {
    const q = safeJsonParse(localStorage.getItem(EDC_OFFLINE_KEY), []);
    const badge = document.getElementById('edcOfflineQueueBadge');
    if (!badge) return;
    if (q.length > 0) {
      badge.textContent = `⚡ ${q.length} Antrean Offline`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  window.syncEdcOfflineQueue = async function(manual = false) {
    if (!navigator.onLine) {
      if (manual) showDccToast('warning', 'Masih Offline', 'Koneksi internet belum tersedia.');
      return;
    }
    const q = safeJsonParse(localStorage.getItem(EDC_OFFLINE_KEY), []);
    if (q.length === 0) {
      if (manual) showDccToast('info', 'Antrean Bersih', 'Tidak ada data antrean offline.');
      return;
    }

    const webappUrl = getEdcWebappUrl();
    if (!webappUrl) return;

    let synced = 0;
    const remaining = [];

    for (let i = 0; i < q.length; i++) {
      try {
        await fetch(webappUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(q[i])
        });
        synced++;
      } catch (e) {
        remaining.push(q[i]);
      }
    }

    localStorage.setItem(EDC_OFFLINE_KEY, JSON.stringify(remaining));
    updateEdcOfflineBadge();
    if (synced > 0) {
      showDccToast('success', 'Sinkronisasi Sukses', `${synced} data antrean offline berhasil terkirim!`);
      fetchEdCorrectionData(true);
    }
  };

  function resetEdcForm() {
    const sku = document.getElementById('edcSkuInput');
    if (sku) sku.value = '';
    const name = document.getElementById('edcNamaSku');
    if (name) name.value = '';
    const sloc = document.getElementById('edcSlocExisting');
    if (sloc) sloc.value = '';
    const qty = document.getElementById('edcQtySystem');
    if (qty) qty.value = '0';
    const sysEd = document.getElementById('edcExpiredDateSystem');
    if (sysEd) sysEd.value = '-';
    if (edcFlatpickrInstance) edcFlatpickrInstance.clear();
    const good = document.getElementById('edcFisikGood');
    if (good) good.value = '0';
    const bad = document.getElementById('edcFisikBad');
    if (bad) bad.value = '0';
    const rem = document.getElementById('edcRemaksInput');
    if (rem) rem.value = '';
    edcPhotoList = [];
    renderEdcPhotoPreviews();
    const helper = document.getElementById('edcStatusHelper');
    if (helper) helper.innerHTML = '';
    const banner = document.getElementById('edcSelectedBanner');
    if (banner) banner.classList.add('hidden');
    selectedEdcSku = null;
  }

  // ── Report & Export Logic ──
  function renderEdcReport() {
    let totalDone = 0;
    let totalPending = 0;
    let totalRevisi = 0;

    for (let i = 0; i < edcMainListData.length; i++) {
      const item = edcMainListData[i];
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      if (isDone) {
        totalDone++;
        if (item.edStatus === 'REVISI' || (item.edActual && item.edSystem && item.edActual !== item.edSystem)) {
          totalRevisi++;
        }
      } else {
        totalPending++;
      }
    }

    const elTotal = document.getElementById('edcStatTotal');
    if (elTotal) elTotal.textContent = edcMainListData.length;
    const elDone = document.getElementById('edcStatDone');
    if (elDone) elDone.textContent = totalDone;
    const elPending = document.getElementById('edcStatPending');
    if (elPending) elPending.textContent = totalPending;
    const elRevisi = document.getElementById('edcStatRevisi');
    if (elRevisi) elRevisi.textContent = totalRevisi;

    // Render list
    const container = document.getElementById('edcReportTableContainer');
    if (!container) return;

    if (edcHasilRows.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding: 30px; color: var(--text-muted);">Belum ada riwayat koreksi hari ini.</div>';
      return;
    }

    let html = '';
    for (let i = 0; i < edcHasilRows.length; i++) {
      const h = edcHasilRows[i];
      const isMatch = h.edStatus === 'MATCH' || h.edActual === h.edSystem;
      html += `
        <div class="eds-report-item" style="border-left: 4px solid ${isMatch ? '#10b981' : '#f59e0b'}; margin-bottom:10px; padding:12px 14px; background:rgba(15,23,42,0.6); border-radius:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-weight:700; color:#c084fc;">${escapeHtml(h.sku)}</span>
            <span style="font-size:0.75rem; color:#94a3b8;">${escapeHtml(h.timestamp || '')}</span>
          </div>
          <div style="font-size:0.88rem; font-weight:600; color:#f1f5f9; margin-bottom:6px;">${escapeHtml(h.productName || 'Produk')}</div>
          <div style="font-size:0.78rem; color:#cbd5e1; display:flex; flex-wrap:wrap; gap:10px;">
            <span>ED Sistem: <b>${formatEdsDateDisplay(h.edSystem)}</b></span>
            <span>ED Baru: <b style="color:${isMatch ? '#34d399' : '#fbbf24'};">${formatEdsDateDisplay(h.edActual)} (${escapeHtml(h.edStatus)})</b></span>
            <span>Fisik Good: <b>${h.fisikGood}</b></span>
            <span>Petugas: <b>${escapeHtml(h.petugas || '-')}</b></span>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  }

  window.shareEdcToWhatsApp = function() {
    if (edcMainListData.length === 0) {
      showDccToast('warning', 'Data Kosong', 'Belum ada data tugas untuk dibagikan.');
      return;
    }

    let totalDone = 0;
    let totalPending = 0;
    let totalRevisi = 0;
    const revisiList = [];

    for (let i = 0; i < edcMainListData.length; i++) {
      const item = edcMainListData[i];
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      if (isDone) {
        totalDone++;
        if (item.edStatus === 'REVISI' || (item.edActual && item.edSystem && item.edActual !== item.edSystem)) {
          totalRevisi++;
          revisiList.push(item);
        }
      } else {
        totalPending++;
      }
    }

    const todayDate = new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    let msg = `*LAPORAN HASIL AUDIT ED CORRECTION (MTG)*\n`;
    msg += `📅 ${todayDate}\n\n`;
    msg += `📊 *Ringkasan Operasional:*\n`;
    msg += `• Total SKU Tugas: ${edcMainListData.length}\n`;
    msg += `• Sudah Diperiksa: ${totalDone} SKU (${Math.round((totalDone/edcMainListData.length)*100)}%)\n`;
    msg += `• Belum Diperiksa: ${totalPending} SKU\n`;
    msg += `• Revisi ED Ditemukan: ${totalRevisi} SKU\n\n`;

    if (revisiList.length > 0) {
      msg += `⚠️ *Daftar Produk Revisi ED:*\n`;
      revisiList.slice(0, 15).forEach((r, idx) => {
        msg += `${idx + 1}. *[${r.sku}]* ${r.productName}\n`;
        msg += `   - ED Sistem: ${formatEdsDateDisplay(r.edSystem)} ➔ *ED Aktual: ${formatEdsDateDisplay(r.edActual)}*\n`;
        msg += `   - Rak: ${r.rack} | Good: ${r.fisikGood} | PIC: ${r.petugas}\n`;
      });
      if (revisiList.length > 15) {
        msg += `   _...dan ${revisiList.length - 15} produk lainnya._\n`;
      }
    }

    msg += `\n_Dikirim melalui SuperApp MTG - ED Correction System_`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  window.exportEdcToExcel = function() {
    if (edcMainListData.length === 0) {
      showDccToast('warning', 'Data Kosong', 'Tidak ada data untuk diexport.');
      return;
    }

    const headers = ['SKU', 'Nama Produk', 'Lokasi Rak', 'Stok Sistem', 'ED Sistem', 'ED Fisik Koreksi', 'Status ED', 'Fisik Good', 'Fisik Bad', 'Total Fisik', 'Selisih', 'Status Audit', 'Petugas', 'Remarks'];
    const rows = [headers];

    for (let i = 0; i < edcMainListData.length; i++) {
      const item = edcMainListData[i];
      const isDone = item.status === 'DONE' || edcSubmittedSkuSet.has(item.sku.toLowerCase());
      rows.push([
        `'${item.sku}`,
        `"${(item.productName || '').replace(/"/g, '""')}"`,
        `"${(item.rack || '').replace(/"/g, '""')}"`,
        item.qtySystem,
        formatEdsDateDisplay(item.edSystem),
        formatEdsDateDisplay(item.edActual),
        item.edStatus || (isDone ? 'MATCH' : '-'),
        item.fisikGood,
        item.fisikBad,
        item.totalFisik,
        item.selisih,
        isDone ? 'DONE' : 'PENDING',
        `"${(item.petugas || '').replace(/"/g, '""')}"`,
        `"${(item.remarks || '').replace(/"/g, '""')}"`
      ]);
    }

    const csvContent = rows.map(r => r.join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const todayStr = new Date().toISOString().split('T')[0];
    link.href = url;
    link.setAttribute('download', `Laporan_ED_Correction_MTG_${todayStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showDccToast('success', 'File Terunduh', 'Laporan CSV ED Correction berhasil diunduh.');
  };

  window.printEdcPdf = function() {
    window.print();
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

  // ══════════════════════════════════════════════════════════════════════════
  //  COMPLAIN TRACKER MODULE
  //  Integrated with GoWA WhatsApp Gateway & Realtime Telemetry HUD Alerts
  // ══════════════════════════════════════════════════════════════════════════

  let complainList = [];
  let complainActiveTab = 'semua';
  let complainSearchQuery = '';
  let complainEvidenceData = null;
  let complainEvidenceFilename = null;
  let complainSyncSource = 'Demo Data';
  let COMPLAIN_API_BASE_URL = localStorage.getItem('superapp_complain_api_url') || '';

  let lastKnownComplainIds = new Set();
  let activeComplainToastItem = null;
  let complainToastTimer = null;
  let isComplainPolling = false;

  // Resolves the best API URL for Complain Service
  function getComplainApiUrl(endpoint = '/api/complaints') {
    if (COMPLAIN_API_BASE_URL && COMPLAIN_API_BASE_URL.trim()) {
      return COMPLAIN_API_BASE_URL.trim().replace(/\/+$/, '') + endpoint;
    }
    if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http')) {
      return window.location.origin + endpoint;
    }
    return 'http://127.0.0.1:3100' + endpoint;
  }

  const FIRESTORE_REST_URL = 'https://firestore.googleapis.com/v1/projects/complain-m/databases/(default)/documents/complaints';

  function mapFirestoreDocToComplain(d) {
    const f = d.fields || {};
    const id = f.id?.stringValue || d.name.split('/').pop();
    return {
      id: id,
      type: f.type?.stringValue || 'complain',
      hub: f.hub?.stringValue || 'Hub MTG Menteng',
      invoice: f.invoice?.stringValue || '',
      sender: f.sender?.stringValue || '',
      description: f.description?.stringValue || '',
      productImageUrl: f.productImageUrl?.stringValue || null,
      status: f.status?.stringValue || 'baru',
      createdAt: f.createdAt?.stringValue || d.createTime,
      claimedBy: f.claimedBy?.stringValue || null,
      claimedAt: f.claimedAt?.stringValue || null,
      resolvedAt: f.resolvedAt?.stringValue || null,
      evidenceUrl: f.evidenceUrl?.stringValue || null,
      rawText: f.rawText?.stringValue || ''
    };
  }

  function formatComplainDate(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      const day = String(d.getDate()).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];
      const mon = months[d.getMonth()];
      const yr = d.getFullYear();
      const hr = String(d.getHours()).padStart(2, '0');
      const mn = String(d.getMinutes()).padStart(2, '0');
      return `${day} ${mon} ${yr}, ${hr}:${mn}`;
    } catch (e) {
      return isoStr;
    }
  }

  function formatComplainDateShort(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      const day = String(d.getDate()).padStart(2, '0');
      const mon = String(d.getMonth() + 1).padStart(2, '0');
      const hr = String(d.getHours()).padStart(2, '0');
      const mn = String(d.getMinutes()).padStart(2, '0');
      return `${day}/${mon} ${hr}:${mn}`;
    } catch (e) {
      return isoStr;
    }
  }

  function getStatusLabel(status) {
    const map = { baru: 'Baru', dikerjakan: 'Dikerjakan', selesai: 'Selesai' };
    return map[status] || status;
  }

  window.fetchComplainData = async function (forceRefresh = false) {
    if (!forceRefresh && complainList.length > 0) {
      filterComplainList();
      return;
    }

    const cardContainer = document.getElementById('cplCardContainer');
    if (complainList.length === 0 && cardContainer) {
      cardContainer.innerHTML = `
        <div class="cpl-loading-placeholder">
          <div class="loading-spinner" style="width:32px;height:32px;margin:0 auto 12px auto;"></div>
          <div>Memuat data complain...</div>
        </div>
      `;
    }

    // 1. Coba ambil dari GoWA Webhook API endpoint (via proxy lokal atau URL custom)
    const apiUrl = getComplainApiUrl('/api/complaints');
    try {
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.data) && json.data.length > 0) {
          complainList = json.data;
          complainSyncSource = 'VPS GoWA';
          complainList.forEach(c => lastKnownComplainIds.add(c.id));
          localStorage.setItem('superapp_cached_complaints', JSON.stringify(complainList));
          filterComplainList();
          updateComplainMeta();
          return;
        }
      }
    } catch (apiErr) {
      // lanjut ke Firestore REST
    }

    // 2. Ambil langsung dari Cloud Firestore REST API (aktif di seluruh dunia tanpa perlu port 3100)
    try {
      const fsRes = await fetch(`${FIRESTORE_REST_URL}?pageSize=200`, {
        cache: 'no-cache',
        signal: AbortSignal.timeout(6000)
      });
      if (fsRes.ok) {
        const fsJson = await fsRes.json();
        if (fsJson && Array.isArray(fsJson.documents)) {
          complainList = fsJson.documents.map(mapFirestoreDocToComplain);
          complainList.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          complainSyncSource = 'Cloud (Firestore)';
          complainList.forEach(c => lastKnownComplainIds.add(c.id));
          localStorage.setItem('superapp_cached_complaints', JSON.stringify(complainList));
          filterComplainList();
          updateComplainMeta();
          return;
        } else if (fsJson && !fsJson.documents) {
          // Firestore aktif tapi koleksi masih kosong
          complainList = [];
          complainSyncSource = 'Cloud (Firestore)';
          localStorage.setItem('superapp_cached_complaints', JSON.stringify([]));
          filterComplainList();
          updateComplainMeta();
          return;
        }
      }
    } catch (fsErr) {
      console.warn('Firestore REST fetch notice:', fsErr);
    }

    // 3. Coba dari cache lokal jika pernah tersimpan
    const cached = localStorage.getItem('superapp_cached_complaints');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          complainList = parsed;
          complainSyncSource = 'Cache Lokal';
          complainList.forEach(c => lastKnownComplainIds.add(c.id));
          filterComplainList();
          updateComplainMeta();
          return;
        }
      } catch (e) {}
    }

    // 4. Default: list kosong (tidak ada dummy palsu)
    complainList = [];
    complainSyncSource = 'Cloud (Firestore)';
    filterComplainList();
    updateComplainMeta();
  };

  window.refreshComplainData = function () {
    const refreshBtn = document.querySelector('.cpl-refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');
    fetchComplainData(true);
    setTimeout(() => {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }, 800);
  };

  window.configureComplainApiUrl = function () {
    const current = COMPLAIN_API_BASE_URL || '';
    const input = prompt(
      'Masukkan URL Server Webhook GoWA VPS (contoh: http://192.168.1.50:3100 atau https://bot.domain.com):\n(Kosongkan untuk otomatis menggunakan Cloud Firestore langsung)',
      current
    );
    if (input !== null) {
      COMPLAIN_API_BASE_URL = input.trim().replace(/\/+$/, '');
      localStorage.setItem('superapp_complain_api_url', COMPLAIN_API_BASE_URL);
      fetchComplainData(true);
    }
  };

  let isFirstComplainPoll = true;

  // Web Audio chime generator (crisp two-tone alert for complain, urgent alert for cancel)
  function playComplainAlertSound(isCancel = false) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const now = ctx.currentTime;
      
      if (isCancel) {
        // Urgent 3-tone buzzer alert for Cancel order
        [784, 659.25, 523.25].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(freq, now + i * 0.14);
          gain.gain.setValueAtTime(0.35, now + i * 0.14);
          gain.gain.exponentialRampToValueAtTime(0.01, now + (i + 1) * 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.14);
          osc.stop(now + (i + 1) * 0.14);
        });
      } else {
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(587.33, now); // D5
        gain1.gain.setValueAtTime(0.35, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.28);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880, now + 0.16); // A5
        gain2.gain.setValueAtTime(0.45, now + 0.16);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.55);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.16);
        osc2.stop(now + 0.55);
      }
    } catch (e) {}
  }

  function handleNewComplainNotification(newItems) {
    if (!newItems || newItems.length === 0) return;
    const newBaru = newItems.filter(c => c.status === 'baru');
    if (newBaru.length === 0) return;

    const latest = newBaru[0];
    const hub = latest.hub || 'Hub MTG Menteng';
    const inv = latest.invoice || 'INV';
    const desc = latest.description || 'Keluhan baru masuk';
    const isCancel = latest.type === 'cancel' ||
      /cancel|batal|dibatalkan/i.test(latest.title || '') ||
      /cancel|batal|dibatalkan/i.test(latest.description || '') ||
      /cancel|batal|dibatalkan/i.test(latest.rawText || '');

    const title = isCancel ? `🚫 CANCEL ORDER: ${hub}` : `🚨 Complain Baru: ${hub}`;
    const body = `Inv: ${inv} | ${desc.substring(0, 75)}`;

    // 1. Play alert chime
    playComplainAlertSound(isCancel);

    // 2. Native Android Notification (via WebView bridge)
    if (window.AndroidUpdateBridge && typeof window.AndroidUpdateBridge.showNativeNotification === 'function') {
      try {
        window.AndroidUpdateBridge.showNativeNotification(
          title,
          body,
          String(latest.id || ''),
          String(latest.invoice || ''),
          String(latest.productImageUrl || '')
        );
      } catch (e) {
        console.warn('Android native notif error:', e);
      }
    }

    // 3. Web Notification API (Browser / PWA)
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notif = new Notification(title, {
          body: body,
          icon: 'assets/icon-192.png',
          badge: 'assets/icon-192.png',
          tag: 'complain-' + latest.id
        });
        notif.onclick = function () {
          window.focus();
          if (window.openAppMenu) window.openAppMenu('complain');
          if (window.showComplainDetail) window.showComplainDetail(latest.id);
          notif.close();
        };
      } catch (e) {}
    }

    // 4. In-App HUD Toast Banner (danger red for cancel, warning amber for complain)
    showGlobalToast(isCancel ? 'danger' : 'warning', title, body);
  }

  // Request browser notification permission if not yet decided
  window.requestComplainNotificationPermission = function () {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        Notification.requestPermission();
      } catch (e) {}
    }
  };

  window.pollNewComplaints = async function () {
    if (isComplainPolling) return;
    isComplainPolling = true;

    try {
      let fetchedItems = null;

      // 1. Coba REST API
      const apiUrl = getComplainApiUrl('/api/complaints');
      try {
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.data)) {
            fetchedItems = json.data;
            complainSyncSource = 'VPS GoWA';
          }
        }
      } catch (err) {}

      // 2. Fallback ke Firestore REST
      if (!fetchedItems) {
        try {
          const fsRes = await fetch(`${FIRESTORE_REST_URL}?pageSize=200`, {
            cache: 'no-cache',
            signal: AbortSignal.timeout(6000)
          });
          if (fsRes.ok) {
            const fsJson = await fsRes.json();
            if (fsJson && Array.isArray(fsJson.documents)) {
              fetchedItems = fsJson.documents.map(mapFirestoreDocToComplain);
              fetchedItems.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
              complainSyncSource = 'Cloud (Firestore)';
            } else if (fsJson && !fsJson.documents) {
              fetchedItems = [];
            }
          }
        } catch (fbErr) {}
      }

      if (fetchedItems && Array.isArray(fetchedItems)) {
        let notifiedSet = new Set();
        try {
          const stored = localStorage.getItem('superapp_notified_complain_ids');
          if (stored) {
            notifiedSet = new Set(JSON.parse(stored));
          }
        } catch (_) {}

        // Deteksi tiket berstatus 'baru' yang belum pernah dinotifikasikan di perangkat ini (dalam 24 jam terakhir)
        const unnotifiedNew = fetchedItems.filter(c => {
          if (c.status !== 'baru') return false;
          if (notifiedSet.has(c.id)) return false;
          const ageHours = (Date.now() - new Date(c.createdAt || 0).getTime()) / (1000 * 60 * 60);
          return ageHours < 24;
        });

        if (unnotifiedNew.length > 0) {
          handleNewComplainNotification(unnotifiedNew);
          unnotifiedNew.forEach(c => notifiedSet.add(c.id));
          try {
            const arr = Array.from(notifiedSet).slice(-200);
            localStorage.setItem('superapp_notified_complain_ids', JSON.stringify(arr));
          } catch (_) {}
        }

        fetchedItems.forEach(c => lastKnownComplainIds.add(c.id));
        isFirstComplainPoll = false;

        complainList = fetchedItems;
        try {
          localStorage.setItem('superapp_cached_complaints', JSON.stringify(complainList));
        } catch (e) {}

        updateComplainMeta();
        // Update list card jika sedang di workspace complain
        const workspace = document.getElementById('complainWorkspace');
        if (workspace && !workspace.classList.contains('hidden')) {
          filterComplainList();
        }
      }
    } catch (e) {
      console.warn('Poll complain error:', e);
    } finally {
      isComplainPolling = false;
    }
  };

  // Start background live polling setiap 8 detik
  setInterval(window.pollNewComplaints, 8000);
  setTimeout(window.pollNewComplaints, 1500);

  // Request browser notification permission upon first click
  document.addEventListener('click', function reqNotifOnce() {
    window.requestComplainNotificationPermission();
    document.removeEventListener('click', reqNotifOnce);
  }, { once: true });

  function updateComplainMeta() {
    const countBaru = complainList.filter(c => c.status === 'baru').length;
    const badge = document.getElementById('cplCounterBadge');
    if (badge) {
      badge.textContent = countBaru;
      badge.classList.toggle('empty', countBaru === 0);
    }

    const homeBadge = document.getElementById('homeComplainBadge');
    if (homeBadge) {
      if (countBaru > 0) {
        homeBadge.textContent = countBaru > 99 ? '99+' : countBaru;
        homeBadge.classList.remove('hidden');
      } else {
        homeBadge.classList.add('hidden');
      }
    }

    // Tab counts
    const countAll = complainList.length;
    const countDikerjakan = complainList.filter(c => c.status === 'dikerjakan').length;
    const countSelesai = complainList.filter(c => c.status === 'selesai').length;

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('cplTabCountAll', countAll);
    el('cplTabCountBaru', countBaru);
    el('cplTabCountDikerjakan', countDikerjakan);
    el('cplTabCountSelesai', countSelesai);

    const syncBadge = document.getElementById('cplLastSyncBadge');
    if (syncBadge) {
      syncBadge.textContent = complainSyncSource;
      syncBadge.style.cursor = 'pointer';
      syncBadge.title = 'Klik untuk mengatur URL Server GoWA VPS';
      syncBadge.onclick = window.configureComplainApiUrl;
    }
  }

  function filterComplainList() {
    let filtered = [...complainList];

    // Tab filter
    if (complainActiveTab !== 'semua') {
      filtered = filtered.filter(c => c.status === complainActiveTab);
    }

    // Search filter
    if (complainSearchQuery) {
      const q = complainSearchQuery.toLowerCase();
      filtered = filtered.filter(c =>
        (c.invoice || '').toLowerCase().includes(q) ||
        (c.sender || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (c.hub || '').toLowerCase().includes(q)
      );
    }

    // Sort: baru first, then dikerjakan, then selesai; within each, newest first
    const statusOrder = { baru: 0, dikerjakan: 1, selesai: 2 };
    filtered.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 3;
      const sb = statusOrder[b.status] ?? 3;
      if (sa !== sb) return sa - sb;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    renderComplainCards(filtered);
    updateComplainMeta();

    // Update list count badge
    const countBadge = document.getElementById('cplListCountBadge');
    if (countBadge) countBadge.textContent = `${filtered.length} Complain`;
  }

  function renderComplainCards(list) {
    const container = document.getElementById('cplCardContainer');
    if (!container) return;

    if (list.length === 0) {
      const tabLabel = complainActiveTab === 'semua' ? '' : ` berstatus "${getStatusLabel(complainActiveTab)}"`;
      const searchNote = complainSearchQuery ? ` dengan kata kunci "${complainSearchQuery}"` : '';
      container.innerHTML = `
        <div class="cpl-empty-state">
          <div class="cpl-empty-state-icon">📭</div>
          <div class="cpl-empty-state-title">Tidak Ada Complain</div>
          <div class="cpl-empty-state-desc">
            Tidak ditemukan complain${tabLabel}${searchNote}. Coba ubah filter atau kata kunci pencarian.
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(item => {
      const isCancel = item.type === 'cancel' ||
        /cancel|batal|dibatalkan/i.test(item.description || '') ||
        /cancel|batal|dibatalkan/i.test(item.rawText || '');

      return `
      <div class="cpl-card status-${item.status} ${isCancel ? 'is-cancel' : ''}" onclick="showComplainDetail('${item.id}')">
        <div class="cpl-card-header">
          <div class="cpl-card-hub">${escapeHtml(item.hub)}</div>
          <div style="display:flex; align-items:center; gap:5px;">
            ${isCancel ? `<span class="cpl-type-badge cancel">🚫 CANCEL</span>` : ''}
            <span class="cpl-status-badge ${item.status}">${getStatusLabel(item.status)}</span>
          </div>
        </div>
        <div class="cpl-card-invoice">
          ${escapeHtml(item.invoice)}
          ${item.productImageUrl ? `<span class="cpl-media-badge" title="Ada Foto Produk Terlampir">📷 Foto</span>` : ''}
        </div>
        <div class="cpl-card-sender">${escapeHtml(item.sender)}</div>
        <div class="cpl-card-desc">${escapeHtml(item.description)}</div>
        <div class="cpl-card-footer">
          <div class="cpl-card-date">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${formatComplainDateShort(item.createdAt)}
          </div>
          ${item.claimedBy ? `<div class="cpl-card-assignee">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            PIC: <strong>${escapeHtml(item.claimedBy)}</strong>
          </div>` : ''}
        </div>
      </div>
      `;
    }).join('');
  }



  window.showComplainDetail = function (id) {
    const item = complainList.find(c => c.id === id);
    if (!item) return;

    const section = document.getElementById('cplDetailSection');
    if (!section) return;

    complainEvidenceData = null;
    complainEvidenceFilename = null;

    const isCancel = item.type === 'cancel' ||
      /cancel|batal|dibatalkan/i.test(item.description || '') ||
      /cancel|batal|dibatalkan/i.test(item.rawText || '');

    let statusHeroClass = item.status;
    let statusHeroText = getStatusLabel(item.status).toUpperCase();
    let statusHeroSub = '';
    if (item.status === 'baru') statusHeroSub = 'Menunggu petugas mengambil alih';
    if (item.status === 'dikerjakan') statusHeroSub = `Sedang dikerjakan oleh ${item.claimedBy || '-'}`;
    if (item.status === 'selesai') statusHeroSub = `Diselesaikan pada ${formatComplainDate(item.resolvedAt)}`;

    // Timeline
    let timelineHtml = `
      <div class="cpl-timeline-item">
        <div class="cpl-timeline-dot baru active"></div>
        <div class="cpl-timeline-label">${isCancel ? 'Cancel Masuk' : 'Complain Masuk'}</div>
        <div class="cpl-timeline-time">${formatComplainDate(item.createdAt)}</div>
        <div class="cpl-timeline-user">Via WhatsApp Group</div>
      </div>
    `;

    if (item.status === 'dikerjakan' || item.status === 'selesai') {
      timelineHtml += `
        <div class="cpl-timeline-item">
          <div class="cpl-timeline-dot dikerjakan ${item.status === 'dikerjakan' ? 'active' : ''}"></div>
          <div class="cpl-timeline-label">Dikerjakan</div>
          <div class="cpl-timeline-time">${formatComplainDate(item.claimedAt)}</div>
          <div class="cpl-timeline-user">${escapeHtml(item.claimedBy || '-')}</div>
        </div>
      `;
    } else {
      timelineHtml += `
        <div class="cpl-timeline-item">
          <div class="cpl-timeline-dot pending"></div>
          <div class="cpl-timeline-label" style="color: #475569;">Menunggu dikerjakan</div>
        </div>
      `;
    }

    if (item.status === 'selesai') {
      timelineHtml += `
        <div class="cpl-timeline-item">
          <div class="cpl-timeline-dot selesai active"></div>
          <div class="cpl-timeline-label">Selesai</div>
          <div class="cpl-timeline-time">${formatComplainDate(item.resolvedAt)}</div>
          <div class="cpl-timeline-user">${escapeHtml(item.claimedBy || '-')}</div>
        </div>
      `;
    } else {
      timelineHtml += `
        <div class="cpl-timeline-item">
          <div class="cpl-timeline-dot pending"></div>
          <div class="cpl-timeline-label" style="color: #475569;">Menunggu diselesaikan</div>
        </div>
      `;
    }

    // Evidence section
    let evidenceHtml = '';
    if (item.status === 'selesai' && item.evidenceUrl) {
      evidenceHtml = `
        <div class="cpl-evidence-card">
          <div class="cpl-evidence-title">${isCancel ? 'Bukti Konfirmasi / Tarik Barang' : 'Bukti Reply Complain'}</div>
          <img src="${item.evidenceUrl}" class="cpl-evidence-preview-existing" alt="Bukti reply complain" onerror="this.style.display='none'">
        </div>
        <div class="cpl-completed-banner">
          <div class="cpl-completed-icon">✅</div>
          <div class="cpl-completed-text">Complain Telah Diselesaikan</div>
          <div class="cpl-completed-sub">Diselesaikan oleh ${escapeHtml(item.claimedBy)} pada ${formatComplainDate(item.resolvedAt)}</div>
        </div>
      `;
    } else if (item.status === 'dikerjakan') {
      evidenceHtml = `
        <div class="cpl-evidence-card">
          <div class="cpl-evidence-title">Upload Bukti Reply Complain</div>
          <div class="cpl-upload-choice-row" style="display:flex; gap:8px; margin-bottom:10px;">
            <button type="button" class="cpl-btn-subtle" onclick="triggerComplainEvidenceUpload('gallery')" style="flex:1; padding:9px 12px; background:rgba(56,189,248,0.12); border:1px solid rgba(56,189,248,0.35); border-radius:8px; color:#38bdf8; font-weight:600; cursor:pointer; font-size:0.82rem; display:flex; align-items:center; justify-content:center; gap:6px;">
              <span>🖼️ Dari Galeri</span>
            </button>
            <button type="button" class="cpl-btn-subtle" onclick="triggerComplainEvidenceUpload('camera')" style="flex:1; padding:9px 12px; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); border-radius:8px; color:#10b981; font-weight:600; cursor:pointer; font-size:0.82rem; display:flex; align-items:center; justify-content:center; gap:6px;">
              <span>📷 Buka Kamera</span>
            </button>
          </div>
          <div class="cpl-upload-zone" id="cplUploadZone" onclick="triggerComplainEvidenceUpload('gallery')">
            <div class="cpl-upload-icon">📸</div>
            <div class="cpl-upload-text">Pilih foto screenshot dari galeri atau kamera</div>
            <div class="cpl-upload-hint">Format gambar PNG, JPG, JPEG didukung</div>
          </div>
        </div>
      `;
    }

    // Action buttons
    let actionsHtml = '';
    if (item.status === 'baru') {
      actionsHtml = `
        <div class="cpl-actions">
          <button type="button" class="cpl-btn-primary" onclick="claimComplain('${item.id}')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            ${isCancel ? 'Kerjakan Pembatalan Ini' : 'Kerjakan Complain Ini'}
          </button>
        </div>
      `;
    } else if (item.status === 'dikerjakan') {
      actionsHtml = `
        <div class="cpl-actions">
          <button type="button" class="cpl-btn-resolve" id="cplResolveBtn" onclick="resolveComplain('${item.id}')" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Tandai Selesai
          </button>
          <div style="font-size: 0.72rem; color: #64748b; text-align: center;">Upload bukti terlebih dahulu untuk mengaktifkan tombol ini</div>
        </div>
      `;
    }

    section.innerHTML = `
      <div class="cpl-detail-header">
        <button type="button" class="cpl-detail-back-btn" onclick="closeComplainDetail()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="cpl-detail-title-text">${isCancel ? 'Detail Pembatalan (Cancel)' : 'Detail Complain'}</div>
        <div style="display:flex; align-items:center; gap:5px;">
          ${isCancel ? `<span class="cpl-type-badge cancel" style="background:rgba(239,68,68,0.22); color:#ef4444; border:1px solid rgba(239,68,68,0.5); font-size:10px; font-weight:800; padding:2px 6px; border-radius:4px;">🚫 CANCEL</span>` : ''}
          <span class="cpl-status-badge ${item.status}">${getStatusLabel(item.status)}</span>
        </div>
      </div>

      <div class="cpl-detail-body">
        ${isCancel ? `
        <!-- Cancel Warning Alert Banner -->
        <div class="cpl-cancel-alert-box" style="background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.45); border-radius:10px; padding:12px 14px; margin-bottom:14px; display:flex; align-items:center; gap:12px;">
          <span style="font-size:24px; line-height:1;">🚫</span>
          <div>
            <div style="font-size:13px; font-weight:800; color:#ef4444; letter-spacing:0.4px;">PESANAN DIBATALKAN (CANCEL ORDER)</div>
            <div style="font-size:11.5px; color:#cbd5e1; margin-top:2px;">Harap segera hentikan proses packing invoice ini atau koordinasikan agar barang tidak terkirim.</div>
          </div>
        </div>` : ''}

        <!-- Status Hero -->
        <div class="cpl-status-hero ${statusHeroClass}">
          <div class="cpl-status-hero-label">${isCancel ? 'Status Pembatalan Order' : 'Status Complain'}</div>
          <div class="cpl-status-hero-text">${statusHeroText}</div>
          <div class="cpl-status-hero-sub">${statusHeroSub}</div>
        </div>

        <!-- Info Card -->
        <div class="cpl-info-card">
          <div class="cpl-info-row">
            <div class="cpl-info-label">Hub</div>
            <div class="cpl-info-value">${escapeHtml(item.hub)}</div>
          </div>
          <div class="cpl-info-row">
            <div class="cpl-info-label">Invoice</div>
            <div class="cpl-info-value mono">${escapeHtml(item.invoice)}</div>
          </div>
          <div class="cpl-info-row">
            <div class="cpl-info-label">Pengirim</div>
            <div class="cpl-info-value">${escapeHtml(item.sender)}</div>
          </div>
          <div class="cpl-info-row">
            <div class="cpl-info-label">Tanggal Masuk</div>
            <div class="cpl-info-value mono">${formatComplainDate(item.createdAt)}</div>
          </div>
          <div class="cpl-info-row">
            <div class="cpl-info-label">Nama PIC</div>
            <div class="cpl-info-value" style="font-weight:600; color:${item.claimedBy ? '#38bdf8' : '#94a3b8'};">
              ${item.claimedBy ? escapeHtml(item.claimedBy) : '<span style="color:#94a3b8; font-style:italic;">Menunggu Klaim</span>'}
            </div>
          </div>
        </div>

        <!-- Description -->
        <div class="cpl-desc-card">
          <div class="cpl-desc-label">Detail Complain</div>
          <div class="cpl-desc-text">${escapeHtml(item.description)}</div>
        </div>

        ${item.productImageUrl ? `
        <!-- Product Photo Card (Foto dari WhatsApp) -->
        <div class="cpl-product-photo-card">
          <div class="cpl-product-photo-header">
            <div class="cpl-product-photo-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              Foto dari WhatsApp
            </div>
          </div>
          <div class="cpl-product-photo-hint">Tap foto untuk perbesar</div>
          <div class="cpl-product-photo-wrapper" onclick="openPhotoViewerModal('${item.productImageUrl}')">
            <img src="${item.productImageUrl}" class="cpl-product-photo-img" alt="Foto Produk Complain" loading="lazy" onerror="this.parentElement.style.display='none'">
            <div class="cpl-product-photo-zoom-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Timeline -->
        <div class="cpl-timeline-card">
          <div class="cpl-timeline-title">Timeline Penanganan</div>
          <div class="cpl-timeline">
            ${timelineHtml}
          </div>
        </div>

        <!-- Evidence -->
        ${evidenceHtml}

        <!-- Actions -->
        ${actionsHtml}
      </div>
    `;

    section.classList.remove('hidden');
    section.scrollTop = 0;
  };

  window.closeComplainDetail = function () {
    const section = document.getElementById('cplDetailSection');
    if (section) {
      section.classList.add('hidden');
      section.innerHTML = '';
    }
    complainEvidenceData = null;
    complainEvidenceFilename = null;
  };

  window.switchComplainTab = function (tab) {
    complainActiveTab = tab;

    // Update tab button styles
    ['All', 'Baru', 'Dikerjakan', 'Selesai'].forEach(t => {
      const btn = document.getElementById('cplTab' + t);
      if (btn) btn.classList.remove('active');
    });

    const tabMap = { semua: 'All', baru: 'Baru', dikerjakan: 'Dikerjakan', selesai: 'Selesai' };
    const activeBtn = document.getElementById('cplTab' + tabMap[tab]);
    if (activeBtn) activeBtn.classList.add('active');

    filterComplainList();
  };

  window.clearComplainFilter = function () {
    const input = document.getElementById('cplFilterInput');
    if (input) input.value = '';
    complainSearchQuery = '';
    document.getElementById('cplFilterClearBtn').classList.add('hidden');
    filterComplainList();
  };

  // Search input handler (attach on DOMContentLoaded)
  function initComplainSearch() {
    const input = document.getElementById('cplFilterInput');
    if (!input) return;

    let debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      const clearBtn = document.getElementById('cplFilterClearBtn');
      if (clearBtn) clearBtn.classList.toggle('hidden', !this.value);

      debounceTimer = setTimeout(() => {
        complainSearchQuery = this.value.trim();
        filterComplainList();
      }, 250);
    });
  }

  let activeClaimComplainId = null;

  function syncClaimComplain(id, item) {
    // Save to local cache
    try {
      localStorage.setItem('superapp_cached_complaints', JSON.stringify(complainList));
    } catch (e) {}

    // Update to Firestore if active
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
      try {
        firebase.firestore().collection('complaints').doc(id).update({
          status: 'dikerjakan',
          claimedBy: item.claimedBy,
          claimedAt: item.claimedAt
        });
      } catch (e) {
        console.warn('Firestore claim update error:', e);
      }
    }

    // Update to Firestore REST API (Cloud direct)
    try {
      fetch(`${FIRESTORE_REST_URL}/${id}?updateMask.fieldPaths=status&updateMask.fieldPaths=claimedBy&updateMask.fieldPaths=claimedAt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            status: { stringValue: 'dikerjakan' },
            claimedBy: { stringValue: item.claimedBy },
            claimedAt: { stringValue: item.claimedAt }
          }
        })
      }).catch(() => {});
    } catch (e) {}

    // Update to VPS REST API (via local proxy atau VPS langsung)
    try {
      const claimUrl = getComplainApiUrl(`/api/complaints/${id}/claim`);
      fetch(claimUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedBy: item.claimedBy })
      }).catch(() => {});
    } catch (e) {}
  }

  window.claimComplain = function (id) {
    const item = complainList.find(c => c.id === id);
    if (!item) {
      showGlobalToast('error', 'Tiket Tidak Ditemukan', 'Data tiket komplain tidak ditemukan.');
      return;
    }
    if (item.status !== 'baru') {
      showGlobalToast('info', 'Status Tiket', `Tiket ini sudah dalam status "${item.status}"`);
      return;
    }

    activeClaimComplainId = id;
    const modal = document.getElementById('cplPicClaimModal');
    const input = document.getElementById('cplPicNameInput');
    if (modal && input) {
      const savedPic = localStorage.getItem('superapp_pic_name') || '';
      input.value = savedPic;
      modal.classList.remove('hidden');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 100);
    } else {
      const promptPic = prompt('Masukkan Nama PIC yang mengerjakan complain ini:', localStorage.getItem('superapp_pic_name') || '');
      if (promptPic && promptPic.trim()) {
        const pic = promptPic.trim();
        localStorage.setItem('superapp_pic_name', pic);
        item.status = 'dikerjakan';
        item.claimedBy = pic;
        item.claimedAt = new Date().toISOString();
        filterComplainList();
        showComplainDetail(id);
        showGlobalToast('success', 'Tiket Diklaim', `Komplain sedang dikerjakan oleh ${pic}`);
        syncClaimComplain(id, item);
      }
    }
  };

  window.closePicClaimModal = function () {
    const modal = document.getElementById('cplPicClaimModal');
    if (modal) modal.classList.add('hidden');
    activeClaimComplainId = null;
  };

  window.confirmClaimComplain = async function () {
    const id = activeClaimComplainId;
    if (!id) return;

    const input = document.getElementById('cplPicNameInput');
    const rawVal = input ? input.value.trim() : '';
    if (!rawVal) {
      if (input) {
        input.focus();
        input.style.borderColor = '#ef4444';
        setTimeout(() => { input.style.borderColor = ''; }, 1200);
      }
      showGlobalToast('warning', 'Nama PIC Wajib Diisi', 'Silakan ketikkan nama PIC yang menangani komplain ini.');
      return;
    }

    const picName = rawVal;
    localStorage.setItem('superapp_pic_name', picName);
    closePicClaimModal();

    const item = complainList.find(c => c.id === id);
    if (!item) return;

    item.status = 'dikerjakan';
    item.claimedBy = picName;
    item.claimedAt = new Date().toISOString();

    filterComplainList();
    showComplainDetail(id);
    showGlobalToast('success', 'Tiket Diklaim', `Komplain sedang dikerjakan oleh ${picName}`);

    syncClaimComplain(id, item);
  };

  // Keyboard handler Enter/Escape di modal PIC
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('cplPicNameInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.confirmClaimComplain();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          window.closePicClaimModal();
        }
      });
    }
  });

  let activeProductPhotoComplainId = null;

  function handleEvidenceFileSelect(e) {
    const inputEl = e.target;
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;

    showGlobalToast('info', 'Memproses Foto', 'Sedang mengompresi dan menyiapkan foto bukti...');

    const reader = new FileReader();
    reader.onload = function (evt) {
      if (inputEl) inputEl.value = '';
      const rawDataUrl = evt.target.result;
      
      compressEvidenceImage(rawDataUrl, 1280, 0.82, function (compressedDataUrl) {
        complainEvidenceData = compressedDataUrl;
        complainEvidenceFilename = file.name || 'bukti_complain.jpg';

        // Update preview UI in detail section
        const zone = document.getElementById('cplUploadZone');
        if (zone) {
          zone.className = 'cpl-upload-zone has-preview';
          zone.innerHTML = `
            <img src="${complainEvidenceData}" class="cpl-evidence-preview" alt="Pratinjau Bukti Selesai">
            <div class="cpl-evidence-filename">✅ Bukti Foto Siap (${escapeHtml(complainEvidenceFilename)})</div>
            <div style="margin-top: 8px; font-size: 0.76rem; color: #38bdf8; font-weight: 600; cursor: pointer;">Ganti Foto</div>
          `;
        }

        // Enable Tandai Selesai button
        const resolveBtn = document.getElementById('cplResolveBtn');
        if (resolveBtn) {
          resolveBtn.disabled = false;
          resolveBtn.style.opacity = '1';
          resolveBtn.style.cursor = 'pointer';
        }

        showGlobalToast('success', 'Bukti Terpasang', 'Foto bukti penyelesaian berhasil dipilih. Tekan "Tandai Selesai" untuk menyimpan.');
      });
    };
    reader.onerror = function () {
      showGlobalToast('error', 'Gagal Membaca File', 'Foto tidak dapat dimuat. Silakan pilih kembali.');
    };
    reader.readAsDataURL(file);
  }

  function compressEvidenceImage(dataUrl, maxDim, quality, callback) {
    try {
      const img = new Image();
      img.onload = function () {
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
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL('image/jpeg', quality);
        callback(compressed);
      };
      img.onerror = function () {
        callback(dataUrl);
      };
      img.src = dataUrl;
    } catch (e) {
      callback(dataUrl);
    }
  }

  function initComplainEvidenceUpload() {
    const galleryInput = document.getElementById('cplEvidenceInput');
    const cameraInput = document.getElementById('cplEvidenceCameraInput');

    if (galleryInput && !galleryInput._hasListener) {
      galleryInput.addEventListener('change', handleEvidenceFileSelect);
      galleryInput._hasListener = true;
    }
    if (cameraInput && !cameraInput._hasListener) {
      cameraInput.addEventListener('change', handleEvidenceFileSelect);
      cameraInput._hasListener = true;
    }
  }
  window.handleEvidenceFileSelect = handleEvidenceFileSelect;

  window.triggerComplainEvidenceUpload = function (source = 'gallery') {
    initComplainEvidenceUpload();
    const targetInput = source === 'camera'
      ? document.getElementById('cplEvidenceCameraInput')
      : document.getElementById('cplEvidenceInput');

    if (targetInput) {
      targetInput.value = '';
      targetInput.click();
    }
  };

  window.resolveComplain = async function (id) {
    const item = complainList.find(c => c.id === id);
    if (!item || item.status !== 'dikerjakan') return;

    if (!complainEvidenceData) {
      showGlobalToast('warning', 'Bukti Diperlukan', 'Upload bukti screenshot reply complain terlebih dahulu.');
      return;
    }

    item.status = 'selesai';
    item.resolvedAt = new Date().toISOString();
    item.evidenceUrl = complainEvidenceData;

    const uploadedEvidence = complainEvidenceData;
    complainEvidenceData = null;
    complainEvidenceFilename = null;

    filterComplainList();
    showComplainDetail(id);
    showGlobalToast('success', 'Complain Selesai', 'Tiket telah berhasil diselesaikan dengan bukti terlampir!');

    // Save to local cache
    try {
      localStorage.setItem('superapp_cached_complaints', JSON.stringify(complainList));
    } catch (e) {}

    // Update to Firestore if active
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
      try {
        firebase.firestore().collection('complaints').doc(id).update({
          status: 'selesai',
          resolvedAt: item.resolvedAt,
          evidenceUrl: uploadedEvidence
        });
      } catch (e) {
        console.warn('Firestore resolve update error:', e);
      }
    }

    // Update to Firestore REST API (Cloud direct)
    try {
      fetch(`${FIRESTORE_REST_URL}/${id}?updateMask.fieldPaths=status&updateMask.fieldPaths=resolvedAt&updateMask.fieldPaths=evidenceUrl`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            status: { stringValue: 'selesai' },
            resolvedAt: { stringValue: item.resolvedAt },
            evidenceUrl: { stringValue: uploadedEvidence }
          }
        })
      }).catch(() => {});
    } catch (e) {}

    // Update to VPS REST API (via local proxy atau VPS langsung)
    try {
      const resolveUrl = getComplainApiUrl(`/api/complaints/${id}/resolve`);
      fetch(resolveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidenceUrl: uploadedEvidence })
      }).catch(() => {});
    } catch (e) {}
  };

  // Initialize complain search and upload handlers on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initComplainSearch();
      initComplainEvidenceUpload();
    });
  } else {
    initComplainSearch();
    initComplainEvidenceUpload();
  }

  // ──────────────────────────────────────────────
  // NEW KOLI INBOUND MTG - Simplified Table & Detail
  // ──────────────────────────────────────────────

  const KOLI_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1sULhhG0_Oe2hr2B34Lum08ibDuxWJtM9buz9kitAnKg/gviz/tq?tqx=out:csv&gid=0';
  const KOLI_PROXY_URL = '/api/koli-inbound-csv';
  const KOLI_CACHE_KEY = 'koli_inbound_cache_data_v3';

  let koliAllRows = [];
  let koliFilteredRows = [];
  let koliSelectedOrigin = 'all';
  let koliSearchQuery = '';
  let koliDisplayLimit = 100;
  let isKoliFetching = false;

  function parseKoliCsvRows(csvText) {
    const rows = parseCSV(csvText);
    if (!rows || rows.length <= 1) {
      throw new Error('Format CSV kosong atau tidak valid.');
    }

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    // 0. so_date (Col A, index 0)
    let dateIdx = headers.findIndex(h => h === 'so_date' || (h.includes('date') && !h.includes('update')));
    if (dateIdx === -1) dateIdx = 0;

    // 1. no_koli (Col C, index 2)
    let koliIdx = headers.findIndex(h => h === 'no_koli' || h === 'koli' || (h.includes('koli') && !h.includes('id')));
    if (koliIdx === -1) koliIdx = 2;

    // 2. so_number (Col D, index 3) - Avoid matching 'fsoid_koli_id'
    let soIdx = headers.findIndex(h => h === 'so_number' || h === 'no_so' || (h.includes('so') && h.includes('number') && !h.includes('date')));
    if (soIdx === -1) {
      soIdx = headers.findIndex(h => (h === 'so' || h.endsWith('_so') || h.startsWith('so_')) && !h.includes('date') && !h.includes('id'));
    }
    if (soIdx === -1) soIdx = 3;

    // 3. origin_location_name (Col E, index 4)
    let originIdx = headers.findIndex(h => h.includes('origin'));
    if (originIdx === -1) originIdx = 4;

    // 4. destination_location_name (Col F, index 5)
    let destIdx = headers.findIndex(h => h.includes('destination') || h.includes('dest'));
    if (destIdx === -1) destIdx = 5;

    // 5. product_sku_number (Col G, index 6)
    let skuIdx = headers.findIndex(h => h === 'product_sku_number' || h === 'sku' || h.includes('sku'));
    if (skuIdx === -1) skuIdx = 6;

    // 6. product_name (Col H, index 7) - Avoid matching 'origin_location_name'
    let nameIdx = headers.findIndex(h => h === 'product_name' || (h.includes('product') && h.includes('name')) || (h.includes('name') && !h.includes('location') && !h.includes('origin') && !h.includes('dest')));
    if (nameIdx === -1) nameIdx = 7;

    // 7. quantity (Col I, index 8)
    let qtyIdx = headers.findIndex(h => h === 'quantity' || h === 'qty' || h.includes('qty') || h.includes('quantity'));
    if (qtyIdx === -1) qtyIdx = 8;

    const colDate = dateIdx;
    const colKoli = koliIdx;
    const colSo = soIdx;
    const colOrigin = originIdx;
    const colDest = destIdx;
    const colSku = skuIdx;
    const colName = nameIdx;
    const colQty = qtyIdx;

    const items = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const noKoli = String(row[colKoli] || '').trim();
      const sku = String(row[colSku] || '').trim();
      if (!noKoli && !sku) continue;

      const soNumber = String(row[colSo] || '').trim();
      const origin = String(row[colOrigin] || '').trim() || 'Origin Tidak Diketahui';
      const dest = String(row[colDest] || '').trim();
      const name = String(row[colName] || '').trim() || '-';
      const rawQty = parseInt(row[colQty], 10);
      const qty = isNaN(rawQty) || rawQty <= 0 ? 1 : rawQty;
      const soDate = String(row[colDate] || '').trim();

      items.push({
        noKoli,
        soNumber,
        origin,
        dest,
        sku,
        name,
        qty,
        soDate
      });
    }

    return items;
  }

  function populateKoliOriginDropdown() {
    const originSelect = document.getElementById('koliOriginSelect');
    if (!originSelect) return;

    const originCounts = new Map();
    koliAllRows.forEach(item => {
      const orig = item.origin || 'Lainnya';
      originCounts.set(orig, (originCounts.get(orig) || 0) + 1);
    });

    const sortedOrigins = Array.from(originCounts.keys()).sort();

    let html = '<option value="all">Semua Origin (' + koliAllRows.length + ')</option>';
    sortedOrigins.forEach(orig => {
      const count = originCounts.get(orig);
      const isSelected = koliSelectedOrigin === orig ? 'selected' : '';
      html += '<option value="' + escapeHtml(orig) + '" ' + isSelected + '>' + escapeHtml(orig) + ' (' + count + ')</option>';
    });

    originSelect.innerHTML = html;
  }

  function filterKoliData() {
    const q = (koliSearchQuery || '').toLowerCase();
    koliFilteredRows = koliAllRows.filter(item => {
      // Origin filter
      if (koliSelectedOrigin !== 'all' && item.origin !== koliSelectedOrigin) {
        return false;
      }
      // Text query filter
      if (q) {
        const mOrigin = item.origin.toLowerCase().includes(q);
        const mName = item.name.toLowerCase().includes(q);
        const mKoli = item.noKoli.toLowerCase().includes(q);
        const mSo = item.soNumber.toLowerCase().includes(q);
        const mSku = item.sku.toLowerCase().includes(q);
        if (!mOrigin && !mName && !mKoli && !mSo && !mSku) return false;
      }
      return true;
    });
  }

  function renderKoliTable(appendOnly = false) {
    const tbody = document.getElementById('koliTableBody');
    const emptyState = document.getElementById('koliEmptyState');
    const rowCounter = document.getElementById('koliRowCountBadge');
    if (!tbody) return;

    if (!appendOnly) {
      filterKoliData();
    }

    if (rowCounter) {
      rowCounter.textContent = koliFilteredRows.length.toLocaleString('id-ID') + ' Baris';
    }

    if (koliFilteredRows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    const slice = koliFilteredRows.slice(0, koliDisplayLimit);

    let html = '';
    slice.forEach((row, idx) => {
      html += `
        <tr onclick="openKoliDetail(${idx})">
          <td class="td-origin">${escapeHtml(row.origin)}</td>
          <td class="td-name">${escapeHtml(row.name)}</td>
          <td class="td-koli">${escapeHtml(row.noKoli)}</td>
          <td class="td-so" title="${escapeHtml(row.soNumber)}">${escapeHtml(row.soNumber)}</td>
          <td class="td-sku">${escapeHtml(row.sku)}</td>
          <td class="td-qty">${row.qty}</td>
          <td class="td-arrow">&rsaquo;</td>
        </tr>
      `;
    });

    if (koliFilteredRows.length > koliDisplayLimit) {
      html += `
        <tr style="background: rgba(255,255,255,0.02);">
          <td colspan="7" style="text-align: center; padding: 14px;">
            <button type="button" class="btn-clean secondary" style="display:inline-flex; width:auto; padding:6px 18px; font-size:0.8rem;" onclick="loadMoreKoliRows(event)">
              Tampilkan Lebih Banyak (${slice.length} dari ${koliFilteredRows.length})
            </button>
          </td>
        </tr>
      `;
    }

    tbody.innerHTML = html;
  }

  window.loadMoreKoliRows = function (event) {
    if (event) event.stopPropagation();
    koliDisplayLimit += 150;
    renderKoliTable(true);
  };

  window.onKoliOriginSelectChange = function (val) {
    koliSelectedOrigin = val || 'all';
    koliDisplayLimit = 100;
    renderKoliTable();
  };

  window.clearKoliSearch = function () {
    const input = document.getElementById('koliSearchInput');
    const clearBtn = document.getElementById('koliSearchClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    koliSearchQuery = '';
    koliDisplayLimit = 100;
    renderKoliTable();
  };

  window.openKoliDetail = function (index) {
    const item = koliFilteredRows[index];
    if (!item) return;

    const modal = document.getElementById('koliDetailModal');
    if (modal) modal.classList.remove('hidden');

    const elTitle = document.getElementById('koliDetailTitleOrigin');
    const elKoli = document.getElementById('koliValNoKoli');
    const elSo = document.getElementById('koliValSoNumber');
    const elOrigin = document.getElementById('koliValOrigin');
    const elSku = document.getElementById('koliValSku');
    const elName = document.getElementById('koliValName');
    const elQty = document.getElementById('koliValQty');

    if (elTitle) elTitle.textContent = item.origin || 'Detail Koli';
    if (elKoli) elKoli.textContent = item.noKoli || '-';
    if (elSo) elSo.textContent = item.soNumber || '-';
    if (elOrigin) elOrigin.textContent = item.origin || '-';
    if (elName) elName.textContent = item.name || '-';
    if (elQty) elQty.textContent = String(item.qty || 1);

    // Helper untuk generate QR Code (Barcode Kotak)
    function renderKoliQr(container, text) {
      if (!container) return;
      container.innerHTML = '';
      const cleanText = String(text || '').trim();
      if (!cleanText) {
        container.innerHTML = '<span style="color:#64748b;font-size:0.75rem;padding:10px;text-align:center;">Masukkan teks untuk barcode</span>';
        return;
      }
      if (typeof QRCode !== 'undefined') {
        try {
          new QRCode(container, {
            text: cleanText,
            width: 160,
            height: 160,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
          const img = container.querySelector('img');
          const canvas = container.querySelector('canvas');
          if (img) {
            img.style.display = 'block';
            img.style.width = '160px';
            img.style.height = '160px';
          }
          if (canvas && (!img || !img.src)) {
            canvas.style.display = 'block';
            canvas.style.width = '160px';
            canvas.style.height = '160px';
          }
        } catch (qrErr) {
          console.warn('QR generation error:', qrErr);
          container.innerHTML = '<span style="color:#000;font-size:0.75rem;padding:10px;word-break:break-all;">' + escapeHtml(cleanText) + '</span>';
        }
      } else {
        container.innerHTML = '<span style="color:#000;font-size:0.75rem;padding:10px;word-break:break-all;">' + escapeHtml(cleanText) + '</span>';
      }
    }

    // 1. Generate QR Code untuk NO KOLI
    const qrKoliBox = document.getElementById('koliQrKoliBox');
    renderKoliQr(qrKoliBox, item.noKoli);

    // 2. Generate QR Code untuk SKU dan pasang live listener
    const qrSkuBox = document.getElementById('koliQrSkuBox');
    if (elSku) {
      elSku.value = item.sku || '';
      renderKoliQr(qrSkuBox, elSku.value);

      if (!elSku._hasLiveQrListener) {
        let debounceTimer = null;
        elSku.addEventListener('input', function () {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const targetBox = document.getElementById('koliQrSkuBox');
            renderKoliQr(targetBox, elSku.value);
          }, 50);
        });
        elSku._hasLiveQrListener = true;
      }
    } else {
      renderKoliQr(qrSkuBox, item.sku);
    }
  };

  window.closeKoliDetailModal = function () {
    const modal = document.getElementById('koliDetailModal');
    if (modal) modal.classList.add('hidden');
  };

  window.refreshKoliInboundData = function () {
    window.fetchKoliInboundData(true);
  };

  window.fetchKoliInboundData = async function (forceRefresh = false) {
    if (!forceRefresh && koliAllRows.length > 0) {
      renderKoliTable();
      return;
    }

    const refreshBtn = document.querySelector('.koli-refresh-icon-btn');
    const loadingState = document.getElementById('koliLoadingState');

    // Warm cache instant render
    if (!forceRefresh && koliAllRows.length === 0) {
      try {
        const cached = localStorage.getItem(KOLI_CACHE_KEY);
        if (cached) {
          const parsed = parseKoliCsvRows(cached);
          if (parsed.length > 0) {
            koliAllRows = parsed;
            populateKoliOriginDropdown();
            renderKoliTable();
          }
        }
      } catch (cacheErr) {
        console.warn('Failed to load Koli cache:', cacheErr);
      }
    }

    if (isKoliFetching) return;
    isKoliFetching = true;

    if (refreshBtn) refreshBtn.classList.add('spinning');
    if (koliAllRows.length === 0 && loadingState) loadingState.classList.remove('hidden');

    try {
      let csvText = '';
      let fetchSuccess = false;

      // Attempt 1: Direct Google Sheet fetch
      try {
        const directRes = await fetch(KOLI_SHEET_URL + '&_t=' + Date.now());
        if (directRes.ok) {
          csvText = await directRes.text();
          if (csvText && csvText.length > 50) {
            fetchSuccess = true;
          }
        }
      } catch (directErr) {
        console.warn('Direct sheet fetch failed, trying proxy:', directErr);
      }

      // Attempt 2: Local server proxy fallback
      if (!fetchSuccess) {
        const proxyRes = await fetch(KOLI_PROXY_URL + '?_t=' + Date.now());
        if (!proxyRes.ok) throw new Error('HTTP Error ' + proxyRes.status);
        csvText = await proxyRes.text();
      }

      const parsed = parseKoliCsvRows(csvText);
      if (!parsed || parsed.length === 0) {
        throw new Error('Data Koli kosong atau format tidak sesuai.');
      }

      koliAllRows = parsed;

      try {
        localStorage.setItem(KOLI_CACHE_KEY, csvText);
      } catch (saveErr) {
        console.warn('Failed to save koli cache:', saveErr);
      }

      populateKoliOriginDropdown();
      renderKoliTable();

    } catch (err) {
      console.error('Fetch Koli Inbound Error:', err);
      if (koliAllRows.length === 0) {
        const emptyState = document.getElementById('koliEmptyState');
        if (emptyState) {
          emptyState.classList.remove('hidden');
          emptyState.innerHTML = `
            <div style="color:#ef4444; font-weight:600; margin-bottom:6px;">Gagal Memuat Data</div>
            <div>${escapeHtml(err.message || 'Periksa koneksi internet Anda.')}</div>
            <button type="button" class="btn-clean secondary" style="display:inline-flex; width:auto; margin-top:12px; padding:6px 16px;" onclick="fetchKoliInboundData(true)">
              Coba Lagi
            </button>
          `;
        }
      }
    } finally {
      isKoliFetching = false;
      if (refreshBtn) refreshBtn.classList.remove('spinning');
      if (loadingState) loadingState.classList.add('hidden');
    }
  };

  function initKoliSearchInput() {
    const searchInput = document.getElementById('koliSearchInput');
    const clearBtn = document.getElementById('koliSearchClearBtn');
    if (!searchInput) return;

    let searchTimer = null;
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !val);

      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        koliSearchQuery = val.trim();
        koliDisplayLimit = 100;
        renderKoliTable();
      }, 120);
    });
  }

  function initKoliScrollLoader() {
    const wrapper = document.querySelector('.koli-table-wrapper');
    if (!wrapper) return;
    wrapper.addEventListener('scroll', () => {
      if (wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 160) {
        if (koliDisplayLimit < koliFilteredRows.length) {
          koliDisplayLimit += 100;
          renderKoliTable(true);
        }
      }
    }, { passive: true });
  }

  // ══════════════════════════════════════════════════════════════════
  //  📦 PINJAMAN & PENGEMBALIAN BARANG MTG MODULE
  // ══════════════════════════════════════════════════════════════════

  let currentPinjamanTab = 'pinjam';
  let kembaliPhotoBase64 = '';
  let pinjeminPhotoBase64 = '';
  let terimaPhotoBase64 = '';
  let pinjamanHistoryData = [];
  let pinjamanHistoryFilter = 'all';
  let stockUpdateCacheMap = new Map();
  let isStockUpdateFetching = false;
  let pinjamanAutocompleteTimer = null;
  const PINJAMAN_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbygTPu8soPeO8j0l88UMUcBQrSi7WFCjSe-G2PJV5vg_JLsEim1q2mHuaV9nT6GSQj3sw/exec';

  // ── 1. Fetch & Cache Data dari Sheet 'STOCK UPDATE' ──
  async function fetchStockUpdateSheet() {
    if (isStockUpdateFetching || stockUpdateCacheMap.size > 0) return;
    isStockUpdateFetching = true;
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('STOCK UPDATE')}&tq=${encodeURIComponent('SELECT C, D, F, I WHERE C IS NOT NULL')}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const csvText = await res.text();
      const rows = parseCSV(csvText);
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const sku = String(row[0] || '').trim();
        const productName = String(row[1] || '').trim();
        const sloc = String(row[2] || '').trim();
        const qty = String(row[3] || '0').trim();
        if (sku) {
          stockUpdateCacheMap.set(sku.toLowerCase(), { sku, sloc, productName, qty });
          stockUpdateCacheMap.set(sku, { sku, sloc, productName, qty });
        }
      }
    } catch (e) {
      console.warn('Notice: Background STOCK UPDATE fetch:', e);
    } finally {
      isStockUpdateFetching = false;
    }
  }

  // ── 2. SKU Lookup Engine (O(1) Memory First, fallback to Stock Update & MSLTC) ──
  function lookupSkuDetails(rawSku) {
    if (!rawSku) return null;
    const clean = String(rawSku).trim();
    if (!clean) return null;
    const cleanLower = clean.toLowerCase();

    // 1. Cek di Stock Update Cache jika sudah terisi
    if (stockUpdateCacheMap.has(clean)) {
      return stockUpdateCacheMap.get(clean);
    }
    if (stockUpdateCacheMap.has(cleanLower)) {
      return stockUpdateCacheMap.get(cleanLower);
    }

    // 2. Cek di dataMap (Master Rack & Stock dari RACK UPDATE)
    if (dataMap && dataMap.has(clean)) {
      const list = dataMap.get(clean);
      if (list && list.length > 0) {
        const it = list[0];
        return {
          sku: clean,
          productName: it.productName || '',
          sloc: it.sloc || it.masterSloc || '',
          qty: it.qty || '0'
        };
      }
    }
    if (dataMap) {
      for (const [k, list] of dataMap.entries()) {
        if (k.toLowerCase() === cleanLower && list && list.length > 0) {
          const it = list[0];
          return {
            sku: k,
            productName: it.productName || '',
            sloc: it.sloc || it.masterSloc || '',
            qty: it.qty || '0'
          };
        }
      }
    }

    // 3. Cek di MSLTC Map
    if (msltcMap && msltcMap.has(clean)) {
      const mList = msltcMap.get(clean);
      if (mList && mList.length > 0) {
        const it = mList[0];
        return {
          sku: clean,
          productName: it.productName || '',
          sloc: it.rackName || '',
          qty: '0'
        };
      }
    }

    return null;
  }

  // ── 3. Search SKU & Produk untuk Autocomplete Dropdown ──
  function searchSkuCandidates(query, limit = 8) {
    const q = (query || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];

    const results = [];
    const seen = new Set();

    // Prioritaskan cek di dataMap
    if (dataMap) {
      for (const [sku, items] of dataMap.entries()) {
        if (!items || items.length === 0) continue;
        const it = items[0];
        const pName = (it.productName || '').toLowerCase();
        const sLower = sku.toLowerCase();
        const slocLower = (it.sloc || it.masterSloc || '').toLowerCase();

        if (sLower.includes(q) || pName.includes(q) || slocLower.includes(q)) {
          if (!seen.has(sku)) {
            seen.add(sku);
            results.push({
              sku: sku,
              productName: it.productName || 'Tanpa Nama',
              sloc: it.sloc || it.masterSloc || 'Belum Ada Rak',
              qty: it.qty || '0'
            });
            if (results.length >= limit) return results;
          }
        }
      }
    }

    // Cek di stockUpdateCacheMap jika belum cukup
    if (results.length < limit && stockUpdateCacheMap.size > 0) {
      for (const [, item] of stockUpdateCacheMap.entries()) {
        const sLower = item.sku.toLowerCase();
        const pName = item.productName.toLowerCase();
        if (sLower.includes(q) || pName.includes(q)) {
          if (!seen.has(item.sku)) {
            seen.add(item.sku);
            results.push(item);
            if (results.length >= limit) return results;
          }
        }
      }
    }

    return results;
  }

  // ── 4. Inisialisasi Modul Pinjaman ──
  window.initPinjamanModule = function () {
    // Muat data stock update di background jika belum
    fetchStockUpdateSheet();

    // Restore PIC peminjam & pengembalian terakhir
    const lastPicPinjam = localStorage.getItem('SUPERAPP_LAST_PIC_PINJAM') || '';
    const lastPicKembali = localStorage.getItem('SUPERAPP_LAST_PIC_KEMBALI') || '';
    const lastPicPinjemin = localStorage.getItem('SUPERAPP_LAST_PIC_PINJEMIN') || '';
    const lastPicTerima = localStorage.getItem('SUPERAPP_LAST_PIC_TERIMA') || '';

    const picPinjamInput = document.getElementById('pinjamPicInput');
    if (picPinjamInput && !picPinjamInput.value && lastPicPinjam) {
      picPinjamInput.value = lastPicPinjam;
    }

    const picKembaliInput = document.getElementById('kembaliPicInput');
    if (picKembaliInput && !picKembaliInput.value && lastPicKembali) {
      picKembaliInput.value = lastPicKembali;
    }

    const picPinjeminInput = document.getElementById('pinjeminPicInput');
    if (picPinjeminInput && !picPinjeminInput.value && (lastPicPinjemin || lastPicPinjam)) {
      picPinjeminInput.value = lastPicPinjemin || lastPicPinjam;
    }

    const picTerimaInput = document.getElementById('terimaPicInput');
    if (picTerimaInput && !picTerimaInput.value && (lastPicTerima || lastPicKembali)) {
      picTerimaInput.value = lastPicTerima || lastPicKembali;
    }

    // Pasang input listeners untuk autocomplete 4 form
    initPinjamSkuAutocomplete();
    initKembaliSkuAutocomplete();
    initPinjeminSkuAutocomplete();
    initTerimaSkuAutocomplete();

    // Default ke tab pinjam
    switchPinjamanTab(currentPinjamanTab || 'pinjam');
  };

  // ── 5. Tab Switcher (5 Flows) ──
  window.switchPinjamanTab = function (tabName) {
    currentPinjamanTab = tabName;

    const btnPinjam = document.getElementById('tabPinjamBtn');
    const btnKembali = document.getElementById('tabKembaliBtn');
    const btnPinjemin = document.getElementById('tabPinjeminBtn');
    const btnTerima = document.getElementById('tabTerimaBtn');
    const btnHistory = document.getElementById('tabHistoryBtn');

    const panelPinjam = document.getElementById('tabContentPinjam');
    const panelKembali = document.getElementById('tabContentKembali');
    const panelPinjemin = document.getElementById('tabContentPinjemin');
    const panelTerima = document.getElementById('tabContentTerima');
    const panelHistory = document.getElementById('tabContentHistory');

    [btnPinjam, btnKembali, btnPinjemin, btnTerima, btnHistory].forEach(b => b && b.classList.remove('active'));
    [panelPinjam, panelKembali, panelPinjemin, panelTerima, panelHistory].forEach(p => p && p.classList.add('hidden'));

    if (tabName === 'pinjam') {
      if (btnPinjam) btnPinjam.classList.add('active');
      if (panelPinjam) panelPinjam.classList.remove('hidden');
    } else if (tabName === 'kembali') {
      if (btnKembali) btnKembali.classList.add('active');
      if (panelKembali) panelKembali.classList.remove('hidden');
    } else if (tabName === 'pinjemin') {
      if (btnPinjemin) btnPinjemin.classList.add('active');
      if (panelPinjemin) panelPinjemin.classList.remove('hidden');
    } else if (tabName === 'terima') {
      if (btnTerima) btnTerima.classList.add('active');
      if (panelTerima) panelTerima.classList.remove('hidden');
    } else if (tabName === 'history') {
      if (btnHistory) btnHistory.classList.add('active');
      if (panelHistory) panelHistory.classList.remove('hidden');
      fetchPinjamanHistory();
    }
  };

  // ── 6. Setup Autocomplete untuk Form Peminjaman ──
  function initPinjamSkuAutocomplete() {
    const input = document.getElementById('pinjamSkuInput');
    const dropdown = document.getElementById('pinjamSkuDropdown');
    const clearBtn = document.getElementById('pinjamClearSkuBtn');
    if (!input || !dropdown) return;

    input.oninput = function () {
      const val = input.value.trim();
      if (clearBtn) clearBtn.classList.toggle('hidden', !val);

      clearTimeout(pinjamanAutocompleteTimer);
      if (val.length < 2) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
      }

      pinjamanAutocompleteTimer = setTimeout(() => {
        const matches = searchSkuCandidates(val);
        if (matches.length === 0) {
          dropdown.classList.add('hidden');
          dropdown.innerHTML = '';
          return;
        }

        dropdown.innerHTML = matches.map(m => `
          <div class="pinjaman-autocomplete-item" onclick="selectPinjamSkuCandidate('${encodeURIComponent(JSON.stringify(m))}')">
            <div class="pinjaman-ac-name">${escapeHtml(m.productName)}</div>
            <div class="pinjaman-ac-meta">
              <span>SKU: ${escapeHtml(m.sku)}</span>
              <span>•</span>
              <span>📍 SLOC: ${escapeHtml(m.sloc)}</span>
            </div>
          </div>
        `).join('');
        dropdown.classList.remove('hidden');
      }, 140);
    };

    input.onchange = function () {
      applyPinjamSku(input.value.trim());
    };

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }

  window.selectPinjamSkuCandidate = function (encodedItem) {
    try {
      const item = JSON.parse(decodeURIComponent(encodedItem));
      const input = document.getElementById('pinjamSkuInput');
      const dropdown = document.getElementById('pinjamSkuDropdown');
      if (input) input.value = item.sku;
      if (dropdown) dropdown.classList.add('hidden');
      applyPinjamSku(item.sku, item);
    } catch (e) {
      console.warn('selectPinjamSkuCandidate error:', e);
    }
  };

  function applyPinjamSku(sku, preloadedItem = null) {
    if (!sku) return;
    const item = preloadedItem || lookupSkuDetails(sku);
    const clearBtn = document.getElementById('pinjamClearSkuBtn');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const nameInput = document.getElementById('pinjamNamaProdukInput');
    const previewBox = document.getElementById('pinjamProductPreview');
    const previewName = document.getElementById('pinjamPreviewName');
    const previewSku = document.getElementById('pinjamPreviewSku');
    const previewSloc = document.getElementById('pinjamPreviewSloc');
    const previewStock = document.getElementById('pinjamPreviewStock');

    if (item) {
      if (nameInput) nameInput.value = item.productName || '';
      if (previewBox) previewBox.classList.remove('hidden');
      if (previewName) previewName.textContent = item.productName || '-';
      if (previewSku) previewSku.textContent = item.sku || sku;
      if (previewSloc) previewSloc.textContent = item.sloc || 'Belum Ada Rak';
      if (previewStock) previewStock.textContent = item.qty || '0';
    } else {
      if (previewBox) previewBox.classList.add('hidden');
    }
  }

  window.clearPinjamSku = function () {
    const input = document.getElementById('pinjamSkuInput');
    const nameInput = document.getElementById('pinjamNamaProdukInput');
    const previewBox = document.getElementById('pinjamProductPreview');
    const clearBtn = document.getElementById('pinjamClearSkuBtn');
    const dropdown = document.getElementById('pinjamSkuDropdown');

    if (input) input.value = '';
    if (nameInput) nameInput.value = '';
    if (previewBox) previewBox.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.focus();
  };

  window.openPinjamScanner = function () {
    if (typeof openUniversalScanner === 'function') {
      openUniversalScanner((decodedText) => {
        const sku = String(decodedText || '').trim();
        const input = document.getElementById('pinjamSkuInput');
        if (input) {
          input.value = sku;
          applyPinjamSku(sku);
        }
      });
    }
  };

  window.stepPinjamQty = function (delta) {
    const qtyInput = document.getElementById('pinjamQtyInput');
    if (!qtyInput) return;
    const current = parseInt(qtyInput.value, 10) || 1;
    qtyInput.value = Math.max(1, current + delta);
  };

  window.handlePinjamHubChange = function (val) {
    const customContainer = document.getElementById('pinjamCustomHubContainer');
    const customInput = document.getElementById('pinjamCustomHubInput');
    if (val === 'custom') {
      if (customContainer) customContainer.classList.remove('hidden');
      if (customInput) customInput.focus();
    } else {
      if (customContainer) customContainer.classList.add('hidden');
      if (customInput) customInput.value = '';
    }
  };

  // ── 7. Setup Autocomplete untuk Form Pengembalian ──
  function initKembaliSkuAutocomplete() {
    const input = document.getElementById('kembaliSkuInput');
    const dropdown = document.getElementById('kembaliSkuDropdown');
    const clearBtn = document.getElementById('kembaliClearSkuBtn');
    if (!input || !dropdown) return;

    input.oninput = function () {
      const val = input.value.trim();
      if (clearBtn) clearBtn.classList.toggle('hidden', !val);

      clearTimeout(pinjamanAutocompleteTimer);
      if (val.length < 2) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
      }

      pinjamanAutocompleteTimer = setTimeout(() => {
        const matches = searchSkuCandidates(val);
        if (matches.length === 0) {
          dropdown.classList.add('hidden');
          dropdown.innerHTML = '';
          return;
        }

        dropdown.innerHTML = matches.map(m => `
          <div class="pinjaman-autocomplete-item" onclick="selectKembaliSkuCandidate('${encodeURIComponent(JSON.stringify(m))}')">
            <div class="pinjaman-ac-name">${escapeHtml(m.productName)}</div>
            <div class="pinjaman-ac-meta">
              <span>SKU: ${escapeHtml(m.sku)}</span>
              <span>•</span>
              <span>📍 SLOC: ${escapeHtml(m.sloc)}</span>
            </div>
          </div>
        `).join('');
        dropdown.classList.remove('hidden');
      }, 140);
    };

    input.onchange = function () {
      applyKembaliSku(input.value.trim());
    };

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }

  window.selectKembaliSkuCandidate = function (encodedItem) {
    try {
      const item = JSON.parse(decodeURIComponent(encodedItem));
      const input = document.getElementById('kembaliSkuInput');
      const dropdown = document.getElementById('kembaliSkuDropdown');
      if (input) input.value = item.sku;
      if (dropdown) dropdown.classList.add('hidden');
      applyKembaliSku(item.sku, item);
    } catch (e) {
      console.warn('selectKembaliSkuCandidate error:', e);
    }
  };

  function applyKembaliSku(sku, preloadedItem = null) {
    if (!sku) return;
    const item = preloadedItem || lookupSkuDetails(sku);
    const clearBtn = document.getElementById('kembaliClearSkuBtn');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const nameInput = document.getElementById('kembaliNamaProdukInput');
    const slocInput = document.getElementById('kembaliSlocInput');
    const previewBox = document.getElementById('kembaliProductPreview');
    const previewName = document.getElementById('kembaliPreviewName');
    const previewSku = document.getElementById('kembaliPreviewSku');
    const previewSloc = document.getElementById('kembaliPreviewSloc');
    const previewStock = document.getElementById('kembaliPreviewStock');

    if (item) {
      if (nameInput) nameInput.value = item.productName || '';
      if (slocInput) slocInput.value = item.sloc || '';
      if (previewBox) previewBox.classList.remove('hidden');
      if (previewName) previewName.textContent = item.productName || '-';
      if (previewSku) previewSku.textContent = item.sku || sku;
      if (previewSloc) previewSloc.textContent = item.sloc || 'Belum Ada Rak';
      if (previewStock) previewStock.textContent = item.qty || '0';
    } else {
      if (previewBox) previewBox.classList.add('hidden');
    }
  }

  window.clearKembaliSku = function () {
    const input = document.getElementById('kembaliSkuInput');
    const nameInput = document.getElementById('kembaliNamaProdukInput');
    const slocInput = document.getElementById('kembaliSlocInput');
    const previewBox = document.getElementById('kembaliProductPreview');
    const clearBtn = document.getElementById('kembaliClearSkuBtn');
    const dropdown = document.getElementById('kembaliSkuDropdown');

    if (input) input.value = '';
    if (nameInput) nameInput.value = '';
    if (slocInput) slocInput.value = '';
    if (previewBox) previewBox.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.focus();
  };

  window.openKembaliScanner = function () {
    if (typeof openUniversalScanner === 'function') {
      openUniversalScanner((decodedText) => {
        const sku = String(decodedText || '').trim();
        const input = document.getElementById('kembaliSkuInput');
        if (input) {
          input.value = sku;
          applyKembaliSku(sku);
        }
      });
    }
  };

  window.stepKembaliQty = function (delta) {
    const qtyInput = document.getElementById('kembaliQtyInput');
    if (!qtyInput) return;
    const current = parseInt(qtyInput.value, 10) || 1;
    qtyInput.value = Math.max(1, current + delta);
  };

  window.handleKembaliHubChange = function (val) {
    const customContainer = document.getElementById('kembaliCustomHubContainer');
    const customInput = document.getElementById('kembaliCustomHubInput');
    if (val === 'custom') {
      if (customContainer) customContainer.classList.remove('hidden');
      if (customInput) customInput.focus();
    } else {
      if (customContainer) customContainer.classList.add('hidden');
      if (customInput) customInput.value = '';
    }
  };

  // ── 8. Upload Foto Produk Pengembalian (Kamera & Galeri) ──
  window.triggerKembaliCamera = function () {
    const input = document.getElementById('kembaliPhotoCameraInput');
    if (input) input.click();
  };

  window.triggerKembaliGallery = function () {
    const input = document.getElementById('kembaliPhotoGalleryInput');
    if (input) input.click();
  };

  window.handleKembaliPhotoSelected = function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const MAX_DIM = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_DIM) {
            height *= MAX_DIM / width;
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width *= MAX_DIM / height;
            height = MAX_DIM;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Kompresi ringan JPEG quality 0.70 (~35-50KB)
        kembaliPhotoBase64 = canvas.toDataURL('image/jpeg', 0.70);
        const approxKb = Math.round((kembaliPhotoBase64.length * 3 / 4) / 1024);

        const dropzone = document.getElementById('kembaliPhotoDropzone');
        const previewWrap = document.getElementById('kembaliPhotoPreviewContainer');
        const previewImg = document.getElementById('kembaliPhotoPreviewImg');
        const metaText = document.getElementById('kembaliPhotoMetaText');

        if (previewImg) previewImg.src = kembaliPhotoBase64;
        if (metaText) metaText.textContent = `✅ Foto siap upload (${approxKb} KB)`;
        if (dropzone) dropzone.classList.add('hidden');
        if (previewWrap) previewWrap.classList.remove('hidden');

        if (typeof playSuccessBeep === 'function') playSuccessBeep();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.removeKembaliPhoto = function () {
    kembaliPhotoBase64 = '';
    const camInput = document.getElementById('kembaliPhotoCameraInput');
    const galInput = document.getElementById('kembaliPhotoGalleryInput');
    if (camInput) camInput.value = '';
    if (galInput) galInput.value = '';

    const dropzone = document.getElementById('kembaliPhotoDropzone');
    const previewWrap = document.getElementById('kembaliPhotoPreviewContainer');
    const previewImg = document.getElementById('kembaliPhotoPreviewImg');

    if (previewImg) previewImg.src = '';
    if (previewWrap) previewWrap.classList.add('hidden');
    if (dropzone) dropzone.classList.remove('hidden');
  };

  // ── 8B. Setup Autocomplete & Helper Form MTG Pinjemin ke Hub Lain ──
  function initPinjeminSkuAutocomplete() {
    const input = document.getElementById('pinjeminSkuInput');
    const dropdown = document.getElementById('pinjeminSkuDropdown');
    const clearBtn = document.getElementById('pinjeminClearSkuBtn');
    if (!input || !dropdown) return;

    input.oninput = function () {
      const val = input.value.trim();
      if (clearBtn) clearBtn.classList.toggle('hidden', !val);

      clearTimeout(pinjamanAutocompleteTimer);
      if (val.length < 2) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
      }

      pinjamanAutocompleteTimer = setTimeout(() => {
        const matches = searchSkuCandidates(val);
        if (matches.length === 0) {
          dropdown.classList.add('hidden');
          dropdown.innerHTML = '';
          return;
        }

        dropdown.innerHTML = matches.map(m => `
          <div class="pinjaman-autocomplete-item" onclick="selectPinjeminSkuCandidate('${encodeURIComponent(JSON.stringify(m))}')">
            <div class="pinjaman-ac-name">${escapeHtml(m.productName)}</div>
            <div class="pinjaman-ac-meta">
              <span>SKU: ${escapeHtml(m.sku)}</span>
              <span>•</span>
              <span>📍 SLOC: ${escapeHtml(m.sloc)}</span>
            </div>
          </div>
        `).join('');
        dropdown.classList.remove('hidden');
      }, 140);
    };

    input.onchange = function () {
      applyPinjeminSku(input.value.trim());
    };

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }

  window.selectPinjeminSkuCandidate = function (encodedItem) {
    try {
      const item = JSON.parse(decodeURIComponent(encodedItem));
      const input = document.getElementById('pinjeminSkuInput');
      const dropdown = document.getElementById('pinjeminSkuDropdown');
      if (input) input.value = item.sku;
      if (dropdown) dropdown.classList.add('hidden');
      applyPinjeminSku(item.sku, item);
    } catch (e) {
      console.warn('selectPinjeminSkuCandidate error:', e);
    }
  };

  function applyPinjeminSku(sku, preloadedItem = null) {
    if (!sku) return;
    const item = preloadedItem || lookupSkuDetails(sku);
    const clearBtn = document.getElementById('pinjeminClearSkuBtn');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const nameInput = document.getElementById('pinjeminNamaProdukInput');
    const slocInput = document.getElementById('pinjeminSlocInput');
    const previewBox = document.getElementById('pinjeminProductPreview');
    const previewName = document.getElementById('pinjeminPreviewName');
    const previewSku = document.getElementById('pinjeminPreviewSku');
    const previewSloc = document.getElementById('pinjeminPreviewSloc');
    const previewStock = document.getElementById('pinjeminPreviewStock');

    if (item) {
      if (nameInput) nameInput.value = item.productName || '';
      if (slocInput) slocInput.value = item.sloc || '';
      if (previewBox) previewBox.classList.remove('hidden');
      if (previewName) previewName.textContent = item.productName || '-';
      if (previewSku) previewSku.textContent = item.sku || sku;
      if (previewSloc) previewSloc.textContent = item.sloc || 'Belum Ada Rak';
      if (previewStock) previewStock.textContent = item.qty || '0';
    } else {
      if (previewBox) previewBox.classList.add('hidden');
    }
  }

  window.clearPinjeminSku = function () {
    const input = document.getElementById('pinjeminSkuInput');
    const nameInput = document.getElementById('pinjeminNamaProdukInput');
    const slocInput = document.getElementById('pinjeminSlocInput');
    const previewBox = document.getElementById('pinjeminProductPreview');
    const clearBtn = document.getElementById('pinjeminClearSkuBtn');
    const dropdown = document.getElementById('pinjeminSkuDropdown');

    if (input) input.value = '';
    if (nameInput) nameInput.value = '';
    if (slocInput) slocInput.value = '';
    if (previewBox) previewBox.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.focus();
  };

  window.openPinjeminScanner = function () {
    if (typeof openUniversalScanner === 'function') {
      openUniversalScanner((decodedText) => {
        const sku = String(decodedText || '').trim();
        const input = document.getElementById('pinjeminSkuInput');
        if (input) {
          input.value = sku;
          applyPinjeminSku(sku);
        }
      });
    }
  };

  window.stepPinjeminQty = function (delta) {
    const qtyInput = document.getElementById('pinjeminQtyInput');
    if (!qtyInput) return;
    const current = parseInt(qtyInput.value, 10) || 1;
    qtyInput.value = Math.max(1, current + delta);
  };

  window.handlePinjeminHubChange = function (val) {
    const customContainer = document.getElementById('pinjeminCustomHubContainer');
    const customInput = document.getElementById('pinjeminCustomHubInput');
    if (val === 'custom') {
      if (customContainer) customContainer.classList.remove('hidden');
      if (customInput) customInput.focus();
    } else {
      if (customContainer) customContainer.classList.add('hidden');
      if (customInput) customInput.value = '';
    }
  };

  window.triggerPinjeminCamera = function () {
    const input = document.getElementById('pinjeminPhotoCameraInput');
    if (input) input.click();
  };

  window.triggerPinjeminGallery = function () {
    const input = document.getElementById('pinjeminPhotoGalleryInput');
    if (input) input.click();
  };

  window.handlePinjeminPhotoSelected = function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const MAX_DIM = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_DIM) {
            height *= MAX_DIM / width;
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width *= MAX_DIM / height;
            height = MAX_DIM;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        pinjeminPhotoBase64 = canvas.toDataURL('image/jpeg', 0.70);
        const approxKb = Math.round((pinjeminPhotoBase64.length * 3 / 4) / 1024);

        const dropzone = document.getElementById('pinjeminPhotoDropzone');
        const previewWrap = document.getElementById('pinjeminPhotoPreviewContainer');
        const previewImg = document.getElementById('pinjeminPhotoPreviewImg');
        const metaText = document.getElementById('pinjeminPhotoMetaText');

        if (previewImg) previewImg.src = pinjeminPhotoBase64;
        if (metaText) metaText.textContent = `✅ Foto bukti siap (${approxKb} KB)`;
        if (dropzone) dropzone.classList.add('hidden');
        if (previewWrap) previewWrap.classList.remove('hidden');

        if (typeof playSuccessBeep === 'function') playSuccessBeep();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.removePinjeminPhoto = function () {
    pinjeminPhotoBase64 = '';
    const camInput = document.getElementById('pinjeminPhotoCameraInput');
    const galInput = document.getElementById('pinjeminPhotoGalleryInput');
    if (camInput) camInput.value = '';
    if (galInput) galInput.value = '';

    const dropzone = document.getElementById('pinjeminPhotoDropzone');
    const previewWrap = document.getElementById('pinjeminPhotoPreviewContainer');
    const previewImg = document.getElementById('pinjeminPhotoPreviewImg');

    if (previewImg) previewImg.src = '';
    if (previewWrap) previewWrap.classList.add('hidden');
    if (dropzone) dropzone.classList.remove('hidden');
  };

  // ── 8C. Setup Autocomplete & Helper Form MTG Terima Pengembalian ──
  function initTerimaSkuAutocomplete() {
    const input = document.getElementById('terimaSkuInput');
    const dropdown = document.getElementById('terimaSkuDropdown');
    const clearBtn = document.getElementById('terimaClearSkuBtn');
    if (!input || !dropdown) return;

    input.oninput = function () {
      const val = input.value.trim();
      if (clearBtn) clearBtn.classList.toggle('hidden', !val);

      clearTimeout(pinjamanAutocompleteTimer);
      if (val.length < 2) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
      }

      pinjamanAutocompleteTimer = setTimeout(() => {
        const matches = searchSkuCandidates(val);
        if (matches.length === 0) {
          dropdown.classList.add('hidden');
          dropdown.innerHTML = '';
          return;
        }

        dropdown.innerHTML = matches.map(m => `
          <div class="pinjaman-autocomplete-item" onclick="selectTerimaSkuCandidate('${encodeURIComponent(JSON.stringify(m))}')">
            <div class="pinjaman-ac-name">${escapeHtml(m.productName)}</div>
            <div class="pinjaman-ac-meta">
              <span>SKU: ${escapeHtml(m.sku)}</span>
              <span>•</span>
              <span>📍 SLOC: ${escapeHtml(m.sloc)}</span>
            </div>
          </div>
        `).join('');
        dropdown.classList.remove('hidden');
      }, 140);
    };

    input.onchange = function () {
      applyTerimaSku(input.value.trim());
    };

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }

  window.selectTerimaSkuCandidate = function (encodedItem) {
    try {
      const item = JSON.parse(decodeURIComponent(encodedItem));
      const input = document.getElementById('terimaSkuInput');
      const dropdown = document.getElementById('terimaSkuDropdown');
      if (input) input.value = item.sku;
      if (dropdown) dropdown.classList.add('hidden');
      applyTerimaSku(item.sku, item);
    } catch (e) {
      console.warn('selectTerimaSkuCandidate error:', e);
    }
  };

  function applyTerimaSku(sku, preloadedItem = null) {
    if (!sku) return;
    const item = preloadedItem || lookupSkuDetails(sku);
    const clearBtn = document.getElementById('terimaClearSkuBtn');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const nameInput = document.getElementById('terimaNamaProdukInput');
    const slocInput = document.getElementById('terimaSlocInput');
    const previewBox = document.getElementById('terimaProductPreview');
    const previewName = document.getElementById('terimaPreviewName');
    const previewSku = document.getElementById('terimaPreviewSku');
    const previewSloc = document.getElementById('terimaPreviewSloc');
    const previewStock = document.getElementById('terimaPreviewStock');

    if (item) {
      if (nameInput) nameInput.value = item.productName || '';
      if (slocInput) slocInput.value = item.sloc || '';
      if (previewBox) previewBox.classList.remove('hidden');
      if (previewName) previewName.textContent = item.productName || '-';
      if (previewSku) previewSku.textContent = item.sku || sku;
      if (previewSloc) previewSloc.textContent = item.sloc || 'Belum Ada Rak';
      if (previewStock) previewStock.textContent = item.qty || '0';
    } else {
      if (previewBox) previewBox.classList.add('hidden');
    }
  }

  window.clearTerimaSku = function () {
    const input = document.getElementById('terimaSkuInput');
    const nameInput = document.getElementById('terimaNamaProdukInput');
    const slocInput = document.getElementById('terimaSlocInput');
    const previewBox = document.getElementById('terimaProductPreview');
    const clearBtn = document.getElementById('terimaClearSkuBtn');
    const dropdown = document.getElementById('terimaSkuDropdown');

    if (input) input.value = '';
    if (nameInput) nameInput.value = '';
    if (slocInput) slocInput.value = '';
    if (previewBox) previewBox.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.focus();
  };

  window.openTerimaScanner = function () {
    if (typeof openUniversalScanner === 'function') {
      openUniversalScanner((decodedText) => {
        const sku = String(decodedText || '').trim();
        const input = document.getElementById('terimaSkuInput');
        if (input) {
          input.value = sku;
          applyTerimaSku(sku);
        }
      });
    }
  };

  window.stepTerimaQty = function (delta) {
    const qtyInput = document.getElementById('terimaQtyInput');
    if (!qtyInput) return;
    const current = parseInt(qtyInput.value, 10) || 1;
    qtyInput.value = Math.max(1, current + delta);
  };

  window.handleTerimaHubChange = function (val) {
    const customContainer = document.getElementById('terimaCustomHubContainer');
    const customInput = document.getElementById('terimaCustomHubInput');
    if (val === 'custom') {
      if (customContainer) customContainer.classList.remove('hidden');
      if (customInput) customInput.focus();
    } else {
      if (customContainer) customContainer.classList.add('hidden');
      if (customInput) customInput.value = '';
    }
  };

  window.triggerTerimaCamera = function () {
    const input = document.getElementById('terimaPhotoCameraInput');
    if (input) input.click();
  };

  window.triggerTerimaGallery = function () {
    const input = document.getElementById('terimaPhotoGalleryInput');
    if (input) input.click();
  };

  window.handleTerimaPhotoSelected = function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const MAX_DIM = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_DIM) {
            height *= MAX_DIM / width;
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width *= MAX_DIM / height;
            height = MAX_DIM;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        terimaPhotoBase64 = canvas.toDataURL('image/jpeg', 0.70);
        const approxKb = Math.round((terimaPhotoBase64.length * 3 / 4) / 1024);

        const dropzone = document.getElementById('terimaPhotoDropzone');
        const previewWrap = document.getElementById('terimaPhotoPreviewContainer');
        const previewImg = document.getElementById('terimaPhotoPreviewImg');
        const metaText = document.getElementById('terimaPhotoMetaText');

        if (previewImg) previewImg.src = terimaPhotoBase64;
        if (metaText) metaText.textContent = `✅ Foto barang siap (${approxKb} KB)`;
        if (dropzone) dropzone.classList.add('hidden');
        if (previewWrap) previewWrap.classList.remove('hidden');

        if (typeof playSuccessBeep === 'function') playSuccessBeep();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.removeTerimaPhoto = function () {
    terimaPhotoBase64 = '';
    const camInput = document.getElementById('terimaPhotoCameraInput');
    const galInput = document.getElementById('terimaPhotoGalleryInput');
    if (camInput) camInput.value = '';
    if (galInput) galInput.value = '';

    const dropzone = document.getElementById('terimaPhotoDropzone');
    const previewWrap = document.getElementById('terimaPhotoPreviewContainer');
    const previewImg = document.getElementById('terimaPhotoPreviewImg');

    if (previewImg) previewImg.src = '';
    if (previewWrap) previewWrap.classList.add('hidden');
    if (dropzone) dropzone.classList.remove('hidden');
  };

  // ── 9. Submit Form Peminjaman ──
  window.submitFormPinjam = async function (e) {
    if (e && e.preventDefault) e.preventDefault();

    const skuInput = document.getElementById('pinjamSkuInput');
    const nameInput = document.getElementById('pinjamNamaProdukInput');
    const qtyInput = document.getElementById('pinjamQtyInput');
    const hubSelect = document.getElementById('pinjamHubSelect');
    const customHubInput = document.getElementById('pinjamCustomHubInput');
    const picInput = document.getElementById('pinjamPicInput');
    const remarksInput = document.getElementById('pinjamRemarksInput');
    const submitBtn = document.getElementById('btnSubmitPinjam');

    const sku = (skuInput ? skuInput.value : '').trim();
    const productName = (nameInput ? nameInput.value : '').trim();
    const qty = parseInt(qtyInput ? qtyInput.value : '1', 10) || 1;
    let hub = (hubSelect ? hubSelect.value : '').trim();
    if (hub === 'custom') {
      hub = (customHubInput ? customHubInput.value : '').trim();
    }
    const pic = (picInput ? picInput.value : '').trim();
    const remarks = (remarksInput ? remarksInput.value : '').trim();

    // Validasi
    if (!sku) {
      alert('Silakan masukkan Nomor SKU Produk.');
      if (skuInput) skuInput.focus();
      return;
    }
    if (!productName) {
      alert('Silakan masukkan Nama Produk.');
      if (nameInput) nameInput.focus();
      return;
    }
    if (qty < 1) {
      alert('Jumlah QTY minimal 1.');
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!hub) {
      alert('Silakan pilih atau ketik HUB tujuan peminjaman.');
      if (hubSelect) hubSelect.focus();
      return;
    }
    if (!pic) {
      alert('Silakan masukkan nama PIC Peminjam.');
      if (picInput) picInput.focus();
      return;
    }

    const payload = {
      action: 'savePinjamanBarang',
      module: 'pinjaman',
      formType: 'pinjam',
      sku: sku,
      productName: productName,
      qty: qty,
      hub: hub,
      pic: pic,
      remarks: remarks,
      status: 'DIPINJAM'
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Menyimpan Peminjaman...</span>';
    }

    try {
      await fetch(PINJAMAN_WEBAPP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      // Simpan PIC ke localStorage
      localStorage.setItem('SUPERAPP_LAST_PIC_PINJAM', pic);

      // Audio & Feedback
      if (typeof playSaveSuccessChime === 'function') playSaveSuccessChime();
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) {}
      if (typeof showDccToast === 'function') {
        showDccToast('success', 'Peminjaman Berhasil!', `SKU ${sku} (${productName}) QTY ${qty} ke ${hub} tercatat.`);
      } else {
        alert(`✅ Peminjaman Berhasil!\n\nSKU: ${sku}\nProduk: ${productName}\nQTY: ${qty}\nHUB: ${hub}\nPIC: ${pic}`);
      }

      // Reset form (pertahankan PIC)
      if (skuInput) skuInput.value = '';
      if (nameInput) nameInput.value = '';
      if (qtyInput) qtyInput.value = '1';
      if (hubSelect) hubSelect.value = '';
      if (customHubInput) customHubInput.value = '';
      document.getElementById('pinjamCustomHubContainer')?.classList.add('hidden');
      if (remarksInput) remarksInput.value = '';
      document.getElementById('pinjamProductPreview')?.classList.add('hidden');
      document.getElementById('pinjamClearSkuBtn')?.classList.add('hidden');

    } catch (err) {
      console.error('Gagal simpan pinjaman:', err);
      alert('Gagal mengirim data. Silakan periksa koneksi internet Anda.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          <span>Submit Peminjaman</span>
        `;
      }
    }
  };

  // ── 10. Submit Form Pengembalian ──
  window.submitFormKembali = async function (e) {
    if (e && e.preventDefault) e.preventDefault();

    const skuInput = document.getElementById('kembaliSkuInput');
    const nameInput = document.getElementById('kembaliNamaProdukInput');
    const slocInput = document.getElementById('kembaliSlocInput');
    const qtyInput = document.getElementById('kembaliQtyInput');
    const hubSelect = document.getElementById('kembaliHubSelect');
    const customHubInput = document.getElementById('kembaliCustomHubInput');
    const picInput = document.getElementById('kembaliPicInput');
    const remarksInput = document.getElementById('kembaliRemarksInput');
    const submitBtn = document.getElementById('btnSubmitKembali');

    const sku = (skuInput ? skuInput.value : '').trim();
    const productName = (nameInput ? nameInput.value : '').trim();
    const sloc = (slocInput ? slocInput.value : '').trim();
    const qty = parseInt(qtyInput ? qtyInput.value : '1', 10) || 1;
    let hub = (hubSelect ? hubSelect.value : '').trim();
    if (hub === 'custom') {
      hub = (customHubInput ? customHubInput.value : '').trim();
    }
    const pic = (picInput ? picInput.value : '').trim();
    const remarks = (remarksInput ? remarksInput.value : '').trim();

    // Validasi
    if (!sku) {
      alert('Silakan masukkan Nomor SKU Produk yang dikembalikan.');
      if (skuInput) skuInput.focus();
      return;
    }
    if (!productName) {
      alert('Silakan masukkan Nama Produk.');
      if (nameInput) nameInput.focus();
      return;
    }
    if (!sloc) {
      alert('Silakan masukkan SLOC (Lokasi Rak) produk.');
      if (slocInput) slocInput.focus();
      return;
    }
    if (qty < 1) {
      alert('Jumlah QTY minimal 1.');
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!kembaliPhotoBase64) {
      alert('Wajib upload foto produk yang dikembalikan (via Kamera atau Galeri).');
      return;
    }
    if (!pic) {
      alert('Silakan masukkan nama PIC Pengembalian.');
      if (picInput) picInput.focus();
      return;
    }
    if (!hub) {
      alert('Silakan pilih atau ketik HUB asal pengembalian barang.');
      if (hubSelect) hubSelect.focus();
      return;
    }

    const payload = {
      action: 'savePengembalianBarang',
      module: 'pinjaman',
      formType: 'pengembalian',
      sku: sku,
      productName: productName,
      sloc: sloc,
      qty: qty,
      hub: hub,
      pic: pic,
      remarks: remarks,
      imageBase64: kembaliPhotoBase64,
      status: 'DIKEMBALIKAN'
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Menyimpan Pengembalian & Foto...</span>';
    }

    try {
      await fetch(PINJAMAN_WEBAPP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      // Simpan PIC ke localStorage
      localStorage.setItem('SUPERAPP_LAST_PIC_KEMBALI', pic);

      // Feedback
      if (typeof playSaveSuccessChime === 'function') playSaveSuccessChime();
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) {}
      if (typeof showDccToast === 'function') {
        showDccToast('success', 'Pengembalian Berhasil!', `SKU ${sku} (${productName}) QTY ${qty} dikembalikan ke ${hub}.`);
      } else {
        alert(`✅ Pengembalian Berhasil!\n\nSKU: ${sku}\nProduk: ${productName}\nSLOC: ${sloc}\nQTY: ${qty}\nHUB: ${hub}\nPIC: ${pic}`);
      }

      // Reset Form & Foto
      if (skuInput) skuInput.value = '';
      if (nameInput) nameInput.value = '';
      if (slocInput) slocInput.value = '';
      if (qtyInput) qtyInput.value = '1';
      if (hubSelect) hubSelect.value = '';
      if (customHubInput) customHubInput.value = '';
      document.getElementById('kembaliCustomHubContainer')?.classList.add('hidden');
      if (remarksInput) remarksInput.value = '';
      document.getElementById('kembaliProductPreview')?.classList.add('hidden');
      document.getElementById('kembaliClearSkuBtn')?.classList.add('hidden');
      removeKembaliPhoto();

    } catch (err) {
      console.error('Gagal simpan pengembalian:', err);
      alert('Gagal mengirim data pengembalian. Silakan periksa koneksi internet Anda.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Submit Pengembalian</span>
        `;
      }
    }
  };

  // ── 10B. Submit Form MTG Pinjemin ke Hub Lain ──
  window.submitFormPinjemin = async function (e) {
    if (e && e.preventDefault) e.preventDefault();

    const skuInput = document.getElementById('pinjeminSkuInput');
    const nameInput = document.getElementById('pinjeminNamaProdukInput');
    const slocInput = document.getElementById('pinjeminSlocInput');
    const qtyInput = document.getElementById('pinjeminQtyInput');
    const hubSelect = document.getElementById('pinjeminHubSelect');
    const customHubInput = document.getElementById('pinjeminCustomHubInput');
    const picInput = document.getElementById('pinjeminPicInput');
    const driverInput = document.getElementById('pinjeminDriverInput');
    const remarksInput = document.getElementById('pinjeminRemarksInput');
    const submitBtn = document.getElementById('btnSubmitPinjemin');

    const sku = (skuInput ? skuInput.value : '').trim();
    const productName = (nameInput ? nameInput.value : '').trim();
    const sloc = (slocInput ? slocInput.value : '').trim();
    const qty = parseInt(qtyInput ? qtyInput.value : '1', 10) || 1;
    let hub = (hubSelect ? hubSelect.value : '').trim();
    if (hub === 'custom') {
      hub = (customHubInput ? customHubInput.value : '').trim();
    }
    const pic = (picInput ? picInput.value : '').trim();
    const picHub = (driverInput ? driverInput.value : '').trim();
    const remarks = (remarksInput ? remarksInput.value : '').trim();

    if (!sku) {
      alert('Silakan masukkan Nomor SKU Produk.');
      if (skuInput) skuInput.focus();
      return;
    }
    if (!productName) {
      alert('Silakan masukkan Nama Produk.');
      if (nameInput) nameInput.focus();
      return;
    }
    if (!sloc) {
      alert('Silakan tentukan SLOC (Lokasi Rak) asal barang.');
      if (slocInput) slocInput.focus();
      return;
    }
    if (qty < 1) {
      alert('Jumlah QTY minimal 1.');
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!hub) {
      alert('Silakan pilih atau ketik HUB peminjam.');
      if (hubSelect) hubSelect.focus();
      return;
    }
    if (!pic) {
      alert('Silakan masukkan nama PIC Petugas MTG yang meminjamkan.');
      if (picInput) picInput.focus();
      return;
    }

    const payload = {
      action: 'savePinjeminKeHub',
      module: 'pinjaman',
      formType: 'pinjemin',
      type: 'pinjemin',
      sku: sku,
      productName: productName,
      sloc: sloc,
      qty: qty,
      hub: hub,
      pic: pic,
      picHub: picHub,
      imageBase64: pinjeminPhotoBase64,
      remarks: remarks,
      status: 'DIPINJAMKAN'
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Menyimpan Pinjaman Keluar...</span>';
    }

    try {
      await fetch(PINJAMAN_WEBAPP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      localStorage.setItem('SUPERAPP_LAST_PIC_PINJEMIN', pic);

      if (typeof playSaveSuccessChime === 'function') playSaveSuccessChime();
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) {}
      if (typeof showDccToast === 'function') {
        showDccToast('success', 'Pinjaman Keluar Berhasil!', `SKU ${sku} (${productName}) QTY ${qty} dipinjamkan ke ${hub}.`);
      } else {
        alert(`✅ MTG Pinjemin Berhasil!\n\nSKU: ${sku}\nProduk: ${productName}\nQTY: ${qty}\nPeminjam: ${hub}\nPIC MTG: ${pic}`);
      }

      if (skuInput) skuInput.value = '';
      if (nameInput) nameInput.value = '';
      if (slocInput) slocInput.value = '';
      if (qtyInput) qtyInput.value = '1';
      if (hubSelect) hubSelect.value = '';
      if (customHubInput) customHubInput.value = '';
      document.getElementById('pinjeminCustomHubContainer')?.classList.add('hidden');
      if (driverInput) driverInput.value = '';
      if (remarksInput) remarksInput.value = '';
      document.getElementById('pinjeminProductPreview')?.classList.add('hidden');
      document.getElementById('pinjeminClearSkuBtn')?.classList.add('hidden');
      removePinjeminPhoto();

    } catch (err) {
      console.error('Gagal simpan pinjemin:', err);
      alert('Gagal mengirim data. Silakan periksa koneksi internet Anda.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="8.5" cy="7" r="4"></circle>
            <line x1="20" y1="8" x2="20" y2="14"></line>
            <line x1="23" y1="11" x2="17" y2="11"></line>
          </svg>
          <span>Submit MTG Pinjemin</span>
        `;
      }
    }
  };

  // ── 10C. Submit Form MTG Terima Pengembalian dari Hub Lain ──
  window.submitFormTerima = async function (e) {
    if (e && e.preventDefault) e.preventDefault();

    const skuInput = document.getElementById('terimaSkuInput');
    const nameInput = document.getElementById('terimaNamaProdukInput');
    const slocInput = document.getElementById('terimaSlocInput');
    const qtyInput = document.getElementById('terimaQtyInput');
    const hubSelect = document.getElementById('terimaHubSelect');
    const customHubInput = document.getElementById('terimaCustomHubInput');
    const kondisiSelect = document.getElementById('terimaKondisiSelect');
    const picInput = document.getElementById('terimaPicInput');
    const driverInput = document.getElementById('terimaDriverInput');
    const remarksInput = document.getElementById('terimaRemarksInput');
    const submitBtn = document.getElementById('btnSubmitTerima');

    const sku = (skuInput ? skuInput.value : '').trim();
    const productName = (nameInput ? nameInput.value : '').trim();
    const sloc = (slocInput ? slocInput.value : '').trim();
    const qty = parseInt(qtyInput ? qtyInput.value : '1', 10) || 1;
    let hub = (hubSelect ? hubSelect.value : '').trim();
    if (hub === 'custom') {
      hub = (customHubInput ? customHubInput.value : '').trim();
    }
    const kondisi = (kondisiSelect ? kondisiSelect.value : 'Good').trim();
    const pic = (picInput ? picInput.value : '').trim();
    const picHub = (driverInput ? driverInput.value : '').trim();
    const remarks = (remarksInput ? remarksInput.value : '').trim();

    if (!sku) {
      alert('Silakan masukkan Nomor SKU Produk yang diterima.');
      if (skuInput) skuInput.focus();
      return;
    }
    if (!productName) {
      alert('Silakan masukkan Nama Produk.');
      if (nameInput) nameInput.focus();
      return;
    }
    if (!sloc) {
      alert('Silakan masukkan SLOC (Lokasi Rak) penempatan kembali produk.');
      if (slocInput) slocInput.focus();
      return;
    }
    if (qty < 1) {
      alert('Jumlah QTY minimal 1.');
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!hub) {
      alert('Silakan pilih atau ketik HUB asal pengembalian.');
      if (hubSelect) hubSelect.focus();
      return;
    }
    if (!pic) {
      alert('Silakan masukkan nama PIC Petugas MTG penerima.');
      if (picInput) picInput.focus();
      return;
    }

    const payload = {
      action: 'saveTerimaKembali',
      module: 'pinjaman',
      formType: 'terima',
      type: 'terima',
      sku: sku,
      productName: productName,
      sloc: sloc,
      qty: qty,
      hub: hub,
      kondisi: kondisi,
      pic: pic,
      picHub: picHub,
      imageBase64: terimaPhotoBase64,
      remarks: remarks,
      status: 'DITERIMA KEMBALI'
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Menyimpan Penerimaan Kembali...</span>';
    }

    try {
      await fetch(PINJAMAN_WEBAPP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      localStorage.setItem('SUPERAPP_LAST_PIC_TERIMA', pic);

      if (typeof playSaveSuccessChime === 'function') playSaveSuccessChime();
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) {}
      if (typeof showDccToast === 'function') {
        showDccToast('success', 'Penerimaan Kembali Berhasil!', `SKU ${sku} (${productName}) QTY ${qty} dari ${hub} diterima.`);
      } else {
        alert(`✅ Terima Pengembalian Berhasil!\n\nSKU: ${sku}\nProduk: ${productName}\nSLOC: ${sloc}\nQTY: ${qty}\nHUB Asal: ${hub}\nPIC MTG: ${pic}`);
      }

      if (skuInput) skuInput.value = '';
      if (nameInput) nameInput.value = '';
      if (slocInput) slocInput.value = '';
      if (qtyInput) qtyInput.value = '1';
      if (hubSelect) hubSelect.value = '';
      if (customHubInput) customHubInput.value = '';
      document.getElementById('terimaCustomHubContainer')?.classList.add('hidden');
      if (driverInput) driverInput.value = '';
      if (remarksInput) remarksInput.value = '';
      document.getElementById('terimaProductPreview')?.classList.add('hidden');
      document.getElementById('terimaClearSkuBtn')?.classList.add('hidden');
      removeTerimaPhoto();

    } catch (err) {
      console.error('Gagal simpan terima pengembalian:', err);
      alert('Gagal mengirim data. Silakan periksa koneksi internet Anda.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Submit Terima Pengembalian</span>
        `;
      }
    }
  };

  // ── 11. Fetch & Render Riwayat Transaksi (4 Flows) ──
  window.refreshPinjamanData = function (showToast = false) {
    fetchStockUpdateSheet();
    fetchPinjamanHistory();
    if (showToast && typeof showDccToast === 'function') {
      showDccToast('info', 'Menyinkronkan...', 'Memperbarui data Pinjaman & Pengembalian MTG.');
    }
  };

  async function fetchPinjamanHistory() {
    const listContainer = document.getElementById('pinjamanHistoryList');
    if (!listContainer) return;

    listContainer.innerHTML = `
      <div class="dcc-empty-state" style="padding: 30px 10px; text-align: center;">
        <div class="spinning" style="display: inline-block; font-size: 24px; margin-bottom: 8px;">⏳</div>
        <div style="font-size: 0.85rem; color: #94a3b8;">Memuat riwayat transaksi dari Google Sheets...</div>
      </div>
    `;

    try {
      const baseUrl = PINJAMAN_WEBAPP_URL;
      const pUrl = `${baseUrl}?sheet=${encodeURIComponent('Pinjaman Barang MTG')}&_ts=${Date.now()}`;
      const kUrl = `${baseUrl}?sheet=${encodeURIComponent('Pengembalian Barang MTG')}&_ts=${Date.now()}`;
      const pinjeminUrl = `${baseUrl}?sheet=${encodeURIComponent('Pinjemin ke Hub Lain')}&_ts=${Date.now()}`;
      const terimaUrl = `${baseUrl}?sheet=${encodeURIComponent('Terima Pengembalian Hub')}&_ts=${Date.now()}`;

      const [resP, resK, resPinjemin, resTerima] = await Promise.all([
        fetch(pUrl).catch(() => null),
        fetch(kUrl).catch(() => null),
        fetch(pinjeminUrl).catch(() => null),
        fetch(terimaUrl).catch(() => null)
      ]);

      const dataP = resP && resP.ok ? await resP.json() : [];
      const dataK = resK && resK.ok ? await resK.json() : [];
      const dataPinjemin = resPinjemin && resPinjemin.ok ? await resPinjemin.json() : [];
      const dataTerima = resTerima && resTerima.ok ? await resTerima.json() : [];

      const combined = [];

      // 1. Data Sheet Pinjaman Barang MTG (Pinjam ke Hub Lain)
      if (Array.isArray(dataP)) {
        dataP.forEach(row => {
          if (row['NOMOR SKU'] || row['TIMESTAMP']) {
            const jenis = String(row['JENIS TRANSAKSI'] || '').trim();
            const status = String(row['STATUS'] || '').trim().toUpperCase();
            let type = (jenis.includes('Pinjemin') || status === 'DIPINJAMKAN') ? 'pinjemin' : 'pinjam';

            combined.push({
              type: type,
              timestamp: row['TIMESTAMP'] || '',
              jenis: jenis || (type === 'pinjemin' ? 'MTG Pinjemin ke Hub Lain' : 'MTG Pinjam ke Hub Lain'),
              sku: row['NOMOR SKU'] || '',
              productName: row['NAMA PRODUK'] || '',
              qty: row['QTY'] || row['QTY PINJAM'] || '1',
              hub: row['HUB TARGET / ASAL'] || row['HUB TARGET PINJAM'] || row['PINJAM KE HUB'] || '-',
              pic: row['PIC PETUGAS MTG'] || row['PIC PEMINJAM'] || '-',
              picHub: row['PIC / DRIVER HUB'] || '',
              sloc: row['SLOC (LOKASI RAK)'] || '',
              photoUrl: row['BUKTI FOTO (DRIVE)'] || '',
              status: row['STATUS'] || (type === 'pinjemin' ? 'DIPINJAMKAN' : 'DIPINJAM'),
              remarks: row['CATATAN'] || ''
            });
          }
        });
      }

      // 2. Data Sheet Pengembalian Barang MTG (Kembalikan ke Hub Lain)
      if (Array.isArray(dataK)) {
        dataK.forEach(row => {
          if (row['NOMOR SKU'] || row['TIMESTAMP']) {
            const jenis = String(row['JENIS TRANSAKSI'] || '').trim();
            const status = String(row['STATUS'] || '').trim().toUpperCase();
            let type = (jenis.includes('Terima') || status === 'DITERIMA KEMBALI') ? 'terima' : 'kembali';

            combined.push({
              type: type,
              timestamp: row['TIMESTAMP'] || '',
              jenis: jenis || (type === 'terima' ? 'MTG Terima Pengembalian' : 'MTG Kembalikan ke Hub Lain'),
              sku: row['NOMOR SKU'] || '',
              productName: row['NAMA PRODUK'] || '',
              qty: row['QTY'] || row['QTY KEMBALI'] || '1',
              hub: row['HUB TARGET / ASAL'] || row['HUB TARGET PENGEMBALIAN'] || row['KEMBALIKAN KE HUB'] || '-',
              kondisi: row['KONDISI BARANG'] || 'Good',
              pic: row['PIC PETUGAS MTG'] || row['PIC PENGEMBALIAN'] || '-',
              picHub: row['PIC / DRIVER HUB'] || '',
              sloc: row['SLOC (LOKASI RAK)'] || '',
              photoUrl: row['BUKTI FOTO (DRIVE)'] || row['FOTO PRODUK (DRIVE)'] || '',
              status: row['STATUS'] || (type === 'terima' ? 'DITERIMA KEMBALI' : 'DIKEMBALIKAN'),
              remarks: row['CATATAN'] || ''
            });
          }
        });
      }

      // 3. Data Sheet Pinjemin ke Hub Lain (MTG Pinjemin Stok Keluar)
      if (Array.isArray(dataPinjemin)) {
        dataPinjemin.forEach(row => {
          if (row['NOMOR SKU'] || row['TIMESTAMP']) {
            combined.push({
              type: 'pinjemin',
              timestamp: row['TIMESTAMP'] || '',
              jenis: row['JENIS TRANSAKSI'] || 'MTG Pinjemin ke Hub Lain',
              sku: row['NOMOR SKU'] || '',
              productName: row['NAMA PRODUK'] || '',
              qty: row['QTY'] || '1',
              hub: row['HUB PEMINJAM (TUJUAN)'] || row['HUB TARGET / ASAL'] || '-',
              pic: row['PIC PETUGAS MTG'] || '-',
              picHub: row['PIC / DRIVER HUB'] || '',
              sloc: row['SLOC (LOKASI RAK)'] || '',
              photoUrl: row['BUKTI FOTO (DRIVE)'] || '',
              status: row['STATUS'] || 'DIPINJAMKAN',
              remarks: row['CATATAN'] || ''
            });
          }
        });
      }

      // 4. Data Sheet Terima Pengembalian Hub (MTG Terima Stok Masuk Kembali)
      if (Array.isArray(dataTerima)) {
        dataTerima.forEach(row => {
          if (row['NOMOR SKU'] || row['TIMESTAMP']) {
            combined.push({
              type: 'terima',
              timestamp: row['TIMESTAMP'] || '',
              jenis: row['JENIS TRANSAKSI'] || 'MTG Terima Pengembalian dari Hub Lain',
              sku: row['NOMOR SKU'] || '',
              productName: row['NAMA PRODUK'] || '',
              qty: row['QTY'] || '1',
              hub: row['HUB ASAL PENGEMBALIAN'] || row['HUB TARGET / ASAL'] || '-',
              kondisi: row['KONDISI BARANG'] || 'Good',
              pic: row['PIC PETUGAS MTG'] || '-',
              picHub: row['PIC / DRIVER HUB'] || '',
              sloc: row['SLOC (LOKASI RAK)'] || '',
              photoUrl: row['BUKTI FOTO (DRIVE)'] || '',
              status: row['STATUS'] || 'DITERIMA KEMBALI',
              remarks: row['CATATAN'] || ''
            });
          }
        });
      }

      // Sort descending by timestamp / newest first
      combined.reverse();
      pinjamanHistoryData = combined;
      renderPinjamanHistory();

    } catch (e) {
      console.warn('Gagal memuat riwayat pinjaman:', e);
      listContainer.innerHTML = `
        <div class="dcc-empty-state" style="padding: 24px 10px; text-align: center;">
          <div style="font-size: 28px; margin-bottom: 6px;">📡</div>
          <div style="font-size: 0.88rem; font-weight: 600; color: #f8fafc;">Belum Ada Riwayat Tersimpan</div>
          <div style="font-size: 0.74rem; color: #94a3b8; margin-top: 4px;">Data riwayat akan muncul otomatis setelah Anda melakukan submit formulir.</div>
        </div>
      `;
    }
  }

  function renderPinjamanHistory() {
    const listContainer = document.getElementById('pinjamanHistoryList');
    const searchInput = document.getElementById('pinjamanHistorySearch');
    if (!listContainer) return;

    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

    let filtered = pinjamanHistoryData;

    // Filter tipe (5 opsi filter: all, pinjam, kembali, pinjemin, terima)
    if (pinjamanHistoryFilter === 'pinjam') {
      filtered = filtered.filter(it => it.type === 'pinjam');
    } else if (pinjamanHistoryFilter === 'kembali') {
      filtered = filtered.filter(it => it.type === 'kembali');
    } else if (pinjamanHistoryFilter === 'pinjemin') {
      filtered = filtered.filter(it => it.type === 'pinjemin');
    } else if (pinjamanHistoryFilter === 'terima') {
      filtered = filtered.filter(it => it.type === 'terima');
    }

    // Filter search text
    if (query) {
      filtered = filtered.filter(it => {
        return (it.sku && it.sku.toLowerCase().includes(query)) ||
               (it.productName && it.productName.toLowerCase().includes(query)) ||
               (it.hub && it.hub.toLowerCase().includes(query)) ||
               (it.pic && it.pic.toLowerCase().includes(query)) ||
               (it.picHub && it.picHub.toLowerCase().includes(query));
      });
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <div class="dcc-empty-state" style="padding: 24px 10px; text-align: center;">
          <div style="font-size: 26px; margin-bottom: 6px;">🔍</div>
          <div style="font-size: 0.85rem; color: #94a3b8;">Tidak ada data yang sesuai kriteria filter.</div>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = filtered.map(it => {
      let badgeClass = 'pinjam';
      let badgeText = '📤 MTG PINJAM';
      let cardClass = 'pinjam';

      if (it.type === 'kembali') {
        badgeClass = 'kembali';
        badgeText = '🔄 MTG KEMBALIKAN';
        cardClass = 'kembali';
      } else if (it.type === 'pinjemin') {
        badgeClass = 'pinjemin';
        badgeText = '🤝 MTG PINJEMIN';
        cardClass = 'pinjemin';
      } else if (it.type === 'terima') {
        badgeClass = 'terima';
        badgeText = '📦 TERIMA KEMBALI';
        cardClass = 'terima';
      }

      return `
        <div class="pinjaman-history-card ${cardClass}">
          <div class="pinjaman-hist-header">
            <span class="pinjaman-hist-badge ${badgeClass}">${badgeText}</span>
            <span class="pinjaman-hist-time">${escapeHtml(it.timestamp)}</span>
          </div>
          <div class="pinjaman-hist-product">${escapeHtml(it.productName || 'Produk Tanpa Nama')}</div>
          <div class="pinjaman-hist-meta">
            <span><strong>SKU:</strong> ${escapeHtml(it.sku)}</span>
            <span><strong>QTY:</strong> ${escapeHtml(String(it.qty))}</span>
            <span><strong>HUB:</strong> ${escapeHtml(it.hub)}</span>
            <span><strong>PIC MTG:</strong> ${escapeHtml(it.pic)}</span>
            ${it.picHub ? `<span><strong>PIC HUB:</strong> ${escapeHtml(it.picHub)}</span>` : ''}
            ${it.kondisi ? `<span><strong>Kondisi:</strong> ${escapeHtml(it.kondisi)}</span>` : ''}
            ${it.sloc ? `<span><strong>📍 SLOC:</strong> ${escapeHtml(it.sloc)}</span>` : ''}
            ${it.photoUrl ? `<span><a href="${escapeHtml(it.photoUrl)}" target="_blank" class="pinjaman-hist-photo-link">📷 Lihat Bukti Foto</a></span>` : ''}
            ${it.remarks ? `<span><em>"${escapeHtml(it.remarks)}"</em></span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  window.filterPinjamanHistory = function () {
    renderPinjamanHistory();
  };

  window.setPinjamanHistoryFilter = function (filter, btn) {
    pinjamanHistoryFilter = filter;
    document.querySelectorAll('.pinjaman-pill-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderPinjamanHistory();
  };

  // Helper escapeHtml jika belum ada
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initKoliSearchInput();
      initKoliScrollLoader();
    });
  } else {
    initKoliSearchInput();
    initKoliScrollLoader();
  }

})();


