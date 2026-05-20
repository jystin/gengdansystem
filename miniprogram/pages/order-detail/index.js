const { getOrder, completeCurrentStep, togglePause, getProcessLibrary, updateOrderStepKeys, revertCompletedStep, MATERIAL_TYPES, getRoughnessCoefficient, getMaterialStockByRoughness, getMaterialTypes, toggleOrderUrgent, listEmployees, getEmployeeDisplayStations } = require('../../utils/mock-store')
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
    materialTypes: MATERIAL_TYPES,
    materialConsumption: { material: '', roughness: '', length: '', qty: '' },
    isBlankingStep: false,
    // 工序操作员选择
    operatorId: '',
    operatorLabel: '请选择操作员',
    activeEmployees: [],
    showOperatorPicker: false,
    operatorSearchKeyword: ''
  },

  onLoad(options) {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    this.orderId = options.id
    this.refresh()
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onShow() {
    // 跳过键盘弹起触发 onShow 的场景，避免输入框失焦
    if (this._inputFocusing) return
    this.refresh()
  },

  refresh() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }

    if (!this.orderId) {
      return
    }

    const order = getOrder(this.orderId)
    if (!order) {
      wx.showToast({ title: '工单不存在', icon: 'none' })
      return
    }

    const user = app.globalData.currentUser
    const isAdmin = user.role === 'admin' || user.role === 'superadmin'
    // 管理员 或 当前工序在员工岗位列表中 可操作
    const _stations = user.stations || (user.station ? [user.station] : [])
    const canComplete = order.status !== 'completed' && (isAdmin || _stations.includes(order.currentStation))
    const currentStep = order.steps[order.currentStepIndex]
    const isBlankingStep = currentStep && currentStep.key === 'blanking'

    // 加载可用员工列表（已启用的，排除 superadmin）
    // 加载可用员工列表（已启用的，排除 superadmin），预处理岗位显示
    const rawEmployees = listEmployees().filter(e => e.status === 'active' && e.role !== 'superadmin')
    const activeEmployees = rawEmployees.map(e => ({
      ...e,
      _stationDisplay: getEmployeeDisplayStations(e)
    }))
    // 默认操作员：当前用户（如果用户在 active 列表中），否则选第一个
    let defaultOperatorId = user.id
    let defaultOperatorLabel = user.name + (getEmployeeDisplayStations(user) ? ` · ${getEmployeeDisplayStations(user)}` : '')
    if (!activeEmployees.find(e => e.id === user.id) && activeEmployees.length > 0) {
      const first = activeEmployees[0]
      defaultOperatorId = first.id
      defaultOperatorLabel = first.name + (getEmployeeDisplayStations(first) ? ` · ${getEmployeeDisplayStations(first)}` : '')
    }
    // 下料工序：从图纸细节自动预填长度（仅在长度为空时）
    const autoLength = (isBlankingStep && order.drawingDetail && order.drawingDetail.length) ? order.drawingDetail.length : ''

    // 下料工序：保留用户已输入的表单数据，只刷新订单/权限等状态信息
    let mcUpdate = null
    if (isBlankingStep) {
      const prevMc = this.data.materialConsumption || {}
      mcUpdate = {
        // 保留用户已填的值，仅当字段为空时才用默认值填充
        material: prevMc.material || '',
        roughness: prevMc.roughness || '',
        length: prevMc.length || autoLength,
        qty: prevMc.qty || ''
      }
    }

    this.setData({
      order: {
        ...order,
        qrUrl: buildQrUrl(order.qrContent || order.id, 320)
      },
      currentUser: user,
      selectedSteps: order.steps,
      selectedStepKeys: order.steps.map(s => s.key),
      drawingUrls: (order.drawings || []).map(d => d.tempFilePath).filter(Boolean),
      isAdmin,
      canComplete,
      isBlankingStep,
      materialTypes: getMaterialTypes(),
      activeEmployees,
      // 仅在操作员未手动选过时才重置（避免刷新覆盖用户选择）
      ...(this.data.operatorId ? {} : {
        operatorId: defaultOperatorId,
        operatorLabel: defaultOperatorLabel
      }),
      ...(mcUpdate ? { materialConsumption: mcUpdate } : {})
    })

    // 下料工序：立即重新计算（从 state 读取最新库存，确保与库存页同步）
    if (isBlankingStep) {
      this._updateCalcWeight()
    } else {
      // 非下料工序：清除残留的计算卡片
      if (this.data.calcWeightInfo) {
        this.setData({ calcWeightInfo: null })
      }
    }
  },

  // 预览图纸大图
  previewDrawing(event) {
    const urls = event.currentTarget.dataset.urls || []
    const index = event.currentTarget.dataset.index || 0
    if (urls.length === 0) return
    wx.previewImage({
      current: urls[index],
      urls
    })
  },

  onNoteInput(event) {
    this._inputFocusing = true
    this.setData({ note: event.detail.value })
  },

  onQtyInput(event) {
    this._inputFocusing = true
    this.setData({ completedQty: event.detail.value })
  },

  onNoteBlur() {
    this._inputFocusing = false
  },

  onQtyBlur() {
    this._inputFocusing = false
  },

  bindMaterialType(event) {
    const index = Number(event.detail.value)
    const material = MATERIAL_TYPES[index]
    this.setData({
      materialConsumption: { ...this.data.materialConsumption, material }
    })
    // 切换材料后立即重新计算（含库存查询）
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

  // 实时计算材料消耗量（需材料类型+粗度+长度+数量全部填写后才显示）
  _updateCalcWeight() {
    const { materialConsumption } = this.data
    const len = Number(materialConsumption.length)
    const rVal = Number(materialConsumption.roughness)
    const qty = Number(materialConsumption.qty)
    // 材料类型、粗度、长度、数量 四项缺一不可
    if (!materialConsumption.material || !len || !rVal || !qty || len <= 0 || rVal <= 0 || qty <= 0) {
      this.setData({ calcWeightInfo: null })
      return
    }
    const coef = getRoughnessCoefficient(rVal)
    if (!coef) {
      this.setData({ calcWeightInfo: null })
      return
    }
    // 单根重量(kg) = 长度(mm) * 粗度系数(kg/m) * 0.001 * 损耗系数1.05
    const singleWeightKg = len * 1.05 * coef * 0.001
    // 总消耗量(吨)
    const totalTons = singleWeightKg * qty / 1000
    // 当前库存(吨)
    const currentStock = getMaterialStockByRoughness(materialConsumption.material, rVal)
    // 剩余库存 = 当前库存 - 总消耗量
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

  // ===== 操作员选择器 =====
  showOperatorPicker() {
    this.setData({ showOperatorPicker: true, operatorSearchKeyword: '' })
  },

  hideOperatorPicker() {
    this.setData({ showOperatorPicker: false })
  },

  onOperatorPanelTap() {
    // 空方法，阻止事件冒泡到遮罩层
  },

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
      operatorLabel: emp.name + (getEmployeeDisplayStations(emp) ? ` · ${getEmployeeDisplayStations(emp)}` : ''),
      showOperatorPicker: false,
      operatorSearchKeyword: ''
    })
  },

  get filteredEmployees() {
    const kw = this.data.operatorSearchKeyword.toLowerCase()
    if (!kw) return this.data.activeEmployees
    return this.data.activeEmployees.filter(e =>
      e.name.toLowerCase().includes(kw) || getEmployeeDisplayStations(e).toLowerCase().includes(kw)
    )
  },

  completeStep() {
    const app = getApp()
    const { isBlankingStep, materialConsumption, note, completedQty } = this.data

    // 下料工序：校验材料消耗
    if (isBlankingStep) {
      if (!materialConsumption.material) {
        wx.showToast({ title: '请选择材料类型', icon: 'none' })
        return
      }
      const rVal = Number(materialConsumption.roughness)
      if (!materialConsumption.roughness || isNaN(rVal) || rVal < 0 || rVal > 200) {
        wx.showToast({ title: '请输入有效的粗度（0-200mm）', icon: 'none' })
        return
      }
      const len = Number(materialConsumption.length)
      if (!materialConsumption.length || isNaN(len) || len <= 0) {
        wx.showToast({ title: '请输入有效的长度（mm）', icon: 'none' })
        return
      }
      const matQty = Number(materialConsumption.qty)
      if (!materialConsumption.qty || isNaN(matQty) || matQty <= 0) {
        wx.showToast({ title: '请输入有效的消耗数量', icon: 'none' })
        return
      }
    } else {
      // 其他工序：校验处理数量
      const qty = Number(completedQty)
      if (!completedQty || isNaN(qty) || qty < 0) {
        wx.showToast({ title: '请输入有效的非负数字', icon: 'none' })
        return
      }
    }

    try {
      // 校验操作员是否已选择
      const selectedOperatorId = this.data.operatorId
      if (!selectedOperatorId) {
        wx.showToast({ title: '请选择操作员', icon: 'none' })
        return
      }

      // 下料工序：将根数换算为实际吨数后再提交（单根重量 × 根数 / 1000 = 吨）
      let submitConsumption = null
      if (isBlankingStep) {
        const len = Number(materialConsumption.length)
        const rVal = Number(materialConsumption.roughness)
        const pieces = Number(materialConsumption.qty)
        const coef = getRoughnessCoefficient(rVal) || (rVal * rVal * 0.006165)
        const calcTons = len * 1.05 * coef * 0.001 * pieces / 1000
        submitConsumption = {
          ...materialConsumption,
          calcTons: Math.round(calcTons * 10000) / 10000  // 保留4位小数
        }
      }
      const order = completeCurrentStep(
        this.orderId,
        selectedOperatorId,
        note,
        isBlankingStep ? null : completedQty,
        submitConsumption
      )
      // 完成后重新计算权限（流转后当前工序变了）
      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _s = user.stations || (user.station ? [user.station] : [])
      const canComplete = order.status !== 'completed' && (isAdmin || _s.includes(order.currentStation))
      const nextStep = order.steps[order.currentStepIndex]
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
      wx.showToast({ title: '工序已完成并流转', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  togglePause() {
    const app = getApp()
    try {
      const order = togglePause(this.orderId, !this.data.order.paused, app.globalData.currentUser.id)
      this.setData({
        order: {
          ...order,
          qrUrl: buildQrUrl(order.qrContent || order.id, 320)
        }
      })
      wx.showToast({ title: order.paused ? '已暂停' : '已恢复', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  toggleUrgent() {
    const app = getApp()
    try {
      const order = toggleOrderUrgent(this.orderId, !this.data.order.urgent, app.globalData.currentUser.id)
      this.setData({
        order: {
          ...order,
          qrUrl: buildQrUrl(order.qrContent || order.id, 320)
        }
      })
      wx.showToast({ title: order.urgent ? '已设为加急' : '已取消加急', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  enterEditSteps() {
    if (this.data.currentUser.role !== 'admin' && this.data.currentUser.role !== 'superadmin') {
      wx.showToast({ title: '只有管理员可以编辑工序', icon: 'none' })
      return
    }

    const processList = getProcessLibrary()

    // 已完成/有历史记录(员工扫码确认过)的工序不可删除，但管理员可撤回
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

  // 添加工序（支持重复添加，新添加的可删除）
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

  // 删除已选工序（只能删除未确认的工序）
  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    const step = this.data.selectedSteps.find(s => s.instanceId === instanceId)

    if (step && !step.canDelete) {
      wx.showToast({ title: '该工序已完成，无法删除', icon: 'none' })
      return
    }

    const newSelectedSteps = this.data.selectedSteps.filter((s) => s.instanceId !== instanceId)
    this.setData({
      selectedSteps: newSelectedSteps,
      selectedStepKeys: newSelectedSteps.map((s) => s.key)
    })
  },

  // 撤回已完成的工序（仅管理员可操作）
  revertStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    const step = this.data.selectedSteps.find(s => s.instanceId === instanceId)
    if (!step || !step.canRevert) return

    wx.showModal({
      title: '确认撤回',
      content: `确定要撤回「${step.name}」吗？该工序的完成记录将被移除，当前工序将回退到此步骤。`,
      confirmColor: '#e53935',
      success: (res) => {
        if (!res.confirm) return

        const app = getApp()
        try {
          const updatedOrder = revertCompletedStep(this.orderId, step.key, app.globalData.currentUser.id)
          const user = app.globalData.currentUser
          const isAdmin = user.role === 'admin' || user.role === 'superadmin'
          const _s1 = user.stations || (user.station ? [user.station] : [])
          const canComplete = updatedOrder.status !== 'completed' && (isAdmin || _s1.includes(updatedOrder.currentStation))
          // 撤回后重新判断当前是否为下料工序
          const revertedStep = updatedOrder.steps[updatedOrder.currentStepIndex]
          const isBlankingAfterRevert = revertedStep && revertedStep.key === 'blanking'
          const autoLengthAfterRevert = (isBlankingAfterRevert && updatedOrder.drawingDetail && updatedOrder.drawingDetail.length) ? updatedOrder.drawingDetail.length : ''

          this.setData({
            order: {
              ...updatedOrder,
              qrUrl: buildQrUrl(updatedOrder.qrContent || updatedOrder.id, 320)
            },
            editingSteps: false,
            selectedSteps: updatedOrder.steps,
            selectedStepKeys: updatedOrder.steps.map(s => s.key),
            isAdmin,
            canComplete,
            isBlankingStep: isBlankingAfterRevert,
            materialConsumption: isBlankingAfterRevert ? { material: '', roughness: '', length: autoLengthAfterRevert, qty: '' } : this.data.materialConsumption
          })
          if (isBlankingAfterRevert) {
            this._updateCalcWeight()
          } else {
            if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
          }
          wx.showToast({ title: '已撤回工序', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  },

  saveStepChanges() {
    const app = getApp()
    try {
      const { selectedSteps, order } = this.data
      if (selectedSteps.length === 0) {
        wx.showToast({ title: '至少需要一个工序', icon: 'none' })
        return
      }

      const selectedStepKeys = selectedSteps.map((s) => s.key)
      const updatedOrder = updateOrderStepKeys(this.orderId, selectedStepKeys, app.globalData.currentUser.id)

      // 保存工序后重新计算权限和当前步骤类型
      const user = app.globalData.currentUser
      const isAdmin = user.role === 'admin' || user.role === 'superadmin'
      const _s2 = user.stations || (user.station ? [user.station] : [])
      const canComplete = updatedOrder.status !== 'completed' && (isAdmin || _s2.includes(updatedOrder.currentStation))
      const currentStepAfterSave = updatedOrder.steps[updatedOrder.currentStepIndex]
      const isBlankingAfterSave = currentStepAfterSave && currentStepAfterSave.key === 'blanking'
      const autoLengthAfterSave = (isBlankingAfterSave && updatedOrder.drawingDetail && updatedOrder.drawingDetail.length) ? updatedOrder.drawingDetail.length : ''

      this.setData({
        order: {
          ...updatedOrder,
          qrUrl: buildQrUrl(updatedOrder.qrContent || updatedOrder.id, 320)
        },
        editingSteps: false,
        selectedSteps: updatedOrder.steps,
        selectedStepKeys: updatedOrder.steps.map(s => s.key),
        isAdmin,
        canComplete,
        isBlankingStep: isBlankingAfterSave,
        materialConsumption: isBlankingAfterSave ? { material: '', roughness: '', length: autoLengthAfterSave, qty: '' } : this.data.materialConsumption
      })

      if (isBlankingAfterSave) {
        this._updateCalcWeight()
      } else {
        if (this.data.calcWeightInfo) this.setData({ calcWeightInfo: null })
      }

      wx.showToast({ title: '工序已更新', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  }
})
