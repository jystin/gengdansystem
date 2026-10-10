/**
 * 完成工序云函数
 * 将工单当前工序标记为完成，流转到下一工序
 * 支持下料工序的材料库存扣减
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 工序库（与 orderManager / createOrder / init-db / miniprogram/utils/api.js 保持一致）
//
//   needPartner:    该工序完成后必须指定一名「配合人员」（默认是编程员）
//   partnerKeyword: 配合人员的岗位关键字（默认「编程」）
//   partnerLabel:   配合人员的界面称谓（默认「编程员」），如打字工序为「调字员」
//   repeatable + maxRepeat: 可重复多道（精车最多 4 道）
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

// 已下线的工序：不在「可选工序」，但老工单 stepKeys 可能仍带「编程」，须能解析
const LEGACY_PROCESSES = {
  programming: { key: 'programming', name: '编程', station: '编程工' }
}

const PROCESS_MAP = Object.fromEntries(
  PROCESS_LIBRARY.map(p => [p.key, p]).concat(Object.entries(LEGACY_PROCESSES))
)

const DEFAULT_PARTNER_KEYWORD = '编程'
const DEFAULT_PARTNER_LABEL = '编程员'

/** 归一化某工序的「配合人员」配置（兼容旧字段 needProgrammer） */
function resolvePartner(step) {
  const need = !!(step && (step.needPartner || step.needProgrammer))
  return {
    need,
    keyword: (step && step.partnerKeyword) || DEFAULT_PARTNER_KEYWORD,
    label: (step && step.partnerLabel) || DEFAULT_PARTNER_LABEL
  }
}

/** 岗位名里是否包含指定关键字（如「编程」「调字」） */
function hasStationKeyword(stations, keyword) {
  return (stations || []).some(s => String(s).includes(keyword))
}

