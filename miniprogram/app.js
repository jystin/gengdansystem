const { resolveUserAccess, setCurrentUser: setStoreCurrentUser, getSystemJoinPath } = require('./utils/mock-store')

const STORAGE_DEVICE_ID = 'deviceId'
const STORAGE_SESSION_USER_ID = 'sessionUserId'

App({
  globalData: {
    currentUser: null,
    accessState: 'guest',
    deviceId: '',
    appName: '兴祥机械跟单系统',
    joinInvitePath: getSystemJoinPath()
  },

  onLaunch() {
    this.ensureDeviceId()
    this.syncAccessContext()
  },

  ensureDeviceId() {
    const storedDeviceId = wx.getStorageSync(STORAGE_DEVICE_ID)
    if (storedDeviceId) {
      this.globalData.deviceId = storedDeviceId
      return storedDeviceId
    }

    const nextDeviceId = 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    wx.setStorageSync(STORAGE_DEVICE_ID, nextDeviceId)
    this.globalData.deviceId = nextDeviceId
    return nextDeviceId
  },

  syncAccessContext() {
    const sessionUserId = wx.getStorageSync(STORAGE_SESSION_USER_ID)
    const deviceId = this.ensureDeviceId()
    const access = resolveUserAccess(sessionUserId, deviceId)

    this.globalData.currentUser = access.user
    this.globalData.accessState = access.state

    if (access.user && access.state === 'active') {
      wx.setStorageSync(STORAGE_SESSION_USER_ID, access.user.id)
      return access
    }

    wx.removeStorageSync(STORAGE_SESSION_USER_ID)
    return access
  },

  setCurrentUser(user) {
    if (!user || !user.id) {
      wx.removeStorageSync(STORAGE_SESSION_USER_ID)
      return this.syncAccessContext()
    }

    const employee = setStoreCurrentUser(user.id)
    if (employee.status !== 'active') {
      throw new Error('仅已审批账号可登录系统')
    }

    wx.setStorageSync(STORAGE_SESSION_USER_ID, employee.id)
    return this.syncAccessContext()
  },

  requireActiveAccess(redirectUrl) {
    const access = this.syncAccessContext()
    if (access.state === 'active' && access.user) {
      return true
    }

    const message = access.state === 'pending'
      ? '申请已提交，待管理员审批后可进入系统'
      : '仅限内部员工通过管理员分享链接申请后使用'
    wx.showToast({ title: message, icon: 'none' })
    if (redirectUrl) {
      wx.redirectTo({ url: redirectUrl })
    }
    return false
  }
})
