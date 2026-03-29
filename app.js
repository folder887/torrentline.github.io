(function () {
  'use strict';

  /* ── [1] Config ── */
  const CONFIG = {
    trackers: [
      'wss://tracker.btorrent.xyz',
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
    ],
    statsInterval: 250,       // ms between UI stats updates
    streamThreshold: 512 * 1024 * 1024, // 512 MB — use streaming above this
  };

  const FILE_ICONS = {
    // Video
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', wmv: '🎬', webm: '🎬', m4v: '🎬',
    // Audio
    mp3: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', wav: '🎵', m4a: '🎵',
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    // Docs
    pdf: '📄', doc: '📄', docx: '📄', txt: '📄', md: '📄', epub: '📖',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    // Code / data
    json: '📋', xml: '📋', csv: '📋', iso: '💿', exe: '⚙️', dmg: '💿',
  };

  /* ── [2] DOM References ── */
  const $ = (id) => document.getElementById(id);
  const els = {
    header:       $('app-header'),
    clientStats:  $('client-stats'),
    globalDl:     $('global-dl'),
    globalUl:     $('global-ul'),
    compatWarn:   $('compat-warning'),
    dropZone:     $('drop-zone'),
    fileInput:    $('file-input'),
    magnetInput:  $('magnet-input'),
    magnetBtn:    $('magnet-btn'),
    magnetError:  $('magnet-error'),
    emptyState:   $('empty-state'),
    torrentList:  $('torrent-list'),
    toastCont:    $('toast-container'),
    cardTpl:      $('torrent-card-tpl'),
    fileRowTpl:   $('file-row-tpl'),
  };

  /* ── [3] State ── */
  const state = {
    torrents: new Map(),   // infoHash → { torrent, cardEl }
    animFrameId: null,
    lastStats: 0,
  };

  /* ── [4] Browser Support Check ── */
  function checkSupport() {
    const issues = [];
    if (typeof WebTorrent === 'undefined') issues.push('WebTorrent failed to load (check your connection)');
    if (typeof RTCPeerConnection === 'undefined') issues.push('WebRTC is not supported in this browser');
    if (!window.fetch) issues.push('Fetch API not available');
    if (issues.length) {
      els.compatWarn.textContent = '⚠ ' + issues.join('; ');
      els.compatWarn.classList.remove('hidden');
    }
    return issues.length === 0;
  }

  /* ── [5] WebTorrent Client ── */
  let client;

  function initClient() {
    client = new WebTorrent({
      tracker: { announce: CONFIG.trackers },
    });

    client.on('error', (err) => {
      showToast('Client error: ' + err.message, 'error');
      console.error('[WebTorrent]', err);
    });
  }

  /* ── [6] Utility Functions ── */
  function formatBytes(bytes) {
    if (bytes === 0 || bytes == null) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
  }

  function formatSpeed(bps) {
    if (!bps || bps < 1) return '0 B/s';
    return formatBytes(bps) + '/s';
  }

  function formatETA(ms) {
    if (!ms || ms === Infinity || ms < 0) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 5)  return 'Done';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function fileIcon(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return FILE_ICONS[ext] || '📁';
  }

  function basename(path) {
    return path.split(/[\\/]/).pop();
  }

  /* ── [7] Toast Notifications ── */
  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    els.toastCont.appendChild(toast);

    const dismiss = () => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };

    setTimeout(dismiss, 4000);
    toast.addEventListener('click', dismiss);
  }

  /* ── [8] Status Badge ── */
  const STATUS_LABELS = {
    connecting:  'Connecting',
    metadata:    'Metadata',
    downloading: 'Downloading',
    seeding:     'Seeding',
    done:        'Done',
    error:       'Error',
    paused:      'Paused',
  };

  function setStatus(cardEl, status) {
    const badge = cardEl.querySelector('.status-badge');
    badge.className = 'status-badge ' + status;
    badge.textContent = STATUS_LABELS[status] || status;
  }

  /* ── [9] Empty State ── */
  function updateEmptyState() {
    if (state.torrents.size === 0) {
      els.emptyState.style.display = '';
    } else {
      els.emptyState.style.display = 'none';
    }
  }

  /* ── [10] Card Stats Update ── */
  function updateCardStats(cardEl, torrent) {
    const pct = (torrent.progress * 100).toFixed(1);
    const fill = cardEl.querySelector('.progress-fill');
    fill.style.width = pct + '%';
    cardEl.querySelector('.progress-track').setAttribute('aria-valuenow', pct);
    cardEl.querySelector('.progress-pct').textContent = pct + '%';
    cardEl.querySelector('.dl-speed').textContent  = formatSpeed(torrent.downloadSpeed);
    cardEl.querySelector('.ul-speed').textContent  = formatSpeed(torrent.uploadSpeed);
    cardEl.querySelector('.peers').textContent     = torrent.numPeers;
    cardEl.querySelector('.eta-val').textContent   = formatETA(torrent.timeRemaining);
  }

  /* ── [11] File Download ── */
  async function downloadFile(file, btnEl) {
    btnEl.disabled = true;
    btnEl.classList.add('loading');
    btnEl.innerHTML = '…';

    try {
      // Large files: use File System Access API if available (streaming, no memory bloat)
      if (file.length > CONFIG.streamThreshold && 'showSaveFilePicker' in window) {
        let handle;
        try {
          handle = await window.showSaveFilePicker({ suggestedName: basename(file.name) });
        } catch (e) {
          // User cancelled picker
          resetBtn(btnEl);
          return;
        }
        const writable = await handle.createWritable();
        const readable = file.stream();
        await readable.pipeTo(writable);
      } else {
        // Standard path: load into memory as Blob
        const blob = await file.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = basename(file.name);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      }

      btnEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 7l4 4 7-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Saved';
      btnEl.classList.remove('loading');
      btnEl.classList.add('done');
    } catch (err) {
      console.error('[download]', err);
      showToast('Download failed: ' + err.message, 'error');
      resetBtn(btnEl);
    }
  }

  function resetBtn(btnEl) {
    btnEl.disabled = false;
    btnEl.classList.remove('loading', 'done');
    btnEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v8M6.5 9l-3-3M6.5 9l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> Retry';
  }

  /* ── [12] File List Renderer ── */
  function renderFileList(cardEl, torrent) {
    const listEl  = cardEl.querySelector('.file-list');
    const countEl = cardEl.querySelector('.file-count');
    listEl.innerHTML = '';
    countEl.textContent = torrent.files.length;

    torrent.files.forEach((file) => {
      const tpl  = els.fileRowTpl.content.cloneNode(true);
      const row  = tpl.querySelector('.file-row');
      const icon = row.querySelector('.file-icon');
      const name = row.querySelector('.file-name');
      const size = row.querySelector('.file-size');
      const btn  = row.querySelector('.btn-download');

      icon.textContent      = fileIcon(file.name);
      name.textContent      = basename(file.name);
      name.title            = file.name;
      size.textContent      = formatBytes(file.length);
      btn.addEventListener('click', () => downloadFile(file, btn));

      listEl.appendChild(tpl);
    });
  }

  /* ── [13] Torrent Card Creator ── */
  function createTorrentCard(torrent) {
    const tpl    = els.cardTpl.content.cloneNode(true);
    const cardEl = tpl.querySelector('.torrent-card');
    const removeBtn = cardEl.querySelector('.btn-remove');

    // We'll set the infoHash as a data attr once metadata arrives
    removeBtn.addEventListener('click', () => {
      const hash = cardEl.dataset.infohash;
      if (hash) removeTorrent(hash);
    });

    return cardEl;
  }

  /* ── [14] Torrent Event Binding ── */
  function bindTorrentEvents(torrent, cardEl) {
    torrent.on('metadata', () => {
      cardEl.dataset.infohash = torrent.infoHash;
      // Re-key state map with real infoHash
      // (was keyed by magnetURI or temp key before)
      state.torrents.set(torrent.infoHash, { torrent, cardEl });

      const nameEl = cardEl.querySelector('.torrent-name');
      const sizeEl = cardEl.querySelector('.torrent-size');
      nameEl.textContent = torrent.name || 'Unknown';
      sizeEl.textContent = formatBytes(torrent.length);
      setStatus(cardEl, 'connecting');
    });

    torrent.on('ready', () => {
      setStatus(cardEl, 'downloading');
      cardEl.querySelector('.progress-fill').classList.add('active');
      renderFileList(cardEl, torrent);
      // Show file list open by default
      cardEl.querySelector('.file-list-wrap').open = true;
    });

    torrent.on('download', () => {
      // Heavy events — stats loop handles UI updates; just ensure status is right
      if (torrent.progress > 0 && torrent.progress < 1) {
        const badge = cardEl.querySelector('.status-badge');
        if (!badge.classList.contains('downloading')) {
          setStatus(cardEl, 'downloading');
        }
      }
    });

    torrent.on('done', () => {
      setStatus(cardEl, 'done');
      const fill = cardEl.querySelector('.progress-fill');
      fill.style.width = '100%';
      fill.classList.remove('active');
      fill.classList.add('done');
      cardEl.querySelector('.progress-pct').textContent = '100%';
      cardEl.querySelector('.dl-speed').textContent = '0 B/s';
      cardEl.querySelector('.eta-val').textContent  = 'Done';
      showToast('"' + torrent.name + '" finished!', 'success');
    });

    torrent.on('upload', () => {
      if (torrent.done) setStatus(cardEl, 'seeding');
    });

    torrent.on('noPeers', (type) => {
      if (torrent.progress < 1) {
        showToast('No peers found (' + type + ')', 'warning');
      }
    });

    torrent.on('error', (err) => {
      setStatus(cardEl, 'error');
      showToast('Torrent error: ' + err.message, 'error');
    });
  }

  /* ── [15] Add Torrent ── */
  function addTorrent(torrentId, displayName) {
    // Check for duplicates
    if (typeof torrentId === 'string') {
      // magnet link — extract infohash to deduplicate
      const match = torrentId.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
      if (match) {
        const hash = match[1].toLowerCase();
        if (state.torrents.has(hash)) {
          showToast('Torrent already added', 'warning');
          return;
        }
      }
    }

    let torrent;
    try {
      torrent = client.add(torrentId, { announce: CONFIG.trackers });
    } catch (e) {
      showToast('Failed to add: ' + e.message, 'error');
      return;
    }

    const cardEl = createTorrentCard(torrent);
    if (displayName) cardEl.querySelector('.torrent-name').textContent = displayName;

    els.torrentList.prepend(cardEl);
    updateEmptyState();

    // Temp key until metadata arrives
    const tempKey = torrent.infoHash || torrent.magnetURI || Date.now().toString();
    state.torrents.set(tempKey, { torrent, cardEl });
    cardEl.dataset.infohash = tempKey;

    setStatus(cardEl, 'connecting');

    // Show global stats bar
    els.clientStats.classList.remove('hidden');

    bindTorrentEvents(torrent, cardEl);
  }

  /* ── [16] Remove Torrent ── */
  function removeTorrent(infoHash) {
    const entry = state.torrents.get(infoHash);
    if (!entry) return;
    const { torrent, cardEl } = entry;

    client.remove(torrent, { destroyStore: true }, (err) => {
      if (err) console.warn('[remove]', err);
    });

    cardEl.style.animation = 'fade-out 0.2s ease forwards';
    cardEl.addEventListener('animationend', () => cardEl.remove(), { once: true });

    state.torrents.delete(infoHash);
    updateEmptyState();

    if (state.torrents.size === 0) {
      els.clientStats.classList.add('hidden');
    }
  }

  /* ── [17] File Input Handler ── */
  function handleTorrentFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.torrent')) {
      showToast('Please select a .torrent file', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // WebTorrent browser build includes Buffer global
        const buf = typeof Buffer !== 'undefined'
          ? Buffer.from(e.target.result)
          : new Uint8Array(e.target.result);
        addTorrent(buf, file.name.replace(/\.torrent$/i, ''));
      } catch (err) {
        showToast('Invalid .torrent file', 'error');
      }
    };
    reader.onerror = () => showToast('Could not read file', 'error');
    reader.readAsArrayBuffer(file);
  }

  /* ── [18] Magnet Input Handler ── */
  function handleMagnetInput() {
    const val = els.magnetInput.value.trim();

    // Clear error state
    els.magnetInput.classList.remove('error');
    els.magnetError.classList.add('hidden');
    els.magnetError.textContent = '';

    if (!val) return;

    if (!val.toLowerCase().startsWith('magnet:?xt=urn:btih:')) {
      els.magnetInput.classList.add('error', 'shake');
      els.magnetInput.addEventListener('animationend', () => {
        els.magnetInput.classList.remove('shake');
      }, { once: true });
      els.magnetError.textContent = 'Must be a valid magnet link (magnet:?xt=urn:btih:…)';
      els.magnetError.classList.remove('hidden');
      return;
    }

    addTorrent(val);
    els.magnetInput.value = '';
  }

  /* ── [19] Drop Zone ── */
  function initDropZone() {
    // Prevent browser from opening files on drop anywhere
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
      document.addEventListener(evt, (e) => e.preventDefault());
    });

    els.dropZone.addEventListener('dragenter', (e) => {
      e.stopPropagation();
      els.dropZone.classList.add('drag-active');
    });

    els.dropZone.addEventListener('dragover', (e) => {
      e.stopPropagation();
      els.dropZone.classList.add('drag-active');
    });

    els.dropZone.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      if (!els.dropZone.contains(e.relatedTarget)) {
        els.dropZone.classList.remove('drag-active');
      }
    });

    els.dropZone.addEventListener('drop', (e) => {
      e.stopPropagation();
      els.dropZone.classList.remove('drag-active');
      const file = e.dataTransfer.files[0];
      handleTorrentFile(file);
    });

    els.dropZone.addEventListener('click', () => els.fileInput.click());

    els.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        els.fileInput.click();
      }
    });

    els.fileInput.addEventListener('change', (e) => {
      handleTorrentFile(e.target.files[0]);
      els.fileInput.value = ''; // reset so same file can be re-added
    });
  }

  /* ── [20] Stats RAF Loop ── */
  function startStatsLoop() {
    function loop(ts) {
      if (ts - state.lastStats >= CONFIG.statsInterval) {
        state.lastStats = ts;

        // Global header stats
        if (client) {
          els.globalDl.textContent = formatSpeed(client.downloadSpeed);
          els.globalUl.textContent = formatSpeed(client.uploadSpeed);
        }

        // Per-card stats
        for (const { torrent, cardEl } of state.torrents.values()) {
          if (!torrent.done) updateCardStats(cardEl, torrent);
        }
      }
      state.animFrameId = requestAnimationFrame(loop);
    }
    state.animFrameId = requestAnimationFrame(loop);
  }

  /* ── [21] Init ── */
  function init() {
    if (!checkSupport()) return;

    initClient();
    initDropZone();
    startStatsLoop();

    // Magnet button & Enter key
    els.magnetBtn.addEventListener('click', handleMagnetInput);
    els.magnetInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleMagnetInput();
    });

    // Paste detection for magnet links
    document.addEventListener('paste', (e) => {
      const active = document.activeElement;
      // Only auto-add if user isn't already in the magnet input
      if (active === els.magnetInput) return;
      const text = (e.clipboardData || window.clipboardData).getData('text').trim();
      if (text.toLowerCase().startsWith('magnet:?xt=urn:btih:')) {
        e.preventDefault();
        addTorrent(text);
        showToast('Magnet link added from clipboard', 'info');
      }
    });

    updateEmptyState();
    console.info('[TorrentLine] ready');
  }

  // Wait for DOM + WebTorrent script
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
