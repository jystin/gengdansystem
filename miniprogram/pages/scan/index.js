const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    orderId: '',
    quickOrders: [],
    currentUser: { role: '', status: 'active' },
    accessState: 'guest'
  },

  async onLoad(options) {
    // 从小程序码扫码进入：scene = 工单号
    if (options && options.scene) {
      const orderId = decodeURIComponent(options.scene)
      if (!orderId || !/^GD\d{11,}$/.test(orderId)) return
      const app = getApp()
      await app.waitForAccessReady()
      if (app.globalData.accessState !== 'active') {
        wx.reLaunch({ url: '/pages/join/index' })
        return
      }
      wx.navigateTo({ url: '/pages/order-detail/index?scene=' + encodeURIComponent(orderId) })
    }
  },

  async onShow() {
    const app = getApp()
    const access = await app.waitForAccessReady()
    const accessState = app.globalData.accessState || 'guest'
    let quickOrders = []
    if (accessState === 'active') {
      try {
        const orders = await api.listOrders(1, 100)
        quickOrders = (orders || []).slice(0, 5)
      } catch (e) { /* 静默 */ }
    }
    this.setData({
      quickOrders,
      currentUser: (access && access.user) || app.globalData.currentUser || { role: 'guest', status: 'guest' },
      accessState
    })
  },

  ensureInternalAccess() {
    const app = getApp()
    if (app.globalData.accessState === 'active') return true
    ui.toast('仅内部已审批账号可查看工单')
    return false
  },

  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },

  onOrderInput(event) {
    this.setData({ orderId: event.detail.value.trim() })
  },

  async scanCode() {
    const app = getApp()
    if (!(await app.requirePrivacyAuthorize())) return
    wx.scanCode({
      onlyFromCamera: false,
      success: (result) => {
        try {
          if (!this.ensureInternalAccess()) return
          const scannedText = result.result || result.path || ''
          const orderId = this.extractOrderId(scannedText)
          if (!orderId) { ui.toast('未识别到工单号，请扫描文本二维码或手动输入'); return }
          this.openOrder(orderId)
        } catch (e) { ui.toast('扫码处理异常') }
      },
      fail: () => { ui.toast('扫码已取消') }
    })
  },

  extractOrderId(text) {
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
  },

  openByInput() {
    if (!this.ensureInternalAccess()) return
    const orderId = this.extractOrderId(this.data.orderId)
    if (!orderId) { ui.toast('请输入工单号'); return }
    this.openOrder(orderId)
  },

  openOrder(target) {
    if (!this.ensureInternalAccess()) return
    const id = typeof target === 'string' ? target : (target && target.currentTarget && target.currentTarget.dataset.id)
    if (!id) { ui.toast('工单号无效'); return }
    wx.navigateTo({ url: `/pages/order-detail/index?id=${encodeURIComponent(id)}` })
  }
})
