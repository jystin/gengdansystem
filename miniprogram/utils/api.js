/**
 * 统一 API 服务层
 * 所有云函数调用都通过本文件，禁止页面直接 wx.cloud.callFunction
 *
 * 关键能力：
 *  - 5 秒缓存（GET 类操作）
 *  - 网络错误自动重试 1 次
 *  - 30 秒清理过期缓存
 *  - 统一错误抛出（业务错误抛 Error(result.error)）
 *  - 集中维护 PROCESS_LIBRARY、ROUGHNESS_COEFFICIENTS
 */

if (!wx.cloud) {
  throw new Error('请在 app.js onLaunch 中先调用 wx.cloud.init()')
}

const CACHE_TTL = 5000         // 5 秒
const CACHE_CLEANUP_INTERVAL = 30000  // 30 秒
const RETRY_DELAY = 500        // 重试延时
const RETRY_MAX = 1            // 重试次数

const cache = new Map()
const inflight = new Map()

/**
 * 调用云函数的统一入口
 * @param {string} name 云函数名
 * @param {object} data 业务参数（自动注入 token / deviceId）
 * @param {object} opts { cache: 是否启用缓存, noRetry: 是否禁用重试 }
 */
function callFunction(name, data, opts = {}) {
  const { cache: useCache = false, noRetry = false } = opts
  const app = getApp ? getApp() : null
  const token = app && app.globalData ? app.globalData.token : ''
  const deviceId = app && app.globalData ? app.globalData.deviceId : ''
  const payload = { ...data, token, deviceId }
  const cacheKey = useCache ? `${name}:${JSON.stringify(payload)}` : null

  // 1. 命中缓存
  if (useCache && cacheKey && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey)
    if (entry.expire > Date.now()) {
      return Promise.resolve(entry.value)
    }
    cache.delete(cacheKey)
  }

  // 2. 合并并发请求（仅缓存类请求做去重，其余不做以避免 key 包含 Date.now() 的无效内存占用）
  if (useCache && cacheKey && inflight.has(cacheKey)) {
    return inflight.get(cacheKey)
  }

  const promise = _invoke(name, payload, useCache, noRetry, cacheKey)
  if (useCache && cacheKey) {
    inflight.set(cacheKey, promise)
    promise.finally(() => inflight.delete(cacheKey))
  }
  return promise
}

function _invoke(name, payload, useCache, noRetry, cacheKey) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft) => {
      const handleSuccess = (res) => {
        const result = res && res.result
        if (!result) {
          reject(new Error(`${name} 云函数无返回`))
          return
        }
        if (result.success === false) {
          // 业务错误不重试
          reject(new Error(result.error || '操作失败'))
          return
        }
        if (useCache && cacheKey) {
          cache.set(cacheKey, { value: result, expire: Date.now() + CACHE_TTL })
          ensureCacheCleanup() // 【优化】懒启动定时清理
        }
        resolve(result)
      }
      const handleFail = (err) => {
        const isNet = !err || (err.errMsg && /fail/i.test(err.errMsg)) ||
          (err.errCode && err.errCode !== 'ERR_INVALID_ARGUMENT')
        if (!noRetry && isNet && retriesLeft > 0) {
          setTimeout(() => attempt(retriesLeft - 1), RETRY_DELAY)
        } else {
          reject(new Error((err && err.errMsg) || '网络异常，请稍后重试'))
        }
      }
      // 探测 SDK 形态：先尝试以 success/fail 回调方式调用
      //   - 老版 SDK：直接通过回调处理
      //   - 新版 SDK：内部 Promise 也会被 success 回调 resolve，但外部仍能拿到 Promise
      // 两种 SDK 共用同一段 success/fail 逻辑
      let promiseLike = null
      try {
        promiseLike = wx.cloud.callFunction({
          name,
          data: payload,
          success: handleSuccess,
          fail: handleFail
        })
      } catch (e) {
        // 极老 SDK 可能同步抛错
        handleFail(e)
        return
      }
      if (promiseLike && typeof promiseLike.then === 'function') {
        // 新版 SDK：监听 Promise 以防 success 回调未被触发
        // 重复 resolve 不会出错（Promise resolve 幂等）
        promiseLike.then(handleSuccess, handleFail)
      }
      // 老版 SDK：promiseLike 为 undefined，已通过 success/fail 回调处理
    }
    attempt(RETRY_MAX)
  })
}

