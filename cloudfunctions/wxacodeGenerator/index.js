/**
 * 微信小程序码生成器
 * 直接调微信 HTTP API 生成太阳码，需配置 WX_APP_SECRET 环境变量。
 * 每个工单只生成一次，fileID 缓存到 orders.qrCodeFileID。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// ---- HTTPS 工具 ----

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('响应解析失败')) }
      })
    }).on('error', reject)
    setTimeout(() => reject(new Error('access_token 请求超时')), 10000)
  })
}

function httpsPost(url, body) {
  const postData = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const str = buf.toString('utf8')
        if (str.startsWith('{')) {
          try { reject(new Error(JSON.parse(str).errmsg || 'unknown error')) }
          catch (e) { resolve(buf) }
          return
        }
        resolve(buf)
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('wxacode 请求超时')) })
    req.write(postData)
    req.end()
  })
}

// ---- access_token（内存缓存 1.5h）----

let _tokenCache = { value: '', expireAt: 0 }

async function getAccessToken() {
  if (_tokenCache.value && Date.now() < _tokenCache.expireAt) return _tokenCache.value
  const appId = cloud.getWXContext().APPID
  const appSecret = process.env.WX_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error('缺少 WX_APP_SECRET 环境变量，请在云开发控制台（云函数 wxacodeGenerator → 配置 → 环境变量）中配置 WX_APP_SECRET = 小程序 AppSecret（微信公众平台 → 开发管理 → 开发设置）')
  }
  const result = await httpsGet(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`
  )
  if (!result.access_token) throw new Error('获取 access_token 失败')
  _tokenCache = { value: result.access_token, expireAt: Date.now() + (result.expires_in - 600) * 1000 }
  return _tokenCache.value
}

// ---- 生成小程序码 ----

async function generateWxacodeBuffer(scene) {
  const accessToken = await getAccessToken()
  const wxacodeUrl = `https://api.weixin.qq.com/wxa/getwxacode?access_token=${accessToken}`

  // 按优先级尝试：正式版 → 体验版 → 开发版
  for (const envVersion of ['release', 'trial', 'develop']) {
    try {
      return await httpsPost(wxacodeUrl, {
        path: `pages/scan/index?scene=${encodeURIComponent(scene)}`,
        env_version: envVersion,
        width: 320
      })
    } catch (err) {
      if (!err.message.includes('invalid page')) throw err
    }
  }
  throw new Error('所有版本均未找到页面 pages/scan/index，请确认代码已上传')
}

// ---- 主入口 ----

exports.main = async (event, context) => {
  const { orderId, forceRegenerate } = event
  if (!orderId || typeof orderId !== 'string' || !/^[A-Za-z0-9\-_~]{1,32}$/.test(orderId.trim())) {
    return { success: false, error: '工单号无效' }
  }

  try {
    // 非强制时优先返回缓存
    if (!forceRegenerate) {
      try {
        const orderRes = await db.collection('orders').where({ id: orderId }).get()
        if (orderRes.data.length > 0 && orderRes.data[0].qrCodeFileID) {
          return { success: true, cached: true, fileID: orderRes.data[0].qrCodeFileID }
        }
      } catch (e) { /* orders 不存在则继续 */ }
    }

    const buffer = await generateWxacodeBuffer(orderId)
    if (!buffer || buffer.length < 100) {
      return { success: false, error: '微信接口返回数据异常' }
    }

    const cloudPath = `qrcodes/${orderId}.png`
    const uploadResult = await cloud.uploadFile({ cloudPath, fileContent: buffer })

    // 写回 fileID 到订单
    try {
      const orderRes = await db.collection('orders').where({ id: orderId }).get()
      if (orderRes.data.length > 0) {
        await db.collection('orders').doc(orderRes.data[0]._id).update({
          data: { qrCodeFileID: uploadResult.fileID, updatedAt: db.serverDate() }
        })
      }
    } catch (e) { /* 非致命 */ }

    return { success: true, cached: false, fileID: uploadResult.fileID, cloudPath }
  } catch (err) {
    console.error('[wxacodeGenerator] 失败:', err.message)
    return {
      success: false,
      error: err.message || '生成失败',
      hint: '请检查：① WX_APP_SECRET 环境变量是否已配置；② 小程序代码是否已上传（页面 pages/scan/index 是否存在）；③ AppSecret 是否与当前 AppID 匹配'
    }
  }
}
