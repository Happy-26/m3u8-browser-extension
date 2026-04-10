/**
 * Crypto Utilities - AES-128 解密
 * 参考 Android 项目 EncryptionUtils.kt 的实现逻辑
 */

const CryptoUtils = {

  /**
   * 将十六进制字符串转换为 ArrayBuffer
   * @param {string} hex
   * @returns {ArrayBuffer}
   */
  hexToBuffer(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes.buffer;
  },

  /**
   * 将 ArrayBuffer 转换为十六进制字符串
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * 将 IV 字符串转换为 ArrayBuffer
   * IV 可以是 "0x..." 格式或纯十六进制字符串
   * @param {string} iv
   * @returns {ArrayBuffer}
   */
  parseIV(iv) {
    if (!iv) return null;
    let hex = iv;
    if (hex.startsWith('0x') || hex.startsWith('0X')) {
      hex = hex.substring(2);
    }
    // IV 必须是 16 字节，不足前面补 0
    hex = hex.padStart(32, '0');
    return this.hexToBuffer(hex);
  },

  /**
   * 导入 AES-128 密钥
   * @param {ArrayBuffer} keyData - 16 字节密钥
   * @returns {Promise<CryptoKey>}
   */
  async importKey(keyData) {
    return await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-CBC', length: 128 },
      false,
      ['decrypt']
    );
  },

  /**
   * 从 URL 下载解密密钥
   * @param {string} url
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchKey(url, referer = null) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    };
    // CDN 防盗链多数需要 Referer，优先使用传入值，否则用 key URL 的 origin
    if (referer) {
      headers['Referer'] = referer;
    } else {
      try {
        headers['Referer'] = new URL(url).origin + '/';
      } catch {}
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error('Failed to fetch key: HTTP ' + response.status);
    }
    return await response.arrayBuffer();
  },

  /**
   * AES-128-CBC 解密单个分片
   * @param {ArrayBuffer} encryptedData - 加密的分片数据
   * @param {CryptoKey} key - 解密密钥
   * @param {ArrayBuffer} iv - 初始化向量
   * @returns {Promise<ArrayBuffer>}
   */
  async decryptSegment(encryptedData, key, iv) {
    return await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: new Uint8Array(iv) },
      key,
      encryptedData
    );
  },

  /**
   * 使用加密配置解密分片数据
   * @param {ArrayBuffer} encryptedData - 加密数据
   * @param {Object} encryption - 加密配置 { method, uri, iv }
   * @param {CryptoKey|null} cachedKey - 已缓存的密钥
   * @returns {Promise<{data: ArrayBuffer, key: CryptoKey}>}
   */
  async decryptWithEncryption(encryptedData, encryption, cachedKey = null) {
    if (!encryption || encryption.method !== 'AES-128') {
      return { data: encryptedData, key: cachedKey };
    }

    // 获取密钥（携带 Referer 头，防止 CDN 防盗链拦截）
    let key = cachedKey;
    if (!key && encryption.uri) {
      const keyReferer = encryption.uri.startsWith('http')
        ? new URL(encryption.uri).origin + '/'
        : null;
      const keyData = await this.fetchKey(encryption.uri, keyReferer);
      key = await this.importKey(keyData);
    }

    if (!key) {
      throw new Error('No encryption key available');
    }

    // 解析 IV
    const iv = encryption.IV
      ? this.parseIV(encryption.IV)
      : this.hexToBuffer('00000000000000000000000000000000'); // 默认全零 IV

    // 解密
    const decryptedData = await this.decryptSegment(encryptedData, key, iv);
    return { data: decryptedData, key };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CryptoUtils;
}