// 【优化】懒初始化定时清理：仅在首次写入缓存时启动，缓存为空时停止定时器
let cleanupTimer = null
function ensureCacheCleanup() {
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      const now = Date.now()
      let anyRemaining = false
      for (const [k, v] of cache.entries()) {
        if (v.expire <= now) { cache.delete(k) }
        else { anyRemaining = true }
      }
      // 缓存为空时停止定时器以释放资源
      if (!anyRemaining) {
        clearInterval(cleanupTimer)
        cleanupTimer = null
      }
    }, CACHE_CLEANUP_INTERVAL)
  }
}
function clearCache() {
  cache.clear()
  // 同时清理并发去重映射
  inflight.clear()
}

// =====================================================================
// 常量：与后端 4 处同步（utils/api.js / orderManager / completeStep / init-db）
// =====================================================================

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

const MATERIAL_TYPES_FALLBACK = [
  '不锈钢420', '不锈钢304', '不锈钢316', '不锈钢431', '铜', '双相钢'
]

function getProcessLibrary() { return PROCESS_LIBRARY.slice() }
function getProcessByKey(key) { return PROCESS_LIBRARY.find(p => p.key === key) }
function getRoughnessCoefficient(r) {
  const k = String(r).trim()
  if (ROUGHNESS_COEFFICIENTS[k] !== undefined) return ROUGHNESS_COEFFICIENTS[k]
  const d = Number(k)
  if (!isNaN(d) && d > 0) return Math.round(d * d * 0.006165 * 1000) / 1000
  return null
}

// =====================================================================
// 鉴权 / 用户
// =====================================================================

async function login(deviceId) {
  const res = await callFunction('auth', { action: 'login', deviceId }, { noRetry: true })
  return res
}
async function verify(token) {
  return callFunction('auth', { action: 'verify', token }, { noRetry: true })
}
async function logout() {
  return callFunction('auth', { action: 'logout' })
}
async function submitJoinApplication(payload) {
  return callFunction('auth', { action: 'submitJoinApplication', ...payload })
}
async function generateJoinQRCode(force = false) {
  return callFunction('auth', { action: 'generateJoinQRCode', force })
}
async function getJoinQRCodeFileID(force = false) {
  const r = await generateJoinQRCode(force)
  return r && r.success ? r : null
}

// =====================================================================
// 仪表盘 / 工单
// =====================================================================

async function getDashboard() {
  const r = await callFunction('orderManager', { action: 'dashboard' }, { cache: true })
  return r.dashboard || {}
}
async function listOrders(page = 1, pageSize = 100) {
  const r = await callFunction('orderManager', { action: 'listOrders', page, pageSize }, { cache: true })
  return r.orders || []
}
async function getOrder(orderId) {
  if (!orderId) return null
  const r = await callFunction('orderManager', { action: 'getOrder', orderId }, { cache: true })
  return r.order || null
}
async function createOrder(payload) {
  clearCache()
  return callFunction('createOrder', payload)
}
async function completeCurrentStep(payload) {
  clearCache()
  return callFunction('completeStep', payload)
}
async function togglePause(orderId, paused) {
  clearCache()
  return callFunction('orderManager', { action: 'togglePause', orderId, paused })
}
async function toggleOrderUrgent(orderId, urgent) {
  clearCache()
  return callFunction('orderManager', { action: 'toggleUrgent', orderId, urgent })
}
async function revertCompletedStep(orderId, stepKey) {
  clearCache()
  return callFunction('orderManager', { action: 'revertStep', orderId, stepKey })
}
async function updateOrderStepKeys(orderId, stepKeys) {
  clearCache()
  return callFunction('orderManager', { action: 'updateStepKeys', orderId, stepKeys })
}
async function updateOrderDrawings(orderId, drawings) {
  clearCache()
  return callFunction('orderManager', { action: 'updateDrawings', orderId, drawings })
}
async function deleteOrder(orderId) {
  clearCache()
  return callFunction('orderManager', { action: 'deleteOrder', orderId })
}

