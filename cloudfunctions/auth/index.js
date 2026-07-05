/**
 * 生产环境鉴权与会话管理云函数示例
 * 用微信 openid + 数据库替代本地 mock-store 的 sessionUserId
 * 
 * 使用方式：
 * 1. 在微信小程序后台配置该云函数
 * 2. 在小程序中调用 wx.cloud.callFunction({ name: 'auth', data: { action: 'login' } })
 * 3. 返回的 token 写入本地存储，后续 API 调用时在 header 中携带
 */

let cloudModule = null
let cloudReady = false

function getCloud() {
  if (!cloudModule) {
    cloudModule = require('wx-server-sdk')
  }
  return cloudModule
}

function ensureCloudReady() {
  if (!cloudReady) {
    const cloud = getCloud()
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
    cloudReady = true
  }
}

function getDb() {
  const cloud = getCloud()
  ensureCloudReady()
  return cloud.database()
}

function isMissingCollectionError(err) {
  return err && (err.errCode === -502005 || String(err.errMsg || '').includes('Db or Table not exist'))
}

/**
 * 主入口
 * 支持的 action:
 *   - login: 用 openid 登录或注册（需 openid 和可选的 deviceId）
 *   - verify: 验证 token 有效性
 *   - logout: 清除会话
 *   - submitJoinApplication: 新员工自助申请加入系统
 */
exports.main = async (event, context) => {
  try {
    const cloud = getCloud()
    ensureCloudReady()

    const safeEvent = event || {}
    const action = safeEvent.action
    const token = safeEvent.token
    const deviceId = safeEvent.deviceId
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID || ''

    switch (action) {
      case 'login':
        return await login({ openid, deviceId })

      case 'ping':
        return {
          success: true,
          message: 'auth 云函数可用',
          runtime: process.version,
          openid: openid,
          timestamp: Date.now()
        }
      
      case 'verify':
        return await verifyToken(token)
      
      case 'checkAccess':
        return await checkAccess({ openid, deviceId, token })

      case 'logout':
        return await logout(token)
      
      case 'submitJoinApplication':
        return await submitJoinApplication({
          deviceId: deviceId,
          name: safeEvent.name,
          stations: safeEvent.stations || [],
          openid: openid
        })
      
      default:
        return { success: false, error: '未知的操作类型' }
    }
  } catch (err) {
    return {
      success: false,
      error: 'auth 云函数执行异常: ' + (err.message || '服务器错误'),
      hint: '请在微信开发者工具中对 auth 执行 上传并部署（云端安装依赖）'
    }
  }
}

/**
 * 登录或自动注册
 * @param {string} openid - 微信 openid
 * @param {string} deviceId - 设备标识（可选）
 */
async function login({ openid, deviceId }) {
  if (!openid) {
    return { success: false, error: '缺少 openid' }
  }

  const db = getDb()

  // 查询用户是否存在于数据库
  let res
  try {
    res = await db.collection('users').where({
      openid: openid
    }).get()
  } catch (err) {
    if (isMissingCollectionError(err)) {
      return {
        success: false,
        error: '数据库未初始化：缺少 users 集合，请先运行 init-db'
      }
    }
    throw err
  }

  let user = res.data[0]
  
  // 如果 openid 匹配不到用户，优先通过 deviceId 直接查找 users 中的已激活用户
  // 适用于 invite 用户审批通过后 pending 记录已被清理的场景
  if (!user && deviceId) {
    try {
      const deviceUserRes = await db.collection('users').where({
        deviceId: deviceId,
        status: 'active'
      }).get()
      if (deviceUserRes.data.length > 0) {
        user = deviceUserRes.data[0]
      }
    } catch (err) {
      // 静默处理
    }
  }

  // 兜底：兼容尚未清理的 approved pending 记录（含 userId 引用）
  if (!user && deviceId) {
    try {
      const approvedRes = await db.collection('pending_applications').where({
        deviceId: deviceId,
        status: 'approved'
      }).get()
      if (approvedRes.data.length > 0) {
        const approved = approvedRes.data[0]
        if (approved.userId) {
          try {
            const userRes = await db.collection('users').doc(approved.userId).get()
            if (userRes.data) user = userRes.data
          } catch (e) { /* userId 引用可能失效 */ }
        }
      }
    } catch (err) {
      // 静默处理
    }
  }

  
  if (!user) {
    // 用户不存在，检查是否通过邀请码申请过
    let pendingRes
    try {
      pendingRes = await db.collection('pending_applications').where({
        openid: openid
      }).get()
    } catch (err) {
      if (isMissingCollectionError(err)) {
        pendingRes = { data: [] }
      } else {
        throw err
      }
    }

    if (pendingRes.data.length === 0) {
      // 完全陌生用户 → 返回 guest 状态
      return {
        success: true,
        state: 'guest',
        user: null,
        token: null,
        message: '仅限内部员工通过管理员分享链接申请后使用'
      }
    }

    // 找到待审批申请
    const pendingApp = pendingRes.data[0]
    return {
      success: true,
      state: 'pending',
      user: {
        id: pendingApp._id,
        name: pendingApp.name,
        role: 'pending',
        stations: pendingApp.stations,
        status: 'pending'
      },
      token: null,
      message: '申请已提交，等待管理员审批'
    }
  }

  // 检查用户是否已被启用
  if (user.status !== 'active') {
    const isDisabled = user.status === 'disabled'
    return {
      success: true,
      state: isDisabled ? 'disabled' : 'pending',
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        stations: user.stations || [],
        status: user.status
      },
      token: null,
      message: isDisabled
        ? '您的账号已被管理员移除'
        : '账号尚未被管理员审批激活'
    }
  }

  // 生成 JWT token（生产环境请使用签名算法）
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 7 * 24 * 60 * 60 * 1000
  const token = generateToken({
    userId: user._id,
    openid: openid,
    issuedAt: issuedAt,
    expiresAt: expiresAt
  })

  // 更新最后登录时间与设备 ID
  await db.collection('users').doc(user._id).update({
    data: {
      lastLoginAt: db.serverDate(),
      lastDeviceId: deviceId || ''
    }
  })

  return {
    success: true,
    state: 'active',
    user: {
      id: user._id,
      name: user.name,
      role: user.role,
      stations: user.stations || [],
      status: user.status
    },
    token: token
  }
}

