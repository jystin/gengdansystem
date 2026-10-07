const api = require('../../utils/api')
const ui = require('../../utils/ui')
const storage = require('../../utils/cloud-storage')
const { buildQrUrl } = require('../../utils/qr-url')

// 小程序码 fileID → 临时链接缓存（临时链接 2 小时过期）
const _wxacodeUrlCache = Object.create(null)
const _textQrUrlCache = Object.create(null)

function getQrUrlSync(order) {
  if (order && order.qrCodeFileID && _wxacodeUrlCache[order.qrCodeFileID]) {
    return _wxacodeUrlCache[order.qrCodeFileID]
  }
  return getTextQrUrlSync(order)
}

function getTextQrUrlSync(order) {
  const text = order ? (order.qrContent || order.id) : ''
  const key = `${text}_320`
  if (text && !_textQrUrlCache[key]) {
    _textQrUrlCache[key] = buildQrUrl(text, 320)
  }
  return _textQrUrlCache[key] || ''
}

function withQrUrls(order) {
  if (!order) return order
  return { ...order, qrUrl: getQrUrlSync(order), textQrUrl: getTextQrUrlSync(order) }
}

/**
 * 异步刷新小程序码临时链接（getTempFileURL 链接 2 小时过期）
 * @returns {string} 可展示的 URL
 */
async function refreshQrUrlAsync(order) {
  if (order && order.qrCodeFileID) {
    try {
      const result = await storage.getTempFileURL([order.qrCodeFileID])
      if (result && result.fileList && result.fileList[0] && result.fileList[0].tempFileURL) {
        _wxacodeUrlCache[order.qrCodeFileID] = result.fileList[0].tempFileURL
        return result.fileList[0].tempFileURL
      }
    } catch (e) { /* 降级到文本二维码 */ }
  }
  return getQrUrlSync(order)
}

/**
 * 为 steps 生成唯一 _stepKey，防止同名工序 wx:key 重复警告
 */
function ensureStepKeys(order) {
  if (!order || !Array.isArray(order.steps)) return order
  return { ...order, steps: order.steps.map((s, i) => ({ ...s, _stepKey: `${s.key}_${i}` })) }
}