// =====================================================================
// 员工
// =====================================================================

async function listEmployees() {
  const r = await callFunction('employeeManager', { action: 'list' }, { cache: true })
  return r.employees || []
}
async function updateEmployeeStations(employeeId, stations) {
  clearCache()
  return callFunction('employeeManager', { action: 'updateStations', employeeId, stations })
}
async function updateEmployeeRole(employeeId, role) {
  clearCache()
  return callFunction('employeeManager', { action: 'updateRole', employeeId, role })
}
async function inviteEmployee(payload) {
  clearCache()
  return callFunction('employeeManager', { action: 'invite', ...payload })
}
async function approveEmployee(applicationId) {
  clearCache()
  return callFunction('approveEmployee', { action: 'approve', applicationId })
}
async function rejectEmployee(applicationId) {
  clearCache()
  return callFunction('approveEmployee', { action: 'reject', applicationId })
}
async function deleteEmployee(employeeId) {
  clearCache()
  return callFunction('approveEmployee', { action: 'delete', employeeId })
}

// =====================================================================
// 库存
// =====================================================================

async function getMaterialTypes() {
  try {
    const r = await callFunction('inventoryManager', { action: 'getTypes' }, { cache: true })
    return r.types || MATERIAL_TYPES_FALLBACK
  } catch (e) {
    return MATERIAL_TYPES_FALLBACK
  }
}
async function getMaterialInventory() {
  const r = await callFunction('inventoryManager', { action: 'getInventory' }, { cache: true })
  return r.inventory || []
}
async function getMaterialStockByRoughness(material, roughness) {
  if (!material || roughness === '' || roughness == null) return 0
  const r = await callFunction('inventoryManager', { action: 'getStock', material, roughness }, { cache: true })
  return Number(r.stock || 0)
}
async function addMaterialStock(material, qty, note, roughness) {
  clearCache()
  return callFunction('inventoryManager', { action: 'addStock', material, qty, note, roughness })
}
async function deductMaterialStock(material, qty, note, orderId, roughness) {
  clearCache()
  return callFunction('inventoryManager', { action: 'deductStock', material, qty, note, orderId, roughness })
}
async function setMaterialStock(material, stock, note, roughness) {
  clearCache()
  return callFunction('inventoryManager', { action: 'setStock', material, stock, note, roughness })
}
async function addMaterialType(name) {
  clearCache()
  return callFunction('inventoryManager', { action: 'addType', name })
}
async function getMaterialLogs() {
  const r = await callFunction('inventoryManager', { action: 'getLogs' }, { cache: true })
  return r.logs || []
}

// =====================================================================
// 产量 / 日志
// =====================================================================

async function getEmployeeMonthlyProduction(employeeId, year) {
  const r = await callFunction('orderManager', { action: 'employeeMonthlyProduction', employeeId, year: year || String(new Date().getFullYear()) })
  return r.data || null
}
async function getAllEmployeesMonthlyProduction(year) {
  const r = await callFunction('orderManager', { action: 'allEmployeesMonthlyProduction', year: year || String(new Date().getFullYear()) }, { cache: true })
  return r.stats || []
}
async function getProductionRows() {
  const r = await callFunction('orderManager', { action: 'productionRows' }, { cache: true })
  return r.rows || []
}
async function listLogs(days) {
  const r = await callFunction('orderManager', { action: 'listLogs', days: days || 2 }, { cache: true })
  return r.logs || []
}
async function cleanupOldLogs() {
  return callFunction('orderManager', { action: 'cleanupLogs' })
}

