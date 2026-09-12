/**
 * dash.js — Admin Complaint Command Center Logic
 * SuperApp MTG • Hub MTG Menteng
 * Real-time Firestore REST sync + GoWA Backend Proxy
 */

// ─── Configuration ───
const FIRESTORE_PROJECT_ID = 'complain-m';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/complaints`;
const API_BASE_URL = window.location.origin.includes('superappshub.space')
  ? 'https://superappshub.space' // or direct VPS if configured
  : ''; // Relative on localhost

let complaintsData = [];
let filteredData = [];
let autoRefreshInterval = null;
let refreshCountdown = 10;
let currentDetailComplain = null;
let currentViewMode = 'table'; // 'table' or 'grid'

// ─── DOM References ───
const dom = {
  syncStatusChip: document.getElementById('syncStatusChip'),
  syncDot: document.getElementById('syncDot'),
  syncStatusText: document.getElementById('syncStatusText'),
  refreshTimer: document.getElementById('refreshTimer'),
  btnManualRefresh: document.getElementById('btnManualRefresh'),

  // KPI
  kpiTotal: document.getElementById('kpiTotal'),
  kpiTotalSub: document.getElementById('kpiTotalSub'),
  kpiBaru: document.getElementById('kpiBaru'),
  kpiDikerjakan: document.getElementById('kpiDikerjakan'),
  kpiSelesai: document.getElementById('kpiSelesai'),
  kpiHariIni: document.getElementById('kpiHariIni'),
  kpiFoto: document.getElementById('kpiFoto'),

  // Controls
  searchInput: document.getElementById('searchInput'),
  btnClearSearch: document.getElementById('btnClearSearch'),
  statusFilter: document.getElementById('statusFilter'),
  photoFilter: document.getElementById('photoFilter'),
  dateFilter: document.getElementById('dateFilter'),
  btnResetFilters: document.getElementById('btnResetFilters'),

  // Actions
  btnManualInput: document.getElementById('btnManualInput'),
  btnExportCsv: document.getElementById('btnExportCsv'),
  btnPrint: document.getElementById('btnPrint'),
  btnAdminMenu: document.getElementById('btnAdminMenu'),
  adminDropdownMenu: document.getElementById('adminDropdownMenu'),
  btnClearResolved: document.getElementById('btnClearResolved'),
  btnClearAll: document.getElementById('btnClearAll'),
  btnSimulateComplain: document.getElementById('btnSimulateComplain'),
  btnViewWebhookLog: document.getElementById('btnViewWebhookLog'),

  // Views & Table
  visibleCount: document.getElementById('visibleCount'),
  totalCount: document.getElementById('totalCount'),
  viewTableBtn: document.getElementById('viewTableBtn'),
  viewGridBtn: document.getElementById('viewGridBtn'),
  tableContainer: document.getElementById('tableContainer'),
  complaintTableBody: document.getElementById('complaintTableBody'),
  cardsContainer: document.getElementById('cardsContainer'),
  emptyState: document.getElementById('emptyState'),
  emptySubtext: document.getElementById('emptySubtext'),
  loadingState: document.getElementById('loadingState'),

  // Detail Modal
  detailModal: document.getElementById('detailModal'),
  btnCloseDetailModal: document.getElementById('btnCloseDetailModal'),
  btnCloseDetailModalBottom: document.getElementById('btnCloseDetailModalBottom'),
  modalHubTag: document.getElementById('modalHubTag'),
  modalInvoice: document.getElementById('modalInvoice'),
  modalStatusBadge: document.getElementById('modalStatusBadge'),
  btnModalSetProgress: document.getElementById('btnModalSetProgress'),
  btnModalSetResolved: document.getElementById('btnModalSetResolved'),
  btnModalSetReopen: document.getElementById('btnModalSetReopen'),
  modalSender: document.getElementById('modalSender'),
  modalDescription: document.getElementById('modalDescription'),
  modalClaimedBy: document.getElementById('modalClaimedBy'),
  modalTimeCreated: document.getElementById('modalTimeCreated'),
  modalTimeClaimed: document.getElementById('modalTimeClaimed'),
  modalTimeResolved: document.getElementById('modalTimeResolved'),
  modalRawText: document.getElementById('modalRawText'),
  modalProductImage: document.getElementById('modalProductImage'),
  noProductPhotoBanner: document.getElementById('noProductPhotoBanner'),
  btnZoomProductPhoto: document.getElementById('btnZoomProductPhoto'),
  modalEvidenceImage: document.getElementById('modalEvidenceImage'),
  noEvidenceBanner: document.getElementById('noEvidenceBanner'),
  btnZoomEvidencePhoto: document.getElementById('btnZoomEvidencePhoto'),
  btnModalDeleteComplain: document.getElementById('btnModalDeleteComplain'),

  // Lightbox
  lightboxModal: document.getElementById('lightboxModal'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxCaption: document.getElementById('lightboxCaption'),
  btnCloseLightbox: document.getElementById('btnCloseLightbox'),

  // Manual Modal
  manualInputModal: document.getElementById('manualInputModal'),
  btnCloseManualModal: document.getElementById('btnCloseManualModal'),
  btnCancelManual: document.getElementById('btnCancelManual'),
  manualComplainForm: document.getElementById('manualComplainForm'),
  inputInvoice: document.getElementById('inputInvoice'),
  inputHub: document.getElementById('inputHub'),
  inputSender: document.getElementById('inputSender'),
  inputDesc: document.getElementById('inputDesc'),
  inputPhoto: document.getElementById('inputPhoto'),
  manualPhotoPreview: document.getElementById('manualPhotoPreview'),
  manualPreviewImg: document.getElementById('manualPreviewImg'),
  btnRemoveManualPhoto: document.getElementById('btnRemoveManualPhoto'),

  // PIN Modal
  pinModal: document.getElementById('pinModal'),
  btnClosePinModal: document.getElementById('btnClosePinModal'),
  btnCancelPin: document.getElementById('btnCancelPin'),
  btnConfirmClearAll: document.getElementById('btnConfirmClearAll'),
  adminPinInput: document.getElementById('adminPinInput'),

  // Webhook Log Modal
  webhookLogModal: document.getElementById('webhookLogModal'),
  btnCloseWebhookLogModal: document.getElementById('btnCloseWebhookLogModal'),
  btnCloseWebhookLogBottom: document.getElementById('btnCloseWebhookLogBottom'),
  webhookJsonViewer: document.getElementById('webhookJsonViewer'),

  // Toast
  toastContainer: document.getElementById('toastContainer')
};

let uploadedManualPhotoBase64 = null;

// ─── Firestore Document Decoder ───
function decodeFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const fields = doc.fields;

  function unwrap(val) {
    if (!val) return null;
    if (val.stringValue !== undefined) return val.stringValue;
    if (val.integerValue !== undefined) return parseInt(val.integerValue, 10);
    if (val.doubleValue !== undefined) return parseFloat(val.doubleValue);
    if (val.booleanValue !== undefined) return val.booleanValue;
    if (val.timestampValue !== undefined) return val.timestampValue;
    if (val.nullValue !== undefined) return null;
    if (val.mapValue !== undefined) {
      const res = {};
      for (const k in val.mapValue.fields) {
        res[k] = unwrap(val.mapValue.fields[k]);
      }
      return res;
    }
    if (val.arrayValue !== undefined) {
      return (val.arrayValue.values || []).map(unwrap);
    }
    return null;
  }

  const obj = {};
  for (const k in fields) {
    obj[k] = unwrap(fields[k]);
  }

  // Extract ID from doc.name: "projects/.../documents/complaints/{id}"
  if (!obj.id && doc.name) {
    obj.id = doc.name.split('/').pop();
  }

  return obj;
}

// ─── Encode Object to Firestore Fields ───
function encodeToFirestoreFields(obj) {
  const fields = {};
  for (const k in obj) {
    const val = obj[k];
    if (val === null || val === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof val === 'string') {
      fields[k] = { stringValue: val };
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        fields[k] = { integerValue: val.toString() };
      } else {
        fields[k] = { doubleValue: val };
      }
    } else if (typeof val === 'boolean') {
      fields[k] = { booleanValue: val };
    } else if (typeof val === 'object') {
      fields[k] = { mapValue: { fields: encodeToFirestoreFields(val) } };
    }
  }
  return fields;
}

// ─── Data Fetching Engine (Dual Cloud Sync) ───
async function fetchComplaints() {
  let list = [];
  let source = '';

  // 1. Try Firestore REST directly
  try {
    const fsRes = await fetch(FIRESTORE_URL + '?pageSize=200&_t=' + Date.now(), {
      cache: 'no-store'
    });
    if (fsRes.ok) {
      const fsData = await fsRes.json();
      if (fsData && fsData.documents) {
        list = fsData.documents.map(decodeFirestoreDoc).filter(Boolean);
        source = 'Firestore Cloud';
      }
    }
  } catch (err) {
    console.warn('Firestore direct REST error, falling back to local/backend API:', err);
  }

  // 2. Fallback to /api/complaints if Firestore returned empty or failed
  if (list.length === 0) {
    try {
      const apiRes = await fetch('/api/complaints?_t=' + Date.now());
      if (apiRes.ok) {
        const apiData = await apiRes.json();
        list = apiData.data || apiData || [];
        source = 'GoWA Webhook API';
      }
    } catch (err2) {
      console.warn('Local API error:', err2);
    }
  }

  // Sort descending by createdAt
  list.sort((a, b) => {
    const tA = new Date(a.createdAt || 0).getTime();
    const tB = new Date(b.createdAt || 0).getTime();
    return tB - tA;
  });

  complaintsData = list;
  updateSyncTelemetry(true, source || 'Tersinkron');
  applyFiltersAndRender();
  updateKPIs();
}

// ─── Update Telemetry Header ───
function updateSyncTelemetry(isOnline, sourceName) {
  if (isOnline) {
    dom.syncDot.className = 'pulse-dot active';
    dom.syncStatusText.textContent = `Sync: ${sourceName} (${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`;
  } else {
    dom.syncDot.className = 'pulse-dot';
    dom.syncStatusText.textContent = 'Sync: Terputus / Offline';
  }
}

// ─── KPI Calculations ───
function updateKPIs() {
  const total = complaintsData.length;
  const baru = complaintsData.filter(c => (c.status || '').toLowerCase() === 'baru').length;
  const dikerjakan = complaintsData.filter(c => (c.status || '').toLowerCase() === 'dikerjakan').length;
  const selesai = complaintsData.filter(c => (c.status || '').toLowerCase() === 'selesai').length;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = complaintsData.filter(c => {
    const t = new Date(c.createdAt || 0).getTime();
    return t >= startOfToday;
  }).length;

  const withPhoto = complaintsData.filter(c => !!c.productImageUrl).length;

  dom.kpiTotal.textContent = total;
  dom.kpiBaru.textContent = baru;
  dom.kpiDikerjakan.textContent = dikerjakan;
  dom.kpiSelesai.textContent = selesai;
  dom.kpiHariIni.textContent = today;
  dom.kpiFoto.textContent = withPhoto;
  dom.totalCount.textContent = total;
}

// ─── Filter & Search Engine ───
function applyFiltersAndRender() {
  const query = (dom.searchInput.value || '').trim().toLowerCase();
  const status = dom.statusFilter.value;
  const photo = dom.photoFilter.value;
  const dateRange = dom.dateFilter.value;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sevenDaysAgo = startOfToday - (7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = startOfToday - (30 * 24 * 60 * 60 * 1000);

  filteredData = complaintsData.filter(item => {
    // Search query
    if (query) {
      const matchInv = (item.invoice || '').toLowerCase().includes(query);
      const matchSender = (item.sender || '').toLowerCase().includes(query);
      const matchDesc = (item.description || '').toLowerCase().includes(query);
      const matchUser = (item.claimedBy || '').toLowerCase().includes(query);
      const matchHub = (item.hub || '').toLowerCase().includes(query);
      if (!matchInv && !matchSender && !matchDesc && !matchUser && !matchHub) {
        return false;
      }
    }

    // Status filter
    if (status !== 'all') {
      if ((item.status || '').toLowerCase() !== status) return false;
    }

    // Photo filter
    if (photo === 'with_photo' && !item.productImageUrl) return false;
    if (photo === 'no_photo' && item.productImageUrl) return false;

    // Date filter
    if (dateRange !== 'all') {
      const itemTime = new Date(item.createdAt || 0).getTime();
      if (dateRange === 'today' && itemTime < startOfToday) return false;
      if (dateRange === '7days' && itemTime < sevenDaysAgo) return false;
      if (dateRange === '30days' && itemTime < thirtyDaysAgo) return false;
    }

    return true;
  });

  dom.visibleCount.textContent = filteredData.length;
  renderViews();
}

// ─── Render Table & Cards ───
function renderViews() {
  dom.loadingState.style.display = 'none';

  if (filteredData.length === 0) {
    dom.tableContainer.style.display = 'none';
    dom.cardsContainer.style.display = 'none';
    dom.emptyState.style.display = 'flex';
    if (complaintsData.length === 0) {
      dom.emptySubtext.textContent = 'Belum ada pesan complain yang masuk dari bot WhatsApp.';
    } else {
      dom.emptySubtext.textContent = 'Tidak ada complain yang sesuai dengan filter atau kata kunci pencarian.';
    }
    return;
  }

  dom.emptyState.style.display = 'none';

  if (currentViewMode === 'table') {
    dom.tableContainer.style.display = 'block';
    dom.cardsContainer.style.display = 'none';
  } else {
    dom.tableContainer.style.display = 'none';
    dom.cardsContainer.style.display = 'grid';
  }

  // 1. Render Table Rows
  dom.complaintTableBody.innerHTML = filteredData.map((item, idx) => {
    const statusClass = `status-${(item.status || 'baru').toLowerCase()}`;
    const statusLabel = formatStatusLabel(item.status);
    const dateFormatted = formatDateTime(item.createdAt);
    const shortDesc = (item.description || '-').length > 55
      ? escapeHtml((item.description || '').substring(0, 55)) + '...'
      : escapeHtml(item.description || '-');

    const photoThumb = item.productImageUrl
      ? `<div class="thumb-cell" onclick="openLightbox('${escapeHtml(item.productImageUrl)}', 'Foto Produk — ${escapeHtml(item.invoice)}')">
           <img src="${escapeHtml(item.productImageUrl)}" alt="Foto">
         </div>`
      : `<span class="thumb-empty">-</span>`;

    const evidenceThumb = item.evidenceUrl
      ? `<div class="thumb-cell" onclick="openLightbox('${escapeHtml(item.evidenceUrl)}', 'Bukti Selesai — ${escapeHtml(item.invoice)}')">
           <img src="${escapeHtml(item.evidenceUrl)}" alt="Bukti">
         </div>`
      : `<span class="thumb-empty">-</span>`;

    return `
      <tr data-id="${escapeHtml(item.id)}">
        <td class="cell-mono text-muted">${idx + 1}</td>
        <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
        <td>
          <div class="invoice-badge">
            <span class="cell-mono">${escapeHtml(item.invoice || '-')}</span>
            <button class="invoice-copy-btn" onclick="copyText('${escapeHtml(item.invoice || '')}')" title="Salin Invoice">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </td>
        <td><strong>${escapeHtml(item.sender || 'Customer')}</strong></td>
        <td><span title="${escapeHtml(item.description || '')}">${shortDesc}</span></td>
        <td>${photoThumb}</td>
        <td>${item.claimedBy ? `<strong>${escapeHtml(item.claimedBy)}</strong>` : '<span class="text-muted">Menunggu</span>'}</td>
        <td>${evidenceThumb}</td>
        <td class="cell-mono" style="font-size: 0.76rem; color: var(--text-subtext);">${dateFormatted}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" onclick="viewComplainDetail('${escapeHtml(item.id)}')" title="Buka Detail">Detail</button>
            <button class="action-btn delete-btn" onclick="confirmDeleteComplain('${escapeHtml(item.id)}', '${escapeHtml(item.invoice)}')" title="Hapus">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // 2. Render Cards (Mobile)
  dom.cardsContainer.innerHTML = filteredData.map(item => {
    const statusClass = `status-${(item.status || 'baru').toLowerCase()}`;
    const statusLabel = formatStatusLabel(item.status);
    const dateFormatted = formatDateTime(item.createdAt);

    return `
      <div class="complaint-card" data-id="${escapeHtml(item.id)}">
        <div class="card-top">
          <div>
            <div class="card-invoice">${escapeHtml(item.invoice || '-')}</div>
            <div class="card-time">${dateFormatted}</div>
          </div>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>

        <div class="card-customer">Pelapor: ${escapeHtml(item.sender || 'Customer')}</div>
        <div class="card-desc">${escapeHtml(item.description || '-')}</div>

        <div class="card-media-preview">
          ${item.productImageUrl ? `
            <div class="card-thumb-item">
              <span class="card-thumb-label">Foto Produk</span>
              <div class="thumb-cell" onclick="openLightbox('${escapeHtml(item.productImageUrl)}', 'Foto Produk — ${escapeHtml(item.invoice)}')">
                <img src="${escapeHtml(item.productImageUrl)}" alt="Foto">
              </div>
            </div>
          ` : ''}
          ${item.evidenceUrl ? `
            <div class="card-thumb-item">
              <span class="card-thumb-label">Bukti Selesai</span>
              <div class="thumb-cell" onclick="openLightbox('${escapeHtml(item.evidenceUrl)}', 'Bukti Selesai — ${escapeHtml(item.invoice)}')">
                <img src="${escapeHtml(item.evidenceUrl)}" alt="Bukti">
              </div>
            </div>
          ` : ''}
        </div>

        <div class="card-footer">
          <span class="text-muted" style="font-size: 0.78rem;">
            ${item.claimedBy ? `Staf: <strong>${escapeHtml(item.claimedBy)}</strong>` : 'Belum ditugaskan'}
          </span>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-secondary" onclick="viewComplainDetail('${escapeHtml(item.id)}')">Detail</button>
            <button class="btn btn-sm btn-danger-outline" onclick="confirmDeleteComplain('${escapeHtml(item.id)}', '${escapeHtml(item.invoice)}')">Hapus</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Modal Detail & Photo Viewer ───
window.viewComplainDetail = function(id) {
  const item = complaintsData.find(c => c.id === id);
  if (!item) return;

  currentDetailComplain = item;

  dom.modalHubTag.textContent = (item.hub || 'HUB MTG MENTENG').toUpperCase();
  dom.modalInvoice.textContent = item.invoice || 'INV/...';
  dom.modalSender.textContent = item.sender || '-';
  dom.modalDescription.textContent = item.description || '-';
  dom.modalClaimedBy.textContent = item.claimedBy
    ? `${item.claimedBy} (Diklaim: ${formatDateTime(item.claimedAt)})`
    : 'Belum ada staf yang mengklaim ticket ini';

  dom.modalTimeCreated.textContent = formatDateTime(item.createdAt);
  dom.modalTimeClaimed.textContent = item.claimedAt ? formatDateTime(item.claimedAt) : '-';
  dom.modalTimeResolved.textContent = item.resolvedAt ? formatDateTime(item.resolvedAt) : '-';
  dom.modalRawText.textContent = item.rawText || '(Pesan raw tidak tersedia)';

  // Status badge
  const statusClass = `status-${(item.status || 'baru').toLowerCase()}`;
  dom.modalStatusBadge.className = `status-badge ${statusClass}`;
  dom.modalStatusBadge.textContent = formatStatusLabel(item.status);

  // Product Image
  if (item.productImageUrl) {
    dom.modalProductImage.src = item.productImageUrl;
    dom.modalProductImage.style.display = 'block';
    dom.noProductPhotoBanner.style.display = 'none';
    dom.btnZoomProductPhoto.style.display = 'inline-block';
  } else {
    dom.modalProductImage.style.display = 'none';
    dom.noProductPhotoBanner.style.display = 'block';
    dom.btnZoomProductPhoto.style.display = 'none';
  }

  // Evidence Image
  if (item.evidenceUrl) {
    dom.modalEvidenceImage.src = item.evidenceUrl;
    dom.modalEvidenceImage.style.display = 'block';
    dom.noEvidenceBanner.style.display = 'none';
    dom.btnZoomEvidencePhoto.style.display = 'inline-block';
  } else {
    dom.modalEvidenceImage.style.display = 'none';
    dom.noEvidenceBanner.style.display = 'block';
    dom.btnZoomEvidencePhoto.style.display = 'none';
  }

  dom.detailModal.classList.add('active');
};

// Quick status changer from detail modal
async function updateDetailStatus(newStatus) {
  if (!currentDetailComplain) return;
  const id = currentDetailComplain.id;

  showToast(`Memperbarui status menjadi ${newStatus}...`, 'info');

  try {
    // 1. Try Firestore REST Patch
    const docUrl = `${FIRESTORE_URL}/${id}`;
    const updateTime = new Date().toISOString();
    const updatePayload = {
      status: newStatus
    };
    if (newStatus === 'dikerjakan' && !currentDetailComplain.claimedAt) {
      updatePayload.claimedAt = updateTime;
      updatePayload.claimedBy = 'Admin Console';
    } else if (newStatus === 'selesai') {
      updatePayload.resolvedAt = updateTime;
    }

    // Try backend proxy first
    let success = false;
    try {
      if (newStatus === 'dikerjakan') {
        const res = await fetch(`/api/complaints/${id}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: 'Admin Console' })
        });
        if (res.ok) success = true;
      }
    } catch (_) {}

    // Direct Firestore update if needed
    if (!success) {
      const patchFields = encodeToFirestoreFields(updatePayload);
      const maskParams = Object.keys(updatePayload).map(k => `updateMask.fieldPaths=${k}`).join('&');
      await fetch(`${docUrl}?${maskParams}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: patchFields })
      });
    }

    showToast(`Status berhasil diubah menjadi ${newStatus}!`, 'success');
    await fetchComplaints();

    // Refresh modal
    const updated = complaintsData.find(c => c.id === id);
    if (updated) viewComplainDetail(id);
  } catch (err) {
    showToast(`Gagal update status: ${err.message}`, 'error');
  }
}

// ─── Single Delete Complain ───
window.confirmDeleteComplain = async function(id, invoice) {
  if (!confirm(`Apakah Anda yakin ingin menghapus data complain [${invoice || id}] secara permanen?`)) {
    return;
  }

  showToast(`Menghapus complain ${invoice}...`, 'info');

  try {
    // 1. Try backend endpoint
    let deleted = false;
    try {
      const res = await fetch(`/api/complaints/${id}`, { method: 'DELETE' });
      if (res.ok) deleted = true;
    } catch (_) {}

    // 2. Direct Firestore REST delete fallback
    if (!deleted) {
      const fsRes = await fetch(`${FIRESTORE_URL}/${id}`, { method: 'DELETE' });
      if (fsRes.ok) deleted = true;
    }

    showToast(`Complain ${invoice} berhasil dihapus!`, 'success');
    dom.detailModal.classList.remove('active');
    await fetchComplaints();
  } catch (err) {
    showToast(`Gagal menghapus: ${err.message}`, 'error');
  }
};

// ─── Clear Resolved Complaints ───
async function handleClearResolved() {
  const resolvedCount = complaintsData.filter(c => (c.status || '').toLowerCase() === 'selesai').length;
  if (resolvedCount === 0) {
    showToast('Tidak ada complain dengan status selesai untuk dibersihkan.', 'warning');
    return;
  }

  if (!confirm(`Konfirmasi: Hapus ${resolvedCount} complain berstatus 'SELESAI'? Riwayat yang belum selesai tetap aman.`)) {
    return;
  }

  showToast('Membersihkan complain selesai...', 'info');

  try {
    let success = false;
    // Backend endpoint
    try {
      const res = await fetch('/api/complaints/clear-resolved', { method: 'POST' });
      if (res.ok) success = true;
    } catch (_) {}

    // Direct Firestore deletion fallback for resolved items
    if (!success) {
      const resolvedList = complaintsData.filter(c => (c.status || '').toLowerCase() === 'selesai');
      for (const item of resolvedList) {
        await fetch(`${FIRESTORE_URL}/${item.id}`, { method: 'DELETE' });
      }
    }

    showToast(`Berhasil membersihkan ${resolvedCount} complain selesai!`, 'success');
    await fetchComplaints();
  } catch (err) {
    showToast(`Gagal membersihkan: ${err.message}`, 'error');
  }
}

// ─── Clear All Complaints (PIN Protected) ───
function openPinModal() {
  dom.adminPinInput.value = '';
  dom.pinModal.classList.add('active');
  dom.adminPinInput.focus();
}

async function handleConfirmClearAll() {
  const pin = dom.adminPinInput.value.trim();
  if (!pin) {
    showToast('Harap masukkan PIN Admin!', 'warning');
    return;
  }

  showToast('Memverifikasi PIN dan mengosongkan data...', 'info');

  try {
    let success = false;
    try {
      const res = await fetch('/api/complaints/clear-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'PIN Admin Salah!', 'error');
        return;
      }
      success = true;
    } catch (_) {}

    // Direct Firestore fallback if backend proxy not reachable (PIN 1234 check)
    if (!success) {
      if (pin !== '1234') {
        showToast('PIN Admin tidak valid!', 'error');
        return;
      }
      for (const item of complaintsData) {
        await fetch(`${FIRESTORE_URL}/${item.id}`, { method: 'DELETE' });
      }
      success = true;
    }

    dom.pinModal.classList.remove('active');
    showToast('Seluruh data complain berhasil dikosongkan!', 'success');
    await fetchComplaints();
  } catch (err) {
    showToast(`Gagal: ${err.message}`, 'error');
  }
}

// ─── Manual Complaint Ticket Creation ───
async function handleManualSubmit(e) {
  e.preventDefault();

  const invoice = dom.inputInvoice.value.trim();
  const hub = dom.inputHub.value.trim() || 'Hub MTG Menteng';
  const sender = dom.inputSender.value.trim();
  const description = dom.inputDesc.value.trim();
  const productImageUrl = uploadedManualPhotoBase64 || null;

  if (!invoice || !sender || !description) {
    showToast('Lengkapi nomor invoice, pelapor, dan keluhan!', 'warning');
    return;
  }

  showToast('Menyimpan complain baru...', 'info');

  const newComplain = {
    id: `cpl-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
    hub,
    invoice,
    sender,
    description,
    productImageUrl,
    status: 'baru',
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    evidenceUrl: null,
    rawText: `[Input Manual Admin Console]\nHub: ${hub}\nInvoice: ${invoice}\nPelapor: ${sender}\nKeluhan: ${description}`
  };

  try {
    // Save to Firestore direct REST
    const docUrl = `${FIRESTORE_URL}?documentId=${newComplain.id}`;
    const res = await fetch(docUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeToFirestoreFields(newComplain) })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    showToast(`Complain ${invoice} berhasil ditambahkan!`, 'success');
    dom.manualInputModal.classList.remove('active');
    dom.manualComplainForm.reset();
    uploadedManualPhotoBase64 = null;
    dom.manualPhotoPreview.style.display = 'none';

    await fetchComplaints();
  } catch (err) {
    showToast(`Gagal menyimpan complain: ${err.message}`, 'error');
  }
}

