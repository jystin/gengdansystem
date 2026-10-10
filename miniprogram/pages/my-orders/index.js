const api = require('../../utils/api')
const ui = require('../../utils/ui')

/**
 * 我的工单（认领视图）
 * - 待完成：我认领且尚未完成流转的工单（order_claims.status = active）
 * - 已完成：我认领并完成流转的工单（order_claims.status = completed）
 * 数据来源 orderManager.listClaims(scope='my')，每条带 order 工单概要
 */
Page({
  data: {
    tab: 'pending',
    pending: [],
    done: [],
    loading: true
  },

  onShow() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    try {
      ui.showLoading('加载中...')
      const claims = await api.listClaims('my')
      const decorate = (c) => ({
        ...c,
        _claimedAt: String(c.claimedAt || '').slice(0, 16),
        _completedAt: String(c.completedAt || '').slice(0, 16)
      })
      const pending = (claims || []).filter(c => c.status === 'active').map(decorate)
      const done = (claims || []).filter(c => c.status === 'completed').map(decorate)
      this.setData({ pending, done, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      ui.handleError(e, '加载我的工单失败')
    } finally {
      ui.hideLoading()
    }
  },

  switchTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (tab && tab !== this.data.tab) this.setData({ tab })
  },

  openOrder(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/index' })
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  }
})
