const { listOrders } = require('../../utils/mock-store')

Page({
  data: {
    orderId: '',
    quickOrders: [],
    currentUser: { role: '', status: 'active' }
  },

  onShow() {
    const app = getApp()
    const access = app.syncAccessContext()
    this.setData({
      quickOrders: listOrders().slice(0, 5),
      currentUser: access.user || { role: 'guest', status: 'guest' }
    })
  },

  ensureInternalAccess() {
    const app = getApp()
    const access = app.syncAccessContext()
    if (access.state === 'active') {
      return true
    }
    wx.showToast({ title: '仅内部已审批账号可查看工单', icon: 'none' })
    return false
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onOrderInput(event) {
    this.setData({ orderId: event.detail.value.trim() })
  },

  scanCode() {
    if (!this.ensureInternalAccess()) {
      return
    }

    wx.scanCode({
      onlyFromCamera: false,
      success: (result) => {
        const scannedText = result.result || result.path || ''
        const inviteCode = this.extractJoinInvite(scannedText)
        if (inviteCode) {
          this.openJoinPage(inviteCode)
          return
        }

        const orderId = this.extractOrderId(scannedText)
        if (!orderId) {
          wx.showToast({ title: '未识别到工单号', icon: 'none' })
          return
        }
        this.openOrder(orderId)
      },
      fail: () => {
        wx.showToast({ title: '扫码已取消', icon: 'none' })
      }
    })
  },

  extractOrderId(text) {
    const matched = String(text).match(/GD\d{11,}/)
    return matched ? matched[0] : String(text).trim()
  },

  extractJoinInvite(text) {
    const matched = String(text).match(/JOIN-\d{8}/)
    return matched ? matched[0] : ''
  },

  openJoinPage(inviteCode = '') {
    const code = this.extractJoinInvite(inviteCode)
    if (!code) {
      wx.showToast({ title: '请先输入或扫描管理员分享的入驻码', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/join/index?invite=${code}` })
  },

  openByInput() {
    if (!this.ensureInternalAccess()) {
      return
    }

    const orderId = this.extractOrderId(this.data.orderId)
    if (!orderId) {
      wx.showToast({ title: '请输入工单号', icon: 'none' })
      return
    }
    this.openOrder(orderId)
  },

  goJoinPage() {
    this.openJoinFromInput()
  },

  openJoinFromInput() {
    const inviteCode = this.extractJoinInvite(this.data.orderId)
    if (!inviteCode) {
      wx.showToast({ title: '请输入或扫描入驻码', icon: 'none' })
      return
    }
    this.openJoinPage(inviteCode)
  },

  openOrder(event) {
    if (!this.ensureInternalAccess()) {
      return
    }
    const orderId = event.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/order-detail/index?id=${orderId}` })
  }
})
