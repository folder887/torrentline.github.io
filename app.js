/* ═══════════════════════════════════════════════
   TorrentLine — app.js
   Browser-based torrent client + search
   ═══════════════════════════════════════════════ */

/* ── [1] Config ── */
const CONFIG = {
  // WebTorrent CDN sources tried in order until one works
  wtSources: [
    'https://esm.sh/webtorrent',
    'https://cdn.skypack.dev/webtorrent',
    'https://esm.run/webtorrent',
    'https://ga.jspm.io/npm:webtorrent@latest/dist/webtorrent.min.js',
    'https://unpkg.com/webtorrent@latest/dist/webtorrent.min.js?module',
    'https://cdn.jsdelivr.net/npm/webtorrent@latest/dist/webtorrent.min.js',
  ],

  // WebSocket trackers — the only type that work inside browsers
  wssTrackers: [
    'wss://tracker.btorrent.xyz',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.files.fm:7073/announce',
    'wss://peertube.cpy.re:443/tracker/socket',
    'wss://tracker.novage.com.ua',
    'wss://spacetradegame.com:443/announce',
  ],

  // Extra trackers added to magnet links (UDP works in desktop clients)
  extraTrackers: [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://9.rarbg.to:2710/announce',
    'udp://tracker.zer0day.to:1337/announce',
  ],

  // TPB API — public, CORS-enabled
  apiBase: 'https://apibay.org',

  statsInterval:   250,  // ms between UI refreshes
  streamThreshold: 512 * 1024 * 1024, // 512 MB — use streaming above this
  resultsPerPage:  25,
};

/* ── [2] DOM refs ── */
const el = (id) => document.getElementById(id);
const dom = {
  overlay:       el('loading-overlay'),
  loaderStatus:  el('loader-status'),
  header:        el('app-header'),
  clientStats:   el('client-stats'),
  globalDl:      el('global-dl'),
  globalUl:      el('global-ul'),
  dlCount:       el('dl-count'),
  compatWarn:    el('compat-warning'),
  // Downloads
  dropZone:      el('drop-zone'),
  fileInput:     el('file-input'),
  magnetInput:   el('magnet-input'),
  magnetBtn:     el('magnet-btn'),
  magnetError:   el('magnet-error'),
  emptyState:    el('empty-state'),
  torrentList:   el('torrent-list'),
  // Browse
  browseSearch:     el('browse-search'),
  browseSearchBtn:  el('browse-search-btn'),
  browseClear:      el('browse-clear'),
  browseCats:       el('browse-cats'),
  browseStatusBar:  el('browse-status-bar'),
  resultCount:      el('browse-result-count'),
  queryLabel:       el('browse-query-label'),
  browseLoading:    el('browse-loading'),
  browseEmpty:      el('browse-empty'),
  browseError:      el('browse-error'),
  browseErrorMsg:   el('browse-error-msg'),
  browseRetry:      el('browse-retry'),
  browseResults:    el('browse-results'),
  loadMoreWrap:     el('browse-load-more'),
  loadMoreBtn:      el('load-more-btn'),
  // Templates
  cardTpl:       el('torrent-card-tpl'),
  fileRowTpl:    el('file-row-tpl'),
  resultTpl:     el('result-card-tpl'),
};

/* ── [3] App State ── */
const state = {
  torrents: new Map(),      // infoHash → { torrent, cardEl }
  animFrameId: null,
  lastStats: 0,
  browse: {
    results: [],
    page: 0,
    query: '',
    cat: '0',
    top100: 'all',
  },
};

let WebTorrent = null;
let client = null;

/* ─────────────────────────────────────────────────
   [4] Utilities
───────────────────────────────────────────────── */
function formatBytes(b) {
  if (!b || b <= 0) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}
