const api = require('../../utils/api')
const ui = require('../../utils/ui')

function emptyCreateForm() {
  return {
    factory: '',
    customer: '',
    orderDate: '',
    dueDate: '',
    model: '',
    material: '',
    qty: '',
    batchNo: '',
    drawingsText: '',
    remarks: '',
    urgent: false,
    drawingDetail: {
      blankingRoughness: '',
      productRoughness: '',
      length: '',
      topHoleThread: '',
      topHole: '',
      crossHole: '',
      squareHead: ''
    }
  }
}

function emptyInviteForm() {
  return {
    name: '',
    station: '',
    stations: [],
    roleIndex: 0,
    note: ''
  }
}

Page({
  data: {
    currentUser: { role: '', status: 'active' },
    dashboard: {},
    orders: [],
    employees: [],
    pendingEmployees: [],
    logs: [],
    roleOptions: [],
    joinInvitePath: '',
    joinQRFileID: '',
    createForm: emptyCreateForm(),
    inviteForm: emptyInviteForm(),
    employeePanelOpen: false
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      this.setData({ currentUser: null })
      ui.toast('仅管理员可访问管理中心')
      return
    }
    const roleOptions = currentUser.role === 'superadmin' ? ['worker', 'admin'] : ['worker']

    try {
      ui.showLoading('加载中...')
      const [dashboard, orders, employees, logs] = await Promise.all([
        api.getDashboard(),
        api.listOrders(1, 100).catch(() => []),
        api.listEmployees().catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
      const cleanedEmployees = (employees || []).map(e => {
        const nameFallback = (currentUser.id && e.id === currentUser.id && currentUser.name)
          ? currentUser.name : '员工'
        return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role), statusLabel: api.statusLabel(e.status) }
      })
      const pendingEmployees = cleanedEmployees.filter((employee) => employee.status === 'pending')
      let joinInvitePath = ''
      let joinQRFileID = ''
      try {
        const qr = await api.generateJoinQRCode(false)
        if (qr && qr.success) {
          joinInvitePath = qr.invitePath || ''
          joinQRFileID = qr.fileID || ''
        }
      } catch (e) { /* 静默 */ }

      this.setData({
        currentUser,
        dashboard: dashboard || {},
        orders: (orders || []).slice(0, 8),
        employees: cleanedEmployees,
        pendingEmployees,
        logs: (logs || []).slice(0, 12).map(api.normalizeLog).filter(Boolean),
        roleOptions,
        joinInvitePath,
        joinQRFileID,
        inviteForm: {
          ...this.data.inviteForm,
          roleIndex: Math.min(this.data.inviteForm.roleIndex, roleOptions.length - 1)
        }
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  goHome() { wx.navigateBack({ delta: 1 }) },
  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },
  goProfile() { wx.navigateTo({ url: '/pages/profile/index' }) },
  goScan() { wx.navigateTo({ url: '/pages/scan/index' }) },
  goMaterial() { wx.navigateTo({ url: '/pages/material/index' }) },

  goJoinPage() {
    if (this.data.joinInvitePath) {
      wx.navigateTo({ url: this.data.joinInvitePath })
    }
  },

  copyJoinInvite() {
    const path = this.data.joinInvitePath
    if (!path) { ui.toast('入驻链接生成中'); return }
    wx.setClipboardData({
      data: path,
      success: () => { ui.toast('入驻链接已复制', 'none') }
    })
  },

  async refreshJoinQR() {
    try {
      ui.showLoading('生成中...')
      const qr = await api.generateJoinQRCode(true)
      if (qr && qr.success) {
        this.setData({ joinInvitePath: qr.invitePath || '', joinQRFileID: qr.fileID || '' })
        ui.toast('已刷新', 'success')
      } else {
        ui.toast('生成失败')
      }
    } catch (e) {
      ui.handleError(e, '生成失败')
    } finally {
      ui.hideLoading()
    }
  },

  goCreateOrder() { wx.navigateTo({ url: '/pages/create-order/index' }) },
  goOrdersByCategory(event) {
    const category = event.currentTarget.dataset.category
    wx.navigateTo({ url: `/pages/orders/index?category=${category}` })
  },
  openOrder(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  bindCreateField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({ createForm: { ...this.data.createForm, [field]: value } })
  },

  toggleUrgent(event) {
    this.setData({ createForm: { ...this.data.createForm, urgent: event.detail.value } })
  },

  async submitCreateOrder() {
    const app = getApp()
    try {
      const form = this.data.createForm
      if (!form.factory || !form.customer || !form.dueDate || !form.model || !form.material || !form.qty) {
        ui.toast('请先补全工单信息'); return
      }
      const drawings = (form.drawingsText || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
        .map((name) => ({ name, type: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image' }))
      const result = await api.createOrder({
        customerName: form.customer,
        factory: form.factory,
        orderDate: form.orderDate,
        dueDate: form.dueDate,
        type: form.model,
        size: form.size || '',
        qty: Number(form.qty),
        material: form.material,
        singleNo: form.batchNo,
        urgent: !!form.urgent,
        isReorder: false,
        drawings,
        drawingDetail: form.drawingDetail,
        remarks: form.remarks,
        stepKeys: ['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse']
      })
      this.setData({ createForm: emptyCreateForm() })
      await this.onShow()
      ui.toast('工单已创建', 'success')
    } catch (e) {
      ui.handleError(e, '创建失败')
    }
  },

  bindInviteField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({ inviteForm: { ...this.data.inviteForm, [field]: value } })
  },

  bindInviteRole(event) {
    this.setData({ inviteForm: { ...this.data.inviteForm, roleIndex: Number(event.detail.value) } })
  },

  async submitInvite() {
    if (!this.data.inviteForm.name || !this.data.inviteForm.station) {
      ui.toast('请填写姓名和岗位'); return
    }
    const role = this.data.roleOptions[this.data.inviteForm.roleIndex] || 'worker'
    try {
      await api.inviteEmployee({
        name: this.data.inviteForm.name,
        station: this.data.inviteForm.station,
        stations: this.data.inviteForm.stations.length > 0 ? this.data.inviteForm.stations : [this.data.inviteForm.station],
        role,
        note: this.data.inviteForm.note
      })
      this.setData({ inviteForm: emptyInviteForm() })
      await this.onShow()
      ui.toast('已创建待审批账号', 'success')
    } catch (e) {
      ui.handleError(e, '创建失败')
    }
  },

  async approveEmployee(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.approveEmployee(id)
      await this.onShow()
      ui.toast('已通过审批', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async rejectEmployee(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.rejectEmployee(id)
      await this.onShow()
      ui.toast('已驳回', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async deleteEmployee(event) {
    const { id } = event.currentTarget.dataset
    const target = this.data.employees.find((employee) => employee.id === id)
    const ok = await ui.confirm(`确定要删除 ${target ? target.name : '该员工'} 吗？`, '确认删除')
    if (!ok) return
    try {
      await api.deleteEmployee(id)
      await this.onShow()
      ui.toast('已删除', 'none')
    } catch (e) {
      ui.handleError(e, '删除失败')
    }
  },

  async promoteToAdmin(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.updateEmployeeRole(id, 'admin')
      await this.onShow()
      ui.toast('已设为管理员', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async demoteToWorker(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.updateEmployeeRole(id, 'worker')
      await this.onShow()
      ui.toast('已取消管理员权限', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  toggleEmployeePanel() {
    this.setData({ employeePanelOpen: !this.data.employeePanelOpen })
  },

  onShareAppMessage() {
    return {
      title: '兴祥机械跟单系统入驻申请',
      path: this.data.joinInvitePath || '/pages/join/index'
    }
  }
})
