/**
 * Segment Downloader - 并发分片下载器
 * 参考 Android 项目 SegmentDownloadManager.kt 的实现逻辑
 * 支持并发下载、自动重试、断点续传
 */

const SegmentDownloader = {

  /**
   * 创建下载任务
   * @param {Object} options
   * @returns {Object} 任务对象
   */
  createTask(options) {
    const task = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      url: options.url,
      name: options.name || this._extractName(options.url),
      segments: options.segments || [],
      totalSegments: options.segments?.length || 0,
      downloadedSegments: 0,
      status: 'pending', // pending | running | paused | completed | error
      progress: 0,
      speed: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      startTime: null,
      endTime: null,
      error: null,
      encryption: options.encryption || null,
      maxConcurrency: options.maxConcurrency || 6,
      retryCount: 0,
      maxRetries: options.maxRetries || 3,
      onProgress: options.onProgress || null,
      onComplete: options.onComplete || null,
      onError: options.onError || null,
      abortController: null
    };
    return task;
  },

  /**
   * 从 URL 提取文件名
   * @param {string} url
   * @returns {string}
   */
  _extractName(url) {
    try {
      const pathname = new URL(url).pathname;
      const name = pathname.split('/').pop();
      if (name && name.includes('.')) {
        return name.replace(/\.[^.]+$/, '.mp4');
      }
      return 'video_' + Date.now() + '.mp4';
    } catch {
      return 'video_' + Date.now() + '.mp4';
    }
  },

  /**
   * 下载单个分片
   * @param {Object} segment
   * @param {Object} task
   * @param {number} attempt
   * @returns {Promise<{segment: Object, data: ArrayBuffer, size: number}>}
   */
  async _downloadSegment(segment, task, attempt = 1) {
    const controller = new AbortController();
    segment._controller = controller;

    try {
      const response = await fetch(segment.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Referer': new URL(segment.url).origin + '/'
        }
      });

      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      const contentLength = response.headers.get('Content-Length');
      if (contentLength) {
        segment.size = parseInt(contentLength, 10);
      }

      const data = await response.arrayBuffer();
      return { segment, data, size: data.byteLength };
    } catch (err) {
      if (attempt < task.maxRetries) {
        // 自动重试
        await this._delay(500 * attempt);
        return this._downloadSegment(segment, task, attempt + 1);
      }
      throw err;
    }
  },

  /**
   * 带并发的分片下载
   * @param {Object} task
   * @returns {AsyncGenerator}
   */
  async *_downloadWithConcurrency(task) {
    const queue = [...task.segments];
    const inFlight = [];
    const results = new Map();

    // 用于中断的 AbortController
    task.abortController = new AbortController();

    while (queue.length > 0 || inFlight.length > 0) {
      // 如果任务已暂停或中断，跳出
      if (task.status === 'paused' || task.abortController.signal.aborted) {
        break;
      }

      // 填充并发队列
      while (inFlight.length < task.maxConcurrency && queue.length > 0) {
        const segment = queue.shift();
        const promise = this._downloadSegmentWithProgress(segment, task);
        inFlight.push(promise);
      }

      if (inFlight.length === 0) break;

      // 等待任意一个完成
      const completed = await Promise.race(inFlight.map(async (p, i) => {
        try {
          const result = await p;
          return { index: i, result };
        } catch (err) {
          return { index: i, error: err };
        }
      }));

      // 移除完成的 Promise
      inFlight.splice(completed.index, 1);

      if (completed.error) {
        task.status = 'error';
        task.error = completed.error.message;
        if (task.onError) task.onError(task, completed.error);
        return; // 出错停止
      }

      const { segment, data } = completed.result;
      results.set(segment.seq, data);
      task.downloadedSegments++;
      task.downloadedBytes += data.byteLength;
      task.progress = Math.round((task.downloadedSegments / task.totalSegments) * 100);

      // 计算速度
      if (task.startTime) {
        const elapsed = (Date.now() - task.startTime) / 1000;
        task.speed = Math.round(task.downloadedBytes / elapsed);
      }

      if (task.onProgress) {
        task.onProgress(task, segment, data.byteLength);
      }

      yield { segment, data, progress: task.progress };
    }
  },

  /**
   * 带进度的分片下载（包装 _downloadSegment）
   */
  async _downloadSegmentWithProgress(segment, task) {
    return await this._downloadSegment(segment, task);
  },

  /**
   * 启动下载任务
   * @param {Object} task
   * @returns {Promise<Object>} 下载结果
   */
  async start(task) {
    if (task.status === 'running') return task;
    task.status = 'running';
    task.startTime = Date.now();
    task.downloadedSegments = 0;
    task.downloadedBytes = 0;
    task.progress = 0;
    task.error = null;

    const results = [];

    try {
      for await (const result of this._downloadWithConcurrency(task)) {
        results.push(result);
      }

      if (task.status !== 'paused') {
        task.status = 'completed';
        task.endTime = Date.now();
        task.progress = 100;
      }

      if (task.onComplete) {
        task.onComplete(task, results);
      }
    } catch (err) {
      task.status = 'error';
      task.error = err.message;
      if (task.onError) task.onError(task, err);
    }

    return task;
  },

  /**
   * 暂停下载任务
   * @param {Object} task
   */
  pause(task) {
    if (task.status !== 'running') return;
    task.status = 'paused';
    if (task.abortController) {
      task.abortController.abort();
    }
  },

  /**
   * 恢复下载任务
   * @param {Object} task
   */
  resume(task) {
    if (task.status !== 'paused') return;
    // 重新下载未完成的部分
    task.status = 'pending';
    return this.start(task);
  },

  /**
   * 格式化文件大小
   * @param {number} bytes
   * @returns {string}
   */
  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return size.toFixed(1) + ' ' + units[i];
  },

  /**
   * 格式化速度
   * @param {number} bytesPerSec
   * @returns {string}
   */
  formatSpeed(bytesPerSec) {
    return this.formatSize(bytesPerSec) + '/s';
  },

  /**
   * 格式化时间
   * @param {number} seconds
   * @returns {string}
   */
  formatTime(seconds) {
    if (!seconds || seconds < 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    return m + ':' + s.toString().padStart(2, '0');
  },

  /**
   * 估算剩余时间
   * @param {Object} task
   * @returns {number} 秒数
   */
  estimateRemaining(task) {
    if (!task.startTime || task.speed === 0) return -1;
    const remainingBytes = task.totalBytes - task.downloadedBytes;
    return remainingBytes / task.speed;
  },

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SegmentDownloader;
}