// =====================================================================
// 备份
// =====================================================================

async function createBackup() { return callFunction('backupManager', { action: 'backup' }) }
async function listBackups() { return callFunction('backupManager', { action: 'list' }) }
async function restoreBackup(backupId, confirm = true) {
  return callFunction('backupManager', { action: 'restore', backupId, confirm })
}
async function deleteBackup(backupId) { return callFunction('backupManager', { action: 'delete', backupId }) }

// =====================================================================
// 系统镜像点（snapshotManager）
// =====================================================================

async function createSnapshot() {
  return callFunction('snapshotManager', { action: 'create' })
}
async function listSnapshots() {
  return callFunction('snapshotManager', { action: 'list' })
}
async function restoreSnapshot(snapshotId, confirm = true) {
  return callFunction('snapshotManager', { action: 'restore', snapshotId, confirm })
}
async function deleteSnapshot(snapshotId) {
  return callFunction('snapshotManager', { action: 'delete', snapshotId })
}

// =====================================================================
// 工具
// =====================================================================

function getCurrentUserId() {
  const app = getApp()
  return app && app.globalData && app.globalData.currentUser ? app.globalData.currentUser.id : ''
}
function isCurrentUserAdmin() {
  const app = getApp()
  const u = app && app.globalData && app.globalData.currentUser
  return !!(u && (u.role === 'admin' || u.role === 'superadmin'))
}
function isCurrentUserActive() {
  const app = getApp()
  return !!(app && app.globalData && app.globalData.accessState === 'active')
}
function getOrderStatusLabel(o) {
  if (o.status === 'completed') return '已完工'
  if (o.paused) return '已暂停'
  if (o.overdue) return '已逾期'
  if (o.urgent) return '加急'
  return '生产中'
}
function isOverdue(o) {
  if (!o || o.status === 'completed') return false
  if (!o.dueDate) return false
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return o.dueDate < today
}

// 渲染员工岗位显示文本
function getEmployeeDisplayStations(emp) {
  if (!emp) return ''
  const list = Array.isArray(emp.stations) ? emp.stations : (emp.station ? [emp.station] : [])
  // 【UI】隐藏“管理员中心”虚拟岗位，避免与真实工种信息混淆
  return list.filter(s => s !== '管理员中心').join(' / ')
}

// 月度表头（用于产量统计导出）
// 【优化】按年份缓存，同名年份反复调用不重复构建
const _monthHeadersCache = Object.create(null)
function buildMonthHeaders(year) {
  const y = year || String(new Date().getFullYear())
  if (_monthHeadersCache[y]) return _monthHeadersCache[y]
  const h = Array.from({ length: 12 }, (_, i) => ({
    key: `${y}-${String(i + 1).padStart(2, '0')}`,
    label: `${i + 1}月`
  }))
  _monthHeadersCache[y] = h
  return h
}

/**
 * 角色 → 中文
 * 兜底处理：英文 / 缺省值都映射为中文
 */
function roleLabel(role) {
  if (role === 'superadmin' || /^super.*admin/i.test(role)) return '超管'
  if (role === 'admin') return '管理员'
  if (role === 'worker') return '员工'
  if (role === 'pending') return '待审'
  return '访客'
}

/**
 * 状态 → 中文
 */
function statusLabel(s) {
  if (s === 'active' || /active|enabled/i.test(s)) return '已激活'
  if (s === 'pending' || /pending/i.test(s)) return '待审批'
  if (s === 'disabled' || /disabled/i.test(s)) return '已禁用'
  return s || ''
}

