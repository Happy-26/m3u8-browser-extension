/**
 * Service Worker - 后台服务（Manifest V3）
 * 负责：M3U8 拦截、任务调度、下载管理、跨页面通信
 */

// 导入核心模块（通过 importScripts）
importScripts('../lib/m3u8-parser.js', '../lib/crypto-utils.js', '../lib/storage-utils.js', '../lib/idb-utils.js');
// segment-downloader.js 未被 service-worker 直接调用（service-worker 自己实现了下载逻辑）

// 内存中的任务队列（Service Worker 生命周期有限，需持久化存储）
const activeTasks = new Map();

// ========== 并发任务队列管理 ==========
const TaskQueue = {
  _runningCount: 0,
  _maxConcurrent: 2, // 默认值，会在 startDownload 时用 settings 覆盖
  _queue: [],         // 待执行的任务队列

  /**
   * 入队，尝试立即执行或排队
   * @param {Object} task - 任务对象
   * @param {Object} settings - 用户设置（含 maxConcurrentTasks）
   */
  enqueue(task, settings) {
    this._maxConcurrent = settings.maxConcurrentTasks || 2;
    this._queue.push(task);
    this._dispatch();
  },

  _dispatch() {
    while (this._runningCount < this._maxConcurrent && this._queue.length > 0) {
      const next = this._queue.shift();
      this._runTask(next);
    }
  },

  async _runTask(task) {
    this._runningCount++;
    // 标记为队列管理模式：runDownload 完成后 / 暂停时 / 失败时调用 TaskQueue.notifyDone()
    task._queueManaged = true;
    await runDownload(task, {});
  },

  // 任务完成时（由 onTaskComplete/onTaskError/pauseDownload 调用）通知队列继续
  notifyDone() {
    this._runningCount = Math.max(0, this._runningCount - 1);
    this._dispatch();
  }
};

// ========== 消息监听 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[ServiceWorker] Message error:', err);
    sendResponse({ success: false, error: err.message });
  });
  return true; // 异步响应
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'M3U8_CAPTURED':
      return await onM3U8Captured(message.payload);

    case 'PARSE_M3U8':
      return await parseM3U8(message.payload.url);

    case 'PARSE_MASTER_PLAYLIST':
      return await parseMasterPlaylist(message.payload.url);

    case 'SELECT_VARIANT':
      return await parseM3U8(message.payload.variantUrl);

    case 'START_DOWNLOAD':
      return await startDownload(message.payload);

    case 'PAUSE_DOWNLOAD':
      return pauseDownload(message.payload.taskId);

    case 'RESUME_DOWNLOAD':
      return await resumeDownload(message.payload.taskId);

    case 'GET_TASKS':
      return await getTasks();

    case 'GET_CAPTURED_URLS':
      return await getCapturedUrls();

    case 'DELETE_CAPTURED_URL':
      return await deleteCapturedUrl(message.payload.url);

    case 'CLEAR_CAPTURED_URLS':
      return await StorageUtils.clearCapturedUrls();

    case 'DELETE_TASK':
      return await deleteTask(message.payload.taskId);

    case 'CLEAR_COMPLETED_TASKS':
      return await clearCompletedTasks();

    case 'MERGE_PROGRESS':
      return await onMergeProgress(message.payload);

    case 'MERGE_COMPLETE':
      return await onMergeComplete(message.payload);

    case 'MERGE_ERROR':
      return await onMergeError(message.payload);

    case 'GET_SETTINGS':
      return await StorageUtils.getSettings();

    case 'SAVE_SETTINGS':
      await StorageUtils.saveSettings(message.payload.settings);
      return { success: true };

    case 'OPEN_MANAGER':
      chrome.tabs.create({ url: '../pages/download-manager.html' });
      return { success: true };

    case 'OPEN_SETTINGS':
      chrome.tabs.create({ url: '../pages/settings.html' });
      return { success: true };

    default:
      return { success: false, error: 'Unknown message type: ' + message.type };
  }
}

// ========== M3U8 捕获处理 ==========

async function onM3U8Captured(payload) {
  const added = await StorageUtils.addCapturedUrl(payload);

  if (added) {
    // 发送通知
    const settings = await StorageUtils.getSettings();
    if (settings.showNotifications) {
      showNotification('检测到 M3U8 链接', payload.url, payload.pageTitle);
    }

    // 自动解析
    if (settings.autoParse) {
      // 异步解析，不阻塞
      parseM3U8(payload.url).catch(() => {});
    }
  }

  return { success: true, isNew: added };
}

