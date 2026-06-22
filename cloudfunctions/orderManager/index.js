/**
 * 工单管理云函数
 * 支持：获取工单列表、工单详情、暂停/恢复、加急/取消加急、撤回工序、修改工序配置
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PROCESS_LIBRARY = [
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

const ROUGHNESS_COEFFICIENTS = {
  '5.5': 0.135, '6': 0.228, '6.5': 0.26, '7': 0.302,
  '8': 0.395, '9': 0.499, '10': 0.617, '11': 0.746,
  '12': 0.888, '13': 1.04, '14': 1.21, '15': 1.39,
  '16': 1.58, '17': 1.78, '18': 2.00, '19': 2.23,
  '20': 2.47, '21': 2.72, '22': 2.98, '23': 3.26,
  '24': 3.55, '25': 3.85, '26': 4.17, '27': 4.49,
  '28': 4.83, '29': 5.18, '30': 5.55, '31': 5.92,
  '32': 6.31, '33': 6.71, '34': 7.13, '35': 7.55,
  '36': 7.99, '38': 8.90, '40': 9.87, '42': 10.87,
  '45': 12.48, '48': 14.21, '50': 15.42, '53': 17.30,
  '55': 18.60
}

function formatTime() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function formatDate() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function isOverdue(order) {
  if (order.status === 'completed') return false
  const today = new Date()
  const pad = n => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  return order.dueDate < todayStr
}

function getOrderStatusLabel(order) {
  if (order.status === 'completed') return '已完工'
  if (order.paused) return '已暂停'
  if (isOverdue(order)) return '已逾期'
  if (order.urgent) return '加急'
  return '生产中'
}

function getOrderCategory(order) {
  if (order.status === 'completed') return 'completed'
  if (order.paused) return 'paused'
  if (isOverdue(order)) return 'overdue'
  if (order.urgent) return 'urgent'
  return 'processing'
}

function enrichOrder(order) {
  const steps = (order.stepKeys || []).map(k => PROCESS_LIBRARY.find(p => p.key === k)).filter(Boolean)
  return {
    ...order,
    steps,
    overdue: isOverdue(order),
    category: getOrderCategory(order),
    categoryLabel: getOrderStatusLabel(order),
    statusLabel: getOrderStatusLabel(order),
    progress: steps.length > 0 ? Math.min(Math.round((order.currentStepIndex / steps.length) * 100), 100) : 0,
    currentStepName: steps.length > 0 ? ((steps[Math.min(order.currentStepIndex, steps.length - 1)] || {}).name || '已完成') : '无工序',
    currentStation: steps.length > 0 ? ((steps[Math.min(order.currentStepIndex, steps.length - 1)] || {}).station || '入库完成') : ''
  }
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

// 仪表盘统计数据 - 使用聚合查询优化性能
async function getDashboard() {
  try {
    const today = new Date()
    const pad = n => String(n).padStart(2, '0')
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

    // 并行使用count查询，避免大数据量传输
    const [
      totalRes,
      completedRes,
      pausedRes,
      urgentRes,
      overdueRes,
      pendingRes
    ] = await Promise.all([
      db.collection('orders').count(),
      db.collection('orders').where({ status: 'completed' }).count(),
      db.collection('orders').where({ paused: true, status: db.command.neq('completed') }).count(),
      db.collection('orders').where({ urgent: true, status: db.command.neq('completed'), paused: false }).count(),
      db.collection('orders').where({
        status: db.command.neq('completed'),
        paused: false,
        dueDate: db.command.lt(todayStr)
      }).count(),
      db.collection('pending_applications').where({ status: 'pending' }).count().catch(() => ({ total: 0 }))
    ])

    const total = totalRes.total || 0
    const completed = completedRes.total || 0
    const paused = pausedRes.total || 0
    const urgent = urgentRes.total || 0
    const overdue = overdueRes.total || 0
    const pendingEmployees = pendingRes.total || 0

    // 修复：进行中 = 总数 - 已完成 - 暂停（pause 与完成互斥；加急是生产中的子集；逾期也是生产中的子集）
    const processing = Math.max(0, total - completed - paused)

    return { total, completed, paused, urgent, overdue, processing, pendingEmployees }
  } catch (err) {
    if (err.errCode === -502005) return { total: 0, completed: 0, paused: 0, urgent: 0, overdue: 0, processing: 0, pendingEmployees: 0 }
    throw err
  }
}

// 获取工单列表（支持分页）
async function listOrders(page = 1, pageSize = 100) {
  try {
    const skip = Math.max(0, (page - 1) * pageSize)
    const limit = Math.min(pageSize, 100)
    const res = await db.collection('orders')
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(limit)
      .get()
    return res.data.map(enrichOrder)
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

// 获取单个工单
async function getOrder(orderId) {
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) return null
  return enrichOrder(res.data[0])
}

// 暂停/恢复工单
async function togglePause(orderId, paused, user) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  if (res.data[0].status === 'completed') throw new Error('已完工的工单不能暂停')

  await db.collection('orders').doc(res.data[0]._id).update({
    data: {
      paused: Boolean(paused),
      status: paused ? 'paused' : 'processing',
      updatedAt: db.serverDate()
    }
  })

  // 审计日志
  try {
    await db.collection('audit_logs').add({
      data: { action: paused ? '暂停工单' : '恢复工单', targetId: orderId, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 切换加急状态
async function toggleUrgent(orderId, urgent, user) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')

  await db.collection('orders').doc(res.data[0]._id).update({
    data: { urgent: Boolean(urgent), updatedAt: db.serverDate() }
  })

  try {
    await db.collection('audit_logs').add({
      data: { action: urgent ? '设为加急' : '取消加急', targetId: orderId, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 撤回已完成工序
async function revertStep(orderId, stepKey, user) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  const steps = (order.stepKeys || []).map(k => PROCESS_LIBRARY.find(p => p.key === k)).filter(Boolean)
  // 关键修复：找到 history 中最后一个匹配 stepKey 的索引（而非 steps 数组中首个）
  // history 是按完成顺序追加，所以应该从尾部向前找最后完成的
  const history = order.history || []
  let lastHistoryIdx = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].stepKey === stepKey) { lastHistoryIdx = i; break }
  }
  if (lastHistoryIdx < 0) throw new Error('该工序尚未完成，无法撤回')
  if (lastHistoryIdx >= (order.currentStepIndex || 0)) throw new Error('该工序尚未完成')

  // revertIndex 取 history 索引 +1（currentStepIndex 指向下一个待执行）
  const revertIndex = lastHistoryIdx + 1

  // 下料工序撤回：回退库存
  if (stepKey === 'blanking') {
    const blankingHistory = history[lastHistoryIdx]
    if (blankingHistory && blankingHistory.materialConsumption && blankingHistory.materialConsumption.material) {
      const mc = blankingHistory.materialConsumption
      const material = mc.material
      const roughness = String(mc.roughness || '')
      let returnTons = mc.calcTons
      if (!returnTons && mc.qty && roughness) {
        const rVal = Number(roughness)
        const len = Number(mc.length) || 1
        const coef = ROUGHNESS_COEFFICIENTS[roughness] || (rVal * rVal * 0.006165)
        returnTons = len * 1.05 * coef * 0.001 * Number(mc.qty) / 1000
      }
      if (returnTons && Number(returnTons) > 0) {
        try {
          const invRes = await db.collection('inventory').where({ name: material }).get()
          if (invRes.data.length > 0) {
            const inv = invRes.data[0]
            const stock = inv.stock || {}
            stock[roughness] = (Number(stock[roughness]) || 0) + Number(returnTons)
            await db.collection('inventory').doc(inv._id).update({ data: { stock, lastUpdatedAt: db.serverDate() } })
            try {
              await db.collection('material_logs').add({
                data: { type: 'in', material, roughness, qty: Number(returnTons), operator: user.name, operatorId: user._id, note: `撤回下料工序 ${orderId}，库存回退`, createdAt: db.serverDate() }
              })
            } catch (e) { /* 非关键 */ }
          }
        } catch (e) { /* 静默处理 */ }
      }
    }
  }

  // 撤回：移除该步骤及之后的所有历史记录，回退 currentStepIndex
  const newHistory = history.filter((h, idx) => idx < revertIndex)
  const newStatus = order.status === 'completed' ? 'processing' : order.status

  await db.collection('orders').doc(order._id).update({
    data: {
      history: newHistory,
      currentStepIndex: revertIndex,
      status: newStatus,
      updatedAt: db.serverDate()
    }
  })

  try {
    await db.collection('audit_logs').add({
      data: { action: '撤回工序', targetId: orderId, targetName: steps[Math.min(revertIndex, steps.length - 1)] ? steps[Math.min(revertIndex, steps.length - 1)].name : stepKey, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 修改工单工序配置
async function updateStepKeys(orderId, newStepKeys, user) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  let newIndex = order.currentStepIndex
  if (newIndex >= newStepKeys.length) {
    newIndex = newStepKeys.length - 1
  }

  await db.collection('orders').doc(order._id).update({
    data: { stepKeys: newStepKeys, currentStepIndex: newIndex, updatedAt: db.serverDate() }
  })

  try {
    await db.collection('audit_logs').add({
      data: { action: '更新工序', targetId: orderId, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 更新工单图纸（管理员）
async function updateDrawings(orderId, drawings, user) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  // 合并现有图纸和新图纸
  const existingDrawings = order.drawings || []
  const allDrawings = [...existingDrawings, ...drawings]

  await db.collection('orders').doc(order._id).update({
    data: { drawings: allDrawings, updatedAt: db.serverDate() }
  })

  try {
    await db.collection('audit_logs').add({
      data: { action: '上传图纸', targetId: orderId, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 删除工单（管理员）
async function deleteOrder(orderId, user) {
  requireAdmin(user)

  // 查询工单
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  // 1. 回滚库存：如果工单已完成的工序中包含下料工序，需要回退库存
  const history = order.history || []
  const blankingHistory = history.find(h => h.stepKey === 'blanking')
  if (blankingHistory && blankingHistory.materialConsumption && blankingHistory.materialConsumption.material) {
    const mc = blankingHistory.materialConsumption
    const material = mc.material
    const roughness = String(mc.roughness || '')
    let returnTons = mc.calcTons
    if (!returnTons && mc.qty && roughness) {
      const rVal = Number(roughness)
      const len = Number(mc.length) || 1
      const coef = ROUGHNESS_COEFFICIENTS[roughness] || (rVal * rVal * 0.006165)
      returnTons = len * 1.05 * coef * 0.001 * Number(mc.qty) / 1000
    }
    if (returnTons && Number(returnTons) > 0) {
      try {
        const invRes = await db.collection('inventory').where({ name: material }).get()
        if (invRes.data.length > 0) {
          const inv = invRes.data[0]
          const stock = inv.stock || {}
          stock[roughness] = (Number(stock[roughness]) || 0) + Number(returnTons)
          await db.collection('inventory').doc(inv._id).update({ data: { stock, lastUpdatedAt: db.serverDate() } })
          // 记录库存回退日志
          try {
            await db.collection('material_logs').add({
              data: { type: 'in', material, roughness, qty: Number(returnTons), operator: user.name, operatorId: user._id, note: `删除工单 ${orderId}，库存回退`, createdAt: db.serverDate() }
            })
          } catch (e) { /* 非关键 */ }
        }
      } catch (e) { /* 静默处理库存回滚失败 */ }
    }
  }

  // 2. 删除云存储中的图纸文件
  const drawings = order.drawings || []
  const fileIDs = drawings.map(d => d.fileID || d.fileId).filter(Boolean)
  if (fileIDs.length > 0) {
    try {
      await cloud.deleteFile({ fileList: fileIDs })
    } catch (e) {
      console.error('删除图纸文件失败:', e)
      // 继续删除工单记录，不因文件删除失败而中断
    }
  }

  // 3. 删除工单记录（员工产量统计基于历史记录，删除后自动更新）
  await db.collection('orders').doc(order._id).remove()

  // 4. 删除相关的审计日志
  try {
    const logsRes = await db.collection('audit_logs').where({ targetId: orderId }).get()
    for (const log of logsRes.data) {
      try {
        await db.collection('audit_logs').doc(log._id).remove()
      } catch (e) { /* 忽略单个删除失败 */ }
    }
  } catch (e) { /* 非关键 */ }

  // 5. 记录删除操作日志
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '删除工单',
        targetId: orderId,
        targetName: order.customerName || order.id,
        operatorId: user._id,
        operatorName: user.name,
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return { deleted: true, orderId }
}

// 获取员工月度产量统计（单个）
async function getEmployeeMonthlyProduction(employeeId, year) {
  const ordersRes = await db.collection('orders').limit(1000).get()
  const rows = []
  for (const order of ordersRes.data) {
    for (const record of (order.history || [])) {
      if (!record.operator || record.operator === '系统流转') continue
      if (record.operatorId !== employeeId) continue
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      const monthKey = monthMatch ? monthMatch[1] : ''
      if (!monthKey.startsWith(String(year))) continue
      rows.push({ orderId: order.id, customerName: order.customerName || '', orderQty: Number(order.qty) || 0, employeeId, employeeName: record.operator, monthKey, completedAt: record.completedAt })
    }
  }

  const months = Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`,
    label: `${i + 1}月`
  }))
  const monthlyMap = {}
  months.forEach(m => { monthlyMap[m.key] = 0 })
  rows.forEach(r => { if (monthlyMap[r.monthKey] !== undefined) monthlyMap[r.monthKey] += r.orderQty })

  let employee = null
  try {
    const empRes = await db.collection('users').doc(employeeId).get()
    if (empRes.data) employee = empRes.data
  } catch (e) { /* ignore */ }

  const monthlyRoots = months.map(m => ({ id: employeeId, ...m, roots: monthlyMap[m.key] || 0 }))
  return {
    employee,
    year,
    totalRoots: monthlyRoots.reduce((s, m) => s + m.roots, 0),
    monthlyRoots,
    currentMonthRoots: (monthlyRoots[new Date().getMonth()] || {}).roots || 0
  }
}

// 获取所有活跃员工月度产量统计（批量，解决 N+1 问题）
async function getAllEmployeesMonthlyProduction(year) {
  // 一次查询所有数据
  const [ordersRes, usersRes] = await Promise.all([
    db.collection('orders').limit(1000).get().catch(() => ({ data: [] })),
    db.collection('users').where({ status: 'active' }).limit(200).get().catch(() => ({ data: [] }))
  ])

  const activeEmps = usersRes.data.filter(u => u.role !== 'superadmin')
  const months = Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`,
    label: `${i + 1}月`
  }))

  const empMap = {}
  activeEmps.forEach(e => {
    empMap[e._id] = { employee: { id: e._id, name: e.name, stations: e.stations || [], role: e.role, status: e.status }, monthlyMap: {} }
    months.forEach(m => { empMap[e._id].monthlyMap[m.key] = 0 })
  })

  // 单次遍历所有工单历史，按 operatorId 分组累加
  for (const order of ordersRes.data) {
    for (const record of (order.history || [])) {
      if (!record.operator || !record.operatorId || record.operator === '系统流转') continue
      const stat = empMap[record.operatorId]
      if (!stat) continue
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      const monthKey = monthMatch ? monthMatch[1] : ''
      if (stat.monthlyMap[monthKey] !== undefined) {
        stat.monthlyMap[monthKey] += (Number(order.qty) || 0)
      }
    }
  }

  return Object.values(empMap).map(stat => ({
    employee: stat.employee,
    year,
    totalRoots: Object.values(stat.monthlyMap).reduce((s, v) => s + v, 0),
    monthlyRoots: months.map(m => ({ id: stat.employee.id, ...m, roots: stat.monthlyMap[m.key] || 0 })),
    currentMonthRoots: stat.monthlyMap[(months[new Date().getMonth()] || {}).key] || 0
  }))
}

// 获取所有生产明细行（批量，服务器端聚合）
async function getProductionRows() {
  const ordersRes = await db.collection('orders').limit(1000).get().catch(() => ({ data: [] }))
  const rows = []
  for (const order of ordersRes.data) {
    for (const record of (order.history || [])) {
      if (!record.operator || record.operator === '系统流转') continue
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      rows.push({
        orderId: order.id,
        customerName: order.customerName || '',
        orderQty: Number(order.qty) || 0,
        employeeId: record.operatorId || '',
        employeeName: record.operator,
        monthKey: monthMatch ? monthMatch[1] : '',
        completedAt: record.completedAt,
        stepName: record.stepName,
        station: record.role
      })
    }
  }
  return rows
}

// 获取审计日志（默认最近2天，限制最大100条避免性能问题）
async function listLogs(days = 2) {
  try {
    // 限制最大查询天数为7天，避免性能问题
    const safeDays = Math.min(Math.max(1, days), 7)
    const cutoffDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000)
    const res = await db.collection('audit_logs')
      .where({
        createdAt: db.command.gte(cutoffDate)
      })
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()
    return res.data
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

// 清理3个月前的日志（循环执行直到清完，每次最多100条）
async function cleanupOldLogs() {
  try {
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    let totalDeleted = 0
    // 循环清理，每次最多100条，避免单次响应过大触发超时
    for (let round = 0; round < 20; round++) {
      const res = await db.collection('audit_logs')
        .where({
          createdAt: db.command.lt(threeMonthsAgo)
        })
        .limit(100)
        .get()
      if (res.data.length === 0) break

      for (const doc of res.data) {
        try {
          await db.collection('audit_logs').doc(doc._id).remove()
          totalDeleted++
        } catch (e) { /* 忽略单个删除失败 */ }
      }
      if (res.data.length < 100) break
    }
    return totalDeleted
  } catch (err) {
    return 0
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
      case 'dashboard':
        return { success: true, dashboard: await getDashboard() }

      case 'listOrders':
        return { success: true, orders: await listOrders(event.page, event.pageSize) }

      case 'getOrder':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, order: await getOrder(event.orderId) }

      case 'togglePause':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, order: await togglePause(event.orderId, event.paused, user) }

      case 'toggleUrgent':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, order: await toggleUrgent(event.orderId, event.urgent, user) }

      case 'revertStep':
        if (!event.orderId || !event.stepKey) return { success: false, error: '缺少参数' }
        return { success: true, order: await revertStep(event.orderId, event.stepKey, user) }

      case 'updateStepKeys':
        if (!event.orderId || !event.stepKeys) return { success: false, error: '缺少参数' }
        return { success: true, order: await updateStepKeys(event.orderId, event.stepKeys, user) }

      case 'updateDrawings':
        if (!event.orderId || !event.drawings) return { success: false, error: '缺少参数' }
        return { success: true, order: await updateDrawings(event.orderId, event.drawings, user) }

      case 'deleteOrder':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, result: await deleteOrder(event.orderId, user) }

      case 'employeeMonthlyProduction':
        if (!event.employeeId) return { success: false, error: '缺少员工ID' }
        return { success: true, data: await getEmployeeMonthlyProduction(event.employeeId, event.year || String(new Date().getFullYear())) }

      case 'allEmployeesMonthlyProduction':
        return { success: true, stats: await getAllEmployeesMonthlyProduction(event.year || String(new Date().getFullYear())) }

      case 'productionRows':
        return { success: true, rows: await getProductionRows() }

      case 'listLogs':
        return { success: true, logs: await listLogs(event.days) }

      case 'cleanupLogs':
        // 修复：仅管理员可清理日志，防止任意用户误删审计
        if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
          return { success: false, error: '仅管理员可清理日志' }
        }
        return { success: true, deletedCount: await cleanupOldLogs() }

      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  } catch (err) {
    return { success: false, error: err.message || '操作失败' }
  }
}
