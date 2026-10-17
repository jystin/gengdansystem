/**
 * 扫码落地页（中转页）
 * 仅承担一个职责：微信相机扫「工单小程序码」后的落地跳转（scene = 工单号）。
 * 手动「扫码进单」入口已改为直接调起相机（utils/scan.js），不再进入本页。
 */
Page({
  async onLoad(options) {
    if (options && options.scene) {
      const orderId = decodeURIComponent(options.scene)
      if (!orderId || !/^GD\d{11,}$/.test(orderId)) {
        wx.reLaunch({ url: '/pages/home/index' })
        return
      }
      const app = getApp()
      await app.waitForAccessReady()
      if (app.globalData.accessState !== 'active') {
        wx.reLaunch({ url: '/pages/join/index' })
        return
      }
      wx.redirectTo({ url: '/pages/order-detail/index?scene=' + encodeURIComponent(orderId) + '&focus=panel' })
      return
    }
    // 直接访问本页（无 scene）→ 回首页
    wx.reLaunch({ url: '/pages/home/index' })
  }
})
