# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