// ========== M3U8 解析 ==========

async function parseM3U8(url) {
  try {
    const result = await M3U8Parser.parseFromUrl(url);

    await StorageUtils.updateCapturedUrl(url, {
      status: 'parsed',
      segments: result.segments,
      totalSegments: result.segments.length,
      totalDuration: result.totalDuration,
      resolution: result.resolution,
      bandwidth: result.bandwidth,
      encryption: result.encryption,
      parsedAt: Date.now()
    });

    // 估算文件大小
    let totalBytes = 0;
    result.segments.forEach(seg => {
      totalBytes += seg.size || (result.targetDuration * 1024 * 1024 * 0.125);
    });

    return {
      success: true,
      data: {
        ...result,
        totalBytes,
        segmentCount: result.segments.length,
        fileName: _generateFileName(url, result.resolution)
      }
    };
  } catch (err) {
    await StorageUtils.updateCapturedUrl(url, { status: 'error', error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * 解析 Master Playlist，返回所有变体流供用户选择
 */
async function parseMasterPlaylist(url) {
  try {
    const result = await M3U8Parser.parseMasterPlaylist(url);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ========== 下载任务管理 ==========

async function startDownload(payload) {
  const { url, segments, encryption, fileName, totalBytes, settings } = payload;

  const task = {
    id: payload.taskId || Date.now().toString(),
    url,
    name: fileName,
    segments,
    encryption,
    totalBytes: totalBytes || 0,
    segmentData: {},
    totalSegments: segments.length,
    downloadedSegments: 0,
    downloadedBytes: 0,
    progress: 0,
    speed: 0,
    retryCount: 0,
    _segmentRetries: {},
    maxConcurrency: settings.maxConcurrency,
    maxRetries: settings.maxRetries,
    status: 'queued',
    startTime: null,
    abortController: null
  };

  // 保存到存储
  await StorageUtils.addTask(task);
  activeTasks.set(task.id, task);

  // 更新捕获 URL 状态
  await StorageUtils.updateCapturedUrl(url, { status: 'downloading', taskId: task.id });

  // 进入并发任务队列（由队列管理器决定何时启动）
  TaskQueue.enqueue(task, settings);

  return { success: true, taskId: task.id };
}

async function runDownload(task, settings) {
  // 从 task 自身获取并发配置（startDownload 填充的）
  const maxConcurrency = task.maxConcurrency || (settings?.maxConcurrency) || 6;

  // 按并发度分批下载（跳过已下载的分片，支持断点续传）
  const pendingSegs = task.segments.filter(seg => !(seg.seq in task.segmentData));
  const results = [];

  task.abortController = new AbortController();
  const signal = task.abortController.signal;
  task.startTime = task.startTime || Date.now();
  task.status = 'running';

  // ========== 批量写入优化：每 BATCH_WRITE_SIZE 个分片写一次 IDB ==========
  const BATCH_WRITE_SIZE = 20;
  let pendingWrites = {}; // { seq: ArrayBuffer }
  let writeCounter = 0;

  while (pendingSegs.length > 0) {
    if (task.status === 'paused' || signal.aborted) {
      break;
    }

    // 收集当前批次
    const batch = [];
    while (batch.length < maxConcurrency && pendingSegs.length > 0) {
      batch.push(pendingSegs.shift());
    }

    // 并发下载当前批次
    const batchResults = await Promise.allSettled(
      batch.map(async (seg) => {
        const response = await fetch(seg.url, {
          signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Referer': new URL(seg.url).origin + '/'
          }
        });

        if (!response.ok) throw new Error('HTTP ' + response.status);

        const contentLength = response.headers.get('Content-Length');
        seg.size = contentLength ? parseInt(contentLength) : 0;

        const data = await response.arrayBuffer();
        return { seq: seg.seq, data, size: data.byteLength };
      })
    );

    // 处理批次结果
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const seg = batch[i];
      if (result.status === 'fulfilled') {
        task.segmentData[result.value.seq] = result.value.data;
        results.push(result.value);
        pendingWrites[result.value.seq] = result.value.data;
        task.downloadedSegments++;
        task.downloadedBytes += result.value.size;
        task.progress = Math.round((task.downloadedSegments / task.totalSegments) * 100);

        // 计算速度
        if (task.startTime) {
          const elapsed = (Date.now() - task.startTime) / 1000;
          task.speed = Math.round(task.downloadedBytes / elapsed);
        }

        // 批量写入 IndexedDB（每 BATCH_WRITE_SIZE 个分片写一次，减少 IDB 写入次数）
        writeCounter++;
        if (writeCounter >= BATCH_WRITE_SIZE || pendingSegs.length === 0) {
          await IDBStorage.putSegments(task.id, pendingWrites);
          pendingWrites = {};
          writeCounter = 0;
        }
      } else {
        // 将失败的分片重新加入队列末尾重试（最多重试 maxRetries 次）
        const segRetryCount = (task._segmentRetries || {})[seg.seq] || 0;
        if (segRetryCount < task.maxRetries) {
          task._segmentRetries = task._segmentRetries || {};
          task._segmentRetries[seg.seq] = segRetryCount + 1;
          pendingSegs.push(seg);
          console.warn(`[ServiceWorker] Requeue segment ${seg.seq} (attempt ${segRetryCount + 1}/${task.maxRetries}):`, result.reason?.message || result.reason);
        } else {
          task.retryCount++;
          console.error('[ServiceWorker] Segment permanently failed after', task.maxRetries, 'attempts:', result.reason);
        }
      }
    }

    // 【关键修复】每批下载完成后同步进度到 StorageUtils，让 UI 能看到更新
    await StorageUtils.updateTask(task.id, {
      downloadedSegments: task.downloadedSegments,
      downloadedBytes: task.downloadedBytes,
      progress: task.progress,
      speed: task.speed,
      status: task.status
    });

    // 广播进度更新到所有标签页
    broadcastToTabs({ type: 'TASK_UPDATE', payload: { ...task } });
  }

  // 退出循环时，把剩余的 pendingWrites 也持久化
  if (Object.keys(pendingWrites).length > 0) {
    await IDBStorage.putSegments(task.id, pendingWrites);
  }

  if (task.status !== 'paused') {
    task.status = 'completed';
    task.progress = 100;
    await onTaskComplete(task.id, task, results);
  }

  // 队列模式下通知队列可以启动下一个任务
  if (task._queueManaged) {
    TaskQueue.notifyDone();
  }
}

async function onTaskProgress(taskId, task) {
  await StorageUtils.updateTask(taskId, {
    progress: task.progress,
    downloadedSegments: task.downloadedSegments,
    downloadedBytes: task.downloadedBytes,
    speed: task.speed
  });

  // 广播到相关标签页
  broadcastToTabs({ type: 'TASK_UPDATE', payload: task });

  // 触发 popup 刷新统计栏（通知其重新加载数据）
  broadcastToTabs({ type: 'STATS_REFRESH' });
}

async function onTaskComplete(taskId, task, results) {
  task.status = 'completed';
  task.endTime = Date.now();
  task.progress = 100;

  await StorageUtils.updateTask(taskId, {
    status: 'completed',
    progress: 100,
    endTime: task.endTime
  });

  // 更新捕获 URL 状态
  await StorageUtils.updateCapturedUrl(task.url, { status: 'completed' });

  // 通知 popup/download-manager 执行合并
  broadcastToTabs({ type: 'TASK_COMPLETE', payload: { taskId, task } });

  showNotification('下载完成', task.name, '正在合并文件...');

  // 发送消息给所有标签页，让它们执行合并
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'MERGE_AND_DOWNLOAD',
        payload: {
          taskId,
          task,
          settings: await StorageUtils.getSettings()
        }
      });
    } catch {
      // 标签页可能没有加载 content script
    }
  }

}

