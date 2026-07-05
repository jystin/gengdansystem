/**
 * 审批员工云函数
 * 管理员通过/驳回员工入驻申请
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 清理已审批通过的 pending_applications 记录
 * 1. 只有在 users 记录创建/更新成功后才调用，确保用户已通过
 * 2. 先将申请状态明确更新为 approved，并关联 users 中的 userId
 * 3. 状态明确为 approved 后，再物理删除 pending 记录
 * 4. 删除失败时保留 approved 状态作为兜底，保证登录等回退逻辑仍可正常定位用户
 */
async function cleanupApprovedApplication(db, applicationId, userId) {
  try {
    // 步骤1：状态明确更新为 approved，并写入关联 userId
    await db.collection('pending_applications').doc(applicationId).update({
      data: {
        status: 'approved',
        userId: userId,
        approvedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })

    // 步骤2：状态已明确为 approved，执行物理删除
    await db.collection('pending_applications').doc(applicationId).remove()

    return { success: true, message: 'pending 记录已清理' }
  } catch (err) {
    // 记录不存在（-502002）说明已被清理，视为成功
    if (err && err.errCode === -502002) {
      return { success: true, message: 'pending 记录已不存在' }
    }
    return { success: false, error: err.message || '清理 pending 记录失败' }
  }
}


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

        // ========== 清理已通过申请：状态明确为 approved 后，物理删除 pending 记录 ==========
        // 先更新 pending 状态为 approved 并关联 userId，再删除；
        // 删除失败时保留 approved 状态作为兜底，避免影响登录回退。
        const cleanupResult = await cleanupApprovedApplication(db, targetId, userDoc._id)

        // 审计日志
        try {
          await db.collection('audit_logs').add({
            data: {
              action: '审批通过',
              targetId: targetId,
              targetName: application.name,
              operatorId: admin._id,
              operatorName: admin.name,
              detail: JSON.stringify({
                userId: userDoc._id,
                pendingCleaned: cleanupResult.success,
                pendingCleanupMessage: cleanupResult.message || cleanupResult.error || ''
              }),
              createdAt: db.serverDate()
            }
          })
        } catch (e) { /* 非关键 */ }

        return {
          success: true,
          message: cleanupResult.success ? '审批通过' : '审批通过，但 pending 记录清理失败',
          employee: userDoc,
          cleanup: cleanupResult
        }
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

        // ========== 第一步：查找 users 集合中的员工 ==========
        let empRes = null
        try {
          empRes = await db.collection('users').doc(targetId).get()
        } catch (e) { /* users 集合中不存在 */ }

        if (empRes && empRes.data) {
          // 权限校验：超管可删 admin/worker；普通管理员只能删 worker
          if (empRes.data.role === 'superadmin') {
            return { success: false, error: '不能删除超级管理员' }
          }
          if (admin.role !== 'superadmin' && empRes.data.role === 'admin') {
            return { success: false, error: '仅超级管理员可删除管理员' }
          }

          // ========== 第二步：保存快照（用于审计和潜在回滚） ==========
          const userSnapshot = { ...empRes.data }
          const deletedRecord = {
            original: userSnapshot,
            deletedAt: new Date(),
            deletedBy: { id: admin._id, name: admin.name }
          }

          // ========== 第三步：物理删除 users 记录 ==========
          try {
            await db.collection('users').doc(targetId).remove()
          } catch (removeErr) {
            // 物理删除失败时降级为软删除（改 status='disabled'）
            try {
              await db.collection('users').doc(targetId).update({
                data: { status: 'disabled', updatedAt: db.serverDate() }
              })
            } catch (updateErr) {
              return { success: false, error: '删除失败：' + (removeErr.message || '数据库异常') }
            }
          }

          // ========== 第四步：清理关联的 pending_applications 记录 ==========
          const conditions = []
          if (userSnapshot.openid) conditions.push({ openid: userSnapshot.openid })
          if (userSnapshot.deviceId) conditions.push({ deviceId: userSnapshot.deviceId })
          if (userSnapshot.lastDeviceId && userSnapshot.lastDeviceId !== userSnapshot.deviceId) {
            conditions.push({ deviceId: userSnapshot.lastDeviceId })
          }

          for (const cond of conditions) {
            try {
              const related = await db.collection('pending_applications').where({
                ...cond,
                status: 'approved'
              }).get()
              for (const p of (related && related.data ? related.data : [])) {
                try {
                  await db.collection('pending_applications').doc(p._id).remove()
                } catch (e) { /* 非关键 */ }
              }
            } catch (e) { /* 非关键 */ }
          }

          // ========== 第五步：写入审计日志 ==========
          try {
            await db.collection('audit_logs').add({
              data: {
                action: '永久删除员工',
                targetId,
                targetName: userSnapshot.name,
                operatorId: admin._id,
                operatorName: admin.name,
                detail: JSON.stringify({
                  openid: userSnapshot.openid || '',
                  role: userSnapshot.role,
                  stations: userSnapshot.stations || []
                }),
                createdAt: db.serverDate()
              }
            })
          } catch (e) { /* 非关键 */ }

          return {
            success: true,
            message: '已永久删除',
            deleted: { id: targetId, name: userSnapshot.name, snapshot: deletedRecord }
          }
        }

        // ========== 第六步：未在 users 中找到，尝试 pending_applications ==========
        let pendingRes = null
        try {
          pendingRes = await db.collection('pending_applications').doc(targetId).get()
        } catch (e) { /* pending_applications 集合中不存在 */ }

        if (pendingRes && pendingRes.data) {
          const pendingSnapshot = { ...pendingRes.data }

          // 权限校验
          if (pendingSnapshot.role === 'superadmin') {
            return { success: false, error: '不能删除超级管理员' }
          }
          if (admin.role !== 'superadmin' && pendingSnapshot.role === 'admin') {
            return { success: false, error: '仅超级管理员可删除管理员申请' }
          }

          // 物理删除待审批记录
          try {
            await db.collection('pending_applications').doc(targetId).remove()
          } catch (removeErr) {
            return { success: false, error: '删除失败：' + (removeErr.message || '数据库异常') }
          }

          // 审计日志
          try {
            await db.collection('audit_logs').add({
              data: {
                action: '删除待审批员工',
                targetId,
                targetName: pendingSnapshot.name,
                operatorId: admin._id,
                operatorName: admin.name,
                createdAt: db.serverDate()
              }
            })
          } catch (e) { /* 非关键 */ }

          return {
            success: true,
            message: '已删除',
            deleted: { id: targetId, name: pendingSnapshot.name, from: 'pending' }
          }
        }

        return { success: false, error: '员工不存在' }
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
