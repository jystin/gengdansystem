const api = require('../../utils/api')
const ui = require('../../utils/ui')
const { exportOrders } = require('../../utils/export-excel')
const { generateProductionDetailHtml } = require('../../utils/export-excel')

Page({
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
    prodEmployeeNames: []
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const user = app.globalData.currentUser || { role: 'guest', status: 'guest' }
    this.setData({ user, currentUserRole: user.role || '' })
    this.refresh()
  },

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const [dashboard, orders, logs] = await Promise.all([
        api.getDashboard(),
        api.listOrders(1, 100).catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
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
      const [employees, processLib] = await Promise.all([
        api.listEmployees(),
        Promise.resolve(api.getProcessLibrary())
      ])
      const stationMap = {}
      processLib.forEach(p => { stationMap[p.station] = p.name })
      const allStations = Object.keys(stationMap).map(s => ({ station: s, name: stationMap[s], checked: false }))

      const currentUser = getApp().globalData.currentUser || {}
      const empList = (employees || []).map(emp => {
        // 如果是当前用户自己，用 app 全局已修正的中文名作为兜底
        const nameFallback = (currentUser.id && emp.id === currentUser.id && currentUser.name)
          ? currentUser.name
          : '员工'
        return {
          ...emp,
          name: api.cleanName(emp.name, nameFallback),
          stations: Array.isArray(emp.stations) ? emp.stations : (emp.station ? [emp.station] : []),
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
    } catch (e) {
      ui.handleError(e, '加载员工数据失败')
    } finally {
      ui.hideLoading()
    }
  },

  closeEmpModal() {
    this.setData({ showEmpModal: false, editingEmpId: '' })
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
    const newStations = this.data.tempCheckedStations[id] || []
    try {
      await api.updateEmployeeStations(id, newStations)
      // 更新本地列表显示
      const empList = this.data.empList.map(e =>
        e.id === id ? { ...e, stations: newStations, _stationDisplay: api.getEmployeeDisplayStations({ ...e, stations: newStations }) } : e
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
      await this.toggleEmpModal() // 刷新整个员工弹窗
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
      await this.toggleEmpModal()
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
      await this.toggleEmpModal()
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
      await this.toggleEmpModal()
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

  async exportAllProduction() {
    try {
      ui.showLoading('正在生成报表...')
      const rows = await api.getProductionRows()
      if (rows.length === 0) {
        ui.hideLoading()
        ui.toast('暂无数据')
        return
      }
      const content = generateProductionDetailHtml(rows, null, this.data.prodYear)
      this._doExportFile(content, `员工月度报表_全部_${this.data.prodYear}`)
    } catch (e) {
      ui.handleError(e, '导出失败')
    } finally {
      ui.hideLoading()
    }
  },

  async exportOneProduction() {
    const { productionStats, selectedProdIndex, prodYear } = this.data
    const emp = productionStats[selectedProdIndex]
    if (!emp) return
    try {
      ui.showLoading('正在生成报表...')
      const allRows = await api.getProductionRows()
      const empId = emp.employee.id
      const empName = emp.employee.name
      const rows = allRows.filter(r => r.employeeId === empId || r.employeeName === empName)
      if (rows.length === 0) {
        ui.hideLoading()
        ui.toast('该员工暂无记录')
        return
      }
      const content = generateProductionDetailHtml(rows, emp, prodYear)
      this._doExportFile(content, `员工月度报表_${empName}_${prodYear}`)
    } catch (e) {
      ui.handleError(e, '导出失败')
    } finally {
      ui.hideLoading()
    }
  },

  _doExportFile(content, fileName) {
    const fs = wx.getFileSystemManager()
    const fullFileName = fileName + '_' + this._formatNow() + '.xls'
    const tempFilePath = `${wx.env.USER_DATA_PATH}/${fullFileName}`

    fs.writeFile({
      filePath: tempFilePath,
      data: content,
      encoding: 'utf8',
      success: () => {
        ui.showLoading('正在打开...')
        wx.openDocument({
          filePath: tempFilePath,
          fileType: 'xls',
          showMenu: true,
          success: () => { ui.hideLoading() },
          fail: () => {
            ui.hideLoading()
            ui.toast('文件已生成', 'none', 2000)
          }
        })
      },
      fail: () => {
        ui.hideLoading()
        ui.toast('写入失败')
      }
    })
  },

  _formatNow() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  }
})
