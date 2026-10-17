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

/**
 * 归一化认领映射：{ [stepIndex]: claim[] }（多认领模型，与 orderManager._normalizeStepClaims 同逻辑）
 * 兼容旧数据：activeClaim 单字段、stepClaims 值为单个对象 → 一律包装成数组
 */
function _normalizeStepClaims(order) {
  const map = {}
  const sc = order && order.stepClaims
  if (sc && typeof sc === 'object') {
    for (const k of Object.keys(sc)) {
      const v = sc[k]
      if (Array.isArray(v)) {
        const list = v.filter(Boolean)
        if (list.length > 0) map[Number(k)] = list
      } else if (v) {
        map[Number(k)] = [v]
      }
    }
  }
  const legacy = order && order.activeClaim
  if (legacy && legacy.stepIndex !== undefined && legacy.stepIndex !== null) {
    const idx = Number(legacy.stepIndex)
    if (!map[idx]) map[idx] = [legacy]
  }
  return map
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
        ...(patch.reason ? { reason: patch.reason } : {}),
        // 跨认领完成时记录实际操作人（认领人 ≠ 提交人，供「我的工单」展示）
        ...(patch.completedByName ? { completedByName: patch.completedByName } : {}),
        ...(patch.completedByRole ? { completedByRole: patch.completedByRole } : {}),
        ...(patch.completedById ? { completedById: patch.completedById } : {})
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
    if (steps.length === 0) return { success: false, error: '工单没有工序，无法提交' }

    // ===== 并行模型：提交目标 = 任意未完成工序（event.stepIndex）=====
    // currentStepIndex 新语义 = 「最后一次提交数量的工序下标」（用于首页/列表「当前工序」展示）
    const qtyTargetOrder = Number(order.qty) || 0
    const stepDoneMap = order.stepDone || {}
    const isStepDoneAt = (i) => {
      if (stepDoneMap[i]) return true
      if (qtyTargetOrder > 0 && (Number((order.stepQty || {})[i]) || 0) >= qtyTargetOrder) return true
      // 老工单兼容：从未用过并行模型（无 stepDone 字段）时，顺序指针之前的工序视为已完成
      if (!order.stepDone && i < (Number(order.currentStepIndex) || 0)) return true
      return false
    }
    let rawIdx
    if (event.stepIndex === undefined || event.stepIndex === null || event.stepIndex === '') {
      // 缺省 = 第一道未完成工序（currentStepIndex 是展示指针，不适合做提交目标缺省）
      rawIdx = steps.findIndex((s, i) => !isStepDoneAt(i))
      if (rawIdx < 0) {
        return { success: false, error: '所有工序已完成，请在操作面板确认「工单已完成」' }
      }
    } else {
      rawIdx = Number(event.stepIndex)
    }
    if (!Number.isInteger(rawIdx) || rawIdx < 0 || rawIdx >= steps.length) {
      return { success: false, error: '要完成的工序不存在' }
    }
    if (isStepDoneAt(rawIdx)) {
      return { success: false, error: `「${steps[rawIdx].name}」已完成，无需重复提交` }
    }
    const idx = rawIdx
    const currentStep = steps[idx]

    // ===== 认领校验（并行模型）：普通员工必须先认领该工序才能提交；管理员 / 流转工可跨认领 =====
    // 多认领模型：同一工序可被多人认领（stepClaims 值为数组，含旧数据兼容）；
    // 管理员 / 流转工跨认领完成时，实际操作人记录进认领流水（completedBy*）
    const stepClaimsMap = _normalizeStepClaims(order)
    const claimList = stepClaimsMap[idx] || []
    const claimActive = claimList.length > 0
    const isFloaterUser = (user.stations || []).includes('流转工')
    const iAmClaimant = claimList.some(c => c.userId === user._id)
    if (!isAdmin && !isFloaterUser && !iAmClaimant) {
      if (claimActive) {
        const names = claimList.map(c => c.userName || '其他员工').join('、')
        return {
          success: false,
          error: `「${currentStep.name}」已被「${names}」认领，如需协作请先加入认领`
        }
      }
      return { success: false, error: `请先认领「${currentStep.name}」再提交根数` }
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

    // 岗位校验：操作员（effectiveOperator）是管理员则不受岗位限制；普通员工必须岗位匹配；
    // 流转工是特殊工种，可处理任意工序（其余权限与普通员工一致）
    const isOperatorAdmin = effectiveOperator.role === 'admin' || effectiveOperator.role === 'superadmin'
    if (!isOperatorAdmin) {
      const stations = effectiveOperator.stations || []
      if (!stations.includes(currentStep.station) && !stations.includes('流转工')) {
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
      // 工序下标：前端按工序分组展示历史记录（老数据无此字段时按下标对齐）
      stepIndex: idx,
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

    // ===== 并行模型：数量累计提交 =====
    // 同一工序可被多人认领，各自提交根数原子累加到 stepQty[下标]；
    // 累计达到订单数量 → 标记该工序完成（stepDone），清掉该工序认领并归档流水。
    // 工单本身不因工序完成而完工——须所有工序完成后，由入库仓管员点「工单已完成」收尾。
    // currentStepIndex 新语义 = 最后一次提交数量的工序下标（首页/列表「当前工序」展示）
    const qtyTarget = Number(order.qty) || 0
    const prevAcc = Number((order.stepQty || {})[idx]) || 0
    const submittedQty = Number(recordQty) || 0
    // 部分提交标记：有数量工单且本次提交后累计仍未达标 → 历史记录标记 partial（前端/审计区分「部分完成」）
    if (qtyTarget > 0 && prevAcc + submittedQty < qtyTarget) historyEntry.partial = true
    const _cmd = db.command

    // 基础更新：历史 + 原子累加 + 当前工序指针。
    // 条件 stepDone.neq(true)：该工序一旦完成即不可再提交（防完成后重复提交）
    // 老工单首次并行提交：把顺序指针之前的已完成工序补记 stepDone（一次性迁移）
    const legacyDoneInit = {}
    if (!order.stepDone) {
      for (let i = 0; i < (Number(order.currentStepIndex) || 0); i++) legacyDoneInit[i] = true
    }
    const baseUpdate = await db.collection('orders').where({
      _id: order._id,
      [`stepDone.${idx}`]: _cmd.neq(true)
    }).update({
      data: {
        history: newHistory,
        [`stepQty.${idx}`]: _cmd.inc(submittedQty),
        currentStepIndex: idx,
        ...(Object.keys(legacyDoneInit).length ? { stepDone: _cmd.set({ ...legacyDoneInit }) } : {}),
        updatedAt: db.serverDate()
      }
    })
    if (baseUpdate.stats.updated === 0) {
      return { success: false, error: `「${currentStep.name}」已被其他同事提交完成，请刷新后重试` }
    }

    // 下料工序：原子扣减材料库存（where stock >= dedQty 才执行 inc，杜绝并发超扣），
    // 扣减失败回滚本次提交（历史 + 累计 + 指针）
    if (inventoryDeduction) {
      const { invId, material, roughness, dedQty } = inventoryDeduction
      const rollbackSubmission = async () => {
        try {
          await db.collection('orders').where({ _id: order._id }).update({
            data: {
              history: order.history || [],
              [`stepQty.${idx}`]: _cmd.inc(-submittedQty),
              currentStepIndex: Number(order.currentStepIndex) || 0,
              updatedAt: db.serverDate()
            }
          })
        } catch (rollbackErr) {
          console.error('[completeStep] 提交回滚失败:', rollbackErr.message)
        }
      }
      try {
        const stockPath = `stock.${roughness}`
        const deductRes = await db.collection('inventory').where({
          _id: invId,
          [stockPath]: _cmd.gte(dedQty)
        }).update({
          data: { [stockPath]: _cmd.inc(-dedQty), lastUpdatedAt: db.serverDate() }
        })
        if (deductRes.stats.updated === 0) {
          let remainStock = 0
          try {
            const invNow = await db.collection('inventory').doc(invId).get()
            const s = Number((invNow.data.stock || {})[roughness])
            remainStock = Number.isFinite(s) ? s : 0
          } catch (e) { /* 忽略 */ }
          await rollbackSubmission()
          return { success: false, error: `${material} φ${roughness} 库存不足（可能被并发占用），当前剩余 ${remainStock.toFixed(4)} 吨` }
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
            note: `工单 ${orderId} ${currentStep.name}`,
            orderId,
            createdAt: db.serverDate()
          }
        }).catch(() => {})
      } catch (err) {
        console.error('[completeStep] 库存扣减失败，回滚提交:', err.message)
        await rollbackSubmission()
        return { success: false, error: `库存扣减失败: ${err.message}，记录已回滚，请重试` }
      }
    }

    // 读回最新累计（并发提交后 stepQty 可能大于本地估算，以库内为准）
    let latestAcc = prevAcc + submittedQty
    try {
      const freshRes = await db.collection('orders').doc(order._id).get()
      const fresh = freshRes.data || {}
      latestAcc = Number((fresh.stepQty || {})[idx]) || latestAcc
    } catch (e) { /* 读回失败用本地估算 */ }

    // 完成判定：无数量工单提交一次即完成；有数量工单累计达标即完成
    const stepJustCompleted = !qtyTarget || latestAcc >= qtyTarget

    // 完成标记：条件更新防并发重复标记；同一更新内清掉本工序认领 + 更新最后提交指针
    let stepCompletedNow = false
    if (stepJustCompleted) {
      const doneUpdate = await db.collection('orders').where({
        _id: order._id,
        [`stepDone.${idx}`]: _cmd.neq(true)
      }).update({
        data: {
          [`stepDone.${idx}`]: true,
          ...(claimActive ? { [`stepClaims.${idx}`]: _cmd.remove() } : {}),
          ...(order.activeClaim && Number(order.activeClaim.stepIndex) === idx ? { activeClaim: null } : {}),
          currentStepIndex: idx,
          updatedAt: db.serverDate()
        }
      })
      stepCompletedNow = doneUpdate.stats.updated > 0
    }

    // 认领流水归档为已完成：本工序全部认领归档，各认领人的「我的工单」同步移到已完成
    if (stepCompletedNow) {
      for (const c of claimList) {
        // 认领人 ≠ 提交人（管理员/流转工跨认领完成）时记录实际操作人
        const proxyDone = c.userId !== user._id
        await _archiveClaim(c, {
          status: 'completed',
          completedAt: formatTime(),
          ...(proxyDone ? {
            completedByName: user.name,
            completedByRole: isAdmin ? '管理员' : '流转工',
            completedById: user._id
          } : {})
        })
      }
      // 兜底：归档提交后新加入的本工序认领流水
      try {
        await db.collection('order_claims').where({ orderId, stepIndex: idx, status: 'active' }).update({
          data: { status: 'completed', completedAt: formatTime() }
        })
      } catch (e) { /* 非关键 */ }
    }

    // 审计日志（记录实际工序操作员，非提交人）
    try {
      await db.collection('audit_logs').add({
        data: {
          action: stepCompletedNow ? '完成工序' : '部分完成工序',
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
            accumulated: latestAcc,
            qtyTarget,
            stepIndex: idx,
            programmerId: effectiveProgrammer ? effectiveProgrammer._id : '',
            programmerName: effectiveProgrammer ? effectiveProgrammer.name : '',
            partnerRole: effectiveProgrammer ? partnerCfg.label : ''
          },
          createdAt: db.serverDate()
        }
      })
    } catch (e) { /* 非关键 */ }

    // 返回最新工单（前端刷新用）：从库里读回保证与实际状态一致
    let freshOrder = null
    try {
      const r = await db.collection('orders').doc(order._id).get()
      freshOrder = r.data || null
    } catch (e) { /* 读回失败退化为本地拼装 */ }

    let updatedOrder
    if (freshOrder) {
      const outSteps = buildSteps(freshOrder.stepKeys || oldStepKeys)
      const ptr = Number(freshOrder.currentStepIndex) || 0
      const ptrStep = outSteps[ptr]
      updatedOrder = {
        ...freshOrder,
        steps: outSteps,
        currentStepName: ptrStep ? ptrStep.name : '',
        currentStation: ptrStep ? ptrStep.station : '',
        progress: outSteps.length > 0
          ? Math.min(Math.round((outSteps.filter((s, i) => !!((freshOrder.stepDone || {})[i]) || (qtyTarget > 0 && (Number((freshOrder.stepQty || {})[i]) || 0) >= qtyTarget)).length / outSteps.length) * 100), 100)
          : 0,
        overdue: order.dueDate ? isOverdueAfter(freshOrder) : false
      }
    } else {
      updatedOrder = {
        ...order,
        steps,
        stepQty: { ...(order.stepQty || {}), [idx]: latestAcc },
        stepDone: { ...(order.stepDone || {}), ...(stepCompletedNow ? { [idx]: true } : {}) },
        currentStepIndex: idx,
        currentStepName: currentStep.name,
        currentStation: currentStep.station,
        history: newHistory
      }
    }

    return {
      success: true,
      partial: !stepCompletedNow,
      accumulated: latestAcc,
      qtyTarget,
      remaining: Math.max(qtyTarget - latestAcc, 0),
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
