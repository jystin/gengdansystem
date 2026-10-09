/**
 * 图片保存 / 复制工具
 *
 * 平台差异：
 * - 电脑端（微信 Windows 版 / Mac 版）：wx.saveFileToDisk 会弹出**系统「另存为」对话框**，
 *   用户可自选任意目录和文件名。该 API 仅在 PC 端可用（基础库 ≥ 2.11.0）。
 * - 移动端（iOS / Android）：wx.saveImageToPhotosAlbum 保存到系统相册。
 *
 * 另外：PC 端「鼠标右键」等价于移动端「长按」。所以 <image show-menu-by-longpress>
 * 在电脑端右键即可唤出微信原生菜单（保存图片 / 发送给朋友等）。
 *
 * 注意：saveFileToDisk / saveImageToPhotosAlbum 都只接受**本地文件路径**，
 * 不接受网络 URL，所以必须先 downloadFile 落盘；云文件走 wx.cloud.downloadFile
 * （不占用 downloadFile 合法域名额度）。
 */

/** 取当前运行平台（windows / mac / devtools / ios / android） */
function getPlatform() {
  try {
    if (typeof wx.getDeviceInfo === 'function') {
      const info = wx.getDeviceInfo()
      if (info && info.platform) return String(info.platform).toLowerCase()
    }
  } catch (e) { /* 老基础库无 getDeviceInfo */ }
  try {
    const sys = wx.getSystemInfoSync()
    return String((sys && sys.platform) || '').toLowerCase()
  } catch (e) {
    return ''
  }
}

let _platformCache = null
function platform() {
  if (_platformCache === null) _platformCache = getPlatform()
  return _platformCache
}

/** 是否桌面端（含开发者工具，开发者工具跑在 PC 上） */
function isDesktop() {
  const p = platform()
  return p === 'windows' || p === 'mac' || p === 'devtools'
}

/** 是否在开发者工具里运行 */
function isDevtools() {
  return platform() === 'devtools'
}

/**
 * 是否真正支持「另存为」对话框
 *
 * 坑：开发者工具里 wx.saveFileToDisk **有定义但调用必定失败**，会报
 * "saveFileToDisk:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发"。
 * 所以这里必须把 devtools 排除掉——否则按钮一直显示「另存为…」却永远失败，
 * 用户会以为是功能坏了，实际只是环境不支持。
 */
function canSaveToDisk() {
  const p = platform()
  return (p === 'windows' || p === 'mac') && typeof wx.saveFileToDisk === 'function'
}

/** 开发者工具专属错误码（调用方据此给出针对性提示，而不是笼统的「保存失败」） */
const DEVTOOLS_UNSUPPORTED = 'DEVTOOLS_UNSUPPORTED'

/** 把不支持 Promise 的老式回调 API 包成 Promise */
function callAsync(name, options) {
  return new Promise((resolve, reject) => {
    const fn = wx[name]
    if (typeof fn !== 'function') {
      reject(new Error(`当前环境不支持 ${name}`))
      return
    }
    fn(Object.assign({}, options, { success: resolve, fail: reject }))
  })
}

/**
 * 下载到本地临时文件
 * @param {string} url     网络图片地址
 * @param {string} fileID  云文件 ID（优先使用，规避合法域名配置）
 * @returns {Promise<string>} tempFilePath
 */
async function downloadToTemp(url, fileID) {
  let cloudError = null
  if (fileID && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
    try {
      const res = await new Promise((resolve, reject) => {
        wx.cloud.downloadFile({ fileID, success: resolve, fail: reject })
      })
      if (res && res.tempFilePath) return res.tempFilePath
      cloudError = new Error('云文件下载返回空路径')
    } catch (e) {
      cloudError = e
      console.warn('[image-save] 云文件下载失败，改用临时链接', e)
    }
  }

  if (!url) {
    throw new Error((cloudError && (cloudError.errMsg || cloudError.message)) || '图片地址为空')
  }

  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        // 下载接口只要收到响应就会走 success，需自己判断状态码
        if (res.statusCode && res.statusCode !== 200) {
          reject(new Error(`图片下载失败(${res.statusCode})`))
          return
        }
        if (!res.tempFilePath) {
          reject(new Error('图片下载失败'))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '图片下载失败'))
    })
  })
}

