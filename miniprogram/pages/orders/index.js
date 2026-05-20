const { listOrders, isAdmin, getOrdersForExport } = require('../../utils/mock-store')
const { exportOrders } = require('../../utils/export-excel')

const CATEGORY_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'urgent', label: '加急' },
  { key: 'overdue', label: '逾期' },
  { key: 'processing', label: '进行中' },
  { key: 'paused', label: '暂停' },
  { key: 'completed', label: '已完成' }
]

Page({
  data: {
    keyword: '',
    orders: [],
    filteredOrders: [],
    activeCategory: 'all',
    categoryOptions: CATEGORY_OPTIONS,
    selectMode: false,
    selectedSet: {},   // 用对象代替数组，key=orderId, value=true — 避免 indexOf 问题
    selectedCount: 0,
    isAdmin: false,
    showDatePicker: false,
    dateStart: '',
    dateEnd: '',
    showCustomerPicker: false,
    customerOptions: [],
    selectedCustomerIndex: 0
  },

  onShow() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const user = app.globalData.currentUser
    this.setData({ isAdmin: isAdmin(user) })
    // 仅在首次进入或无 category 参数时才刷新（避免覆盖用户手动切换的 tab）
    if (!this._hasCategoryFromUrl) {
      this.refresh()
    }
  },

  onLoad(options) {
    if (options && options.category) {
      const validCategory = CATEGORY_OPTIONS.find(o => o.key === options.category)
      if (validCategory) {
        this._hasCategoryFromUrl = true
        this.setData({ activeCategory: validCategory.key }, () => {
          this.refresh()
        })
      }
    }
  },

  refresh() {
    const orders = listOrders()
    this.setData({
      orders,
      filteredOrders: this._buildFiltered(orders)
    })
  },

  // 构建带 _checked 标记的列表（每次 selectedSet 变化时调用）
  _buildFiltered(orders) {
    const { selectedSet } = this.data
    return this.applyFilter(this.data.keyword, orders, this.data.activeCategory).map((o) => ({
      ...o,
      _checked: !!selectedSet[o.id]
    }))
  },

  // 刷新 filteredOrders 的选中状态（不改变筛选条件）
  _refreshCheckState() {
    this.setData({
      filteredOrders: this._buildFiltered(this.data.orders),
      selectedCount: Object.keys(this.data.selectedSet).length
    })
  },

  onKeywordInput(event) {
    const keyword = event.detail.value.trim()
    this.setData({ keyword })
    this._applyCurrentFilter()
  },

  onCategoryTap(event) {
    const activeCategory = event.currentTarget.dataset.category
    this.setData({ activeCategory })
    this._applyCurrentFilter()
  },

  _applyCurrentFilter() {
    this.setData({ filteredOrders: this._buildFiltered(this.data.orders) })
  },

  applyFilter(keyword, orders, activeCategory = 'all') {
    let result = orders

    if (activeCategory !== 'all') {
      result = result.filter((order) => order.category === activeCategory)
    }

    if (!keyword) return result

    return result.filter((order) => {
      const text = [order.id, order.customerName, order.type, order.size, order.material, order.currentStepName].join(' ')
      return text.includes(keyword)
    })
  },

  toggleSelectMode() {
    this.setData({
      selectMode: !this.data.selectMode,
      selectedSet: {},
      selectedCount: 0
    }, () => {
      this._refreshCheckState()
    })
  },

  toggleSelect(event) {
    const id = event.currentTarget.dataset.id
    const newSet = { ...this.data.selectedSet }
    if (newSet[id]) {
      delete newSet[id]
    } else {
      newSet[id] = true
    }
    this.setData({ selectedSet: newSet }, () => {
      this._refreshCheckState()
    })
  },

  exportSelected() {
    const ids = Object.keys(this.data.selectedSet)
    if (ids.length === 0) {
      wx.showToast({ title: '请先选择工单', icon: 'none' })
      return
    }
    this.doExport(ids)
  },

  exportAll() {
    this.doExport(null)
  },

  showDateRangePicker() {
    this.setData({ showDatePicker: true, dateStart: '', dateEnd: '' })
  },

  hideDatePicker() {
    this.setData({ showDatePicker: false })
  },

  // 用户点击了 picker 区域 → 记录时间戳，用于区分"点遮罩关闭"和"picker 关闭泄漏事件"
  onPickerAreaTap() {
    this._lastPickerTapTime = Date.now()
  },

  // 点击遮罩层：300ms内有过 picker 操作则忽略（picker 原生组件关闭时会泄漏 tap 到 mask）
  onMaskTap() {
    if (this._lastPickerTapTime && Date.now() - this._lastPickerTapTime < 300) return
    this.hideDatePicker()
  },

  onDateStartChange(event) {
    this.setData({ dateStart: event.detail.value })
    this._lastPickerTapTime = Date.now()
  },

  onDateEndChange(event) {
    this.setData({ dateEnd: event.detail.value })
    this._lastPickerTapTime = Date.now()
  },

  confirmDateRangeExport() {
    const { dateStart, dateEnd } = this.data
    if (!dateStart && !dateEnd) {
      wx.showToast({ title: '请至少选择一个日期', icon: 'none' })
      return
    }
    this.hideDatePicker()
    this.doExport(null, { start: dateStart, end: dateEnd })
  },

  showCustomerPicker() {
    const customers = [...new Set(this.data.orders.map(o => o.customerName).filter(Boolean))].sort()
    this.setData({ customerOptions: customers, selectedCustomerIndex: 0, showCustomerPicker: true })
  },

  hideCustomerPicker() {
    this.setData({ showCustomerPicker: false })
  },

  onCustomerChange(event) {
    this.setData({ selectedCustomerIndex: Number(event.detail.value) })
    this._lastPickerTapTime = Date.now()
  },

  onCustomerPickerAreaTap() {
    this._lastPickerTapTime = Date.now()
  },

  // 按客户导出：过滤出该客户的订单，走 doExport 统一排序
  confirmCustomerExport() {
    const { customerOptions, selectedCustomerIndex } = this.data
    const customerName = customerOptions[selectedCustomerIndex]
    this.hideCustomerPicker()
    this.doExport(null, null, `客户_${customerName}`, customerName)
  },

  // 按客户名↑ + 下单时间↑ 排序（无下单日期的排到该客户最后）
  _sortByCustomerAndDate(orders) {
    return [...orders].sort((a, b) => {
      const c = a.customerName.localeCompare(b.customerName, 'zh-CN')
      if (c !== 0) return c
      if (!a.orderDate && !b.orderDate) return 0
      if (!a.orderDate) return 1
      if (!b.orderDate) return -1
      return new Date(a.orderDate) - new Date(b.orderDate)
    })
  },

  doExport(orderIds, dateRange, fileName, filterCustomer) {
    wx.showLoading({ title: '正在生成导出文件...' })

    try {
      let orders = getOrdersForExport(orderIds, dateRange)
      if (filterCustomer) orders = orders.filter(o => o.customerName === filterCustomer)
      orders = this._sortByCustomerAndDate(orders)

      if (orders.length === 0) {
        wx.hideLoading()
        wx.showToast({ title: '该条件下没有可导出的工单', icon: 'none' })
        return
      }

      const name = fileName || (() => {
        if (orderIds && orderIds.length > 0) return `选中_${orderIds.length}项工单`
        if (dateRange) return `按下单日期_${dateRange.start || '起'}至${dateRange.end || '今'}`
        return '工单导出'
      })()

      exportOrders(orders, name).then(() => {
        wx.hideLoading()
        this.setData({ selectMode: false, selectedSet: {}, selectedCount: 0 }, () => {
          this._refreshCheckState()
        })
      }).catch(() => {
        wx.hideLoading()
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '导出失败', icon: 'none' })
    }
  },

  openOrder(event) {
    if (this.data.selectMode) return
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  openScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  }
})
