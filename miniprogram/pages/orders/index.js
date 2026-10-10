const api = require('../../utils/api')
const ui = require('../../utils/ui')
const { exportOrders } = require('../../utils/export-excel')

const CATEGORY_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'notStarted', label: '未开始' },
  { key: 'urgent', label: '加急' },
  { key: 'overdue', label: '逾期' },
  { key: 'processing', label: '进行中' },
  { key: 'paused', label: '暂停' },
  { key: 'completed', label: '已完成' }
]

// 管理员专属分类：全员认领视图（未完成的可就地撤销认领换人推进）
const ADMIN_CATEGORY_OPTIONS = CATEGORY_OPTIONS.concat([
  { key: 'claimedActive', label: '认领中' },
  { key: 'claimedDone', label: '认领完成' }
])

Page({
  data: {
    keyword: '',
    orders: [],
    claims: [],
    filteredOrders: [],
    activeCategory: 'all',
    categoryOptions: CATEGORY_OPTIONS,
    selectMode: false,
    deleteMode: false,
    selectedSet: {},
    selectedCount: 0,
    isAdmin: false,
    showDatePicker: false,
    dateStart: '',
    dateEnd: '',
    showCustomerPicker: false,
    customerOptions: [],
    selectedCustomerIndex: 0,
    // 滚动分页状态
    page: 1,
    pageSize: 50,
    hasMore: true,
    loadingMore: false,
    // 安全删除自定义弹窗(替代 wx.showModal,避免被吞)
    showDeleteConfirmModal: false,
    deleteConfirmContent: '',
    deleteConfirmIds: [],
    deleteConfirmBtnLoading: false
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const isAdmin = api.isCurrentUserAdmin()
    this.setData({
      isAdmin,
      // 管理员专属分类（认领中 / 认领完成）；非管理员回退基础分类防止残留
      categoryOptions: isAdmin ? ADMIN_CATEGORY_OPTIONS : CATEGORY_OPTIONS,
      ...(isAdmin ? {} : { activeCategory: CATEGORY_OPTIONS.some(o => o.key === this.data.activeCategory) ? this.data.activeCategory : 'all' })
    })
    // 每次回到列表页都重新拉取：工单状态（逾期/未开始/生产中）是按交期等字段
    // 实时派生的，详情页改交期/完成工序后必须刷新，分类才能即时归位
    // （旧逻辑带分类参数进入后永不刷新，导致「已逾期」里的工单改完交期还挂在原分类）
    this.refresh()
  },

  onLoad(options) {
    if (options && options.category) {
      const validCategory = CATEGORY_OPTIONS.find(o => o.key === options.category)
      if (validCategory) {
        // 只设置分类，首次刷新交给随后的 onShow（onLoad 先于 onShow 执行）
        this.setData({ activeCategory: validCategory.key })
      }
    }
  },

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const pageSize = 50
      const isAdmin = this.data.isAdmin
      // 管理员并行拉取认领列表（active + completed），供「认领中 / 认领完成」分类渲染
      const [orders, claims] = await Promise.all([
        api.listOrders(1, pageSize),
        isAdmin ? api.listClaims('all').catch(() => []) : Promise.resolve([])
      ])
      this.setData({
        page: 1,
        pageSize,
        hasMore: (orders || []).length >= pageSize,
        orders: orders || [],
        claims: claims || []
      })
      this._rebuildView()
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    } finally {
      ui.hideLoading()
    }
  },

  /**
   * 统一重建列表视图：
   * - 认领分类（claimedActive / claimedDone）：以认领流水为主体（带工单概要与认领人）
   * - 其余分类：走原有工单过滤逻辑
   */
  _rebuildView() {
    const { activeCategory, keyword, claims, orders, selectedSet } = this.data
    const isClaimView = activeCategory === 'claimedActive' || activeCategory === 'claimedDone'
    let filteredOrders
    if (isClaimView) {
      const wantStatus = activeCategory === 'claimedActive' ? 'active' : 'completed'
      filteredOrders = (claims || [])
        .filter(c => c.status === wantStatus && c.order)
        .map(c => ({
          ...c.order,
          // 已被撤销的进行中快照（管理员撤销后 activeClaim 清空，但流水还在 active 状态的边界）
          // 保守处理：认领中视图只显示订单上 activeClaim 与流水一致的记录
          _claimStale: wantStatus === 'active' && (!c.order.activeClaim || c.order.activeClaim.userId !== c.userId),
          _claim: c,
          _claimTime: String(wantStatus === 'active' ? c.claimedAt : (c.completedAt || c.claimedAt)).slice(0, 16),
          _checked: !!selectedSet[c.orderId]
        }))
      if (keyword) {
        filteredOrders = filteredOrders.filter(o => {
          const text = [o.id, o.customerName, o.type, o.size, o.material, o.currentStepName, (o._claim && o._claim.stepName) || '', (o._claim && o._claim.userName) || ''].join(' ')
          return text.includes(keyword)
        })
      }
    } else {
      filteredOrders = this._buildFiltered(orders)
    }
    this.setData({ filteredOrders, hasMore: isClaimView ? false : this.data.hasMore })
  },

  /**
   * 触底加载下一页（配合后端分页，避免超过 100 条丢单）
   */
  async loadMore() {
    const { hasMore, loadingMore, pageSize, activeCategory } = this.data
    // 认领视图不分页（流水上限 200 条）
    if (activeCategory === 'claimedActive' || activeCategory === 'claimedDone') return
    if (!hasMore || loadingMore) return
    this.setData({ loadingMore: true })
    try {
      const nextPage = this.data.page + 1
      const batch = await api.listOrders(nextPage, pageSize)
      const merged = [...this.data.orders, ...(batch || [])]
      this.setData({
        page: nextPage,
        orders: merged,
        hasMore: (batch || []).length >= pageSize
      })
      this._rebuildView()
    } catch (e) {
      ui.toast('加载更多失败，请稍后重试', 'none')
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  onReachBottom() {
    this.loadMore()
  },

  /**
   * 全量拉取工单（导出用）：分页循环直到取完，上限 2000 条防异常
   */
  async _fetchAllOrders() {
    const all = []
    let page = 1
    const pageSize = 100
    while (true) {
      const batch = await api.listOrders(page, pageSize)
      all.push(...(batch || []))
      if (!batch || batch.length < pageSize) break
      if (all.length >= 2000) break
      page++
    }
    return all
  },

  _buildFiltered(orders) {
    const { selectedSet } = this.data
    return this.applyFilter(this.data.keyword, orders, this.data.activeCategory).map((o) => {
      // 未开始工单:可一键删除(没产量/库存影响);后端 categoryLabel 已是互斥正确中文
      const isNotStarted = this._isNotStarted(o)
      return {
        ...o,
        _checked: !!selectedSet[o.id],
        _isNotStarted: isNotStarted,
        _deletable: o.category === 'completed' || isNotStarted
      }
    })
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
    this._rebuildView()
  },

  applyFilter(keyword, orders, activeCategory = 'all') {
    let result = orders
    if (activeCategory !== 'all') {
      result = result.filter((order) => this._matchesCategory(order, activeCategory))
    }
    if (!keyword) return result
    return result.filter((order) => {
      const text = [order.id, order.customerName, order.type, order.size, order.material, order.currentStepName].join(' ')
      return text.includes(keyword)
    })
  },

  /**
   * 按精确字段匹配分类,与 dashboard 统计完全对齐
   *
   * 修复:原实现用 order.category(互斥分类),导致一个加急订单如果同时逾期,
   *      会被归到 overdue,点击首页"加急=4"进去列表却看到 0 条
   *
   * 现在改为独立判断每个属性,与 orderManager.getDashboard 的统计条件一致:
   *   - 加急:    urgent=true AND status≠completed AND paused=false
   *   - 逾期:    status≠completed AND paused=false AND dueDate<today
   *   - 暂停:    paused=true AND status≠completed
   *   - 已完成:  status=completed
   *   - 进行中:  status≠completed AND paused=false(包含加急和逾期,与 dashboard 对齐)
   */
  _matchesCategory(order, category) {
    if (category === 'all') return true
    const isCompleted = order.status === 'completed'
    // 已逾期:!paused && !completed && dueDate<today(包含未开工但过期)
    const isOverdue = !isCompleted && !order.paused && api.isOverdue(order)
    // 已暂停:paused && currentStepIndex>0(已开工后暂停,排除未开工暂停)
    const isPausedStrict = !!order.paused && !isCompleted && (order.currentStepIndex || 0) > 0
    // 未开始:currentStepIndex=0 && history 空 && !overdue(过期归 overdue)
    const isNotStarted = !isOverdue && !isCompleted && (order.currentStepIndex || 0) === 0 && (!Array.isArray(order.history) || order.history.length === 0)
    // 进行中:其他未完成(!paused, started, !overdue, !notStarted)
    const isProcessing = !isCompleted && !isOverdue && !isPausedStrict && !isNotStarted
    if (category === 'completed') return isCompleted
    if (category === 'overdue') return isOverdue
    if (category === 'paused') return isPausedStrict
    if (category === 'notStarted') return isNotStarted
    if (category === 'processing') return isProcessing
    // 加急是"进行中"的属性(独立属性筛选,和分类并行)
    if (category === 'urgent') return !!order.urgent && !isCompleted && !order.paused
    return true
  },

  toggleSelectMode() {
    const next = !this.data.selectMode
    this.setData({
      selectMode: next,
      deleteMode: false,
      selectedSet: {},
      selectedCount: 0
    }, () => {
      this._refreshCheckState()
    })
  },

  toggleDeleteMode() {
    const next = !this.data.deleteMode
    this.setData({
      deleteMode: next,
      selectMode: false,
      selectedSet: {},
      selectedCount: 0
    }, () => {
      this._refreshCheckState()
    })
  },

  toggleSelect(event) {
    const id = event.currentTarget.dataset.id
    // 删除模式下，只允许勾选「已完成」或「未开始」的工单
    if (this.data.deleteMode) {
      const order = this.data.orders.find(o => o.id === id)
      if (!order) return
      const deletable = order.category === 'completed' || this._isNotStarted(order)
      if (!deletable) {
        ui.toast('只能选择已完成或未开始的工单')
        return
      }
    }
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

  /**
   * 是否"未开始"的工单（还没完成第一道工序）
   * 不限制 status:processing 或 paused 都算(暂停但未开工可删除)
   * 与 orderManager.getDashboard 的 notStarted 统计条件一致
   */
  _isNotStarted(order) {
    if (!order) return false
    return (order.currentStepIndex || 0) === 0
      && (!Array.isArray(order.history) || order.history.length === 0)
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

  exportCompleted() {
    // 仅导出 status='completed' 的工单
    this.doExport(null, null, null, null, { onlyCompleted: true })
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

  async doExport(orderIds, dateRange, fileName, filterCustomer, opts = {}) {
    try {
      ui.showLoading('正在生成导出文件...')
      let orders = await this._fetchAllOrders()
      if (orderIds && orderIds.length > 0) {
        orders = orders.filter(o => orderIds.includes(o.id))
      }
      if (dateRange) {
        if (dateRange.start) orders = orders.filter(o => (o.orderDate || '') >= dateRange.start)
        if (dateRange.end) orders = orders.filter(o => (o.orderDate || '') <= dateRange.end)
      }
      if (filterCustomer) orders = orders.filter(o => o.customerName === filterCustomer)
      if (opts.onlyCompleted) orders = orders.filter(o => o.category === 'completed')
      orders = this._sortByCustomerAndDate(orders)

      if (orders.length === 0) {
        ui.hideLoading()
        ui.toast('该条件下没有可导出的工单')
        return
      }

      const name = fileName || (() => {
        if (opts.onlyCompleted) return `已完成工单_${orders.length}项`
        if (orderIds && orderIds.length > 0) return `选中_${orderIds.length}项工单`
        if (dateRange) return `按下单日期_${dateRange.start || '起'}至${dateRange.end || '今'}`
        return '工单导出'
      })()

      const res = await exportOrders(orders, name)
      ui.hideLoading()
      if (res && res.mode === 'disk') {
        ui.toast('已保存到所选目录，双击即可打开', 'success', 2500)
      }
      this.setData({ selectMode: false, selectedSet: {}, selectedCount: 0 }, () => {
        this._refreshCheckState()
      })
    } catch (e) {
      ui.hideLoading()
      // 开发者工具不支持「另存为」：给明确指引，不当作普通导出失败
      if (e && e.code === 'DEVTOOLS_UNSUPPORTED') {
        ui.toast('开发者工具不支持「另存为」，请在电脑版微信中导出', 'none', 3500)
        return
      }
      ui.handleError(e, '导出失败')
    }
  },

  async confirmSafeDelete() {
    console.log('[safeDelete] confirmSafeDelete 触发, selectedSet =', this.data.selectedSet)
    const ids = Object.keys(this.data.selectedSet)
    if (ids.length === 0) {
      ui.toast('请先勾选要删除的工单')
      return
    }
    // 服务端兜底校验：只允许「已完成」或「未开始」的工单
    const selected = this.data.orders.filter(o => ids.includes(o.id))
    const invalid = selected.filter(o => o.category !== 'completed' && !this._isNotStarted(o))
    if (invalid.length > 0) {
      ui.toast('只能删除已完成或未开始的工单，请取消其他选择')
      return
    }

    // 【修复】不再依赖 wx.showModal(在某些环境下会被吞/不弹),
    //   改用 Page 内自定义弹窗(data + wx:if 控制,绝对可靠)
    const content = selected.map(o => `• ${o.id}  ${o.customerName || ''}`).join('\n')
    this.setData({
      showDeleteConfirmModal: true,
      deleteConfirmContent: content,
      deleteConfirmIds: ids,
      deleteConfirmBtnLoading: false
    })
  },

  /** 取消删除 */
  onCancelDelete() {
    this.setData({ showDeleteConfirmModal: false, deleteConfirmBtnLoading: false })
  },

  /** 确认删除(从自定义弹窗触发) */
  async onConfirmDelete() {
    if (this.data.deleteConfirmBtnLoading) return
    const ids = (this.data.deleteConfirmIds || []).slice()
    if (ids.length === 0) {
      this.onCancelDelete()
      return
    }
    this.setData({ deleteConfirmBtnLoading: true })
    ui.showLoading('正在删除...')
    let successCount = 0
    const failedIds = []
    try {
      for (const id of ids) {
        try {
          await api.safeDeleteOrder(id, '已确认删除')
          successCount++
        } catch (e) {
          failedIds.push(id)
          console.error('[safeDelete] 删除失败', id, e)
        }
      }
      ui.hideLoading()
      this.setData({ showDeleteConfirmModal: false, deleteConfirmBtnLoading: false })
      if (failedIds.length > 0) {
        ui.toast(`已删除 ${successCount}，失败 ${failedIds.length}`, 'none', 3000)
      } else {
        ui.toast(`已删除 ${successCount} 个工单`, 'success')
      }
      this.setData({ deleteMode: false, selectedSet: {}, selectedCount: 0 }, () => {
        this.refresh()
      })
    } catch (e) {
      ui.hideLoading()
      this.setData({ deleteConfirmBtnLoading: false })
      ui.handleError(e, '删除失败')
    }
  },

  openOrder(event) {
    if (this.data.selectMode) return
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  /** 管理员就地撤销进行中的认领（换人推进当前工序） */
  async revokeClaim(event) {
    const id = event.currentTarget.dataset.id
    const claim = (this.data.claims || []).find(c => c.status === 'active' && c.orderId === id)
    if (!claim) return
    const ok = await ui.confirm(
      `确定撤销「${claim.userName}」对「${claim.stepName}」的认领吗？撤销后其他员工可重新认领该工序。`,
      '撤销认领',
      { confirmColor: '#b91c1c', modalTimeout: 4000, fallbackOnTimeout: true }
    )
    if (!ok) return
    try {
      ui.showLoading('撤销中...')
      await api.releaseClaim(id)
      ui.hideLoading()
      ui.toast('已撤销认领', 'success')
      await this.refresh()
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '撤销认领失败')
    }
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  openScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  }
})
