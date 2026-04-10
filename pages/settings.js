// Settings Page - 设置页面逻辑
(function() {
  'use strict';

  const PRESET_VALUES = [0, 50, 100, 150, 200, 300, 500, 1024];

  function sendMessage(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, r => resolve(r || {}));
    });
  }

  async function loadSettings() {
    const settings = await sendMessage({ type: 'GET_SETTINGS' });

    const thresholdMB = Math.round((settings.largeFileThreshold || 200 * 1024 * 1024) / (1024 * 1024));
    const idx = PRESET_VALUES.indexOf(thresholdMB);
    const sliderIdx = idx === -1 ? 4 : idx;

    document.getElementById('threshold-slider').value = sliderIdx;
    updateThresholdUI(thresholdMB);

    document.getElementById('large-file-strategy').value = settings.largeFileStrategy || 'stream';

    document.getElementById('concurrency-slider').value = settings.maxConcurrency || 6;
    document.getElementById('concurrency-display').textContent = settings.maxConcurrency || 6;
    document.getElementById('max-retries').value = settings.maxRetries || 3;
    document.getElementById('connect-timeout').value = settings.connectTimeout || 30000;

    document.getElementById('auto-capture').checked = settings.autoCapture !== false;
    document.getElementById('auto-parse').checked = settings.autoParse !== false;
    document.getElementById('auto-quality').checked = settings.autoSelectHighestQuality !== false;
    document.getElementById('show-notifications').checked = settings.showNotifications !== false;
  }

  function updateThresholdUI(mb) {
    const display = document.getElementById('threshold-display');
    const barMem = document.getElementById('bar-memory');
    const barStream = document.getElementById('bar-stream');

    display.textContent = mb === 0 ? '不限制' : mb + ' MB';

    const max = 500;
    const memPct = mb === 0 ? 5 : Math.min(100, Math.round((mb / max) * 100));
    barMem.style.width = memPct + '%';
    barStream.style.width = (100 - memPct) + '%';
    barMem.textContent = memPct > 15 ? '内存合并' : '';
    barStream.textContent = (100 - memPct) > 15 ? '流式合并' : '';

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.mb) === mb);
    });
  }

  function initEventListeners() {
    // 阈值滑块
    document.getElementById('threshold-slider').addEventListener('input', function() {
      const mb = PRESET_VALUES[parseInt(this.value)];
      updateThresholdUI(mb);
    });

    // 预设按钮
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mb = parseInt(btn.dataset.mb);
        const idx = PRESET_VALUES.indexOf(mb);
        document.getElementById('threshold-slider').value = idx;
        updateThresholdUI(mb);
      });
    });

    // 并发数滑块
    document.getElementById('concurrency-slider').addEventListener('input', function() {
      document.getElementById('concurrency-display').textContent = this.value;
    });

    // 保存按钮
    document.getElementById('btn-save').addEventListener('click', saveSettings);

    // 恢复默认按钮
    document.getElementById('btn-reset').addEventListener('click', resetAll);
  }

  async function saveSettings() {
    const slider = document.getElementById('threshold-slider');
    const mb = PRESET_VALUES[parseInt(slider.value)];

    const settings = {
      largeFileThreshold: mb * 1024 * 1024,
      largeFileStrategy: document.getElementById('large-file-strategy').value,
      maxConcurrency: parseInt(document.getElementById('concurrency-slider').value),
      maxRetries: parseInt(document.getElementById('max-retries').value),
      connectTimeout: parseInt(document.getElementById('connect-timeout').value),
      autoCapture: document.getElementById('auto-capture').checked,
      autoParse: document.getElementById('auto-parse').checked,
      autoSelectHighestQuality: document.getElementById('auto-quality').checked,
      showNotifications: document.getElementById('show-notifications').checked
    };

    await sendMessage({ type: 'SAVE_SETTINGS', payload: { settings } });

    const savedStatus = document.getElementById('saved-status');
    savedStatus.innerHTML = '<div class="status-saved">&#10004; 设置已保存</div>';
    setTimeout(() => { savedStatus.innerHTML = ''; }, 3000);
  }

  async function resetAll() {
    if (confirm('确定将所有设置恢复为默认值？')) {
      const defaults = {
        largeFileThreshold: 200 * 1024 * 1024,
        largeFileStrategy: 'stream',
        maxConcurrency: 6,
        maxRetries: 3,
        connectTimeout: 30000,
        autoCapture: true,
        autoParse: true,
        autoSelectHighestQuality: true,
        showNotifications: true
      };
      await sendMessage({ type: 'SAVE_SETTINGS', payload: { settings: defaults } });
      await loadSettings();
      const savedStatus = document.getElementById('saved-status');
      savedStatus.innerHTML = '<div class="status-saved">&#10004; 已恢复默认设置</div>';
      setTimeout(() => { savedStatus.innerHTML = ''; }, 3000);
    }
  }

  // 初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initEventListeners();
      loadSettings();
    });
  } else {
    initEventListeners();
    loadSettings();
  }
})();
