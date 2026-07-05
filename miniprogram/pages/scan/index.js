const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    orderId: '',
    quickOrders: [],
    currentUser: { role: '', status: 'active' },
    accessState: 'guest'
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
          if (!orderId) { ui.toast('未识别到工单号'); return }
          this.openOrder(orderId)
        } catch (e) { ui.toast('扫码处理异常，请重试') }
      },
      fail: () => { ui.toast('扫码已取消') }
    })
  },

  extractOrderId(text) {
    const matched = String(text).match(/GD\d{11,}/)
    return matched ? matched[0] : String(text).trim()
  },

  openByInput() {
    if (!this.ensureInternalAccess()) return
    const orderId = this.extractOrderId(this.data.orderId)
    if (!orderId) { ui.toast('请输入工单号'); return }
    this.openOrder(orderId)
  },

  openOrder(target) {
    if (!this.ensureInternalAccess()) return
    const orderId = typeof target === 'string' ? target : (target && target.currentTarget && target.currentTarget.dataset.id)
    if (!orderId) { ui.toast('工单号无效'); return }
    wx.navigateTo({ url: `/pages/order-detail/index?id=${encodeURIComponent(orderId)}` })
  }
})
