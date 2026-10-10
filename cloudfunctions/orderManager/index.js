      /**
 * 工单管理云函数
 * 支持：获取工单列表、工单详情、暂停/恢复、加急/取消加急、撤回工序、修改工序配置
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 工序库（权威源，修改后需同步到：completeStep/index.js、createOrder/index.js、
//          init-db/index.js、miniprogram/utils/api.js）
//
// 标记说明：
//   needPartner:    该工序完成后必须指定一名「配合人员」（默认是编程员）
//   partnerKeyword: 配合人员的岗位关键字（默认「编程」）——用于筛人 + 后端校验
//   partnerLabel:   配合人员的界面称谓（默认「编程员」）——如打字工序为「调字员」
//   repeatable + maxRepeat: 该工序可重复多道（如精车最多 4 道：精车1~精车4），
//     完成时由操作面板选择「本工单共需几道」，后端按需追加/回收未完成的重复工序
//
// 兼容：旧字段 needProgrammer 仍然被识别（等价于 needPartner），
//       避免云函数分批部署时出现前后端标记不一致。
const PROCESS_LIBRARY = [
  { key: 'blanking', name: '下料', station: '下料工' },
  { key: 'pressing', name: '敦压', station: '敦压工', needPartner: true },
  { key: 'pulling_tail', name: '拉尾子', station: '拉尾工', needPartner: true },
  { key: 'finish_turning', name: '精车', station: '精车工', needPartner: true, repeatable: true, maxRepeat: 4 },
  { key: 'milling_head', name: '铣方头', station: '铣床工', needPartner: true },
  { key: 'tapping', name: '攻丝', station: '攻丝工' },
  { key: 'drilling_head', name: '打方头孔', station: '钻床工' },
  { key: 'tapping_repeat', name: '攻丝（复攻）', station: '攻丝工' },
  { key: 'threading', name: '压螺纹', station: '螺纹工' },
  { key: 'polishing', name: '压光', station: '抛光工' },
  { key: 'marking', name: '打字', station: '打字工', needPartner: true, partnerKeyword: '调字', partnerLabel: '调字员' },
  { key: 'heat_treatment', name: '热处理', station: '热处理工' },
  { key: 'quality_check', name: '质检', station: '质检员' },
  { key: 'warehouse', name: '入库', station: '仓管员' }
]

// 已下线的工序：不再出现在「可选工序」，但老工单 stepKeys 可能仍带「编程」，
// buildSteps 必须仍能解析，否则历史工单丢工序、撤回/完成找不到定义
const LEGACY_PROCESSES = {
  programming: { key: 'programming', name: '编程', station: '编程工' }
}

// 构建 O(1) 查找字典（避免重复 .find() 遍历）；在用工序 + 已下线工序都要能查到
const PROCESS_MAP = Object.fromEntries(
  PROCESS_LIBRARY.map(p => [p.key, p]).concat(Object.entries(LEGACY_PROCESSES))
)

// 配合人员的默认配置（未在工序里单独指定时使用）
const DEFAULT_PARTNER_KEYWORD = '编程'
const DEFAULT_PARTNER_LABEL = '编程员'
// 配合人员的兜底岗位名（原「编程」工序的岗位；工序下线后岗位仍需可分配）
const DEFAULT_PARTNER_STATION = '编程工'

/**
 * 归一化某工序的「配合人员」配置
 * @returns {{ need: boolean, keyword: string, label: string, station: string }}
 */
function resolvePartner(step) {
  const need = !!(step && (step.needPartner || step.needProgrammer))
  return {
    need,
    keyword: (step && step.partnerKeyword) || DEFAULT_PARTNER_KEYWORD,
    label: (step && step.partnerLabel) || DEFAULT_PARTNER_LABEL,
    // 兜底用的岗位名（与编程员岗位保持一致，用于「系统里有没有这类人」的判断）
    station: (step && step.partnerStation) || DEFAULT_PARTNER_STATION
  }
}

/**
 * 把 stepKeys 展开成工序对象数组
 *
 * 【重复工序编号】同一个 key 出现多次时自动编号：精车 → 精车1 / 精车2 / 精车3 / 精车4
 * 注入字段：
 *   _index       在 stepKeys 中的位置（与 currentStepIndex 对齐）
 *   _seq         这是该工序的第几道（从 1 开始）
 *   _repeatTotal 该工序在本工单中共排了几道
 *
 * 注意：必须用本函数统一构建 steps，前端与管理端才能拿到一致的编号与标记。
 */
function buildSteps(stepKeys) {
  const keys = Array.isArray(stepKeys) ? stepKeys : []
  const totalMap = {}
  keys.forEach(k => { totalMap[k] = (totalMap[k] || 0) + 1 })

  const seqMap = {}
  const steps = []
  keys.forEach((k, i) => {
    const def = PROCESS_MAP[k]
    if (!def) return
    seqMap[k] = (seqMap[k] || 0) + 1
    const total = totalMap[k]
    const partner = resolvePartner(def)
    steps.push({
      ...def,
      // 归一化「配合人员」配置：前端统一读 needProgrammer / partnerLabel / partnerKeyword
      needPartner: partner.need,
      needProgrammer: partner.need,
      partnerKeyword: partner.keyword,
      partnerLabel: partner.label,
      _index: i,
      _seq: seqMap[k],
      _repeatTotal: total,
      name: total > 1 ? `${def.name}${seqMap[k]}` : def.name
    })
  })
  return steps
}

// 粗度系数表（权威源，修改后需同步到 miniprogram/utils/api.js）
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

// 使用 UTC+8 中国时区（云函数默认 UTC）
function getChinaNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
}

function formatTime() {
  const china = getChinaNow()
  const pad = n => String(n).padStart(2, '0')
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}`
}

function formatDate() {
  const china = getChinaNow()
  const pad = n => String(n).padStart(2, '0')
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())}`
}

function isOverdue(order) {
  if (order.status === 'completed') return false
  const today = formatDate()
  return order.dueDate < today
}

function getOrderStatusLabel(order) {
  if (order.status === 'completed') return '已完工'
  // 已暂停:仅"开始后暂停"的工单(已开工 currentStepIndex>0 才算真正暂停;未开工的不算)
  if (order.paused && (order.currentStepIndex || 0) > 0) return '已暂停'
  // 已逾期优先级高于"未开始":只要未完成且超时间 = 逾期
  if (isOverdue(order)) return '已逾期'
  // 未开始:currentStepIndex=0 且 history 空(且未逾期)
  if ((order.currentStepIndex || 0) === 0 && (!Array.isArray(order.history) || order.history.length === 0)) return '未开始'
  // 加急:仅在"已开始 + 未暂停 + 未逾期"时显示加急 chip
  if (order.urgent) return '加急'
  return '生产中'
}

function getOrderCategory(order) {
  if (order.status === 'completed') return 'completed'
  if (order.paused && (order.currentStepIndex || 0) > 0) return 'paused'
  if (isOverdue(order)) return 'overdue'
  if ((order.currentStepIndex || 0) === 0 && (!Array.isArray(order.history) || order.history.length === 0)) return 'notStarted'
  return 'processing'
}

