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
 *   - createInviteCode: 管理员生成一次性邀请码（需要权限检查）
 *   - submitJoinApplication: 外部用户申请入驻（扫码进入，无需邀请码）
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
      
      case 'logout':
        return await logout(token)
      
      case 'createInviteCode':
        return await createInviteCode({
          token: token,
          expiresIn: safeEvent.expiresIn,
          maxUses: safeEvent.maxUses
        })

      case 'generateJoinQRCode':
        return await generateJoinQRCode({ token: safeEvent.token, force: !!safeEvent.force })
      
      case 'submitJoinApplication':
        return await submitJoinApplication({
          deviceId: deviceId,
          name: safeEvent.name,
          stations: safeEvent.stations,
          note: safeEvent.note,
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
  
  // 如果 openid 匹配不到用户，尝试通过 deviceId 在 pending_applications 中找到已审批的申请
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
 * 生成一次性邀请码（仅管理员）
 * @param {string} token - 管理员 token
 * @param {number} expiresIn - 有效期（秒，默认 86400 = 1 天）
 * @param {number} maxUses - 最多使用次数（0 = 无限制，默认 1 = 仅一次）
 */
async function createInviteCode({ token, expiresIn = 86400, maxUses = 1 }) {
  const db = getDb()
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
 * 外部用户申请入驻（扫码进入，无需邀请码）
 * @param {string} deviceId - 设备 ID
 * @param {string} name - 申请人名字
 * @param {string} note - 备注
 */
async function submitJoinApplication({ deviceId, name, note, openid }) {
  const normalizedDeviceId = String(deviceId || '').trim()
  const normalizedName = String(name || '').trim()
  const normalizedNote = String(note || '').trim()

  if (!normalizedDeviceId || !normalizedName) {
    return { success: false, error: '缺少必要字段' }
  }

  const db = getDb()

  // 同一设备的待审批申请直接更新
  const existingRes = await db.collection('pending_applications').where({
    deviceId: normalizedDeviceId
  }).get()

  if (existingRes.data.length > 0) {
    const existingApp = existingRes.data[0]
    await db.collection('pending_applications').doc(existingApp._id).update({
      data: {
        name: normalizedName,
        note: normalizedNote,
        openid: openid || '',
        status: 'pending',
        updatedAt: db.serverDate()
      }
    })

    await db.collection('audit_logs').add({
      data: {
        action: '更新入驻申请',
        userId: existingApp._id,
        userName: normalizedName,
        deviceId: normalizedDeviceId,
        timestamp: db.serverDate()
      }
    })

    return {
      success: true,
      message: '申请已更新，请等待管理员审批',
      applicationId: existingApp._id
    }
  }

  // 新增申请
  const application = await db.collection('pending_applications').add({
    data: {
      deviceId: normalizedDeviceId,
      openid: openid || '',
      name: normalizedName,
      stations: [],
      note: normalizedNote,
      status: 'pending',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  // 记录审计日志
  await db.collection('audit_logs').add({
    data: {
      action: '提交入驻申请',
      userId: application._id,
      userName: normalizedName,
      deviceId: normalizedDeviceId,
      timestamp: db.serverDate()
    }
  })

  return {
    success: true,
    message: '申请已提交，请等待管理员审批',
    applicationId: application._id
  }
}

const crypto = require('crypto')
// 生产环境请在云函数环境变量中配置 TOKEN_SECRET，此处为开发默认值
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'xingxiang_machinery_tracking_secret_2026_salt'

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
 * HTTPS GET 辅助函数（获取 access_token）
 */
function _httpsGet(url) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _httpsGet(res.headers.location).then(resolve).catch(reject)
        return res.resume()
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

/**
 * 获取微信 access_token（用于 HTTP 调用 wxacode 接口）
 * 优先级：cloud.getAccessToken() > 环境变量 appid/secret > 返回空
 */
async function _getAccessToken(cloud) {
  // 方式1: cloud.getAccessToken()（部分 SDK 版本）
  if (typeof cloud.getAccessToken === 'function') {
    try {
      const t = await cloud.getAccessToken()
      const token = (t && typeof t === 'string' && t.length > 10) ? t : ((t && t.access_token) ? t.access_token : '')
      if (token) return token
    } catch (e) { /* 静默处理 */ }
  }

  // 方式2: 环境变量 WX_APPID + WX_APPSECRET
  const appId = process.env.WX_APPID || ''
  const secret = process.env.WX_APPSECRET || ''
  if (appId && secret) {
    try {
      const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
      const body = JSON.parse((await _httpsGet(tokenUrl)).toString())
      if (body.access_token) return body.access_token
    } catch (e) { /* 静默处理 */ }
  }

  return ''
}

/**
 * 生成入驻小程序码 — 使用微信官方接口生成真正的小程序码
 */
async function generateJoinQRCode({ token, force = false }) {
  const db = getDb()
  const cloud = getCloud()

  const verified = await verifyToken(token)
  if (!verified.success || (verified.user.role !== 'admin' && verified.user.role !== 'superadmin')) {
    return { success: false, error: '仅管理员可生成入驻二维码' }
  }

  const DB_QR = 'join_qrcodes'

  // 非强制刷新时，复用已有有效二维码（1天内）
  if (!force) {
    try {
      const existingRes = await db.collection('invite_codes').where({
        createdBy: verified.user.id, isActive: true, type: 'join_qrcode'
      }).orderBy('createdAt', 'desc').limit(1).get()
      if (existingRes.data.length > 0) {
        const existing = existingRes.data[0]
        if (existing.expiresAt && new Date(existing.expiresAt) > new Date()) {
          const qrCheck = await cloud.database().collection(DB_QR).where({ inviteCode: existing.code }).limit(1).get().catch(() => ({ data: [] }))
          if (qrCheck.data.length > 0) {
            return { success: true, fileID: qrCheck.data[0].fileID, inviteCode: existing.code, invitePath: `/pages/join/index?invite=${existing.code}` }
          }
        }
      }
    } catch (e) { /* 集合可能不存在 */ }
  }

  // 创建新邀请码
  const inviteCode = generateInviteCode()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.collection('invite_codes').add({
    data: { code: inviteCode, createdBy: verified.user.id, type: 'join_qrcode', createdAt: db.serverDate(), expiresAt, maxUses: 0, usedCount: 0, isActive: true }
  })

  // ====== 方式A：cloud.openapi（推荐，SDK 原生） ======
  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: inviteCode, page: 'pages/join/index', width: 280,
      autoColor: false, lineColor: { r: 15, g: 118, b: 110 }, isHyaline: false,
      envVersion: 'develop',
      checkPath: false  // 跳过路径校验，强制生成
    })
    if (result && result.buffer && result.buffer.length > 500) {
      return await _saveAndReturn(cloud, db, DB_QR, inviteCode, verified.user.id, result.buffer)
    }
  } catch (errA) { /* 继续尝试其他方式 */ }

  // ====== 方式A2：换用 get（生成普通小程序码，有数量限制但通常更可靠） ======
  try {
    const result2 = await cloud.openapi.wxacode.get({
      path: `pages/join/index?invite=${encodeURIComponent(inviteCode)}`,
      width: 280,
      autoColor: false, lineColor: { r: 15, g: 118, b: 110 }, isHyaline: false,
      envVersion: 'develop'
    })
    if (result2 && result2.buffer && result2.buffer.length > 500) {
      return await _saveAndReturn(cloud, db, DB_QR, inviteCode, verified.user.id, result2.buffer)
    }
  } catch (errA2) { /* 继续尝试其他方式 */ }

  // ====== 方式B：cloud.openApi（大写A，兼容旧版） ======
  try {
    if (cloud.openApi && cloud.openApi.wxacode) {
      const result = await cloud.openApi.wxacode.getUnlimited({
        scene: inviteCode, page: 'pages/join/index', width: 280,
        autoColor: false, lineColor: { r: 15, g: 118, b: 110 }, isHyaline: false,
        envVersion: 'develop', checkPath: false
      })
      if (result && result.buffer && result.buffer.length > 500) {
        return await _saveAndReturn(cloud, db, DB_QR, inviteCode, verified.user.id, result.buffer)
      }
    }
  } catch (errB) { /* 继续尝试其他方式 */ }

  // ====== 方式C：HTTP 直接调用微信 API（getUnlimited） ======
  try {
    const accessToken = await _getAccessToken(cloud)
    if (!accessToken) throw new Error('无access_token')

    const https = require('https')
    const postData = JSON.stringify({
      scene: inviteCode, page: 'pages/join/index', width: 280,
      auto_color: false, line_color: { r: 15, g: 118, b: 110 }, is_hyaline: false,
      env_version: 'develop', check_path: false
    })

    const buffer = await new Promise((resolve, reject) => {
      const u = new URL(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`)
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const ct = (res.headers['content-type'] || '').toLowerCase()
          if (ct.includes('image') || buf.length > 3000) resolve(buf)
          else {
            let msg = buf.toString('utf-8').substring(0, 500)
            try { const j = JSON.parse(msg); msg = j.errmsg || ('errcode:' + j.errcode) } catch(e) {}
            reject(new Error('HTTP getUnlimited错误: ' + msg))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP超时')) })
      req.write(postData); req.end()
    })

    if (buffer && buffer.length > 500) {
      return await _saveAndReturn(cloud, db, DB_QR, inviteCode, verified.user.id, buffer)
    }
  } catch (errC) { /* 继续尝试其他方式 */ }

  // ====== 方式C2：HTTP 调用 wxacode.get（普通小程序码） ======
  try {
    const accessToken = await _getAccessToken(cloud)
    if (!accessToken) throw new Error('无access_token')

    const https = require('https')
    const postData2 = JSON.stringify({
      path: `pages/join/index?invite=${encodeURIComponent(inviteCode)}`,
      width: 280,
      auto_color: false, line_color: { r: 15, g: 118, b: 110 }, is_hyaline: false,
      env_version: 'develop'
    })

    const buffer2 = await new Promise((resolve, reject) => {
      const u2 = new URL(`https://api.weixin.qq.com/wxa/getwxacode?access_token=${encodeURIComponent(accessToken)}`)
      const req2 = https.request({
        hostname: u2.hostname, path: u2.pathname + u2.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData2) }
      }, res2 => {
        const chunks2 = []
        res2.on('data', c => chunks2.push(c))
        res2.on('end', () => {
          const buf2 = Buffer.concat(chunks2)
          const ct2 = (res2.headers['content-type'] || '').toLowerCase()
          if (ct2.includes('image') || buf2.length > 3000) resolve(buf2)
          else {
            let msg2 = buf2.toString('utf-8').substring(0, 500)
            try { const j = JSON.parse(msg2); msg2 = j.errmsg || ('errcode:' + j.errcode) } catch(e) {}
            reject(new Error('HTTP get错误: ' + msg2))
          }
        })
      })
      req2.on('error', reject)
      req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('HTTP超时')) })
      req2.write(postData2); req2.end()
    })

    if (buffer2 && buffer2.length > 500) {
      return await _saveAndReturn(cloud, db, DB_QR, inviteCode, verified.user.id, buffer2)
    }
  } catch (errC2) { /* 静默处理 */ }

  return { success: false, error: '无法生成小程序码，请检查云函数配置' }
}

/** 上传小程序码到云存储并记录 */
async function _saveAndReturn(cloud, db, DB_QR, inviteCode, userId, buffer) {
  const cloudPath = `qrcodes/join_${Date.now()}.png`
  const uploadResult = await cloud.uploadFile({ cloudPath, fileContent: buffer })
  try { await db.collection(DB_QR).count() } catch(e) { await db.createCollection(DB_QR).catch(() => {}) }
  await db.collection(DB_QR).add({
    data: { inviteCode, fileID: uploadResult.fileID, cloudPath, createdBy: userId, createdAt: db.serverDate() }
  })
  return { success: true, fileID: uploadResult.fileID, inviteCode, invitePath: `/pages/join/index?invite=${inviteCode}` }
}

/**
 * 用户注销
 */
async function logout(token) {
  // 可选：将 token 加入黑名单或清除相关会话数据
  return { success: true, message: '已登出' }
}