/**
 * 把下载得到的临时文件转成「本地用户文件」（USER_DATA_PATH 下、带扩展名）
 *
 * 为什么必须这一步（社区/官方实证的两个原因）：
 * 1. PC 端 saveFileToDisk 对**临时文件**路径会报 `fail file system deny`(errno 1300013)，
 *    必须传入 USER_DATA_PATH 下的「本地用户文件」才能正常弹出另存为对话框；
 * 2. 下载的临时文件名往往没有扩展名（如 qrserver 的 URL），另存后打不开。
 *
 * 双策略：copyFileSync 失败（部分 PC 版本不支持/受限）时，
 * 退回 readFileSync + writeFileSync(binary) 重写一份，仍失败才用临时路径。
 *
 * @returns {{ path: string, ok: boolean, via: 'copy'|'write'|'none', error: Error|null }}
 */
function materialize(tempFilePath, fileName) {
  if (!fileName) return { path: tempFilePath, ok: false, via: 'none', error: null }
  let mgr = null
  try { mgr = wx.getFileSystemManager() } catch (e) { mgr = null }
  if (!mgr || !wx.env || !wx.env.USER_DATA_PATH) {
    return { path: tempFilePath, ok: false, via: 'none', error: null }
  }
  const target = `${wx.env.USER_DATA_PATH}/${fileName}`

  // 【关键】源文件已经是目标用户文件本身（本地生成场景：writeQrFile 先写好，
  // saveLocalFile 又用同名文件调进来）→ 直接返回，绝不能走下面的
  // 「unlinkSync(target) + copyFileSync(源, 目标)」：那是先删源再自拷贝，
  // 会把唯一一份文件删没，saveFileToDisk 必报 file system deny。
  if (tempFilePath === target) {
    return { path: target, ok: true, via: 'none', error: null }
  }

  // 源文件已经在 USER_DATA_PATH 下（本地生成的用户文件），只是名字不同：
  // 用「读出再写入」落一份新名字，原文件保留（它可能是唯一一份）
  if (tempFilePath.indexOf(wx.env.USER_DATA_PATH + '/') === 0) {
    const curName = tempFilePath.slice(wx.env.USER_DATA_PATH.length + 1)
    if (curName === fileName) {
      return { path: target, ok: true, via: 'none', error: null }
    }
    try {
      const buf = mgr.readFileSync(tempFilePath)
      try { mgr.unlinkSync(target) } catch (e0) { /* 不存在，忽略 */ }
      mgr.writeFileSync(target, buf, 'binary')
      return { path: target, ok: true, via: 'write', error: null }
    } catch (e) {
      console.warn('[image-save] 复制用户文件失败，沿用原路径另存', e)
      return { path: tempFilePath, ok: true, via: 'none', error: e }
    }
  }

  // 同名文件已存在时 copyFileSync 会失败，先删掉
  try { mgr.unlinkSync(target) } catch (e) { /* 不存在，忽略 */ }
  // 策略一：copyFileSync（官方社区验证可行的方式）
  try {
    mgr.copyFileSync(tempFilePath, target)
    return { path: target, ok: true, via: 'copy', error: null }
  } catch (e1) { /* 落到策略二 */ }
  // 策略二：读出二进制再写入（保证生成的是真正的「本地用户文件」）
  try {
    const buf = mgr.readFileSync(tempFilePath)
    mgr.writeFileSync(target, buf, 'binary')
    return { path: target, ok: true, via: 'write', error: null }
  } catch (e2) {
    console.warn('[image-save] 落盘为用户文件失败，只能用临时路径另存', e2)
    return { path: tempFilePath, ok: false, via: 'none', error: e2 }
  }
}

/** 用户主动取消（另存为对话框点了取消 / 相册权限弹窗取消）不算错误 */
function isCancel(err) {
  const msg = String((err && (err.errMsg || err.message)) || '').toLowerCase()
  return msg.indexOf('cancel') >= 0 || msg.indexOf('canceled') >= 0
}

/** 识别 PC 端文件系统拒绝（saveFileToDisk:fail file system deny, errno 1300013） */
function isFsDeny(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  return msg.indexOf('file system deny') >= 0 || msg.indexOf('1300013') >= 0
}