function formatSpeed(bps) {
  return (!bps || bps < 1) ? '0 B/s' : formatBytes(bps) + '/s';
}
function formatETA(ms) {
  if (!ms || ms === Infinity || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'Done';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function formatAge(unixSeconds) {
  const d = Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
  if (d < 1)   return 'Today';
  if (d < 30)  return d + 'd ago';
  if (d < 365) return Math.floor(d / 30) + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}
function basename(p) { return (p || '').split(/[/\\]/).pop(); }

const FILE_ICONS = {
  mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', wmv:'🎬', webm:'🎬', m4v:'🎬',
  mp3:'🎵', flac:'🎵', aac:'🎵', ogg:'🎵', wav:'🎵', m4a:'🎵',
  jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', bmp:'🖼️',
  pdf:'📄', doc:'📄', docx:'📄', txt:'📄', md:'📄', epub:'📖',
  zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦', xz:'📦',
  iso:'💿', exe:'⚙️', dmg:'💿', apk:'📱', deb:'📦', rpm:'📦',
  json:'📋', xml:'📋', csv:'📋',
};
function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return FILE_ICONS[ext] || '📁';
}

// Generate a unique gradient from a string (for result thumbnails)
function strGradient(str) {
  let h = 0;
  for (const c of str) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
  const hue1 = Math.abs(h) % 360;
  const hue2 = (hue1 + 45) % 360;
  return `linear-gradient(135deg,hsl(${hue1},55%,22%),hsl(${hue2},50%,14%))`;
}

// Build magnet link from info_hash + name
function buildMagnet(infoHash, name) {
  const allTrackers = [...CONFIG.wssTrackers, ...CONFIG.extraTrackers];
  const trPart = allTrackers.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trPart}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove(); return ok;
  }
}

/* ─────────────────────────────────────────────────
   [5] Toast
───────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  dom.torrentList.parentElement; // ensure dom ready
  document.getElementById('toast-container').appendChild(t);
  const dismiss = () => {
    t.classList.add('removing');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  };
  setTimeout(dismiss, 4000);
  t.addEventListener('click', dismiss);
}

/* ─────────────────────────────────────────────────
   [6] WebTorrent loading with many fallbacks
───────────────────────────────────────────────── */
async function loadWebTorrent() {
  for (let i = 0; i < CONFIG.wtSources.length; i++) {
    const src = CONFIG.wtSources[i];
    dom.loaderStatus.textContent = `Loading engine… (${i + 1}/${CONFIG.wtSources.length})`;
    try {
      const mod = await import(/* @vite-ignore */ src);
      const WT = mod.default ?? mod.WebTorrent ?? mod;
      if (typeof WT === 'function') {
        console.info('[TorrentLine] WebTorrent loaded from:', src);
        return WT;
      }
    } catch (err) {
      console.warn(`[TorrentLine] Source ${i + 1} failed (${src}):`, err.message);
    }
  }
  throw new Error('All WebTorrent CDN sources exhausted');
}

/* ─────────────────────────────────────────────────
   [7] Client init
───────────────────────────────────────────────── */
function initClient(WT) {
  client = new WT({ tracker: { announce: CONFIG.wssTrackers } });
  client.on('error', (err) => {
    console.error('[WebTorrent client]', err);
    toast('Engine error: ' + err.message, 'error');
  });
}

/* ─────────────────────────────────────────────────
   [8] Status badge
───────────────────────────────────────────────── */
const STATUS_MAP = {
  connecting: 'Connecting', metadata: 'Metadata',
  downloading: 'Downloading', seeding: 'Seeding',
  done: 'Done', error: 'Error',
};
function setStatus(cardEl, s) {
  const b = cardEl.querySelector('.status-badge');
  b.className = 'status-badge ' + s;
  b.textContent = STATUS_MAP[s] || s;
}

/* ─────────────────────────────────────────────────
   [9] Card stats update
───────────────────────────────────────────────── */
function updateCardStats(cardEl, t) {
  const pct = (t.progress * 100).toFixed(1);
  const fill = cardEl.querySelector('.progress-fill');
  fill.style.width = pct + '%';
  cardEl.querySelector('.progress-track').setAttribute('aria-valuenow', pct);
  cardEl.querySelector('.progress-pct').textContent = pct + '%';
  cardEl.querySelector('.dl-speed').textContent = formatSpeed(t.downloadSpeed);
  cardEl.querySelector('.ul-speed').textContent = formatSpeed(t.uploadSpeed);
  cardEl.querySelector('.peers').textContent = t.numPeers;
  cardEl.querySelector('.eta-val').textContent = formatETA(t.timeRemaining);
  cardEl.querySelector('.dl-total').textContent =
    t.downloaded > 0 ? formatBytes(t.downloaded) + ' / ' + formatBytes(t.length) : '–';
}

