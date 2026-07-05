/**
 * 数据库备份还原云函数
 * 
 * 支持操作：
 *   backup   - 创建还原点（备份全部业务数据）
 *   restore  - 从指定还原点恢复数据
 *   list     - 列出所有还原点
 *   delete   - 删除指定还原点
 * 
 * 调用示例：
 *   wx.cloud.callFunction({ name: 'backupManager', data: { action: 'backup' } })
 *   wx.cloud.callFunction({ name: 'backupManager', data: { action: 'restore', backupId: 'xxx' } })
 *   wx.cloud.callFunction({ name: 'backupManager', data: { action: 'list' } })
 * 
 * 注意：仅 superadmin 可执行
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 最大保留备份数（与 autoBackup 保持一致）
const MAX_BACKUPS = 24

// 需要备份的集合列表
const BACKUP_COLLECTIONS = [
  'orders',
  'inventory',
  'material_logs',
  'audit_logs',
  'users',
  'processes',
  'invite_codes',
  'pending_applications'
]

function formatTime(d = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function generateId() {
  return 'BAK-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase()
}

// 权限校验
async function requireSuperAdmin(openid) {
  const res = await db.collection('users').where({ openid, role: 'superadmin' }).get()
  if (res.data.length === 0) throw new Error('仅超级管理员可执行备份还原操作')
  return res.data[0]
}

// 分页读取集合全部数据（云函数单次最多1000条）
async function fetchAll(collectionName, pageSize = 200) {
  const all = []
  let offset = 0
  while (true) {
    const res = await db.collection(collectionName).skip(offset).limit(pageSize).get()
    if (res.data.length === 0) break
    all.push(...res.data)
    offset += pageSize
  }
  return all
}

// 确保集合存在（兼容首次使用时集合未创建的场景）
async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).count()
    return true
  } catch (err) {
    // 集合不存在，尝试通过写入创建
    try {
      const res = await db.collection(collectionName).add({
        data: { _init: true, createdAt: db.serverDate() }
      })
      await db.collection(collectionName).doc(res._id).remove()
      return true
    } catch (e) {
      return false
    }
  }
}

// ============ 备份 ============
async function createBackup(operatorName) {
  // 确保 backups 集合存在
  await ensureCollection('backups')

  const backupId = generateId()
  const snapshots = {}
  const counts = {}
  let totalRecords = 0

  for (const col of BACKUP_COLLECTIONS) {
    try {
      const data = await fetchAll(col)
      snapshots[col] = data
      counts[col] = data.length
      totalRecords += data.length
    } catch (err) {
      // 集合可能不存在（新部署场景），跳过
      snapshots[col] = null
      counts[col] = 0
    }
  }

  if (totalRecords === 0) {
    return { success: false, error: '所有集合均为空，无需备份' }
  }

  const backupDoc = {
    backupId,
    type: 'full',
    operator: operatorName,
    counts,
    totalRecords,
    collections: snapshots,
    createdAt: db.serverDate(),
    createdAtText: formatTime()
  }

  await db.collection('backups').add({ data: backupDoc })

  // 自动清理旧备份（并行删除）
  try {
    const allBackups = await db.collection('backups').orderBy('createdAt', 'desc').get()
    if (allBackups.data.length > MAX_BACKUPS) {
      const toDelete = allBackups.data.slice(MAX_BACKUPS)
      await Promise.allSettled(
        toDelete.map(doc => db.collection('backups').doc(doc._id).remove().catch(() => {}))
      )
    }
  } catch (e) { /* 非关键 */ }

  return {
    success: true,
    backupId,
    counts,
    totalRecords,
    message: `备份完成，共 ${totalRecords} 条记录`
  }
}

// ============ 还原 ============
async function restoreBackup(backupId, operatorName) {
  // 查找备份记录
  const res = await db.collection('backups').where({ backupId }).get()
  if (res.data.length === 0) throw new Error(`未找到备份点 ${backupId}`)

  const backup = res.data[0]
  const restoreStats = {}
  let totalRestored = 0
  const errors = []

  // 逐集合并行清空并还原
  for (const col of BACKUP_COLLECTIONS) {
    const data = backup.collections[col]
    if (!data || data.length === 0) {
      restoreStats[col] = 0
      continue
    }

    try {
      // 清空现有数据（并行删除）
      const existing = await fetchAll(col)
      if (existing.length > 0) {
        await Promise.allSettled(
          existing.map(doc => db.collection(col).doc(doc._id).remove().catch(() => {}))
        )
      }

      // 逐条恢复（云函数不支持批量写入）
      let restored = 0
      for (const doc of data) {
        try {
          const { _id, ...rest } = doc
          await db.collection(col).add({ data: rest })
          restored++
        } catch (e) {
          errors.push(`${col}: ${e.message}`)
        }
      }

      restoreStats[col] = restored
      totalRestored += restored
    } catch (err) {
      errors.push(`${col}: ${err.message}`)
      restoreStats[col] = 0
    }
  }

  // 记录还原审计日志
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '恢复备份',
        targetId: backupId,
        operator: operatorName,
        operatorName,
        note: `从还原点 ${backupId} 恢复，共还原 ${totalRestored} 条记录`,
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return {
    success: true,
    backupId,
    restoreStats,
    totalRestored,
    errors: errors.length > 0 ? errors : undefined,
    message: `还原完成！从 ${backupId} 恢复了 ${totalRestored} 条记录` + 
             (errors.length > 0 ? `（${errors.length} 条异常）` : '')
  }
}

// ============ 列出备份点 ============
async function listBackups() {
  const res = await db.collection('backups')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()

  return {
    success: true,
    total: res.data.length,
    backups: res.data.map(b => ({
      backupId: b.backupId,
      type: b.type,
      createdAt: b.createdAtText,
      operator: b.operator,
      totalRecords: b.totalRecords,
      counts: b.counts
    }))
  }
}

// ============ 删除备份点 ============
async function deleteBackup(backupId) {
  const res = await db.collection('backups').where({ backupId }).get()
  if (res.data.length === 0) return { success: false, error: '未找到该备份点' }
  await db.collection('backups').doc(res.data[0]._id).remove()
  return { success: true, message: `已删除备份点 ${backupId}` }
}

// ============ 入口 ============
exports.main = async (event, context) => {
  const { action, backupId } = event || {}
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const user = await requireSuperAdmin(openid)
    const operatorName = user.name || '超级管理员'

    switch (action) {
      case 'backup':
        return await createBackup(operatorName)

      case 'restore': {
        if (!backupId) return { success: false, error: '缺少 backupId 参数' }
        // 还原操作增加二次确认
        if (!event.confirm) {
          return {
            success: false,
            error: '还原操作将覆盖当前全部数据，请传入 confirm: true 确认执行',
            confirmRequired: true
          }
        }
        return await restoreBackup(backupId, operatorName)
      }

      case 'list':
        return await listBackups()

      case 'delete': {
        if (!backupId) return { success: false, error: '缺少 backupId 参数' }
        return await deleteBackup(backupId)
      }

      default:
        return {
          success: false,
          error: '未知操作，支持: backup | restore | list | delete',
          usage: {
            backup: { action: 'backup' },
            restore: { action: 'restore', backupId: 'BAK-xxx', confirm: true },
            list: { action: 'list' },
            delete: { action: 'delete', backupId: 'BAK-xxx' }
          }
        }
    }
  } catch (err) {
    return { success: false, error: err.message || '操作失败' }
  }
}
