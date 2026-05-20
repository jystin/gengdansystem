const { getDashboard, listEmployees, listLogs, getEmployeeMonthlyProduction } = require('../../utils/mock-store')

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

  onShow() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const allEmployees = listEmployees()
    // 切换身份和岗位绑定只展示已激活员工
    const activeEmployees = allEmployees.filter(e => e.status === 'active')
    const user = app.globalData.currentUser
    this.setData({
      user,
      dashboard: getDashboard(),
      employees: activeEmployees,
      logs: listLogs().slice(0, 6),
      monthlyStats: getEmployeeMonthlyProduction(user.id, String(new Date().getFullYear()))
    })
  },

  switchUser(event) {
    const app = getApp()
    // 用 employees（已过滤为active）的索引来切换
    const index = Number(event.detail.value)
    const user = this.data.employees[index]
    app.setCurrentUser(user)
    this.onShow()
    wx.showToast({ title: `已切换为${user.name}`, icon: 'none' })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/index' })
  },
  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  }
})
