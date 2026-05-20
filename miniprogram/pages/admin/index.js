const {
  getDashboard,
  listEmployees,
  listOrders,
  listLogs,
  createOrder,
  getSystemJoinInviteCode,
  getSystemJoinPath,
  inviteEmployee,
  approveEmployee,
  rejectEmployee,
  deleteEmployee,
  updateEmployeeRole
} = require('../../utils/mock-store')

function emptyCreateForm() {
  return {
    factory: '',
    customer: '',
    orderDate: '2026-05-16',
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
    joinInviteCode: '',
    joinInvitePath: '',
    createForm: emptyCreateForm(),
    inviteForm: emptyInviteForm(),
    employeePanelOpen: false
  },

  onShow() {
    const app = getApp()
    if (!app.requireActiveAccess('/pages/scan/index')) {
      return
    }
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      this.setData({ currentUser: null })
      wx.showToast({ title: '仅管理员可访问管理中心', icon: 'none' })
      return
    }
    const roleOptions = currentUser.role === 'superadmin' ? ['worker', 'admin'] : ['worker']
    const joinInviteCode = getSystemJoinInviteCode()
    const joinInvitePath = getSystemJoinPath()
    this.setData({
      currentUser,
      dashboard: getDashboard(),
      orders: listOrders().slice(0, 8),
      employees: listEmployees(),
      pendingEmployees: listEmployees().filter((employee) => employee.status === 'pending'),
      logs: listLogs().slice(0, 12),
      roleOptions,
      joinInviteCode,
      joinInvitePath,
      inviteForm: {
        ...this.data.inviteForm,
        roleIndex: Math.min(this.data.inviteForm.roleIndex, roleOptions.length - 1)
      }
    })
  },

  goHome() {
    wx.navigateBack({ delta: 1 })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  },

  goMaterial() {
    wx.navigateTo({ url: '/pages/material/index' })
  },

  goJoinPage() {
    wx.navigateTo({ url: this.data.joinInvitePath || getSystemJoinPath() })
  },

  copyJoinInvite() {
    wx.setClipboardData({
      data: this.data.joinInvitePath || getSystemJoinPath(),
      success: () => {
        wx.showToast({ title: '入驻链接已复制', icon: 'none' })
      }
    })
  },

  goCreateOrder() {
    wx.navigateTo({ url: '/pages/create-order/index' })
  },

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
    this.setData({
      createForm: {
        ...this.data.createForm,
        [field]: value
      }
    })
  },

  toggleUrgent(event) {
    this.setData({
      createForm: {
        ...this.data.createForm,
        urgent: event.detail.value
      }
    })
  },

  submitCreateOrder() {
    const app = getApp()
    try {
      if (!this.data.createForm.factory || !this.data.createForm.customer || !this.data.createForm.dueDate || !this.data.createForm.model || !this.data.createForm.material || !this.data.createForm.qty) {
        wx.showToast({ title: '请先补全工单信息', icon: 'none' })
        return
      }

      const drawings = (this.data.createForm.drawingsText || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          type: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image'
        }))

      createOrder(
        {
          ...this.data.createForm,
          drawings
        },
        app.globalData.currentUser.id
      )

      this.setData({ createForm: emptyCreateForm() })
      this.onShow()
      wx.showToast({ title: '工单已创建', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  bindInviteField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({
      inviteForm: {
        ...this.data.inviteForm,
        [field]: value
      }
    })
  },

  bindInviteRole(event) {
    this.setData({
      inviteForm: {
        ...this.data.inviteForm,
        roleIndex: Number(event.detail.value)
      }
    })
  },

  submitInvite() {
    const app = getApp()
    try {
      if (!this.data.inviteForm.name || !this.data.inviteForm.station) {
        wx.showToast({ title: '请填写姓名和岗位', icon: 'none' })
        return
      }

      const role = this.data.roleOptions[this.data.inviteForm.roleIndex] || 'worker'
      inviteEmployee(
        {
          name: this.data.inviteForm.name,
          station: this.data.inviteForm.station,
          stations: this.data.inviteForm.stations.length > 0 ? this.data.inviteForm.stations : [this.data.inviteForm.station],
          role,
          note: this.data.inviteForm.note,
          inviteSource: 'admin'
        },
        app.globalData.currentUser.id
      )

      this.setData({ inviteForm: emptyInviteForm() })
      this.onShow()
      wx.showToast({ title: '已创建待审批账号', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  approveEmployee(event) {
    const app = getApp()
    const { id } = event.currentTarget.dataset
    try {
      approveEmployee(id, app.globalData.currentUser.id)
      this.onShow()
      wx.showToast({ title: '已通过审批', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  rejectEmployee(event) {
    const app = getApp()
    const { id } = event.currentTarget.dataset
    try {
      rejectEmployee(id, app.globalData.currentUser.id)
      this.onShow()
      wx.showToast({ title: '已驳回', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  deleteEmployee(event) {
    const app = getApp()
    const { id } = event.currentTarget.dataset
    const target = this.data.employees.find((employee) => employee.id === id)
    wx.showModal({
      title: '确认删除',
      content: `确定要删除 ${target.name} 吗？`,
      success: (result) => {
        if (!result.confirm) {
          return
        }
        try {
          deleteEmployee(id, app.globalData.currentUser.id)
          this.onShow()
          wx.showToast({ title: '已删除', icon: 'none' })
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  },

  promoteToAdmin(event) {
    const app = getApp()
    const { id } = event.currentTarget.dataset
    try {
      updateEmployeeRole(id, 'admin', app.globalData.currentUser.id)
      this.onShow()
      wx.showToast({ title: '已设为管理员', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  demoteToWorker(event) {
    const app = getApp()
    const { id } = event.currentTarget.dataset
    try {
      updateEmployeeRole(id, 'worker', app.globalData.currentUser.id)
      this.onShow()
      wx.showToast({ title: '已取消管理员权限', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  toggleEmployeePanel() {
    this.setData({ employeePanelOpen: !this.data.employeePanelOpen })
  },

  onShareAppMessage() {
    return {
      title: '兴祥机械跟单系统入驻申请',
      path: this.data.joinInvitePath || getSystemJoinPath()
    }
  }
})
