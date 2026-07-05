const api = require('../../utils/api')
const ui = require('../../utils/ui')
const { buildQrUrl } = require('../../utils/qr-url')
// 【优化】buildQrUrl 结果按 text 缓存，同一 orderId 多次 setData 不再重复生成
const _qrUrlCache = Object.create(null)
function cachedQrUrl(text, size) {
  const key = `${text}_${size}`
  if (!_qrUrlCache[key]) {
    _qrUrlCache[key] = buildQrUrl(text, size)
  }
  return _qrUrlCache[key]
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
    isLoadingMore: false
  },

  async onLoad(options) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    this.orderId = options.id
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
      const order = await api.getOrder(this.orderId)

      if (!order) {
        ui.resetLoading()
        ui.toast('工单不存在')
        this.setData({ order: null })
        return
      }

      const user = app.globalData.currentUser
      const { isAdmin, canComplete, isBlankingStep, autoLength } = this._computeAccessState(user, order)

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
      this.setData({
        order: {
          ...order,
          qrUrl: cachedQrUrl(order.qrContent || order.id, 320)
        },
        currentUser: user,
        selectedSteps: order.steps || [],
        selectedStepKeys: (order.steps || []).map(s => s.key),
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
        const t = await wx.cloud.getTempFileURL({ fileList: fileIDList })
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
          const up = await wx.cloud.uploadFile({ cloudPath, filePath: d.tempFilePath })
          return { name: d.name, fileID: up.fileID, cloudPath: up.fileID, type: d.type || 'image' }
        }))
        for (const result of results) {
          if (result.status === 'fulfilled') drawings.push(result.value)
        }
      }

      const res = await api.updateOrderDrawings(this.orderId, drawings)
      const updated = res && res.order ? res.order : res
      this.setData({
        order: { ...updated, qrUrl: cachedQrUrl(updated.qrContent || updated.id, 320) },
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
    const autoLength = (isBlankingStep && order.drawingDetail && order.drawingDetail.length) ? order.drawingDetail.length : ''
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
      const order = result && result.order ? result.order : result
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: nextBlanking, autoLength } = this._computeAccessState(app.globalData.currentUser, order)

      this.setData({
        order: {
          ...order,
          qrUrl: cachedQrUrl(order.qrContent || order.id, 320)
        },
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
      const order = await api.togglePause(this.orderId, !this.data.order.paused)
      this.setData({
        order: { ...order, qrUrl: cachedQrUrl(order.qrContent || order.id, 320) }
      })
      ui.toast(order.paused ? '已暂停' : '已恢复', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async toggleUrgent() {
    try {
      const order = await api.toggleOrderUrgent(this.orderId, !this.data.order.urgent)
      this.setData({
        order: { ...order, qrUrl: cachedQrUrl(order.qrContent || order.id, 320) }
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
    const confirmedKeys = new Set((order.history || []).map(h => h.stepKey))
    const selectedSteps = (order.steps || []).map((step, index) => ({
      ...step,
      instanceId: `${step.key}_${index}_${Date.now()}`,
      canDelete: !confirmedKeys.has(step.key),
      canRevert: confirmedKeys.has(step.key) && index < order.currentStepIndex
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
    const newSelectedSteps = [...this.data.selectedSteps, { ...step, instanceId: `${stepKey}_${Date.now()}`, canDelete: true }]
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
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
    const instanceId = event.currentTarget.dataset.instanceId
    const step = this.data.selectedSteps.find(s => s.instanceId === instanceId)
    if (!step || !step.canRevert) return

    const ok = await ui.confirm(`确定要撤回「${step.name}」吗？该工序的完成记录将被移除，当前工序将回退到此步骤。`, '确认撤回', { confirmColor: '#e53935' })
    if (!ok) return

    try {
      ui.showLoading('撤回中...')
      const updatedOrder = await api.revertCompletedStep(this.orderId, step.key)
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: isBlankingAfterRevert, autoLength: autoLengthAfterRevert } = this._computeAccessState(app.globalData.currentUser, updatedOrder)

      this.setData({
        order: { ...updatedOrder, qrUrl: cachedQrUrl(updatedOrder.qrContent || updatedOrder.id, 320) },
        editingSteps: false,
        selectedSteps: updatedOrder.steps,
        selectedStepKeys: (updatedOrder.steps || []).map(s => s.key),
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
      const updatedOrder = await api.updateOrderStepKeys(this.orderId, selectedStepKeys)
      const app = getApp()
      const { isAdmin, canComplete, isBlankingStep: isBlankingAfterSave, autoLength: autoLengthAfterSave } = this._computeAccessState(app.globalData.currentUser, updatedOrder)

      this.setData({
        order: { ...updatedOrder, qrUrl: cachedQrUrl(updatedOrder.qrContent || updatedOrder.id, 320) },
        editingSteps: false,
        selectedSteps: updatedOrder.steps,
        selectedStepKeys: (updatedOrder.steps || []).map(s => s.key),
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
  }
})
