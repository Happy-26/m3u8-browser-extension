/**
 * Content Script - DOM 扫描 + 播放器检测
 * 策略A：自动捕获 M3U8 链接
 *
 * 捕获策略：
 * 1. DOM 扫描：扫描 script、video、source、a 标签中的 m3u8 链接
 * 2. 网络请求拦截：通过 postMessage 通知 service-worker（已在 manifest 中配置）
 * 3. HLS.js / Video.js 检测：检测页面中运行的播放器实例
 */

(function () {
  'use strict';

  // 避免重复注入
  if (window.__M3U8_CATCHER_LOADED__) return;
  window.__M3U8_CATCHER_LOADED__ = true;

  // 页面信息
  const pageInfo = {
    url: window.location.href,
    title: document.title,
    domain: window.location.hostname,
    capturedAt: Date.now()
  };

  // 已捕获的 URL（避免重复）
  const capturedUrls = new Set();

  /**
   * 检测 URL 是否为 M3U8
   */
  function isM3U8Url(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('/live/') || lower.includes('m3u8?');
  }

  /**
   * 规范化 URL
   */
  function normalizeUrl(raw) {
    if (!raw) return null;
    try {
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        return raw;
      }
      if (raw.startsWith('//')) {
        return window.location.protocol + raw;
      }
      return new URL(raw, window.location.href).href;
    } catch {
      return null;
    }
  }

  /**
   * 向 background script 报告捕获到的 URL
   */
  function reportUrl(url) {
    if (!url || capturedUrls.has(url)) return;
    capturedUrls.add(url);

    // 通过 Chrome API 发送（content script 与 background 通信）
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'M3U8_CAPTURED',
        payload: {
          url,
          pageUrl: pageInfo.url,
          pageTitle: pageInfo.title,
          pageDomain: pageInfo.domain,
          capturedAt: Date.now()
        }
      }).catch(() => {
        // 忽略连接错误（如 background 未就绪）
      });
    }
  }

  // ========== 策略1：DOM 扫描 ==========

  function scanDOM() {
    const results = [];

    // 扫描所有 <script> 标签内容
    document.querySelectorAll('script').forEach(script => {
      if (!script.textContent) return;
      const matches = script.textContent.match(/[^"'>\s]+\.m3u8[^"'<\s]*/gi);
      if (matches) {
        matches.forEach(m => {
          const url = normalizeUrl(m.trim());
          if (url) results.push(url);
        });
      }
    });

    // 扫描 <video> 和 <audio> 标签
    document.querySelectorAll('video, audio').forEach(el => {
      const src = el.getAttribute('src');
      if (isM3U8Url(src)) {
        results.push(normalizeUrl(src));
      }
      // 扫描 <source> 子标签
      el.querySelectorAll('source').forEach(source => {
        const src = source.getAttribute('src');
        if (isM3U8Url(src)) {
          results.push(normalizeUrl(src));
        }
      });
    });

    // 扫描 <a> 链接
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (isM3U8Url(href)) {
        results.push(normalizeUrl(href));
      }
    });

    // 扫描 iframe
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.getAttribute('src');
      if (isM3U8Url(src)) {
        results.push(normalizeUrl(src));
      }
    });

    // 扫描 data-src / data-url 等懒加载属性
    document.querySelectorAll('[data-src], [data-url], [data-video], [data-hls]').forEach(el => {
      ['data-src', 'data-url', 'data-video', 'data-hls'].forEach(attr => {
        const val = el.getAttribute(attr);
        if (isM3U8Url(val)) {
          results.push(normalizeUrl(val));
        }
      });
    });

    // 去重并报告
    results.forEach(url => reportUrl(url));
  }

  // ========== 策略2：拦截 fetch/XHR 中的 M3U8 请求 ==========

  function hookNetwork() {
    // hook fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const response = await originalFetch.apply(this, args);

      if (isM3U8Url(url) && response.url) {
        reportUrl(normalizeUrl(response.url));
      }

      return response;
    };

    // hook XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (isM3U8Url(url)) {
        reportUrl(normalizeUrl(url));
      }
      return originalXHROpen.call(this, method, url, ...rest);
    };
  }

  // ========== 策略3：HLS.js / Video.js 检测 ==========

  function detectPlayers() {
    // 检测 HLS.js 实例
    if (window.Hls && window.hlsInstances) {
      window.hlsInstances.forEach(hls => {
        if (hls.url) {
          reportUrl(normalizeUrl(hls.url));
        }
      });
    }

    // 检测原生 video 的 HLS
    document.querySelectorAll('video').forEach(video => {
      // 通过 video.src 检测（部分浏览器可直接获取 HLS 链接）
      if (video.src && isM3U8Url(video.src)) {
        reportUrl(normalizeUrl(video.src));
      }

      // 如果 video 由 HLS.js 控制
      if (video._hls) {
        const levels = video._hls.levels || [];
        levels.forEach(level => {
          if (level.url) {
            reportUrl(normalizeUrl(level.url));
          }
        });
      }

      // Video.js
      if (video.dataset.vjsVideoId && video.dataset.accountId) {
        // Brightcove 视频
      }
    });

    // 检测 dash.js
    if (window.dashjs && window.MediaPlayer) {
      // DASH 检测（通常是 .mpd，这里不处理）
    }
  }

  // ========== 策略4：MutationObserver 动态内容监控 ==========

  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      let hasNewContent = false;
      mutations.forEach(mutation => {
        if (mutation.addedNodes.length > 0) {
          hasNewContent = true;
        }
      });
      if (hasNewContent) {
        // 节流：延迟扫描
        clearTimeout(window._m3u8ScanTimer);
        window._m3u8ScanTimer = setTimeout(scanDOM, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ========== 初始化 ==========

  function init() {
    // 立即扫描
    scanDOM();

    // 启动网络拦截
    try {
      hookNetwork();
    } catch (e) {
      console.warn('[M3U8 Catcher] Network hook failed:', e);
    }

    // 检测播放器
    detectPlayers();

    // 监控动态内容
    observeDynamicContent();

    // 页面加载完成后再次扫描（处理懒加载）
    if (document.readyState === 'complete') {
      setTimeout(scanDOM, 2000);
    } else {
      window.addEventListener('load', () => {
        setTimeout(scanDOM, 2000);
      });
    }

    // 监听来自 background 的查询请求
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'M3U8_CATCHER_PING') {
        // 回复已就绪
        event.source.postMessage({
          type: 'M3U8_CATCHER_PONG',
          payload: {
            url: window.location.href,
            title: document.title,
            capturedCount: capturedUrls.size
          }
        }, event.origin);
      }
    });

    // 监听来自 popup 或 service-worker 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[M3U8 Catcher] Received message:', message.type);
      
      if (message.type === 'MANUAL_SCAN') {
        scanDOM();
        sendResponse({ success: true });
      } else if (message.type === 'PARSE_M3U8') {
        // 转发到 service worker 处理，content script 不应执行合并等重量级操作
        chrome.runtime.sendMessage(message, (r) => sendResponse(r || {}));
        return true;
      } else if (message.type === 'START_DOWNLOAD') {
        // 转发到 service worker 处理
        chrome.runtime.sendMessage(message, (r) => sendResponse(r || {}));
        return true;
      } else if (message.type === 'MERGE_AND_DOWNLOAD') {
        // 分片已下载并存入 IndexedDB（service worker 下载时持久化）
        // MV3 content script 无法直接 importScripts，改为动态加载 lib 模块
        const { taskId, task, settings } = message.payload || {};

        async function doMerge() {
          try {
            // 按依赖顺序加载：crypto-utils → idb-utils → merger
            await Promise.all([
              loadScript(chrome.runtime.getURL('lib/crypto-utils.js')),
              loadScript(chrome.runtime.getURL('lib/idb-utils.js')),
              loadScript(chrome.runtime.getURL('lib/merger.js'))
            ]);

            if (typeof IDBStorage === 'undefined' || typeof Merger === 'undefined') {
              throw new Error('Failed to load merger modules: IDBStorage=' + typeof IDBStorage + ', Merger=' + typeof Merger);
            }

            // 从 IndexedDB 恢复分片数据（chrome.storage.local 不再存 ArrayBuffer）
            const segmentData = await IDBStorage.getSegments(taskId);
            if (!segmentData || Object.keys(segmentData).length === 0) {
              throw new Error('No segment data in IDB for task: ' + taskId);
            }

            // 构造 segmentResults（{ seq: ArrayBuffer }）供 merger 使用
            const segmentResults = {};
            for (const [seq, data] of Object.entries(segmentData)) {
              segmentResults[parseInt(seq)] = data;
            }

            // 合并进度回调：通知 service worker 更新进度
            const onMergeProgress = (info) => {
              chrome.runtime.sendMessage({
                type: 'MERGE_PROGRESS',
                payload: { taskId, ...info }
              }).catch(() => {});
            };

            await Merger.mergeAndStreamDownload(
              task.segments,
              segmentResults,
              task.encryption,
              task.name,
              onMergeProgress,
              settings
            );

            // 合并完成后清理 IndexedDB（节省空间）
            await IDBStorage.deleteSegments(taskId);

            // 通知 service worker 合并完成
            chrome.runtime.sendMessage({
              type: 'MERGE_COMPLETE',
              payload: { taskId }
            }).catch(() => {});

          } catch (err) {
            console.error('[M3U8 Catcher] Merge error:', err);
            // 通知 service worker 合并失败
            chrome.runtime.sendMessage({
              type: 'MERGE_ERROR',
              payload: { taskId, error: err.message }
            }).catch(() => {});
          }
        }

        doMerge();
        return;
      }

      return false;
    });

    /**
     * 动态加载 JS 脚本（返回 Promise，重复加载自动跳过）
     */
    function loadScript(src) {
      return new Promise((resolve) => {
        if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { console.error('[M3U8 Catcher] Failed to load:', src); resolve(); };
        document.head.appendChild(s);
      });
    }
  }

  // Storage 操作
  async function updateCapturedUrl(url, updates) {
    return new Promise((resolve) => {
      chrome.storage.local.get('capturedUrls', (result) => {
        const urls = result.capturedUrls || [];
        const idx = urls.findIndex(u => u.url === url);
        if (idx !== -1) {
          urls[idx] = { ...urls[idx], ...updates };
        }
        chrome.storage.local.set({ capturedUrls: urls }, resolve);
      });
    });
  }

  async function updateTask(taskId, updates) {
    return new Promise((resolve) => {
      chrome.storage.local.get('tasks', (result) => {
        const tasks = result.tasks || [];
        const idx = tasks.findIndex(t => t.id === taskId);
        if (idx !== -1) {
          tasks[idx] = { ...tasks[idx], ...updates };
        }
        chrome.storage.local.set({ tasks }, resolve);
      });
    });
  }

  // 等 DOM 准备就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
