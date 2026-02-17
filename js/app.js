/**
 * App Shell
 * File handling, UI logic, playback controls.
 */

document.addEventListener('DOMContentLoaded', () => {
  const viewer = new GCodeViewer(document.getElementById('viewer-container'));
  const parser = new GCodeParser();

  const pasteArea = document.getElementById('paste-area');
  const dropZone = document.getElementById('drop-zone');
  const statsPanel = document.getElementById('stats-panel');
  const fileName = document.getElementById('file-name');
  const parseBtn = document.getElementById('parse-btn');
  const resetBtn = document.getElementById('reset-view');
  const fileInput = document.getElementById('file-input');
  const statusMsg = document.getElementById('status-msg');

  // Playback controls
  const playbackBar = document.getElementById('playback-bar');
  const playBtn = document.getElementById('play-btn');
  const restartBtn = document.getElementById('restart-btn');
  const showAllBtn = document.getElementById('show-all-btn');
  const speedSlider = document.getElementById('speed-slider');
  const speedLabel = document.getElementById('speed-label');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  function showStatus(msg, isError) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? '#ff4444' : '#44dd88';
    statusMsg.style.display = 'block';
    if (!isError) setTimeout(() => { statusMsg.style.display = 'none'; }, 3000);
  }

  function loadGCode(text, name) {
    showStatus('Parsing ' + (name || 'G-code') + '...', false);

    if (!text || text.trim().length === 0) {
      showStatus('File is empty', true);
      return;
    }

    try {
      const result = parser.parse(text);

      if (!result.segments.length) {
        showStatus('No toolpath moves found in file', true);
        fileName.textContent = 'No moves found';
        statsPanel.classList.remove('hidden');
        return;
      }

      // Load and immediately show full toolpath — user can restart + play to animate
      viewer.renderToolpath(result.segments, result.bounds);

      fileName.textContent = name || 'Pasted G-code';
      document.getElementById('stat-lines').textContent = result.stats.lineCount.toLocaleString();
      document.getElementById('stat-moves').textContent = result.stats.moveCount.toLocaleString();

      const b = result.stats.bounds;
      const sizeX = (b.max.x - b.min.x).toFixed(2);
      const sizeY = (b.max.y - b.min.y).toFixed(2);
      const sizeZ = (b.max.z - b.min.z).toFixed(2);
      document.getElementById('stat-bounds').textContent = sizeX + ' x ' + sizeY + ' x ' + sizeZ;

      statsPanel.classList.remove('hidden');
      playbackBar.classList.remove('hidden');

      updatePlayButton(false);
      updateProgress(0, result.segments.length);
      showStatus('Loaded: ' + result.segments.length + ' moves', false);

      pasteArea.value = '';
    } catch (err) {
      showStatus('Parse error: ' + err.message, true);
    }
  }

  // Playback callbacks
  viewer.onProgress = (current, total) => updateProgress(current, total);
  viewer.onPlayStateChange = (playing) => updatePlayButton(playing);

  function updatePlayButton(playing) {
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('btn-primary', !playing);
  }

  function updateProgress(current, total) {
    const pct = total > 0 ? (current / total * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = current.toLocaleString() + ' / ' + total.toLocaleString();
  }

  playBtn.addEventListener('click', () => viewer.togglePlay());
  restartBtn.addEventListener('click', () => viewer.restart());
  showAllBtn.addEventListener('click', () => viewer.showAll());

  speedSlider.addEventListener('input', () => {
    const val = parseFloat(speedSlider.value);
    const speed = Math.pow(10, (val - 50) / 35);
    const rounded = speed >= 10 ? Math.round(speed) :
                    speed >= 1 ? Math.round(speed * 10) / 10 :
                    Math.round(speed * 100) / 100;
    viewer.setSpeed(rounded);
    speedLabel.textContent = rounded + 'x';
  });

  // Progress bar scrubbing
  let scrubbing = false;
  function scrubFromEvent(e) {
    const rect = progressBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    viewer.scrubTo(fraction);
  }
  progressBar.addEventListener('mousedown', (e) => { scrubbing = true; viewer.pause(); scrubFromEvent(e); });
  progressBar.addEventListener('touchstart', (e) => { scrubbing = true; viewer.pause(); scrubFromEvent(e); e.preventDefault(); }, { passive: false });
  document.addEventListener('mousemove', (e) => { if (scrubbing) scrubFromEvent(e); });
  document.addEventListener('touchmove', (e) => { if (scrubbing) scrubFromEvent(e); }, { passive: true });
  document.addEventListener('mouseup', () => { scrubbing = false; });
  document.addEventListener('touchend', () => { scrubbing = false; });

  // File input — label triggers the native picker directly
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    showStatus('Reading ' + file.name + '...', false);
    const reader = new FileReader();
    reader.onload = () => loadGCode(reader.result, file.name);
    reader.onerror = () => showStatus('Error reading file: ' + reader.error.message, true);
    reader.readAsText(file);
    // Reset so same file can be re-selected
    fileInput.value = '';
  });

  // Drag & drop
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) {
      showStatus('Reading ' + file.name + '...', false);
      const reader = new FileReader();
      reader.onload = () => loadGCode(reader.result, file.name);
      reader.onerror = () => showStatus('Error reading file', true);
      reader.readAsText(file);
    }
  });

  // Parse pasted text
  parseBtn.addEventListener('click', () => {
    const text = pasteArea.value.trim();
    if (text) loadGCode(text, null);
  });

  // Reset view
  resetBtn.addEventListener('click', () => viewer.resetView());

  // PWA file handling
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files.length) return;
      const fileHandle = launchParams.files[0];
      const file = await fileHandle.getFile();
      loadGCode(await file.text(), file.name);
    });
  }

  // Handle shared file or file URL
  if (window.location.search) {
    const params = new URLSearchParams(window.location.search);

    if (params.get('shared')) {
      caches.open('shared-files').then(cache =>
        cache.match('/shared-file-data')
      ).then(async (response) => {
        if (!response) return;
        const text = await response.text();
        const name = response.headers.get('X-File-Name') || 'shared.nc';
        loadGCode(text, name);
        caches.delete('shared-files');
        history.replaceState(null, '', '/');
      });
    }

    const fileUrl = params.get('file');
    if (fileUrl) {
      showStatus('Loading ' + fileUrl.split('/').pop() + '...', false);
      fetch(fileUrl)
        .then(r => r.text())
        .then(text => loadGCode(text, fileUrl.split('/').pop()))
        .catch(err => showStatus('Error loading file: ' + err.message, true));
    }
  }
});
