/**
 * 系统镜像点管理云函数
 *
 * 支持操作：
 *   create   - 手动创建镜像点（保存全部业务数据）
 *   list     - 列出所有镜像点（最多 10 条）
 *   restore  - 从指定镜像点恢复数据（需二次确认）
 *   delete   - 删除指定镜像点
 *
 * 自动镜像：每 8 小时由定时器触发（config.json triggers）
 *
 * 镜像点与备份的区别：
 *   - 备份（backupManager）：每 2 小时，保留 24 份，侧重灾难恢复
 *   - 镜像（snapshotManager）：每 8 小时，保留 10 份，侧重版本回滚 + 云端同步
 *
 * 调用示例：
 *   wx.cloud.callFunction({ name: 'snapshotManager', data: { action: 'create' } })
 *   wx.cloud.callFunction({ name: 'snapshotManager', data: { action: 'list' } })
 *   wx.cloud.callFunction({ name: 'snapshotManager', data: { action: 'restore', snapshotId: 'SNAP-xxx', confirm: true } })
 *
 * 注意：手动操作仅 superadmin 可执行；定时器自动镜像无需鉴权
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 最大保留镜像点数（与 UI 说明保持一致）
const MAX_SNAPSHOTS = 10

// 需要镜像的全部业务集合
const SNAPSHOT_COLLECTIONS = [
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
  return 'SNAP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase()
}

// 权限校验：仅 superadmin
async function requireSuperAdmin(openid) {
  const res = await db.collection('users').where({ openid, role: 'superadmin' }).get()
  if (res.data.length === 0) throw new Error('仅超级管理员可执行镜像点操作')
  return res.data[0]
}

// 分页读取集合全部数据
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

// 检测集合不存在的错误
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

// 确保集合存在（多种兜底方式）
async function ensureCollection(collectionName) {
  // 方式1：count 探测
  try {
    await db.collection(collectionName).count()
    return true
  } catch (err) {
    if (!isMissingCollectionError(err)) return true
  }

  // 方式2：db.createCollection（新版 API）
  if (typeof db.createCollection === 'function') {
    try {
      await db.createCollection(collectionName)
      return true
    } catch (err) { /* 继续尝试 */ }
  }

  // 方式3：add 文档隐式创建集合
  try {
    const res = await db.collection(collectionName).add({
      data: { _init: true, createdAt: db.serverDate() }
    })
    await db.collection(collectionName).doc(res._id).remove().catch(() => {})
    return true
  } catch (err) { /* 静默 */ }

  return false
}

// ============ 记录云端同步版本号 ============
async function bumpSyncVersion(operatorName) {
  const syncVersion = Date.now()
  try {
    await ensureCollection('system_config')
    const configRes = await db.collection('system_config')
      .where({ key: 'dataVersion' })
      .get()
    if (configRes.data.length > 0) {
      await db.collection('system_config')
        .doc(configRes.data[0]._id)
        .update({
          data: {
            value: syncVersion,
            updatedAt: db.serverDate(),
            updatedBy: operatorName
          }
        })
    } else {
      await db.collection('system_config').add({
        data: {
          key: 'dataVersion',
          value: syncVersion,
          updatedAt: db.serverDate(),
          updatedBy: operatorName
        }
      })
    }
  } catch (e) {
    console.error('[snapshotManager] 同步版本写入失败:', e.message)
  }
  return syncVersion
}

// ============ 创建镜像点 ============
async function createSnapshot(operatorName) {
  await ensureCollection('snapshots')

  const snapshotId = generateId()
  const snapshots = {}
  const counts = {}
  let totalRecords = 0

  for (const col of SNAPSHOT_COLLECTIONS) {
    try {
      const data = await fetchAll(col)
      snapshots[col] = data
      counts[col] = data.length
      totalRecords += data.length
    } catch (err) {
      snapshots[col] = null
      counts[col] = 0
    }
  }

  if (totalRecords === 0) {
    return { success: false, error: '所有集合均为空，无需创建镜像点' }
  }

  const doc = {
    snapshotId,
    type: operatorName === '系统自动镜像' ? 'auto' : 'manual',
    operator: operatorName,
    counts,
    totalRecords,
    collections: snapshots,
    createdAt: db.serverDate(),
    createdAtText: formatTime()
  }

  await db.collection('snapshots').add({ data: doc })

  // 自动清理：仅保留最近 MAX_SNAPSHOTS 条
  try {
    const allSnapshots = await db.collection('snapshots')
      .orderBy('createdAt', 'desc')
      .get()
    if (allSnapshots.data.length > MAX_SNAPSHOTS) {
      const toDelete = allSnapshots.data.slice(MAX_SNAPSHOTS)
      await Promise.allSettled(
        toDelete.map(doc =>
          db.collection('snapshots').doc(doc._id).remove().catch(() => {})
        )
      )
      console.log(`[snapshotManager] 清理 ${toDelete.length} 条过期镜像点`)
    }
  } catch (e) { /* 非关键 */ }

  return {
    success: true,
    snapshotId,
    type: doc.type,
    counts,
    totalRecords,
    message: `镜像点创建完成，共 ${totalRecords} 条记录`
  }
}

