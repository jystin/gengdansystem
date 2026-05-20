const { createOrder, getProcessLibrary, listOrders } = require('../../utils/mock-store')

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

  onLoad() {
    this._init()
  },

  _init() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      wx.showToast({ title: '只有管理员可创建工单', icon: 'none' })
      wx.redirectTo({ url: '/pages/home/index' })
      return
    }

    const processList = getProcessLibrary()
    // 加载订单列表用于"从已有工单读取"
    const copyOrders = listOrders()

    this.setData({
      currentUser,
      processList,
      copyOrders,
      selectedSteps: [],
      form: {
        ...emptyForm(),
        selectedStepKeys: []
      }
    })
  },
  
  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onShow() {
    // 不再每次 onShow 都重置表单，避免上传图片时表单被清空
  },

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
      form: {
        ...this.data.form,
        isReorder: !this.data.form.isReorder
      }
    })
  },

  bindField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({
      form: {
        ...this.data.form,
        [field]: value
      }
    })
  },

  bindDueDate(event) {
    this.setData({
      form: {
        ...this.data.form,
        dueDate: event.detail.value
      }
    })
  },

  setUrgent(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({
      form: {
        ...this.data.form,
        urgent: value
      }
    })
  },

  setIsReorder(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({
      form: {
        ...this.data.form,
        isReorder: value
      }
    })
  },

  // 嵌套对象字段绑定（如 drawingDetail.roughness）
  bindSubField(event) {
    const field = event.currentTarget.dataset.field
    const sub = event.currentTarget.dataset.sub
    const value = event.detail.value
    this.setData({
      form: {
        ...this.data.form,
        [sub]: {
          ...(this.data.form[sub] || {}),
          [field]: value
        }
      }
    })
  },

  // drawingDetail 的布尔字段切换
  setDrawingDetailBool(event) {
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({
      form: {
        ...this.data.form,
        drawingDetail: {
          ...(this.data.form.drawingDetail || {}),
          [key]: value
        }
      }
    })
  },

  // 添加工序（支持重复添加）
  addStep(event) {
    const stepKey = event.currentTarget.dataset.key
    const step = this.data.processList.find((p) => p.key === stepKey)
    if (!step) return

    const form = this.data.form
    const newSelectedSteps = [...this.data.selectedSteps, { ...step, instanceId: `${stepKey}_${Date.now()}` }]

    this.setData({
      selectedSteps: newSelectedSteps,
      form: {
        ...form,
        selectedStepKeys: newSelectedSteps.map((s) => s.key)
      }
    })
  },

  // 删除已选工序（支持删除重复工序的单个实例）
  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    const form = this.data.form
    const newSelectedSteps = this.data.selectedSteps.filter((s) => s.instanceId !== instanceId)
    this.setData({
      selectedSteps: newSelectedSteps,
      form: {
        ...form,
        selectedStepKeys: newSelectedSteps.map((s) => s.key)
      }
    })
  },

  submit() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      wx.showToast({ title: '只有管理员可创建工单', icon: 'none' })
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
      wx.showToast({ title: '请填写：' + missing.join('、'), icon: 'none', duration: 2500 })
      return
    }

    try {
      const order = createOrder(
        {
          ...form,
          stepKeys: form.selectedStepKeys,
          drawings: form.drawings
        },
        currentUser.id
      )

      this.setData({
        form: emptyForm(),
        createdOrderId: order.id
      })

      wx.showToast({ title: '工单创建成功', icon: 'success' })
      wx.navigateTo({ url: `/pages/order-detail/index?id=${order.id}` })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  // 打开从已有工单读取弹窗
  openCopyModal() {
    const copyOrders = listOrders()
    this.setData({ showCopyModal: true, copyOrders })
  },

  // 关闭弹窗
  closeCopyModal() {
    this.setData({ showCopyModal: false })
  },

  // 从已有工单读取信息填充表单
  loadFromOrder(event) {
    const orderId = event.currentTarget.dataset.id
    const order = this.data.copyOrders.find((o) => o.id === orderId)
    if (!order) return

    // 从工序库中还原已选工序
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

    wx.showToast({ title: '已读取：' + orderId, icon: 'none' })
  }
})
