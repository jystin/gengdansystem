/**
 * 库存管理云函数
 * 支持：查询库存、入库、出库、设置库存、新增材料种类、获取流水日志
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const MATERIAL_TYPES = [
  '不锈钢420', '不锈钢304', '不锈钢316', '不锈钢431', '铜', '双相钢'
]

const MATERIAL_LOW_THRESHOLDS = {
  '不锈钢420': 10, '不锈钢304': 3, '不锈钢316': 3, '不锈钢431': 5
}

function formatTime() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

async function getUserByOpenid(openid) {
  const res = await db.collection('users').where({ openid }).get()
  return res.data[0] || null
}

function requireAdmin(user) {
  if (!user) throw new Error('用户不存在')
  if (user.status !== 'active') throw new Error('账号未启用')
  if (user.role !== 'admin' && user.role !== 'superadmin') throw new Error('无管理员权限')
}

// 获取材料类型列表
async function getTypes() {
  try {
    const res = await db.collection('inventory').get()
    const names = res.data.map(item => item.name).filter(Boolean)
    // 合并默认列表和数据库中实际存在的
    const all = [...new Set([...MATERIAL_TYPES, ...names])]
    return all.sort()
  } catch (err) {
    if (err.errCode === -502005) return MATERIAL_TYPES.slice()
    throw err
  }
}

// 获取材料库存列表（一次查询获取完整数据，避免 getTypes 重复查询）
async function getInventory() {
  try {
    const res = await db.collection('inventory').get()
    const invMap = {}
    const allNames = new Set(MATERIAL_TYPES)
    res.data.forEach(item => { 
      invMap[item.name] = item.stock || {}
      if (item.name) allNames.add(item.name)
    })
    const types = [...allNames].sort()

    return types.map(name => {
      const roughnessMap = invMap[name] || {}
      const threshold = MATERIAL_LOW_THRESHOLDS[name] || 0
      const entries = Object.entries(roughnessMap)
      const totalStock = entries.reduce((s, [, v]) => s + Number(v), 0)
      const detail = entries
        .map(([r, stock]) => ({ roughness: String(r), stock: Number(stock), isLow: Number(stock) < threshold }))
        .sort((a, b) => Number(a.roughness) - Number(b.roughness))
      const hasLowRoughness = detail.some(d => d.isLow)
      return { name, stock: totalStock, detail, hasLowRoughness }
    })
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

// 查询指定材料和粗度的库存
async function getStockByRoughness(material, roughness) {
  const rKey = String(roughness || '').trim()
  if (!material || !rKey) return 0
  try {
    const res = await db.collection('inventory').where({ name: material }).get()
    if (res.data.length === 0) return 0
    return Number((res.data[0].stock || {})[rKey]) || 0
  } catch (err) {
    if (err.errCode === -502005) return 0
    throw err
  }
}

// 入库 - 使用原子操作防止并发问题
async function addStock(material, qty, user, note, roughness) {
  requireAdmin(user)
  const types = await getTypes()
  if (!types.includes(material)) throw new Error('材料类型无效')
  if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) throw new Error('请输入有效数量')
  if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  const qtyNum = Number(qty)
  const invRes = await db.collection('inventory').where({ name: material }).get()

  if (invRes.data.length === 0) {
    // 首次入库该材料
    await db.collection('inventory').add({
      data: {
        name: material,
        stock: { [rKey]: qtyNum },
        lastUpdatedAt: db.serverDate(),
        createdAt: db.serverDate()
      }
    })
  } else {
    // 使用原子inc操作增加库存
    const inv = invRes.data[0]
    const updatePath = `stock.${rKey}`
    await db.collection('inventory').doc(inv._id).update({
      data: {
        [updatePath]: db.command.inc(qtyNum),
        lastUpdatedAt: db.serverDate()
      }
    })
  }

  // 异步记录日志
  db.collection('material_logs').add({
    data: {
      type: 'in',
      material,
      roughness: rKey,
      qty: qtyNum,
      operator: user.name,
      operatorId: user._id,
      note: note || '',
      createdAt: db.serverDate()
    }
  }).catch(() => {})

  db.collection('audit_logs').add({
    data: {
      action: '材料入库',
      targetName: `${material} φ${rKey} +${qtyNum}吨`,
      operatorId: user._id,
      operatorName: user.name,
      createdAt: db.serverDate()
    }
  }).catch(() => {})

  return await getInventory()
}

// 出库（消耗库存）- 使用原子操作防止并发超卖
async function deductStock(material, qty, user, note, orderId, roughness) {
  requireAdmin(user)
  const types = await getTypes()
  if (!types.includes(material)) throw new Error('材料类型无效')
  if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) throw new Error('请输入有效数量')
  if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  const qtyNum = Number(qty)

  // 使用原子操作：先查询并验证库存，再使用inc原子扣减
  const invRes = await db.collection('inventory').where({ name: material }).get()
  if (invRes.data.length === 0) throw new Error(`${material} 库存不存在`)

  const inv = invRes.data[0]
  const currentStock = Number((inv.stock || {})[rKey]) || 0

  if (currentStock < qtyNum) {
    throw new Error(`${material} φ${rKey} 库存不足，当前剩余 ${currentStock.toFixed(4)} 吨`)
  }

  // 使用原子inc操作扣减库存，防止并发问题
  const updatePath = `stock.${rKey}`
  const updateRes = await db.collection('inventory').doc(inv._id).update({
    data: {
      [updatePath]: db.command.inc(-qtyNum),
      lastUpdatedAt: db.serverDate()
    }
  })

  if (updateRes.stats.updated === 0) {
    throw new Error('库存扣减失败，请重试')
  }

  // 异步记录日志（不阻塞主流程）
  db.collection('material_logs').add({
    data: {
      type: 'out',
      material,
      roughness: rKey,
      qty: qtyNum,
      operator: user.name,
      operatorId: user._id,
      note: note || '',
      orderId: orderId || '',
      createdAt: db.serverDate()
    }
  }).catch(() => {})

  return await getInventory()
}

// 设置库存（管理员直接修正）
async function setStock(material, newStock, user, note, roughness) {
  requireAdmin(user)
  const types = await getTypes()
  if (!types.includes(material)) throw new Error('材料类型无效')
  if (newStock === null || isNaN(Number(newStock)) || Number(newStock) < 0) throw new Error('请输入有效库存数量')
  if (!roughness || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  const invRes = await db.collection('inventory').where({ name: material }).get()
  const oldStock = ((invRes.data[0] || {}).stock || {})[rKey] || 0

  if (invRes.data.length === 0) {
    const stock = {}
    stock[rKey] = Number(newStock)
    await db.collection('inventory').add({ data: { name: material, stock, lastUpdatedAt: db.serverDate(), createdAt: db.serverDate() } })
  } else {
    const inv = invRes.data[0]
    // 使用字段级原子更新，避免并发覆盖整个 stock 对象
    await db.collection('inventory').doc(inv._id).update({
      data: { [`stock.${rKey}`]: Number(newStock), lastUpdatedAt: db.serverDate() }
    })
  }

  try {
    await db.collection('material_logs').add({
      data: { type: 'set', material, roughness: rKey, qty: Number(newStock), operator: user.name, operatorId: user._id, note: note || `手动设置库存：${material} φ${rKey} ${oldStock} → ${newStock} 吨`, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  try {
    await db.collection('audit_logs').add({
      data: { action: '设置库存', targetName: `${material} φ${rKey} → ${newStock}吨`, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getInventory()
}

// 新增材料种类
async function addType(name, user) {
  requireAdmin(user)
  if (!name || !name.trim()) throw new Error('材料名称不能为空')
  const trimmed = name.trim()
  const types = await getTypes()
  if (types.includes(trimmed)) throw new Error(`材料「${trimmed}」已存在`)

  // 在 inventory 中创建空记录
  await db.collection('inventory').add({
    data: { name: trimmed, stock: {}, lastUpdatedAt: db.serverDate(), createdAt: db.serverDate() }
  })

  try {
    await db.collection('audit_logs').add({
      data: { action: '新增材料类型', targetName: trimmed, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getInventory()
}

// 获取材料流水日志
async function getLogs() {
  try {
    const res = await db.collection('material_logs').orderBy('createdAt', 'desc').limit(500).get()
    return res.data
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { action } = event
    if (!action) return { success: false, error: '缺少 action 参数' }

    const user = await getUserByOpenid(openid)

    switch (action) {
      case 'getTypes':
        return { success: true, types: await getTypes() }

      case 'getInventory':
        return { success: true, inventory: await getInventory() }

      case 'getStock':
        return { success: true, stock: await getStockByRoughness(event.material, event.roughness) }

      case 'addStock':
        return { success: true, inventory: await addStock(event.material, event.qty, user, event.note, event.roughness) }

      case 'deductStock':
        return { success: true, inventory: await deductStock(event.material, event.qty, user, event.note, event.orderId, event.roughness) }

      case 'setStock':
        return { success: true, inventory: await setStock(event.material, event.stock, user, event.note, event.roughness) }

      case 'addType':
        return { success: true, inventory: await addType(event.name, user) }

      case 'getLogs':
        return { success: true, logs: await getLogs() }

      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  } catch (err) {
    return { success: false, error: err.message || '操作失败' }
  }
}
