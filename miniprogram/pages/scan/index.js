const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    orderId: '',
    quickOrders: [],
    currentUser: { role: '', status: 'active' }
  },

  async onShow() {
    const app = getApp()
    const access = await app.waitForAccessReady()
    try {
      const orders = await api.listOrders(1, 100)
      this.setData({
        quickOrders: (orders || []).slice(0, 5),
        currentUser: (access && access.user) || app.globalData.currentUser || { role: 'guest', status: 'guest' }
      })
    } catch (e) {
      this.setData({ quickOrders: [], currentUser: app.globalData.currentUser || { role: 'guest', status: 'guest' } })
    }
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

  scanCode() {
    if (!this.ensureInternalAccess()) return
    wx.scanCode({
      onlyFromCamera: false,
      success: (result) => {
        const scannedText = result.result || result.path || ''
        const inviteCode = this.extractJoinInvite(scannedText)
        if (inviteCode) { this.openJoinPage(inviteCode); return }
        const orderId = this.extractOrderId(scannedText)
        if (!orderId) { ui.toast('未识别到工单号'); return }
        this.openOrder(orderId)
      },
      fail: () => { ui.toast('扫码已取消') }
    })
  },

  extractOrderId(text) {
    const matched = String(text).match(/GD\d{11,}/)
    return matched ? matched[0] : String(text).trim()
  },

  extractJoinInvite(text) {
    const matched = String(text).match(/(INV|JOIN)-[A-Z0-9]{6,12}/)
    return matched ? matched[0] : ''
  },

  openJoinPage(inviteCode = '') {
    const code = this.extractJoinInvite(inviteCode)
    if (!code) {
      ui.toast('请先输入或扫描管理员分享的入驻码')
      return
    }
    wx.navigateTo({ url: `/pages/join/index?invite=${code}` })
  },

  openByInput() {
    if (!this.ensureInternalAccess()) return
    const orderId = this.extractOrderId(this.data.orderId)
    if (!orderId) { ui.toast('请输入工单号'); return }
    this.openOrder(orderId)
  },

  goJoinPage() { this.openJoinFromInput() },

  openJoinFromInput() {
    const inviteCode = this.extractJoinInvite(this.data.orderId)
    if (!inviteCode) { ui.toast('请输入或扫描入驻码'); return }
    this.openJoinPage(inviteCode)
  },

  openOrder(event) {
    if (!this.ensureInternalAccess()) return
    const orderId = event.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/order-detail/index?id=${orderId}` })
  }
})
