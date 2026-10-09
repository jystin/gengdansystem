/**
 * 图纸文件工具
 *
 * 统一「拍照 / 相册 / 本地文件」的选择、归一化与预览：
 *   - 移动端（iOS / Android）：走 wx.chooseMedia，拍照或相册选图片
 *   - 电脑端（Windows / macOS）与开发者工具：走 wx.chooseMessageFile，
 *     从磁盘选择文件，支持 PDF（工厂常见：CAD 导出的 PDF 图纸）
 *
 * 归一化后的统一结构：
 *   { name, tempFilePath, size, type: 'image' | 'pdf', isPDF, ext }
 */

const ui = require('./ui')

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
const FILE_EXT = IMAGE_EXT.concat(['pdf'])
// 云存储单文件上限（小程序端 50MB）
const MAX_FILE_SIZE = 50 * 1024 * 1024

/** 当前运行平台：windows / mac / devtools / ios / android ... */
function getPlatform() {
  try {
    const info = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {}
    return String(info.platform || '').toLowerCase()
  } catch (e) {
    return ''
  }
}

/** 是否为电脑端（含开发者工具，方便在工具里测试 PDF 上传） */
function isDesktop() {
  const p = getPlatform()
  return p === 'windows' || p === 'mac' || p === 'devtools'
}

/** 取文件名/路径的扩展名（小写，不含点） */
function extOf(name) {
  const m = String(name || '').match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/)
  return m ? m[1].toLowerCase() : ''
}

function isPdfName(name) {
  return extOf(name) === 'pdf'
}

function isImageName(name) {
  return IMAGE_EXT.indexOf(extOf(name)) !== -1
}

/** 把不同 API 返回的文件对象归一化 */
function normalize(file) {
  const path = file.path || file.tempFilePath || ''
  const name = file.name || String(path).split('/').pop() || ''
  const ext = extOf(name) || extOf(path) || 'jpg'
  const isPDF = ext === 'pdf'
  const size = Number(file.size) || 0
  return {
    key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name || `drawing_${Date.now()}.${ext}`,
    tempFilePath: path,
    size,
    sizeText: formatSize(size),
    type: isPDF ? 'pdf' : 'image',
    isPDF,
    ext
  }
}

/** 从相册/相机选图片（移动端） */
function chooseFromAlbum(count) {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f, i) => normalize({
          path: f.tempFilePath,
          name: `drawing_${Date.now()}_${i}.jpg`,
          size: f.size
        }))
        resolve(files)
      },
      fail: () => resolve([])
    })
  })
}

/** 从本地磁盘/会话文件选文件（电脑端，支持 PDF） */
function chooseFromDisk(count) {
  if (typeof wx.chooseMessageFile !== 'function') {
    // 极老基础库降级为选图片
    return chooseFromAlbum(count)
  }
  return new Promise((resolve) => {
    wx.chooseMessageFile({
      count,
      // 注意：官方 extension 过滤参数「仅 type==='file' 时有效」，
      // 而 type==='file' 会排除图片，无法一次选中「图片 + PDF」。
      // 因此这里用 all，再在本地按扩展名过滤（图片 / PDF 放行，其余提示）
      type: 'all',
      success: (res) => {
        const raw = res.tempFiles || []
        const accepted = []
        let rejected = 0
        for (const f of raw) {
          const item = normalize(f)
          if (FILE_EXT.indexOf(item.ext) !== -1) accepted.push(item)
          else rejected++
        }
        if (rejected > 0) {
          ui.toast(`已忽略 ${rejected} 个不支持的文件（仅支持图片和 PDF）`, 'none', 2500)
        }
        resolve(accepted)
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (/cancel/i.test(msg)) {
          resolve([])
          return
        }
        // 非取消的失败（个别客户端异常）：降级为选图片，避免"点了没反应"
        console.warn('[drawing] chooseMessageFile 失败，降级为选择图片', err)
        chooseFromAlbum(count).then(resolve)
      }
    })
  })
}

