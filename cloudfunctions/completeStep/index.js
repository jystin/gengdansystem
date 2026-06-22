/**
 * 完成工序云函数
 * 将工单当前工序标记为完成，流转到下一工序
 * 支持下料工序的材料库存扣减
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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

function formatTime() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { orderId, operatorId, note, completedQty, materialConsumption } = event

    if (!orderId) return { success: false, error: '缺少工单ID' }
    if (!operatorId) return { success: false, error: '缺少操作员ID' }

    // 权限校验
    const userRes = await db.collection('users').where({ openid }).get()
    if (userRes.data.length === 0) return { success: false, error: '用户不存在' }
    const user = userRes.data[0]
    if (user.status !== 'active') return { success: false, error: '账号未激活' }

    // operatorId 身份校验：非管理员必须本人操作，管理员可代他人操作
    let effectiveOperator = user // 最终生效的操作员
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      if (user._id !== operatorId) {
        return { success: false, error: '只能操作自己的工序' }
      }
    } else {
      // 管理员代操作时，验证 operatorId 对应的用户是否存在且活跃，并使用其身份记录历史
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

    const steps = (order.stepKeys || []).map(k => PROCESS_LIBRARY.find(p => p.key === k)).filter(Boolean)
    const currentStep = steps[order.currentStepIndex]
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
          updatedAt: db.serverDate()
        }
      })
      if (lockUpdate.stats.updated === 0) {
        return { success: false, error: '该工单已被处理，请刷新后重试' }
      }
      // 记录审计日志
      try {
        await db.collection('audit_logs').add({
          data: {
            action: '完成工序',
            targetId: orderId,
            operator: effectiveOperator.name,
            operatorId: effectiveOperator._id,
            operatorName: effectiveOperator.name,
            note: '工单完工确认（自动补全）',
            detail: { note },
            createdAt: db.serverDate()
          }
        })
      } catch (e) { /* 非关键 */ }
      // 构建 steps 数组供前端使用（自动完工情况）
      const finalSteps = (order.stepKeys || []).map(k => PROCESS_LIBRARY.find(p => p.key === k)).filter(Boolean)
      return { success: true, order: { ...order, steps: finalSteps, currentStepName: '已完成', currentStation: '入库完成', status: 'completed', completedDate: formatTime(), history: finalHistory } }
    }

    // 权限检查：非管理员需检查岗位
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      const userStations = user.stations || []
      if (!userStations.includes(currentStep.station)) {
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
          if (invRes.data.length > 0) {
            const inv = invRes.data[0]
            const stock = inv.stock || {}
            const rKey = String(roughness)
            const currentStock = Number(stock[rKey]) || 0
            if (currentStock < dedQty) {
              return { success: false, error: `${material} φ${rKey} 库存不足，当前剩余 ${currentStock.toFixed(4)} 吨` }
            }
            inventoryDeduction = { invId: inv._id, oldStock: { ...stock }, material, roughness: rKey, dedQty }
          }
        } catch (err) {
          if (err.errCode !== -502005 && !String(err.errMsg || '').includes('not exist')) {
            return { success: false, error: '库存查询异常，请检查库存数据后重试: ' + (err.message || '未知错误') }
          }
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
      operatorId: effectiveOperator._id,
      operator: effectiveOperator.name,
      role: currentStep.station,
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
    const newStepIndex = order.currentStepIndex + 1
    const isCompleted = newStepIndex >= steps.length

    // 乐观锁并发保护：仅当 currentStepIndex 未变化时才更新，防止重复完成
    const updateResult = await db.collection('orders').where({
      _id: order._id,
      currentStepIndex: order.currentStepIndex
    }).update({
      data: {
        currentStepIndex: newStepIndex,
        status: isCompleted ? 'completed' : 'processing',
        completedDate: isCompleted ? formatTime() : null,
        history: newHistory,
        updatedAt: db.serverDate()
      }
    })
    if (updateResult.stats.updated === 0) {
      return { success: false, error: '该工序已被处理，请刷新后重试' }
    }

    // 乐观锁成功 → 执行实际库存扣减（使用原子操作防止并发问题）
    if (inventoryDeduction) {
      const { invId, material, roughness, dedQty } = inventoryDeduction
      try {
        // 使用原子inc操作扣减库存
        const stockPath = `stock.${roughness}`
        await db.collection('inventory').doc(invId).update({
          data: {
            [stockPath]: db.command.inc(-dedQty),
            lastUpdatedAt: db.serverDate()
          }
        })
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
        // 工序已推进，库存扣减失败需要人工干预，但不应回滚工序（记录审计日志供追踪）
        db.collection('audit_logs').add({
          data: {
            action: '库存扣减失败',
            targetId: orderId,
            targetName: `${material} φ${roughness}`,
            operator: effectiveOperator.name,
            operatorName: effectiveOperator.name,
            note: `库存扣减失败: ${err.message}, 应扣除 ${dedQty} 吨`,
            createdAt: db.serverDate()
          }
        }).catch(() => {})
      }
    }

    // 审计日志
    try {
      await db.collection('audit_logs').add({
        data: {
          action: '完成工序',
          targetId: orderId,
          targetName: currentStep.name,
          operatorId: user._id,
          operatorName: user.name,
          createdAt: db.serverDate()
        }
      })
    } catch (e) { /* 非关键 */ }

    // 构建 steps 数组供前端使用
    const updatedSteps = (order.stepKeys || []).map(k => PROCESS_LIBRARY.find(p => p.key === k)).filter(Boolean)
    const nextCurrentStep = updatedSteps[newStepIndex]
    const updatedOrder = {
      ...order,
      steps: updatedSteps,
      currentStepIndex: newStepIndex,
      currentStepName: nextCurrentStep ? nextCurrentStep.name : (isCompleted ? '已完成' : '无工序'),
      currentStation: nextCurrentStep ? nextCurrentStep.station : (isCompleted ? '入库完成' : ''),
      status: isCompleted ? 'completed' : 'processing',
      completedDate: isCompleted ? formatTime() : null,
      history: newHistory,
      // 补充前端展示需要的派生字段（保持与 orderManager.enrichOrder 一致）
      progress: updatedSteps.length > 0 ? Math.min(Math.round((newStepIndex / updatedSteps.length) * 100), 100) : 0,
      overdue: order.dueDate ? isOverdueAfter({ ...order, status: isCompleted ? 'completed' : 'processing' }) : false
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

// 工具：完成工序后重新计算 overdue
function isOverdueAfter(order) {
  if (order.status === 'completed') return false
  const today = new Date()
  const pad = n => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  return order.dueDate < todayStr
}
