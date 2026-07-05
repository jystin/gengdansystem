/**
 * 数据库初始化
 * 仅首次部署时调用，执行后自动标记为已完成
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'init-db', data: { adminOpenid: '你的openid' } })
 *
 * 安全机制：写入 _system_config 标记防止重复执行
 */

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 首次执行前检查是否已完成初始化
async function checkIfAlreadyInitialized() {
  try {
    const cfg = await db.collection('_system_config').doc('init_db_done').get()
    if (cfg && cfg.data && cfg.data.done) {
      return true
    }
  } catch (_) { /* 集合或记录不存在，可以继续 */ }
  return false
}

async function markAsInitialized() {
  try {
    await db.collection('_system_config').add({
      data: { _id: 'init_db_done', done: true, completedAt: db.serverDate() }
    })
  } catch (_) {
    // 记录已存在，尝试更新
    try {
      await db.collection('_system_config').doc('init_db_done').update({
        data: { done: true, completedAt: db.serverDate() }
      })
    } catch (_) { /* 忽略 */ }
  }
}

function isMissingCollectionError(err) {
  if (!err) return false
  const msg = String(err.errMsg || err.message || '')
  return (
    err.errCode === -502005 ||
    err.errCode === -502001 ||
    msg.includes('not exist') ||
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('Database or Table')
  )
}

async function safeGet(collectionName, queryBuilder) {
  try {
    return await queryBuilder(db.collection(collectionName))
  } catch (err) {
    if (isMissingCollectionError(err)) {
      return { data: [] }
    }
    throw err
  }
}

async function safeCount(collectionName) {
  try {
    return await db.collection(collectionName).count()
  } catch (err) {
    if (isMissingCollectionError(err)) {
      return { total: 0 }
    }
    throw err
  }
}

async function ensureCollection(collectionName) {
  // 方式1：尝试 count 检测集合是否存在
  try {
    await db.collection(collectionName).count()
    return true
  } catch (err) {
    if (!isMissingCollectionError(err)) return true
  }

  // 方式2：尝试 db.createCollection（新版 API）
  if (typeof db.createCollection === 'function') {
    try {
      await db.createCollection(collectionName)
      return true
    } catch (err) { /* 继续尝试其他方式 */ }
  }

  // 方式3：尝试 add 文档来隐式创建集合
  try {
    const res = await db.collection(collectionName).add({
      data: { _init: true, createdAt: db.serverDate() }
    })
    // 清理初始化文档
    await db.collection(collectionName).doc(res._id).remove()
    return true
  } catch (err) { /* 静默处理 */ }

  // 全部失败
  return false
}

