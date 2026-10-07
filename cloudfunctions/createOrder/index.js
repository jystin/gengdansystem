/**
 * 创建工单云函数
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

/**
 * 原子获取当日工单序号（并发安全）
 *
 * 修复说明：
 * 旧实现用 `_key` 字段存储计数器，且无唯一索引，并发创建时可能产生多条
 * 相同 _key 的孤儿记录，导致序号错乱（靠 createOrder 唯一性保护兜底）。
 *
 * 新实现：
 * 1. 以 _id = datePrefix 为主键，云开发 _id 天然唯一：
 *    - 首次：add({ _id, seq: 1 }) 成功 → 序号 1
 *    - 并发：仅一个 add 成功，其余抛主键冲突 → 走原子 inc 读取最新值
 * 2. 兼容旧数据：旧记录以 `_key` 字段存储，仍可正常 inc 延续序号
 */
async function nextOrderSeq(datePrefix) {
  const col = db.collection('daily_counters')

  // 1) 兼容旧格式：_key 字段定位（历史数据，无 _id 主键记录）
  try {
    const legacy = await col.where({ _key: datePrefix }).get()
    if (legacy.data.length > 0) {
      await col.doc(legacy.data[0]._id).update({ data: { seq: db.command.inc(1) } })
      const fresh = await col.doc(legacy.data[0]._id).get()
      return (fresh.data && fresh.data.seq) ? fresh.data.seq : ((legacy.data[0].seq || 0) + 1)
    }
  } catch (e) { /* 集合不存在等情况，交由下方新格式处理 */ }

  // 2) 新格式：以 _id 为主键（天然唯一，原子）
  try {
    const docRes = await col.doc(datePrefix).get()
    await col.doc(datePrefix).update({ data: { seq: db.command.inc(1) } })
    const fresh = await col.doc(datePrefix).get()
    return (fresh.data && fresh.data.seq) ? fresh.data.seq : ((docRes.data.seq || 0) + 1)
  } catch (e) {
    // 文档不存在 → 尝试创建；并发时仅一个 add 成功，其余抛主键冲突走 inc
    try {
      await col.add({ data: { _id: datePrefix, seq: 1 } })
      return 1
    } catch (addErr) {
      // 主键冲突（并发已创建）或其它错误 → 原子 inc
      await col.doc(datePrefix).update({ data: { seq: db.command.inc(1) } })
      const fresh = await col.doc(datePrefix).get()
      return (fresh.data && fresh.data.seq) ? fresh.data.seq : 1
    }
  }
}

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

    // 字段白名单校验：stepKeys 必须全部存在于工序库
    const validKeys = new Set(PROCESS_LIBRARY.map(p => p.key))
    if (!Array.isArray(stepKeys) || stepKeys.some(k => !validKeys.has(k))) {
      return { success: false, error: '工序配置包含无效工序' }
    }

    // 字段白名单校验：drawingDetail 仅保留允许的字段，防止字段篡改
    const ALLOWED_DRAWING_FIELDS = ['blankingRoughness', 'productRoughness', 'length', 'blankingLength', 'topHoleThread', 'crossHole', 'squareHead']
    const safeDrawingDetail = {}
    if (drawingDetail && typeof drawingDetail === 'object') {
      for (const f of ALLOWED_DRAWING_FIELDS) {
        if (drawingDetail[f] !== undefined) safeDrawingDetail[f] = String(drawingDetail[f]).slice(0, 100)
      }
    }

    // 字符串长度限制
    const safeCustomerName = String(customerName).slice(0, 100)
    const safeType = String(type).slice(0, 50)
    const safeSize = String(size).slice(0, 100)
    const safeMaterial = String(material).slice(0, 50)

    // 生成工单号 GD + 年月日 + 序号（原子操作防止竞态）
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const datePrefix = `GD${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`

    // 【修复竞态】计数器改为以 _id = datePrefix 为主键（云开发 _id 天然唯一）：
    //   add 冲突（并发时仅一个成功）→ 其余走原子 inc 读取最新值，
    //   彻底消除原「先查后建」方案中并发 add 均成功、产生多条孤儿计数器记录的窗口。
    let seq = 1
    try {
      seq = await nextOrderSeq(datePrefix)
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
    let finalOrderId = ''
    while (safetyCounter < 50) {
      const orderId = datePrefix + String(seq).padStart(3, '0')
      const existingRes = await db.collection('orders').where({ id: orderId }).count().catch(() => ({ total: 0 }))
      if (existingRes.total === 0) {
        finalOrderId = orderId
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
      customerName: safeCustomerName,
      type: safeType,
      size: safeSize,
      qty: Number(qty),
      material: safeMaterial,
      dueDate,
      singleNo: singleNo || `S${datePrefix.slice(2)}${String(seq).padStart(3, '0')}`,
      status: 'processing',
      urgent: Boolean(urgent),
      isReorder: Boolean(isReorder),
      paused: false,
      currentStepIndex: 0,
      stepKeys: stepKeys,
      drawings: Array.isArray(drawings) ? drawings.slice(0, 20) : [],
      drawingDetail: safeDrawingDetail,
      history: [],
      remarks: remarks ? String(remarks).slice(0, 500) : '',
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

    // 生成微信小程序码（调用 wxacodeGenerator，失败不阻塞主流程，但向前端返回 qrWarning 提示）
    let qrCodeFileID = ''
    let qrWarning = ''
    try {
      const wxacodeRes = await cloud.callFunction({
        name: 'wxacodeGenerator',
        data: { orderId: finalOrderId, forceRegenerate: false }
      })
      const r = wxacodeRes.result || {}
      if (r.success && r.fileID) {
        qrCodeFileID = r.fileID
        await db.collection('orders').doc(result._id).update({
          data: {
            qrCodeFileID: qrCodeFileID,
            updatedAt: db.serverDate()
          }
        })
      } else {
        qrWarning = `小程序码生成失败（${r.error || '未知错误'}），已降级为文本二维码。请在云开发控制台为 wxacodeGenerator 配置 WX_APP_SECRET 环境变量后重试`
        console.warn('[createOrder] 小程序码生成失败:', (r.error || '无返回') + '，将降级为文本二维码')
      }
    } catch (qrErr) {
      qrWarning = `小程序码生成失败（${qrErr.message || qrErr}），已降级为文本二维码。请在云开发控制台为 wxacodeGenerator 配置 WX_APP_SECRET 环境变量后重试`
      console.warn('[createOrder] 小程序码生成失败（将降级为文本二维码）:', qrErr.message || qrErr)
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
      qrWarning: qrWarning || undefined,
      order: {
        ...orderData,
        _id: result._id,
        qrCodeFileID: qrCodeFileID || ''
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || '创建工单失败'
    }
  }
}
