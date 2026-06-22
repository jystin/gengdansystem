/**
 * 创建工单云函数
 * 支持管理员创建新工单，写入云数据库并生成工单号
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 工序库（与 init-db 和 mock-store 保持一致）
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

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { customerName, type, size, qty, material, dueDate, 
            singleNo, urgent, isReorder, drawings, stepKeys, 
            drawingDetail, remarks } = event

    // 权限校验：必须是管理员
    const userRes = await db.collection('users').where({ openid }).get()
    if (userRes.data.length === 0) {
      return { success: false, error: '用户不存在' }
    }
    const user = userRes.data[0]
    if (user.status !== 'active') {
      return { success: false, error: '账号未激活' }
    }
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      return { success: false, error: '仅管理员可创建工单' }
    }

    // 参数校验
    if (!customerName) return { success: false, error: '缺少客户名称' }
    if (!type) return { success: false, error: '缺少种类' }
    if (!size) return { success: false, error: '缺少尺寸' }
    if (qty === null || qty === undefined || qty === '' || Number(qty) <= 0) return { success: false, error: '缺少数量或数量需大于0' }
    if (!material) return { success: false, error: '缺少材质' }
    if (!dueDate) return { success: false, error: '缺少交货期' }
    if (!stepKeys || stepKeys.length === 0) return { success: false, error: '缺少工序配置' }
    if (singleNo && String(singleNo).trim().length > 50) return { success: false, error: '单号过长' }

    // 生成工单号 GD + 年月日 + 序号（原子操作防止竞态）
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const datePrefix = `GD${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    
    // 使用计数器集合 + inc 原子操作避免竞态
    let seq = 1
    try {
      // 关键：使用 _ 字段的 inc 是原子的，但拿到最新值需要 inc 后再 get
      // 这里的策略：先 inc 一次（无论是否新建），再读取最新值
      const counterRes = await db.collection('daily_counters').where({ _key: datePrefix }).get()
      if (counterRes.data.length > 0) {
        // 已有计数器，原子递增
        await db.collection('daily_counters').doc(counterRes.data[0]._id).update({
          data: { seq: db.command.inc(1) }
        })
        // 重新读取最新值，避免并发导致的重复
        const freshRes = await db.collection('daily_counters').doc(counterRes.data[0]._id).get()
        seq = (freshRes.data && freshRes.data.seq) ? freshRes.data.seq : (counterRes.data[0].seq + 1)
      } else {
        // 首次创建计数器（可能多个并发同时进入此分支）
        try {
          await db.collection('daily_counters').add({ data: { _key: datePrefix, seq: 1 } })
          seq = 1
        } catch (addErr) {
          // 并发竞争：其他请求已创建，此时直接走 inc 分支
          const retryRes = await db.collection('daily_counters').where({ _key: datePrefix }).get()
          if (retryRes.data.length > 0) {
            await db.collection('daily_counters').doc(retryRes.data[0]._id).update({
              data: { seq: db.command.inc(1) }
            })
            const freshRes2 = await db.collection('daily_counters').doc(retryRes.data[0]._id).get()
            seq = (freshRes2.data && freshRes2.data.seq) ? freshRes2.data.seq : 1
          }
        }
      }
    } catch (e) {
      // 计数器集合不存在时，回退到 count 方式（仅首次部署时触发）
      try {
        const countRes = await db.collection('orders')
          .where({ id: db.RegExp({ regexp: `^${datePrefix}`, options: 'i' }) })
          .count()
        seq = countRes.total + 1
      } catch (e2) { /* seq 保持 1 */ }
    }
    
    // 唯一性保护：若已存在同 id 订单，递增 seq 直到唯一
    let safetyCounter = 0
    while (safetyCounter < 50) {
      const orderId = datePrefix + String(seq).padStart(3, '0')
      const existingRes = await db.collection('orders').where({ id: orderId }).count().catch(() => ({ total: 0 }))
      if (existingRes.total === 0) {
        var finalOrderId = orderId
        break
      }
      seq++
      safetyCounter++
    }
    if (!finalOrderId) finalOrderId = datePrefix + String(seq).padStart(3, '0')

    // 构建工序列表
    const steps = stepKeys
      .map(key => PROCESS_LIBRARY.find(p => p.key === key))
      .filter(Boolean)

    // 构建工单数据
    const orderData = {
      id: finalOrderId,
      qrContent: finalOrderId,
      customerName,
      type,
      size,
      qty: Number(qty),
      material,
      dueDate,
      singleNo: singleNo || `S${datePrefix.slice(2)}${String(seq).padStart(3, '0')}`,
      status: 'processing',
      urgent: Boolean(urgent),
      isReorder: Boolean(isReorder),
      paused: false,
      currentStepIndex: 0,
      stepKeys: stepKeys,
      drawings: drawings || [],
      drawingDetail: drawingDetail || {},
      history: [],
      remarks: remarks || '',
      orderDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      completedDate: null,
      createdBy: user._id,
      createdByName: user.name,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }

    let result
    try {
      result = await db.collection('orders').add({ data: orderData })
    } catch (err) {
      if (err.errCode === -502005 || String(err.errMsg || '').includes('not exist')) {
        return {
          success: false,
          error: '数据库集合 orders 不存在',
          action: '请在云开发控制台创建 orders 集合后重试'
        }
      }
      throw err
    }

    // 审计日志
    try {
      await db.collection('audit_logs').add({
        data: {
          action: '创建工单',
          targetId: finalOrderId,
          targetName: customerName,
          operatorId: user._id,
          operatorName: user.name,
          createdAt: db.serverDate()
        }
      })
    } catch (e) {
      // 审计日志写入失败不影响主流程
    }

    return {
      success: true,
      order: {
        ...orderData,
        _id: result._id
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || '创建工单失败'
    }
  }
}
