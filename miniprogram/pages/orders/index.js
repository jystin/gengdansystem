const api = require('../../utils/api')
const ui = require('../../utils/ui')
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
    selectedSet: {},
    selectedCount: 0,
    isAdmin: false,
    showDatePicker: false,
    dateStart: '',
    dateEnd: '',
    showCustomerPicker: false,
    customerOptions: [],
    selectedCustomerIndex: 0
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    this.setData({ isAdmin: api.isCurrentUserAdmin() })
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

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const orders = await api.listOrders(1, 100)
      this.setData({
        orders: orders || [],
        filteredOrders: this._buildFiltered(orders || [])
      })
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    } finally {
      ui.hideLoading()
    }
  },

  _buildFiltered(orders) {
    const { selectedSet } = this.data
    return this.applyFilter(this.data.keyword, orders, this.data.activeCategory).map((o) => ({
      ...o,
      _checked: !!selectedSet[o.id]
    }))
  },

  _refreshCheckState() {
    this.setData({
      filteredOrders: this._buildFiltered(this.data.orders),
      selectedCount: Object.keys(this.data.selectedSet).length
    })
  },

  onKeywordInput(event) {
    // 防抖300ms，减少频繁过滤的性能开销
    const keyword = event.detail.value.trim()
    this.setData({ keyword })
    if (this._keywordTimer) clearTimeout(this._keywordTimer)
    this._keywordTimer = setTimeout(() => {
      this._applyCurrentFilter()
    }, 300)
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
      ui.toast('请先选择工单')
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

  onPickerAreaTap() {
    this._lastPickerTapTime = Date.now()
  },

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
      ui.toast('请至少选择一个日期')
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

  confirmCustomerExport() {
    const { customerOptions, selectedCustomerIndex } = this.data
    const customerName = customerOptions[selectedCustomerIndex]
    this.hideCustomerPicker()
    this.doExport(null, null, `客户_${customerName}`, customerName)
  },

  _sortByCustomerAndDate(orders) {
    return [...orders].sort((a, b) => {
      const c = (a.customerName || '').localeCompare(b.customerName || '', 'zh-CN')
      if (c !== 0) return c
      if (!a.orderDate && !b.orderDate) return 0
      if (!a.orderDate) return 1
      if (!b.orderDate) return -1
      return new Date(a.orderDate) - new Date(b.orderDate)
    })
  },

  async doExport(orderIds, dateRange, fileName, filterCustomer) {
    try {
      ui.showLoading('正在生成导出文件...')
      let orders = await api.listOrders(1, 100)
      if (orderIds && orderIds.length > 0) {
        orders = orders.filter(o => orderIds.includes(o.id))
      }
      if (dateRange) {
        if (dateRange.start) orders = orders.filter(o => (o.orderDate || '') >= dateRange.start)
        if (dateRange.end) orders = orders.filter(o => (o.orderDate || '') <= dateRange.end)
      }
      if (filterCustomer) orders = orders.filter(o => o.customerName === filterCustomer)
      orders = this._sortByCustomerAndDate(orders)

      if (orders.length === 0) {
        ui.hideLoading()
        ui.toast('该条件下没有可导出的工单')
        return
      }

      const name = fileName || (() => {
        if (orderIds && orderIds.length > 0) return `选中_${orderIds.length}项工单`
        if (dateRange) return `按下单日期_${dateRange.start || '起'}至${dateRange.end || '今'}`
        return '工单导出'
      })()

      await exportOrders(orders, name)
      ui.hideLoading()
      this.setData({ selectMode: false, selectedSet: {}, selectedCount: 0 }, () => {
        this._refreshCheckState()
      })
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '导出失败')
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