/**
 * 选择图纸（自动按平台选择方式）
 * @param {number} count 最多可选数量
 * @returns {Promise<Array>} 归一化后的文件数组；用户取消返回 []
 */
async function chooseDrawings(count = 9) {
  const files = isDesktop() ? await chooseFromDisk(count) : await chooseFromAlbum(count)
  if (!files.length) return []
  // 体积校验
  const tooBig = files.filter((f) => f.size > MAX_FILE_SIZE)
  if (tooBig.length) {
    ui.toast(`文件过大（单个不超过 50MB）：${tooBig.map((f) => f.name).join('、')}`, 'none', 2500)
  }
  return files.filter((f) => f.size <= MAX_FILE_SIZE)
}

/** 下载远程文件到本地临时路径 */
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({ url, success: resolve, fail: reject })
  })
}

/**
 * 云文件下载（按 fileID 直取本地路径）
 * 不走 tempFileURL + wx.downloadFile，不占「downloadFile 合法域名」额度，
 * 是 getTempFileURL 失败/临时链接不可用时的可靠兜底。
 */
function downloadCloudFile(fileID) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
      reject(new Error('云开发未初始化'))
      return
    }
    wx.cloud.downloadFile({
      fileID,
      success: (res) => {
        if (res && res.tempFilePath) resolve(res.tempFilePath)
        else reject(new Error('云文件下载返回空路径'))
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '云文件下载失败'))
    })
  })
}

/** 用系统能力打开 PDF */
function openDocument(filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType: 'pdf',
      showMenu: true,
      success: resolve,
      fail: reject
    })
  })
}

/** 打开失败后的统一降级：把真实原因透出，并复制链接/ID 方便排查 */
function openFailed(e, url, fileID) {
  console.error('[drawing] 打开文件失败', e, { url: url || '', fileID: fileID || '' })
  const detail = String((e && (e.errMsg || e.message)) || '').slice(0, 60)
  wx.setClipboardData({
    data: url || fileID || '',
    success: () => ui.toast(`无法打开${detail ? '：' + detail : ''}，已复制文件链接`, 'none', 3000),
    fail: () => ui.toast(`打开文件失败${detail ? '：' + detail : ''}`, 'none', 2500)
  })
}

/**
 * 云函数兜底：服务端解析临时链接
 * 云函数以管理员权限运行，**不受客户端存储安全规则限制**。
 * 典型场景：云存储权限设为「仅创建者可读写」时，别人上传的文件客户端
 * getTempFileURL / cloud.downloadFile 都拿不到（报 empty download url），
 * 走服务端解析即可正常拿到下载链接。
 */
async function resolveUrlsViaServer(fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : []).filter(id => typeof id === 'string' && id.indexOf('cloud://') === 0)
  if (list.length === 0) throw new Error('缺少有效的文件ID')
  const res = await new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(new Error('云开发未初始化'))
      return
    }
    wx.cloud.callFunction({
      name: 'orderManager',
      data: { action: 'drawingUrls', fileIDs: list },
      success: (r) => resolve(r),
      fail: (err) => reject(new Error((err && err.errMsg) || '云函数调用失败'))
    })
  })
  const body = res && res.result
  if (!body || !body.success) throw new Error((body && body.error) || '临时链接解析失败')
  const map = Object.create(null)
  for (const item of (body.urls || [])) {
    if (item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL
  }
  return map
}

/**
 * 打开/预览 PDF（支持远程 URL、本地临时路径、云 fileID）
 *
 * ⚠️ Windows/Mac 版微信的 wx.openDocument 的 success/fail 回调**可能永不触发**
 * （开发者工具会正常回调，真机/PC 体验版不一定），所以：
 *   - loading 在「下载完成、交给 openDocument 之前」就必须收掉；
 *   - PC 端不 await 回调，只接管「立即 fail」的情况；移动端回调可靠，仍然等待。
 */
