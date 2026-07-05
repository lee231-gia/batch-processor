(function() {
  'use strict';

  /* ── State ── */
  let files = [];
  let results = [];
  let isProcessing = false;
  let isPaused = false;
  let selectedIds = new Set();
  let previewFileId = null;
  let processingStartTime = 0;
  let totalProcessedCount = 0;

  const PIPELINE_STAGES = {
    idle: { icon: '○', label: 'Queued' },
    reading: { icon: '📖', label: 'Reading file' },
    detecting: { icon: '🔍', label: 'Detecting type' },
    analyzing: { icon: '📊', label: 'Analyzing quality' },
    preprocessing: { icon: '🛠', label: 'Preprocessing' },
    orienting: { icon: '🔄', label: 'Detecting orientation' },
    ocr: { icon: '👁', label: 'OCR' },
    iteration1: { icon: '①', label: 'Iteration 1' },
    iteration2: { icon: '②', label: 'Iteration 2' },
    iteration3: { icon: '③', label: 'Iteration 3' },
    consensus: { icon: '⚖', label: 'Consensus check' },
    critique: { icon: '🔎', label: 'Validating output' },
    audio: { icon: '🎤', label: 'Transcribing audio' },
    video: { icon: '🎬', label: 'Processing video' },
    building: { icon: '📐', label: 'Building structure' },
    done: { icon: '✓', label: 'Complete' },
    error: { icon: '⚠', label: 'Failed' },
  };

  const STRATEGY_LABELS_BY_KEY = {
    standard: 'Standard grayscale',
    contrast: 'Enhanced contrast',
    sharpened: 'Sharpened + contrast',
    threshold: 'Adaptive threshold',
    upscaled: '2x upscaled',
    despeckle: 'Denoised',
    aggresive: 'Aggressive enhance',
  };

  /* ── Processors ── */
  const ocrProc = new OcrProcessor();
  const audioProc = new AudioProcessor();
  const videoProc = new VideoProcessor(ocrProc, audioProc);
  const structPreserver = new StructurePreserver();
  const exportMgr = new ExportManager();

  /* ── DOM refs: existing ── */
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const queueSection = document.getElementById('queueSection');
  const exportSection = document.getElementById('exportSection');
  const fileCount = document.getElementById('fileCount');
  const doneCount = document.getElementById('doneCount');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportBtn = document.getElementById('exportBtn');
  const copyBtn = document.getElementById('copyBtn');
  const layoutMode = document.getElementById('layoutMode');
  const exportFormat = document.getElementById('exportFormat');
  const langSelect = document.getElementById('langSelect');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsClose = document.getElementById('settingsClose');
  const mergeAll = document.getElementById('mergeAll');
  const genPdf = document.getElementById('genPdf');
  const genDocx = document.getElementById('genDocx');
  const videoMode = document.getElementById('videoMode');
  const maxWorkers = document.getElementById('maxWorkers');
  const urlInput = document.getElementById('urlInput');
  const urlAddBtn = document.getElementById('urlAddBtn');

  /* ── DOM refs: new ── */
  const mainArea = document.getElementById('mainArea');
  const leftPanel = document.getElementById('leftPanel');
  const centerPanel = document.getElementById('centerPanel');
  const rightPanel = document.getElementById('rightPanel');
  const leftResize = document.getElementById('leftResize');
  const centerResize = document.getElementById('centerResize');
  const searchInput = document.getElementById('searchInput');
  const filterSelect = document.getElementById('filterSelect');
  const selectCount = document.getElementById('selectCount');
  const copySelectedBtn = document.getElementById('copySelectedBtn');
  const statusText = document.getElementById('statusText');
  const statusProgress = document.getElementById('statusProgress');
  const statusTime = document.getElementById('statusTime');
  const statusSpeed = document.getElementById('statusSpeed');
  const statusErrors = document.getElementById('statusErrors');
  const queueErrors = document.getElementById('queueErrors');
  const queueStats = document.getElementById('queueStats');
  const queueProgressText = document.getElementById('queueProgressText');
  const previewContent = document.getElementById('previewContent');
  const previewTabsEl = document.getElementById('previewTabs');
  const previewFileName = document.getElementById('previewFileName');
  const previewCloseBtn = document.getElementById('previewCloseBtn');
  const outputText = document.getElementById('outputText');
  const outputSearch = document.getElementById('outputSearch');
  const themeToggle = document.getElementById('themeToggle');
  const contextMenu = document.getElementById('contextMenu');
  const urlInputBar = document.getElementById('urlInputBar');
  const urlCloseBtn = document.getElementById('urlCloseBtn');

  /* ── Layout persistence ── */
  let leftWidth = parseInt(localStorage.getItem('bp_leftWidth')) || 320;
  let rightWidth = parseInt(localStorage.getItem('bp_rightWidth')) || 380;
  leftPanel.style.width = leftWidth + 'px';
  rightPanel.style.width = rightWidth + 'px';

  /* ── Theme ── */
  if (localStorage.getItem('bp_theme') === 'light') {
    document.body.classList.add('light');
    themeToggle.textContent = '☀️';
  }

  /* ── Event listeners: existing ── */
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => {
    if (fileInput.files) { handleFiles(fileInput.files); fileInput.value = ''; }
  });

  settingsBtn.addEventListener('click', () => settingsPanel.classList.remove('hidden'));
  settingsClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));

  layoutMode.addEventListener('change', () => {
    exportMgr.setLayoutMode(layoutMode.value);
    refreshTextPreviews();
  });

  startBtn.addEventListener('click', startProcessing);
  pauseBtn.addEventListener('click', togglePause);
  clearBtn.addEventListener('click', (e) => showContextMenuItems(e, 'clear'));
  exportBtn.addEventListener('click', handleExport);
  copyBtn.addEventListener('click', handleCopyAll);

  videoMode.addEventListener('change', () => videoProc.setVideoMode(videoMode.value));
  langSelect.addEventListener('change', () => ocrProc.setLang(langSelect.value));
  maxWorkers.addEventListener('change', () => ocrProc.setMaxWorkers(parseInt(maxWorkers.value) || 4));

  document.getElementById('testBtn').addEventListener('click', async () => {
    if (!window.runOcrAccuracyTest) return setStatus('Test runner not loaded');
    const btn = document.getElementById('testBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ <span class="tb-label">Testing...</span>';
    try {
      await window.runOcrAccuracyTest();
    } catch (e) {
      console.error('Test failed:', e);
      alert('Test failed: ' + e.message);
    }
    btn.disabled = false;
    btn.innerHTML = '🧪 <span class="tb-label">Test</span>';
  });

  urlAddBtn.addEventListener('click', handleUrlInput);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUrlInput(); });

  /* ── Event listeners: new ── */
  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light');
    const isLight = document.body.classList.contains('light');
    themeToggle.textContent = isLight ? '☀️' : '🌙';
    localStorage.setItem('bp_theme', isLight ? 'light' : 'dark');
  });

  previewCloseBtn.addEventListener('click', closePreview);

  searchInput.addEventListener('input', renderFileList);
  filterSelect.addEventListener('change', renderFileList);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T' && window.runOcrAccuracyTest) {
      e.preventDefault();
      window.runOcrAccuracyTest().catch(console.error);
    }
  });

  outputSearch.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const text = document.getElementById('outputText');
    if (!q) { text.style.outline = 'none'; return; }
    const idx = text.value.toLowerCase().indexOf(q);
    if (idx >= 0) {
      text.focus();
      text.setSelectionRange(idx, idx + q.length);
      text.style.outline = '2px solid var(--accent)';
    } else {
      text.style.outline = '2px solid var(--danger)';
    }
    setTimeout(() => text.style.outline = 'none', 3000);
  });

  document.addEventListener('click', () => { if (contextMenu) contextMenu.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!contextMenu.classList.contains('hidden')) contextMenu.classList.add('hidden');
      if (!urlInputBar.classList.contains('hidden')) urlInputBar.classList.add('hidden');
      if (!settingsPanel.classList.contains('hidden')) settingsPanel.classList.add('hidden');
    }
    if (e.ctrlKey && e.key === 'a' && e.target.closest('#fileList')) {
      e.preventDefault();
      selectAll();
    }
    if (e.ctrlKey && e.key === 'c' && selectedIds.size > 0) {
      copySelected();
    }
  });

  copySelectedBtn.addEventListener('click', copySelected);

  document.getElementById('addFilesBtn').addEventListener('click', () => fileInput.click());
  document.getElementById('addFolderBtn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.webkitdirectory = true;
    inp.multiple = true;
    inp.onchange = () => { if (inp.files) handleFiles(inp.files); };
    inp.click();
  });
  document.getElementById('clipboardBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) addTextEntry(text);
    } catch (_) { /* fallback */ }
  });
  document.getElementById('cameraBtn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.capture = 'environment';
    inp.onchange = () => { if (inp.files) handleFiles(inp.files); };
    inp.click();
  });
  document.getElementById('toolbarUrlBtn').addEventListener('click', () => {
    urlInputBar.classList.remove('hidden');
    urlInput.focus();
  });
  urlCloseBtn.addEventListener('click', () => urlInputBar.classList.add('hidden'));

  /* ── Init message ── */
  const dropTitle = document.querySelector('.drop-title');
  const dropSub = document.querySelector('.drop-sub');
  dropTitle.textContent = 'Initializing…';
  dropSub.textContent = 'Loading OCR engine';

  Promise.all([
    ocrProc.init().catch(e => console.warn('OCR init:', e)),
    audioProc.init().catch(e => console.warn('Audio init:', e)),
  ]).then(() => {
    dropTitle.textContent = 'Drag & drop here';
    dropSub.textContent = 'or click to browse';
    setStatus('Ready');
  });

  /* ══════════════════════════════════════════════════════════════
     FILE MANAGEMENT
     ══════════════════════════════════════════════════════════════ */

  function getTypeIcon(type) {
    switch (type) {
      case 'img': return '📷';
      case 'audio': return '🎵';
      case 'video': return '🎬';
      case 'text': return '📄';
      case 'link': return '🔗';
      default: return '📄';
    }
  }

  function classifyFile(file) {
    const name = file.name.toLowerCase();
    const type = file.type;
    if (type.startsWith('image/') || /\.(png|jpg|jpeg|webp|bmp|tiff?)$/i.test(name)) return 'img';
    if (type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|wma|aac)$/i.test(name)) return 'audio';
    if (type.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|wmv|flv)$/i.test(name)) return 'video';
    if (type === 'text/plain' || /\.txt$/i.test(name)) return 'text';
    if (/\.(md|markdown)$/i.test(name)) return 'text';
    return null;
  }

  function handleFiles(fileList) {
    const newFiles = [];
    for (const file of fileList) {
      const type = classifyFile(file);
      if (!type) continue;
      newFiles.push({
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random(),
        file, name: file.name, size: file.size, type,
        status: 'queued', progress: 0, result: null,
        stage: 'idle', stageStart: 0, pipelineStages: [],
        confidence: 0, wordCount: 0, error: null,
        tags: [], language: 'eng',
      });
    }
    if (newFiles.length === 0) return;
    files = files.concat(newFiles);

    renderFileList();
    updateQueueVisibility();
    updateStartButton();
    setStatus(`Added ${newFiles.length} file(s)`);
  }

  function addUrlEntry(url) {
    files.push({
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random(),
      url, name: url.substring(0, 50) + (url.length > 50 ? '…' : ''),
      type: 'link', status: 'queued', progress: 0, result: null,
      stage: 'idle', stageStart: 0, pipelineStages: [],
      confidence: 0, wordCount: 0, error: null, tags: [], language: 'eng',
    });
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  function addTextEntry(text) {
    const firstLine = text.split('\n')[0].substring(0, 50);
    files.push({
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random(),
      text, name: 'Text: ' + firstLine + (text.length > 50 ? '…' : ''),
      type: 'text', status: 'queued', progress: 0, result: null,
      stage: 'idle', stageStart: 0, pipelineStages: [],
      confidence: 0, wordCount: 0, error: null, tags: [], language: 'eng',
    });
    const dropZoneEl = document.querySelector('.mini-drop');
    if (dropZoneEl) dropZoneEl.style.display = 'none';
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  async function handleUrlInput() {
    const val = urlInput.value.trim();
    if (!val) return;
    urlInput.value = '';
    urlInputBar.classList.add('hidden');
    if (val.startsWith('http://') || val.startsWith('https://')) {
      addUrlEntry(val);
    } else {
      addTextEntry(val);
    }
  }

  /* ── File helpers ── */
  function getFile(id) { return files.find(f => f.id === id); }

  function getFilteredFiles() {
    const q = searchInput.value.toLowerCase().trim();
    const filter = filterSelect.value;
    return files.filter(f => {
      if (filter !== 'all' && filter !== f.type && f.status !== filter) return false;
      if (q && !f.name.toLowerCase().includes(q) && !(f.result && (f.result.text || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  /* ══════════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════════ */

  function renderFileList() {
    fileList.innerHTML = '';
    const filtered = getFilteredFiles();

    for (const f of filtered) {
      const div = document.createElement('div');
      div.className = 'file-item' + (selectedIds.has(f.id) ? ' selected' : '') + (f.status === 'done' ? ' done' : '');
      div.dataset.id = f.id;

      let previewHtml;
      if (f.type === 'img' && f.file) {
        previewHtml = `<img class="preview" src="${URL.createObjectURL(f.file)}" alt="">`;
      } else if (f.type === 'link') {
        previewHtml = `<div class="preview audio">🔗</div>`;
      } else {
        previewHtml = `<div class="preview audio">${getTypeIcon(f.type)}</div>`;
      }

      const stageInfo = PIPELINE_STAGES[f.stage] || PIPELINE_STAGES.idle;
      const stageIcon = stageInfo.icon;
      const stageLabel = stageInfo.label;

      let statusHtml;
      if (f.status === 'queued') {
        statusHtml = `<span class="stage-text">○ Queued</span>`;
      } else if (f.status === 'processing') {
        const pct = Math.round(f.progress * 100);
        statusHtml = `
          <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
          <span class="stage-text active">${stageIcon} ${stageLabel}</span>
        `;
      } else if (f.status === 'done') {
        let label = '✓ Done';
        if (f.result?.orientationCorrected) label = '✓ Rotated';
        if (f.result?.mirroredCorrected) label = '✓ Mirrored';
        statusHtml = `<span class="check">${label}</span>`;
      } else if (f.status === 'error') {
        statusHtml = `<span class="error">⚠ ${String(f.error || 'Error').substring(0, 20)}</span>`;
      }

      const typeLabel = { img: 'Image', audio: 'Audio', video: 'Video', text: 'Text', link: 'URL' }[f.type] || f.type;

      div.innerHTML = `
        ${previewHtml}
        <div class="file-info">
          <span class="name" title="${f.name.replace(/"/g, '&quot;')}">${f.name.replace(/</g, '&lt;')}</span>
          <div class="file-meta">
            <span class="type-badge ${f.type}">${typeLabel}</span>
            ${f.result ? `<span>${f.result.wordCount || 0} words</span>` : ''}
            ${f.result && f.result.confidence ? `<span>${Math.round(f.result.confidence)}%</span>` : ''}
          </div>
        </div>
        <div class="status">${statusHtml}</div>
      `;

      fileList.appendChild(div);
    }

    document.querySelectorAll('.file-list .file-item .preview').forEach(img => {
      if (img.tagName === 'IMG') img.addEventListener('load', () => URL.revokeObjectURL(img.src));
    });

    setupFileItemEvents();
  }

  function setupFileItemEvents() {
    const items = fileList.querySelectorAll('.file-item');

    items.forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) {
          toggleSelection(item.dataset.id);
        } else if (e.shiftKey && selectedIds.size > 0) {
          rangeSelect(item.dataset.id);
        } else {
          selectedIds.clear();
          selectedIds.add(item.dataset.id);
          updateSelectionUI();
        }
        openPreview(item.dataset.id);
      });

      item.addEventListener('dblclick', () => {
        const f = getFile(item.dataset.id);
        if (f && f.result) { openPreview(item.dataset.id); }
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!selectedIds.has(item.dataset.id)) {
          selectedIds.clear();
          selectedIds.add(item.dataset.id);
          updateSelectionUI();
        }
        showContextMenu(e.clientX, e.clientY, item.dataset.id);
      });
    });
  }

  function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    updateSelectionUI();
  }

  function rangeSelect(id) {
    const ids = fileList.querySelectorAll('.file-item');
    const idArr = Array.from(ids).map(el => el.dataset.id);
    const first = idArr.indexOf([...selectedIds][0]);
    const last = idArr.indexOf(id);
    if (first === -1 || last === -1) return;
    const [start, end] = first < last ? [first, last] : [last, first];
    for (let i = start; i <= end; i++) selectedIds.add(idArr[i]);
    updateSelectionUI();
  }

  function selectAll() {
    const visible = fileList.querySelectorAll('.file-item');
    visible.forEach(el => selectedIds.add(el.dataset.id));
    updateSelectionUI();
    setStatus(`Selected ${selectedIds.size} file(s)`);
  }

  function updateSelectionUI() {
    fileList.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('selected', selectedIds.has(el.dataset.id));
    });
    if (selectedIds.size > 0) {
      selectCount.textContent = `${selectedIds.size} selected`;
      selectCount.classList.remove('hidden');
      copySelectedBtn.classList.remove('hidden');
    } else {
      selectCount.classList.add('hidden');
      copySelectedBtn.classList.add('hidden');
    }
  }

  /* ── Context Menu ── */
  function showContextMenu(x, y, fileId) {
    const f = getFile(fileId);
    const items = [];

    if (f && f.result) {
      items.push({ label: '👁 View', action: () => { openPreview(fileId); } });
      items.push({ label: '📋 Copy', action: () => copyFileText(fileId) });
      items.push({ label: '📋 Copy as Markdown', action: () => copyFileMd(fileId) });
      items.push({ label: '📋 Copy as JSON', action: () => copyFileJson(fileId) });
      items.push('sep');
      items.push({ label: '📦 Export selected', action: () => { exportSelected(); } });
    }

    if (f && (f.status === 'done' || f.status === 'error')) {
      items.push({ label: '🔄 Retry', action: () => retryFile(fileId) });
    }
    if (f && f.status === 'queued') {
      items.push({ label: '❌ Cancel', action: () => removeFile(fileId) });
    }
    items.push('sep');
    items.push({ label: '🗑 Delete from queue', action: () => removeFile(fileId), danger: true });

    items.push('sep');
    items.push({ label: 'Select All', action: selectAll });
    items.push({ label: 'Deselect All', action: () => { selectedIds.clear(); updateSelectionUI(); } });

    renderContextMenu(items, x, y);
  }

  function showContextMenuItems(e, type) {
    const items = [];
    if (type === 'clear') {
      items.push({ label: 'Clear Selected', action: () => { removeSelected(); } });
      items.push({ label: 'Clear Completed', action: () => { removeByStatus('done'); } });
      items.push({ label: 'Clear Failed', action: () => { removeByStatus('error'); } });
      items.push({ label: 'Clear Queued', action: () => { removeByStatus('queued'); } });
      items.push('sep');
      items.push({ label: 'Clear All', action: clearAll, danger: true });
    }
    const x = e ? e.clientX : 100;
    const y = e ? e.clientY : 100;
    renderContextMenu(items, x, y);
  }

  function renderContextMenu(items, x, y) {
    contextMenu.innerHTML = '';
    for (const item of items) {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'context-menu-sep';
        contextMenu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
        el.textContent = item.label;
        el.addEventListener('click', (e) => { e.stopPropagation(); item.action(); contextMenu.classList.add('hidden'); });
        contextMenu.appendChild(el);
      }
    }
    const maxX = window.innerWidth - 200;
    const maxY = window.innerHeight - contextMenu.children.length * 30;
    contextMenu.style.left = Math.min(x, maxX) + 'px';
    contextMenu.style.top = Math.min(y, maxY) + 'px';
    contextMenu.classList.remove('hidden');
  }

  function removeFile(id) {
    files = files.filter(f => f.id !== id);
    selectedIds.delete(id);
    if (previewFileId === id) closePreview();
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  function removeByStatus(status) {
    if (isProcessing) return;
    const ids = files.filter(f => f.status === status).map(f => f.id);
    ids.forEach(id => selectedIds.delete(id));
    files = files.filter(f => f.status !== status);
    if (ids.includes(previewFileId)) closePreview();
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  function removeSelected() {
    if (isProcessing) return;
    selectedIds.forEach(id => {
      if (previewFileId === id) closePreview();
    });
    files = files.filter(f => !selectedIds.has(f.id));
    selectedIds.clear();
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  function retryFile(id) {
    const f = getFile(id);
    if (!f) return;
    f.status = 'queued';
    f.progress = 0;
    f.stage = 'idle';
    f.error = null;
    f.result = null;
    renderFileList();
    updateQueueVisibility();
    updateStartButton();
  }

  /* ── Preview ── */
  function openPreview(fileId) {
    const f = getFile(fileId);
    if (!f) return;
    previewFileId = fileId;
    centerPanel.classList.remove('hidden');
    previewFileName.textContent = f.name;
    updatePreviewContent(f);
  }

  function closePreview() {
    previewFileId = null;
    centerPanel.classList.add('hidden');
  }

  function updatePreviewContent(f) {
    const activeTab = document.querySelector('.preview-tab.active');
    const tabName = activeTab ? activeTab.dataset.tab : 'text';

    document.querySelectorAll('.preview-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    previewContent.classList.add('hidden');
    document.getElementById('previewMetadata').classList.add('hidden');
    document.getElementById('previewPipeline').classList.add('hidden');
    document.getElementById('previewLog').classList.add('hidden');
    document.getElementById('previewOriginal').classList.add('hidden');
    document.getElementById('previewCorrected').classList.add('hidden');

    switch (tabName) {
      case 'text': {
        previewContent.classList.remove('hidden');
        previewContent.value = f.result ? (f.result.structuredText || f.result.text || '') : (f.text || '(pending)');
        break;
      }
      case 'metadata': {
        const el = document.getElementById('previewMetadata');
        el.classList.remove('hidden');
        el.textContent = f.result ? JSON.stringify({
          name: f.name,
          type: f.type,
          confidence: f.result.confidence,
          wordCount: f.result.wordCount,
          orientationCorrected: f.result.orientationCorrected,
          mirroredCorrected: f.result.mirroredCorrected,
          language: f.language || 'eng',
        }, null, 2) : '(no result)';
        break;
      }
      case 'pipeline': {
        const el = document.getElementById('previewPipeline');
        el.classList.remove('hidden');
        const stages = f.pipelineStages && f.pipelineStages.length > 0 ? f.pipelineStages : [{ name: 'Queued', status: 'pending' }];
        el.innerHTML = stages.map(s =>
          `<div class="pipeline-stage ${s.status}">
            <span class="stage-icon">${s.status === 'running' ? '⟳' : s.status === 'done' ? '✓' : s.status === 'error' ? '⚠' : '○'}</span>
            <span class="stage-name">${s.name}</span>
            <span class="stage-time">${s.duration ? (s.duration / 1000).toFixed(1) + 's' : ''}</span>
          </div>`
        ).join('');
        break;
      }
      case 'log': {
        const el = document.getElementById('previewLog');
        el.classList.remove('hidden');
        el.textContent = f.logs ? f.logs.join('\n') : '(no logs)';
        break;
      }
      case 'original': {
        const el = document.getElementById('previewOriginal');
        el.classList.remove('hidden');
        el.textContent = f.result ? f.result.text || '(no text)' : '(pending)';
        break;
      }
      case 'corrected': {
        const el = document.getElementById('previewCorrected');
        el.classList.remove('hidden');
        el.textContent = f.result ? (f.result.structuredText || f.result.text || '(no corrected text)') : '(pending)';
        break;
      }
    }
  }

  previewTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.preview-tab');
    if (!tab) return;
    const f = getFile(previewFileId);
    if (!f) return;
    previewTabsEl.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    updatePreviewContent(f);
  });

  /* ── Status Bar ── */
  function setStatus(msg) { statusText.textContent = msg; }

  function updateStatusBar() {
    const queued = files.filter(f => f.status === 'queued').length;
    const processing = files.filter(f => f.status === 'processing').length;
    const done = files.filter(f => f.status === 'done').length;
    const errors = files.filter(f => f.status === 'error').length;

    if (isProcessing) {
      const elapsed = Date.now() - processingStartTime;
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      statusTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      statusTime.classList.remove('hidden');

      if (totalProcessedCount > 0 && elapsed > 2000) {
        const speed = (totalProcessedCount / (elapsed / 1000)).toFixed(1);
        statusSpeed.textContent = `${speed} files/s`;
        statusSpeed.classList.remove('hidden');
      }

      const totalLeft = queued + processing;
      statusProgress.textContent = `Processing… ${done} done, ${totalLeft} left`;
      statusProgress.classList.remove('hidden');
    } else {
      statusProgress.classList.add('hidden');
      statusTime.classList.add('hidden');
      statusSpeed.classList.add('hidden');
    }

    if (errors > 0) {
      statusErrors.textContent = `${errors} error(s)`;
      statusErrors.classList.remove('hidden');
      queueErrors.textContent = `${errors} error(s)`;
      queueErrors.classList.remove('hidden');
    } else {
      statusErrors.classList.add('hidden');
      queueErrors.classList.add('hidden');
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PROCESSING
     ══════════════════════════════════════════════════════════════ */

  function updateStartButton() {
    const hasQueued = files.some(f => f.status === 'queued');
    startBtn.disabled = !hasQueued || isProcessing;
  }

  function updateQueueVisibility() {
    fileCount.textContent = `${files.length} files`;
    const done = files.filter(f => f.status === 'done').length;
    doneCount.textContent = `${done} done`;
    updateStatusBar();
    if (files.length === 0) {
      const dt = document.querySelector('.drop-title');
      const ds = document.querySelector('.drop-sub');
      if (dt) dt.textContent = 'Drag & drop here';
      if (ds) ds.textContent = 'or click to browse';
    }
  }

  async function startProcessing() {
    if (isProcessing) return;
    isProcessing = true;
    isPaused = false;
    processingStartTime = Date.now();
    totalProcessedCount = 0;
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.textContent = '⏸ Pause';
    clearBtn.disabled = true;

    try { await ocrProc.init(); } catch (e) { console.warn('OCR init:', e.message); }
    try { await audioProc.init(); } catch (e) { console.warn('Audio init:', e.message); }

    const queued = files.filter(f => f.status === 'queued');
    if (queued.length === 0) { isProcessing = false; return; }
    const concurrency = Math.max(1, Math.min(ocrProc.maxWorkers, queued.length));
    let nextIdx = 0;
    setStatus(`Processing ${queued.length} file(s) with ${concurrency} worker(s)…`);

    const workerTask = async () => {
      while (nextIdx < queued.length) {
        if (isPaused) { isProcessing = false; return; }

        const i = nextIdx++;
        const f = queued[i];
        f.status = 'processing';
        f.progress = 0;
        f.pipelineStages = [{ name: 'Queued', status: 'done', duration: 0 }, { name: 'Processing', status: 'running' }];
        updateFileItem(f.id);
        updateQueueVisibility();

        try {
          const result = await processFile(f);
          f.status = 'done';
          f.progress = 1;
          f.result = result;
          f.pipelineStages.push({ name: 'Complete', status: 'done', duration: 0 });
          results.push({ name: f.name, type: f.type, ...result });
          totalProcessedCount++;
          updateOutputText();
        } catch (err) {
          f.status = 'error';
          f.error = err.message || 'Unknown error';
          f.pipelineStages.push({ name: 'Failed: ' + String(f.error).substring(0, 40), status: 'error' });
        }

        updateFileItem(f.id);
        updateQueueVisibility();
        updateStatusBar();
      }
    };

    const pipelines = Array(concurrency).fill().map(() => workerTask());
    await Promise.all(pipelines);

    isProcessing = false;
    startBtn.disabled = true;
    pauseBtn.disabled = true;
    pauseBtn.textContent = '⏹ Stop';
    clearBtn.disabled = false;
    updateStatusBar();
    updateOutputText();

    const totalDone = files.filter(f => f.status === 'done').length;
    const totalErrors = files.filter(f => f.status === 'error').length;
    if (totalDone > 0) {
      exportMgr.setResults(results);
      setStatus(`Completed: ${totalDone} done, ${totalErrors} failed`);
    } else if (totalErrors > 0) {
      setStatus(`All ${totalErrors} file(s) failed`);
    } else {
      setStatus('No files processed');
    }
  }

  function updateFileItem(id) {
    const div = fileList.querySelector(`[data-id="${id}"]`);
    if (!div) return;
    const f = getFile(id);
    if (!f) return;
    const statusEl = div.querySelector('.status');
    if (!statusEl) return;

    if (f.status === 'queued') {
      statusEl.innerHTML = `<span class="stage-text">○ Queued</span>`;
    } else if (f.status === 'processing') {
      const stageInfo = PIPELINE_STAGES[f.stage] || PIPELINE_STAGES.idle;
      const pct = Math.round(f.progress * 100);
      statusEl.innerHTML = `
        <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
        <span class="stage-text active">${stageInfo.icon} ${stageInfo.label}</span>
      `;
    } else if (f.status === 'done') {
      let label = '✓ Done';
      if (f.result?.orientationCorrected) label = '✓ Rotated';
      if (f.result?.mirroredCorrected) label = '✓ Mirrored';
      statusEl.innerHTML = `<span class="check">${label}</span>`;
    } else if (f.status === 'error') {
      statusEl.innerHTML = `<span class="error">⚠ ${String(f.error || 'Error').substring(0, 20)}</span>`;
    }
  }

  async function processFile(f) {
    const _lastUpdate = { time: 0 };
    const onProgress = (p, stage) => {
      const now = Date.now();
      if (stage || now - _lastUpdate.time > 50) {
        _lastUpdate.time = now;
        f.progress = Math.min(p, 0.99);
        if (stage) {
          f.stage = stage;
          f.pipelineStages.push({ name: (PIPELINE_STAGES[stage] || {}).label || stage, status: 'done', duration: now - (f.stageStart || now) });
          f.stageStart = now;
          f.pipelineStages.push({ name: 'Processing…', status: 'running' });
        }
        updateFileItem(f.id);
        updateQueueVisibility();
      }
    };

    switch (f.type) {
      case 'img': return processImage(f, onProgress);
      case 'audio': return processAudioFile(f, onProgress);
      case 'video': return processVideoFile(f, onProgress);
      case 'text': return processTextFile(f);
      case 'link': return processLink(f);
      default: throw new Error('Unsupported file type');
    }
  }

  async function processImage(f, onProgress) {
    onProgress(0.05, 'reading');
    const imageData = await fileToDataUrl(f.file);
    onProgress(0.1, 'analyzing');
    const result = await ocrProc.processImage(imageData, f.name, (p) => {
      onProgress(0.1 + p * 0.75);
    });
    onProgress(0.85, 'consensus');

    // Push pipeline report iterations into file's pipeline stages
    if (result.pipelineReport) {
      const rpt = result.pipelineReport;

      if (rpt.quality && rpt.quality.difficulty) {
        f.pipelineStages.push({ name: `Quality: ${rpt.quality.difficulty} (blur=${rpt.quality.blurScore}, contrast=${Math.round(rpt.quality.contrast)})`, status: 'done', duration: 0 });
      }

      let totalOcrCalls = 0;
      for (const iter of rpt.iterations || []) {
        for (const strat of iter.strategies || []) {
          totalOcrCalls++;
          f.pipelineStages.push({
            name: `Iter ${iter.iteration + 1}: ${STRATEGY_LABELS_BY_KEY[strat.name] || strat.name} (score ${strat.score})`,
            status: 'done', duration: iter.duration || 0,
          });
        }
      }

      if (rpt.consensusAgreement !== undefined) {
        f.pipelineStages.push({ name: `Consensus agreement: ${(rpt.consensusAgreement * 100).toFixed(0)}%`, status: 'done', duration: 0 });
      }
      if (rpt.finalStrategy) {
        f.pipelineStages.push({ name: `Best strategy: ${STRATEGY_LABELS_BY_KEY[rpt.finalStrategy] || rpt.finalStrategy}`, status: 'done', duration: 0 });
      }
    }

    onProgress(0.9, 'building');
    const structured = structPreserver.reconstructLayout(result.words, layoutMode.value);
    onProgress(1.0, 'done');
    return {
      text: result.text, structuredText: structured,
      words: result.words, confidence: result.confidence,
      wordCount: result.wordCount,
      orientationCorrected: result.orientationCorrected || false,
      mirroredCorrected: result.mirroredCorrected || false,
      pipelineReport: result.pipelineReport,
    };
  }

  async function processAudioFile(f, onProgress) {
    onProgress(0.1, 'reading');
    const result = await audioProc.processAudio(f.file, f.name, (p) => {
      onProgress(0.1 + p * 0.85);
    });
    onProgress(1.0, 'done');
    return {
      text: result.text, structuredText: result.text,
      words: result.words, confidence: result.confidence,
      wordCount: result.wordCount,
    };
  }

  async function processVideoFile(f, onProgress) {
    onProgress(0.05, 'reading');
    const result = await videoProc.processVideo(f.file, f.name, (p) => {
      onProgress(Math.min(p * 0.95, 0.95));
    });
    onProgress(1.0, 'done');
    return result;
  }

  async function processTextFile(f) {
    let text;
    if (f.text) text = f.text;
    else if (f.file) text = await f.file.text();
    else text = '';
    return {
      text, structuredText: text,
      words: text.split(/\s+/).filter(w => w).map(w => ({ text: w, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, confidence: 1 })),
      confidence: 1, wordCount: text.split(/\s+/).filter(w => w).length,
    };
  }

  async function processLink(f) {
    if (!window.electronAPI) {
      return { text: '[URL fetching requires Electron desktop app]', structuredText: '[URL fetching requires Electron desktop app]', words: [], confidence: 0, wordCount: 0 };
    }
    const result = await window.electronAPI.fetchUrl(f.url);
    if (!result.success) {
      return { text: `[Failed to fetch ${f.url}: ${result.error}]`, structuredText: `[Failed to fetch ${f.url}: ${result.error}]`, words: [], confidence: 0, wordCount: 0 };
    }
    const html = result.data.html;
    const text = extractTextFromHtml(html);
    return {
      text, structuredText: text,
      words: text.split(/\s+/).filter(w => w).map(w => ({ text: w, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, confidence: 1 })),
      confidence: 1, wordCount: text.split(/\s+/).filter(w => w).length,
    };
  }

  function extractTextFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, nav, footer, header, aside').forEach(s => s.remove());
    return doc.body ? doc.body.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /* ══════════════════════════════════════════════════════════════
     COPY / EXPORT
     ══════════════════════════════════════════════════════════════ */

  async function copySelected() {
    const filesToCopy = files.filter(f => selectedIds.has(f.id) && f.result);
    if (filesToCopy.length === 0) return;
    const parts = filesToCopy.map(f => {
      const text = f.result.structuredText || f.result.text || '';
      return `=== ${f.name} ===\n${text}`;
    });
    await navigator.clipboard.writeText(parts.join('\n\n'));
    copySelectedBtn.textContent = '✓ Copied!';
    setTimeout(() => { copySelectedBtn.textContent = '📋 Copy Sel'; }, 2000);
    setStatus(`Copied ${filesToCopy.length} file(s)`);
  }

  async function copyFileText(fileId) {
    const f = getFile(fileId);
    if (!f || !f.result) return;
    await navigator.clipboard.writeText(f.result.structuredText || f.result.text || '');
    setStatus('Copied to clipboard');
  }

  async function copyFileMd(fileId) {
    const f = getFile(fileId);
    if (!f || !f.result) return;
    const text = f.result.structuredText || f.result.text || '';
    await navigator.clipboard.writeText(`## ${f.name}\n\n${text}`);
    setStatus('Copied as Markdown');
  }

  async function copyFileJson(fileId) {
    const f = getFile(fileId);
    if (!f || !f.result) return;
    await navigator.clipboard.writeText(JSON.stringify({ name: f.name, ...f.result }, null, 2));
    setStatus('Copied as JSON');
  }

  async function handleCopyAll() {
    await exportMgr.copyAll();
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = '📋 Copy All'; }, 2000);
  }

  async function exportSelected() {
    const selResults = results.filter(r => selectedIds.has(files.find(f => f.name === r.name && f.result)?.id));
    if (selResults.length === 0) return;
    await doExportNow(selResults);
  }

  function togglePause() {
    isPaused = true;
    isProcessing = false;
    pauseBtn.disabled = true;
    pauseBtn.textContent = '⏹ Stopped';
    setStatus('Stopping…');
  }

  function clearAll() {
    if (isProcessing) return;
    if (!confirm('Clear entire queue?')) return;
    files = [];
    results = [];
    selectedIds.clear();
    closePreview();
    fileList.innerHTML = '';
    queueStats.classList.add('hidden');
    updateQueueVisibility();
    startBtn.disabled = true;
    setStatus('Queue cleared');
  }

  /* ── Export ── */
  async function handleExport() {
    const doneFiles = files.filter(f => f.result);
    if (doneFiles.length === 0) { setStatus('No files to export'); return; }
    exportMgr.setResults(results);
    await doExportNow();
  }

  function updateOutputText() {
    const doneFiles = files.filter(f => f.result);
    if (doneFiles.length === 0) { outputText.value = ''; return; }
    outputText.value = buildExportText(doneFiles.map(f => ({
      name: f.name, text: f.result.structuredText || f.result.text || '',
    })));
  }

  async function doExportNow(customResults) {
    const format = exportFormat.value;
    const originalBtnText = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.innerHTML = '⏳ Exporting…';
    const savedResults = customResults || results;
    try {
      const tempExport = new ExportManager();
      tempExport.setResults(savedResults);
      tempExport.setLayoutMode(layoutMode.value);
      switch (format) {
        case 'zip': await tempExport.exportZip(); break;
        case 'merged-txt': await tempExport.exportTxtMerged(); break;
        case 'merged-md': await tempExport.exportMdMerged(); break;
        case 'csv': await tempExport.exportCsv(); break;
        case 'pdf': await tempExport.exportPdf(); break;
        case 'docx': await tempExport.exportDocx(); break;
        default: await tempExport.exportZip();
      }
      setStatus('Export complete');
    } catch (err) {
      console.error('Export error:', err);
      setStatus('Export failed: ' + err.message);
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = originalBtnText;
    }
  }

  function refreshTextPreviews() {
    for (const f of files) {
      if (f.result) {
        const structured = new StructurePreserver().reconstructLayout(f.result.words, layoutMode.value);
        f.result.structuredText = structured;
      }
    }
    updateOutputText();
    const pf = previewFileId ? getFile(previewFileId) : null;
    if (pf) updatePreviewContent(pf);
  }

  /* ── Resizable panels ── */
  function initResize(handle, panel, side, storageKey) {
    let startX, startSize;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startSize = side === 'left' ? leftPanel.offsetWidth : rightPanel.offsetWidth;
      handle.classList.add('active');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      const delta = e.clientX - startX;
      const newSize = side === 'left' ? startSize + delta : startSize - delta;
      const clamped = Math.max(200, Math.min(600, newSize));
      panel.style.width = clamped + 'px';
      if (side === 'left') leftWidth = clamped;
      else rightWidth = clamped;
    }
    function onUp() {
      handle.classList.remove('active');
      localStorage.setItem(storageKey, side === 'left' ? leftWidth : rightWidth);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  initResize(leftResize, leftPanel, 'left', 'bp_leftWidth');
  initResize(centerResize, rightPanel, 'right', 'bp_rightWidth');

  /* ── Utilities ── */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Periodic status update ── */
  setInterval(updateStatusBar, 1000);

})();
