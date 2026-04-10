// Popup 主逻辑 - 外部脚本文件
// 解决 Content Security Policy 不允许内联脚本的问题

(function() {
  'use strict';

  // ========== 全局错误捕获 ==========
  window.onerror = function(msg, url, line, col, error) {
    try {
      showDebug('JS Error: ' + msg + ' (line ' + line + ')');
    } catch(e) {}
    return false;
  };

  function showDebug(msg) {
    console.error('[Popup]', msg);
    try {
      const panel = document.getElementById('debug-panel');
      const errorSpan = document.getElementById('debug-error');
      if (panel && errorSpan) {
        errorSpan.textContent = msg;
        panel.style.display = 'block';
      }
    } catch(e) {}
  }

  // ========== Popup 主逻辑 ==========
  let capturedUrls = [];
  let selectedUrl = null;
  let selectedUrls = new Set(); // 多选集合

  // 标记初始化状态
  let isInitialized = false;

  // DOM 元素引用
  let urlListEl, emptyState, modalDetail, modalDetailBody;

  // 初始化 - 立即执行
  function init() {
    console.log('[Popup] Script start');

    // 获取 DOM 元素
    urlListEl = document.getElementById('url-list');
    emptyState = document.getElementById('empty-state');
    modalDetail = document.getElementById('modal-detail');
    modalDetailBody = document.getElementById('modal-detail-body');

    

    // 检查 StorageUtils 是否存在
    if (typeof StorageUtils === 'undefined') {
      showDebug('StorageUtils 未加载！基础功能可能受限');
      console.warn('[Popup] StorageUtils not available');
    } else {
      console.log('[Popup] StorageUtils OK');
    }

    // 绑定所有事件监听器
    bindAllEventListeners();

    // 尝试加载数据
    if (typeof StorageUtils !== 'undefined') {
      loadCapturedUrls();
      setInterval(loadCapturedUrls, 3000);
    }

    isInitialized = true;
    console.log('[Popup] Init complete');
  }

  // 加载捕获的 URL
  async function loadCapturedUrls() {
    try {
      if (typeof StorageUtils === 'undefined') return;
      capturedUrls = await StorageUtils.getCapturedUrls();
      // 清理已不存在的选中项
      const validUrls = new Set(capturedUrls.map(u => u.url));
      for (const url of selectedUrls) {
        if (!validUrls.has(url)) selectedUrls.delete(url);
      }
      renderUrlList();
      updateStats();
    } catch (err) {
      console.error('[Popup] Failed to load URLs:', err);
    }
  }

  // 渲染列表
  function renderUrlList() {
    if (!urlListEl || !emptyState) return;

    if (!capturedUrls || capturedUrls.length === 0) {
      urlListEl.innerHTML = '';
      urlListEl.appendChild(emptyState);
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    const selectAllChecked = capturedUrls.length > 0 && capturedUrls.every(u => selectedUrls.has(u.url));
    const html = `
      <div class="url-list-header">
        <label class="url-item" style="cursor:pointer;">
          <input type="checkbox" id="select-all" ${selectAllChecked ? 'checked' : ''} style="margin-right:8px;accent-color:var(--primary);">
          <span style="font-size:12px;color:var(--text-secondary);">全选</span>
          ${selectedUrls.size > 0 ? `<span style="margin-left:auto;font-size:12px;color:var(--primary);font-weight:600;">已选 ${selectedUrls.size} 项</span>` : ''}
        </label>
      </div>
    ` + capturedUrls.map(item => {
      const domain = getDomain(item.pageUrl);
      const segCount = item.totalSegments ? item.totalSegments + ' 个分片' : '';
      const duration = item.totalDuration ? formatDuration(item.totalDuration) : '';
      const meta = [segCount, duration].filter(Boolean).join(' · ');
      const isSelected = selectedUrls.has(item.url);

      return `
        <div class="url-item ${isSelected ? 'selected' : ''}" data-url="${escapeHtml(item.url)}">
          <label style="display:flex;align-items:center;cursor:pointer;flex:1;min-width:0;">
            <input type="checkbox" class="url-select-checkbox" data-url="${escapeHtml(item.url)}" ${isSelected ? 'checked' : ''} style="margin-right:8px;accent-color:var(--primary);flex-shrink:0;">
            <div style="flex:1;min-width:0;">
              <div class="url-item-header">
                <div class="url-item-status ${item.status || 'pending'}"></div>
                <div class="url-item-title">${escapeHtml(getFileName(item.url))}</div>
                <div class="url-item-actions">
                  <button class="btn-icon btn-sm" title="复制链接" data-action="copy" data-url="${escapeHtml(item.url)}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  </button>
                  <button class="btn-icon btn-sm" title="删除" data-action="delete" data-url="${escapeHtml(item.url)}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="url-item-domain">${escapeHtml(item.pageDomain || item.url)}</div>
              ${meta ? '<div class="url-item-meta"><span>' + meta + '</span></div>' : ''}
            </div>
          </label>
        </div>
      `;
    }).join('');

    urlListEl.innerHTML = html;

    // 绑定列表项点击事件
    urlListEl.querySelectorAll('.url-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // 忽略复选框和按钮点击
        if (e.target.closest('input[type="checkbox"]') || e.target.closest('.url-item-actions')) return;
        const url = el.dataset.url;
        showDetail(url);
      });
    });

    // 全选复选框
    const selectAll = document.getElementById('select-all');
    if (selectAll) {
      selectAll.addEventListener('change', (e) => {
        if (e.target.checked) {
          capturedUrls.forEach(u => selectedUrls.add(u.url));
        } else {
          selectedUrls.clear();
        }
        renderUrlList();
        updateStats();
      });
    }

    // 单项复选框
    urlListEl.querySelectorAll('.url-select-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const url = cb.dataset.url;
        if (e.target.checked) {
          selectedUrls.add(url);
        } else {
          selectedUrls.delete(url);
        }
        renderUrlList();
        updateStats();
      });
    });

    // 绑定复制和删除按钮
    urlListEl.querySelectorAll('[data-action="copy"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyUrl(btn.dataset.url);
      });
    });

    urlListEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteUrl(btn.dataset.url);
      });
    });
  }

  // 显示详情
  async function showDetail(url) {
    selectedUrl = url;
    const item = capturedUrls.find(u => u.url === url);
    if (!item || !modalDetailBody) return;

    // 详情卡始终显示基本信息
    let bodyHtml = `
      <div class="video-info">
        <div class="video-info-name">${escapeHtml(getFileName(item.url))}</div>
      </div>
      <div class="form-group">
        <label class="form-label">M3U8 链接</label>
        <div class="form-hint text-mono truncate" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
      </div>
    `;

    if (item.status === 'error') {
      bodyHtml += `
        <div class="form-group">
          <div class="badge badge-error">解析失败</div>
          <div class="form-hint mt-8">${escapeHtml(item.error || '未知错误')}</div>
        </div>
      `;
      modalDetailBody.innerHTML = bodyHtml;
      modalDetail.classList.add('active');
      return;
    }

    if (item.status === 'parsed' && item.segments) {
      const totalSize = estimateSize(item);
      bodyHtml += `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">分辨率</label>
            <div class="form-hint">${item.resolution || '未检测到'}</div>
          </div>
          <div class="form-group">
            <label class="form-label">分片数量</label>
            <div class="form-hint">${item.totalSegments} 个</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">&#9201; 时长</label>
            <div class="form-hint">${formatDuration(item.totalDuration || 0)}</div>
          </div>
          <div class="form-group">
            <label class="form-label">&#128190; 估算大小</label>
            <div class="form-hint">${formatBytes(totalSize)}</div>
          </div>
        </div>
        ${item.encryption ? '<div class="form-group"><label class="form-label">&#128274; 加密</label><div class="badge badge-warning">AES-128</div></div>' : '<div class="form-group"><label class="form-label">&#128275; 加密</label><div class="badge badge-success">无加密</div></div>'}
        <div id=\"quality-selector-container\"></div>
      `;
    } else if (item.status === 'pending') {
      // 先尝试获取 Master Playlist 变体流列表
      try {
        const res = await sendMessage({ type: 'PARSE_MASTER_PLAYLIST', payload: { url: item.url } });
        if (res.success && res.data?.variantStreams?.length > 1) {
          bodyHtml += buildQualitySelectorHtml(res.data.variantStreams, item.url);
        } else {
          bodyHtml += `<div class=\"form-group\"><div class=\"badge badge-muted\">待解析</div><div class=\"form-hint mt-8\">点击"开始下载"将先解析再下载</div></div>`;
        }
      } catch {
        bodyHtml += `<div class=\"form-group\"><div class=\"badge badge-muted\">待解析</div><div class=\"form-hint mt-8\">点击"开始下载"将先解析再下载</div></div>`;
      }
    } else {
      bodyHtml += `<div class=\"form-group\"><div class=\"badge badge-muted\">待解析</div><div class=\"form-hint mt-8\">点击"开始下载"将先解析再下载</div></div>`;
    }

    modalDetailBody.innerHTML = bodyHtml;
    modalDetail.classList.add('active');

    // 为清晰度选项绑定点击事件
    document.querySelectorAll('.quality-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const variantUrl = btn.dataset.variantUrl;
        const label = btn.dataset.label;
        // 取消其他选中
        document.querySelectorAll('.quality-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // 解析选中的清晰度
        showToast('正在解析', label, 'info');
        const res = await sendMessage({ type: 'SELECT_VARIANT', payload: { variantUrl } });
        if (res.success) {
          await StorageUtils.updateCapturedUrl(item.url, { status: 'parsed', resolution: label });
          showToast('解析完成', label, 'success');
          await loadCapturedUrls();
        } else {
          showToast('解析失败', res.error, 'error');
        }
      });
    });
  }

  function buildQualitySelectorHtml(variantStreams, originalUrl) {
    const options = variantStreams.map((v, i) => {
      const isRecommended = i === 0;
      return `
        <div class="quality-option ${isRecommended ? 'active' : ''}"
             data-variant-url="${escapeHtml(v.uri)}"
             data-label="${escapeHtml(v.label)}">
          <div class="quality-option-label">${escapeHtml(v.label)}</div>
          ${isRecommended ? '<div class="quality-option-badge">推荐</div>' : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="form-group">
        <label class="form-label">&#127918; 选择清晰度（${variantStreams.length} 个可选）</label>
        <div class="quality-list">${options}</div>
      </div>
    `;
  }

  // 更新统计
  function updateStats() {
    const statTotal = document.getElementById('stat-total');
    const statParsed = document.getElementById('stat-parsed');
    const statDownloading = document.getElementById('stat-downloading');
    const statCompleted = document.getElementById('stat-completed');

    if (statTotal) statTotal.textContent = capturedUrls.length;
    if (statParsed) statParsed.textContent = capturedUrls.filter(u => u.status === 'parsed').length;
    if (statDownloading) statDownloading.textContent = capturedUrls.filter(u => u.status === 'downloading').length;
    if (statCompleted) statCompleted.textContent = capturedUrls.filter(u => u.status === 'completed').length;
  }

  // 事件监听
  function bindAllEventListeners() {
    // 扫描当前页面
    const btnScan = document.getElementById('btn-scan');
    if (btnScan) {
      btnScan.addEventListener('click', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) {
            await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SCAN' });
            showToast('已触发页面扫描', '正在搜索 M3U8 链接...', 'success');
            setTimeout(loadCapturedUrls, 1500);
          }
        } catch (err) {
          showDebug('扫描失败: ' + err.message);
          showToast('扫描失败', err.message, 'error');
        }
      });
      console.log('[Popup] btn-scan bound');
    }

    // 解析选中（多选）
    const btnParse = document.getElementById('btn-parse');
    if (btnParse) {
      btnParse.addEventListener('click', async () => {
        const selected = capturedUrls.filter(u => selectedUrls.has(u.url));
        if (selected.length === 0) {
          showToast('请先选择要解析的链接', '勾选列表中的项目', 'warning');
          return;
        }
        showToast('开始解析', `共 ${selected.length} 个链接`, 'success');
        for (const item of selected) {
          try {
            await sendMessage({ type: 'PARSE_M3U8', payload: { url: item.url } });
          } catch (e) {}
        }
        setTimeout(loadCapturedUrls, 2000);
      });
    }

    // 下载选中（多选）
    const btnDownload = document.getElementById('btn-download');
    if (btnDownload) {
      btnDownload.addEventListener('click', async () => {
        const selected = capturedUrls.filter(u => selectedUrls.has(u.url) && (u.status === 'parsed' || u.status === 'downloading'));
        if (selected.length === 0) {
          showToast('请先选择已解析的链接', '勾选已解析状态的项目', 'warning');
          return;
        }
        showToast('开始批量下载', `共 ${selected.length} 个任务`, 'success');
        for (const item of selected) {
          await downloadItem(item);
        }
        selectedUrls.clear();
        await loadCapturedUrls();
      });
    }

    // 手动添加 URL
    const btnAddUrl = document.getElementById('btn-add-url');
    if (btnAddUrl) {
      btnAddUrl.addEventListener('click', async () => {
        const url = document.getElementById('manual-url').value.trim();
        if (!url) return;
        if (!url.startsWith('http')) {
          showToast('无效链接', '请输入以 http:// 或 https:// 开头的链接', 'error');
          return;
        }
        try {
          await StorageUtils.addCapturedUrl({ url, pageUrl: url, pageTitle: '手动添加', pageDomain: getDomain(url), capturedAt: Date.now() });
          document.getElementById('manual-url').value = '';
          await loadCapturedUrls();
          showToast('已添加', url, 'success');
        } catch (err) {
          showDebug('添加URL失败: ' + err.message);
        }
      });
      console.log('[Popup] btn-add-url bound');
    }

    // 清空
    const btnClear = document.getElementById('btn-clear');
    if (btnClear) {
      btnClear.addEventListener('click', async () => {
        if (confirm('确定清空所有捕获的链接？')) {
          await StorageUtils.clearCapturedUrls();
          await loadCapturedUrls();
        }
      });
      console.log('[Popup] btn-clear bound');
    }

    // 下载全部
    const btnDownloadAll = document.getElementById('btn-download-all');
    if (btnDownloadAll) {
      btnDownloadAll.addEventListener('click', async () => {
        const parsed = capturedUrls.filter(u => u.status === 'parsed');
        if (parsed.length === 0) {
          showToast('无可下载项', '请先解析 M3U8 链接', 'warning');
          return;
        }
        showToast('开始下载', `共 ${parsed.length} 个任务`, 'success');
        for (const item of parsed) {
          await downloadItem(item);
        }
      });
      console.log('[Popup] btn-download-all bound');
    }

    // 打开管理器
    const btnOpenManager = document.getElementById('btn-open-manager');
    if (btnOpenManager) {
      btnOpenManager.addEventListener('click', () => {
        chrome.tabs.create({ url: '../pages/download-manager.html' });
      });
      console.log('[Popup] btn-open-manager bound');
    }

    // 打开设置
    const btnOpenSettings = document.getElementById('btn-open-settings');
    if (btnOpenSettings) {
      btnOpenSettings.addEventListener('click', () => {
        chrome.tabs.create({ url: '../pages/settings.html' });
      });
      console.log('[Popup] btn-open-settings bound');
    }

    // 模态框
    const modalClose = document.getElementById('modal-close');
    if (modalClose) {
      modalClose.addEventListener('click', () => {
        modalDetail.classList.remove('active');
      });
    }

    if (modalDetail) {
      modalDetail.addEventListener('click', (e) => {
        if (e.target === modalDetail) modalDetail.classList.remove('active');
      });
    }

    const modalDownload = document.getElementById('modal-download');
    if (modalDownload) {
      modalDownload.addEventListener('click', async () => {
        if (selectedUrl) {
          const item = capturedUrls.find(u => u.url === selectedUrl);
          if (item) {
            await downloadItem(item);
            modalDetail.classList.remove('active');
          }
        }
      });
    }

    console.log('[Popup] All listeners bound');
  }

  // 下载单个
  async function downloadItem(item) {
    try {
      if (item.status === 'parsed' || item.status === 'downloading') {
        const settings = await StorageUtils.getSettings();
        const taskId = Date.now().toString();
        const task = {
          id: taskId,
          url: item.url,
          name: getFileName(item.url),
          segments: item.segments,
          encryption: item.encryption,
          totalSegments: item.segments?.length || 0,
          downloadedSegments: 0,
          progress: 0,
          status: 'pending',
          createdAt: Date.now()
        };
        await StorageUtils.addTask(task);
        await StorageUtils.updateCapturedUrl(item.url, { status: 'downloading', taskId });
        showToast('开始下载', getFileName(item.url), 'success');

        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'START_DOWNLOAD',
              payload: { taskId, task, settings }
            });
          } catch (e) {}
        }

        await loadCapturedUrls();
      } else {
        showToast('正在解析', item.url, 'info');
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'PARSE_M3U8',
              payload: { url: item.url }
            });
          } catch (e) {}
        }
        await loadCapturedUrls();
      }
    } catch (err) {
      console.error('[Popup] Download error:', err);
      showToast('下载失败', err.message, 'error');
    }
  }

  // Toast 提示
  function showToast(title, message, type = 'info') {
    const container = document.querySelector('.toast-container') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-message">${escapeHtml(message)}</div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function createToastContainer() {
    const c = document.createElement('div');
    c.className = 'toast-container';
    document.body.appendChild(c);
    return c;
  }

  // 工具函数
  function sendMessage(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, response => {
        resolve(response || {});
      });
    });
  }

  function getDomain(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function getFileName(url) {
    try {
      const path = new URL(url).pathname;
      const name = path.split('/').pop();
      return name || 'video';
    } catch { return 'video'; }
  }

  function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    return m + ':' + s.toString().padStart(2, '0');
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(1) + ' ' + units[i];
  }

  function estimateSize(item) {
    if (!item.segments || item.segments.length === 0) return 0;
    const avgSegSize = 2 * 1024 * 1024;
    return item.segments.length * avgSegSize;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // 暴露给全局
  window.copyUrl = function(url) {
    navigator.clipboard.writeText(url).then(() => showToast('已复制', url, 'success'));
  };

  window.deleteUrl = async function(url) {
    await StorageUtils.deleteCapturedUrl(url);
    await loadCapturedUrls();
  };

  // DOM 加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 监听 service worker 的统计刷新广播
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATS_REFRESH') {
      loadCapturedUrls();
    }
    return false;
  });

  console.log('[Popup] Script loaded, waiting for init...');
})();