Page({
  data: {
    order: null,
    note: '',
    completedQty: '',
    currentUser: { role: '', status: 'active' },
    processList: [],
    editingSteps: false,
    selectedSteps: [],
    selectedStepKeys: [],
    isAdmin: false,
    canComplete: false,
    materialTypes: [],
    materialConsumption: { material: '', roughness: '', length: '', qty: '' },
    isBlankingStep: false,
    operatorId: '',
    operatorLabel: '请选择操作员',
    activeEmployees: [],
    showOperatorPicker: false,
    operatorSearchKeyword: '',
    pendingDrawings: [],
    drawingUrls: [],
    drawingCount: 0,
    hasDrawings: false,
    hasPending: false,
    // 前端状态：是否正在后台补充加载（用于 UI 展示骨架屏/弱提示）
    isLoadingMore: false,
    // 小程序码重新生成状态
    qrRegenerating: false,
    // ===== 编辑工单字段 =====
    editingFields: false,
    editFieldsDraft: {}, // 顶层字段
    editDetailDraft: {}, // 图纸细节字段
    editBtnLoading: false
  },

  async onLoad(options) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    // 支持两种进入方式：
    //   1. 页面跳转 → options.id = 工单号
    //   2. 微信扫码（小程序码）→ options.scene = 工单号
    const orderId = options.id || options.scene
    if (!orderId) {
      ui.toast('缺少工单号，请扫描有效的小程序码')
      return
    }
    this.orderId = decodeURIComponent(orderId)
    await this.refresh({ force: true })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  async onShow() {
    // 节流：3 秒内已刷新过则不重复刷新，避免从后台切回/页面跳转时反复请求
    if (this._lastRefreshAt && Date.now() - this._lastRefreshAt < 3000) return
    if (this._inputFocusing || this.data.hasPending) return
    await this.refresh()
  },

  /**
   * 刷新工单详情
   * @param {Object} opts
   * @param {boolean} opts.force 是否强制刷新（忽略节流）
   *
   * 分阶段加载策略：
   *   1. 首屏优先：只拿工单主数据，立即 setData 渲染核心 UI
   *   2. 后台补齐：并行加载 materialTypes / employees / drawing URLs
   *   3. 下料计算：仅在当前是下料工序时，异步计算重量/库存
   * 这样用户能最快看到工单主体，避免等待所有接口串行完成。
   */
  async refresh(opts = {}) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    if (!this.orderId) return

    // 节流保护（非强制刷新时）
    if (!opts.force && this._lastRefreshAt && Date.now() - this._lastRefreshAt < 3000) return

    this._lastRefreshAt = Date.now()
    if (this._refreshing) return
    this._refreshing = true

    try {
      ui.showLoading('加载中...')

      // ===== Phase 1: 首屏核心数据（只请求工单，最快渲染）=====
      let order = await api.getOrder(this.orderId)

      if (!order) {
        ui.resetLoading()
        ui.toast('工单不存在')
        this.setData({ order: null })
        return
      }

      const user = app.globalData.currentUser
      const { isAdmin, canComplete, isBlankingStep, autoLength } = this._computeAccessState(user, order)

      // 确保 steps 有唯一 _stepKey（防止 wx:key 重复警告）
      order = ensureStepKeys(order)

      // 清理工单 history 中的操作员英文名
      if (order.history && Array.isArray(order.history)) {
        order.history = order.history.map(h => ({
          ...h,
          operator: api.cleanName(h.operator, '操作员')
        }))
      }

      let mcUpdate = null
      if (isBlankingStep) {
        const prevMc = this.data.materialConsumption || {}
        mcUpdate = {
          material: prevMc.material || '',
          roughness: prevMc.roughness || '',
          length: prevMc.length || autoLength,
          qty: prevMc.qty || ''
        }
      }

      // 先渲染首屏，让用户立刻看到工单主体
      // 如果当前处于编辑工序模式，则不要覆盖已选工序，避免 instanceId 丢失导致删除时清空全部
      // 异步刷新小程序码临时链接（优先 wxacode，降级文本二维码）
      const qrUrl = await refreshQrUrlAsync(order)
      this.setData({
        order: withQrUrls({ ...order, qrUrl }),
        currentUser: user,
        ...(this.data.editingSteps ? {} : {
          selectedSteps: order.steps || [],
          selectedStepKeys: (order.steps || []).map(s => s.key)
        }),
        isAdmin,
        canComplete,
        isBlankingStep,
        drawingCount: (order.drawings || []).length + (this.data.pendingDrawings || []).length,
        hasDrawings: (order.drawings || []).length + (this.data.pendingDrawings || []).length > 0,
        ...(mcUpdate ? { materialConsumption: mcUpdate } : {})
      })
      ui.hideLoading()

      // ===== Phase 2: 后台并行加载参考数据（员工、材料类型）和图纸 URL =====
      this.setData({ isLoadingMore: true })
      const [materialTypes, employees] = await Promise.all([
        api.getMaterialTypes(),
        api.listEmployees()
      ])


      const activeEmployees = (employees || [])
        .filter(e => e.status === 'active' && e.role !== 'superadmin')
        .map(e => ({ ...e, name: api.cleanName(e.name, '员工'), _stationDisplay: api.getEmployeeDisplayStations(e) }))

      const userDisplayName = api.cleanName(user.name, '用户')
      const userStationDisplay = api.getEmployeeDisplayStations(user)
      let defaultOperatorId = user.id
      let defaultOperatorLabel = userDisplayName + (userStationDisplay ? ` · ${userStationDisplay}` : '')
      if (!activeEmployees.find(e => e.id === user.id) && activeEmployees.length > 0) {
        const first = activeEmployees[0]
        defaultOperatorId = first.id
        defaultOperatorLabel = first.name + (api.getEmployeeDisplayStations(first) ? ` · ${api.getEmployeeDisplayStations(first)}` : '')
      }

      // 图纸 URL 改为懒加载：先让首屏出来，再异步换临时链接
      const drawingUrls = await this._resolveDrawingUrls(order.drawings || [])
      const pendingLen = (this.data.pendingDrawings || []).length
      const drawingCount = drawingUrls.length + pendingLen

      this.setData({
        materialTypes: materialTypes || [],
        activeEmployees,
        drawingUrls,
        drawingCount,
        hasDrawings: drawingCount > 0,
        hasPending: pendingLen > 0,
        isLoadingMore: false,
        ...(this.data.operatorId ? {} : {
          operatorId: defaultOperatorId,
          operatorLabel: defaultOperatorLabel
        })
      })


      // ===== Phase 3: 下料工序才需要的重量/库存计算（完全异步，不阻塞 UI）=====
      if (isBlankingStep) {
        this._updateCalcWeight()
      } else if (this.data.calcWeightInfo) {
        this.setData({ calcWeightInfo: null })
      }
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    } finally {
      ui.hideLoading()
      this._refreshing = false
    }
  },

  /**
   * 批量解析图纸 fileID → 临时 URL
   * 与首屏渲染解耦，避免 wx.cloud.getTempFileURL 阻塞页面展示
   */
  async _resolveDrawingUrls(drawings) {
    const drawingUrls = []
    if (!Array.isArray(drawings) || drawings.length === 0) return drawingUrls

    const fileIDList = drawings.filter(d => d.fileID).map(d => d.fileID)
    const localPaths = drawings.filter(d => d.tempFilePath && !d.fileID).map(d => d.tempFilePath)

    if (fileIDList.length > 0) {
      try {
        const t = await storage.getTempFileURL(fileIDList)
        if (t && t.fileList) {
          for (const item of t.fileList) {
            if (item.tempFileURL) drawingUrls.push(item.tempFileURL)
          }
        }
      } catch (e) {
        console.warn('[order-detail] 图纸临时链接获取失败', e)
      }
    }
    drawingUrls.push(...localPaths)
    return drawingUrls
  },

  previewDrawing(event) {
    const urls = event.currentTarget.dataset.urls || []
    const index = event.currentTarget.dataset.index || 0
    if (urls.length === 0) return
    wx.previewImage({ current: urls[index], urls })
  },

  async chooseDrawing() {
    if (this._choosingLock) return
    this._choosingLock = true
    try {
      const app = getApp()
      const privacyOk = await app.requirePrivacyAuthorize()
      if (!privacyOk) return

      const chooseResult = await new Promise((resolve) => {
        wx.chooseMedia({
          count: 9,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          success: (res) => resolve(res),
          fail: () => resolve(null)
        })
      })

      if (!chooseResult) return
      const tempFiles = chooseResult.tempFiles || []
      const pendingDrawings = (this.data.pendingDrawings || []).concat(
        tempFiles.map((file, index) => ({
          name: `drawing_${Date.now()}_${index}`,
          tempFilePath: file.tempFilePath,
          type: file.type || 'image',
          size: file.size || 0
        }))
      )
      const drawingCount = (this.data.drawingUrls || []).length + pendingDrawings.length
      this.setData({
        pendingDrawings,
        drawingCount,
        hasDrawings: drawingCount > 0,
        hasPending: pendingDrawings.length > 0
      })
    } catch (e) {
      ui.handleError(e, '选择图纸失败')
    } finally {
      this._choosingLock = false
    }
  },

  removePendingDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    const pendingDrawings = this.data.pendingDrawings.filter((_, i) => i !== index)
    const drawingCount = (this.data.drawingUrls || []).length + pendingDrawings.length
    this.setData({
      pendingDrawings,
      drawingCount,
      hasDrawings: drawingCount > 0,
      hasPending: pendingDrawings.length > 0
    })
  },

  /**
   * 删除已上传的图纸(点 ✕ 直接执行)
   * 流程:wx.cloud.deleteFile(云存储) + api.updateOrderDrawings(数据库)
   * 【修复】原本用 wx.showModal 二次确认,但你这环境下 modal 会被吞,
   *   改成点 ✕ 直接执行 + toast 反馈,确保每次点击都有反应。
   *   误删可重新上传,代价低;管理员操作默认信任。
   */
  async deleteUploadedDrawing(event) {
    console.log('[deleteDrawing] click, event =', event)
    const index = Number(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.index)
    if (isNaN(index) || index < 0) {
      ui.toast('图纸索引异常')
      return
    }
    if (!this.orderId) {
      ui.toast('工单数据未加载完成')
      return
    }
    const drawings = (this.data.order && this.data.order.drawings) || []
    const target = drawings[index]
    if (!target || !target.fileID) {
      ui.toast('图纸数据异常,无法删除')
      return
    }
    ui.showLoading('正在删除图纸...')
    try {
      // 1. 删除云存储文件(失败不阻塞,数据库为准)
      try {
        await storage.deleteFile({ fileList: [target.fileID] })
      } catch (e) {
        console.warn('[deleteDrawing] deleteFile 失败,继续更新数据库', e)
      }
      // 2. 更新数据库 drawings 数组
      const newDrawings = drawings.filter((_, i) => i !== index)
      await api.updateOrderDrawings(this.orderId, newDrawings)
      // 3. 更新本地 UI
      const newDrawingUrls = (this.data.drawingUrls || []).filter((_, i) => i !== index)
      const drawingCount = newDrawingUrls.length + (this.data.pendingDrawings || []).length
      this.setData({
        order: { ...this.data.order, drawings: newDrawings },
        drawingUrls: newDrawingUrls,
        drawingCount,
        hasDrawings: drawingCount > 0
      })
      ui.hideLoading()
      ui.toast('图纸已删除', 'success')
    } catch (e) {
      ui.hideLoading()
      console.error('[deleteDrawing] failed', e)
      ui.handleError(e, '删除图纸失败')
    }
  },

  /**
   * 编辑工单字段(防下错单):
   * 1. 进入编辑模式:复制当前 order 字段到 draft,字段变 input
   * 2. 保存:合并顶层字段 + drawingDetail,调 api.updateOrderFields
   * 3. 取消:清空 draft,关闭编辑
   *
   * 二维码不需要重新生成(指向工单号 GDxxx,工单号不变)
   */
  enterEditFields() {
    if (!this.data.order) return
    const o = this.data.order
    this.setData({
      editingFields: true,
      editFieldsDraft: {
        customerName: o.customerName || '',
        type: o.type || '',
        size: o.size || '',
        qty: o.qty != null ? String(o.qty) : '',
        singleNo: o.singleNo || '',
        material: o.material || '',
        dueDate: o.dueDate || '',
        orderDate: o.orderDate || '',
        remarks: o.remarks || ''
      },
      editDetailDraft: {
        blankingRoughness: (o.drawingDetail && o.drawingDetail.blankingRoughness) || '',
        productRoughness: (o.drawingDetail && o.drawingDetail.productRoughness) || '',
        length: (o.drawingDetail && o.drawingDetail.length) || '',
        blankingLength: (o.drawingDetail && o.drawingDetail.blankingLength) || '',
        topHoleThread: (o.drawingDetail && o.drawingDetail.topHoleThread) || '',
        crossHole: (o.drawingDetail && o.drawingDetail.crossHole) || '',
        squareHead: (o.drawingDetail && o.drawingDetail.squareHead) || ''
      },
      editBtnLoading: false
    })
  },

  cancelEditFields() {
    this.setData({
      editingFields: false,
      editFieldsDraft: {},
      editDetailDraft: {},
      editBtnLoading: false
    })
  },

  onEditFieldInput(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`editFieldsDraft.${key}`]: event.detail.value })
  },

  onEditDetailInput(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`editDetailDraft.${key}`]: event.detail.value })
  },

  async saveEditFields() {
    if (this.data.editBtnLoading) return
    const draft = this.data.editFieldsDraft || {}
    const detail = this.data.editDetailDraft || {}

    // 本地校验:必填项
    if (!draft.type || !String(draft.type).trim()) return ui.toast('请输入种类')
    if (!draft.size || !String(draft.size).trim()) return ui.toast('请输入尺寸')
    if (!draft.material || !String(draft.material).trim()) return ui.toast('请输入材质')
    const qty = Number(draft.qty)
    if (!Number.isFinite(qty) || qty <= 0) return ui.toast('请输入正确的数量')

    const fields = {
      customerName: String(draft.customerName || '').trim(),
      type: String(draft.type || '').trim(),
      size: String(draft.size || '').trim(),
      qty: qty,
      singleNo: String(draft.singleNo || '').trim(),
      material: String(draft.material || '').trim(),
      dueDate: String(draft.dueDate || '').trim(),
      orderDate: String(draft.orderDate || '').trim(),
      remarks: String(draft.remarks || '').trim()
    }
    // 图纸细节(全字段透传,后端白名单过滤)
    const drawingDetail = {
      blankingRoughness: String(detail.blankingRoughness || '').trim(),
      productRoughness: String(detail.productRoughness || '').trim(),
      length: String(detail.length || '').trim(),
      blankingLength: String(detail.blankingLength || '').trim(),
      topHoleThread: String(detail.topHoleThread || '').trim(),
      crossHole: String(detail.crossHole || '').trim(),
      squareHead: String(detail.squareHead || '').trim()
    }

    this.setData({ editBtnLoading: true })
    try {
      const res = await api.updateOrderFields(this.orderId, { ...fields, drawingDetail })
      // 云函数返回 { success: true, order: {...} },需要取 .order
      const updated = (res && res.order) || null
      // 同步本地 order(用云端返回值;若无返回则用本地拼接兜底)
      const rawOrder = updated || { ...this.data.order, ...fields, drawingDetail }
      // 重新应用 QR URL + 确保 steps 有唯一 key(云端返回可能没有)
      const newOrder = withQrUrls(ensureStepKeys(rawOrder))
      this.setData({
        order: newOrder,
        editingFields: false,
        editFieldsDraft: {},
        editDetailDraft: {},
        editBtnLoading: false
      })
      ui.toast('修改已保存', 'success')
    } catch (e) {
      console.error('[editFields] failed', e)
      this.setData({ editBtnLoading: false })
      ui.handleError(e, '保存失败')
    }
  },

  clearPendingDrawings() {
    const drawingCount = (this.data.drawingUrls || []).length
    this.setData({
      pendingDrawings: [],
      drawingCount,
      hasDrawings: drawingCount > 0,
      hasPending: false
    })
  },

  async saveDrawings() {
    const pendingDrawings = this.data.pendingDrawings || []
    if (pendingDrawings.length === 0) return
    const user = this.data.currentUser
    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
      ui.toast('仅管理员可上传图纸')
      return
    }
    try {
      ui.showLoading('上传图纸中...')
      const order = this.data.order || {}
      const drawings = []
      const CONCURRENCY = 3
      for (let i = 0; i < pendingDrawings.length; i += CONCURRENCY) {
        const batch = pendingDrawings.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(batch.map(async (d) => {
          const ext = (d.tempFilePath.match(/\.(\w+)$/) || [])[1] || 'jpg'
          const cloudPath = `drawings/${order.singleNo || order.id || 'order'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
          const up = await storage.uploadFile(cloudPath, d.tempFilePath)
          return { name: d.name, fileID: up.fileID, cloudPath: up.fileID, type: d.type || 'image' }
        }))
        for (const result of results) {
          if (result.status === 'fulfilled') drawings.push(result.value)
        }
      }

      const res = await api.updateOrderDrawings(this.orderId, drawings)
      const updated = ensureStepKeys(res && res.order ? res.order : res)
      this.setData({
        order: withQrUrls(updated),
        pendingDrawings: []
      })
      await this.refresh()
      ui.hideLoading()
      ui.toast('图纸上传成功', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '上传图纸失败')
    }
  },

  onNoteInput(event) {
    this._inputFocusing = true
    this.setData({ note: event.detail.value })
  },

  onQtyInput(event) {
    this._inputFocusing = true
    this.setData({ completedQty: event.detail.value })
  },

  onNoteBlur() { this._inputFocusing = false },
  onQtyBlur() { this._inputFocusing = false },

  bindMaterialType(event) {
    const index = Number(event.detail.value)
    const material = (this.data.materialTypes || [])[index]
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, material }
    })
    this._updateCalcWeight()
  },

  bindMaterialQty(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, qty: event.detail.value }
    })
    this._updateCalcWeight()
  },

  bindMaterialRoughness(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, roughness: event.detail.value }
    })
    this._updateCalcWeight()
  },

  bindMaterialLength(event) {
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, length: event.detail.value }
    })
    this._updateCalcWeight()
  },

  // 提取公共状态计算逻辑（refresh/completeStep/revertStep/saveStepChanges 复用）
  _computeAccessState(user, order) {
    const isAdmin = user.role === 'admin' || user.role === 'superadmin'
    const _stations = user.stations || (user.station ? [user.station] : [])
    const canComplete = order.status !== 'completed' && (isAdmin || _stations.includes(order.currentStation))
    const currentStep = order.steps && order.steps[order.currentStepIndex]
    const isBlankingStep = currentStep && currentStep.key === 'blanking'
    const autoLength = (isBlankingStep && order.drawingDetail && (order.drawingDetail.blankingLength || order.drawingDetail.length)) ? (order.drawingDetail.blankingLength || order.drawingDetail.length) : ''
    return { isAdmin, canComplete, isBlankingStep, autoLength }
  },

  async _updateCalcWeight() {
    if (this._calcWeightTimer) clearTimeout(this._calcWeightTimer)
    this._calcWeightTimer = setTimeout(() => this._doCalcWeight(), 300)
  },

  async _doCalcWeight() {
    const { materialConsumption } = this.data
    const len = Number(materialConsumption.length)
    const rVal = Number(materialConsumption.roughness)
    const qty = Number(materialConsumption.qty)
    if (!materialConsumption.material || !len || !rVal || !qty || len <= 0 || rVal <= 0 || qty <= 0) {
      this.setData({ calcWeightInfo: null })
      return
    }
    const coef = api.getRoughnessCoefficient(rVal)
    if (!coef) {
      this.setData({ calcWeightInfo: null })
      return
    }
    const singleWeightKg = len * 1.05 * coef * 0.001
    const totalTons = singleWeightKg * qty / 1000
    let currentStock = 0
    try {
      currentStock = await api.getMaterialStockByRoughness(materialConsumption.material, rVal)
    } catch (e) { currentStock = 0 }
    const remainStock = Math.max(currentStock - totalTons, 0)

    this.setData({
      calcWeightInfo: {
        coef,
        singleWeightKg: singleWeightKg.toFixed(3),
        totalTons: totalTons.toFixed(3),
        currentStock: currentStock.toFixed(3),
        remainStock: remainStock.toFixed(3)
      }
    })
  },

  showOperatorPicker() {
    this.setData({ showOperatorPicker: true, operatorSearchKeyword: '' })
  },

  hideOperatorPicker() {
    this.setData({ showOperatorPicker: false })
  },

  onOperatorPanelTap() { /* 阻止冒泡 */ },

  onOperatorSearchInput(event) {
    this._inputFocusing = true
    this.setData({ operatorSearchKeyword: event.detail.value.trim() })
  },

  selectOperator(event) {
    const id = event.currentTarget.dataset.id
    const emp = this.data.activeEmployees.find(e => e.id === id)
    if (!emp) return
    this.setData({
      operatorId: emp.id,
      operatorLabel: emp.name + (api.getEmployeeDisplayStations(emp) ? ` · ${api.getEmployeeDisplayStations(emp)}` : ''),
      showOperatorPicker: false,
      operatorSearchKeyword: ''
    })
  },



  async completeStep() {
    const { isBlankingStep, materialConsumption, note, completedQty } = this.data

    if (isBlankingStep) {
      if (!materialConsumption.material) { ui.toast('请选择材料类型'); return }
      const rVal = Number(materialConsumption.roughness)
      if (!materialConsumption.roughness || isNaN(rVal) || rVal < 0 || rVal > 200) { ui.toast('请输入有效的粗度（0-200mm）'); return }
      const len = Number(materialConsumption.length)
      if (!materialConsumption.length || isNaN(len) || len <= 0) { ui.toast('请输入有效的长度（mm）'); return }
      const matQty = Number(materialConsumption.qty)
      if (!materialConsumption.qty || isNaN(matQty) || matQty <= 0) { ui.toast('请输入有效的消耗数量'); return }
    } else {
      const qty = Number(completedQty)
      if (!completedQty || isNaN(qty) || qty < 0) { ui.toast('请输入有效的非负数字'); return }
    }

    if (!this.data.operatorId) { ui.toast('请选择操作员'); return }

    try {
      let submitConsumption = null
      if (isBlankingStep) {
        const len = Number(materialConsumption.length)
        const rVal = Number(materialConsumption.roughness)
        const pieces = Number(materialConsumption.qty)
        const coef = api.getRoughnessCoefficient(rVal) || (rVal * rVal * 0.006165)
        const calcTons = len * 1.05 * coef * 0.001 * pieces / 1000
        submitConsumption = {
          ...materialConsumption,
          calcTons: Math.round(calcTons * 10000) / 10000
        }
      }
      ui.showLoading('提交中...')
      const result = await api.completeCurrentStep({
        orderId: this.orderId,
        operatorId: this.data.operatorId,
        note,
        completedQty: isBlankingStep ? null : completedQty,
        materialConsumption: submitConsumption
      })
      const order = ensureStepKeys(result && result.order ? result.order : result)
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: nextBlanking, autoLength } = this._computeAccessState(app.globalData.currentUser, order)

      this.setData({
        order: withQrUrls(order),
        note: '',
        completedQty: '',
        isAdmin,
        canComplete,
        isBlankingStep: nextBlanking,
        materialConsumption: { material: '', roughness: '', length: '', qty: '' },
        calcWeightInfo: null
      })
      ui.hideLoading()
      ui.toast('工序已完成并流转', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '提交失败')
    }
  },

  async togglePause() {
    try {
      const order = ensureStepKeys(await api.togglePause(this.orderId, !this.data.order.paused))
      this.setData({
        order: withQrUrls(order)
      })
      ui.toast(order.paused ? '已暂停' : '已恢复', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async toggleUrgent() {
    try {
      const order = ensureStepKeys(await api.toggleOrderUrgent(this.orderId, !this.data.order.urgent))
      this.setData({
        order: withQrUrls(order)
      })
      ui.toast(order.urgent ? '已设为加急' : '已取消加急', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  enterEditSteps() {
    if (this.data.currentUser.role !== 'admin' && this.data.currentUser.role !== 'superadmin') {
      ui.toast('只有管理员可以编辑工序')
      return
    }
    const processList = api.getProcessLibrary()
    const { order } = this.data
    const currentStepIndex = order.currentStepIndex || 0
    const selectedSteps = (order.steps || []).map((step, index) => ({
      ...step,
      instanceId: `${step.key}_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      canDelete: index >= currentStepIndex,
      canRevert: index < currentStepIndex
    }))
    this.setData({
      editingSteps: true,
      processList,
      selectedSteps,
      selectedStepKeys: selectedSteps.map(s => s.key)
    })
  },

  exitEditSteps() {
    const { order } = this.data
    this.setData({ editingSteps: false, selectedSteps: order.steps, selectedStepKeys: order.steps.map(s => s.key) })
  },

  addStep(event) {
    const stepKey = event.currentTarget.dataset.key
    const step = this.data.processList.find((p) => p.key === stepKey)
    if (!step) return
    const newStep = {
      ...step,
      instanceId: `${stepKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      canDelete: true,
      canRevert: false
    }
    const newSelectedSteps = [...this.data.selectedSteps, newStep]
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    // 防御 instanceId 缺失时误清空全部
    if (!instanceId) {
      console.warn('[order-detail] 删除工序失败：缺少 instanceId')
      ui.toast('操作失败，请重试')
      return
    }
    const step = this.data.selectedSteps.find(s => s.instanceId === instanceId)
    if (step && !step.canDelete) {
      ui.toast('该工序已完成，无法删除')
      return
    }
    const newSelectedSteps = this.data.selectedSteps.filter((s) => s.instanceId !== instanceId)
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  async revertStep(event) {
    // 严格限制：仅管理员可回退工序
    if (!this.data.isAdmin) {
      ui.toast('仅管理员可回退工序')
      return
    }

    const instanceId = event.currentTarget.dataset.instanceId
    const stepKey = event.currentTarget.dataset.stepKey
    let step = null
    if (instanceId) {
      step = this.data.selectedSteps.find(s => s.instanceId === instanceId)
    } else if (stepKey) {
      step = (this.data.order.steps || []).find(s => s.key === stepKey)
    }
    if (!step) return

    // 二次确认，防止误操作
    const ok = await ui.confirm(`确定要撤回「${step.name}」吗？该工序的完成记录将被移除，当前工序将回退到此步骤。`, '确认撤回', { confirmColor: '#e53935' })
    if (!ok) return

    try {
      ui.showLoading('撤回中...')
      const updatedOrder = ensureStepKeys(await api.revertCompletedStep(this.orderId, step.key))
      if (!updatedOrder || !Array.isArray(updatedOrder.stepKeys)) {
        ui.hideLoading()
        ui.toast('撤回失败，返回数据异常')
        return
      }
      const revertedSteps = updatedOrder.steps || updatedOrder.stepKeys.map(k => {
        const p = api.getProcessByKey(k)
        return p ? { ...p } : null
      }).filter(Boolean)
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: isBlankingAfterRevert, autoLength: autoLengthAfterRevert } = this._computeAccessState(app.globalData.currentUser, updatedOrder)

      this.setData({
        order: withQrUrls(updatedOrder),
        editingSteps: false,
        selectedSteps: revertedSteps,
        selectedStepKeys: (updatedOrder.stepKeys || []).map(k => k),
        isAdmin,
        canComplete,
        isBlankingStep: isBlankingAfterRevert,
        materialConsumption: isBlankingAfterRevert ? { material: '', roughness: '', length: autoLengthAfterRevert, qty: '' } : this.data.materialConsumption
      })
      if (isBlankingAfterRevert) {
        await this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
      }
      ui.hideLoading()
      ui.toast('已撤回工序', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '撤回失败')
    }
  },

  async saveStepChanges() {
    const { selectedSteps } = this.data
    if (selectedSteps.length === 0) {
      ui.toast('至少需要一个工序')
      return
    }
    const selectedStepKeys = selectedSteps.map((s) => s.key)
    try {
      ui.showLoading('保存中...')
      const updatedOrder = ensureStepKeys(await api.updateOrderStepKeys(this.orderId, selectedStepKeys))
      if (!updatedOrder || !Array.isArray(updatedOrder.stepKeys)) {
        ui.hideLoading()
        ui.toast('保存失败，返回数据异常')
        return
      }
      // 若后端未展开 steps，则根据 stepKeys 本地同步，确保 UI 有数据
      const savedSteps = updatedOrder.steps || updatedOrder.stepKeys.map(k => {
        const p = api.getProcessByKey(k)
        return p ? { ...p } : null
      }).filter(Boolean)
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: isBlankingAfterSave, autoLength: autoLengthAfterSave } = this._computeAccessState(app.globalData.currentUser, updatedOrder)

      this.setData({
        order: withQrUrls(updatedOrder),
        editingSteps: false,
        selectedSteps: savedSteps,
        selectedStepKeys: (updatedOrder.stepKeys || []).map(k => k),
        isAdmin,
        canComplete,
        isBlankingStep: isBlankingAfterSave,
        materialConsumption: isBlankingAfterSave ? { material: '', roughness: '', length: autoLengthAfterSave, qty: '' } : this.data.materialConsumption
      })
      if (isBlankingAfterSave) {
        await this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
      }
      ui.hideLoading()
      ui.toast('工序已更新', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '保存失败')
    }
  },

  async regenerateWxacode() {
    if (this.data.qrRegenerating) return
    this.setData({ qrRegenerating: true })
    try {
      const res = await api.generateWxacode(this.orderId, true)
      if (!res || !res.fileID) { ui.toast('生成失败：' + (res && res.error || '未知错误')); return }
      ui.toast('小程序码已生成', 'success')
      await this.refresh({ force: true })
    } catch (e) {
      ui.handleError(e, '小程序码生成失败')
    } finally {
      this.setData({ qrRegenerating: false })
    }
  }
})
