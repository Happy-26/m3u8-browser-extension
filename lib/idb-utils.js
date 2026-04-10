/**
 * IndexedDB Storage Utils - 大文件分片二进制存储
 *
 * 问题：chrome.storage.local 有 ~10MB 配额限制，
 * 大视频（数百个分片 × 数MB/分片）会直接爆掉。
 *
 * 解决方案：将 segmentData（ArrayBuffer 二进制）存入 IndexedDB，
 * chrome.storage.local 仅存元数据（不含二进制）。
 *
 * 数据库: m3u8-catcher-db
 * Object Store: segments (keyPath: taskId)
 */

const IDBStorage = {
  DB_NAME: 'm3u8-catcher-db',
  DB_VERSION: 1,
  STORE_NAME: 'segments',
  _db: null,

  /**
   * 打开数据库连接（惰性初始化）
   */
  async openDB() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(new Error('IDB: open failed: ' + request.error));

      request.onsuccess = () => {
        this._db = request.result;
        resolve(this._db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'taskId' });
          // 索引用于清理过期数据
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
    });
  },

  /**
   * 保存任务的分片数据（增量合并模式）
   * @param {string} taskId
   * @param {Object} newSegments - { seq: ArrayBuffer, ... } 新增分片（合并到已有数据）
   */
  async putSegments(taskId, newSegments) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const getReq = store.get(taskId);

      getReq.onsuccess = () => {
        const existing = getReq.result ? getReq.result.segments : {};
        const merged = { ...existing, ...newSegments };
        const record = {
          taskId,
          segments: merged,
          updatedAt: Date.now()
        };
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(new Error('IDB put failed: ' + putReq.error));
      };

      getReq.onerror = () => reject(new Error('IDB get failed: ' + getReq.error));
    });
  },

  /**
   * 加载任务的分片数据
   * @param {string} taskId
   * @returns {Promise<Object|null>} { seq: ArrayBuffer, ... } or null
   */
  async getSegments(taskId) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.get(taskId);
      req.onsuccess = () => {
        const record = req.result;
        resolve(record ? record.segments : null);
      };
      req.onerror = () => reject(new Error('IDB get failed: ' + req.error));
    });
  },

  /**
   * 删除任务的分片数据（任务完成后清理）
   * @param {string} taskId
   */
  async deleteSegments(taskId) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.delete(taskId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('IDB delete failed: ' + req.error));
    });
  },

  /**
   * 清理所有已完成任务的过期数据（>24小时）
   */
  async cleanExpired(maxAgeMs = 24 * 60 * 60 * 1000) {
    const db = await this.openDB();
    const cutoff = Date.now() - maxAgeMs;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const index = store.index('updatedAt');
      const range = IDBKeyRange.upperBound(cutoff);
      let deleted = 0;
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(new Error('IDB clean failed: ' + tx.error));
    });
  },

  /**
   * 估算 IndexedDB 中存储总量（调试用）
   */
  async estimateUsage() {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      let count = 0;
      let totalBytes = 0;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          count++;
          const segs = cursor.value.segments || {};
          for (const key in segs) {
            if (segs[key] instanceof ArrayBuffer) totalBytes += segs[key].byteLength;
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve({ count, totalBytes });
      tx.onerror = () => reject(new Error('IDB estimate failed: ' + tx.error));
    });
  }
};

// 浏览器环境全局导出
if (typeof window !== 'undefined') {
  window.IDBStorage = IDBStorage;
}
if (typeof self !== 'undefined') {
  self.IDBStorage = IDBStorage;
}