/* ─────────────────────────────────────────────────
   [10] File download
───────────────────────────────────────────────── */
async function downloadFile(file, btnEl) {
  btnEl.disabled = true; btnEl.classList.add('loading');
  const origHtml = btnEl.innerHTML;
  btnEl.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:1.5px"></div>';

  try {
    if (file.length > CONFIG.streamThreshold && 'showSaveFilePicker' in window) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: basename(file.name) });
      } catch { resetDlBtn(btnEl, origHtml); return; }
      const writable = await handle.createWritable();
      await file.stream().pipeTo(writable);
    } else {
      const blob = await file.blob();
      const url  = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: basename(file.name), style: 'display:none' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
    btnEl.innerHTML = '✓ Saved';
    btnEl.classList.remove('loading'); btnEl.classList.add('done');
  } catch (err) {
    console.error('[download]', err);
    toast('Download failed: ' + err.message, 'error');
    resetDlBtn(btnEl, origHtml);
  }
}
function resetDlBtn(btnEl, origHtml) {
  btnEl.disabled = false; btnEl.classList.remove('loading', 'done');
  btnEl.innerHTML = origHtml;
}

/* ─────────────────────────────────────────────────
   [11] File list
───────────────────────────────────────────────── */
function renderFileList(cardEl, torrent) {
  const list = cardEl.querySelector('.file-list');
  const countEl = cardEl.querySelector('.file-count');
  list.innerHTML = '';
  countEl.textContent = torrent.files.length;
  torrent.files.forEach((file) => {
    const frag = dom.fileRowTpl.content.cloneNode(true);
    const row  = frag.querySelector('.file-row');
    row.querySelector('.file-icon').textContent = fileIcon(file.name);
    const nameEl = row.querySelector('.file-name');
    nameEl.textContent = basename(file.name);
    nameEl.title = file.name;
    row.querySelector('.file-size').textContent = formatBytes(file.length);
    const btn = row.querySelector('.btn-download');
    const origHtml = btn.innerHTML;
    btn.addEventListener('click', () => downloadFile(file, btn));
    list.appendChild(frag);
  });
}

/* ─────────────────────────────────────────────────
   [12] Torrent card creation & events
───────────────────────────────────────────────── */
function createTorrentCard(torrent) {
  const frag  = dom.cardTpl.content.cloneNode(true);
  const card  = frag.querySelector('.torrent-card');

  card.querySelector('.btn-remove').addEventListener('click', () => {
    removeTorrent(card.dataset.infohash);
  });

  card.querySelector('.btn-copy-magnet').addEventListener('click', async () => {
    const magnet = torrent.magnetURI || buildMagnet(torrent.infoHash, torrent.name || '');
    if (await copyText(magnet)) toast('Magnet link copied!', 'success');
    else toast('Could not copy to clipboard', 'error');
  });

  return card;
}

function bindTorrentEvents(torrent, card) {
  torrent.on('metadata', () => {
    card.dataset.infohash = torrent.infoHash;
    state.torrents.set(torrent.infoHash, { torrent, card });
    card.querySelector('.torrent-name').textContent = torrent.name || 'Unknown';
    card.querySelector('.torrent-size').textContent = formatBytes(torrent.length);
    setStatus(card, 'connecting');
  });

  torrent.on('ready', () => {
    setStatus(card, 'downloading');
    card.querySelector('.progress-fill').classList.add('active');
    renderFileList(card, torrent);
    card.querySelector('.file-list-wrap').open = true;
  });

  torrent.on('done', () => {
    setStatus(card, 'done');
    const fill = card.querySelector('.progress-fill');
    fill.style.width = '100%'; fill.classList.remove('active'); fill.classList.add('done');
    card.querySelector('.progress-pct').textContent = '100%';
    card.querySelector('.dl-speed').textContent = '0 B/s';
    card.querySelector('.eta-val').textContent = 'Done';
    toast('"' + torrent.name + '" finished!', 'success');
  });

  torrent.on('upload', () => { if (torrent.done) setStatus(card, 'seeding'); });

  torrent.on('noPeers', (type) => {
    if (torrent.progress < 1) toast('No peers found (' + type + ')', 'warning');
  });

  torrent.on('error', (err) => {
    setStatus(card, 'error');
    toast('Torrent error: ' + err.message, 'error');
  });
}

/* ─────────────────────────────────────────────────
   [13] Add / remove torrent
───────────────────────────────────────────────── */
function updateDlCount() {
  const n = state.torrents.size;
  dom.dlCount.textContent = n;
  dom.dlCount.classList.toggle('hidden', n === 0);
}

function updateEmptyState() {
  dom.emptyState.style.display = state.torrents.size > 0 ? 'none' : '';
}

