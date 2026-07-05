/**
 * 员工管理云函数
 * 支持：获取员工列表、更新岗位、更新角色、邀请员工
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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

function requireSuperAdmin(user) {
  if (!user) throw new Error('用户不存在')
  if (user.role !== 'superadmin') throw new Error('仅超级管理员可执行此操作')
}

// 获取员工列表
async function listEmployees() {
  try {
    const [usersRes, pendingRes] = await Promise.all([
      db.collection('users').limit(100).get().catch(() => ({ data: [] })),
      db.collection('pending_applications').where({ status: 'pending' }).limit(50).get().catch(() => ({ data: [] }))
    ])

    const employees = usersRes.data.map(u => ({
      id: u._id,
      name: u.name,
      role: u.role,
      stations: u.stations || [],
      status: u.status,
      openid: u.openid || '',
      deviceId: u.deviceId || u.lastDeviceId || '',
      createdAt: u.createdAt
    }))

    const pending = pendingRes.data.map(p => ({
      id: p._id,
      name: p.name,
      role: 'worker',
      stations: p.stations || [],
      status: 'pending',
      openid: p.openid || '',
      deviceId: p.deviceId || '',
      inviteSource: p.inviteSource || 'scan',
      inviteNote: p.note || '',
      createdAt: p.createdAt
    }))

    // 按 openid / deviceId / name 去重：users 中的记录优先级更高，避免已审批员工和待审申请同时出现
    const userKeys = new Set()
    employees.forEach(e => {
      if (e.openid) userKeys.add(`openid:${e.openid}`)
      if (e.deviceId) userKeys.add(`deviceId:${e.deviceId}`)
      if (e.name) userKeys.add(`name:${e.name}`)
    })

    const filteredPending = pending.filter(p => {
      if (p.openid && userKeys.has(`openid:${p.openid}`)) return false
      if (p.deviceId && userKeys.has(`deviceId:${p.deviceId}`)) return false
      if (p.name && userKeys.has(`name:${p.name}`)) return false
      return true
    })

    return [...employees, ...filteredPending]
  } catch (err) {
    if (err.errCode === -502005) return []
    throw err
  }
}

// 更新员工岗位（支持已激活员工和待审批申请）
async function updateStations(employeeId, stations, user) {
  requireAdmin(user)

  const finalStations = Array.isArray(stations) ? stations : []
  const db = cloud.database()

  // 先尝试查找 users 集合
  let empRes
  try {
    empRes = await db.collection('users').doc(employeeId).get()
  } catch (e) {
    empRes = { data: null }
  }

  if (empRes.data) {
    // 是已激活员工
    if (empRes.data.role === 'superadmin') throw new Error('不能修改超级管理员')

    await db.collection('users').doc(employeeId).update({
      data: { stations: finalStations, updatedAt: db.serverDate() }
    })

    try {
      await db.collection('audit_logs').add({
        data: { action: '更新岗位', targetId: employeeId, targetName: empRes.data.name, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
      })
    } catch (e) { /* 非关键 */ }
  } else {
    // 尝试查找 pending_applications 集合
    let pendingRes
    try {
      pendingRes = await db.collection('pending_applications').doc(employeeId).get()
    } catch (e) {
      pendingRes = { data: null }
    }

    if (!pendingRes.data) {
      throw new Error('员工或申请记录不存在')
    }

    await db.collection('pending_applications').doc(employeeId).update({
      data: { stations: finalStations, updatedAt: db.serverDate() }
    })

    try {
      await db.collection('audit_logs').add({
        data: { action: '更新待审员工岗位', targetId: employeeId, targetName: pendingRes.data.name, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
      })
    } catch (e) { /* 非关键 */ }
  }

  return await listEmployees()
}

// 更新员工角色（仅超管）
async function updateRole(employeeId, role, user) {
  requireSuperAdmin(user)

  const empRes = await db.collection('users').doc(employeeId).get()
  if (!empRes.data) throw new Error('员工不存在')
  if (empRes.data.role === 'superadmin') throw new Error('不能修改超级管理员')

  const newRole = role === 'admin' ? 'admin' : 'worker'
  const newStations = [...(empRes.data.stations || [])]
  if (newRole === 'admin' && !newStations.includes('管理员中心')) {
    newStations.unshift('管理员中心')
  }

  await db.collection('users').doc(employeeId).update({
    data: { role: newRole, stations: newStations, updatedAt: db.serverDate() }
  })

  try {
    const actionText = newRole === 'admin' ? '设为管理员' : '取消管理员'
    await db.collection('audit_logs').add({
      data: { action: actionText, targetId: employeeId, targetName: empRes.data.name, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return await listEmployees()
}

// 管理员邀请员工
async function inviteEmployee(name, stations, role, note, user) {
  requireAdmin(user)

  if (!name || !name.trim()) throw new Error('请填写姓名')
  const finalStations = Array.isArray(stations) && stations.length > 0 ? stations : []
  if (finalStations.length === 0) throw new Error('请填写岗位')
  const finalRole = role === 'admin' && user.role !== 'superadmin' ? 'worker' : (role || 'worker')

  // 生成邀请码
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let inviteCode = 'INV-'
  for (let i = 0; i < 8; i++) {
    inviteCode += chars[Math.floor(Math.random() * chars.length)]
  }

  // 创建待审批申请
  const appResult = await db.collection('pending_applications').add({
    data: {
      name: name.trim(),
      stations: finalStations,
      role: finalRole,
      status: 'pending',
      inviteSource: 'admin',
      note: note || '',
      inviteCodeUsed: inviteCode,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  // 创建邀请码记录
  try {
    await db.collection('invite_codes').add({
      data: {
        code: inviteCode,
        createdBy: user._id,
        createdAt: db.serverDate(),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        maxUses: 1,
        usedCount: 1,
        isActive: true
      }
    })
  } catch (e) { /* 非关键 */ }

  try {
    await db.collection('audit_logs').add({
      data: { action: '邀请员工', targetId: appResult._id, targetName: `${name.trim()}`, operatorId: user._id, operatorName: user.name, createdAt: db.serverDate() }
    })
  } catch (e) { /* 非关键 */ }

  return { employee: { id: appResult._id, name: name.trim(), role: finalRole, stations: finalStations, status: 'pending' }, inviteCode }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    const { action } = event
    if (!action) return { success: false, error: '缺少 action 参数' }

    const user = await getUserByOpenid(openid)

    switch (action) {
      case 'list':
        // 仅活跃的内部员工可查看员工列表
        if (!user || user.status !== 'active') {
          return { success: false, error: '仅活跃的内部员工可查看员工列表' }
        }
        return { success: true, employees: await listEmployees() }

      case 'updateStations':
        if (!event.employeeId || !event.stations) return { success: false, error: '缺少参数' }
        return { success: true, employees: await updateStations(event.employeeId, event.stations, user) }

      case 'updateRole':
        if (!event.employeeId || !event.role) return { success: false, error: '缺少参数' }
        return { success: true, employees: await updateRole(event.employeeId, event.role, user) }

      case 'invite':
        return {
          success: true,
          result: await inviteEmployee(event.name, event.stations, event.role, event.note, user)
        }

      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  } catch (err) {
    return { success: false, error: err.message || '操作失败' }
  }
}
