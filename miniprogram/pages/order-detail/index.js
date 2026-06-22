const api = require('../../utils/api')
const ui = require('../../utils/ui')
const { buildQrUrl } = require('../../utils/qr-url')

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
    operatorSearchKeyword: ''
  },

  async onLoad(options) {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    this.orderId = options.id
    await this.refresh()
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  async onShow() {
    if (this._inputFocusing) return
    await this.refresh()
  },

  async refresh() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    if (!this.orderId) return

    try {
      ui.showLoading('加载中...')
      const [order, materialTypes, employees] = await Promise.all([
        api.getOrder(this.orderId),
        api.getMaterialTypes(),
        api.listEmployees()
      ])

      if (!order) {
        ui.hideLoading()
        ui.toast('工单不存在')
        return
      }

      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _stations = user.stations || (user.station ? [user.station] : [])
      const canComplete = order.status !== 'completed' && (isAdmin || _stations.includes(order.currentStation))
      const currentStep = order.steps && order.steps[order.currentStepIndex]
      const isBlankingStep = currentStep && currentStep.key === 'blanking'

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

      const autoLength = (isBlankingStep && order.drawingDetail && order.drawingDetail.length) ? order.drawingDetail.length : ''

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

      // 清理工单 history 中的操作员英文名
      if (order.history && Array.isArray(order.history)) {
        order.history = order.history.map(h => ({
          ...h,
          operator: api.cleanName(h.operator, '操作员')
        }))
      }

      // 处理 drawings 中云存储 fileID → 临时可访问 URL
      const drawingUrls = []
      if (Array.isArray(order.drawings)) {
        for (const d of order.drawings) {
          if (d.fileID) {
            try {
              const t = await wx.cloud.getTempFileURL({ fileList: [d.fileID] })
              if (t && t.fileList && t.fileList[0] && t.fileList[0].tempFileURL) {
                drawingUrls.push(t.fileList[0].tempFileURL)
              }
            } catch (e) { /* ignore */ }
          } else if (d.tempFilePath) {
            drawingUrls.push(d.tempFilePath)
          }
        }
      }

      this.setData({
        order: {
          ...order,
          qrUrl: buildQrUrl(order.qrContent || order.id, 320)
        },
        currentUser: user,
        selectedSteps: order.steps || [],
        selectedStepKeys: (order.steps || []).map(s => s.key),
        drawingUrls,
        isAdmin,
        canComplete,
        isBlankingStep,
        materialTypes: materialTypes || [],
        activeEmployees,
        ...(this.data.operatorId ? {} : {
          operatorId: defaultOperatorId,
          operatorLabel: defaultOperatorLabel
        }),
        ...(mcUpdate ? { materialConsumption: mcUpdate } : {})
      })

      if (isBlankingStep) {
        await this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) {
          this.setData({ calcWeightInfo: null })
        }
      }
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    } finally {
      ui.hideLoading()
    }
  },

  previewDrawing(event) {
    const urls = event.currentTarget.dataset.urls || []
    const index = event.currentTarget.dataset.index || 0
    if (urls.length === 0) return
    wx.previewImage({ current: urls[index], urls })
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

  async _updateCalcWeight() {
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

  get filteredEmployees() {
    const kw = (this.data.operatorSearchKeyword || '').toLowerCase()
    if (!kw) return this.data.activeEmployees
    return this.data.activeEmployees.filter(e =>
      e.name.toLowerCase().includes(kw) || (e._stationDisplay || '').toLowerCase().includes(kw)
    )
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
      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _s = user.stations || (user.station ? [user.station] : [])
      const canComplete = order.status !== 'completed' && (isAdmin || _s.includes(order.currentStation))
      const nextStep = (order.steps || [])[order.currentStepIndex]
      const nextBlanking = nextStep && nextStep.key === 'blanking'

      this.setData({
        order: {
          ...order,
          qrUrl: buildQrUrl(order.qrContent || order.id, 320)
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
        order: { ...order, qrUrl: buildQrUrl(order.qrContent || order.id, 320) }
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
        order: { ...order, qrUrl: buildQrUrl(order.qrContent || order.id, 320) }
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
      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _s1 = user.stations || (user.station ? [user.station] : [])
      const canComplete = updatedOrder.status !== 'completed' && (isAdmin || _s1.includes(updatedOrder.currentStation))
      const revertedStep = (updatedOrder.steps || [])[updatedOrder.currentStepIndex]
      const isBlankingAfterRevert = revertedStep && revertedStep.key === 'blanking'
      const autoLengthAfterRevert = (isBlankingAfterRevert && updatedOrder.drawingDetail && updatedOrder.drawingDetail.length) ? updatedOrder.drawingDetail.length : ''

      this.setData({
        order: { ...updatedOrder, qrUrl: buildQrUrl(updatedOrder.qrContent || updatedOrder.id, 320) },
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
      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _s2 = user.stations || (user.station ? [user.station] : [])
      const canComplete = updatedOrder.status !== 'completed' && (isAdmin || _s2.includes(updatedOrder.currentStation))
      const currentStepAfterSave = (updatedOrder.steps || [])[updatedOrder.currentStepIndex]
      const isBlankingAfterSave = currentStepAfterSave && currentStepAfterSave.key === 'blanking'
      const autoLengthAfterSave = (isBlankingAfterSave && updatedOrder.drawingDetail && updatedOrder.drawingDetail.length) ? updatedOrder.drawingDetail.length : ''

      this.setData({
        order: { ...updatedOrder, qrUrl: buildQrUrl(updatedOrder.qrContent || updatedOrder.id, 320) },
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