/** 把底层 fail 对象包成带真实 errMsg 的 Error，页面可直接展示失败原因 */
function enrichError(err, extra) {
  const raw = String((err && (err.errMsg || err.message)) || err || '')
  const e = err instanceof Error ? err : new Error(raw || '保存失败')
  if (raw && e.message !== raw && e.message.indexOf(raw) < 0) e.message = `${e.message}（${raw}）`
  if (isFsDeny(e)) e.code = 'FILE_SYSTEM_DENY'
  if (extra) e.detail = extra
  return e
}

/**
 * 保存一张**已经在本地**的图片文件（如本地生成的二维码 PNG）
 * @param {object} opts
 * @param {string} opts.filePath 本地文件路径（USER_DATA_PATH 或临时路径）
 * @param {string} [opts.fileName] 落地文件名，务必带扩展名
 * @returns {Promise<{mode:'disk'|'album', path:string}>}
 */
async function saveLocalFile(opts) {
  const { filePath, fileName } = opts || {}
  if (!filePath) throw new Error('文件路径为空')
  const mat = materialize(filePath, fileName)
  const localPath = mat.path

  if (canSaveToDisk()) {
    try {
      await callAsync('saveFileToDisk', { filePath: localPath })
      return { mode: 'disk', path: localPath }
    } catch (err) {
      // 兜底：个别 PC 版本对刚写入的用户文件仍报 file system deny，
      // 用原始路径再试一次（牺牲扩展名，保住「能存下来」）
      if (localPath !== filePath) {
        try {
          await callAsync('saveFileToDisk', { filePath })
          return { mode: 'disk', path: filePath }
        } catch (err2) {
          throw enrichError(err2 || err, { materialized: mat.ok, via: mat.via })
        }
      }
      throw enrichError(err, { materialized: mat.ok, via: mat.via })
    }
  }

  // 开发者工具：saveFileToDisk 必然失败，直接抛出可识别的错误，
  // 让调用方给出「请在电脑版微信里使用」的明确提示，而不是误导性的失败
  if (isDevtools()) {
    const err = new Error('开发者工具不支持「另存为」，请在电脑版微信中打开本小程序使用')
    err.code = DEVTOOLS_UNSUPPORTED
    throw err
  }

  try {
    await callAsync('saveImageToPhotosAlbum', { filePath: localPath })
    return { mode: 'album', path: localPath }
  } catch (err) {
    throw enrichError(err, { materialized: mat.ok, via: mat.via })
  }
}

/**
 * 保存图片（网络图片：先下载落盘，再走 saveLocalFile）
 * @param {object} opts
 * @param {string} opts.url        网络图片地址
 * @param {string} [opts.fileID]   云文件 ID（有则优先走云下载，不占合法域名额度）
 * @param {string} [opts.fileName] 落地文件名，务必带扩展名
 * @returns {Promise<{mode:'disk'|'album', path:string}>}
 */
async function saveImage(opts) {
  const { url, fileID, fileName } = opts || {}
  // 先落盘：既是为了拿到本地路径，也顺带验证图片地址/域名白名单是否可用
  const tempFilePath = await downloadToTemp(url, fileID)
  return saveLocalFile({ filePath: tempFilePath, fileName })
}

/** 复制文本到剪贴板（setClipboardData 自带系统提示，无需再 toast） */
function copyText(text) {
  return callAsync('setClipboardData', { data: String(text == null ? '' : text) })
}

/** 全屏预览图片（PC / 移动端均支持，预览态下可再次右键或长按保存） */
function previewImage(urls, current) {
  const list = (urls || []).filter(Boolean)
  if (list.length === 0) return
  wx.previewImage({
    urls: list,
    current: current && list.indexOf(current) >= 0 ? current : list[0],
    showmenu: true
  })
}

/** 生成安全的落地文件名（去掉不适合做文件名的字符） */
function safeFileName(name) {
  return String(name || 'image').replace(/[\\/:*?"<>|\s]+/g, '_')
}

module.exports = {
  platform,
  isDesktop,
  isDevtools,
  canSaveToDisk,
  saveImage,
  saveLocalFile,
  copyText,
  previewImage,
  safeFileName,
  isCancel,
  DEVTOOLS_UNSUPPORTED
}