function addTorrent(torrentId, displayName) {
  if (!client) { toast('Engine not ready yet', 'warning'); return; }

  // Deduplicate magnet by infohash
  if (typeof torrentId === 'string') {
    const m = torrentId.match(/btih:([a-f0-9]{40}|[a-z2-7]{32})/i);
    if (m && state.torrents.has(m[1].toLowerCase())) {
      toast('Already added', 'warning'); return;
    }
  }

  let torrent;
  try { torrent = client.add(torrentId, { announce: CONFIG.wssTrackers }); }
  catch (e) { toast('Failed to add: ' + e.message, 'error'); return; }

  const card = createTorrentCard(torrent);
  if (displayName) card.querySelector('.torrent-name').textContent = displayName;
  dom.torrentList.prepend(card);

  const tempKey = torrent.infoHash || String(Date.now());
  card.dataset.infohash = tempKey;
  state.torrents.set(tempKey, { torrent, card });
  setStatus(card, 'connecting');

  dom.clientStats.classList.remove('hidden');
  updateEmptyState(); updateDlCount();
  bindTorrentEvents(torrent, card);
}

function removeTorrent(hash) {
  const entry = state.torrents.get(hash);
  if (!entry) return;
  const { torrent, card } = entry;
  client.remove(torrent, { destroyStore: true }, (e) => { if (e) console.warn(e); });
  card.style.animation = 'fade-out .22s ease forwards';
  card.addEventListener('animationend', () => card.remove(), { once: true });
  state.torrents.delete(hash);
  updateEmptyState(); updateDlCount();
  if (!state.torrents.size) dom.clientStats.classList.add('hidden');
}

/* ─────────────────────────────────────────────────
   [14] Input handlers
───────────────────────────────────────────────── */
function handleTorrentFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.torrent')) {
    toast('Please select a .torrent file', 'error'); return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try { addTorrent(new Uint8Array(e.target.result), file.name.replace(/\.torrent$/i, '')); }
    catch { toast('Not a valid .torrent file', 'error'); }
  };
  reader.onerror = () => toast('Could not read file', 'error');
  reader.readAsArrayBuffer(file);
}

function handleMagnetInput() {
  const val = dom.magnetInput.value.trim();
  dom.magnetInput.classList.remove('field-err');
  dom.magnetError.classList.add('hidden');
  if (!val) return;
  if (!val.toLowerCase().startsWith('magnet:?xt=urn:btih:')) {
    dom.magnetInput.classList.add('field-err', 'shake');
    dom.magnetInput.addEventListener('animationend', () => dom.magnetInput.classList.remove('shake'), { once: true });
    dom.magnetError.textContent = 'Must start with magnet:?xt=urn:btih:';
    dom.magnetError.classList.remove('hidden');
    return;
  }
  addTorrent(val);
  dom.magnetInput.value = '';
}

/* ─────────────────────────────────────────────────
   [15] Drop zone
───────────────────────────────────────────────── */
function initDropZone() {
  ['dragenter','dragover','dragleave','drop'].forEach(ev =>
    document.addEventListener(ev, e => e.preventDefault()));

  dom.dropZone.addEventListener('dragenter', (e) => {
    e.stopPropagation(); dom.dropZone.classList.add('drag-active');
  });
  dom.dropZone.addEventListener('dragover', (e) => {
    e.stopPropagation(); dom.dropZone.classList.add('drag-active');
  });
  dom.dropZone.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    if (!dom.dropZone.contains(e.relatedTarget)) dom.dropZone.classList.remove('drag-active');
  });
  dom.dropZone.addEventListener('drop', (e) => {
    e.stopPropagation(); dom.dropZone.classList.remove('drag-active');
    handleTorrentFile(e.dataTransfer.files[0]);
  });
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
  });
  dom.fileInput.addEventListener('change', (e) => {
    handleTorrentFile(e.target.files[0]); dom.fileInput.value = '';
  });
  dom.magnetBtn.addEventListener('click', handleMagnetInput);
  dom.magnetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleMagnetInput(); });
}

