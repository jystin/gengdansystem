const api = require('../../utils/api')
const ui = require('../../utils/ui')

function emptyForm() {
  return {
    customerName: '',
    type: '',
    size: '',
    qty: '',
    material: '',
    dueDate: '',
    singleNo: '',
    urgent: null,
    isReorder: null,
    drawings: [],
    drawingDetail: {
      blankingRoughness: '',
      productRoughness: '',
      length: '',
      topHoleThread: '',
      topHole: '',
      crossHole: '',
      squareHead: ''
    },
    selectedStepKeys: []
  }
}

Page({
  data: {
    currentUser: { role: '', status: 'active' },
    form: emptyForm(),
    createdOrderId: '',
    processList: [],
    selectedSteps: [],
    showCopyModal: false,
    copyOrders: []
  },

  async onLoad() {
    await this._init()
  },

  async _init() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      ui.toast('只有管理员可创建工单')
      wx.redirectTo({ url: '/pages/home/index' })
      return
    }
    try {
      ui.showLoading('加载中...')
      const [processList, orders] = await Promise.all([
        Promise.resolve(api.getProcessLibrary()),
        api.listOrders(1, 100).catch(() => [])
      ])
      this.setData({
        currentUser,
        processList,
        copyOrders: orders || [],
        selectedSteps: [],
        form: { ...emptyForm(), selectedStepKeys: [] }
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onShow() { /* 避免图片上传时表单被重置 */ },

  chooseDrawing() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const drawings = (this.data.form.drawings || []).concat(
          res.tempFiles.map((file, index) => ({
            name: `drawing_${Date.now()}_${index}`,
            tempFilePath: file.tempFilePath,
            type: file.type || 'image',
            size: file.size
          }))
        )
        this.setData({ form: { ...this.data.form, drawings } })
      }
    })
  },

  removeDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    const drawings = this.data.form.drawings.filter((_, i) => i !== index)
    this.setData({ form: { ...this.data.form, drawings } })
  },

  toggleIsReorder() {
    this.setData({
      form: { ...this.data.form, isReorder: !this.data.form.isReorder }
    })
  },

  bindField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({
      form: { ...this.data.form, [field]: value }
    })
  },

  bindDueDate(event) {
    this.setData({ form: { ...this.data.form, dueDate: event.detail.value } })
  },

  setUrgent(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({ form: { ...this.data.form, urgent: value } })
  },

  setIsReorder(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({ form: { ...this.data.form, isReorder: value } })
  },

  bindSubField(event) {
    const field = event.currentTarget.dataset.field
    const sub = event.currentTarget.dataset.sub
    const value = event.detail.value
    this.setData({
      form: {
        ...this.data.form,
        [sub]: { ...(this.data.form[sub] || {}), [field]: value }
      }
    })
  },

  setDrawingDetailBool(event) {
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({
      form: {
        ...this.data.form,
        drawingDetail: { ...(this.data.form.drawingDetail || {}), [key]: value }
      }
    })
  },

  addStep(event) {
    const stepKey = event.currentTarget.dataset.key
    const step = this.data.processList.find((p) => p.key === stepKey)
    if (!step) return
    const form = this.data.form
    const newSelectedSteps = [...this.data.selectedSteps, { ...step, instanceId: `${stepKey}_${Date.now()}` }]
    this.setData({
      selectedSteps: newSelectedSteps,
      form: { ...form, selectedStepKeys: newSelectedSteps.map((s) => s.key) }
    })
  },

  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    const form = this.data.form
    const newSelectedSteps = this.data.selectedSteps.filter((s) => s.instanceId !== instanceId)
    this.setData({
      selectedSteps: newSelectedSteps,
      form: { ...form, selectedStepKeys: newSelectedSteps.map((s) => s.key) }
    })
  },

  async submit() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      ui.toast('只有管理员可创建工单')
      return
    }
    const form = this.data.form
    const missing = []
    if (!form.customerName) missing.push('客户名称')
    if (!form.type) missing.push('种类')
    if (!form.size) missing.push('尺寸')
    if (!form.qty) missing.push('数量')
    if (!form.material) missing.push('材质')
    if (!form.dueDate) missing.push('交货期')
    if (!form.singleNo) missing.push('单号')
    if (!form.drawings || form.drawings.length === 0) missing.push('图纸')
    if (form.urgent !== true && form.urgent !== false) missing.push('是否急要')
    if (form.isReorder !== true && form.isReorder !== false) missing.push('是否补单')
    if (!form.selectedStepKeys || form.selectedStepKeys.length === 0) missing.push('工序配置')
    if (missing.length > 0) {
      ui.toast('请填写：' + missing.join('、'), 'none', 2500)
      return
    }

    try {
      ui.showLoading('上传图纸中...')
      // 上传图纸到云存储
      const drawings = []
      for (const d of (form.drawings || [])) {
        if (d.tempFilePath) {
          try {
            const ext = (d.tempFilePath.match(/\.(\w+)$/) || [])[1] || 'jpg'
            const cloudPath = `drawings/${form.singleNo || 'order'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
            const up = await wx.cloud.uploadFile({ cloudPath, filePath: d.tempFilePath })
            drawings.push({
              name: d.name,
              fileID: up.fileID,
              cloudPath: up.fileID,
              type: d.type || 'image'
            })
          } catch (e) {
            // 上传失败的图纸保留本地引用，避免阻断
            drawings.push({ name: d.name, tempFilePath: d.tempFilePath, type: d.type || 'image' })
          }
        } else {
          drawings.push(d)
        }
      }

      ui.showLoading('创建工单中...')
      const result = await api.createOrder({
        customerName: form.customerName,
        type: form.type,
        size: form.size,
        qty: Number(form.qty),
        material: form.material,
        dueDate: form.dueDate,
        singleNo: form.singleNo,
        urgent: !!form.urgent,
        isReorder: !!form.isReorder,
        drawings,
        stepKeys: form.selectedStepKeys,
        drawingDetail: form.drawingDetail,
        remarks: form.remarks || ''
      })

      const order = result && result.order ? result.order : result
      this.setData({ form: emptyForm(), createdOrderId: order.id || '' })
      ui.hideLoading()
      ui.toast('工单创建成功', 'success')
      if (order.id) {
        wx.navigateTo({ url: `/pages/order-detail/index?id=${order.id}` })
      }
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '创建工单失败')
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  async openCopyModal() {
    try {
      const orders = await api.listOrders(1, 100)
      this.setData({ showCopyModal: true, copyOrders: orders || [] })
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    }
  },

  closeCopyModal() {
    this.setData({ showCopyModal: false })
  },

  loadFromOrder(event) {
    const orderId = event.currentTarget.dataset.id
    const order = this.data.copyOrders.find((o) => o.id === orderId)
    if (!order) return
    const selectedSteps = (order.stepKeys || []).map((key) => {
      const proc = this.data.processList.find((p) => p.key === key)
      return proc ? { ...proc, instanceId: key + '_' + Date.now() } : null
    }).filter(Boolean)

    this.setData({
      form: {
        ...emptyForm(),
        customerName: order.customerName || '',
        type: order.type || '',
        size: order.size || '',
        qty: order.qty !== undefined ? String(order.qty) : '',
        material: order.material || '',
        dueDate: order.dueDate || '',
        singleNo: '',
        drawings: [],
        drawingDetail: {
          blankingRoughness: order.drawingDetail?.blankingRoughness || order.drawingDetail?.roughness || '',
          productRoughness: order.drawingDetail?.productRoughness || order.drawingDetail?.bossRoughness || '',
          length: order.drawingDetail?.length || '',
          topHoleThread: order.drawingDetail?.topHoleThread || order.drawingDetail?.thread || '',
          topHole: order.drawingDetail?.topHole || order.drawingDetail?.hasHole || '',
          crossHole: order.drawingDetail?.crossHole || order.drawingDetail?.markText || '',
          squareHead: order.drawingDetail?.squareHead || ''
        },
        urgent: null,
        isReorder: null,
        selectedStepKeys: order.stepKeys || []
      },
      selectedSteps,
      showCopyModal: false
    })
    ui.toast('已读取：' + orderId, 'none')
  }
})
