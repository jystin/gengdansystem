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
    accessState: 'guest',     // guest | pending | active | disabled
    deviceId: '',
    appName: '兴祥机械跟单系统',
    token: '',
    accessReady: false,
    authReadyPromise: null,
    isNetworkConnected: true,
    systemInfo: null,
    _lastAuthSyncTime: 0,     // 上次鉴权同步时间戳，用于 onShow 节流
    _permissionWatcherTimer: null,  // 权限轮询定时器
    _kickoutModalShown: false,      // 防止重复弹出踢出弹窗

    // ===== 隐私 API 授权配置 =====
    // 设为 true   → 启用完整的微信隐私 API 作用域检查（上线前需要在微信后台配置隐私协议）
    // 设为 false  → 开发阶段跳过所有隐私检查，chooseMedia/chooseImage 直接可用
    privacyCheckEnabled: false
  },

  async onLaunch() {
    // 【优化】云初始化是启动必要条件，同步等待；其余非阻塞操作异步启动
    this.initCloud()
    // 【优化】错误监控、系统信息和隐私授权非首屏必需，延迟到下一微任务执行
    setTimeout(() => {
      this.setupErrorMonitoring()
      this.initSystemInfo()
      this.setupPrivacyAuthorization()
    }, 0)
    this.ensureDeviceId()
    // 同步启动鉴权流程（不 await，让首次进入 home 时也能被 waitForAccessReady 捕获）
    this.startAuthFlow()
  },

  /**
   * 隐私合规配置（微信 2023.09+ 要求）
   * 使用相机/相册前必须先弹出隐私协议弹窗并获得用户同意
   * 受 globalData.privacyCheckEnabled 控制
   */
  setupPrivacyAuthorization() {
    if (!this.globalData.privacyCheckEnabled) return
    if (typeof wx.onNeedPrivacyAuthorization !== 'function') return
    const privacyContractName = '兴祥机械跟单系统隐私保护指引'
    wx.onNeedPrivacyAuthorization((resolve) => {
      wx.showModal({
        title: '隐私权限说明',
        content: `为了帮您上传工单图纸，${privacyContractName}需要获取您的相机和相册权限。\n\n• 相机：用于拍摄工单图纸照片\n• 相册：用于从相册中选择图纸图片\n\n您的图片仅用于业务流转，不会用于其他用途。点击"同意"即表示您已阅读并同意《${privacyContractName}》。`,
        confirmText: '同意',
        cancelText: '拒绝',
        success: (res) => {
          if (res.confirm) {
            resolve({ event: 'agree', buttonId: 'agree' })
          } else {
            resolve({ event: 'disagree' })
          }
        }
      })
    })
  },

  /**
   * 请求隐私授权（调用隐私敏感 API 前必须调用）
   *
   * 配置项：this.globalData.privacyCheckEnabled
   *   false（默认）→ 开发阶段，直接放行，不触发任何隐私检查
   *   true        → 上线阶段，执行完整微信隐私 API 作用域校验
   *                  上线前必须在微信后台「设置 → 服务内容声明 → 用户隐私保护指引」
   *                  中勾选 chooseMedia/chooseImage 对应的作用域
   *
   * @returns {Promise<boolean>} 是否可继续
   */
  async requirePrivacyAuthorize() {
    // 配置开关：关闭时跳过所有隐私检查，直接放行
    if (!this.globalData.privacyCheckEnabled) return true

    if (typeof wx.getPrivacySetting !== 'function') return true
    if (typeof wx.requirePrivacyAuthorize !== 'function') return true
    try {
      const setting = await wx.getPrivacySetting()
      if (!setting || !setting.needAuthorization) return true
      // 10 秒超时兜底：部分环境隐私 API 可能无响应，避免按钮卡死
      await Promise.race([
        wx.requirePrivacyAuthorize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('PRIVACY_TIMEOUT')), 10000))
      ])
      return true
    } catch (e) {
      // 开发工具未配置隐私协议时，隐私 API 会报错或超时，此时降级放行便于调试；
      // 真机用户拒绝时，按合规要求阻止后续操作。
      try {
        const sys = wx.getSystemInfoSync()
        if (sys && sys.platform === 'devtools') {
          return true
        }
      } catch (err) { /* ignore */ }
      wx.showToast({ title: '需要您同意隐私权限后才能使用', icon: 'none', duration: 2000 })
      return false
    }
  },

  /**
   * 小程序从后台回到前台时，自动刷新鉴权状态
   * 解决管理员在后台删除/提升员工后，员工回到前台权限未更新的问题
   */
  onShow() {
    const now = Date.now()
    // 活跃用户回到前台时强制刷新鉴权（10 秒节流，避免频繁请求）
    if (this.globalData.accessState === 'active' && now - this.globalData._lastAuthSyncTime >= 10000) {
      this.refreshAuthContext()
    }
  },

  /**
   * 小程序进入后台时，停止权限轮询以节省资源
   */
  onHide() {
    this.stopPermissionWatcher()
  },

  /**
   * 强制刷新鉴权上下文（重新调用 auth/login，获取最新角色/权限）
   * 适用于：管理员权限变更后、角色切换等场景
   */
  async refreshAuthContext() {
    // 已有踢出弹窗展示中，不再刷新
    if (this.globalData._kickoutModalShown) return
    this.globalData._lastAuthSyncTime = Date.now()
    // 重置鉴权 Promise，使下一次 waitForAccessReady 等待新的同步结果
    this.globalData.accessReady = false
    this.globalData.authReadyPromise = null
    await this.startAuthFlow()
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
   * 系统信息（使用新API替代已废弃的 wx.getSystemInfoSync）
   */
  initSystemInfo() {
    try {
      const deviceInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : {}
      const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : {}
      const appBaseInfo = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {}
      this.globalData.systemInfo = {
        ...deviceInfo,
        ...windowInfo,
        ...appBaseInfo,
        platform: deviceInfo.platform || appBaseInfo.platform || '',
        model: deviceInfo.model || '',
        pixelRatio: deviceInfo.pixelRatio || 1,
        windowWidth: windowInfo.windowWidth || 375,
        windowHeight: windowInfo.windowHeight || 667,
        statusBarHeight: windowInfo.statusBarHeight || 20,
        safeArea: windowInfo.safeArea || null,
        screenWidth: windowInfo.screenWidth || 375,
        screenHeight: windowInfo.screenHeight || 667,
        SDKVersion: appBaseInfo.SDKVersion || '',
        version: appBaseInfo.version || '',
        language: appBaseInfo.language || 'zh_CN'
      }
    } catch (e) { /* ignore */ }
    // 网络状态
    wx.onNetworkStatusChange && wx.onNetworkStatusChange((res) => {
      this.globalData.isNetworkConnected = !!res.isConnected
    })
    try {
      wx.getNetworkType({
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
      if (res && res.state) {
        const user = res.user || null
        // 英文名兜底：超管显示中文名
        if (user && user.role === 'superadmin') {
          if (!user.name || /^[A-Za-z\s]+$/.test(user.name) || /admin/i.test(user.name)) {
            user.name = '江鑫（超管）'
          }
        }
        this.globalData.currentUser = user
        this.globalData.accessState = res.state
        if (res.token) {
          this.globalData.token = res.token
          wx.setStorageSync(STORAGE_TOKEN, res.token)
        } else {
          // pending/guest/disabled 状态清除 token
          wx.removeStorageSync(STORAGE_TOKEN)
          this.globalData.token = ''
        }
        // 检测到被禁用时停止权限轮询，由页面 requireActiveAccess 拦截
        if (res.state === 'disabled') {
          this.stopPermissionWatcher()
        }
        // 活跃或待审批用户启动权限轮询监视器
        if (res.state === 'active' || res.state === 'pending') {
          this.startPermissionWatcher()
        }
      }
    } catch (e) {
      console.error('[app] syncAccessContext failed:', e)
      this.globalData.currentUser = null
      this.globalData.accessState = 'guest'
      this.stopPermissionWatcher()
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
    this.globalData.accessReady = true
    this.globalData.authReadyPromise = null
  },

  /**
   * 启动权限轮询监视器（每 30 秒检查一次账号状态）
   */
  startPermissionWatcher() {
    this.stopPermissionWatcher()
    this.globalData._kickoutModalShown = false
    // 立即执行一次检查
    this._checkUserAccessStatus()
    // 每 3 秒轮询，确保账号被删除后实时踢出
    this.globalData._permissionWatcherTimer = setInterval(() => {
      this._checkUserAccessStatus()
    }, 3000)
  },

  /**
   * 停止权限轮询监视器
   */
  stopPermissionWatcher() {
    if (this.globalData._permissionWatcherTimer) {
      clearInterval(this.globalData._permissionWatcherTimer)
      this.globalData._permissionWatcherTimer = null
    }
  },

  /**
   * 检查用户账号实时状态（轻量级查询）
   * 仅在 accessState 为 active 或 pending 时执行
   */
  async _checkUserAccessStatus() {
    const currentState = this.globalData.accessState
    // 非活跃/待审批用户无需轮询
    if (currentState !== 'active' && currentState !== 'pending') return
    // 已有踢出弹窗展示中，不再重复检查
    if (this.globalData._kickoutModalShown) return

    try {
      const api = require('./utils/api')
      const res = await api.checkAccess()
      if (!res || !res.state) return

      const previousState = currentState
      const newState = res.state

      // 状态未变化，无需处理
      if (previousState === newState) return

      // 场景一：员工被管理员删除（active → disabled）
      if (previousState === 'active' && newState === 'disabled') {
        this.forceKickout('您的账号已被管理员移除，无法继续访问系统')
        return
      }

      // 场景二：员工审批通过（pending → active）
      if (previousState === 'pending' && newState === 'active') {
        // 强制重新同步完整鉴权信息
        await this.syncAccessContext()
        if (this.globalData.accessState !== 'active') return // 二次确认
        wx.showToast({ title: '审批已通过，欢迎加入！', icon: 'success', duration: 2000 })
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/home/index' })
        }, 2000)
        return
      }

      // 场景三：pending 变 disabled（申请被拒绝后又删除）
      if (previousState === 'pending' && newState === 'disabled') {
        this._clearAuth()
        this.globalData.accessState = 'disabled'
        this.stopPermissionWatcher()
        return
      }

      // 其他状态变化：直接同步全局状态
      if (res.user) {
        this.globalData.currentUser = res.user
      }
      this.globalData.accessState = newState
    } catch (e) {
      // 网络错误静默处理，不因断网误踢用户
      console.warn('[app] _checkUserAccessStatus failed:', e)
    }
  },

  /**
   * 强制踢出用户：清除鉴权、弹出阻塞弹窗、重定向到申请页
   * @param {string} reason 踢出原因（展示给用户）
   */
  forceKickout(reason) {
    if (this.globalData._kickoutModalShown) return
    this.globalData._kickoutModalShown = true

    // 清除所有鉴权数据
    this._clearAuth()
    this.globalData.accessState = 'disabled'
    this.stopPermissionWatcher()

    // 展示阻塞式模态弹窗（用户无法关闭后继续操作）
    wx.showModal({
      title: '账号已被移除',
      content: reason || '您的账号已被管理员移除，无法继续访问系统',
      showCancel: false,
      confirmText: '我知道了',
      success: () => {
        wx.reLaunch({ url: '/pages/join/index' })
      }
    })
  },

  /**
   * 权限守卫：未激活用户只能跳转到 scan/join
   * 支持三种状态检测：
   *   - active:   放行
   *   - disabled: 展示阻塞弹窗 + 强制跳转 join 页
   *   - pending:  提示待审批 + 跳转 join 页
   *   - guest:    提示申请 + 跳转 join 页
   * @param {string} redirectUrl 重定向目标页
   * @returns {boolean} 是否通过
   */
  requireActiveAccess(redirectUrl) {
    if (this.globalData.accessState === 'active' && this.globalData.currentUser) {
      return true
    }

    // 已删除用户：展示阻塞弹窗，无法跳过
    if (this.globalData.accessState === 'disabled') {
      if (!this.globalData._kickoutModalShown) {
        this.globalData._kickoutModalShown = true
        this.stopPermissionWatcher()
        wx.showModal({
          title: '账号已被移除',
          content: '您的账号已被管理员移除，无法继续访问系统',
          showCancel: false,
          confirmText: '我知道了',
          success: () => {
            wx.reLaunch({ url: redirectUrl || '/pages/join/index' })
          }
        })
      }
      return false
    }

    const message = this.globalData.accessState === 'pending'
      ? '申请已提交，待管理员审批后可进入系统'
      : '请先填写信息申请加入系统'
    wx.showToast({ title: message, icon: 'none', duration: 2000 })
    if (redirectUrl) {
      wx.redirectTo({ url: redirectUrl })
    }
    return false
  }
})
