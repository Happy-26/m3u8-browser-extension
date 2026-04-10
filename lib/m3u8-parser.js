/**
 * M3U8 Parser
 * 解析 M3U8 文件，提取分片列表和加密信息
 * 参考 Android 项目 M3U8ParserService.kt 的实现逻辑
 */

const M3U8Parser = {

  /**
   * 解析 M3U8 内容
   * @param {string} content - M3U8 文件内容
   * @param {string} baseUrl - 基础 URL，用于解析相对路径
   * @returns {Object} 解析结果 { segments, isMasterPlaylist, bandwidth, resolution, encryption }
   */
  async parse(content, baseUrl) {
    const lines = content.split(/\r?\n/);
    const result = {
      segments: [],
      isMasterPlaylist: false,
      bandwidth: null,
      resolution: null,
      encryption: null,
      totalDuration: 0,
      variantStreams: []  // 多码率 playlist
    };

    let currentSegment = null;
    let currentDuration = 0;
    let state = 'idle'; // idle | header | segment

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 跳过空行和注释
      if (!line || line.startsWith('#')) {
        // M3U8 文件头
        if (line === '#EXTM3U') {
          state = 'header';
          continue;
        }

        // 媒体列表信息
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          result.targetDuration = parseInt(line.split(':')[1], 10);
        }

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          result.mediaSequence = parseInt(line.split(':')[1], 10);
        }

        if (line.startsWith('#EXT-X-KEY:')) {
          result.encryption = this._parseEncryption(line);
        }

        if (line.startsWith('#EXT-X-BANDWIDTH:')) {
          const bandwidth = parseInt(line.split(':')[1], 10);
          if (currentSegment) {
            currentSegment.bandwidth = bandwidth;
          } else {
            result.bandwidth = bandwidth;
          }
        }

        if (line.startsWith('#EXT-X-RESOLUTION:')) {
          result.resolution = line.split(':')[1];
        }

        // 变体流 (Master Playlist)
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          result.isMasterPlaylist = true;
          const attrs = this._parseAttributes(line);
          result.variantStreams.push({
            bandwidth: parseInt(attrs['BANDWIDTH'] || '0', 10),
            resolution: attrs['RESOLUTION'],
            codecs: attrs['CODECS'],
            uri: this._resolveUrl(baseUrl, lines[i + 1]?.trim())
          });
          i++; // 跳过下一行的 URI
          continue;
        }

        // 分片信息
        if (line.startsWith('#EXTINF:')) {
          const parts = line.split(':')[1].split(',');
          currentDuration = parseFloat(parts[0]);
          currentSegment = {
            duration: currentDuration,
            title: parts[1] || '',
            url: null,
            seq: result.segments.length
          };
          state = 'segment';
          continue;
        }

        // 分片加密方法结束
        if (line === '#EXT-X-KEY:METHOD=NONE') {
          result.encryption = null;
        }

        if (line.startsWith('#EXT-X-DISCONTINUITY')) {
          if (currentSegment) {
            currentSegment.discontinuity = true;
          }
        }

        continue;
      }

      // 非注释行 = URL
      if (state === 'segment' && currentSegment) {
        currentSegment.url = this._resolveUrl(baseUrl, line);
        result.totalDuration += currentDuration;
        result.segments.push(currentSegment);
        currentSegment = null;
        state = 'header';
      }
    }

    return result;
  },

  /**
   * 解析 EXT-X-KEY 属性
   * @param {string} line
   * @returns {Object|null}
   */
  _parseEncryption(line) {
    const attrs = this._parseAttributes(line);
    const method = attrs['METHOD'];

    if (!method || method === 'NONE') {
      return null;
    }

    const encryption = {
      method: method,
      uri: attrs['URI'] ? attrs['URI'].replace(/"/g, '') : null,
      IV: attrs['IV'] ? attrs['IV'].replace(/"/g, '') : null,  // AES-128 解密必须知道 IV
      keyFormat: attrs['KEYFORMAT'],
      keyFormatVersions: attrs['KEYFORMATVERSIONS']
    };

    if (method === 'AES-128') {
      encryption.key = null; // 需通过 URI 下载
    }

    if (method === 'SAMPLE-AES') {
      encryption.cryptoVersion = attrs['IV'];
    }

    return encryption;
  },

  /**
   * 解析 #EXT-X-KEY:... 或 #EXT-X-STREAM-INF:... 中的属性
   * @param {string} line
   * @returns {Object}
   */
  _parseAttributes(line) {
    const attrs = {};
    const attrString = line.split(':').slice(1).join(':');
    const regex = /([A-Z-]+)=(?:"([^"]*)"|([^",\s]+))/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
      attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  },

  /**
   * 解析相对 URL 或绝对 URL
   * @param {string} baseUrl
   * @param {string} url
   * @returns {string}
   */
  _resolveUrl(baseUrl, url) {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    if (url.startsWith('//')) {
      return (baseUrl.startsWith('https') ? 'https:' : 'http:') + url;
    }
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  },

  /**
   * 从 URL 获取 M3U8 内容
   * @param {string} url
   * @returns {Promise<string>}
   */
  async fetch(url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': new URL(url).origin + '/'
      }
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText);
    }
    return await response.text();
  },

  /**
   * 仅解析 Master Playlist，返回所有变体流（不自动递归）
   * @param {string} url - M3U8 URL
   * @returns {Promise<{isMasterPlaylist, variantStreams, originalUrl}>}
   */
  async parseMasterPlaylist(url) {
    const content = await this.fetch(url);
    const result = await this.parse(content, url);

    if (result.isMasterPlaylist && result.variantStreams.length > 0) {
      // 按带宽降序排列，方便 UI 展示
      result.variantStreams.sort((a, b) => b.bandwidth - a.bandwidth);
      result.variantStreams.forEach((v, i) => {
        v.label = _buildVariantLabel(v, i);
      });
    }

    return {
      isMasterPlaylist: result.isMasterPlaylist,
      variantStreams: result.variantStreams || [],
      originalUrl: url
    };
  }

  /**
   * 完整解析流程：获取 + 解析（带递归深度限制防止恶意嵌套）
   * @param {string} url - M3U8 URL
   * @param {number} depth - 当前递归深度（内部使用）
   * @returns {Promise<Object>}
   */
  async parseFromUrl(url, depth = 0) {
    // 防止递归嵌套过深（超过 5 层直接取第一个变体流）
    if (depth > 5) {
      console.warn('[M3U8Parser] Recursion depth exceeded, stopping at level', depth);
      const content = await this.fetch(url);
      return await this.parse(content, url);
    }

    const content = await this.fetch(url);
    const result = await this.parse(content, url);

    if (result.isMasterPlaylist && result.variantStreams.length > 0) {
      result.variantStreams.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = result.variantStreams[0];
      if (best.uri) {
        return await this.parseFromUrl(best.uri, depth + 1);
      }
    }

    result.originalUrl = url;
    return result;
  }

  /**
   * 生成变体流可读标签
   */
  function _buildVariantLabel(v, index) {
    const parts = [];
    if (v.resolution) parts.push(v.resolution);
    if (v.bandwidth) {
      const mbps = (v.bandwidth / 1_000_000).toFixed(1);
      parts.push(mbps + ' Mbps');
    }
    if (v.codecs) {
      const videoCodec = v.codecs.split(',')[0].trim();
      parts.push(videoCodec);
    }
    if (parts.length === 0) return `清晰度 ${index + 1}`;
    return parts.join(' · ');
  },

  /**
   * 估算总文件大小
   * @param {Array} segments
   * @returns {number} 字节数估算
   */
  estimateTotalSize(segments) {
    if (!segments || segments.length === 0) return 0;
    return segments.reduce((acc, seg) => acc + (seg.estimatedSize || 2 * 1024 * 1024), 0);
  },

  /**
   * 快速检测 URL 是否为 M3U8
   * @param {string} url
   * @returns {boolean}
   */
  isM3U8Url(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return lower.endsWith('.m3u8') || lower.includes('.m3u8?') || lower.includes('/live/') || lower.includes('/hls/');
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = M3U8Parser;
}

// 浏览器环境全局导出（window 用于 content script，self 用于 service worker）
if (typeof window !== 'undefined') {
  window.M3U8Parser = M3U8Parser;
}
if (typeof self !== 'undefined') {
  self.M3U8Parser = M3U8Parser;
}
