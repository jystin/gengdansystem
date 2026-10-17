const api = require('../../utils/api')
const ui = require('../../utils/ui')
const scan = require('../../utils/scan')

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
      const decorate = (c) => {
        // 多认领模型：stepClaims[下标] 为认领数组；我的认领已不在列表中 = 被转移/撤销
        const sc = (c.order && c.order.stepClaims) || {}
        const live = Array.isArray(sc[c.stepIndex]) ? sc[c.stepIndex] : (sc[c.stepIndex] ? [sc[c.stepIndex]] : [])
        return {
          ...c,
          _claimedAt: String(c.claimedAt || '').slice(0, 16),
          _completedAt: String(c.completedAt || '').slice(0, 16),
          // 预认领的未来工序：流程还没流转到该步 → 显示「等待前置工序」；
          // 流程已到达 → 可进详情页填写实际数据并完成流转
          _waiting: !!(c.order && Number(c.order.currentStepIndex) !== Number(c.stepIndex)),
          _canWork: !!(c.order && Number(c.order.currentStepIndex) === Number(c.stepIndex)),
          _transferred: c.status === 'active' && live.length > 0 && !live.some(x => x.userId === c.userId)
        }
      }
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
    scan.scanAndOpenOrder()
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  }
})