// ─── Export CSV Engine ───
function exportToCsv() {
  if (filteredData.length === 0) {
    showToast('Tidak ada data untuk diexport!', 'warning');
    return;
  }

  const headers = [
    'No',
    'ID Complain',
    'Hub',
    'No Invoice',
    'Pelapor / Customer',
    'Status',
    'Detail Keluhan',
    'Ada Foto Produk',
    'Dikerjakan Oleh',
    'Waktu Masuk',
    'Waktu Selesai'
  ];

  const rows = filteredData.map((c, i) => [
    i + 1,
    `"${(c.id || '').replace(/"/g, '""')}"`,
    `"${(c.hub || '').replace(/"/g, '""')}"`,
    `"${(c.invoice || '').replace(/"/g, '""')}"`,
    `"${(c.sender || '').replace(/"/g, '""')}"`,
    `"${(c.status || '').replace(/"/g, '""')}"`,
    `"${(c.description || '').replace(/"/g, '""')}"`,
    c.productImageUrl ? 'YA' : 'TIDAK',
    `"${(c.claimedBy || '-').replace(/"/g, '""')}"`,
    `"${formatDateTime(c.createdAt)}"`,
    `"${c.resolvedAt ? formatDateTime(c.resolvedAt) : '-'}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `rekap_complain_mtg_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('Export CSV berhasil diunduh!', 'success');
}

// ─── Webhook Raw Payload Inspector ───
async function viewWebhookLog() {
  dom.webhookJsonViewer.textContent = 'Memuat payload webhook terbaru dari server VPS...';
  dom.webhookLogModal.classList.add('active');

  try {
    const res = await fetch('/api/latest-webhook');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    dom.webhookJsonViewer.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    dom.webhookJsonViewer.textContent = `Gagal mengambil payload: ${err.message}\nPastikan server wa-bot-webhook aktif di port 3100.`;
  }
}

// ─── Simulate Incoming Complain ───
async function handleSimulateComplain() {
  showToast('Mengirim simulasi complain WhatsApp...', 'info');
  try {
    const dummyInvoice = `INV/TEST/${Math.floor(1000 + Math.random() * 9000)}`;
    const res = await fetch('/api/simulate-complain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice: dummyInvoice,
        customer: 'Pelanggan Uji Coba',
        issue: 'Barang tidak lengkap (kurang 1 item susu UHT)',
        withImage: true
      })
    });
    const result = await res.json();
    showToast(`Simulasi ${dummyInvoice} berhasil dikirim!`, 'success');
    await fetchComplaints();
  } catch (err) {
    showToast(`Gagal simulasi: ${err.message}`, 'error');
  }
}