/**
 * 验证 token 并返回用户信息
 * @param {string} token
 */
async function verifyToken(token) {
  if (!token) {
    return { success: false, error: 'token 缺失' }
  }

  const db = getDb()

  // 在生产环境中验证 JWT 签名
  // 这里示例省略，实际应使用 jsonwebtoken 库
  const decoded = decodeToken(token)
  if (!decoded) {
    return { success: false, error: 'token 无效或过期' }
  }

  if (decoded.expiresAt && Date.now() > decoded.expiresAt) {
    return { success: false, error: 'token 已过期，请重新登录' }
  }

  const { userId } = decoded
  const res = await db.collection('users').doc(userId).get()

  if (!res.data || res.data.status !== 'active') {
    return { success: false, error: '用户不存在或已被禁用' }
  }

  return {
    success: true,
    user: {
      id: res.data._id,
      name: res.data.name,
      role: res.data.role,
      stations: res.data.stations || [],
      status: res.data.status
    }
  }
}



/**
 * 辅助函数：尝试创建缺失的集合（集合已存在时静默忽略）
 */
async function ensureCollection(db, name) {
  try {
    await db.createCollection(name)
  } catch (err) {
    if (!isMissingCollectionError(err)) {
      console.warn(`[auth] ensureCollection ${name} failed:`, err.message || err)
    }
  }
}

/**
 * 员工自助申请加入系统
 * @param {string} deviceId - 设备 ID
 * @param {string} name - 申请人名字
 * @param {string[]} stations - 岗位列表（多选）
 */
async function submitJoinApplication({ deviceId, name, stations, openid }) {
  const normalizedDeviceId = String(deviceId || '').trim()
  const normalizedName = String(name || '').trim()
  const normalizedStations = (Array.isArray(stations) ? stations : (stations ? [stations] : []))
    .map(s => String(s).trim())
    .filter(Boolean)

  if (!normalizedDeviceId || !normalizedName) {
    return { success: false, error: '缺少必要字段' }
  }
  if (normalizedStations.length === 0) {
    return { success: false, error: '请至少选择一个岗位' }
  }

  const db = getDb()

  // 兜底：如果数据库集合尚未创建，先创建（本地/新环境常见）
  await ensureCollection(db, 'pending_applications')
  await ensureCollection(db, 'audit_logs')
  await ensureCollection(db, 'users')

  // 如果该 openid 已经是活跃员工，直接拒绝重复申请
  if (openid) {
    try {
      const existingUserRes = await db.collection('users').where({ openid }).get()
      if (existingUserRes && existingUserRes.data.length > 0) {
        const existingUser = existingUserRes.data[0]
        if (existingUser.status === 'active') {
          return { success: false, error: '您已是系统成员，无需重复申请' }
        }
        // disabled 用户允许重新申请，此处无需拦截
      }
    } catch (err) {
      if (!isMissingCollectionError(err)) throw err
    }
  }

  const applicationData = {
    deviceId: normalizedDeviceId,
    openid: openid || '',
    name: normalizedName,
    stations: normalizedStations,
    status: 'pending',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }

  let existingApp = null
  try {
    const existingRes = await db.collection('pending_applications').where({
      deviceId: normalizedDeviceId
    }).get()
    existingApp = existingRes.data[0] || null
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err
  }

  // 同一设备的待审批申请直接更新
  if (existingApp) {
    try {
      await db.collection('pending_applications').doc(existingApp._id).update({
        data: { ...applicationData, createdAt: existingApp.createdAt }
      })
    } catch (err) {
      return {
        success: false,
        error: '更新申请失败：' + (err.message || '数据库异常')
      }
    }

    try {
      await db.collection('audit_logs').add({
        data: {
          action: '更新入驻申请',
          userId: existingApp._id,
          userName: normalizedName,
          deviceId: normalizedDeviceId,
          timestamp: db.serverDate()
        }
      })
    } catch (e) { /* 非关键：审计日志写入失败不应影响主流程 */ }

    return {
      success: true,
      message: '申请已更新，请等待管理员审批',
      applicationId: existingApp._id
    }
  }

  // 新增申请
  let addRes
  try {
    addRes = await db.collection('pending_applications').add({
      data: applicationData
    })
  } catch (err) {
    return {
      success: false,
      error: '提交申请失败：' + (err.message || '数据库写入异常')
    }
  }
  const application = { _id: addRes._id, ...applicationData }

  try {
    await db.collection('audit_logs').add({
      data: {
        action: '提交入驻申请',
        userId: application._id,
        userName: normalizedName,
        deviceId: normalizedDeviceId,
        timestamp: db.serverDate()
      }
    })
  } catch (e) { /* 非关键：审计日志写入失败不应影响主流程 */ }

  return {
    success: true,
    message: '申请已提交，请等待管理员审批',
    applicationId: application._id
  }
}

