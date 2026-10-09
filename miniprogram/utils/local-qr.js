/**
 * 本地二维码生成（不依赖任何外部服务 / 网络）
 *
 * 为什么要有这个文件：备用文本二维码原来用 api.qrserver.com 生成，
 * 但 `wx.downloadFile` 强制校验「downloadFile 合法域名白名单」，
 * 该域名是外国服务、无 ICP 备案，**无法加入白名单**（<image> 展示不受限，
 * 但另存为必失败：downloadFile:fail invalid url）。
 *
 * 方案：qrcode-generator（MIT, Kazuhiko Arase）出点阵 →
 *       纯 JS 编码成灰度 PNG（zlib 用 stored 块，无需压缩库）→
 *       FileSystemManager 写入 USER_DATA_PATH → 交给 image-save 另存。
 * 全平台可用（PC 另存为 / 移动端存相册），且完全离线。
 */

const qrcode = require('./qrcode-generator')

// ================= PNG 编码（灰度 8bit，colorType=0） =================

/** CRC32（PNG chunk 校验用） */
const CRC_TABLE = (function () {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Adler-32（zlib 流尾校验用） */
function adler32(bytes) {
  let a = 1, b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** PNG chunk = 长度(4BE) + 类型(4) + 数据 + CRC32(4BE) */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const len = data.length
  out[0] = (len >>> 24) & 0xff; out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff;  out[3] = len & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = crc32(out.subarray(4, 8 + len))
  out[8 + len] = (crc >>> 24) & 0xff; out[9 + len] = (crc >>> 16) & 0xff
  out[10 + len] = (crc >>> 8) & 0xff; out[11 + len] = crc & 0xff
  return out
}

/** 把原始扫描线数据包成 zlib 流（zlib 头 + stored/未压缩块 + adler32），避免依赖压缩库 */
function zlibStore(raw) {
  const maxBlock = 65535
  const nBlocks = Math.ceil(raw.length / maxBlock) || 1
  const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4)
  let p = 0
  // zlib 流头：CMF=0x78(deflate,32K) + FLG=0x01（使 (CMF<<8|FLG)%31===0，FDICT=0）
  out[p++] = 0x78; out[p++] = 0x01
  if (raw.length === 0) {
    out[p++] = 0x01; out[p++] = 0x00; out[p++] = 0x00; out[p++] = 0xff; out[p++] = 0xff
  }
  for (let i = 0; i < nBlocks; i++) {
    const start = i * maxBlock
    const len = Math.min(maxBlock, raw.length - start)
    const final = i === nBlocks - 1 ? 0x01 : 0x00
    out[p++] = final
    out[p++] = len & 0xff; out[p++] = (len >>> 8) & 0xff
    const nlen = (~len) & 0xffff
    out[p++] = nlen & 0xff; out[p++] = (nlen >>> 8) & 0xff
    out.set(raw.subarray(start, start + len), p)
    p += len
  }
  const ad = adler32(raw)
  out[p++] = (ad >>> 24) & 0xff; out[p++] = (ad >>> 16) & 0xff
  out[p++] = (ad >>> 8) & 0xff;  out[p++] = ad & 0xff
  return out.subarray(0, p)
}

/**
 * 点阵 → 灰度 PNG（ArrayBuffer）
 * @param {number[][]|{getModuleCount,isDark}} matrixOrQr
 * @param {number} scale 每个模块的像素数
 * @param {number} margin 四周静区（模块数，规范建议 ≥4）
 */
function qrToPng(qr, scale, margin) {
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * scale
  // 每行 = 1 filter 字节 + size 个灰度像素
  const stride = size + 1
  const raw = new Uint8Array(stride * size)
  raw.fill(0xff) // 白底
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue
      const y0 = (r + margin) * scale
      const x0 = (c + margin) * scale
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = (y0 + dy) * stride + 1 + x0
        raw.fill(0x00, rowStart, rowStart + scale)
      }
    }
  }
  // 过滤字节全部置 0（None）
  for (let y = 0; y < size; y++) raw[y * stride] = 0x00

  // IHDR: width/height(4BE) + bitDepth=8 + colorType=0 + 0,0,0
  const ihdr = new Uint8Array(13)
  ihdr[0] = (size >>> 24) & 0xff; ihdr[1] = (size >>> 16) & 0xff
  ihdr[2] = (size >>> 8) & 0xff;  ihdr[3] = size & 0xff
  ihdr[4] = (size >>> 24) & 0xff; ihdr[5] = (size >>> 16) & 0xff
  ihdr[6] = (size >>> 8) & 0xff;  ihdr[7] = size & 0xff
  ihdr[8] = 8   // bit depth
  ihdr[9] = 0   // color type: grayscale
  // 10/11/12 = compression/filter/interlace = 0，默认即 0

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStore(raw)),
    pngChunk('IEND', new Uint8Array(0))
  ]
  const total = parts.reduce((s, x) => s + x.length, 0)
  const png = new Uint8Array(total)
  let p = 0
  parts.forEach(x => { png.set(x, p); p += x.length })
  return { buffer: png.buffer, size, moduleCount: count }
}

// ================= 落盘 =================

/**
 * 生成二维码 PNG 并写入 USER_DATA_PATH
 * @param {string} text     二维码内容（如 order.qrContent || order.id）
 * @param {string} fileName 落地文件名（会覆盖同名文件）
 * @returns {{ path: string, size: number, moduleCount: number }}
 */
function writeQrFile(text, fileName) {
  const content = String(text == null ? '' : text)
  if (!content) throw new Error('二维码内容为空')

  const qr = qrcode(0, 'M') // 0 = 自动选版本；M 纠错（与外部服务默认一致级别）
  qr.addData(content)
  qr.make()

  const count = qr.getModuleCount()
  const margin = 4
  // 目标边长 ~420px，限制在 [4,10] 像素/模块
  const scale = Math.max(4, Math.min(10, Math.floor(420 / (count + margin * 2))))

  const png = qrToPng(qr, scale, margin)

  let mgr = null
  try { mgr = wx.getFileSystemManager() } catch (e) { mgr = null }
  if (!mgr || !wx.env || !wx.env.USER_DATA_PATH) {
    throw new Error('当前环境不支持写入本地文件')
  }
  const path = `${wx.env.USER_DATA_PATH}/${fileName}`
  try { mgr.unlinkSync(path) } catch (e) { /* 不存在，忽略 */ }
  mgr.writeFileSync(path, png.buffer, 'binary')
  return { path, size: png.size, moduleCount: png.moduleCount }
}

/** 供 Node 离线自测：只生成 PNG，不落盘 */
function buildQrPng(text, scale, margin) {
  const qr = qrcode(0, 'M')
  qr.addData(String(text == null ? '' : text))
  qr.make()
  return qrToPng(qr, scale || 8, margin == null ? 4 : margin)
}

module.exports = {
  writeQrFile,
  buildQrPng,
  zlibStore,
  crc32,
  adler32
}
