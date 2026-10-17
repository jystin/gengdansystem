const api = require('../../utils/api')
const ui = require('../../utils/ui')
const scan = require('../../utils/scan')

Page({
  data: {
    user: { name: '', role: '', station: '' },
    dashboard: {},
    employees: [],
    logs: [],
    elderMode: false,
    // 超管工具：是否处于员工视角（演示身份切换状态）
    disguised: false,
    // 编辑岗位弹窗状态
    showStationModal: false,
    stationEmpList: [],
    allStations: [],
    editingStationsId: '',
    editingStationsName: '',
    tempCheckedStations: {},
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
    // 大字模式开关状态（工单详情页字号放大，storage 持久化）
    this.setData({ elderMode: !!wx.getStorageSync('elderMode') })
    const user = app.globalData.currentUser
    try {
      ui.showLoading('加载中...')
      const [allEmployees, dashboard, logs, monthlyStats] = await Promise.all([
        api.listEmployees().catch(() => []),
        api.getDashboard().catch(() => null),
        api.listLogs(2).catch(() => []),
        api.getEmployeeMonthlyProduction(user.id, String(new Date().getFullYear())).catch(() => null)
      ])
      const activeEmployees = (allEmployees || [])
        .filter(e => e.status === 'active')
        .map(e => {
          const nameFallback = (user && user.id && e.id === user.id && user.name) ? user.name : '员工'
          return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role), _stationDisplay: api.getEmployeeDisplayStations(e) }
        })
      this.setData({
        user: { ...user, name: api.cleanName(user.name, '用户'), roleLabel: api.roleLabel(user.role), stationsDisplay: api.getEmployeeDisplayStations(user) },
        dashboard: dashboard || {},
        employees: activeEmployees,
        logs: (logs || []).slice(0, 6).map(api.normalizeLog).filter(Boolean),
        monthlyStats: monthlyStats || {
          year: String(new Date().getFullYear()),
          totalRoots: 0,
          currentMonthRoots: 0,
          monthlyRoots: [],
          programmerTotalRoots: 0,
          programmerCurrentMonthRoots: 0,
          programmerMonthlyRoots: []
        },
        disguised: this._isDisguised()
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  /** 大字模式开关：storage 持久化，工单详情页读取生效 */
  toggleElderMode(event) {
    const on = !!event.detail.value
    wx.setStorageSync('elderMode', on)
    this.setData({ elderMode: on })
    ui.toast(on ? '已开启大字模式' : '已关闭大字模式', 'success')
  },

  // ===== 超管工具：一键切换身份 / 编辑岗位 =====

  /** 是否处于员工视角（本人身份被临时降级为普通员工即视为伪装中） */
  _isDisguised() {
    const backup = wx.getStorageSync('superIdentityBackup')
    const user = getApp().globalData.currentUser || {}
    return !!(backup && backup.role === 'superadmin' && backup.id && user.id === backup.id && user.role !== 'superadmin')
  },

  /**
   * 一键切换「超管 ↔ 普通员工」演示视角（仅改前端展示角色，不动数据库）
   * 保持本人身份（姓名/工号不变），只把角色临时降为 worker，界面按员工视角渲染；
   * 备份超管身份到 storage，再点一次即切回
   */
  toggleSuperIdentity() {
    const app = getApp()
    const current = app.globalData.currentUser || {}
    if (!this._isDisguised()) {
      if (current.role !== 'superadmin') {
        ui.toast('仅超管可切换')
        return
      }
      wx.setStorageSync('superIdentityBackup', {
        id: current.id,
        name: current.name,
        role: current.role,
        stations: current.stations || []
      })
      app.globalData.currentUser = { ...current, role: 'worker' }
      ui.toast('已切换为普通员工视角')
    } else {
      const backup = wx.getStorageSync('superIdentityBackup')
      if (backup && backup.id) {
        app.globalData.currentUser = { ...backup }
      }
      wx.removeStorageSync('superIdentityBackup')
      ui.toast('已切回超管身份', 'success')
    }
    this.onShow()
  },

  /** 打开编辑岗位弹窗：员工横向选择 + 岗位勾选网格 */
  openStationEditor() {
    const list = (this.data.employees || []).map(e => ({
      id: e.id,
      name: e.name,
      role: e.role,
      stations: (Array.isArray(e.stations) ? e.stations : (e.station ? [e.station] : [])).filter(s => s !== '管理员中心')
    }))
    if (!list.length) {
      ui.toast('暂无员工数据')
      return
    }
    // 可分配岗位 = 工序岗位 + 非工序岗位（如「调字员」「流转工」），与首页员工管理保持一致
    const allStations = api.getSelectableStations()
      .filter(s => s.station !== '管理员中心')
      .map(s => ({ station: s.station, name: s.name, checked: false }))
    const first = list[0]
    const checkedSet = new Set(first.stations)
    this.setData({
      showStationModal: true,
      stationEmpList: list,
      editingStationsId: first.id,
      editingStationsName: first.name,
      allStations: allStations.map(s => ({ ...s, checked: checkedSet.has(s.station) })),
      tempCheckedStations: { [first.id]: [...first.stations] }
    })
  },

  closeStationModal() {
    this.setData({ showStationModal: false })
  },

  /** 空方法，阻止弹窗内点击冒泡到遮罩层 */
  noop() {},

  /** 弹窗内切换选中的员工（保留未保存的临时勾选） */
  selectStationEmp(event) {
    const id = event.currentTarget.dataset.id
    const emp = this.data.stationEmpList.find(e => e.id === id)
    if (!emp) return
    const checkedSet = new Set(this.data.tempCheckedStations[id] || emp.stations || [])
    this.setData({
      editingStationsId: id,
      editingStationsName: emp.name,
      allStations: this.data.allStations.map(s => ({ ...s, checked: checkedSet.has(s.station) })),
      tempCheckedStations: { ...this.data.tempCheckedStations, [id]: [...checkedSet] }
    })
  },

  /** 勾选/取消岗位 */
  toggleStationCheck(event) {
    const station = event.currentTarget.dataset.station
    const id = this.data.editingStationsId
    if (!id || !station) return
    const current = [...(this.data.tempCheckedStations[id] || [])]
    const idx = current.indexOf(station)
    if (idx >= 0) current.splice(idx, 1)
    else current.push(station)
    this.setData({
      tempCheckedStations: { ...this.data.tempCheckedStations, [id]: current },
      allStations: this.data.allStations.map(s => ({ ...s, checked: current.includes(s.station) }))
    })
  },

  /** 保存当前编辑员工的岗位 */
  async saveStationEdit() {
    const id = this.data.editingStationsId
    if (!id) return
    const emp = this.data.stationEmpList.find(e => e.id === id)
    let newStations = [...(this.data.tempCheckedStations[id] || [])]
    // 保留「管理员中心」虚拟岗位，避免编辑时误删管理员标识（与首页员工管理逻辑一致）
    if (emp && (emp.role === 'admin' || emp.role === 'superadmin') && !newStations.includes('管理员中心')) {
      newStations = ['管理员中心', ...newStations]
    }
    try {
      ui.showLoading('保存中...')
      await api.updateEmployeeStations(id, newStations)
      // 就地刷新本地展示：弹窗列表 + 页面「岗位绑定员工」区
      const stationEmpList = this.data.stationEmpList.map(e =>
        e.id === id ? { ...e, stations: newStations.filter(s => s !== '管理员中心') } : e
      )
      const employees = this.data.employees.map(e =>
        e.id === id ? { ...e, stations: newStations, _stationDisplay: api.getEmployeeDisplayStations({ ...e, stations: newStations }) } : e
      )
      ui.hideLoading()
      this.setData({ stationEmpList, employees })
      ui.toast(`已保存 ${emp ? emp.name : ''} 的岗位`, 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '保存失败')
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
  goMyOrders() { wx.navigateTo({ url: '/pages/my-orders/index' }) },
  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },
  goScan() { scan.scanAndOpenOrder() },
  goAdmin() {
    const user = this.data.user
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      ui.toast('仅管理员可访问')
      return
    }
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  /** 打开隐私保护指引 */
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract()
    }
  }
})
