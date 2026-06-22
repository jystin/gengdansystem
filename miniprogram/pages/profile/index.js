const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    user: { name: '', role: '', station: '' },
    dashboard: {},
    employees: [],
    logs: [],
    monthlyStats: {
      year: String(new Date().getFullYear()),
      totalRoots: 0,
      currentMonthRoots: 0,
      monthlyRoots: []
    }
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const user = app.globalData.currentUser
    try {
      ui.showLoading('加载中...')
      const [allEmployees, dashboard, logs, monthlyStats] = await Promise.all([
        api.listEmployees().catch(() => []),
        api.getDashboard(),
        api.listLogs(2).catch(() => []),
        api.getEmployeeMonthlyProduction(user.id, String(new Date().getFullYear())).catch(() => null)
      ])
      const activeEmployees = (allEmployees || [])
        .filter(e => e.status === 'active')
        .map(e => {
          const nameFallback = (user && user.id && e.id === user.id && user.name) ? user.name : '员工'
          return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role) }
        })
      this.setData({
        user: { ...user, name: api.cleanName(user.name, '用户'), roleLabel: api.roleLabel(user.role) },
        dashboard: dashboard || {},
        employees: activeEmployees,
        logs: (logs || []).slice(0, 6).map(api.normalizeLog).filter(Boolean),
        monthlyStats: monthlyStats || {
          year: String(new Date().getFullYear()),
          totalRoots: 0,
          currentMonthRoots: 0,
          monthlyRoots: []
        }
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  async switchUser(event) {
    const index = Number(event.detail.value)
    const user = this.data.employees[index]
    if (!user) return
    const app = getApp()
    try {
      ui.showLoading('切换中...')
      // 同步最新用户身份：清除 token 重新走 login
      wx.removeStorageSync('authToken')
      app.globalData.token = ''
      app.globalData.accessReady = false
      app.globalData.authReadyPromise = null
      await app.syncAccessContext()
      // 重新登录以匹配目标 user：直接通过 openid 不一定能匹配（mock 中是任意 id）
      // 这里仅做演示：切换到内存中保存的 active 员工之一
      const newUser = this.data.employees.find(e => e.id === user.id)
      if (newUser) {
        app.globalData.currentUser = { ...newUser, stations: newUser.stations || [] }
        app.globalData.accessState = 'active'
      }
      await this.onShow()
      ui.hideLoading()
      ui.toast(`已切换为${user.name}`, 'none')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '切换失败')
    }
  },

  goOrders() { wx.navigateTo({ url: '/pages/orders/index' }) },
  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },
  goScan() { wx.navigateTo({ url: '/pages/scan/index' }) },
  goAdmin() {
    const user = this.data.user
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      ui.toast('仅管理员可访问')
      return
    }
    wx.navigateTo({ url: '/pages/admin/index' })
  }
})