async function openPdf(url, fileID) {
  if (!url && !fileID) {
    ui.toast('文件地址无效')
    return
  }

  // 阶段一：拿到本地文件（这段需要 loading）
  let filePath = null
  ui.showLoading('正在打开...')
  try {
    if (url && /^https?:\/\//i.test(url)) {
      const dl = await downloadFile(url)
      if (!dl || dl.statusCode !== 200 || !dl.tempFilePath) throw new Error('文件下载失败')
      filePath = dl.tempFilePath
    } else if (url) {
      filePath = url // 本地临时路径直接用
    } else {
      // 没有 url（getTempFileURL 失败等）但有 fileID：
      // 先客户端云下载，失败（如存储权限限制）再走云函数服务端兜底
      try {
        filePath = await downloadCloudFile(fileID)
      } catch (cloudErr) {
        console.warn('[drawing] 客户端云下载失败，改走云函数解析临时链接', cloudErr)
        const map = await resolveUrlsViaServer([fileID])
        const serverUrl = map[fileID]
        if (!serverUrl) throw new Error('文件无法访问（可能已被删除或无读取权限）')
        const dl = await downloadFile(serverUrl)
        if (!dl || dl.statusCode !== 200 || !dl.tempFilePath) throw new Error('文件下载失败')
        filePath = dl.tempFilePath
      }
    }
  } catch (e) {
    ui.hideLoading()
    openFailed(e, url, fileID)
    return
  }
  ui.hideLoading()

  // 阶段二：交给系统打开（loading 已收，成败不再影响 loading）
  const p = openDocument(filePath)
  if (isDesktop()) {
    p.catch((e) => openFailed(e, url, fileID))
  } else {
    try { await p } catch (e) { openFailed(e, url, fileID) }
  }
}

/**
 * 预览/打开图纸
 * @param {Array} list 图纸数组，元素含 { url | tempFilePath | fileID, isPDF, name }
 * @param {number} index 当前项下标
 */
function openDrawing(list, index) {
  const item = list && list[index]
  if (!item) return Promise.resolve()
  const url = item.url || item.tempFilePath || ''
  if (item.isPDF || isPdfName(item.name)) {
    // openPdf 内部支持无 url 时按 fileID 云下载兜底
    return openPdf(url, item.fileID)
  }
  return openImage(item, list)
}

/** 打开图片图纸（url 缺失时：客户端云下载 → 云函数服务端兜底） */
async function openImage(item, list) {
  let url = item.url || item.tempFilePath || ''
  if (!url && item.fileID) {
    ui.showLoading('正在打开...')
    try {
      try {
        url = await downloadCloudFile(item.fileID)
      } catch (cloudErr) {
        console.warn('[drawing] 客户端云下载失败，改走云函数解析临时链接', cloudErr)
        const map = await resolveUrlsViaServer([item.fileID])
        const serverUrl = map[item.fileID]
        if (!serverUrl) throw new Error('文件无法访问（可能已被删除或无读取权限）')
        const dl = await downloadFile(serverUrl)
        if (!dl || dl.statusCode !== 200 || !dl.tempFilePath) throw new Error('文件下载失败')
        url = dl.tempFilePath
      }
    } catch (e) {
      ui.hideLoading()
      openFailed(e, '', item.fileID)
      return
    }
    ui.hideLoading()
  }
  if (!url) {
    ui.toast('文件地址无效')
    return
  }
  // 图片：在全部图片中左右滑动预览（本地兜底路径也并入）
  const urls = (list || [])
    .filter((x) => !(x.isPDF || isPdfName(x.name)))
    .map((x) => x.url || x.tempFilePath)
    .filter(Boolean)
  if (urls.indexOf(url) < 0) urls.push(url)
  wx.previewImage({ current: url, urls })
}

/** 人类可读的文件体积 */
function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

module.exports = {
  IMAGE_EXT,
  FILE_EXT,
  MAX_FILE_SIZE,
  getPlatform,
  isDesktop,
  extOf,
  isPdfName,
  isImageName,
  normalize,
  chooseDrawings,
  openDrawing,
  openPdf,
  downloadFile,
  downloadCloudFile,
  resolveUrlsViaServer,
  openDocument,
  formatSize
}
