/**
 * Storage Utils - 配置存储管理
 * 管理所有用户配置和任务状态，含大文件阈值配置
 */

const StorageUtils = {

  DEFAULT_SETTINGS: {
    // 下载设置
    maxConcurrency: 6,
    maxRetries: 3,
    maxConcurrentTasks: 2,
    connectTimeout: 30000,
    downloadTimeout: 60000,

    // ===== 大文件处理设置（核心配置项） =====
    // largeFileThreshold: 大文件阈值（字节），默认 200MB
    //   - 小于此值：分片在内存中合并，直接下载（速度快）
    //   - 大于此值：流式分块合并下载（避免内存溢出）
    //   - 设为 0：不限制，全部使用流式合并
    largeFileThreshold: 200 * 1024 * 1024, // 200 MB
    // largeFileStrategy: 大文件处理策略
    //   - 'stream': 流式分块合并（默认，推荐）
    //   - 'ffmpeg': ffmpeg.wasm 合并（暂未实现）
    largeFileStrategy: 'stream',

    // 自动捕获设置
    autoCapture: true,
    autoParse: true,
    autoSelectHighestQuality: true,
    autoDownload: false,

    // UI 设置
    showNotifications: true,
    notificationTarget: 'popup',
    autoCloseNotification: true,
    showFloatingButton: true,
    fabPosition: 'bottom-right',
    themeColor: '#0078D4'
  },

  THRESHOLD_PRESETS: [
    { label: '50 MB', value: 50 * 1024 * 1024 },
    { label: '100 MB', value: 100 * 1024 * 1024 },
    { label: '150 MB', value: 150 * 1024 * 1024 },
    { label: '200 MB (推荐)', value: 200 * 1024 * 1024 },
    { label: '300 MB', value: 300 * 1024 * 1024 },
    { label: '500 MB', value: 500 * 1024 * 1024 },
    { label: '1 GB', value: 1024 * 1024 * 1024 },
    { label: '不限制（全部流式合并）', value: 0 }
  ],

  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (result) => {
        resolve(result.settings ? { ...this.DEFAULT_SETTINGS, ...result.settings } : { ...this.DEFAULT_SETTINGS });
      });
    });
  },

  async saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ settings }, resolve);
    });
  },

  async updateSetting(key, value) {
    const settings = await this.getSettings();
    settings[key] = value;
    await this.saveSettings(settings);
  },

  async resetSettings() {
    await this.saveSettings(this.DEFAULT_SETTINGS);
    return this.DEFAULT_SETTINGS;
  },

  async getTasks() {
    return new Promise((resolve) => {
      chrome.storage.local.get('tasks', (result) => {
        resolve(result.tasks || []);
      });
    });
  },

  async saveTasks(tasks) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ tasks }, resolve);
    });
  },

  async addTask(task) {
    const tasks = await this.getTasks();
    tasks.push(task);
    await this.saveTasks(tasks);
    return task;
  },

  async updateTask(taskId, updates) {
    const tasks = await this.getTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], ...updates };
      await this.saveTasks(tasks);
    }
  },

  async deleteTask(taskId) {
    const tasks = await this.getTasks();
    await this.saveTasks(tasks.filter(t => t.id !== taskId));
  },

  async clearCompletedTasks() {
    const tasks = await this.getTasks();
    await this.saveTasks(tasks.filter(t => t.status !== 'completed'));
  },

  async getCapturedUrls() {
    return new Promise((resolve) => {
      chrome.storage.local.get('capturedUrls', (result) => {
        resolve(result.capturedUrls || []);
      });
    });
  },

  async addCapturedUrl(urlInfo) {
    const urls = await this.getCapturedUrls();
    const exists = urls.some(u => u.url === urlInfo.url);
    if (!exists) {
      urls.unshift({ ...urlInfo, capturedAt: Date.now(), checked: false, status: 'pending' });
      await this._save(urls);
    }
    return !exists;
  },

  async updateCapturedUrl(url, updates) {
    const urls = await this.getCapturedUrls();
    const idx = urls.findIndex(u => u.url === url);
    if (idx !== -1) {
      urls[idx] = { ...urls[idx], ...updates };
      await this._save(urls);
    }
  },

  async deleteCapturedUrl(url) {
    const urls = await this.getCapturedUrls();
    await this._save(urls.filter(u => u.url !== url));
  },

  async clearCapturedUrls() {
    await this._save([]);
  },

  _save(urls) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ capturedUrls: urls }, resolve);
    });
  },

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(1) + ' ' + units[i];
  }
};