// ============ 列出镜像点 ============
async function listSnapshots() {
  try {
    const res = await db.collection('snapshots')
      .orderBy('createdAt', 'desc')
      .limit(MAX_SNAPSHOTS)
      .get()

    return {
      success: true,
      total: res.data.length,
      max: MAX_SNAPSHOTS,
      snapshots: res.data.map(s => ({
        snapshotId: s.snapshotId,
        type: s.type === 'auto' ? '自动' : '手动',
        typeRaw: s.type,
        createdAt: s.createdAtText,
        operator: s.operator,
        totalRecords: s.totalRecords,
        counts: s.counts
      }))
    }
  } catch (err) {
    // 集合不存在时返回空列表，不报错
    if (isMissingCollectionError(err)) {
      return { success: true, total: 0, max: MAX_SNAPSHOTS, snapshots: [] }
    }
    throw err
  }
}

// ============ 还原镜像点 ============
async function restoreSnapshot(snapshotId, operatorName) {
  const res = await db.collection('snapshots').where({ snapshotId }).get()
  if (res.data.length === 0) throw new Error(`未找到镜像点 ${snapshotId}`)

  const snapshot = res.data[0]
  const restoreStats = {}
  let totalRestored = 0
  const errors = []

  for (const col of SNAPSHOT_COLLECTIONS) {
    const data = snapshot.collections[col]
    if (!data || data.length === 0) {
      restoreStats[col] = 0
      continue
    }

    try {
      // 清空现有数据
      const existing = await fetchAll(col)
      if (existing.length > 0) {
        await Promise.allSettled(
          existing.map(doc =>
            db.collection(col).doc(doc._id).remove().catch(() => {})
          )
        )
      }

      // 逐条恢复
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

  // ===== 云端数据同步：更新全局版本号，通知所有客户端 =====
  let syncVersion = 0
  try {
    syncVersion = await bumpSyncVersion(operatorName)
  } catch (e) {
    errors.push(`云端同步版本写入失败: ${e.message}`)
  }

  // 审计日志
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '系统镜像恢复',
        targetId: snapshotId,
        operator: operatorName,
        operatorName,
        note: `从镜像点 ${snapshotId} 恢复，共还原 ${totalRestored} 条记录，云端同步版本 v${syncVersion}`,
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return {
    success: true,
    snapshotId,
    restoreStats,
    totalRestored,
    syncVersion,
    errors: errors.length > 0 ? errors : undefined,
    message: `恢复完成！已还原 ${totalRestored} 条记录，云端数据已同步至 v${syncVersion}` +
             (errors.length > 0 ? `（${errors.length} 条异常）` : '')
  }
}

// ============ 删除镜像点 ============
async function deleteSnapshot(snapshotId) {
  const res = await db.collection('snapshots').where({ snapshotId }).get()
  if (res.data.length === 0) return { success: false, error: '未找到该镜像点' }
  await db.collection('snapshots').doc(res.data[0]._id).remove()
  return { success: true, message: `已删除镜像点 ${snapshotId}` }
}

// ============ 自动镜像（定时器触发）============
async function autoSnapshot() {
  return await createSnapshot('系统自动镜像')
}

// ============ 入口 ============
exports.main = async (event, context) => {
  const { action, snapshotId, confirm } = event || {}

  // 定时器触发 → 自动创建镜像点
  if (event && event.TriggerName) {
    console.log(`[snapshotManager] 定时器触发: ${event.TriggerName}`)
    try {
      return await autoSnapshot()
    } catch (err) {
      console.error('[snapshotManager] 自动镜像失败:', err.message)
      return { success: false, error: err.message || '自动镜像点创建失败' }
    }
  }

  // 手动操作 → 需要 superadmin 鉴权
  try {
    const wxContext = cloud.getWXContext()
    const openid = wxContext.OPENID
    const user = await requireSuperAdmin(openid)
    const operatorName = user.name || '超级管理员'

    switch (action) {
      case 'create':
        return await createSnapshot(operatorName)

      case 'list':
        return await listSnapshots()

      case 'restore': {
        if (!snapshotId) return { success: false, error: '缺少 snapshotId 参数' }
        // 二次确认保护
        if (!confirm) {
          return {
            success: false,
            error: '恢复操作将覆盖当前全部数据，请传入 confirm: true 确认执行',
            confirmRequired: true
          }
        }
        return await restoreSnapshot(snapshotId, operatorName)
      }

      case 'delete': {
        if (!snapshotId) return { success: false, error: '缺少 snapshotId 参数' }
        return await deleteSnapshot(snapshotId)
      }

      default:
        return {
          success: false,
          error: '未知操作，支持: create | list | restore | delete',
          usage: {
            create: { action: 'create' },
            list: { action: 'list' },
            restore: { action: 'restore', snapshotId: 'SNAP-xxx', confirm: true },
            delete: { action: 'delete', snapshotId: 'SNAP-xxx' }
          }
        }
    }
  } catch (err) {
    return { success: false, error: err.message || '操作失败' }
  }
}
