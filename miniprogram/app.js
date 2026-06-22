/**
 * 应用入口
 * 职责：
 *  1. 初始化云开发
 *  2. 全局错误监控（wx.onError + onUnhandledRejection + 包装 wx.cloud.callFunction）
 *  3. 网络状态监听
 *  4. 设备 ID 持久化
 *  5. 鉴权：syncAccessContext() → auth/login
 *  6. 权限守卫：requireActiveAccess(redirectUrl)
 */

const STORAGE_DEVICE_ID = 'deviceId'
const STORAGE_TOKEN = 'authToken'

App({
  globalData: {
    currentUser: null,
    accessState: 'guest',     // guest | pending | active
    deviceId: '',
    appName: '兴祥机械跟单系统',
    token: '',
    accessReady: false,
    authReadyPromise: null,
    isNetworkConnected: true,
    systemInfo: null
  },

  async onLaunch() {
    this.initCloud()
    this.setupErrorMonitoring()
    this.initSystemInfo()
    this.ensureDeviceId()
    // 同步启动鉴权流程（不 await，让首次进入 home 时也能被 waitForAccessReady 捕获）
    this.startAuthFlow()
  },

  /**
   * 初始化云开发
   * 优先从 wx.getStorageSync('cloudEnv') 读取用户自定义环境，
   * 否则使用项目硬编码默认环境（与 project.private.config.json/cloud1-d5g9vjcxhac7a2f30 一致）。
   */
  initCloud() {
    try {
      let env = 'cloud1-d5g9vjcxhac7a2f30'
      try {
        const stored = wx.getStorageSync('cloudEnv')
        if (stored && typeof stored === 'string') env = stored
      } catch (e) { /* ignore */ }
      wx.cloud.init({ traceUser: true, env })
    } catch (e) {
      console.error('云开发初始化失败：', e)
    }
  },

  /**
   * 全局错误监控
   * 仅记录 JS 运行时错误与 Promise 拒绝，不包装 wx.cloud.callFunction
   * （云函数错误由 utils/api.js 内部统一处理）
   */
  setupErrorMonitoring() {
    // 运行时错误
    wx.onError && wx.onError((err) => {
      this.logError('onError', err)
    })
    // 未捕获的 Promise 拒绝
    wx.onUnhandledRejection && wx.onUnhandledRejection((res) => {
      this.logError('onUnhandledRejection', res && (res.reason || res))
    })
  },

  logError(type, detail) {
    try {
      const list = wx.getStorageSync('errorLogs') || []
      list.unshift({ type, detail: String(detail), at: new Date().toISOString() })
      wx.setStorageSync('errorLogs', list.slice(0, 50))
    } catch (e) { /* ignore */ }
  },

  /**
   * 系统信息
   */
  initSystemInfo() {
    try {
      this.globalData.systemInfo = wx.getSystemInfoSync()
    } catch (e) { /* ignore */ }
    // 网络状态
    wx.onNetworkStatusChange && wx.onNetworkStatusChange((res) => {
      this.globalData.isNetworkConnected = !!res.isConnected
    })
    try {
      const net = wx.getNetworkType({
        success: (res) => { this.globalData.isNetworkConnected = !!res.networkType && res.networkType !== 'none' }
      })
    } catch (e) { /* ignore */ }
  },

  /**
   * 设备 ID 持久化
   */
  ensureDeviceId() {
    const stored = wx.getStorageSync(STORAGE_DEVICE_ID)
    if (stored) {
      this.globalData.deviceId = stored
      return stored
    }
    const next = 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    wx.setStorageSync(STORAGE_DEVICE_ID, next)
    this.globalData.deviceId = next
    return next
  },

  /**
   * 启动鉴权流程（带并发去重）
   */
  startAuthFlow() {
    if (this.globalData.authReadyPromise) return this.globalData.authReadyPromise
    this.globalData.authReadyPromise = this.syncAccessContext().finally(() => {
      this.globalData.accessReady = true
    })
    return this.globalData.authReadyPromise
  },

  /**
   * 等待鉴权完成
   */
  waitForAccessReady() {
    if (this.globalData.accessReady) return Promise.resolve()
    return this.startAuthFlow()
  },

  /**
   * 同步访问上下文：调用 auth/login 拉取用户状态
   */
  async syncAccessContext() {
    const deviceId = this.ensureDeviceId()
    const token = wx.getStorageSync(STORAGE_TOKEN) || ''
    this.globalData.token = token

    try {
      const api = require('./utils/api')
      const res = await api.login(deviceId)
      console.log('[login] response:', JSON.stringify(res))
      if (res && res.state) {
        const user = res.user || null
        // 兜底：英文名字 / 缺省名字统一规范为中文
        if (user && user.role === 'superadmin') {
          if (!user.name || /^[A-Za-z\s]+$/.test(user.name) || /admin/i.test(user.name)) {
            user.name = '江鑫（超管）'
          }
        } else if (user && (!user.name || /^[A-Za-z\s]+$/.test(user.name))) {
          // 其他英文名字 fallback：保留原值但加备注（在 profile 等页面展示）
        }
        this.globalData.currentUser = user
        this.globalData.accessState = res.state
        if (res.token) {
          this.globalData.token = res.token
          wx.setStorageSync(STORAGE_TOKEN, res.token)
        } else {
          // pending/guest 状态清除 token
          wx.removeStorageSync(STORAGE_TOKEN)
          this.globalData.token = ''
        }
      }
    } catch (e) {
      console.error('[app] syncAccessContext failed:', e)
      this.globalData.currentUser = null
      this.globalData.accessState = 'guest'
    }
    return {
      state: this.globalData.accessState,
      user: this.globalData.currentUser
    }
  },

  /**
   * 清除鉴权
   */
  _clearAuth() {
    wx.removeStorageSync(STORAGE_TOKEN)
    this.globalData.token = ''
    this.globalData.currentUser = null
    this.globalData.accessState = 'guest'
  },

  /**
   * 权限守卫：未激活用户只能跳转到 scan/join
   * @returns {boolean} 是否通过
   */
  requireActiveAccess(redirectUrl) {
    // 调试日志：发布前可删除
    if (!this._dbgLogged) {
      console.log('[access] state=', this.globalData.accessState, 'user=', this.globalData.currentUser)
      this._dbgLogged = true
    }
    if (this.globalData.accessState === 'active' && this.globalData.currentUser) {
      return true
    }
    const message = this.globalData.accessState === 'pending'
      ? '申请已提交，待管理员审批后可进入系统'
      : '仅限内部员工通过管理员分享链接申请后使用'
    wx.showToast({ title: message, icon: 'none', duration: 2000 })
    if (redirectUrl) {
      wx.redirectTo({ url: redirectUrl })
    }
    return false
  }
})
