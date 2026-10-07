/**
 * 云存储统一封装
 *
 * 所有 wx.cloud.uploadFile / wx.cloud.getTempFileURL 调用统一走本文件，
 * 与 utils/api.js 的定位一致：页面不直接触碰 wx.cloud 底层 API，
 * 便于统一错误处理与后续维护（如加超时、重试、日志）。
 */

/**
 * 上传文件到云存储
 * @param {string} cloudPath 云存储路径（如 drawings/xxx.jpg）
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{fileID: string}>}
 */
function uploadFile(cloudPath, filePath) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('云开发未初始化'))
      return
    }
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => resolve(res),
      fail: (err) => reject(new Error((err && err.errMsg) || '文件上传失败'))
    })
  })
}

/**
 * 批量获取文件临时访问 URL
 * @param {string|string[]} fileList 一个或多个 fileID
 * @returns {Promise<{fileList: Array<{fileID: string, tempFileURL: string, status: number, errMsg: string}>}>}
 */
function getTempFileURL(fileList) {
  const list = Array.isArray(fileList) ? fileList : [fileList]
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('云开发未初始化'))
      return
    }
    wx.cloud.getTempFileURL({
      fileList: list,
      success: (res) => resolve(res),
      fail: (err) => reject(new Error((err && err.errMsg) || '文件地址获取失败'))
    })
  })
}

/**
 * 删除云存储文件（一个或多个 fileID）
 * @param {object} options { fileList: string[] }
 * @returns {Promise<{fileList: Array<{fileID: string, status: number, errMsg: string}>}>}
 *   - status=0 表示删除成功,即使云端不存在也不会抛错
 */
function deleteFile(options) {
  const list = (options && options.fileList) || []
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('云开发未初始化'))
      return
    }
    if (!Array.isArray(list) || list.length === 0) {
      resolve({ fileList: [] })
      return
    }
    wx.cloud.deleteFile({
      fileList: list,
      success: (res) => resolve(res),
      fail: (err) => reject(new Error((err && err.errMsg) || '文件删除失败'))
    })
  })
}

module.exports = {
  uploadFile,
  getTempFileURL,
  deleteFile
}
