const api = require('../../utils/api')
const ui = require('../../utils/ui')
// 【优化】export-excel 是重量级模块（约 13KB），仅在管理员需要导出时才懒加载
let _exportExcel = null
function _getExportExcel() {
  if (!_exportExcel) _exportExcel = require('../../utils/export-excel')
  return _exportExcel
}

Page({
  _isPageAlive: true,

  data: {
    user: { role: '', status: 'active' },
    currentUserRole: '',
    dashboard: {},
    orders: [],
    logs: [],
    // 员工管理弹窗
    showEmpModal: false,
    empTab: 'list',           // 当前 tab: 'list' | 'stats'
    editingEmpId: '',         // 正在编辑岗位的员工 ID
    empList: [],              // 员工列表（含 stations 数组）
    allStations: [],          // 所有可选岗位（从工序库提取）
    tempCheckedStations: {},  // 编辑中临时勾选的岗位 { empId: [station1, ...] }
    // 月度统计相关
    showProdModal: false,
    productionStats: [],
    monthHeaders: [],
    selectedProdIndex: 0,
    prodYear: '',
    prodEmployeeNames: [],
    prodMode: 'operate',      // 统计口径：operate=操作根数，program=配合根数（编程员/调字员）
    displayStats: []          // 按当前口径整理后的展示数据
  },

  onLoad() { this._isPageAlive = true },
  onUnload() { this._isPageAlive = false },

  async onShow() {
    const app = getApp()
    // 每次回到首页都刷新鉴权，确保角色/权限与云端一致（节流30秒）
    const now = Date.now()
    if (now - (app.globalData._lastAuthSyncTime || 0) >= 30000) {
      await app.refreshAuthContext()
    }
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/join/index')) {
      return
    }
    const user = app.globalData.currentUser || { role: 'guest', status: 'guest' }
    this.setData({ user, currentUserRole: user.role || '' })
    await this.refresh()
  },

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const [dashboard, orders, logs] = await Promise.all([
        api.getDashboard().catch(() => null),
        api.listOrders(1, 20).catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
      if (!this._isPageAlive) return
      this.setData({
        dashboard: dashboard || {},
        orders: (orders || []).slice(0, 4),
        logs: (logs || []).slice(0, 4).map(api.normalizeLog).filter(Boolean)
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/index' })
  },

  goOrdersByCategory(event) {
    const category = event.currentTarget.dataset.category
    wx.navigateTo({ url: `/pages/orders/index?category=${category}` })
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  goMaterial() {
    wx.navigateTo({ url: '/pages/material/index' })
  },

  goCreateOrder() {
    wx.navigateTo({ url: '/pages/create-order/index' })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  openOrder(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  // ===== 员工管理弹窗 =====
  async toggleEmpModal() {
    if (this.data.showEmpModal) {
      this.setData({ showEmpModal: false })
      return
    }
    try {
      ui.showLoading('加载员工数据...')
      const employees = await api.listEmployees()
      // 可分配岗位 = 工序岗位 + 非工序岗位（如「调字员」），保证调字员可被分配
      const allStations = api.getSelectableStations()
        .filter(s => s.station !== '管理员中心')
        .map(s => ({ station: s.station, name: s.name, checked: false }))

      const currentUser = getApp().globalData.currentUser || {}
      const empList = (employees || []).map(emp => {
        // 如果是当前用户自己，用 app 全局已修正的中文名作为兜底
        const nameFallback = (currentUser.id && emp.id === currentUser.id && currentUser.name)
          ? currentUser.name
          : '员工'
        return {
          ...emp,
          name: api.cleanName(emp.name, nameFallback),
          stations: (Array.isArray(emp.stations) ? emp.stations : (emp.station ? [emp.station] : [])).filter(s => s !== '管理员中心'),
          _stationDisplay: api.getEmployeeDisplayStations(emp),
          roleLabel: api.roleLabel(emp.role),
          statusLabel: api.statusLabel(emp.status)
        }
      })

      const year = String(new Date().getFullYear())
      const stats = (await api.getAllEmployeesMonthlyProduction(year).catch(() => [])).map(s => ({
        ...s,
        employee: { ...s.employee, name: api.cleanName(s.employee.name, '员工'), _stationDisplay: api.getEmployeeDisplayStations(s.employee) }
      }))

      this.setData({
        showEmpModal: true,
        empTab: 'list',
        editingEmpId: '',
        empList,
        allStations,
        tempCheckedStations: {},
        productionStats: stats,
        monthHeaders: api.buildMonthHeaders(year),
        selectedProdIndex: 0,
        prodYear: year,
        prodEmployeeNames: stats.map(s => `${s.employee.name} · ${api.getEmployeeDisplayStations(s.employee)}`)
      })
      this._applyProdMode()
    } catch (e) {
      ui.handleError(e, '加载员工数据失败')
    } finally {
      ui.hideLoading()
    }
  },

  closeEmpModal() {
    this.setData({ showEmpModal: false, editingEmpId: '' })
  },

  /**
   * 仅刷新员工管理弹窗内的数据（不关闭弹窗）
   * 用于"设为管理员""取消管理员""通过审批""删除员工"等操作后的就地刷新
   */
  async _reloadEmpModal() {
    try {
      const currentUser = getApp().globalData.currentUser || {}
      const employees = await api.listEmployees()
      const empList = (employees || []).map(emp => {
        const nameFallback = (currentUser.id && emp.id === currentUser.id && currentUser.name)
          ? currentUser.name : '员工'
        return {
          ...emp,
          name: api.cleanName(emp.name, nameFallback),
          stations: (Array.isArray(emp.stations) ? emp.stations : (emp.station ? [emp.station] : [])).filter(s => s !== '管理员中心'),
          _stationDisplay: api.getEmployeeDisplayStations(emp),
          roleLabel: api.roleLabel(emp.role),
          statusLabel: api.statusLabel(emp.status)
        }
      })

      const year = this.data.prodYear || String(new Date().getFullYear())
      const stats = (await api.getAllEmployeesMonthlyProduction(year).catch(() => [])).map(s => ({
        ...s,
        employee: { ...s.employee, name: api.cleanName(s.employee.name, '员工'), _stationDisplay: api.getEmployeeDisplayStations(s.employee) }
      }))

      if (!this._isPageAlive) return
      this.setData({
        empList,
        productionStats: stats,
        monthHeaders: api.buildMonthHeaders(year),
        prodEmployeeNames: stats.map(s => `${s.employee.name} · ${api.getEmployeeDisplayStations(s.employee)}`),
        editingEmpId: ''
      })
      this._applyProdMode()
    } catch (e) {
      console.warn('[home] 刷新员工弹窗数据失败:', e)
    }
  },

  switchEmpTab(event) {
    const tab = event.currentTarget.dataset.tab
    this.setData({ empTab: tab })
  },

  onEmpMaskTap() {
    this.setData({ showEmpModal: false, editingEmpId: '' })
  },

  onEmpPanelTap() {
    // 空方法，阻止事件冒泡到遮罩层
  },

  // 切换编辑状态
  toggleEmpEdit(event) {
    const id = event.currentTarget.dataset.id
    if (this.data.editingEmpId === id) {
      this.setData({ editingEmpId: '', allStations: this._buildAllStations([]) })
    } else {
      const emp = this.data.empList.find(e => e.id === id)
      const tempChecked = { ...this.data.tempCheckedStations }
      tempChecked[id] = emp ? [...emp.stations] : []
      this.setData({
        editingEmpId: id,
        tempCheckedStations: tempChecked,
        allStations: this._buildAllStations(tempChecked[id] || [])
      })
    }
  },

  _buildAllStations(checkedStations = []) {
    const checkedSet = new Set(Array.isArray(checkedStations) ? checkedStations : [])
    return this.data.allStations.map((station) => ({
      ...station,
      checked: checkedSet.has(station.station)
    }))
  },

  // 勾选/取消岗位
  toggleEmpStationCheck(event) {
    const { empid, station } = event.currentTarget.dataset
    const tempChecked = { ...this.data.tempCheckedStations }
    let current = tempChecked[empid] || []
    current = [...current]
    const idx = current.indexOf(station)
    if (idx >= 0) {
      current.splice(idx, 1)
    } else {
      current.push(station)
    }
    tempChecked[empid] = current
    this.setData({
      tempCheckedStations: tempChecked,
      allStations: this._buildAllStations(current)
    })
  },

  // 保存岗位修改
  async saveEmpStations(event) {
    const id = event.currentTarget.dataset.id
    const emp = this.data.empList.find(e => e.id === id)
    let newStations = this.data.tempCheckedStations[id] || []
    // 【UI】保留“管理员中心”虚拟岗位，避免编辑真实工种时误删管理员标识
    if (emp && (emp.role === 'admin' || emp.role === 'superadmin') && !newStations.includes('管理员中心')) {
      newStations = ['管理员中心', ...newStations]
    }
    try {
      await api.updateEmployeeStations(id, newStations)
      // 更新本地列表显示，保持前端隐藏“管理员中心”
      const empList = this.data.empList.map(e =>
        e.id === id ? { ...e, stations: newStations.filter(s => s !== '管理员中心'), _stationDisplay: api.getEmployeeDisplayStations({ ...e, stations: newStations }) } : e
      )
      this.setData({ empList, editingEmpId: '', allStations: this._buildAllStations([]) })
      ui.toast('岗位已保存', 'success')
    } catch (e) {
      ui.handleError(e, '保存失败')
    }
  },

  // ===== 管理员操作（仅超管可用）=====
  async promoteEmpToAdmin(event) {
    const { id, name } = event.currentTarget.dataset
    if (this.data.currentUserRole !== 'superadmin') {
      ui.toast('仅超管可操作')
      return
    }
    const ok = await ui.confirm(`确定将「${name}」设为管理员？`, '设为管理员')
    if (!ok) return
    try {
      ui.showLoading('处理中...')
      await api.updateEmployeeRole(id, 'admin')
      await this._reloadEmpModal() // 就地刷新员工列表，保持弹窗打开
      ui.hideLoading()
      ui.toast(`「${name}」已设为管理员`, 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '设置失败')
    }
  },

  async demoteEmpToWorker(event) {
    const { id, name } = event.currentTarget.dataset
    if (this.data.currentUserRole !== 'superadmin') {
      ui.toast('仅超管可操作')
      return
    }
    const ok = await ui.confirm(`确定取消「${name}」的管理员权限？`, '取消管理员')
    if (!ok) return
    try {
      ui.showLoading('处理中...')
      await api.updateEmployeeRole(id, 'worker')
      await this._reloadEmpModal() // 就地刷新员工列表，保持弹窗打开
      ui.hideLoading()
      ui.toast(`已取消「${name}」的管理员权限`, 'none')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '操作失败')
    }
  },

  async approvePendingEmp(event) {
    const { id, name } = event.currentTarget.dataset
    if (this.data.currentUserRole !== 'superadmin') {
      ui.toast('仅超管可操作')
      return
    }
    try {
      ui.showLoading('处理中...')
      await api.approveEmployee(id)
      await this._reloadEmpModal() // 就地刷新员工列表，保持弹窗打开
      ui.hideLoading()
      ui.toast(`「${name}」已通过审批`, 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '审批失败')
    }
  },

  async removeEmp(event) {
    const { id, name } = event.currentTarget.dataset
    if (this.data.currentUserRole !== 'superadmin') {
      ui.toast('仅超管可操作')
      return
    }
    const ok = await ui.confirm(`确定删除「${name}」吗？该操作不可恢复。`, '删除员工', { confirmColor: '#b91c1c' })
    if (!ok) return
    try {
      ui.showLoading('删除中...')
      await api.deleteEmployee(id)
      await this._reloadEmpModal() // 就地刷新员工列表，保持弹窗打开
      ui.hideLoading()
      ui.toast('已删除', 'none')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '删除失败')
    }
  },

  // ===== 月度统计 =====
  onProdEmployeeChange(e) {
    this.setData({ selectedProdIndex: Number(e.detail.value) })
  },

  /** 统计口径切换：operate=操作根数（默认） / program=配合根数 */
  onProdModeChange(e) {
    const mode = (e.currentTarget.dataset.mode === 'program') ? 'program' : 'operate'
    if (mode === this.data.prodMode) return
    this.setData({ prodMode: mode, selectedProdIndex: 0 })
    this._applyProdMode()
  },

  /**
   * 按当前口径把 productionStats 整理成展示数据
   * 配合根数来自后端 programmerMonthlyRoots
   * （敦压/拉尾子/精车/铣方头的编程员 + 打字的调字员）
   */
  _applyProdMode() {
    const mode = this.data.prodMode
    const isProg = mode === 'program'
    const list = (this.data.productionStats || []).map(s => ({
      ...s,
      _monthly: (isProg ? s.programmerMonthlyRoots : s.monthlyRoots) || s.monthlyRoots || [],
      _total: isProg ? (s.programmerTotalRoots || 0) : (s.totalRoots || 0),
      _current: isProg ? (s.programmerCurrentMonthRoots || 0) : (s.currentMonthRoots || 0)
    }))
    this.setData({ displayStats: list })
  },

  async exportAllProduction() {
    try {
      ui.showLoading('正在生成报表...')
      const rows = await api.getProductionRows()
      if (rows.length === 0) {
        ui.hideLoading()
        ui.toast('暂无数据')
        return
      }
      const doc = _getExportExcel().buildProductionDoc(rows, null, this.data.prodYear, this.data.prodMode)
      await this._doExportDoc(doc)
    } catch (e) {
      ui.handleError(e, '导出失败')
    } finally {
      ui.hideLoading()
    }
  },

  async exportOneProduction() {
    const { productionStats, selectedProdIndex, prodYear, prodMode } = this.data
    const emp = productionStats[selectedProdIndex]
    if (!emp) return
    try {
      ui.showLoading('正在生成报表...')
      const allRows = await api.getProductionRows()
      const empId = emp.employee.id
      const empName = emp.employee.name
      // 配合口径下：同时导出「他作为配合人员（编程员/调字员）参与」的记录
      const rows = allRows.filter(r =>
        r.employeeId === empId || r.employeeName === empName ||
        (prodMode === 'program' && (r.programmerId === empId || r.programmerName === empName))
      )
      if (rows.length === 0) {
        ui.hideLoading()
        ui.toast('该员工暂无记录')
        return
      }
      const doc = _getExportExcel().buildProductionDoc(rows, emp, prodYear, prodMode)
      await this._doExportDoc(doc)
    } catch (e) {
      ui.handleError(e, '导出失败')
    } finally {
      ui.hideLoading()
    }
  },

  /**
   * 导出报表（平台自适应，由 utils/export-excel 统一处理）
   *   电脑端（微信 Windows/Mac）→ 生成真 .xlsx，弹系统「另存为」对话框，双击即可用 Excel 打开
   *   手机端 → 生成真 .xlsx 用微信文档预览器打开（失败自动回退 HTML 表格）
   *   开发者工具 → 不支持另存为，给出明确提示
   */
  async _doExportDoc(doc) {
    try {
      const res = await _getExportExcel().exportDoc(doc)
      if (res.mode === 'disk') {
        ui.toast('已保存到所选目录，双击即可打开', 'success', 2500)
      }
    } catch (e) {
      if (e && e.code === 'DEVTOOLS_UNSUPPORTED') {
        ui.toast('开发者工具不支持「另存为」，请在电脑版微信中导出', 'none', 3500)
        return
      }
      throw e
    }
  }
})
