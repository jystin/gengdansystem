/**
 * 自动定时备份云函数（每1小时触发）
 * 无需用户认证，由定时器自动调用
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 最大保留备份数（24次 × 2小时/次 = 覆盖最近48小时）
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
  return 'AUTO-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase()
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

// 确保集合存在
async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).count()
    return true
  } catch (err) {
    try {
      const res = await db.collection(collectionName).add({
        data: { _init: true, createdAt: db.serverDate() }
      })
      await db.collection(collectionName).doc(res._id).remove()
      return true
    } catch (e) { return false }
  }
}

async function createAutoBackup() {
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
      snapshots[col] = null
      counts[col] = 0
    }
  }

  if (totalRecords === 0) {
    return { success: false, message: '所有集合均为空，跳过备份' }
  }

  const backupDoc = {
    backupId,
    type: 'auto',
    operator: '系统自动备份',
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
    totalRecords,
    message: `自动备份完成，共 ${totalRecords} 条记录`
  }
}

exports.main = async (event, context) => {
  try {
    return await createAutoBackup()
  } catch (err) {
    return { success: false, error: err.message || '自动备份失败' }
  }
}
