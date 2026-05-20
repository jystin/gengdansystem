const { submitJoinApplication, getSystemJoinInviteCode, isValidJoinInviteCode } = require('../../utils/mock-store')

Page({
  data: {
    inviteCode: '',
    expectedInviteCode: getSystemJoinInviteCode(),
    form: {
      name: '',
      station: '',
      note: ''
    }
  },

  onLoad(options) {
    const app = getApp()
    app.syncAccessContext()

    this.setData({
      inviteCode: options.invite || ''
    })

    if (app.globalData.accessState === 'active') {
      wx.showToast({ title: '当前账号已通过审批', icon: 'none' })
    }
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

  submitApplication() {
    const app = getApp()
    try {
      app.syncAccessContext()
      if (app.globalData.accessState === 'active') {
        wx.showToast({ title: '当前账号已通过审批，无需申请', icon: 'none' })
        return
      }

      if (!isValidJoinInviteCode(this.data.inviteCode)) {
        wx.showToast({ title: '入驻码无效或已过期', icon: 'none' })
        return
      }

      if (!this.data.form.name || !this.data.form.station) {
        wx.showToast({ title: '请填写姓名和岗位', icon: 'none' })
        return
      }

      submitJoinApplication(
        {
          name: this.data.form.name,
          station: this.data.form.station,
          note: this.data.form.note,
          inviteSource: 'scan',
          inviteCode: this.data.inviteCode
        },
        app.globalData.deviceId,
        this.data.inviteCode
      )

      app.syncAccessContext()

      wx.showToast({ title: '申请已提交，等待管理员审批', icon: 'success' })
      this.setData({
        form: {
          name: '',
          station: '',
          note: ''
        }
      })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onShareAppMessage() {
    return {
      title: '申请加入兴祥机械跟单系统',
      path: `/pages/join/index?invite=${this.data.expectedInviteCode}`
    }
  }
})