async function onTaskError(taskId, task, err) {
  task.status = 'error';
  task.error = err.message;

  await StorageUtils.updateTask(taskId, {
    status: 'error',
    error: err.message
  });

  showNotification('下载失败', task.name, err.message);
  broadcastToTabs({ type: 'TASK_ERROR', payload: { taskId, error: err.message } });

  // 队列模式下通知队列可以启动下一个任务
  if (task._queueManaged) {
    TaskQueue.notifyDone();
  }
}

// ========== 合并阶段处理（content script 触发）==========

async function onMergeProgress(payload) {
  const { taskId, phase, percent } = payload;
  // 可选：将合并进度广播到 UI（目前合并在 content script 端完成，暂不写回 storage）
  broadcastToTabs({ type: 'TASK_UPDATE', payload: { id: taskId, mergeProgress: percent, mergePhase: phase } });
}

async function onMergeComplete(payload) {
  const { taskId } = payload;
  // 清理 IndexedDB 中的分片数据
  await IDBStorage.deleteSegments(taskId);
  // 从 activeTasks 中移除
  activeTasks.delete(taskId);
  showNotification('合并完成', '文件已保存', '点击查看');
  broadcastToTabs({ type: 'TASK_UPDATE', payload: { id: taskId, status: 'merged' } });
}

