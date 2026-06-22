/**
 * 临时云函数：把所有 audit_logs 中 operatorName / operator 为英文的记录批量改成中文
 * 用法：右键 → 云函数测试（无需参数）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function isEnglishName(s) {
  if (!s) return false
  const n = String(s).trim()
  if (!n) return false
  if (/^(administrator|admin|root|system|user|test)$/i.test(n)) return true
  if (!/[\u4e00-\u9fa5]/.test(n) && /^[A-Za-z\s]+$/.test(n)) return true
  return false
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { success: false, error: '无 openid' }

  // 1. 找到当前用户的中文名
  const userRes = await db.collection('users').where({ openid }).get()
  if (userRes.data.length === 0) return { success: false, error: '用户不存在' }
  const user = userRes.data[0]
  const chineseName = user.name && /[\u4e00-\u9fa5]/.test(user.name) ? user.name : '江鑫（超管）'

  // 2. 同步把 users.name 改成中文（如果还是英文）
  if (!/[\u4e00-\u9fa5]/.test(user.name || '')) {
    await db.collection('users').doc(user._id).update({ data: { name: chineseName } })
  }

  // 3. 批量改 audit_logs.operatorName
  const logsRes = await db.collection('audit_logs').limit(500).get()
  let logsUpdated = 0
  for (const log of logsRes.data) {
    const needUpdate = isEnglishName(log.operatorName) || isEnglishName(log.operator)
    if (needUpdate) {
      try {
        await db.collection('audit_logs').doc(log._id).update({
          data: { operatorName: chineseName, operator: chineseName }
        })
        logsUpdated++
      } catch (e) { /* ignore */ }
    }
  }

  return { success: true, message: '批量修复完成', chineseName, logsUpdated, scanned: logsRes.data.length }
}
