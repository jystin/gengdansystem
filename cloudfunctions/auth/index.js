/**
 * 生产环境鉴权与会话管理云函数示例
 * 用微信 openid + 数据库替代本地 mock-store 的 sessionUserId
 * 
 * 使用方式：
 * 1. 在微信小程序后台配置该云函数
 * 2. 在小程序中调用 wx.cloud.callFunction({ name: 'auth', data: { action: 'login' } })
 * 3. 返回的 token 写入本地存储，后续 API 调用时在 header 中携带
 */

const cloud = require('wx-server-sdk')
const db = cloud.database()

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

/**
 * 主入口
 * 支持的 action:
 *   - login: 用 openid 登录或注册（需 openid 和可选的 deviceId）
 *   - verify: 验证 token 有效性
 *   - logout: 清除会话
 *   - createInviteCode: 管理员生成一次性邀请码（需要权限检查）
 *   - submitJoinApplication: 外部用户申请入驻（需要邀请码）
 */
exports.main = async (event, context) => {
  const { action, token, openid, deviceId, inviteCode, ...payload } = event
  
  try {
    switch (action) {
      case 'login':
        return await login({ openid, deviceId })
      
      case 'verify':
        return await verifyToken(token)
      
      case 'logout':
        return await logout(token)
      
      case 'createInviteCode':
        return await createInviteCode({ token, ...payload })
      
      case 'submitJoinApplication':
        return await submitJoinApplication({ deviceId, inviteCode, ...payload })
      
      default:
        return { success: false, error: '未知的操作类型' }
    }
  } catch (err) {
    console.error('[auth error]', err)
    return { success: false, error: err.message || '服务器错误' }
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

  // 查询用户是否存在于数据库
  const res = await db.collection('users').where({
    openid: openid
  }).get()

  let user = res.data[0]
  
  if (!user) {
    // 用户不存在，检查是否通过邀请码申请过
    const pendingRes = await db.collection('pending_applications').where({
      openid: openid
    }).get()

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
    return {
      success: true,
      state: 'pending',
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        stations: user.stations || [],
        status: user.status
      },
      token: null,
      message: '账号尚未被管理员审批激活'
    }
  }

  // 生成 JWT token（生产环境请使用签名算法）
  const token = generateToken({ userId: user._id, openid: openid })

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

  // 在生产环境中验证 JWT 签名
  // 这里示例省略，实际应使用 jsonwebtoken 库
  const decoded = decodeToken(token)
  if (!decoded) {
    return { success: false, error: 'token 无效或过期' }
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
 * 生成一次性邀请码（仅管理员）
 * @param {string} token - 管理员 token
 * @param {number} expiresIn - 有效期（秒，默认 86400 = 1 天）
 * @param {number} maxUses - 最多使用次数（0 = 无限制，默认 1 = 仅一次）
 */
async function createInviteCode({ token, expiresIn = 86400, maxUses = 1 }) {
  const verified = await verifyToken(token)
  if (!verified.success || (verified.user.role !== 'admin' && verified.user.role !== 'superadmin')) {
    return { success: false, error: '仅管理员可创建邀请码' }
  }

  // 生成邀请码（建议使用随机字符串或 UUID）
  const inviteCode = generateInviteCode()
  const expiresAt = new Date(Date.now() + expiresIn * 1000)

  await db.collection('invite_codes').add({
    data: {
      code: inviteCode,
      createdBy: verified.user.id,
      createdAt: db.serverDate(),
      expiresAt: expiresAt,
      maxUses: maxUses,
      usedCount: 0,
      isActive: true
    }
  })

  return {
    success: true,
    inviteCode: inviteCode,
    expiresAt: expiresAt.toISOString(),
    maxUses: maxUses
  }
}

/**
 * 外部用户通过邀请码申请入驻
 * @param {string} deviceId - 设备 ID
 * @param {string} inviteCode - 邀请码
 * @param {string} name - 申请人名字
 * @param {array} stations - 岗位列表
 * @param {string} note - 备注
 */
async function submitJoinApplication({ deviceId, inviteCode, name, stations, note, openid }) {
  if (!inviteCode || !name || !stations || stations.length === 0) {
    return { success: false, error: '缺少必要字段' }
  }

  // 验证邀请码
  const codeRes = await db.collection('invite_codes').where({
    code: inviteCode,
    isActive: true
  }).get()

  if (codeRes.data.length === 0) {
    return { success: false, error: '邀请码无效或已过期' }
  }

  const inviteRecord = codeRes.data[0]
  const now = new Date()

  if (inviteRecord.expiresAt < now) {
    return { success: false, error: '邀请码已过期' }
  }

  if (inviteRecord.maxUses > 0 && inviteRecord.usedCount >= inviteRecord.maxUses) {
    return { success: false, error: '邀请码已达使用次数上限' }
  }

  // 检查该设备 ID 是否已有待审批或已激活的申请
  const existingRes = await db.collection('pending_applications').where({
    deviceId: deviceId
  }).get()

  let application = null
  if (existingRes.data.length > 0) {
    // 更新现有申请
    const appId = existingRes.data[0]._id
    await db.collection('pending_applications').doc(appId).update({
      data: {
        name: name,
        stations: stations,
        note: note,
        updatedAt: db.serverDate()
      }
    })
    application = { _id: appId }
  } else {
    // 新增申请
    const addRes = await db.collection('pending_applications').add({
      data: {
        deviceId: deviceId,
        openid: openid || '',
        name: name,
        stations: stations,
        note: note || '',
        status: 'pending',
        inviteCodeUsed: inviteCode,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    application = addRes
  }

  // 增加邀请码的使用计数
  await db.collection('invite_codes').doc(inviteRecord._id).update({
    data: {
      usedCount: inviteRecord.usedCount + 1
    }
  })

  // 记录审计日志
  await db.collection('audit_logs').add({
    data: {
      action: 'submit_join_application',
      userId: application._id,
      userName: name,
      deviceId: deviceId,
      inviteCodeUsed: inviteCode,
      timestamp: db.serverDate()
    }
  })

  return {
    success: true,
    message: '申请已提交，请等待管理员审批',
    applicationId: application._id
  }
}

/**
 * 辅助函数：生成 JWT token（简化示例，生产应使用正式库）
 */
function generateToken(payload) {
  // 这里是简化示例，生产环境应使用 jsonwebtoken 库或微信的官方方案
  // 例：const jwt = require('jsonwebtoken'); return jwt.sign(payload, SECRET, { expiresIn: '7d' })
  return Buffer.from(JSON.stringify(payload)).toString('base64') + '.' + Date.now()
}

/**
 * 辅助函数：解析 token（简化示例）
 */
function decodeToken(token) {
  try {
    const [payload] = token.split('.')
    return JSON.parse(Buffer.from(payload, 'base64').toString())
  } catch {
    return null
  }
}

/**
 * 辅助函数：生成邀请码
 */
function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = 'INV-'
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

/**
 * 用户注销
 */
async function logout(token) {
  // 可选：将 token 加入黑名单或清除相关会话数据
  return { success: true, message: '已登出' }
}
