const api = require('../../utils/api')
const ui = require('../../utils/ui')

Page({
  data: {
    name: '',
    stations: [],       // 已选岗位列表：['下料工', '精车工', ...]
    submitting: false
  },

  onLoad() {
    const app = getApp()
    if (app.globalData.accessState === 'active') {
      ui.toast('当前账号已通过审批，无需重复申请', 'none')
    }
    if (app.globalData.accessState === 'disabled') {
      ui.toast('您的账号已被管理员移除，可重新提交申请', 'none')
    }
    // 加载系统预设岗位列表
    this.setData({
      allStations: api.getProcessLibrary().map(p => ({
        station: p.station,
        name: p.name,
        checked: false
      }))
    })
  },

  bindNameInput(e) {
    this.setData({ name: e.detail.value.trim() })
  },

  toggleStation(e) {
    const station = e.currentTarget.dataset.station
    const index = e.currentTarget.dataset.index
    let stations = [...this.data.stations]
    let allStations = [...this.data.allStations]
    const idx = stations.indexOf(station)
    if (idx >= 0) {
      stations.splice(idx, 1)
      allStations[index].checked = false
    } else {
      stations.push(station)
      allStations[index].checked = true
    }
    this.setData({ stations, allStations })
  },

  async submitApplication() {
    if (this.data.submitting) return
    const app = getApp()
    try {
      if (app.globalData.accessState === 'active') {
        ui.toast('当前账号已通过审批，无需申请')
        return
      }
      if (!this.data.name) {
        ui.toast('请填写姓名')
        return
      }
      if (this.data.stations.length === 0) {
        ui.toast('请至少选择一个岗位')
        return
      }
      this.setData({ submitting: true })
      ui.showLoading('提交中...')
      await api.submitJoinApplication({
        name: this.data.name,
        stations: this.data.stations
      })
      app.globalData.accessReady = false
      app.globalData.authReadyPromise = null
      await app.syncAccessContext()
      ui.hideLoading()
      ui.toast('申请已提交，等待管理员审批', 'success')
      const allStations = this.data.allStations.map(s => ({ ...s, checked: false }))
      this.setData({ name: '', stations: [], allStations, submitting: false })
    } catch (e) {
      ui.hideLoading()
      this.setData({ submitting: false })
      ui.handleError(e, '提交失败')
    }
  },

  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) }
})