/* ─────────────────────────────────────────────────
   [16] Stats loop
───────────────────────────────────────────────── */
function startStatsLoop() {
  function loop(ts) {
    if (ts - state.lastStats >= CONFIG.statsInterval && client) {
      state.lastStats = ts;
      dom.globalDl.textContent = formatSpeed(client.downloadSpeed);
      dom.globalUl.textContent = formatSpeed(client.uploadSpeed);
      for (const { torrent, card } of state.torrents.values()) {
        if (!torrent.done) updateCardStats(card, torrent);
      }
    }
    state.animFrameId = requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/* ─────────────────────────────────────────────────
   [17] Tab navigation
───────────────────────────────────────────────── */
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    const active = p.id === 'tab-' + tabId;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
  if (tabId === 'browse' && state.browse.results.length === 0) {
    loadTop100();
  }
}

/* ─────────────────────────────────────────────────
   [18] Browse — TPB API
───────────────────────────────────────────────── */
const CAT_META = {
  '0':   { label: 'All',      icon: '🌐' },
  '401': { label: 'PC Game',  icon: '🎮' },
  '400': { label: 'Game',     icon: '🎮' },
  '300': { label: 'Software', icon: '💻' },
  '301': { label: 'Software', icon: '💻' },
  '201': { label: 'Movie',    icon: '🎬' },
  '200': { label: 'Video',    icon: '🎬' },
  '205': { label: 'TV Show',  icon: '📺' },
  '101': { label: 'Music',    icon: '🎵' },
  '100': { label: 'Music',    icon: '🎵' },
  '601': { label: 'Book',     icon: '📚' },
  '600': { label: 'Other',    icon: '📦' },
};
function catMeta(id) { return CAT_META[id] || { label: 'Other', icon: '📦' }; }

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  // TPB returns [{"id":"0","name":"No results returned"}] for no results
  if (Array.isArray(data) && data.length === 1 && data[0].id === '0') return [];
  return data;
}

async function loadTop100() {
  const top100key = state.browse.top100 || 'all';
  setBrowseLoading(true);
  try {
    const data = await apiFetch(`${CONFIG.apiBase}/precompiled/data_top100_${top100key}.json`);
    state.browse.results = data;
    state.browse.page = 0;
    renderResults(data, '', true);
    dom.resultCount.textContent = data.length + ' trending';
    dom.queryLabel.textContent = '';
    dom.browseStatusBar.classList.remove('hidden');
  } catch (e) {
    console.warn('[browse top100]', e);
    showBrowseError('Could not load trending. Try searching manually.');
  } finally { setBrowseLoading(false); }
}

async function doSearch(query, cat) {
  if (!query.trim()) { loadTop100(); return; }
  setBrowseLoading(true);
  try {
    const url = `${CONFIG.apiBase}/q.php?q=${encodeURIComponent(query.trim())}&cat=${cat}`;
    const data = await apiFetch(url);
    state.browse.results = data;
    state.browse.page = 0;
    state.browse.query = query.trim();
    renderResults(data, query.trim(), true);
    dom.resultCount.textContent = data.length + ' results';
    dom.queryLabel.textContent = 'for "' + query.trim() + '"';
    dom.browseStatusBar.classList.remove('hidden');
  } catch (e) {
    console.error('[browse search]', e);
    showBrowseError('Search failed: ' + e.message + '. Check your connection.');
  } finally { setBrowseLoading(false); }
}

function setBrowseLoading(on) {
  dom.browseLoading.classList.toggle('hidden', !on);
  dom.browseEmpty.classList.add('hidden');
  dom.browseError.classList.add('hidden');
  if (on) dom.browseResults.innerHTML = '';
}

function showBrowseError(msg) {
  dom.browseErrorMsg.textContent = msg;
  dom.browseError.classList.remove('hidden');
  dom.browseResults.innerHTML = '';
}

function renderResults(results, query, replace = false) {
  if (!results || results.length === 0) {
    dom.browseEmpty.querySelector('.empty-title').textContent = 'No results found';
    dom.browseEmpty.querySelector('.empty-sub').textContent = 'Try different keywords or a different category.';
    dom.browseEmpty.classList.remove('hidden');
    dom.loadMoreWrap.classList.add('hidden');
    return;
  }
  if (replace) dom.browseResults.innerHTML = '';

  const start  = replace ? 0 : state.browse.page * CONFIG.resultsPerPage;
  const slice  = results.slice(start, start + CONFIG.resultsPerPage);

  const frag = document.createDocumentFragment();
  slice.forEach((r) => frag.appendChild(buildResultCard(r)));
  dom.browseResults.appendChild(frag);

  const shown = Math.min((state.browse.page + 1) * CONFIG.resultsPerPage, results.length);
  dom.loadMoreWrap.classList.toggle('hidden', shown >= results.length);
}

