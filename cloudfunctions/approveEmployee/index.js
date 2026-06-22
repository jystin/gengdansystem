/**
 * 审批员工云函数
 * 管理员通过/驳回员工入驻申请
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { action, applicationId, employeeId, operatorId } = event

    // 权限校验
    const adminRes = await db.collection('users').where({ openid }).get()
    if (adminRes.data.length === 0) return { success: false, error: '管理员不存在' }
    const admin = adminRes.data[0]
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return { success: false, error: '仅管理员可审批员工' }
    }

    switch (action) {
      case 'approve': {
        const targetId = applicationId || employeeId
        if (!targetId) return { success: false, error: '缺少申请ID' }

        // 查询待审批申请
        let appRes
        try {
          appRes = await db.collection('pending_applications').doc(targetId).get()
        } catch (err) {
          return { success: false, error: '申请记录不存在' }
        }

        const application = appRes.data
        if (application.status === 'approved') {
          return { success: false, error: '该申请已审批' }
        }

        // 创建/更新 users 集合中的用户
        let userDoc
        if (application.openid) {
          const existingUser = await db.collection('users').where({ openid: application.openid }).get()
          if (existingUser.data.length > 0) {
            // 更新已有用户
            userDoc = existingUser.data[0]
            await db.collection('users').doc(userDoc._id).update({
              data: {
                status: 'active',
                role: 'worker',
                stations: application.stations || [],
                name: application.name,
                updatedAt: db.serverDate()
              }
            })
          } else {
            // 创建新用户
            const newUser = {
              openid: application.openid,
              name: application.name,
              role: 'worker',
              stations: application.stations || [],
              status: 'active',
              createdAt: db.serverDate(),
              lastLoginAt: null,
              lastDeviceId: application.deviceId || ''
            }
            const addRes = await db.collection('users').add({ data: newUser })
            userDoc = { _id: addRes._id, ...newUser }
          }
        } else {
          // 无openid（通过邀请码申请的），也创建用户记录
          const newUser = {
            name: application.name,
            role: 'worker',
            stations: application.stations || [],
            status: 'active',
            deviceId: application.deviceId || '',
            createdAt: db.serverDate(),
            lastLoginAt: null,
            lastDeviceId: application.deviceId || ''
          }
          const addRes = await db.collection('users').add({ data: newUser })
          userDoc = { _id: addRes._id, ...newUser }
        }

        // 更新申请状态，记录 userId 供后续登录回退匹配
        await db.collection('pending_applications').doc(targetId).update({
          data: {
            status: 'approved',
            userId: userDoc._id,
            updatedAt: db.serverDate()
          }
        })

        // 审计日志
        try {
          await db.collection('audit_logs').add({
            data: {
              action: '审批通过',
              targetId: targetId,
              targetName: application.name,
              operatorId: admin._id,
              operatorName: admin.name,
              createdAt: db.serverDate()
            }
          })
        } catch (e) { /* 非关键 */ }

        return { success: true, message: '审批通过', employee: userDoc }
      }

      case 'reject': {
        const targetId = applicationId || employeeId
        if (!targetId) return { success: false, error: '缺少申请ID' }

        // 更新申请状态为驳回
        try {
          await db.collection('pending_applications').doc(targetId).update({
            data: {
              status: 'rejected',
              updatedAt: db.serverDate()
            }
          })
        } catch (err) {
          return { success: false, error: '申请记录不存在或已处理' }
        }

        return { success: true, message: '已驳回' }
      }

      case 'delete': {
        const targetId = employeeId
        if (!targetId) return { success: false, error: '缺少员工ID' }

        // 仅 superadmin 可删除
        if (admin.role !== 'superadmin') {
          return { success: false, error: '仅超级管理员可删除员工' }
        }

        const empRes = await db.collection('users').doc(targetId).get()
        if (!empRes.data) return { success: false, error: '员工不存在' }
        if (empRes.data.role === 'superadmin') {
          return { success: false, error: '不能删除超级管理员' }
        }

        await db.collection('users').doc(targetId).update({
          data: {
            status: 'disabled',
            updatedAt: db.serverDate()
          }
        })

        return { success: true, message: '已删除' }
      }

      default:
        return { success: false, error: '未知操作类型，支持: approve / reject / delete' }
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || '审批操作失败'
    }
  }
}