// ─── Lightbox Modal ───
window.openLightbox = function(src, caption) {
  if (!src) return;
  dom.lightboxImg.src = src;
  dom.lightboxCaption.textContent = caption || '';
  dom.lightboxModal.classList.add('active');
};

// ─── Copy Text Helper ───
window.copyText = function(text) {
  if (!navigator.clipboard) {
    showToast('Clipboard tidak didukung browser', 'warning');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Nomor invoice "${text}" disalin!`, 'info');
  });
};

// ─── Toast System ───
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `hud-toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };

  toast.innerHTML = `
    <span>${icons[type] || 'ℹ️'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    toast.style.transition = 'all 200ms ease';
    setTimeout(() => toast.remove(), 220);
  }, 3500);
}

// ─── Formatters ───
function formatStatusLabel(st) {
  const s = (st || 'baru').toLowerCase();
  if (s === 'baru') return 'Baru';
  if (s === 'dikerjakan') return 'Dikerjakan';
  if (s === 'selesai') return 'Selesai';
  return s.toUpperCase();
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }) + ' ' + d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Setup Event Listeners ───
function setupEventListeners() {
  // Search & Filter
  dom.searchInput.addEventListener('input', () => {
    dom.btnClearSearch.classList.toggle('visible', !!dom.searchInput.value);
    applyFiltersAndRender();
  });

  dom.btnClearSearch.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.btnClearSearch.classList.remove('visible');
    applyFiltersAndRender();
  });

  dom.statusFilter.addEventListener('change', applyFiltersAndRender);
  dom.photoFilter.addEventListener('change', applyFiltersAndRender);
  dom.dateFilter.addEventListener('change', applyFiltersAndRender);

  dom.btnResetFilters.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.btnClearSearch.classList.remove('visible');
    dom.statusFilter.value = 'all';
    dom.photoFilter.value = 'all';
    dom.dateFilter.value = 'all';
    applyFiltersAndRender();
  });

  // KPI cards click to filter
  document.querySelectorAll('.kpi-card[data-filter]').forEach(card => {
    card.addEventListener('click', () => {
      const f = card.dataset.filter;
      dom.statusFilter.value = f === 'semua' ? 'all' : f;
      applyFiltersAndRender();
    });
  });

  // Refresh controls
  dom.btnManualRefresh.addEventListener('click', () => {
    dom.btnManualRefresh.style.transform = 'rotate(360deg)';
    dom.btnManualRefresh.style.transition = 'transform 400ms ease';
    setTimeout(() => {
      dom.btnManualRefresh.style.transform = 'none';
      dom.btnManualRefresh.style.transition = 'none';
    }, 450);
    refreshCountdown = 10;
    fetchComplaints();
  });

  // View toggle
  dom.viewTableBtn.addEventListener('click', () => {
    currentViewMode = 'table';
    dom.viewTableBtn.classList.add('active');
    dom.viewGridBtn.classList.remove('active');
    renderViews();
  });

  dom.viewGridBtn.addEventListener('click', () => {
    currentViewMode = 'grid';
    dom.viewGridBtn.classList.add('active');
    dom.viewTableBtn.classList.remove('active');
    renderViews();
  });

  // Action Buttons
  dom.btnExportCsv.addEventListener('click', exportToCsv);
  dom.btnPrint.addEventListener('click', () => window.print());

  // Admin menu dropdown
  dom.btnAdminMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.adminDropdownMenu.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!dom.adminDropdownMenu.contains(e.target) && e.target !== dom.btnAdminMenu) {
      dom.adminDropdownMenu.classList.remove('show');
    }
  });

  dom.btnClearResolved.addEventListener('click', () => {
    dom.adminDropdownMenu.classList.remove('show');
    handleClearResolved();
  });

  dom.btnClearAll.addEventListener('click', () => {
    dom.adminDropdownMenu.classList.remove('show');
    openPinModal();
  });

  dom.btnSimulateComplain.addEventListener('click', () => {
    dom.adminDropdownMenu.classList.remove('show');
    handleSimulateComplain();
  });

  dom.btnViewWebhookLog.addEventListener('click', () => {
    dom.adminDropdownMenu.classList.remove('show');
    viewWebhookLog();
  });

  // Modals closing
  dom.btnCloseDetailModal.addEventListener('click', () => dom.detailModal.classList.remove('active'));
  dom.btnCloseDetailModalBottom.addEventListener('click', () => dom.detailModal.classList.remove('active'));
  dom.btnCloseLightbox.addEventListener('click', () => dom.lightboxModal.classList.remove('active'));
  dom.lightboxModal.addEventListener('click', (e) => {
    if (e.target === dom.lightboxModal) dom.lightboxModal.classList.remove('active');
  });

  // Detail Modal zoom buttons
  dom.btnZoomProductPhoto.addEventListener('click', () => {
    if (currentDetailComplain && currentDetailComplain.productImageUrl) {
      openLightbox(currentDetailComplain.productImageUrl, `Foto Produk — ${currentDetailComplain.invoice}`);
    }
  });

  dom.btnZoomEvidencePhoto.addEventListener('click', () => {
    if (currentDetailComplain && currentDetailComplain.evidenceUrl) {
      openLightbox(currentDetailComplain.evidenceUrl, `Bukti Selesai — ${currentDetailComplain.invoice}`);
    }
  });

  // Status changers in detail modal
  dom.btnModalSetProgress.addEventListener('click', () => updateDetailStatus('dikerjakan'));
  dom.btnModalSetResolved.addEventListener('click', () => updateDetailStatus('selesai'));
  dom.btnModalSetReopen.addEventListener('click', () => updateDetailStatus('baru'));

  dom.btnModalDeleteComplain.addEventListener('click', () => {
    if (currentDetailComplain) {
      confirmDeleteComplain(currentDetailComplain.id, currentDetailComplain.invoice);
    }
  });

  // Manual Complain Modal
  dom.btnManualInput.addEventListener('click', () => {
    dom.manualComplainForm.reset();
    uploadedManualPhotoBase64 = null;
    dom.manualPhotoPreview.style.display = 'none';
    dom.manualInputModal.classList.add('active');
    dom.inputInvoice.focus();
  });

  dom.btnCloseManualModal.addEventListener('click', () => dom.manualInputModal.classList.remove('active'));
  dom.btnCancelManual.addEventListener('click', () => dom.manualInputModal.classList.remove('active'));
  dom.manualComplainForm.addEventListener('submit', handleManualSubmit);

  // Manual Photo File Input
  dom.inputPhoto.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvt) => {
      uploadedManualPhotoBase64 = loadEvt.target.result;
      dom.manualPreviewImg.src = uploadedManualPhotoBase64;
      dom.manualPhotoPreview.style.display = 'flex';
    };
    reader.readAsDataURL(file);
  });

  dom.btnRemoveManualPhoto.addEventListener('click', () => {
    dom.inputPhoto.value = '';
    uploadedManualPhotoBase64 = null;
    dom.manualPhotoPreview.style.display = 'none';
  });

  // PIN Modal
  dom.btnClosePinModal.addEventListener('click', () => dom.pinModal.classList.remove('active'));
  dom.btnCancelPin.addEventListener('click', () => dom.pinModal.classList.remove('active'));
  dom.btnConfirmClearAll.addEventListener('click', handleConfirmClearAll);
  dom.adminPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConfirmClearAll();
  });

  // Webhook log modal
  dom.btnCloseWebhookLogModal.addEventListener('click', () => dom.webhookLogModal.classList.remove('active'));
  dom.btnCloseWebhookLogBottom.addEventListener('click', () => dom.webhookLogModal.classList.remove('active'));

  // Escape key closes active modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });
}

// ─── Auto Refresh Timer ───
function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);

  autoRefreshInterval = setInterval(() => {
    refreshCountdown--;
    if (refreshCountdown <= 0) {
      refreshCountdown = 10;
      fetchComplaints();
    }
    dom.refreshTimer.textContent = `Auto (${refreshCountdown}s)`;
  }, 1000);
}

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  fetchComplaints();
  startAutoRefresh();
});
