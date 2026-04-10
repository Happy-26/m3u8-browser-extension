/**
 * Service Worker - 后台服务（Manifest V3）
 * 负责：M3U8 拦截、任务调度、下载管理、跨页面通信
 */

// 导入核心模块（通过 importScripts）
importScripts('../lib/m3u8-parser.js', '../lib/crypto-utils.js', '../lib/storage-utils.js');
// segment-downloader.js 未被 service-worker 直接调用（service-worker 自己实现了下载逻辑）

// 内存中的任务队列（Service Worker 生命周期有限，需持久化存储）
const activeTasks = new Map();

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

// ========== 下载任务管理 ==========

async function startDownload(payload) {
  const { url, segments, encryption, fileName, totalBytes, settings } = payload;

  const task = SegmentDownloader.createTask({
    url,
    name: fileName,
    segments,
    encryption,
    maxConcurrency: settings.maxConcurrency,
    maxRetries: settings.maxRetries,
    onProgress: (t, seg, size) => onTaskProgress(t.id, t),
    onComplete: (t, results) => onTaskComplete(t.id, t, results),
    onError: (t, err) => onTaskError(t.id, t, err)
  });

  task.totalBytes = totalBytes || 0;
  task.segmentData = {};

  // 保存到存储
  await StorageUtils.addTask(task);
  activeTasks.set(task.id, task);

  // 更新捕获 URL 状态
  await StorageUtils.updateCapturedUrl(url, { status: 'downloading', taskId: task.id });

  // 启动下载
  await runDownload(task, settings);

  return { success: true, taskId: task.id };
}

async function runDownload(task, settings) {
  // 按并发度分批下载（跳过已下载的分片，支持断点续传）
  const queue = task.segments.filter(seg => !(seg.seq in task.segmentData));
  const results = [];

  task.abortController = new AbortController();
  const signal = task.abortController.signal;

  while (queue.length > 0) {
    if (task.status === 'paused' || signal.aborted) {
      break;
    }

    // 收集当前批次
    const batch = [];
    while (batch.length < task.maxConcurrency && queue.length > 0) {
      batch.push(queue.shift());
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

    // 处理批次结果（用 Promise.allSettled 的 index 找对应分片）
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const seg = batch[i];
      if (result.status === 'fulfilled') {
        task.segmentData[result.value.seq] = result.value.data;
        results.push(result.value);
        task.downloadedSegments++;
        task.downloadedBytes += result.value.size;
        task.progress = Math.round((task.downloadedSegments / task.totalSegments) * 100);

        // 计算速度
        if (task.startTime) {
          const elapsed = (Date.now() - task.startTime) / 1000;
          task.speed = Math.round(task.downloadedBytes / elapsed);
        }

        // 同时持久化已下载的分片数据（支持断点续传恢复）
        await StorageUtils.updateTask(task.id, {
          downloadedSegments: task.downloadedSegments,
          downloadedBytes: task.downloadedBytes,
          progress: task.progress,
          speed: task.speed,
          status: 'running',
          segmentData: task.segmentData
        });
      } else {
        // 将失败的分片重新加入队列末尾重试（最多重试 maxRetries 次）
        const segRetryCount = (task._segmentRetries || {})[seg.seq] || 0;
        if (segRetryCount < task.maxRetries) {
          task._segmentRetries = task._segmentRetries || {};
          task._segmentRetries[seg.seq] = segRetryCount + 1;
          queue.push(seg);
          console.warn(`[ServiceWorker] Requeue segment ${seg.seq} (attempt ${segRetryCount + 1}/${task.maxRetries}):`, result.reason?.message || result.reason);
        } else {
          task.retryCount++;
          console.error('[ServiceWorker] Segment permanently failed after', task.maxRetries, 'attempts:', result.reason);
        }
      }
    }
  }

  if (task.status !== 'paused') {
    task.status = 'completed';
    task.progress = 100;
    await onTaskComplete(task.id, task, results);
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

  // 执行合并（在标签页上下文中执行，service worker 无法触发下载）
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
}

function pauseDownload(taskId) {
  const task = activeTasks.get(taskId);
  if (task && task.abortController) {
    task.abortController.abort();
  }
  task.status = 'paused';
  // 暂停时也要持久化 segmentData，确保下次恢复时数据不丢失
  StorageUtils.updateTask(taskId, { status: 'paused', segmentData: task.segmentData });
  return { success: true };
}

async function resumeDownload(taskId) {
  const tasks = await StorageUtils.getTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const settings = await StorageUtils.getSettings();
  task.status = 'running';
  task.segmentData = task.segmentData || {};
  task.downloadedSegments = task.downloadedSegments || 0;
  task.downloadedBytes = task.downloadedBytes || 0;
  task.abortController = null;
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