function buildResultCard(r) {
  const tpl   = dom.resultTpl.content.cloneNode(true);
  const card  = tpl.querySelector('.result-card');
  const meta  = catMeta(String(r.category));
  const seeds = parseInt(r.seeders) || 0;
  const leech = parseInt(r.leechers) || 0;
  const seedClass = seeds >= 10 ? 'seed-good' : seeds >= 1 ? 'seed-mid' : 'seed-low';
  const seedPct   = Math.min(seeds / 100, 1) * 100;
  const magnet = buildMagnet(r.info_hash, r.name);

  card.querySelector('.result-thumb').style.background = strGradient(r.name);
  card.querySelector('.result-cat-icon').textContent = meta.icon;
  card.querySelector('.result-name').textContent = r.name;
  card.querySelector('.result-size').textContent = formatBytes(parseInt(r.size));
  card.querySelector('.result-age').textContent = r.added ? formatAge(parseInt(r.added)) : '';
  card.querySelector('.result-cat-label').textContent = meta.label;
  card.querySelector('.result-seeds').classList.add(seedClass);
  card.querySelector('.result-seeds-num').textContent = seeds;
  card.querySelector('.result-leech-num').textContent = leech;
  card.querySelector('.seed-bar-fill').style.width = seedPct + '%';

  const dlBtn = card.querySelector('.btn-dl-result');
  dlBtn.addEventListener('click', () => {
    addTorrent(magnet, r.name);
    dlBtn.textContent = '✓ Added';
    dlBtn.classList.add('added');
    dlBtn.disabled = true;
    switchTab('downloads');
    toast('Added: ' + r.name.slice(0, 40) + (r.name.length > 40 ? '…' : ''), 'success');
  });

  card.querySelector('.btn-copy-result').addEventListener('click', async () => {
    if (await copyText(magnet)) toast('Magnet link copied!', 'success');
    else toast('Copy failed', 'error');
  });

  return card;
}

/* ─────────────────────────────────────────────────
   [19] Init
───────────────────────────────────────────────── */
async function init() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Empty state "browse torrents" link
  dom.emptyState.querySelector('.inline-btn').addEventListener('click', () => switchTab('browse'));

  // Category tabs
  dom.browseCats.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dom.browseCats.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.browse.cat = btn.dataset.cat;
      state.browse.top100 = btn.dataset.top100;
      const q = dom.browseSearch.value.trim();
      if (q) doSearch(q, btn.dataset.cat);
      else loadTop100();
    });
  });

  // Search
  dom.browseSearchBtn.addEventListener('click', () => doSearch(dom.browseSearch.value, state.browse.cat));
  dom.browseSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(dom.browseSearch.value, state.browse.cat);
  });
  dom.browseSearch.addEventListener('input', () => {
    dom.browseClear.classList.toggle('hidden', !dom.browseSearch.value);
  });
  dom.browseClear.addEventListener('click', () => {
    dom.browseSearch.value = ''; dom.browseClear.classList.add('hidden');
    loadTop100();
  });

  // Load more
  dom.loadMoreBtn.addEventListener('click', () => {
    state.browse.page++;
    renderResults(state.browse.results, state.browse.query, false);
  });

  // Retry
  dom.browseRetry.addEventListener('click', () => {
    const q = dom.browseSearch.value.trim();
    if (q) doSearch(q, state.browse.cat); else loadTop100();
  });

  // Paste detection anywhere on page
  document.addEventListener('paste', (e) => {
    if (document.activeElement === dom.magnetInput || document.activeElement === dom.browseSearch) return;
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (text.toLowerCase().startsWith('magnet:?xt=urn:btih:')) {
      e.preventDefault();
      addTorrent(text);
      toast('Magnet link added from clipboard!', 'success');
    }
  });

  // Load WebTorrent with fallbacks
  dom.loaderStatus.textContent = 'Loading engine…';
  try {
    WebTorrent = await loadWebTorrent();
    initClient(WebTorrent);
  } catch (err) {
    dom.loaderStatus.textContent = 'Failed to load engine';
    dom.compatWarn.textContent = '⚠ Could not load WebTorrent. Check your internet connection and try reloading. ' + err.message;
    dom.compatWarn.classList.remove('hidden');
    console.error(err);
  }

  // Check WebRTC
  if (typeof RTCPeerConnection === 'undefined') {
    dom.compatWarn.textContent = '⚠ Your browser does not support WebRTC — torrents cannot connect to peers.';
    dom.compatWarn.classList.remove('hidden');
  }

  initDropZone();
  startStatsLoop();
  updateEmptyState();

  // Hide loading overlay
  dom.loaderStatus.textContent = 'Ready';
  setTimeout(() => {
    dom.overlay.classList.add('fade-out');
    setTimeout(() => dom.overlay.remove(), 420);
  }, 300);

  console.info('[TorrentLine] ready');
}

// Start
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
