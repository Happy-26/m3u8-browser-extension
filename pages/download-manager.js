// Download Manager Page - 下载管理器页面逻辑
(function() {
  'use strict';

  const tabContent = document.getElementById('tab-content');
  let currentTab = 'downloads';

  function sendMessage(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, r => resolve(r || {}));
    });
  }

  function initEventListeners() {
    // Tab 切换
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        if (currentTab === 'downloads') renderDownloads();
        else renderCaptured();
      });
    });

    // 设置按钮
    document.getElementById('btn-open-settings').addEventListener('click', openSettings);

    // 添加链接按钮
    document.getElementById('btn-add-url').addEventListener('click', openPopup);
  }

  // ========== 下载任务 ==========
  async function renderDownloads() {
    const tasks = await sendMessage({ type: 'GET_TASKS' });
    document.getElementById('tab-downloads-count').textContent = tasks.length;

    if (!tasks || tasks.length === 0) {
      tabContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#128229;</div>
          <div class="empty-state-title">暂无下载任务</div>
          <div class="empty-state-desc">在弹出窗口中添加 M3U8 链接即可开始下载。也可以点击右上角"添加链接"直接输入。</div>
          <button class="btn btn-primary mt-16" id="btn-add-url-empty">&#43; 添加 M3U8 链接</button>
        </div>
      `;
      document.getElementById('btn-add-url-empty').addEventListener('click', openPopup);
      return;
    }

    const runningTasks = tasks.filter(t => t.status === 'running');
    const completedTasks = tasks.filter(t => t.status === 'completed');
    const errorTasks = tasks.filter(t => t.status === 'error');
    const pausedTasks = tasks.filter(t => t.status === 'paused');

    tabContent.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="display:flex;gap:16px;font-size:13px;color:var(--text-secondary);">
          ${runningTasks.length ? '<span style="color:var(--primary);font-weight:600;">&#127938; ' + runningTasks.length + ' 下载中</span>' : ''}
          ${pausedTasks.length ? '<span style="color:var(--warning);font-weight:600;">&#9208; ' + pausedTasks.length + ' 已暂停</span>' : ''}
          ${completedTasks.length ? '<span style="color:var(--success);font-weight:600;">&#9989; ' + completedTasks.length + ' 已完成</span>' : ''}
          ${errorTasks.length ? '<span style="color:var(--error);font-weight:600;">&#10060; ' + errorTasks.length + ' 失败</span>' : ''}
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-clear-completed">清空已完成</button>
      </div>

      <div class="task-list">
        ${tasks.map(t => renderTaskCard(t)).join('')}
      </div>
    `;

    // 绑定动态生成的任务按钮事件
    tasks.forEach(t => {
      const pauseBtn = document.getElementById('pause-' + t.id);
      const resumeBtn = document.getElementById('resume-' + t.id);
      const delBtn = document.getElementById('del-task-' + t.id);
      if (pauseBtn) pauseBtn.addEventListener('click', () => pauseTask(t.id));
      if (resumeBtn) resumeBtn.addEventListener('click', () => resumeTask(t.id));
      if (delBtn) delBtn.addEventListener('click', () => deleteTask(t.id));
    });

    // 清空已完成按钮
    document.getElementById('btn-clear-completed').addEventListener('click', clearCompleted);
  }

  function renderTaskCard(task) {
    const statusLabel = { pending: '等待中', running: '下载中', paused: '已暂停', completed: '已完成', error: '下载失败' };
    const statusClass = task.status;

    const totalMB = (task.totalBytes || 0) / (1024 * 1024);
    const useMemory = totalMB <= 200;
    const mergeInfo = task.status === 'completed'
      ? '<div class="merge-info-bar"><span class="badge ' + (useMemory ? 'badge-success' : 'badge-warning') + '">' + (useMemory ? '&#9734; 内存合并' : '&#9889; 流式合并') + '</span><span>已保存到本地</span></div>'
      : (task.totalBytes ? '<div class="merge-info-bar"><span class="badge badge-muted">&#128190; 预计: ' + formatBytes(task.totalBytes) + '</span><span>完成后' + (useMemory ? '内存合并' : '流式合并') + '</span></div>' : '');

    return `
      <div class="task-card">
        <div class="task-header">
          <div class="task-info">
            <div class="task-name">${escapeHtml(task.name)}</div>
            <div class="task-meta">
              <span class="status-dot ${statusClass}"></span>
              <span>${statusLabel[task.status] || task.status}</span>
              ${task.totalSegments ? '<span>' + task.downloadedSegments + '/' + task.totalSegments + ' 分片</span>' : ''}
              ${task.totalBytes ? '<span>' + formatBytes(task.totalBytes) + '</span>' : ''}
              ${task.speed ? '<span style="color:var(--primary);">' + formatBytes(task.speed) + '/s</span>' : ''}
            </div>
          </div>
          <div class="task-actions">
            ${task.status === 'running' ? '<button class="btn btn-sm btn-secondary" id="pause-' + task.id + '">暂停</button>' : ''}
            ${task.status === 'paused' ? '<button class="btn btn-sm btn-primary" id="resume-' + task.id + '">继续</button>' : ''}
            <button class="btn btn-sm btn-danger" id="del-task-' + task.id + '">删除</button>
          </div>
        </div>
        ${mergeInfo}
        ${(task.status === 'running' || task.status === 'paused') ? `
          <div class="task-progress">
            <div class="task-progress-info">
              <span>${task.progress}%</span>
              <span class="task-remaining">剩余 ${formatTime(task.remainingTime)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-bar-fill ${task.status === 'paused' ? 'warning' : ''}" style="width:${task.progress}%"></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  async function pauseTask(id) {
    await sendMessage({ type: 'PAUSE_DOWNLOAD', payload: { taskId: id } });
    renderDownloads();
  }

  async function resumeTask(id) {
    await sendMessage({ type: 'RESUME_DOWNLOAD', payload: { taskId: id } });
    renderDownloads();
  }

  async function deleteTask(id) {
    await sendMessage({ type: 'DELETE_TASK', payload: { taskId: id } });
    renderDownloads();
  }

  async function clearCompleted() {
    if (confirm('确定清空所有已完成的任务？')) {
      await sendMessage({ type: 'CLEAR_COMPLETED_TASKS' });
      renderDownloads();
    }
  }

  // ========== 已捕获链接 ==========
  async function renderCaptured() {
    const urls = await sendMessage({ type: 'GET_CAPTURED_URLS' });
    document.getElementById('tab-captured-count').textContent = urls.length;

    if (!urls || urls.length === 0) {
      tabContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#128269;</div>
          <div class="empty-state-title">暂无捕获的链接</div>
          <div class="empty-state-desc">访问包含 M3U8 视频的网页，插件将自动检测并列出</div>
        </div>
      `;
      return;
    }

    tabContent.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="font-size:13px;color:var(--text-secondary);">共 ${urls.length} 条链接</div>
        <button class="btn btn-secondary btn-sm" id="btn-clear-all">清空全部</button>
      </div>
      <div class="card">
        <div class="list">
          ${urls.map(u => `
            <div class="list-item">
              <div class="list-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2">
                  <polygon points="23 7 16 12 23 17 23 7"/>
                  <rect x="1" y="5" width="15" height="14" rx="2"/>
                </svg>
              </div>
              <div class="list-item-content">
                <div class="list-item-title">${escapeHtml(getFileName(u.url))}</div>
                <div class="list-item-subtitle">${escapeHtml(u.pageDomain || u.url)}</div>
              </div>
              <span class="badge badge-${getStatusClass(u.status)}" style="margin-right:8px;">${getStatusLabel(u.status)}</span>
              <button class="btn-icon btn-delete-url" data-url="${escapeHtml(u.url)}" title="删除">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // 绑定清空全部按钮
    document.getElementById('btn-clear-all').addEventListener('click', clearAll);

    // 绑定删除按钮
    document.querySelectorAll('.btn-delete-url').forEach(btn => {
      btn.addEventListener('click', () => delUrl(btn.dataset.url));
    });
  }

  async function delUrl(url) {
    await sendMessage({ type: 'DELETE_CAPTURED_URL', payload: { url } });
    renderCaptured();
  }

  async function clearAll() {
    if (confirm('确定清空所有捕获的链接？')) {
      await sendMessage({ type: 'CLEAR_CAPTURED_URLS' });
      renderCaptured();
    }
  }

  // ========== 工具 ==========
  function openSettings() {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
  }

  function openPopup() {
    chrome.action.openPopup().catch(() => {
      chrome.tabs.create({ url: 'chrome://extensions/?toolbar' });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getFileName(url) {
    try { return new URL(url).pathname.split('/').pop() || 'video'; }
    catch { return 'video'; }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(1) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!seconds || seconds < 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + s + 's';
  }

  function getStatusClass(status) {
    return { pending: 'muted', parsed: 'primary', downloading: 'warning', completed: 'success', error: 'error' }[status] || 'muted';
  }

  function getStatusLabel(status) {
    return { pending: '待解析', parsed: '已解析', downloading: '下载中', completed: '已完成', error: '失败' }[status] || status;
  }

  // ========== 初始化 ==========
  let refreshInterval = null;

  function startRefreshInterval() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
      if (currentTab === 'downloads') renderDownloads();
    }, 3000);
  }

  async function init() {
    initEventListeners();
    renderDownloads();
    const urls = await sendMessage({ type: 'GET_CAPTURED_URLS' });
    document.getElementById('tab-captured-count').textContent = urls.length || 0;
    startRefreshInterval();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
