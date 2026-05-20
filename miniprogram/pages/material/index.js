const { getMaterialInventory, addMaterialStock, setMaterialStock, getMaterialLogs, MATERIAL_TYPES, addMaterialType, deductMaterialStock } = require('../../utils/mock-store')

Page({
  data: {
    currentUser: null,
    isAdmin: false,
    inventory: [],
    logs: [],
    showInboundModal: false,
    inboundForm: {
      material: '',
      roughness: '',
      qty: '',
      note: ''
    },
    showSetStockModal: false,
    setStockForm: {
      material: '',
      roughness: '',
      stock: '',
      note: ''
    },
    showAddMaterialModal: false,
    addMaterialName: '',
    showOutboundModal: false,
    outboundForm: {
      material: '',
      roughness: '',
      qty: '',
      note: ''
    }
  },

  onLoad() {
    this._load()
  },

  onShow() {
    // 弹窗打开期间不刷新数据，防止键盘弹出导致输入框失焦
    if (!this.data.showInboundModal && !this.data.showSetStockModal && !this.data.showAddMaterialModal && !this.data.showOutboundModal) {
      this.refresh()
    }
  },

  _load() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const user = app.globalData.currentUser
    const isAdmin = user.role === 'admin' || user.role === 'superadmin'
    this.setData({ currentUser: user, isAdmin })
    this.refresh()
  },

  refresh() {
    const inventory = getMaterialInventory()
    const logs = getMaterialLogs()
    // 格式化库存数据，保留3位小数
    const fmtInv = inventory.map(item => ({
      ...item,
      stock: Math.round(item.stock * 1000) / 1000,
      detail: (item.detail || []).map(d => ({ ...d, stock: Math.round(d.stock * 1000) / 1000 }))
    }))
    // 操作记录中的数量也保留3位小数
    const fmtLogs = logs.map(item => ({ ...item, qty: Math.round(Number(item.qty) * 1000) / 1000 }))
    const totalStock = Math.round(fmtInv.reduce((sum, item) => sum + item.stock, 0) * 1000) / 1000
    const materialTypes = inventory.length
    // lowCount 基于 hasLowRoughness（任一粗度低于该材料阈值即算不足）
    const lowCount = fmtInv.filter(item => item.hasLowRoughness).length
    this.setData({ inventory: fmtInv, logs: fmtLogs, totalStock, materialTypes, lowCount })
  },

  openInboundModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({
      showInboundModal: true,
      inboundForm: { material, roughness: '', qty: '', note: '' }
    })
  },

  closeInboundModal() {
    this.setData({ showInboundModal: false })
    // 延迟刷新，等弹窗动画结束后再更新数据
    setTimeout(() => this.refresh(), 300)
  },

  bindInboundQty(event) {
    this.setData({
      inboundForm: { ...this.data.inboundForm, qty: event.detail.value }
    })
  },

  bindInboundRoughness(event) {
    this.setData({
      inboundForm: { ...this.data.inboundForm, roughness: event.detail.value }
    })
  },

  bindInboundNote(event) {
    this.setData({
      inboundForm: { ...this.data.inboundForm, note: event.detail.value }
    })
  },

  submitInbound() {
    const { material, roughness, qty, note } = this.data.inboundForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      wx.showToast({ title: '请输入有效的粗度（0-200mm）', icon: 'none' })
      return
    }
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      wx.showToast({ title: '请输入有效的入库数量', icon: 'none' })
      return
    }

    const app = getApp()
    try {
      addMaterialStock(material, Number(qty), app.globalData.currentUser.id, note, roughness)
      this.setData({ showInboundModal: false })
      // 延迟刷新，等弹窗关闭后再更新数据
      setTimeout(() => this.refresh(), 300)
      wx.showToast({ title: '入库成功', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  openSetStockModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({
      showSetStockModal: true,
      setStockForm: { material, roughness: '', stock: '', note: '' }
    })
  },

  closeSetStockModal() {
    this.setData({ showSetStockModal: false })
    setTimeout(() => this.refresh(), 300)
  },

  bindSetStockValue(event) {
    this.setData({
      setStockForm: { ...this.data.setStockForm, stock: event.detail.value }
    })
  },

  bindSetStockRoughness(event) {
    this.setData({
      setStockForm: { ...this.data.setStockForm, roughness: event.detail.value }
    })
  },

  bindSetStockNote(event) {
    this.setData({
      setStockForm: { ...this.data.setStockForm, note: event.detail.value }
    })
  },

  submitSetStock() {
    const { material, roughness, stock, note } = this.data.setStockForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      wx.showToast({ title: '请输入有效的粗度（0-200mm）', icon: 'none' })
      return
    }
    if (stock === '' || isNaN(Number(stock)) || Number(stock) < 0) {
      wx.showToast({ title: '请输入有效的库存数量', icon: 'none' })
      return
    }

    const app = getApp()
    try {
      setMaterialStock(material, Number(stock), app.globalData.currentUser.id, note, roughness)
      this.setData({ showSetStockModal: false })
      setTimeout(() => this.refresh(), 300)
      wx.showToast({ title: '设置成功', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  openAddMaterialModal() {
    this.setData({ showAddMaterialModal: true, addMaterialName: '' })
  },

  closeAddMaterialModal() {
    this.setData({ showAddMaterialModal: false })
  },

  bindAddMaterialName(event) {
    this.setData({ addMaterialName: event.detail.value })
  },

  submitAddMaterial() {
    const name = this.data.addMaterialName
    if (!name || !name.trim()) {
      wx.showToast({ title: '请输入材料名称', icon: 'none' })
      return
    }
    const app = getApp()
    try {
      addMaterialType(name.trim(), app.globalData.currentUser.id)
      this.setData({ showAddMaterialModal: false })
      setTimeout(() => this.refresh(), 300)
      wx.showToast({ title: '已新增材料：' + name.trim(), icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  openOutboundModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({
      showOutboundModal: true,
      outboundForm: { material, roughness: '', qty: '', note: '' }
    })
  },

  closeOutboundModal() {
    this.setData({ showOutboundModal: false })
    setTimeout(() => this.refresh(), 300)
  },

  bindOutboundRoughness(event) {
    this.setData({
      outboundForm: { ...this.data.outboundForm, roughness: event.detail.value }
    })
  },

  bindOutboundQty(event) {
    this.setData({
      outboundForm: { ...this.data.outboundForm, qty: event.detail.value }
    })
  },

  bindOutboundNote(event) {
    this.setData({
      outboundForm: { ...this.data.outboundForm, note: event.detail.value }
    })
  },

  submitOutbound() {
    const { material, roughness, qty, note } = this.data.outboundForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      wx.showToast({ title: '请输入有效的粗度（0-200mm）', icon: 'none' })
      return
    }
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      wx.showToast({ title: '请输入有效的出库数量', icon: 'none' })
      return
    }

    const app = getApp()
    try {
      deductMaterialStock(material, Number(qty), app.globalData.currentUser.id, note || '直接出库（零售/损耗）', '', roughness)
      this.setData({ showOutboundModal: false })
      setTimeout(() => this.refresh(), 300)
      wx.showToast({ title: '出库成功', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  preventClose() {
    // 阻止点击事件冒泡到遮罩层
  }
})
