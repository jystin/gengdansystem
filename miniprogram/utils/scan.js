const ui = require('./ui')

/**
 * 提取工单号：兼容 GD+11位工单号 / URL / scene / id 参数
 */
function extractOrderId(text) {
  if (!text) return ''
  const raw = String(text)
  // 直接匹配 GD + 11+ 位数字
  const m = raw.match(/GD\d{11,}/)
  if (m) return m[0]
  // URL 解码后再匹配
  try {
    const d = decodeURIComponent(raw)
    const dm = d.match(/GD\d{11,}/)
    if (dm) return dm[0]
    // 解析 ?scene=GD... 或 ?id=GD...
    const sm = d.match(/[?&](?:scene|id)=([^&]+)/)
    if (sm && /^GD\d{11,}$/.test(decodeURIComponent(sm[1]))) return sm[1]
  } catch (e) { /* decode 失败 */ }
  return raw.trim()
}

/**
 * 直接调起相机扫码并进入工单详情（首页/个人中心/工单列表/管理页入口共用）
 * 不再经过「扫码进入工单」中间页
 */
async function scanAndOpenOrder() {
  const app = getApp()
  const ok = await app.requirePrivacyAuthorize()
  if (!ok) return
  wx.scanCode({
    onlyFromCamera: false,
    success: (result) => {
      try {
        if (app.globalData.accessState !== 'active') {
          ui.toast('仅内部已审批账号可查看工单')
          return
        }
        const scannedText = (result && (result.result || result.path)) || ''
        const orderId = extractOrderId(scannedText)
        if (!orderId) {
          ui.toast('未识别到工单号，请扫描工单二维码')
          return
        }
        wx.navigateTo({
          url: `/pages/order-detail/index?id=${encodeURIComponent(orderId)}&focus=panel`
        })
      } catch (e) {
        ui.toast('扫码处理异常')
      }
    },
    fail: () => { ui.toast('扫码已取消') }
  })
}

module.exports = {
  extractOrderId,
  scanAndOpenOrder
}