/**
 * 把 stepKeys 展开成工序对象数组（与 orderManager.buildSteps 保持一致）
 * 重复工序自动编号：精车 → 精车1 / 精车2 / 精车3 / 精车4
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
      // 归一化「配合人员」配置（前端统一读 needProgrammer / partnerLabel / partnerKeyword）
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

// 获取中国时区（UTC+8）当前时间，云函数默认运行在 UTC 时区
function getChinaNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
}

// 使用 UTC+8 格式化时间，避免月末晚上 8 点后完成的工序被归到下个月
// 修复前：formatTime 用 getMonth() 等本地方法，云函数 UTC 环境下返回 UTC 时间
function formatTime() {
  const china = getChinaNow()
  const pad = n => String(n).padStart(2, '0')
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}`
}

// 归档认领流水（与 orderManager._archiveClaim 同逻辑；本函数独立部署，需自带一份）
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
        ...(patch.reason ? { reason: patch.reason } : {})
      }
    })
  } catch (e) { /* 非关键 */ }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { orderId, operatorId, note, completedQty, materialConsumption, programmerId, repeatTotal } = event

    if (!orderId) return { success: false, error: '缺少工单ID' }
    if (!operatorId) return { success: false, error: '缺少操作员ID' }

    // 权限校验
    const userRes = await db.collection('users').where({ openid }).get()
    if (userRes.data.length === 0) return { success: false, error: '用户不存在' }
    const user = userRes.data[0]
    if (user.status !== 'active') return { success: false, error: '账号未激活' }

    const isAdmin = user.role === 'admin' || user.role === 'superadmin'

    // 非管理员必须本人操作
    if (!isAdmin && user._id !== operatorId) {
      return { success: false, error: '只能操作自己的工序' }
    }

    // 验证 operatorId 对应的用户存在且活跃（管理员代操作时记录历史用）
    let effectiveOperator = user
    if (operatorId !== user._id) {
      try {
        const opRes = await db.collection('users').doc(operatorId).get()
        if (!opRes.data || opRes.data.status !== 'active') {
          return { success: false, error: '指定的操作员不存在或未激活' }
        }
        effectiveOperator = opRes.data
      } catch (e) {
        return { success: false, error: '指定的操作员不存在' }
      }
    }

    // 查询工单
    const orderRes = await db.collection('orders').where({ id: orderId }).get()
    if (orderRes.data.length === 0) return { success: false, error: '工单不存在' }
    const order = orderRes.data[0]

    if (order.status === 'completed') return { success: false, error: '工单已完工' }
    if (order.paused && user.role !== 'admin' && user.role !== 'superadmin') {
      return { success: false, error: '工单已暂停，仅管理员可处理' }
    }

    const oldStepKeys = Array.isArray(order.stepKeys) ? order.stepKeys : []
    const steps = buildSteps(oldStepKeys)
    const curIdx = Number(order.currentStepIndex) || 0
    const currentStep = steps[curIdx]
    if (!currentStep) {
      // 所有工序已完成或索引越界，记录完工操作并标记为已完成
      // 关键修复：使用乐观锁防止并发完成
      const completeHistoryEntry = {
        stepKey: '__completed__',
        stepName: '工单完工',
        operatorId: effectiveOperator._id,
        operator: effectiveOperator.name,
        role: '系统',
        completedAt: formatTime(),
        note: note || '系统自动完工确认',
        qty: null,
        materialConsumption: null
      }
      const finalHistory = [...(order.history || []), completeHistoryEntry]
      const lockUpdate = await db.collection('orders').where({
        _id: order._id,
        status: 'processing' // 修复：仅当状态还是 processing 时才置为 completed，防止并发重复完工
      }).update({
        data: {
          status: 'completed',
          completedDate: formatTime(),
          history: finalHistory,
          // 兜底：完工时清掉可能残留的进行中认领
          ...(order.activeClaim ? { activeClaim: null } : {}),
          updatedAt: db.serverDate()
        }
      })
      if (lockUpdate.stats.updated === 0) {
        return { success: false, error: '该工单已被处理，请刷新后重试' }
      }
      // 归档残留认领流水
      if (order.activeClaim) {
        await _archiveClaim(order.activeClaim, { status: 'completed', completedAt: formatTime() })
      }
      // 记录审计日志
      try {
        await db.collection('audit_logs').add({
          data: {
            action: '完成工序',
            targetId: orderId,
            targetName: '工单完工',
            operatorId: effectiveOperator._id,
            operatorName: effectiveOperator.name,
            detail: {
              submittedBy: user.name,
              submittedById: user._id,
              proxy: user._id !== effectiveOperator._id,
              note: note || '系统自动完工确认'
            },
            createdAt: db.serverDate()
          }
        })
      } catch (e) { /* 非关键 */ }
      // 构建 steps 数组供前端使用（自动完工情况）
      const finalSteps = buildSteps(order.stepKeys)
      return { success: true, order: { ...order, stepKeys: oldStepKeys, steps: finalSteps, currentStepName: '已完成', currentStation: '入库完成', status: 'completed', completedDate: formatTime(), history: finalHistory } }
    }

    // ===== 认领校验：工序已被认领时，仅认领人本人或管理员可完成 =====
    // 认领绑定当前工序下标；管理员代操作（operatorId=他人）仍然放行
    const activeClaim = order.activeClaim || null
    const claimActive = !!(activeClaim && Number(activeClaim.stepIndex) === curIdx)
    if (claimActive && !isAdmin && activeClaim.userId !== user._id) {
      return {
        success: false,
        error: `该工序已被「${activeClaim.userName || '其他员工'}」认领，需等其完成流转，或由管理员撤销认领`
      }
    }

    // ===== 配合人员校验（敦压 / 拉尾子 / 精车 / 铣方头 = 编程员；打字 = 调字员）=====
    // 规则（严格岗位匹配，不再「放宽为任意在职员工」）：
    //   1) 该工序带 needPartner(兼容 needProgrammer) 标记时必须传 programmerId
    //   2) 该员工必须是「活跃」用户，且岗位必须包含本工序配置的 partnerKeyword
    //      （默认「编程」；打字工序为「调字」）——编程员不能代替调字员，反之亦然
    const partnerCfg = resolvePartner(currentStep)
    let effectiveProgrammer = null
    if (partnerCfg.need) {
      if (!programmerId) {
        return { success: false, error: `「${currentStep.name}」需要选择${partnerCfg.label}` }
      }
      let programmer = null
      try {
        const pRes = await db.collection('users').doc(programmerId).get()
        programmer = pRes.data || null
      } catch (e) {
        return { success: false, error: `指定的${partnerCfg.label}不存在` }
      }
      if (!programmer || programmer.status !== 'active') {
        return { success: false, error: `指定的${partnerCfg.label}不存在或未激活` }
      }
      if (!hasStationKeyword(programmer.stations, partnerCfg.keyword)) {
        // 严格校验：岗位不含关键字一律拒绝。若系统里根本没人配该岗位，
        // 给出「去员工管理分配岗位」的可执行提示，避免用户反复试错
        let partnerPoolExists = false
        try {
          const poolRes = await db.collection('users')
            .where({ status: 'active' })
            .limit(500)
            .get()
          partnerPoolExists = (poolRes.data || [])
            .some(u => hasStationKeyword(u.stations, partnerCfg.keyword))
        } catch (e) { /* 查询失败按严格处理 */ partnerPoolExists = true }

        return {
          success: false,
          error: partnerPoolExists
            ? `「${programmer.name}」的岗位不是${partnerCfg.label}，请重新选择${partnerCfg.label}`
            : `系统里还没有「${partnerCfg.label}」岗位的员工，请先到「员工管理」给员工分配含「${partnerCfg.keyword}」的岗位`
        }
      }
      effectiveProgrammer = programmer
    }

    // 岗位校验：操作员（effectiveOperator）是管理员则不受岗位限制；普通员工必须岗位匹配
    const isOperatorAdmin = effectiveOperator.role === 'admin' || effectiveOperator.role === 'superadmin'
    if (!isOperatorAdmin) {
      const stations = effectiveOperator.stations || []
      if (!stations.includes(currentStep.station)) {
        return { success: false, error: `当前工序仅允许${currentStep.station}处理` }
      }
    }

    // 下料工序：检查材料库存（仅读取，不写入）
    let inventoryDeduction = null // { invId, oldStock, material, roughness, dedQty }
    if (currentStep.key === 'blanking' && materialConsumption && materialConsumption.material) {
      const { material, roughness, qty, calcTons } = materialConsumption
      const dedQty = calcTons || Number(qty)
      if (dedQty > 0) {
        try {
          // 先读取库存检查是否充足（不写入，防止竞态时重复扣减）
          const invRes = await db.collection('inventory').where({ name: material }).get()
          if (invRes.data.length === 0) {
            // 【修复 Bug】库存记录不存在时也必须拒绝下料，避免前端显示 0 但后端通过
            return { success: false, error: `材料「${material}」库存记录不存在，无法下料` }
          }
          const inv = invRes.data[0]
          const stock = inv.stock || {}
          const rKey = String(roughness)
          // 【修复 Bug】用 ?? 0 替代 || 0，避免把 0/负数/NaN 都错误归一化；
          // 并显式校验数字有效性，NaN/Infinity 一律视为 0 库存
          let currentStock = Number(stock[rKey])
          if (!Number.isFinite(currentStock)) currentStock = 0
          // 0 库存或负库存（历史数据）一律视为不可下料
          if (currentStock < dedQty) {
            return { success: false, error: `${material} φ${rKey} 库存不足，当前剩余 ${currentStock.toFixed(4)} 吨` }
          }
          inventoryDeduction = { invId: inv._id, oldStock: { ...stock }, material, roughness: rKey, dedQty }
        } catch (err) {
          if (err.errCode !== -502005 && !String(err.errMsg || '').includes('not exist')) {
            return { success: false, error: '库存查询异常，请检查库存数据后重试: ' + (err.message || '未知错误') }
          }
          // 库存集合不存在（极端情况）也必须拒绝下料
          return { success: false, error: `材料「${material}」库存数据缺失，无法下料` }
        }
      }
    }

    // 记录历史
    // 根数：普通工序从 completedQty 获取，下料工序从 materialConsumption.qty 获取
    let recordQty = null
    if (currentStep.key === 'blanking' && materialConsumption && materialConsumption.qty) {
      recordQty = Number(materialConsumption.qty) || null
    } else if (completedQty !== null && completedQty !== undefined && completedQty !== '') {
      const num = Number(completedQty)
      recordQty = isNaN(num) ? null : num
    }

    const historyEntry = {
      stepKey: currentStep.key,
      stepName: currentStep.name,
      stepSeq: currentStep._seq || 1,
      operatorId: effectiveOperator._id,
      operator: effectiveOperator.name,
      role: currentStep.station,
      // 配合人员（敦压/拉尾子/精车/铣方头 = 编程员；打字 = 调字员）
      programmerId: effectiveProgrammer ? effectiveProgrammer._id : '',
      programmerName: effectiveProgrammer ? effectiveProgrammer.name : '',
      partnerRole: effectiveProgrammer ? partnerCfg.label : '',
      partnerKeyword: effectiveProgrammer ? partnerCfg.keyword : '',
      completedAt: formatTime(),
      note: note || '',
      qty: recordQty,
      materialConsumption: materialConsumption && materialConsumption.material ? {
        material: materialConsumption.material,
        roughness: materialConsumption.roughness || '',
        length: materialConsumption.length || '',
        qty: materialConsumption.qty,
        calcTons: materialConsumption.calcTons || null
      } : null
    }

    const newHistory = [...(order.history || []), historyEntry]
    const newStepIndex = curIdx + 1

    // ===== 可重复工序（精车）道数调整 =====
    // 前端传 repeatTotal = 「本工单该工序总共要几道」。按差值追加/回收「未完成」的重复工序：
    //   例：已排 精车1/2/3，正在完成精车1，选 4 道 → 追加 1 道（精车4）
    //       已排 精车1/2/3，正在完成精车2，改选 2 道 → 回收最后 1 道未完成的精车
    // 只会动「未完成」的那几道（位于当前工序之后），已完成的历史记录不受影响。
    const newStepKeys = [...oldStepKeys]
    let repeatDelta = 0
    if (currentStep.repeatable) {
      const maxTotal = Number(currentStep.maxRepeat) || 4
      const totalNow = newStepKeys.filter(k => k === currentStep.key).length
      // 已排道数下限 = 刚完成的这道（含）→ 不会误删已完成的工序
      const wanted = Math.max(
        Number(repeatTotal) || currentStep._seq || 1,
        currentStep._seq || 1
      )
      const target = Math.min(wanted, maxTotal)
      repeatDelta = target - totalNow

      if (repeatDelta > 0) {
        // 追加到当前工序之后（保持精车连续挨在一起）
        newStepKeys.splice(newStepIndex, 0, ...Array(repeatDelta).fill(currentStep.key))
      } else if (repeatDelta < 0) {
        // 回收最后 |repeatDelta| 道未完成的重复工序（只动 newStepIndex 之后的，不碰已完成）
        let toRemove = -repeatDelta
        for (let i = newStepKeys.length - 1; i >= newStepIndex && toRemove > 0; i--) {
          if (newStepKeys[i] === currentStep.key) {
            newStepKeys.splice(i, 1)
            toRemove--
          }
        }
      }
    }

    const finalSteps = buildSteps(newStepKeys)
    const isCompleted = newStepIndex >= finalSteps.length

    // 修复：管理员在暂停状态下完成工序时，需正确处理 paused 标志
    // - 完成最后一道工序 → status='completed', paused=false（完工工单不能暂停）
    // - 暂停状态下完成中间工序 → 保持 paused=true, status='paused'（togglePause 逻辑一致）
    // - 正常完成中间工序 → status='processing', paused=false
    const newStatus = isCompleted ? 'completed' : (order.paused ? 'paused' : 'processing')
    const newPaused = isCompleted ? false : order.paused

    // 乐观锁并发保护：仅当 currentStepIndex 未变化时才更新，防止重复完成
    const updateResult = await db.collection('orders').where({
      _id: order._id,
      currentStepIndex: order.currentStepIndex
    }).update({
      data: {
        currentStepIndex: newStepIndex,
        stepKeys: newStepKeys,
        status: newStatus,
        paused: newPaused,
        completedDate: isCompleted ? formatTime() : null,
        history: newHistory,
        // 认领联动：本工序完成流转后清掉进行中认领（流水归档为 completed，
        // 在认领人的「我的工单」里自动移到已完成）
        ...(claimActive ? { activeClaim: null } : {}),
        updatedAt: db.serverDate()
      }
    })
    if (updateResult.stats.updated === 0) {
      return { success: false, error: '该工序已被处理，请刷新后重试' }
    }

    // 乐观锁成功 → 执行实际库存扣减
    // 【原子保护】使用 where 条件 + inc 一步完成：只有当 stock >= dedQty 时数据库才执行扣减
    // 数据库引擎层面保证不会扣成负数，无需 check-then-inc 两步，从根本上杜绝并发超扣
    if (inventoryDeduction) {
      const { invId, material, roughness, dedQty } = inventoryDeduction
      try {
        const stockPath = `stock.${roughness}`
        const _ = db.command
        // 原子扣减：where 条件保证 stock[roughness] >= dedQty 才执行 inc(-dedQty)
        const deductRes = await db.collection('inventory').where({
          _id: invId,
          [stockPath]: _.gte(dedQty)
        }).update({
          data: {
            [stockPath]: _.inc(-dedQty),
            lastUpdatedAt: db.serverDate()
          }
        })
        if (deductRes.stats.updated === 0) {
          // 库存不足或被并发占用（可能已被其它请求扣减）→ 回滚工序状态
          let remainStock = 0
          try {
            const invNow = await db.collection('inventory').doc(invId).get()
            const s = Number((invNow.data.stock || {})[roughness])
            remainStock = Number.isFinite(s) ? s : 0
          } catch (e) { /* 忽略 */ }
          // 乐观锁回滚：仅当 currentStepIndex 还是 newStepIndex 时才回滚，避免覆盖其他人的修改
          try {
            await db.collection('orders').where({
              _id: order._id,
              currentStepIndex: newStepIndex
            }).update({
              data: {
                currentStepIndex: order.currentStepIndex,
                // 回滚时同步还原工序列表（本次可能追加/回收了重复工序）
                stepKeys: oldStepKeys,
                status: order.status,
                completedDate: order.completedDate || null,
                history: order.history || [],
                // 回滚时还原进行中认领（认领随本工序完成被清掉，失败需还原）
                // 【坑】目标字段此时刚被主更新置为 null，普通对象写入会报
                // "Cannot create field in element {activeClaim: null}"，必须 _.set 整体替换
                activeClaim: order.activeClaim ? db.command.set(order.activeClaim) : null,
                updatedAt: db.serverDate()
              }
            })
          } catch (rollbackErr) {
            console.error('[completeStep] 工序回滚失败:', rollbackErr.message)
          }
          return {
            success: false,
            error: `${material} φ${roughness} 库存不足（可能被并发占用），当前剩余 ${remainStock.toFixed(4)} 吨`
          }
        }
        // 异步记录材料出库日志（不阻塞主流程）
        db.collection('material_logs').add({
          data: {
            type: 'out',
            material,
            roughness,
            qty: dedQty,
            operator: effectiveOperator.name,
            operatorId: effectiveOperator._id,
            note: `工单 ${orderId} 下料`,
            orderId,
            createdAt: db.serverDate()
          }
        }).catch(() => {})
      } catch (err) {
        // 库存扣减失败 → 回滚工序状态，保证数据一致性
        console.error('[completeStep] 库存扣减失败，回滚工序:', err.message)
        try {
          // 乐观锁回滚：仅当 currentStepIndex 还是 newStepIndex 时才回滚
          await db.collection('orders').where({
            _id: order._id,
            currentStepIndex: newStepIndex
          }).update({
            data: {
              currentStepIndex: order.currentStepIndex,
              // 回滚时同步还原工序列表（本次可能追加/回收了重复工序）
              stepKeys: oldStepKeys,
              status: order.status,
              completedDate: order.completedDate || null,
              history: order.history || [],
              // 回滚时还原进行中认领（认领随本工序完成被清掉，失败需还原）
              // 【坑】目标字段此时刚被主更新置为 null，普通对象写入会报
              // "Cannot create field in element {activeClaim: null}"，必须 _.set 整体替换
              activeClaim: order.activeClaim ? db.command.set(order.activeClaim) : null,
              updatedAt: db.serverDate()
            }
          })
        } catch (rollbackErr) {
          console.error('[completeStep] 工序回滚失败:', rollbackErr.message)
        }
        return { success: false, error: `库存扣减失败: ${err.message}，工序已回滚，请重试` }
      }
    }

    // 认领流水归档为已完成（放在库存扣减成功之后：库存失败回滚时认领仍是进行中）
    if (claimActive) {
      await _archiveClaim(activeClaim, { status: 'completed', completedAt: formatTime() })
    }

    // 审计日志（记录实际工序操作员，非提交人）
    try {
      await db.collection('audit_logs').add({
        data: {
          action: '完成工序',
          targetId: orderId,
          targetName: currentStep.name,
          operatorId: effectiveOperator._id,
          operatorName: effectiveOperator.name,
          detail: {
            submittedBy: user.name,
            submittedById: user._id,
            proxy: user._id !== effectiveOperator._id,
            note: note || '',
            qty: recordQty,
            programmerId: effectiveProgrammer ? effectiveProgrammer._id : '',
            programmerName: effectiveProgrammer ? effectiveProgrammer.name : '',
            partnerRole: effectiveProgrammer ? partnerCfg.label : '',
            repeatDelta: repeatDelta || 0
          },
          createdAt: db.serverDate()
        }
      })
    } catch (e) { /* 非关键 */ }

    // 构建 steps 数组供前端使用（含重复工序编号：精车1/精车2...）
    const updatedSteps = buildSteps(newStepKeys)
    const nextCurrentStep = updatedSteps[newStepIndex]
    const updatedOrder = {
      ...order,
      stepKeys: newStepKeys,
      steps: updatedSteps,
      currentStepIndex: newStepIndex,
      currentStepName: nextCurrentStep ? nextCurrentStep.name : (isCompleted ? '已完成' : '无工序'),
      currentStation: nextCurrentStep ? nextCurrentStep.station : (isCompleted ? '入库完成' : ''),
      status: newStatus,
      paused: newPaused,
      completedDate: isCompleted ? formatTime() : null,
      history: newHistory,
      // 认领联动：本工序完成后认领已被清空（回滚场景不会走到这里），返回值与库内一致
      activeClaim: claimActive ? null : (order.activeClaim || null),
      // 补充前端展示需要的派生字段（保持与 orderManager.enrichOrder 一致）
      progress: updatedSteps.length > 0 ? Math.min(Math.round((newStepIndex / updatedSteps.length) * 100), 100) : 0,
      overdue: order.dueDate ? isOverdueAfter({ ...order, status: newStatus }) : false
    }

    return {
      success: true,
      order: updatedOrder
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || '完成工序失败'
    }
  }
}

// 工具：完成工序后重新计算 overdue（使用中国时区 UTC+8）
function isOverdueAfter(order) {
  if (order.status === 'completed') return false
  const china = getChinaNow()
  const pad = n => String(n).padStart(2, '0')
  const todayStr = `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())}`
  return order.dueDate < todayStr
}
