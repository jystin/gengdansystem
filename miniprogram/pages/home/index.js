const { getDashboard, listOrders, listLogs, listEmployees, getAllEmployeesMonthlyProduction, getProductionRows, buildMonthHeaders, getProcessLibrary, updateEmployeeStations, getEmployeeDisplayStations } = require('../../utils/mock-store')
const { exportOrders } = require('../../utils/export-excel')
const { generateProductionDetailHtml } = require('../../utils/export-excel')

Page({
  data: {
    user: { role: '', status: 'active' },
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

  onShow() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    this.setData({ user: app.globalData.currentUser || { role: 'guest', status: 'guest' } })
    this.refresh()
  },

  refresh() {
    this.setData({
      dashboard: getDashboard(),
      orders: listOrders().slice(0, 4),
      logs: listLogs().slice(0, 4)
    })
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
  toggleEmpModal() {
    if (this.data.showEmpModal) {
      this.setData({ showEmpModal: false })
      return
    }
    const employees = listEmployees()
    const processLib = getProcessLibrary()
    // 从工序库去重提取所有 station
    const stationMap = {}
    processLib.forEach(p => { stationMap[p.station] = p.name })
    const allStations = Object.keys(stationMap).map(s => ({ station: s, name: stationMap[s], checked: false }))
    // 预处理员工列表，确保 stations 是数组
    const empList = employees.map(emp => ({
      ...emp,
      stations: Array.isArray(emp.stations) ? emp.stations : (emp.station ? [emp.station] : [])
    }))

    // 加载月度统计数据
    const year = String(new Date().getFullYear())
    const rawStats = getAllEmployeesMonthlyProduction(year)
    const stats = rawStats.map(s => ({
      ...s,
      employee: {
        ...s.employee,
        _stationDisplay: getEmployeeDisplayStations(s.employee)
      }
    }))

    this.setData({
      showEmpModal: true,
      empTab: 'list',
      editingEmpId: '',
      empList,
      allStations,
      tempCheckedStations: {},
      productionStats: stats,
      monthHeaders: buildMonthHeaders(year),
      selectedProdIndex: 0,
      prodYear: year,
      prodEmployeeNames: stats.map(s => s.employee.name + ' · ' + getEmployeeDisplayStations(s.employee))
    })
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
  saveEmpStations(event) {
    const id = event.currentTarget.dataset.id
    const newStations = this.data.tempCheckedStations[id] || []
    try {
      const app = getApp()
      updateEmployeeStations(id, newStations, app.globalData.currentUser.id)
      // 更新本地列表显示
      const empList = this.data.empList.map(e =>
        e.id === id ? { ...e, stations: newStations } : e
      )
      this.setData({ empList, editingEmpId: '', allStations: this._buildAllStations([]) })
      wx.showToast({ title: '岗位已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    }
  },

  // ===== 月度统计 =====
  onProdEmployeeChange(e) {
    this.setData({ selectedProdIndex: Number(e.detail.value) })
  },

  exportAllProduction() {
    wx.showLoading({ title: '正在生成报表...' })
    try {
      const rows = getProductionRows()
      if (rows.length === 0) {
        wx.hideLoading()
        wx.showToast({ title: '暂无数据', icon: 'none' })
        return
      }
      const content = generateProductionDetailHtml(rows, null, this.data.prodYear)
      this._doExportFile(content, `员工月度报表_全部_${this.data.prodYear}`)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '导出失败', icon: 'none' })
    }
  },

  exportOneProduction() {
    const { productionStats, selectedProdIndex, prodYear } = this.data
    const emp = productionStats[selectedProdIndex]
    if (!emp) return

    wx.showLoading({ title: '正在生成报表...' })
    try {
      const allRows = getProductionRows()
      const empId = emp.employee.id
      const empName = emp.employee.name
      const rows = allRows.filter(r => r.employeeId === empId || r.employeeName === empName)
      if (rows.length === 0) {
        wx.hideLoading()
        wx.showToast({ title: '该员工暂无记录', icon: 'none' })
        return
      }
      const content = generateProductionDetailHtml(rows, emp, prodYear)
      this._doExportFile(content, `员工月度报表_${empName}_${prodYear}`)
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '导出失败', icon: 'none' })
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
        wx.showLoading({ title: '正在打开...' })
        wx.openDocument({
          filePath: tempFilePath,
          fileType: 'xls',
          showMenu: true,
          success: () => { wx.hideLoading() },
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '文件已生成', icon: 'none', duration: 2000 })
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '写入失败', icon: 'none' })
      }
    })
  },

  _formatNow() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  }
})
