# M3U8 Stream Catcher

Chrome / Edge 浏览器插件，自动捕获网页中的 M3U8 链接，一键解析并下载 HLS 视频流。

**版本**: 1.0.3 | **Manifest**: V3

---

## 功能特性

### 核心功能
- **自动捕获**：访问网页时自动检测 DOM 和网络请求中的 M3U8 链接
- **多策略捕获**：
  - DOM 扫描（`<script>`、`<video>`、`<a>`）
  - 网络请求拦截（fetch / XHR Hook）
  - HLS.js / Video.js 播放器检测
  - MutationObserver 动态内容监控（懒加载页面）
- **智能解析**：自动解析 M3U8 分片列表，处理 Master Playlist（多码率，自动选择最高画质）
- **AES-128 解密**：支持主流 HLS 加密视频，含防盗链 Referer 支持
- **并发下载**：多线程并发下载分片，失败自动重试（每个分片最多重试 3 次）

### 大文件处理策略（核心亮点）
- **小文件（≤ 阈值）**：分片在内存中合并为 Blob，直接触发下载，速度快
- **大文件（> 阈值）**：分片分批写入 Blob 流，最后合并下载，避免内存溢出
- **阈值可配置**：默认 **200MB**，可在设置中自由调整
- **可视化进度条**：直观展示内存合并 vs 流式合并的分界

### UI 界面
- **Popup 弹窗**：快速查看捕获列表，支持多选批量下载
- **下载管理器**：查看所有下载任务，支持暂停/继续/删除/断点续传
- **设置页面**：大文件阈值、并发数、自动捕获开关等完整配置

---

## 目录结构

```
m3u8-browser-extension/
├── manifest.json              # Manifest V3 配置
├── popup/
│   ├── popup.html             # 插件主入口弹窗
│   └── popup.js               # 弹窗逻辑（多选批量下载）
├── pages/
│   ├── download-manager.html  # 下载管理页面
│   ├── download-manager.js    # 下载管理器逻辑
│   ├── settings.html          # 设置页面（含大文件阈值配置）
│   └── settings.js            # 设置逻辑
├── background/
│   └── service-worker.js      # 后台服务（任务调度、下载管理、断点续传）
├── content/
│   └── content-script.js      # DOM扫描 + 播放器检测 + 网络拦截
├── lib/
│   ├── m3u8-parser.js         # M3U8 解析器（支持 Master Playlist，含递归深度限制）
│   ├── segment-downloader.js   # 并发分片下载器
│   ├── merger.js              # 分片合并器（大文件阈值 + 密钥缓存）
│   ├── crypto-utils.js        # AES-128 解密（含防盗链 Referer）
│   └── storage-utils.js       # 配置和任务存储
└── assets/
    ├── styles.css             # 全局样式
    └── icons/                 # 图标
```

---

## 大文件阈值配置说明

### 配置项
- **largeFileThreshold**（大文件阈值）：默认 `200 * 1024 * 1024`（200MB）
- **largeFileStrategy**（大文件策略）：默认 `stream`（流式合并）

### 处理逻辑
```
Merger.decideStrategy(totalBytes, threshold):
  ├─ totalBytes <= threshold  →  'memory'  → mergeInMemory() → Blob URL 下载
  └─ totalBytes > threshold   →  'stream'  → 分批 Blob 合并 → 触发下载
```

### 预设值
| 预设 | 说明 | 适用场景 |
|------|------|----------|
| 50 MB | 严格内存限制 | 低内存设备 |
| 100 MB | 较严格 | 短视频 |
| 150 MB | 中等 | 短视频 |
| **200 MB** | **默认推荐** | 普通视频（5-30分钟） |
| 300 MB | 宽松 | 长视频 |
| 500 MB | 较宽松 | 完整剧集 |
| 1 GB | 宽松 | 超长视频 |
| 不限制 | 全流式 | 追求稳定，不关心速度 |

### 为什么默认 200MB？
- 普通网页视频（H.264 1080p 30fps，10秒分片）约 1-3MB/片
- 10分钟视频 ≈ 60分片 × 2MB ≈ 120MB
- 30分钟视频 ≈ 180分片 × 2MB ≈ 360MB
- 200MB 作为阈值，能覆盖大部分日常视频，同时保护浏览器内存

---

## 安装方法

### 方法一：开发者模式安装（推荐开发/测试）

1. 打开 Chrome/Edge，地址栏输入 `chrome://extensions/`（Edge 用 `edge://extensions/`）
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目文件夹 `m3u8-browser-extension`
5. 插件图标出现在工具栏，点击即可使用

### 方法二：打包为 .crx 文件（长期使用）

1. 在 `chrome://extensions/` 页面
2. 点击 **打包扩展程序**
3. 选择项目文件夹
4. 生成 `.crx` 文件（以及对应的 `.pem` 私钥文件）
5. 将 `.crx` 文件拖入扩展页面即可安装
6. 如果提示"无法加载扩展"，先将 `.crx` 改为 `.zip` 解压后用开发者模式加载

### 方法三：Chrome Web Store 发布（公开发布）

1. 注册 [Chrome Web Store 开发者](https://chrome.google.com/webstore/devconsole)（需 $5 注册费）
2. 打包为 `.zip`：`web-ext build` 或手动压缩
3. 上传至开发者后台，填写描述、截图
4. 提交审核（通常 1-3 天）
5. 审核通过后公开发布

### 方法四：web-ext 工具（自动化打包）

```bash
# 安装
npm install -g web-ext

# 打包（生成 .zip）
cd m3u8-browser-extension
web-ext build

# 输出在 ./web-ext-artifacts/ 目录
```

---

## 使用流程

1. **安装插件** → 点击工具栏图标打开 Popup
2. **访问视频网页** → 插件自动捕获 M3U8 链接
3. **勾选链接** → 可单选查看详情，也可多选批量操作
4. **点击下载** → 开始下载分片，支持暂停/断点续传
5. **下载完成** → 自动合并，触发浏览器下载保存为 MP4

---

## 技术栈

- **Manifest V3**（Chrome 扩展最新规范）
- **原生 JavaScript**（无框架依赖，轻量高效）
- **Web Crypto API**（AES-128-CBC 解密）
- **Streams API**（大文件流式合并）
- **Blob API**（内存合并 + 分块合并）
- **chrome.storage**（配置和任务持久化）
- **Fetch API**（带防盗链 Referer）

---

## 已知限制

- 部分网站有防盗链机制（Referer / Cookie），可在设置中手动配置
- 大文件下载可能受浏览器超时限制，建议调整超时时间
- ffmpeg.wasm 合并功能为预留接口，需额外加载 ffmpeg.wasm（设置中可选）
- Service Worker 在浏览器关闭时会被终止，下载进度通过 storage 持久化，支持断点续传

---

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)
