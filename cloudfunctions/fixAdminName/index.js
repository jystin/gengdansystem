/**
 * 临时云函数：把当前 openid 用户的 name 改成 "江鑫（超管）"
 * 仅在调试/迁移时使用
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { success: false, error: '无 openid' }

  const res = await db.collection('users').where({ openid }).get()
  if (res.data.length === 0) {
    return { success: false, error: '当前用户不存在' }
  }
  const user = res.data[0]
  const before = user.name
  await db.collection('users').doc(user._id).update({
    data: { name: '江鑫（超管）' }
  })
  return { success: true, message: '已更新', before, after: '江鑫（超管）' }
}