const crypto = require('crypto')
// 生产环境务必在云函数环境变量中配置 TOKEN_SECRET，此处为兜底默认值
const TOKEN_SECRET = process.env.TOKEN_SECRET || (() => {
  console.error('[auth] 警告：未配置 TOKEN_SECRET 环境变量，使用随机令牌，重启后所有已登录用户需重新登录')
  return require('crypto').randomBytes(32).toString('hex')
})()

/**
 * 辅助函数：生成带 HMAC 签名的 token
 */
function generateToken(payload) {
  const payloadStr = JSON.stringify(payload)
  const payloadB64 = Buffer.from(payloadStr).toString('base64')
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('hex')
  return payloadB64 + '.' + signature
}

/**
 * 辅助函数：验证并解析 token（HMAC 防篡改）
 */
function decodeToken(token) {
  try {
    const lastDot = token.lastIndexOf('.')
    if (lastDot <= 0) return null
    const payloadB64 = token.substring(0, lastDot)
    const signature = token.substring(lastDot + 1)
    const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('hex')
    // 使用 timingSafeEqual 防止时序攻击
    if (signature.length !== expectedSig.length) return null
    const sigBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expectedSig)
    if (sigBuffer.length === 0 || expectedBuffer.length === 0) return null
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null
    return JSON.parse(Buffer.from(payloadB64, 'base64').toString())
  } catch (err) {
    return null
  }
}

/**
 * 实时检查用户访问权限（轻量级，用于前端轮询）
 * 仅返回当前状态，不生成新 token，不做写操作
 * @param {string} openid
 * @param {string} deviceId
 * @param {string} token
 */
async function checkAccess({ openid, deviceId, token }) {
  const db = getDb()
  let state = 'guest'
  let user = null

  // 优先通过 token 识别用户（最高效路径）
  if (token) {
    const decoded = decodeToken(token)
    if (decoded && decoded.userId && decoded.expiresAt && Date.now() < decoded.expiresAt) {
      try {
        const res = await db.collection('users').doc(decoded.userId).get()
        if (res && res.data) {
          const u = res.data
          if (u.status === 'active') {
            state = 'active'
          } else if (u.status === 'disabled') {
            state = 'disabled'
          } else {
            state = 'pending'
          }
          user = { id: u._id, name: u.name, role: u.role, stations: u.stations || [], status: u.status }
          return { success: true, state, user }
        }
      } catch (e) { /* token 对应的用户可能已被删除 */ }
    }
  }

  // 兜底：通过 openid 查找
  if (openid) {
    try {
      const res = await db.collection('users').where({ openid }).get()
      if (res && res.data.length > 0) {
        const u = res.data[0]
        if (u.status === 'active') state = 'active'
        else if (u.status === 'disabled') state = 'disabled'
        else state = 'pending'
        user = { id: u._id, name: u.name, role: u.role, stations: u.stations || [], status: u.status }
        return { success: true, state, user }
      }
    } catch (e) { /* users 集合不存在 */ }
  }

  // 再兜底：通过 openid 查 pending_applications
  if (!user && openid) {
    try {
      const pendingRes = await db.collection('pending_applications').where({ openid }).get()
      if (pendingRes && pendingRes.data.length > 0) {
        state = 'pending'
        const p = pendingRes.data[0]
        user = { id: p._id, name: p.name, role: 'pending', stations: p.stations || [], status: 'pending' }
      }
    } catch (e) { /* pending_applications 集合不存在 */ }
  }

  return { success: true, state, user: user || null }
}

/**
 * 用户注销
 */
async function logout(token) {
  // 可选：将 token 加入黑名单或清除相关会话数据
  return { success: true, message: '已登出' }
}
