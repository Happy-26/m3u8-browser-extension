# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.4] - 2026-04-10

### Fixed
- **【严重】下载进度永远为 0**：`runDownload` 中 `StorageUtils.updateTask()` 从未被调用，进度只存在内存中，UI 轮询读取 storage 永远看不到进度。修复：每批分片下载完成后显式调用 `updateTask()` + `broadcastToTabs(TASK_UPDATE)` 推送进度
- **【严重】暂停后数据丢失 / 电脑重启**：① `pauseDownload` 中 `IDBStorage.putSegments()` 未 await，service worker 被终止时本批数据丢失；② IDB 写入改为每 20 个分片批量写一次，减少 IDB 事务数量；③ `putSegments` 改为先读后合并（`{ ...existing, ...newSegments }`），避免覆盖旧分片
- **【严重】crypto-utils.js 无浏览器全局导出**：动态加载后 `window.CryptoUtils === undefined`，合并时解密模块不存在。修复：添加 `window.CryptoUtils` 和 `self.CryptoUtils` 导出
- **【严重】m3u8-parser.js 漏解析 IV 属性**：AES-128 解密时 `IV=null` 导致输出乱码或崩溃。修复：`_parseEncryption` 补充 `IV: attrs['IV']`
- **popup START_DOWNLOAD 静默失败**：消息盲目发给所有标签页 content script，service worker 未激活时全部静默吞异常。修复：popup 直接用 `chrome.runtime.sendMessage` 发给 service worker，同时修复 payload 字段结构
- **TaskQueue._runTask 死代码**：`task._onDone` 设置了但从未被调用，已删除

### Added
- `service-worker.js` 新增 `MERGE_PROGRESS` / `MERGE_COMPLETE` / `MERGE_ERROR` 消息处理（content script 合并阶段回调）
- `content-script.js` MERGE_AND_DOWNLOAD 增加完整 try/catch、合并进度回调、完成/失败通知

### Changed
- 新增 `lib/idb-utils.js`：IndexedDB 分片二进制存储模块
- `service-worker.js`：`runDownload` 中每批分片下载完成后持久化到 IndexedDB；批量写入优化（每 20 个分片一次事务）；`pauseDownload` 改为 async + await；`resumeDownload` 从 IndexedDB 恢复

## [1.0.3] - 2026-04-10

### Fixed
- **断点续传**: 暂停/恢复下载时，`segmentData` 现在正确持久化到 `chrome.storage`，恢复后跳过已下载分片而非重新下载全部
- **缺失消息处理器**: `service-worker.js` 补充了 `DELETE_TASK` 和 `CLEAR_COMPLETED_TASKS` 处理器（download-manager.html 中的删除/清空功能之前无效）
- **重试逻辑**: 分片下载失败后现在会重新加入队列重试（最多 `maxRetries` 次），而非静默丢弃
- **Referer 请求头**: `crypto-utils.js` 的 `fetchKey` 现在携带 Referer 头，防止 CDN 防盗链拦截 AES-128 密钥请求
- **M3U8 递归深度**: `parseFromUrl` 添加了递归深度限制（最多 5 层），防止恶意嵌套 Master Playlist 导致栈溢出
- **Content Script 职责**: 移除了 `content-script.js` 中无效的动态脚本加载，`PARSE_M3U8` / `START_DOWNLOAD` 消息现在正确转发给 service worker 处理

### Changed
- **merger.js**: `mergeAndStreamDownload` 现在接收并使用用户设置的 `largeFileThreshold`，而非硬编码 200MB
- **merger.js**: `_decryptOne` 重构为接收 `cachedContext`，密钥在整个合并流程中只下载一次
- **popup**: 新增多选批量下载功能，全选复选框 + 单项复选框 + "解析选中" / "下载选中"快捷按钮
- **popup**: `loadCapturedUrls` 现在会清理已不存在的选中项，防止悬空引用
- **service-worker**: `runDownload` 中的 `for...of` 改为 `for` 循环以正确追踪分片索引

## [1.0.2] - 2026-04-10

- 初始版本基础功能