/**
 * 用户名 → 中文清理
 * 处理：英文/系统默认名 → 兜底中文显示
 * 注意：仅做"明显是英文"的兜底，不改真实中文名字
 *
 * @param {string} name 原始姓名（可能为英文）
 * @param {string} fallback 首选兜底值（当可从上下文推断时传入）
 * @returns {string} 清洁后始终为中文的名字
 */
function cleanName(name, fallback) {
  if (!name) return fallback || '用户'
  const n = String(name).trim()
  if (!n) return fallback || '用户'
  // 已含中文 → 直接返回
  if (/[\u4e00-\u9fa5]/.test(n)) return n
  // 明显是英文/系统默认名 → 优先用 fallback，否则返回中文「用户」
  if (/^(administrator|admin|root|system|user|test)$/i.test(n) ||
      /^[A-Za-z\s]+$/.test(n)) {
    return fallback || '用户'
  }
  return n
}

/**
 * 格式化时间为 YYYY-MM-DD HH:mm
 * 输入：Date 对象 / 字符串 / 时间戳
 */
function formatLogTime(t) {
  if (!t) return ''
  const d = t instanceof Date ? t : new Date(t)
  if (isNaN(d.getTime())) return String(t)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 标准化 audit_logs 记录为前端可展示格式
 *   - at: 格式化时间字符串
 *   - action: 行为（已是中文）
 *   - target: 合并 targetId / targetName
 *   - operator: 操作人姓名（智能取当前用户名字作为兜底）
 *   - note: 备注
 */
function normalizeLog(raw) {
  if (!raw) return null
  // 尝试从全局上下文获取当前用户名字作为英文名兜底
  let contextName = ''
  try {
    const app = getApp()
    const u = app && app.globalData && app.globalData.currentUser
    if (u && u.name && /[\u4e00-\u9fa5]/.test(u.name)) {
      contextName = u.name
    }
  } catch (_) { /* 忽略 */ }
  return {
    id: raw._id,
    action: raw.action || '',
    target: raw.targetName || raw.targetId || '',
    targetId: raw.targetId || '',
    operator: cleanName(raw.operatorName || raw.operator, contextName),
    note: raw.note || '',
    at: formatLogTime(raw.createdAt)
  }
}

module.exports = {
  // 内部
  callFunction,
  clearCache,
  // 常量
  PROCESS_LIBRARY,
  ROUGHNESS_COEFFICIENTS,
  MATERIAL_TYPES_FALLBACK,
  getProcessLibrary,
  getProcessByKey,
  getRoughnessCoefficient,
  buildMonthHeaders,
  getEmployeeDisplayStations,
  // 鉴权
  login,
  verify,
  logout,
  submitJoinApplication,
  generateJoinQRCode,
  getJoinQRCodeFileID,
  // 工单
  getDashboard,
  listOrders,
  getOrder,
  createOrder,
  completeCurrentStep,
  togglePause,
  toggleOrderUrgent,
  revertCompletedStep,
  updateOrderStepKeys,
  updateOrderDrawings,
  deleteOrder,
  // 员工
  listEmployees,
  updateEmployeeStations,
  updateEmployeeRole,
  inviteEmployee,
  approveEmployee,
  rejectEmployee,
  deleteEmployee,
  // 库存
  getMaterialTypes,
  getMaterialInventory,
  getMaterialStockByRoughness,
  addMaterialStock,
  deductMaterialStock,
  setMaterialStock,
  addMaterialType,
  getMaterialLogs,
  // 产量
  getEmployeeMonthlyProduction,
  getAllEmployeesMonthlyProduction,
  getProductionRows,
  // 日志
  listLogs,
  cleanupOldLogs,
  // 备份
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  // 系统镜像点
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  // 工具
  getCurrentUserId,
  isCurrentUserAdmin,
  isCurrentUserActive,
  getOrderStatusLabel,
  isOverdue,
  roleLabel,
  statusLabel,
  formatLogTime,
  normalizeLog,
  cleanName
}