exports.main = async (event, context) => {
  // 安全机制：检查是否已初始化，防止重复执行污染数据
  if (!event.force) {
    const alreadyDone = await checkIfAlreadyInitialized()
    if (alreadyDone) {
      return { success: false, error: '数据库已初始化，若需强制重新初始化请传入 force: true' }
    }
  }

  const { adminOpenid, adminName = '江鑫（超管）', resetInventory } = event || {}
  const wxContext = cloud.getWXContext()
  const resolvedAdminOpenid = adminOpenid || wxContext.OPENID

  if (!resolvedAdminOpenid) {
    return { 
      success: false, 
      error: '缺少 adminOpenid 参数，且未能从云函数上下文获取 OPENID'
    }
  }

  try {
    // 第零步：确保所需集合存在
    const requiredCollections = ['processes', 'users', 'inventory', 'audit_logs', 'orders', 'material_logs', 'pending_applications', 'invite_codes', 'backups', 'daily_counters', 'join_qrcodes', 'snapshots', 'system_config']
    const failedCollections = []
    for (const col of requiredCollections) {
      const ok = await ensureCollection(col)
      if (!ok) {
        failedCollections.push(col)
      }
    }

    if (failedCollections.length > 0) {
      return {
        success: false,
        error: `以下集合需手动创建：${failedCollections.join('、')}`,
        missingCollections: failedCollections,
        action: '请在微信开发者工具 → 云开发控制台 → 数据库 → 新建集合，逐个创建上述集合后重新调用 init-db。无需任何配置，保持默认权限即可。'
      }
    }

    // 第一步：初始化工序库
    const processes = [
      { key: 'blanking', name: '下料', station: '下料工' },
      { key: 'pressing', name: '敦压', station: '敦压工' },
      { key: 'programming', name: '编程', station: '编程工' },
      { key: 'pulling_tail', name: '拉尾子', station: '拉尾工' },
      { key: 'finish_turning', name: '精车', station: '精车工' },
      { key: 'milling_head', name: '铣方头', station: '铣床工' },
      { key: 'tapping', name: '攻丝', station: '攻丝工' },
      { key: 'drilling_head', name: '打方头孔', station: '钻床工' },
      { key: 'tapping_repeat', name: '攻丝（复攻）', station: '攻丝工' },
      { key: 'threading', name: '压螺纹', station: '螺纹工' },
      { key: 'polishing', name: '压光', station: '抛光工' },
      { key: 'marking', name: '打字', station: '打字工' },
      { key: 'heat_treatment', name: '热处理', station: '热处理工' },
      { key: 'quality_check', name: '质检', station: '质检员' },
      { key: 'warehouse', name: '入库', station: '仓管员' }
    ]

    // 检查是否已初始化
    const existingProcesses = await safeGet('processes', collection => collection.limit(1).get())
    if (existingProcesses.data.length === 0) {
      for (const proc of processes) {
        await db.collection('processes').add({ data: proc })
      }
    }

    // 第二步：初始化超级管理员账号
    const existingAdmin = await safeGet('users', collection => collection.where({
      openid: resolvedAdminOpenid
    }).get())

    if (existingAdmin.data.length === 0) {
      const admin = {
        openid: resolvedAdminOpenid,
        name: adminName,
        role: 'superadmin',
        stations: ['超级管理员'],
        status: 'active',
        createdAt: db.serverDate(),
        lastLoginAt: null,
        lastDeviceId: ''
      }
      await db.collection('users').add({ data: admin })
    }

    // 第三步：初始化材料类型与库存
    const materials = [
      { name: '不锈钢420', stock: {} },
      { name: '不锈钢304', stock: {} },
      { name: '不锈钢316', stock: {} },
      { name: '不锈钢431', stock: {} },
      { name: '铜', stock: {} },
      { name: '双相钢', stock: {} }
    ]

    const existingInventory = await safeGet('inventory', collection => collection.limit(1).get())
    if (resetInventory && existingInventory.data.length > 0) {
      // 强制重置：先清空库存和日志，再插入空数据
      try {
        // 逐条删除（云开发不支持直接清空集合）
        const allInv = await safeGet('inventory', collection => collection.get())
        for (const doc of allInv.data) {
          await db.collection('inventory').doc(doc._id).remove()
        }
        // 同时清理材料操作日志
        const allLogs = await safeGet('material_logs', collection => collection.get())
        for (const doc of allLogs.data) {
          await db.collection('material_logs').doc(doc._id).remove()
        }
      } catch (e) { /* 静默处理 */ }
    }
    if (existingInventory.data.length === 0 || resetInventory) {
      for (const mat of materials) {
        await db.collection('inventory').add({
          data: {
            name: mat.name,
            stock: mat.stock,
            createdAt: db.serverDate(),
            lastUpdatedAt: db.serverDate()
          }
        })
      }
    }

    // 第四步：初始化审计日志（可选）
    const existingLogs = await safeCount('audit_logs')

    // 标记初始化完成，防止重复执行
    await markAsInitialized()

    // 返回初始化报告
    return {
      success: true,
      message: '数据库初始化完成！',
      summary: {
        processes: processes.length,
        admin: { name: adminName, openid: resolvedAdminOpenid },
        materials: materials.length,
        timestamp: new Date().toISOString()
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      details: err
    }
  }
}
