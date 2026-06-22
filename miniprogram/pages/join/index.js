const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    inviteCode: '',
    form: {
      name: '',
      station: '',
      note: ''
    }
  },

  onLoad(options) {
    this.setData({ inviteCode: options.invite || '' })
    const app = getApp()
    if (app.globalData.accessState === 'active') {
      ui.toast('当前账号已通过审批', 'none')
    }
  },

  bindField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({ form: { ...this.data.form, [field]: value } })
  },

  async submitApplication() {
    const app = getApp()
    try {
      if (app.globalData.accessState === 'active') {
        ui.toast('当前账号已通过审批，无需申请')
        return
      }
      if (!this.data.inviteCode) {
        ui.toast('入驻码无效或已过期')
        return
      }
      if (!this.data.form.name || !this.data.form.station) {
        ui.toast('请填写姓名和岗位')
        return
      }
      ui.showLoading('提交中...')
      await api.submitJoinApplication({
        name: this.data.form.name,
        station: this.data.form.station,
        note: this.data.form.note,
        inviteCode: this.data.inviteCode
      })
      // 重新走鉴权刷新本地状态
      app.globalData.accessReady = false
      app.globalData.authReadyPromise = null
      await app.syncAccessContext()
      ui.hideLoading()
      ui.toast('申请已提交，等待管理员审批', 'success')
      this.setData({ form: { name: '', station: '', note: '' } })
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '提交失败')
    }
  },

  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },

  onShareAppMessage() {
    return {
      title: '申请加入兴祥机械跟单系统',
      path: `/pages/join/index?invite=${this.data.inviteCode}`
    }
  }
})