async function onMergeError(payload) {
  const { taskId, error } = payload;
  showNotification('合并失败', 'task: ' + taskId, error);
  broadcastToTabs({ type: 'TASK_ERROR', payload: { taskId, error: '合并失败: ' + error } });
}

async function pauseDownload(taskId) {
  const task = activeTasks.get(taskId);
  if (task && task.abortController) {
    task.abortController.abort();
  }
  task.status = 'paused';
  // 【关键修复】必须 await 写入 IDB，确保数据持久化完成后再返回
  // 否则 service worker 被终止时数据会丢失
  await IDBStorage.putSegments(taskId, task.segmentData);
  await StorageUtils.updateTask(taskId, {
    status: 'paused',
    downloadedSegments: task.downloadedSegments,
    progress: task.progress
  });
  // 队列模式下暂停也需要释放槽位
  if (task._queueManaged) TaskQueue.notifyDone();
  return { success: true };
}

async function resumeDownload(taskId) {
  const tasks = await StorageUtils.getTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const settings = await StorageUtils.getSettings();
  task.status = 'running';
  // 优先从 IndexedDB 恢复分片数据（chrome.storage.local 不再存 ArrayBuffer）
  task.segmentData = await IDBStorage.getSegments(taskId) || {};
  task.downloadedSegments = task.downloadedSegments || 0;
  task.downloadedBytes = task.downloadedBytes || 0;
  task.abortController = null;
  task.startTime = task.startTime || Date.now();
  task.maxConcurrency = task.maxConcurrency || settings.maxConcurrency;
  task.maxRetries = task.maxRetries || settings.maxRetries;
  activeTasks.set(task.id, task);
  await runDownload(task, settings);
  return { success: true };
}

async function getTasks() {
  return await StorageUtils.getTasks();
}

async function getCapturedUrls() {
  return await StorageUtils.getCapturedUrls();
}

async function deleteCapturedUrl(url) {
  await StorageUtils.deleteCapturedUrl(url);
  return { success: true };
}

async function deleteTask(taskId) {
  activeTasks.delete(taskId);
  await StorageUtils.deleteTask(taskId);
  return { success: true };
}

async function clearCompletedTasks() {
  await StorageUtils.clearCompletedTasks();
  return { success: true };
}

// ========== 工具函数 ==========

function _generateFileName(url, resolution) {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').pop().replace(/\.[^.]+$/, '');
    const suffix = resolution ? '_' + resolution.replace('x', 'x') : '';
    return (name || 'video') + suffix + '_' + Date.now() + '.mp4';
  } catch {
    return 'video_' + Date.now() + '.mp4';
  }
}

async function showNotification(title, body, text) {
  try {
    const settings = await StorageUtils.getSettings();
    if (!settings.showNotifications) return;

    await chrome.notifications.create({
      type: 'basic',
      iconUrl: '../assets/icons/icon48.png',
      title,
      message: body.substring(0, 50) + (body.length > 50 ? '...' : ''),
      priority: 1
    });
  } catch {
    // 通知不可用
  }
}

async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // 忽略
    }
  }
}

// ========== Service Worker 生命周期 ==========

// 保持 Service Worker 活跃
chrome.runtime.onInstalled.addListener(() => {
  console.log('[M3U8 Catcher] Service Worker installed');
});

// 定期清理已完成的任务
setInterval(async () => {
  const tasks = await StorageUtils.getTasks();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const oldTasks = tasks.filter(t =>
    (t.status === 'completed' || t.status === 'error') &&
    t.endTime < oneDayAgo
  );
  for (const t of oldTasks) {
    await StorageUtils.deleteTask(t.id);
  }
}, 60 * 60 * 1000); // 每小时检查一次