function enrichOrder(order) {
  const steps = buildSteps(order.stepKeys)
  const curIdx = Number(order.currentStepIndex) || 0
  // 【修复】原来用 Math.min 把越界下标夹回最后一个工序，导致已完工工单
  // 「当前工序」显示成「入库·仓管员」；现在越界时明确显示「已完成」
  const isAllDone = steps.length > 0 && curIdx >= steps.length
  const curStep = (!isAllDone && steps[curIdx]) ? steps[curIdx] : null
  return {
    ...order,
    steps,
    overdue: isOverdue(order),
    category: getOrderCategory(order),
    categoryLabel: getOrderStatusLabel(order),
    statusLabel: getOrderStatusLabel(order),
    progress: steps.length > 0 ? Math.min(Math.round((curIdx / steps.length) * 100), 100) : 0,
    currentStepName: steps.length === 0 ? '无工序' : (isAllDone ? '已完成' : curStep.name),
    currentStation: steps.length === 0 ? '' : (isAllDone ? '入库完成' : curStep.station)
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
// 【修复】5 大分类互斥,数字与列表筛选一一对应(每个分类对应一个精确查询)
//   优先级:completed > overdue(未完成+超时间) > paused(已开工后暂停) > notStarted > processing
async function getDashboard() {
  try {
    const todayStr = formatDate()

    // 并行查询(每个分类一个独立查询,确保数字与列表分类一致)
    const [
      totalRes,
      completedRes,
      overdueRes,
      pausedRes,
      notStartedRes,
      processingRes,
      urgentRes,
      pendingRes
    ] = await Promise.all([
      // 总数
      db.collection('orders').count(),
      // 已完工
      db.collection('orders').where({ status: 'completed' }).count(),
      // 已逾期:!paused && !completed && dueDate<today(包含未开工但过期的)
      db.collection('orders').where({
        paused: false,
        status: db.command.neq('completed'),
        dueDate: db.command.lt(todayStr)
      }).count(),
      // 已暂停:paused && currentStepIndex>0(已开始后暂停,排除未开工暂停)
      db.collection('orders').where({
        paused: true,
        status: db.command.neq('completed'),
        currentStepIndex: db.command.gt(0)
      }).count(),
      // 未开始:currentStepIndex=0 且 dueDate>=today(过期归 overdue)
      db.collection('orders').where({
        currentStepIndex: 0,
        dueDate: db.command.gte(todayStr)
      }).get(),
      // 进行中:!paused && currentStepIndex>0 && dueDate>=today && !completed
      db.collection('orders').where({
        paused: false,
        status: db.command.neq('completed'),
        currentStepIndex: db.command.gt(0),
        dueDate: db.command.gte(todayStr)
      }).count(),
      // 加急:属性(不互斥,与分类并行):urgent=true && !paused && !completed
      db.collection('orders').where({
        urgent: true,
        status: db.command.neq('completed'),
        paused: false
      }).count(),
      db.collection('pending_applications').where({ status: 'pending' }).count().catch(() => ({ total: 0 }))
    ])

    const total = totalRes.total || 0
    const completed = completedRes.total || 0
    const overdue = overdueRes.total || 0
    const paused = pausedRes.total || 0
    // 未开始用 list + 内存过滤 history 空
    const notStarted = (notStartedRes.data || []).filter(o => !Array.isArray(o.history) || o.history.length === 0).length
    const processing = processingRes.total || 0
    const urgent = urgentRes.total || 0
    const pendingEmployees = pendingRes.total || 0

    return { total, completed, overdue, paused, notStarted, processing, urgent, pendingEmployees }
  } catch (err) {
    if (err.errCode === -502005) return { total: 0, completed: 0, overdue: 0, paused: 0, notStarted: 0, processing: 0, urgent: 0, pendingEmployees: 0 }
    throw err
  }
}

// 获取工单列表（支持分页）
// 【修复】limit 上限从 100 提升到 1000（云函数单次查询上限），配合前端滚动分页避免超过 100 条丢单
async function listOrders(page = 1, pageSize = 100) {
  try {
    const skip = Math.max(0, (page - 1) * pageSize)
    const limit = Math.min(pageSize, 1000)
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
  const res = await db.collection('orders')
    .where({ id: orderId })
    .limit(1)
    .get()
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
//
// stepIndex（可选，推荐传）：被撤回工序在工序列表中的下标。
// 【为什么需要】精车等可重复工序在同一工单里会出现多条相同 stepKey（精车1/精车2/精车3），
// 仅凭 stepKey 只能定位到「最后一次完成的那道」，导致在精车1 上点撤回实际撤掉了精车3。
// 传入 stepIndex 后按位置精确定位（history 下标与工序下标一一对应）。
async function revertStep(orderId, stepKey, stepIndex, user) {
  requireAdmin(user)
  if (!orderId || !stepKey) throw new Error('缺少工单ID或工序标识')

  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  const steps = buildSteps(order.stepKeys)
  const stepDef = PROCESS_MAP[stepKey]
  if (!stepDef) throw new Error(`未知工序：${stepKey}`)
  if (steps.length > 0 && !steps.some(s => s.key === stepKey)) {
    throw new Error(`该工序不在本工单的工序列表中：${stepDef.name}`)
  }

  // history 是按完成顺序追加，从尾部向前找最后完成的匹配工序
  const history = order.history || []
  let lastHistoryIdx = -1

  // 优先按传入下标精确定位（可重复工序必需）
  const idxNum = Number(stepIndex)
  if (Number.isInteger(idxNum) && idxNum >= 0 && idxNum < history.length && history[idxNum].stepKey === stepKey) {
    lastHistoryIdx = idxNum
  } else {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].stepKey === stepKey) { lastHistoryIdx = i; break }
    }
  }
  if (lastHistoryIdx < 0) throw new Error('该工序尚未完成，无法撤回')

  // revertIndex 取 history 索引（currentStepIndex 指向被撤回工序本身，即该工序重新变为待执行）
  // 以 history 记录为准，不再与 currentStepIndex 做冗余比较，避免数据不一致时误报
  const revertIndex = lastHistoryIdx
  const removedRecords = history.slice(revertIndex)
  const targetRecord = history[lastHistoryIdx]

  // 计算被移除记录中涉及下料的库存回退总量，按 (material, roughness) 分组汇总
  // removedRecords 已包含被撤回的目标工序本身及之后所有记录
  const inventoryReturnMap = {}
  const blankingRecordsToRevert = removedRecords.filter(r => r.stepKey === 'blanking' && r.materialConsumption && r.materialConsumption.material)

  for (const record of blankingRecordsToRevert) {
    const mc = record.materialConsumption
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
      const key = `${material}|${roughness}`
      if (!inventoryReturnMap[key]) inventoryReturnMap[key] = { material, roughness, total: 0 }
      inventoryReturnMap[key].total += Number(returnTons)
    }
  }

  // 下料工序撤回：先乐观锁更新工单，成功后才回退库存（避免并发撤回导致库存被多次回退）
  const inventoryReturnItems = Object.values(inventoryReturnMap)

  // 撤回：移除该步骤及之后的所有历史记录（包含被撤回工序本身），回退 currentStepIndex
  const newHistory = history.filter((h, idx) => idx < revertIndex)
  // 撤回已完工工单时，恢复到撤回前的有效状态：
  // - 若工单原本是 completed（说明是最后一个工序被撤回），恢复为 processing
  // - 若工单原本是 paused（数据不一致的边界场景），保持 paused
  // - 其它情况保持原 status 不变
  const becameProcessing = order.status === 'completed'
  const newStatus = becameProcessing ? 'processing' : order.status
  const newCompletedDate = becameProcessing ? null : (order.completedDate || null)
  // 撤回后确保 paused 标志与 status 一致（避免 paused=true 但 status='processing' 的不一致）
  const newPaused = newStatus === 'paused' ? true : (newStatus === 'completed' ? false : order.paused)

  // 乐观锁：防止并发回退冲突（必须在回退库存之前完成，否则两个并发撤回会双倍回退库存）
  const updateResult = await db.collection('orders').where({
    _id: order._id,
    currentStepIndex: order.currentStepIndex,
    status: order.status
  }).update({
    data: {
      history: newHistory,
      currentStepIndex: revertIndex,
      status: newStatus,
      paused: newPaused,
      completedDate: newCompletedDate,
      // 撤回会改变当前工序（或回退到已完成的工序），进行中的认领随之失效 → 释放
      ...(order.activeClaim ? { activeClaim: null } : {}),
      updatedAt: db.serverDate()
    }
  })

  if (updateResult.stats.updated === 0) {
    throw new Error('该工序状态已变更，请刷新后重试')
  }

  // 撤回成功 → 归档被释放的认领流水（reason: revert），员工可重新认领
  if (order.activeClaim) {
    await _archiveClaim(order.activeClaim, {
      status: 'released',
      releasedAt: formatTime(),
      releasedBy: user.name,
      releasedById: user._id,
      reason: 'revert'
    })
  }

  // 乐观锁成功 → 才执行库存回退（支持多个规格分批回退）
  // 库存回退失败时记录告警日志，不让操作失败（工单已回退，无法回滚工单）
  for (const item of inventoryReturnItems) {
    try {
      const invRes = await db.collection('inventory').where({ name: item.material }).get()
      if (invRes.data.length === 0) {
        // 库存记录不存在：记录告警，不能静默跳过
        console.warn(`[revertStep] 材料「${item.material}」库存记录不存在，无法回退 ${item.total} 吨`)
        try {
          await db.collection('audit_logs').add({
            data: {
              action: '库存回退失败',
              targetId: orderId,
              targetName: `${item.material} φ${item.roughness}`,
              operatorId: user._id,
              operatorName: user.name,
              detail: { reason: '库存记录不存在', material: item.material, roughness: item.roughness, returnTons: item.total, stepKey },
              createdAt: db.serverDate()
            }
          })
        } catch (e) { /* 非关键 */ }
        continue
      }
      const inv = invRes.data[0]
      const stockPath = `stock.${item.roughness}`
      await db.collection('inventory').doc(inv._id).update({
        data: { [stockPath]: db.command.inc(item.total), lastUpdatedAt: db.serverDate() }
      })
      try {
        await db.collection('material_logs').add({
          data: {
            type: 'in',
            material: item.material,
            roughness: item.roughness,
            qty: item.total,
            operator: user.name,
            operatorId: user._id,
            orderId,
            note: `撤回下料工序 ${orderId}，库存回退`,
            createdAt: db.serverDate()
          }
        })
      } catch (e) { /* 非关键 */ }
    } catch (e) {
      // 库存回退失败：记录告警日志，不让操作失败（工单已回退）
      console.error(`[revertStep] 库存回退失败: ${item.material} φ${item.roughness} +${item.total}吨,`, e.message)
      try {
        await db.collection('audit_logs').add({
          data: {
            action: '库存回退失败',
            targetId: orderId,
            targetName: `${item.material} φ${item.roughness}`,
            operatorId: user._id,
            operatorName: user.name,
            detail: { reason: e.message, material: item.material, roughness: item.roughness, returnTons: item.total, stepKey },
            createdAt: db.serverDate()
          }
        })
      } catch (e2) { /* 非关键 */ }
    }
  }

  // 记录审计日志：包含原完成时间、被移除工序、操作人等信息
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '撤回工序',
        targetId: orderId,
        targetName: stepDef.name,
        operatorId: user._id,
        operatorName: user.name,
        detail: {
          stepKey,
          stepName: stepDef.name,
          revertedFromIndex: order.currentStepIndex,
          revertedToIndex: revertIndex,
          originalCompletedAt: targetRecord ? targetRecord.completedAt : '',
          removedStepKeys: removedRecords.map(r => r.stepKey),
          removedOperators: [...new Set(removedRecords.map(r => r.operator).filter(Boolean))],
          inventoryReturned: inventoryReturnItems.length > 0 ? inventoryReturnItems.map(item => ({
            material: item.material,
            roughness: item.roughness,
            qty: item.total
          })) : null
        },
        createdAt: db.serverDate()
      }
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

  const oldStepKeys = order.stepKeys || []
  const oldIndex = order.currentStepIndex || 0
  const history = order.history || []

  // 重新计算 currentStepIndex：按新工序列表顺序匹配旧的已完成工序前缀
  // 仅当新工序前缀与旧已完成工序前缀完全一致时，才保留这些已完成记录
  let completedIdx = 0
  let newIndex = 0
  for (const key of newStepKeys) {
    if (completedIdx < oldIndex && key === oldStepKeys[completedIdx]) {
      completedIdx++
      newIndex = completedIdx
    } else {
      break
    }
  }

  // 修复：若新工序前缀与旧已完成前缀不匹配（删除/插入了已完成区域的工序），
  // 需要清理被移除的历史记录，并回退对应的库存
  const newHistory = history.slice(0, newIndex)
  const removedHistory = history.slice(newIndex)

  // 计算被移除记录中涉及下料的库存回退总量
  const inventoryReturnMap = {}
  const blankingRecordsToRemove = removedHistory.filter(r => r.stepKey === 'blanking' && r.materialConsumption && r.materialConsumption.material)
  for (const record of blankingRecordsToRemove) {
    const mc = record.materialConsumption
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
      const key = `${material}|${roughness}`
      if (!inventoryReturnMap[key]) inventoryReturnMap[key] = { material, roughness, total: 0 }
      inventoryReturnMap[key].total += Number(returnTons)
    }
  }
  const inventoryReturnItems = Object.values(inventoryReturnMap)

  const newStatus = newIndex >= newStepKeys.length ? 'completed' : (order.status === 'completed' ? 'processing' : order.status)
  // 完工状态下修改工序不应再保留 completed 状态（除非新工序也全完成）
  const newCompletedDate = newStatus === 'completed' ? (order.completedDate || formatTime()) : null
  // 保持 paused 一致性
  const newPaused = newStatus === 'paused' ? true : (newStatus === 'completed' ? false : order.paused)

  // 乐观锁：防止并发修改工序配置互相覆盖
  const updateResult = await db.collection('orders').where({
    _id: order._id,
    currentStepIndex: order.currentStepIndex
  }).update({
    data: {
      stepKeys: newStepKeys,
      currentStepIndex: newIndex,
      status: newStatus,
      paused: newPaused,
      completedDate: newCompletedDate,
      history: newHistory,
      // 工序重排后认领绑定的工序下标失效 → 释放进行中的认领
      ...(order.activeClaim ? { activeClaim: null } : {}),
      updatedAt: db.serverDate()
    }
  })

  if (updateResult.stats.updated === 0) {
    throw new Error('工单状态已变更，请刷新后重试')
  }

  // 归档被释放的认领流水（reason: stepKeys）
  if (order.activeClaim) {
    await _archiveClaim(order.activeClaim, {
      status: 'released',
      releasedAt: formatTime(),
      releasedBy: user.name,
      releasedById: user._id,
      reason: 'stepKeys'
    })
  }

  // 乐观锁成功 → 才执行库存回退（与 revertStep 一致）
  for (const item of inventoryReturnItems) {
    try {
      const invRes = await db.collection('inventory').where({ name: item.material }).get()
      if (invRes.data.length === 0) {
        console.warn(`[updateStepKeys] 材料「${item.material}」库存记录不存在，无法回退 ${item.total} 吨`)
        try {
          await db.collection('audit_logs').add({
            data: {
              action: '库存回退失败',
              targetId: orderId,
              targetName: `${item.material} φ${item.roughness}`,
              operatorId: user._id,
              operatorName: user.name,
              detail: { reason: '库存记录不存在', material: item.material, roughness: item.roughness, returnTons: item.total, source: 'updateStepKeys' },
              createdAt: db.serverDate()
            }
          })
        } catch (e) { /* 非关键 */ }
        continue
      }
      const inv = invRes.data[0]
      const stockPath = `stock.${item.roughness}`
      await db.collection('inventory').doc(inv._id).update({
        data: { [stockPath]: db.command.inc(item.total), lastUpdatedAt: db.serverDate() }
      })
      try {
        await db.collection('material_logs').add({
          data: {
            type: 'in',
            material: item.material,
            roughness: item.roughness,
            qty: item.total,
            operator: user.name,
            operatorId: user._id,
            orderId,
            note: `修改工序配置 ${orderId}，库存回退`,
            createdAt: db.serverDate()
          }
        })
      } catch (e) { /* 非关键 */ }
    } catch (e) {
      console.error(`[updateStepKeys] 库存回退失败: ${item.material} φ${item.roughness} +${item.total}吨,`, e.message)
      try {
        await db.collection('audit_logs').add({
          data: {
            action: '库存回退失败',
            targetId: orderId,
            targetName: `${item.material} φ${item.roughness}`,
            operatorId: user._id,
            operatorName: user.name,
            detail: { reason: e.message, material: item.material, roughness: item.roughness, returnTons: item.total, source: 'updateStepKeys' },
            createdAt: db.serverDate()
          }
        })
      } catch (e2) { /* 非关键 */ }
    }
  }

  try {
    await db.collection('audit_logs').add({
      data: {
        action: '更新工序',
        targetId: orderId,
        operatorId: user._id,
        operatorName: user.name,
        detail: {
          oldStepKeys,
          newStepKeys,
          oldIndex,
          newIndex,
          removedHistoryCount: removedHistory.length,
          inventoryReturned: inventoryReturnItems.length > 0 ? inventoryReturnItems.map(i => ({ material: i.material, roughness: i.roughness, qty: i.total })) : null
        },
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

// 更新工单图纸（管理员）
/**
 * 更新图纸
 * @param {string} mode 'append'(默认,追加新上传的图纸) | 'replace'(整体覆盖,用于删除后同步)
 */
async function updateDrawings(orderId, drawings, user, mode) {
  requireAdmin(user)
  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  // replace: 完全用传入列表覆盖（删除场景）
  // append: 合并现有图纸和新图纸（上传场景）
  const existingDrawings = order.drawings || []
  const allDrawings = mode === 'replace'
    ? (Array.isArray(drawings) ? drawings : [])
    : [...existingDrawings, ...(Array.isArray(drawings) ? drawings : [])]

  await db.collection('orders').doc(order._id).update({
    data: { drawings: allDrawings, updatedAt: db.serverDate() }
  })

  try {
    await db.collection('audit_logs').add({
      data: {
        action: mode === 'replace' ? '更新图纸列表' : '上传图纸',
        targetId: orderId,
        operatorId: user._id,
        operatorName: user.name,
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return await getOrder(orderId)
}

/**
 * 编辑工单核心字段(防下错单,允许修正种类/尺寸/数量/材质/交期/单号/加急/备注/图纸细节)
 * - 仅管理员
 * - 仅未完成工单可编辑(status != 'completed'),避免破坏历史记录
 * - 字段白名单,过滤前端传来的非法字段
 * - 二维码不需要重新生成(指向工单号,工单号不变)
 */
const EDITABLE_TOP_FIELDS = ['customerName', 'type', 'size', 'qty', 'material', 'dueDate', 'orderDate', 'singleNo', 'urgent', 'remarks']
const EDITABLE_DETAIL_FIELDS = ['blankingRoughness', 'productRoughness', 'length', 'blankingLength', 'topHoleThread', 'crossHole', 'squareHead']

async function updateOrderFields(orderId, fields, user) {
  requireAdmin(user)
  if (!fields || typeof fields !== 'object') throw new Error('fields 参数无效')

  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]
  if (order.status === 'completed') {
    throw new Error('已完成工单不可编辑(避免破坏历史记录)')
  }

  const updateData = {}

  // 顶层字段
  for (const key of EDITABLE_TOP_FIELDS) {
    if (!(key in fields)) continue
    let value = fields[key]
    if (key === 'qty') {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) throw new Error('数量必须是正数')
      updateData[key] = n
    } else if (key === 'urgent') {
      updateData[key] = !!value
    } else if (key === 'customerName') {
      const s = String(value || '').trim()
      if (!s) throw new Error('客户名称不能为空')
      if (s.length > 50) throw new Error('客户名称过长(最多 50 字)')
      updateData[key] = s
    } else if (key === 'singleNo') {
      const s = String(value || '').trim()
      if (s.length > 50) throw new Error('单号过长(最多 50 字)')
      updateData[key] = s
    } else if (key === 'dueDate' || key === 'orderDate') {
      const s = String(value || '').trim()
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期格式应为 YYYY-MM-DD')
      updateData[key] = s
    } else {
      // type / size / material / remarks 等文本字段
      const s = String(value == null ? '' : value).trim()
      if (['type', 'size', 'material'].includes(key) && !s) {
        throw new Error(`${key === 'type' ? '种类' : key === 'size' ? '尺寸' : '材质'}不能为空`)
      }
      updateData[key] = s
    }
  }

  // 图纸细节子字段(整对象替换,但逐字段校验)
  if (fields.drawingDetail && typeof fields.drawingDetail === 'object') {
    const newDetail = { ...(order.drawingDetail || {}) }
    for (const key of EDITABLE_DETAIL_FIELDS) {
      if (!(key in fields.drawingDetail)) continue
      newDetail[key] = String(fields.drawingDetail[key] || '').trim()
    }
    updateData.drawingDetail = newDetail
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('没有可更新的字段')
  }
  updateData.updatedAt = db.serverDate()

  await db.collection('orders').doc(order._id).update({ data: updateData })

  try {
    await db.collection('audit_logs').add({
      data: {
        action: '编辑工单字段',
        targetId: orderId,
        operatorId: user._id,
        operatorName: user.name,
        detail: { updatedFields: Object.keys(updateData) },
        createdAt: db.serverDate()
      }
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

  // 1. 先用乐观锁删除工单（带状态条件），成功后才回退库存
  //    避免两个管理员同时删除导致库存被双倍回退
  const deleteResult = await db.collection('orders').where({
    _id: order._id,
    currentStepIndex: order.currentStepIndex
  }).remove()

  if (deleteResult.stats.removed === 0) {
    throw new Error('工单状态已变更，请刷新后重试')
  }

  // 2. 工单删除成功 → 回滚库存（如果工单已完成的工序中包含下料工序，需要回退库存）
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
        if (invRes.data.length === 0) {
          // 库存记录不存在：记录告警，不能静默跳过
          console.warn(`[deleteOrder] 材料「${material}」库存记录不存在，无法回退 ${returnTons} 吨`)
          try {
            await db.collection('audit_logs').add({
              data: {
                action: '库存回退失败',
                targetId: orderId,
                targetName: `${material} φ${roughness}`,
                operatorId: user._id,
                operatorName: user.name,
                detail: { reason: '库存记录不存在', material, roughness, returnTons: Number(returnTons) },
                createdAt: db.serverDate()
              }
            })
          } catch (e) { /* 非关键 */ }
        } else {
          const inv = invRes.data[0]
          const stockPath = `stock.${roughness}`
          await db.collection('inventory').doc(inv._id).update({
            data: { [stockPath]: db.command.inc(Number(returnTons)), lastUpdatedAt: db.serverDate() }
          })
          // 记录库存回退日志
          try {
            await db.collection('material_logs').add({
              data: { type: 'in', material, roughness, qty: Number(returnTons), operator: user.name, operatorId: user._id, note: `删除工单 ${orderId}，库存回退`, createdAt: db.serverDate() }
            })
          } catch (e) { /* 非关键 */ }
        }
      } catch (e) {
        // 库存回退失败：记录告警日志，不让操作失败（工单已删除，无法回滚）
        console.error(`[deleteOrder] 库存回退失败: ${material} φ${roughness} +${returnTons}吨,`, e.message)
        try {
          await db.collection('audit_logs').add({
            data: {
              action: '库存回退失败',
              targetId: orderId,
              targetName: `${material} φ${roughness}`,
              operatorId: user._id,
              operatorName: user.name,
              detail: { reason: e.message, material, roughness, returnTons: Number(returnTons) },
              createdAt: db.serverDate()
            }
          })
        } catch (e2) { /* 非关键 */ }
      }
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

  // 3. 删除相关的审计日志（工单记录已在第1步通过乐观锁删除）
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

// 安全删除工单（仅删工单本身，不回退库存/产量统计；用于归档后清理）
// 【扩展】允许两种状态的安全删除：
//   1) 已完成(status='completed')：归档清理
//   2) 未开始(status='processing' AND currentStepIndex=0 AND history 为空)：
//      还没有任何产量和库存影响，可安全删除(避免建错单后无法回收)
async function safeDeleteOrder(orderId, user, note) {
  requireAdmin(user)
  if (!orderId) throw new Error('缺少工单ID')

  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]

  // 校验：只允许两种安全状态
  const isCompleted = order.status === 'completed'
  // 未开始：currentStepIndex=0 且 history 为空(status 不限:processing 或 paused 都算)
  const isNotStarted = (order.currentStepIndex || 0) === 0
    && (!Array.isArray(order.history) || order.history.length === 0)
  if (!isCompleted && !isNotStarted) {
    throw new Error('只能删除已完成或未开始的工单（其他状态请改用撤回/修改工序配置）')
  }

  // 乐观锁删除(带上对应的状态条件)
  // 未开始工单:currentStepIndex=0(管 status 是 processing 还是 paused)
  // 已完成工单:status=completed
  const statusLock = isCompleted
    ? { _id: order._id, status: 'completed' }
    : { _id: order._id, currentStepIndex: 0 }
  const deleteResult = await db.collection('orders').where(statusLock).remove()

  if (deleteResult.stats.removed === 0) {
    throw new Error('工单状态已变更，请刷新后重试')
  }

  // 审计日志（标记为安全删除）
  try {
    await db.collection('audit_logs').add({
      data: {
        action: isCompleted ? '安全删除工单' : '删除未开始工单',
        targetId: orderId,
        targetName: order.customerName || order.id,
        operatorId: user._id,
        operatorName: user.name,
        detail: {
          exportedConfirmed: true,
          reason: isCompleted ? 'completed' : 'notStarted',
          note: note || '',
          skippedInventoryRollback: true,
          skippedProductionStatsRollback: true
        },
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return { deleted: true, orderId, safe: true }
}

// 获取员工月度产量统计（单个）
// 优化：使用 field() 仅返回必要字段，分页获取避免 limit(1000) 丢数据
async function fetchOrdersForStats() {
  const PAGE = 100
  let all = []
  for (let page = 0; page < 50; page++) {
    const res = await db.collection('orders')
      .skip(page * PAGE)
      .limit(PAGE)
      .field({ id: 1, customerName: 1, history: 1 })
      .get()
    all = all.concat(res.data)
    if (res.data.length < PAGE) break
  }
  return all
}

async function getEmployeeMonthlyProduction(employeeId, year) {
  const ordersData = await fetchOrdersForStats()
  const rows = []
  // 配合根数：同一份 history 记录里，若该员工是「配合人员」（编程员/调字员）则额外计入
  const progRows = []
  for (const order of ordersData) {
    for (const record of (order.history || [])) {
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      const monthKey = monthMatch ? monthMatch[1] : ''
      const qty = Number(record.qty) || 0

      if (record.programmerId === employeeId && monthKey.startsWith(String(year))) {
        progRows.push({ monthKey, qty })
      }

      if (!record.operator || record.operator === '系统流转') continue
      if (record.operatorId !== employeeId) continue
      if (!monthKey.startsWith(String(year))) continue
      rows.push({ orderId: order.id, customerName: order.customerName || '', qty, employeeId, employeeName: record.operator, monthKey, completedAt: record.completedAt })
    }
  }

  const months = Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`,
    label: `${i + 1}月`
  }))
  const monthlyMap = {}
  const progMonthlyMap = {}
  months.forEach(m => { monthlyMap[m.key] = 0; progMonthlyMap[m.key] = 0 })
  rows.forEach(r => { if (monthlyMap[r.monthKey] !== undefined) monthlyMap[r.monthKey] += r.qty })
  progRows.forEach(r => { if (progMonthlyMap[r.monthKey] !== undefined) progMonthlyMap[r.monthKey] += r.qty })

  let employee = null
  try {
    const empRes = await db.collection('users').doc(employeeId).get()
    if (empRes.data) employee = empRes.data
  } catch (e) { /* ignore */ }

  const monthlyRoots = months.map(m => ({ id: employeeId, ...m, roots: monthlyMap[m.key] || 0 }))
  const programmerMonthlyRoots = months.map(m => ({ id: employeeId, ...m, roots: progMonthlyMap[m.key] || 0 }))
  // 使用 UTC+8 中国时区计算当前月份，避免月初凌晨 0-8 点 UTC 仍是上月导致 currentMonthRoots 取错
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const currentMonthIndex = chinaNow.getUTCMonth()
  return {
    employee,
    year,
    totalRoots: monthlyRoots.reduce((s, m) => s + m.roots, 0),
    monthlyRoots,
    currentMonthRoots: (monthlyRoots[currentMonthIndex] || {}).roots || 0,
    programmerTotalRoots: programmerMonthlyRoots.reduce((s, m) => s + m.roots, 0),
    programmerMonthlyRoots,
    programmerCurrentMonthRoots: (programmerMonthlyRoots[currentMonthIndex] || {}).roots || 0
  }
}

// 获取所有活跃员工月度产量统计（批量，解决 N+1 问题）
async function getAllEmployeesMonthlyProduction(year) {
  // 一次查询所有数据
  const [ordersData, usersRes] = await Promise.all([
    fetchOrdersForStats().catch(() => []),
    db.collection('users').where({ status: 'active' }).limit(200).get().catch(() => ({ data: [] }))
  ])

  const activeEmps = usersRes.data.filter(u => u.role !== 'superadmin')
  const months = Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`,
    label: `${i + 1}月`
  }))

  const empMap = {}
  activeEmps.forEach(e => {
    empMap[e._id] = {
      employee: { id: e._id, name: e.name, stations: e.stations || [], role: e.role, status: e.status },
      monthlyMap: {},
      progMonthlyMap: {}
    }
    months.forEach(m => { empMap[e._id].monthlyMap[m.key] = 0; empMap[e._id].progMonthlyMap[m.key] = 0 })
  })

  // 单次遍历所有工单历史，按 operatorId 分组累加
  for (const order of ordersData) {
    for (const record of (order.history || [])) {
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      const monthKey = monthMatch ? monthMatch[1] : ''
      const qty = Number(record.qty) || 0

      // 配合根数：该记录的配合人员（敦压/拉尾子/精车/铣方头=编程员，打字=调字员）
      if (record.programmerId) {
        const progStat = empMap[record.programmerId]
        if (progStat && progStat.progMonthlyMap[monthKey] !== undefined) {
          progStat.progMonthlyMap[monthKey] += qty
        }
      }

      if (!record.operator || !record.operatorId || record.operator === '系统流转') continue
      const stat = empMap[record.operatorId]
      if (!stat) continue
      if (stat.monthlyMap[monthKey] !== undefined) {
        stat.monthlyMap[monthKey] += qty
      }
    }
  }

  // 使用 UTC+8 中国时区计算当前月份，与 formatTime 保持一致
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const currentMonthIndex = chinaNow.getUTCMonth()
  return Object.values(empMap).map(stat => {
    const programmerMonthlyRoots = months.map(m => ({ id: stat.employee.id, ...m, roots: stat.progMonthlyMap[m.key] || 0 }))
    return {
      employee: stat.employee,
      year,
      totalRoots: Object.values(stat.monthlyMap).reduce((s, v) => s + v, 0),
      monthlyRoots: months.map(m => ({ id: stat.employee.id, ...m, roots: stat.monthlyMap[m.key] || 0 })),
      currentMonthRoots: stat.monthlyMap[(months[currentMonthIndex] || {}).key] || 0,
      // 配合根数（编程员/调字员维度，仅需配合人员的工序产生）
      programmerTotalRoots: programmerMonthlyRoots.reduce((s, m) => s + m.roots, 0),
      programmerMonthlyRoots,
      programmerCurrentMonthRoots: programmerMonthlyRoots[currentMonthIndex] ? programmerMonthlyRoots[currentMonthIndex].roots : 0
    }
  })
}

// 获取所有生产明细行（批量，服务器端聚合）
async function getProductionRows() {
  const ordersData = await fetchOrdersForStats().catch(() => [])
  const rows = []
  for (const order of ordersData) {
    for (const record of (order.history || [])) {
      if (!record.operator || record.operator === '系统流转') continue
      const monthMatch = String(record.completedAt || '').match(/^(\d{4}-\d{2})/)
      rows.push({
        orderId: order.id,
        customerName: order.customerName || '',
        qty: Number(record.qty) || 0,
        employeeId: record.operatorId || '',
        employeeName: record.operator,
        // 配合人员（敦压/拉尾子/精车/铣方头 = 编程员；打字 = 调字员）
        programmerId: record.programmerId || '',
        programmerName: record.programmerName || '',
        partnerRole: record.partnerRole || DEFAULT_PARTNER_LABEL,
        partnerKeyword: record.partnerKeyword || DEFAULT_PARTNER_KEYWORD,
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

      // 并行删除当前批次，显著加速清理
      const delResults = await Promise.allSettled(
        res.data.map(doc => db.collection('audit_logs').doc(doc._id).remove())
      )
      totalDeleted += delResults.filter(r => r.status === 'fulfilled').length
      if (res.data.length < 100) break
    }
    return totalDeleted
  } catch (err) {
    return 0
  }
}

// ===== 固定工序模板 =====

// 列出所有模板
async function listProcessTemplates() {
  try {
    const res = await db.collection('process_templates').orderBy('updatedAt', 'desc').limit(100).get()
    return res.data || []
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

// 保存新模板（管理员）
async function saveProcessTemplate(name, stepKeys, description, user) {
  requireAdmin(user)
  const trimmedName = (name || '').trim()
  if (!trimmedName) throw new Error('请输入模板名称')
  if (!Array.isArray(stepKeys) || stepKeys.length === 0) throw new Error('模板至少包含一个工序')
  const trimmedDesc = (description || '').trim()
  const now = db.serverDate()
  const doc = {
    name: trimmedName.slice(0, 30),
    description: trimmedDesc.slice(0, 200),
    stepKeys: stepKeys.slice(0, 30),
    createdBy: user._id,
    createdByName: user.name,
    createdAt: now,
    updatedAt: now
  }
  const addRes = await db.collection('process_templates').add({ data: doc })
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '保存工序模板',
        targetId: addRes._id,
        targetName: trimmedName,
        operatorId: user._id,
        operatorName: user.name,
        detail: { stepCount: stepKeys.length, description: trimmedDesc },
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }
  return { _id: addRes._id, ...doc, createdAt: new Date(), updatedAt: new Date() }
}

// 删除模板（管理员）
async function deleteProcessTemplate(templateId, user) {
  requireAdmin(user)
  const tplRes = await db.collection('process_templates').doc(templateId).get()
  const tplName = (tplRes.data || {}).name || templateId
  const delRes = await db.collection('process_templates').doc(templateId).remove()
  if (delRes.stats.removed === 0) throw new Error('模板不存在或已删除')
  try {
    await db.collection('audit_logs').add({
      data: {
        action: '删除工序模板',
        targetId: templateId,
        targetName: tplName,
        operatorId: user._id,
        operatorName: user.name,
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }
  return { deleted: true, templateId }
}

// ===================== 工单认领 =====================
//
// 设计要点：
//   - 认领信息双写：
//       1) 订单文档上的 activeClaim（单据级快照：列表/详情展示 + 原子约束 + 完成校验）
//       2) order_claims 集合（认领流水，status: active/completed/released）
//     「我的工单」与管理员认领视图从 order_claims 查询；工单卡片上的认领人从 activeClaim 读
//   - 同一工单同一时刻至多一个进行中的认领：写入用 _.or 原子条件（activeClaim 缺失或为 null
//     且 currentStepIndex 未变），两个员工同时抢认领时数据库层面保证只有一人成功
//   - 认领绑定工序下标：完成并流转后该认领自动归档为 completed；撤回工序/修改工序配置
//     会释放进行中的认领（released），需要时员工重新认领
//   - 权限：员工岗位必须匹配当前工序 station；管理员不受限；认领人本人与管理员可撤销

// 归档认领流水（completed / released）。失败不影响主流程（认领以订单上的 activeClaim 为准）
async function _archiveClaim(claim, patch) {
  if (!claim || !claim.claimId) return
  try {
    await db.collection('order_claims').where({
      claimId: claim.claimId,
      status: 'active'
    }).update({
      data: {
        status: patch.status,
        ...(patch.completedAt ? { completedAt: patch.completedAt } : {}),
        ...(patch.releasedAt ? { releasedAt: patch.releasedAt } : {}),
        ...(patch.releasedBy ? { releasedBy: patch.releasedBy } : {}),
        ...(patch.releasedById ? { releasedById: patch.releasedById } : {}),
        ...(patch.reason ? { reason: patch.reason } : {})
      }
    })
  } catch (e) { /* 非关键 */ }
}

/**
 * 确保 order_claims 集合存在（冷启动后首次认领时自动建，已存在则忽略报错）
 * 控制台手动建过就不依赖这里；没建过也不会再报 -502005 collection not exists
 */
let _claimsCollectionEnsured = false
async function _ensureClaimsCollection() {
  if (_claimsCollectionEnsured) return
  try {
    await db.createCollection('order_claims')
  } catch (e) { /* 集合已存在或环境不支持，忽略 */ }
  _claimsCollectionEnsured = true
}

/**
 * 认领工单当前工序
 * 幂等：本人已认领当前工序时重复调用直接成功；
 * 冲突：已被他人认领时报错；原子条件防止并发抢认领
 */
async function claimOrder(orderId, user) {
  if (!user) throw new Error('用户不存在')
  if (user.status !== 'active') throw new Error('账号未启用')
  if (!orderId) throw new Error('缺少工单ID')

  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]
  if (order.status === 'completed') throw new Error('工单已完工，无需认领')

  const isAdmin = user.role === 'admin' || user.role === 'superadmin'
  if (order.paused && !isAdmin) throw new Error('工单已暂停，仅管理员可操作')

  const steps = buildSteps(order.stepKeys)
  const curIdx = Number(order.currentStepIndex) || 0
  const curStep = steps[curIdx]
  if (!curStep) throw new Error('工单工序已全部完成，无需认领')

  const existing = order.activeClaim || null
  // 幂等：本人已认领当前工序 → 重复点击无害，直接成功
  if (existing && existing.userId === user._id && Number(existing.stepIndex) === curIdx) {
    return { alreadyClaimed: true, claim: existing, order: await getOrder(orderId) }
  }
  if (existing && existing.userId !== user._id) {
    throw new Error(`该工序已被「${existing.userName || '其他员工'}」认领，需等其完成流转，或由管理员撤销认领`)
  }
  // 异常兜底：本人认领的是旧工序（数据不一致时可能出现）→ 先归档旧认领再重新认领
  if (existing && existing.userId === user._id) {
    await _archiveClaim(existing, { status: 'released', releasedAt: formatTime(), releasedBy: user.name, releasedById: user._id, reason: 'stale' })
  }

  // 岗位校验：员工岗位必须包含当前工序 station，管理员放行
  if (!isAdmin) {
    const stations = Array.isArray(user.stations) ? user.stations : (user.station ? [user.station] : [])
    if (!stations.includes(curStep.station)) {
      throw new Error(`当前工序仅限${curStep.station}或管理员认领`)
    }
  }

  const claim = {
    claimId: `C_${orderId}_${curIdx}_${Date.now()}`,
    userId: user._id,
    userName: user.name,
    stepIndex: curIdx,
    stepKey: curStep.key,
    stepName: curStep.name,
    claimedAt: formatTime()
  }

  // 原子认领：仅当 currentStepIndex 未变且无人认领（activeClaim 缺失或为 null）时才写入
  const lockBase = { _id: order._id, currentStepIndex: curIdx }
  const claimFreeCond = _.or([
    { ...lockBase, activeClaim: _.exists(false) },
    { ...lockBase, activeClaim: _.eq(null) }
  ])
  const upd = await db.collection('orders').where(claimFreeCond).update({
    // 【坑】update 传普通对象会被 SDK 拆成点路径合并更新（activeClaim.claimId...），
    // 目标字段 activeClaim 为 null 时报 "Cannot create field in element {activeClaim: null}"。
    // 必须用 _.set 整体替换，null 也能写入。
    data: { activeClaim: _.set(claim), updatedAt: db.serverDate() }
  })
  if (upd.stats.updated === 0) {
    throw new Error('认领失败：工单状态已变更或刚被他人认领，请刷新后重试')
  }

  try {
    await _ensureClaimsCollection()
    await db.collection('order_claims').add({
      data: { orderId, ...claim, status: 'active', createdAt: db.serverDate() }
    })
  } catch (e) { /* 流水写失败不影响认领结果 */ }

  try {
    await db.collection('audit_logs').add({
      data: { action: '认领工单', targetId: orderId, targetName: curStep.name, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return { alreadyClaimed: false, claim, order: await getOrder(orderId) }
}

/**
 * 撤销认领：认领人本人可取消自己的认领；管理员可撤销任何人的认领（换人推进）
 */
async function releaseClaim(orderId, user) {
  if (!user) throw new Error('用户不存在')
  if (user.status !== 'active') throw new Error('账号未启用')
  if (!orderId) throw new Error('缺少工单ID')

  const res = await db.collection('orders').where({ id: orderId }).get()
  if (res.data.length === 0) throw new Error('工单不存在')
  const order = res.data[0]
  const claim = order.activeClaim
  if (!claim) throw new Error('该工单当前没有进行中的认领')

  const isAdmin = user.role === 'admin' || user.role === 'superadmin'
  if (!isAdmin && claim.userId !== user._id) {
    throw new Error('仅认领人本人或管理员可撤销认领')
  }
  const reason = isAdmin && claim.userId !== user._id ? 'admin_revoke' : 'self_cancel'
  await _releaseActiveClaim(order, user, reason)

  try {
    await db.collection('audit_logs').add({
      data: {
        action: '撤销认领',
        targetId: orderId,
        targetName: claim.stepName || '',
        operatorId: user._id,
        operatorName: user.name,
        detail: { claimUserId: claim.userId, claimUserName: claim.userName, reason },
        createdAt: db.serverDate()
      }
    })
  } catch (e) { /* 非关键 */ }

  return { released: true, order: await getOrder(orderId) }
}

// 释放工单上的进行中认领（清 activeClaim + 归档流水），供撤销认领调用
async function _releaseActiveClaim(order, user, reason) {
  const claim = order.activeClaim
  if (!claim) return false
  // 条件更新：claimId 未被并发改过才清空，防止误删他人的新认领
  const upd = await db.collection('orders').where({
    _id: order._id,
    'activeClaim.claimId': claim.claimId
  }).update({ data: { activeClaim: null, updatedAt: db.serverDate() } })
  await _archiveClaim(claim, {
    status: 'released',
    releasedAt: formatTime(),
    releasedBy: user ? user.name : '',
    releasedById: user ? user._id : '',
    reason: reason || ''
  })
  return upd.stats.updated > 0
}

/**
 * 认领列表
 * @param {string} scope 'my' 本人全部认领 | 'all' 全员认领（仅管理员）
 * @param {string[]} statuses 默认 ['active','completed']；released（被撤销）默认不展示
 * 返回的每条认领带 order 工单概要（状态标签/当前工序等派生字段已就绪）
 */
async function listClaims(scope, statuses, user) {
  if (!user) throw new Error('用户不存在')
  const wantAll = scope === 'all'
  if (wantAll) requireAdmin(user)
  const statusList = (Array.isArray(statuses) && statuses.length > 0)
    ? statuses.filter(s => ['active', 'completed', 'released'].includes(s))
    : ['active', 'completed']
  if (statusList.length === 0) return []

  const where = wantAll
    ? { status: _.in(statusList) }
    : { userId: user._id, status: _.in(statusList) }

  let claims = []
  try {
    const res = await db.collection('order_claims')
      .where(where)
      .orderBy('claimedAt', 'desc')
      .limit(200)
      .get()
    claims = res.data || []
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
  if (claims.length === 0) return []

  // 联查工单概要（enrichOrder 补状态标签/当前工序/进度等派生字段）
  const orderIds = [...new Set(claims.map(c => c.orderId).filter(Boolean))]
  const orderMap = {}
  const PAGE = 100
  for (let i = 0; i < orderIds.length; i += PAGE) {
    const batch = orderIds.slice(i, i + PAGE)
    const res = await db.collection('orders').where({ id: _.in(batch) }).get()
    for (const o of res.data || []) orderMap[o.id] = enrichOrder(o)
  }

  return claims.map(c => {
    const o = orderMap[c.orderId]
    return {
      ...c,
      order: o ? {
        id: o.id,
        customerName: o.customerName || '',
        type: o.type || '',
        size: o.size || '',
        qty: o.qty || 0,
        material: o.material || '',
        dueDate: o.dueDate || '',
        urgent: !!o.urgent,
        statusLabel: o.statusLabel || '',
        category: o.category || '',
        currentStepName: o.currentStepName || '',
        currentStation: o.currentStation || '',
        progress: o.progress || 0,
        activeClaim: o.activeClaim || null,
        completedDate: o.completedDate || null
      } : null
    }
  })
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
        return { success: true, order: await revertStep(event.orderId, event.stepKey, event.stepIndex, user) }

      case 'updateStepKeys':
        if (!event.orderId || !event.stepKeys) return { success: false, error: '缺少参数' }
        return { success: true, order: await updateStepKeys(event.orderId, event.stepKeys, user) }

      case 'updateDrawings':
        if (!event.orderId || !event.drawings) return { success: false, error: '缺少参数' }
        return { success: true, order: await updateDrawings(event.orderId, event.drawings, user, event.mode) }

      case 'updateOrderFields':
        if (!event.orderId || !event.fields) return { success: false, error: '缺少参数' }
        return { success: true, order: await updateOrderFields(event.orderId, event.fields, user) }

      case 'deleteOrder':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, result: await deleteOrder(event.orderId, user) }

      case 'safeDeleteOrder':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, result: await safeDeleteOrder(event.orderId, user, event.note) }

      case 'listProcessTemplates':
        return { success: true, templates: await listProcessTemplates() }

      case 'saveProcessTemplate':
        return { success: true, template: await saveProcessTemplate(event.name, event.stepKeys, event.description, user) }

      case 'deleteProcessTemplate':
        if (!event.templateId) return { success: false, error: '缺少模板ID' }
        return { success: true, result: await deleteProcessTemplate(event.templateId, user) }

      case 'employeeMonthlyProduction':
        if (!event.employeeId) return { success: false, error: '缺少员工ID' }
        return { success: true, data: await getEmployeeMonthlyProduction(event.employeeId, event.year || String(new Date().getFullYear())) }

      case 'allEmployeesMonthlyProduction':
        return { success: true, stats: await getAllEmployeesMonthlyProduction(event.year || String(new Date().getFullYear())) }

      case 'productionRows':
        return { success: true, rows: await getProductionRows() }

      case 'drawingUrls':
        // 服务端解析图纸临时链接（管理员权限，不受客户端存储安全规则限制）
        return resolveDrawingUrls(event.fileIDs)

      case 'claimOrder':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, ...(await claimOrder(event.orderId, user)) }

      case 'releaseClaim':
        if (!event.orderId) return { success: false, error: '缺少工单ID' }
        return { success: true, ...(await releaseClaim(event.orderId, user)) }

      case 'listClaims':
        return { success: true, claims: await listClaims(event.scope, event.statuses, user) }

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

/**
 * 服务端解析文件临时链接（drawingUrls action）
 * 云函数以管理员权限运行，不受客户端存储安全规则限制——
 * 客户端因存储权限（如「仅创建者可读写」）拿不到下载链接
 * （getTempFileURL 无结果 / downloadFile 报 empty download url）时，走这里兜底。
 */
async function resolveDrawingUrls(fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : [])
    .filter(id => typeof id === 'string' && id.indexOf('cloud://') === 0)
    .slice(0, 50)
  if (list.length === 0) return { success: false, error: '缺少有效的文件ID' }
  const res = await cloud.getTempFileURL({ fileList: list })
  const urls = ((res && res.fileList) || []).map(item => ({
    fileID: item.fileID,
    tempFileURL: item.tempFileURL || '',
    status: item.status,
    errMsg: item.errMsg || ''
  }))
  return { success: true, urls }
}
