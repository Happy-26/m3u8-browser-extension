/**
 * Merger - 分片合并器
 *
 * 核心策略（基于大文件阈值配置）：
 * - 小文件（<= 阈值）：在内存中合并为 Blob，直接触发下载
 * - 大文件（> 阈值）：使用流式拼接，分块写入后触发下载
 *
 * 参考 Android 项目 MergeManager.kt 的实现逻辑
 *
 * 默认阈值：200MB
 * - 普通网页视频通常几十MB以内，直接内存合并速度快
 * - 超过200MB的完整剧集/电影，使用流式合并避免内存溢出
 */

const Merger = {

  // 默认大文件阈值：200MB
  DEFAULT_LARGE_FILE_THRESHOLD: 200 * 1024 * 1024,

  // 内存合并的最大安全阈值：500MB
  MAX_MEMORY_MERGE_SIZE: 500 * 1024 * 1024,

  /**
   * 根据文件总大小和阈值，决定使用哪种合并策略
   * @param {number} totalBytes - 文件总大小估算
   * @param {number} threshold - 大文件阈值（字节）
   * @returns {'memory' | 'stream'}
   */
  decideStrategy(totalBytes, threshold) {
    const safeThreshold = Math.min(threshold, this.MAX_MEMORY_MERGE_SIZE);
    if (totalBytes <= safeThreshold) {
      return 'memory';
    }
    return 'stream';
  },

  /**
   * 估算总文件大小
   * @param {Array} segments
   * @param {Array} downloadedData
   * @returns {number}
   */
  estimateTotalSize(segments, downloadedData = []) {
    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      if (downloadedData[i] && downloadedData[i].byteLength) {
        total += downloadedData[i].byteLength;
      } else if (segments[i] && segments[i].size) {
        total += segments[i].size;
      } else {
        total += 2 * 1024 * 1024;
      }
    }
    return total;
  },

  // ========== 内存合并（适用于小文件） ==========

  /**
   * 在内存中合并分片（Blob 方式）
   * @param {ArrayBuffer[]} dataArray
   * @param {Function} onProgress
   * @returns {Promise<Blob>}
   */
  async mergeInMemory(dataArray, onProgress = null) {
    if (!dataArray || dataArray.length === 0) {
      throw new Error('No data to merge');
    }

    const total = dataArray.length;
    const chunks = new Array(total);

    for (let i = 0; i < total; i++) {
      chunks[i] = dataArray[i];
      if (onProgress) {
        onProgress({
          phase: 'merging',
          current: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 100)
        });
      }
      if (i % 50 === 0) {
        await this._yield();
      }
    }

    return new Blob(chunks, { type: 'video/mp4' });
  },

  /**
   * 解密 + 内存合并
   * @param {Array} segments
   * @param {Object} segmentResults
   * @param {Object} encryption
   * @param {Object} settings
   * @param {Function} onProgress
   * @returns {Promise<Blob>}
   */
  async decryptAndMerge(segments, segmentResults, encryption, settings, onProgress = null) {
    const total = segments.length;
    const decryptedData = new Array(total);
    let cachedKey = null;
    let iv = null;

    if (encryption && encryption.IV) {
      iv = CryptoUtils.parseIV(encryption.IV);
    }

    for (let i = 0; i < total; i++) {
      let data = segmentResults[i];
      if (!data) {
        throw new Error('Missing segment data at index ' + i);
      }

      if (encryption && encryption.method === 'AES-128') {
        if (!cachedKey && encryption.uri) {
          const keyData = await CryptoUtils.fetchKey(encryption.uri);
          cachedKey = await CryptoUtils.importKey(keyData);
        }
        if (cachedKey) {
          const ivBuffer = iv || new ArrayBuffer(16);
          data = await CryptoUtils.decryptSegment(data, cachedKey, ivBuffer);
        }
      }

      decryptedData[i] = data;

      if (onProgress) {
        onProgress({
          phase: 'decrypting',
          current: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 100)
        });
      }
    }

    return await this.mergeInMemory(decryptedData, onProgress);
  },

  // ========== 流式合并（适用于大文件） ==========

  /**
   * 流式合并 + 下载
   * @param {Array} segments
   * @param {Object} segmentResults
   * @param {Object} encryption
   * @param {string} fileName
   * @param {Function} onProgress
   * @returns {Promise<void>}
   */
  async mergeAndStreamDownload(segments, segmentResults, encryption, fileName, onProgress = null, settings = {}) {
    const totalSize = this.estimateTotalSize(segments, Object.values(segmentResults).filter(Boolean));
    const threshold = settings.largeFileThreshold || this.DEFAULT_LARGE_FILE_THRESHOLD;
    const strategy = this.decideStrategy(totalSize, threshold);

    if (strategy === 'memory') {
      const blob = await this._batchMerge(segments, segmentResults, encryption, onProgress);
      this._triggerDownload(blob, fileName);
    } else {
      await this._largeFileMerge(segments, segmentResults, encryption, fileName, onProgress);
    }
  },

  /**
   * 分批内存合并（中等文件）
   * @param {Array} segments
   * @param {Object} segmentResults
   * @param {Object} encryption
   * @param {Function} onProgress
   * @returns {Promise<Blob>}
   */
  async _batchMerge(segments, segmentResults, encryption, onProgress) {
    const BATCH_SIZE = 50 * 1024 * 1024;
    const batches = [];
    let batchBuffer = [];
    let batchSize = 0;
    const cachedContext = {}; // 跨分片复用密钥

    for (let i = 0; i < segments.length; i++) {
      let data = segmentResults[i] || new ArrayBuffer(0);

      if (encryption && encryption.method === 'AES-128') {
        data = await this._decryptOne(segments[i], data, encryption, cachedContext);
      }

      if (batchSize + data.byteLength > BATCH_SIZE && batchBuffer.length > 0) {
        batches.push(new Blob(batchBuffer, { type: 'video/mp4' }));
        batchBuffer = [];
        batchSize = 0;
      }

      batchBuffer.push(new Uint8Array(data));
      batchSize += data.byteLength;

      if (onProgress) {
        onProgress({
          phase: 'batch_merging',
          current: i + 1,
          total: segments.length,
          percent: Math.round(((i + 1) / segments.length) * 100)
        });
      }
    }

    if (batchBuffer.length > 0) {
      batches.push(new Blob(batchBuffer, { type: 'video/mp4' }));
    }

    return new Blob(batches, { type: 'video/mp4' });
  },

  /**
   * 大文件流式处理
   * @param {Array} segments
   * @param {Object} segmentResults
   * @param {Object} encryption
   * @param {string} fileName
   * @param {Function} onProgress
   */
  async _largeFileMerge(segments, segmentResults, encryption, fileName, onProgress) {
    const CHUNK_SIZE = 100 * 1024 * 1024;
    let blobParts = [];
    let currentChunk = [];
    let currentChunkSize = 0;
    const cachedContext = {}; // 跨分片复用密钥

    for (let i = 0; i < segments.length; i++) {
      let data = segmentResults[i] || new ArrayBuffer(0);

      if (encryption && encryption.method === 'AES-128') {
        data = await this._decryptOne(segments[i], data, encryption, cachedContext);
      }

      currentChunk.push(new Uint8Array(data));
      currentChunkSize += data.byteLength;

      if (currentChunkSize >= CHUNK_SIZE) {
        blobParts.push(new Blob(currentChunk, { type: 'video/mp4' }));
        currentChunk = [];
        currentChunkSize = 0;
      }

      if (onProgress) {
        onProgress({
          phase: 'large_file_processing',
          current: i + 1,
          total: segments.length,
          percent: Math.round(((i + 1) / segments.length) * 100),
          note: '大文件分块写入中...'
        });
      }
    }

    if (currentChunk.length > 0) {
      blobParts.push(new Blob(currentChunk, { type: 'video/mp4' }));
    }

    const finalBlob = new Blob(blobParts, { type: 'video/mp4' });
    this._triggerDownload(finalBlob, fileName);
  },

  /**
   * 解密单个分片（密钥会被缓存在 context 中，下次调用自动复用）
   */
  async _decryptOne(segment, data, encryption, cachedContext = {}) {
    if (!encryption || !encryption.uri) return data;

    // 密钥已缓存则复用
    if (!cachedContext.key && encryption.uri) {
      const keyData = await CryptoUtils.fetchKey(encryption.uri);
      cachedContext.key = await CryptoUtils.importKey(keyData);
    }

    if (cachedContext.key) {
      const iv = encryption.IV ? CryptoUtils.parseIV(encryption.IV) : new ArrayBuffer(16);
      return await CryptoUtils.decryptSegment(data, cachedContext.key, iv);
    }
    return data;
  },

  /**
   * 触发浏览器下载
   * @param {Blob} blob
   * @param {string} fileName
   */
  _triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  },

  /**
   * 主合并入口 - 根据文件大小自动选择策略
   * @param {Object} task - 下载任务
   * @param {Object} settings - 用户配置 { largeFileThreshold, largeFileStrategy }
   * @param {Function} onProgress
   * @returns {Promise<void>}
   */
  async merge(task, settings = {}, onProgress = null) {
    const threshold = settings.largeFileThreshold || this.DEFAULT_LARGE_FILE_THRESHOLD;
    const totalSize = task.totalBytes || this.estimateTotalSize(task.segments, []);
    const strategy = this.decideStrategy(totalSize, threshold);

    if (strategy === 'stream' && settings.largeFileStrategy === 'ffmpeg') {
      return await this._ffmpegMerge(task, onProgress);
    }

    const segmentResults = {};
    if (task.segmentData) {
      for (const [seq, data] of Object.entries(task.segmentData)) {
        segmentResults[parseInt(seq)] = data;
      }
    }

    const dataArray = [];
    for (let i = 0; i < task.segments.length; i++) {
      dataArray.push(segmentResults[i] || new ArrayBuffer(0));
    }

    if (strategy === 'memory') {
      const blob = await this.decryptAndMerge(task.segments, dataArray, task.encryption, settings, onProgress);
      this._triggerDownload(blob, task.name);
    } else {
      await this.mergeAndStreamDownload(task.segments, segmentResults, task.encryption, task.name, onProgress, settings);
    }
  },

  /**
   * ffmpeg.wasm 合并（可选）
   */
  async _ffmpegMerge(task, onProgress) {
    console.warn('[Merger] ffmpeg.wasm merge not yet implemented - falling back to stream merge');
    return await this.mergeAndStreamDownload(task.segments, {}, task.encryption, task.name, onProgress);
  },

  _yield() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Merger;
}

// 浏览器环境全局导出
if (typeof window !== 'undefined') {
  window.Merger = Merger;
}
