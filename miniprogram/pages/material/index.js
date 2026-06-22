const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    currentUser: null,
    isAdmin: false,
    inventory: [],
    logs: [],
    showInboundModal: false,
    inboundForm: { material: '', roughness: '', qty: '', note: '' },
    showSetStockModal: false,
    setStockForm: { material: '', roughness: '', stock: '', note: '' },
    showAddMaterialModal: false,
    addMaterialName: '',
    showOutboundModal: false,
    outboundForm: { material: '', roughness: '', qty: '', note: '' }
  },

  onLoad() {
    this._load()
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    if (!this.data.showInboundModal && !this.data.showSetStockModal && !this.data.showAddMaterialModal && !this.data.showOutboundModal) {
      this.refresh()
    }
  },

  async _load() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const user = app.globalData.currentUser
    const isAdmin = user.role === 'admin' || user.role === 'superadmin'
    this.setData({ currentUser: user, isAdmin })
    this.refresh()
  },

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const [inventory, logs] = await Promise.all([
        api.getMaterialInventory(),
        api.getMaterialLogs()
      ])
      const fmtInv = (inventory || []).map(item => ({
        ...item,
        stock: Math.round(item.stock * 1000) / 1000,
        detail: (item.detail || []).map(d => ({ ...d, stock: Math.round(d.stock * 1000) / 1000 }))
      }))
      const fmtLogs = (logs || []).map(item => ({ ...item, qty: Math.round(Number(item.qty) * 1000) / 1000, operator: api.cleanName(item.operator, '操作员') }))
      const totalStock = Math.round(fmtInv.reduce((sum, item) => sum + item.stock, 0) * 1000) / 1000
      const materialTypes = fmtInv.length
      const lowCount = fmtInv.filter(item => item.hasLowRoughness).length
      this.setData({ inventory: fmtInv, logs: fmtLogs, totalStock, materialTypes, lowCount })
    } catch (e) {
      ui.handleError(e, '加载库存失败')
    } finally {
      ui.hideLoading()
    }
  },

  openInboundModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({ showInboundModal: true, inboundForm: { material, roughness: '', qty: '', note: '' } })
  },

  closeInboundModal() {
    this.setData({ showInboundModal: false })
    setTimeout(() => this.refresh(), 300)
  },

  bindInboundQty(event) { this.setData({ inboundForm: { ...this.data.inboundForm, qty: event.detail.value } }) },
  bindInboundRoughness(event) { this.setData({ inboundForm: { ...this.data.inboundForm, roughness: event.detail.value } }) },
  bindInboundNote(event) { this.setData({ inboundForm: { ...this.data.inboundForm, note: event.detail.value } }) },

  async submitInbound() {
    const { material, roughness, qty, note } = this.data.inboundForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      ui.toast('请输入有效的粗度（0-200mm）'); return
    }
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      ui.toast('请输入有效的入库数量'); return
    }
    try {
      await api.addMaterialStock(material, Number(qty), note, String(roughness))
      this.setData({ showInboundModal: false })
      setTimeout(() => this.refresh(), 300)
      ui.toast('入库成功', 'success')
    } catch (e) {
      ui.handleError(e, '入库失败')
    }
  },

  openSetStockModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({ showSetStockModal: true, setStockForm: { material, roughness: '', stock: '', note: '' } })
  },

  closeSetStockModal() {
    this.setData({ showSetStockModal: false })
    setTimeout(() => this.refresh(), 300)
  },

  bindSetStockValue(event) { this.setData({ setStockForm: { ...this.data.setStockForm, stock: event.detail.value } }) },
  bindSetStockRoughness(event) { this.setData({ setStockForm: { ...this.data.setStockForm, roughness: event.detail.value } }) },
  bindSetStockNote(event) { this.setData({ setStockForm: { ...this.data.setStockForm, note: event.detail.value } }) },

  async submitSetStock() {
    const { material, roughness, stock, note } = this.data.setStockForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      ui.toast('请输入有效的粗度（0-200mm）'); return
    }
    if (stock === '' || isNaN(Number(stock)) || Number(stock) < 0) {
      ui.toast('请输入有效的库存数量'); return
    }
    try {
      await api.setMaterialStock(material, Number(stock), note, String(roughness))
      this.setData({ showSetStockModal: false })
      setTimeout(() => this.refresh(), 300)
      ui.toast('设置成功', 'success')
    } catch (e) {
      ui.handleError(e, '设置失败')
    }
  },

  openAddMaterialModal() {
    this.setData({ showAddMaterialModal: true, addMaterialName: '' })
  },

  closeAddMaterialModal() {
    this.setData({ showAddMaterialModal: false })
  },

  bindAddMaterialName(event) { this.setData({ addMaterialName: event.detail.value }) },

  async submitAddMaterial() {
    const name = (this.data.addMaterialName || '').trim()
    if (!name) { ui.toast('请输入材料名称'); return }
    try {
      await api.addMaterialType(name)
      this.setData({ showAddMaterialModal: false })
      setTimeout(() => this.refresh(), 300)
      ui.toast('已新增材料：' + name, 'success')
    } catch (e) {
      ui.handleError(e, '新增失败')
    }
  },

  openOutboundModal(event) {
    const material = event.currentTarget.dataset.material
    this.setData({ showOutboundModal: true, outboundForm: { material, roughness: '', qty: '', note: '' } })
  },

  closeOutboundModal() {
    this.setData({ showOutboundModal: false })
    setTimeout(() => this.refresh(), 300)
  },

  bindOutboundRoughness(event) { this.setData({ outboundForm: { ...this.data.outboundForm, roughness: event.detail.value } }) },
  bindOutboundQty(event) { this.setData({ outboundForm: { ...this.data.outboundForm, qty: event.detail.value } }) },
  bindOutboundNote(event) { this.setData({ outboundForm: { ...this.data.outboundForm, note: event.detail.value } }) },

  async submitOutbound() {
    const { material, roughness, qty, note } = this.data.outboundForm
    if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
      ui.toast('请输入有效的粗度（0-200mm）'); return
    }
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      ui.toast('请输入有效的出库数量'); return
    }
    try {
      await api.deductMaterialStock(material, Number(qty), note || '直接出库（零售/损耗）', '', String(roughness))
      this.setData({ showOutboundModal: false })
      setTimeout(() => this.refresh(), 300)
      ui.toast('出库成功', 'success')
    } catch (e) {
      ui.handleError(e, '出库失败')
    }
  },

  goHome() { wx.switchTab({ url: '/pages/home/index' }) },
  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },
  preventClose() { /* 阻止冒泡 */ }
})
