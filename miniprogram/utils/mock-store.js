// 全局工序库
const processLibrary = [
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

// 获取工序库
function getProcessLibrary() {
  return clone(processLibrary)
}

// 根据Key获取工序信息
function getProcessByKey(key) {
  return processLibrary.find((p) => p.key === key)
}

// 根据工序Key列表获取工序对象
function getStepsByKeys(stepKeys) {
  if (!stepKeys || stepKeys.length === 0) {
    // 默认返回全部工序
    return clone(processLibrary)
  }
  return stepKeys.map((key) => getProcessByKey(key)).filter(Boolean)
}

const SYSTEM_JOIN_INVITE_CODE = 'JOIN-20260516'

function isValidJoinInviteCode(inviteCode) {
  return String(inviteCode || '').trim() === SYSTEM_JOIN_INVITE_CODE
}

// 粗度系数表（单位：kg/m），用于下料工序计算材料消耗
// 公式：单根重量(kg) = 长度(mm) * 1.05 * 粗度系数(kg/m) * 0.001
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

// 根据粗度(mm)获取粗度系数(kg/m)
// 优先查表，查不到则按国标圆钢公式 d² × 0.006165 自动计算
function getRoughnessCoefficient(roughness) {
  const rKey = String(roughness).trim()
  if (ROUGHNESS_COEFFICIENTS[rKey] !== undefined) return ROUGHNESS_COEFFICIENTS[rKey]
  // fallback: 国标圆钢理论重量公式
  const d = Number(rKey)
  if (!isNaN(d) && d > 0) return Math.round(d * d * 0.006165 * 1000) / 1000
  return null
}

// 材料类型列表（可动态扩展）
let MATERIAL_TYPES = [
  '不锈钢420',
  '不锈钢304',
  '不锈钢316',
  '不锈钢431',
  '铜',
  '双相钢'
]

// 各材料库存预警阈值（按粗度维度判断，单位：吨）
// 含义：某材料的某个粗度库存低于此值时标记为「不足」
const MATERIAL_LOW_THRESHOLDS = {
  '不锈钢420': 10,
  '不锈钢304': 3,
  '不锈钢316': 3,
  '不锈钢431': 5
}
// 未列出的材料默认阈值为 0（只要有库存就正常）

const state = {
  employees: [
    { id: 'u-root', name: '我', role: 'superadmin', stations: ['超级管理员'], status: 'active' },
    { id: 'u-admin', name: '张主管', role: 'admin', stations: ['管理员中心'], status: 'active' },
    { id: 'u-blanking-1', name: '李师傅', role: 'worker', stations: ['下料工'], status: 'active' },
    { id: 'u-turning-1', name: '王师傅', role: 'worker', stations: ['粗车工'], status: 'active' },
    { id: 'u-quality-1', name: '赵师傅', role: 'worker', stations: ['质检员'], status: 'pending', inviteSource: 'admin' },
    { id: 'u-plating-1', name: '陈师傅', role: 'worker', stations: ['电镀工'], status: 'pending', inviteSource: 'scan' }
  ],
  orders: [
    {
      id: 'GD20260516001',
      qrContent: 'GD20260516001',
      customerName: '海龙阀门',
      type: 'VT-80A',
      size: 'φ20×L120',
      dueDate: '2026-05-20',
      orderDate: '2026-05-13',
      material: '304不锈钢',
      qty: 1200,
      singleNo: 'S20260516001',
      status: 'processing',
      urgent: true,
      isReorder: false,
      paused: false,
      currentStepIndex: 1,
      stepKeys: ['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse'],
      drawings: [
        { name: 'VT-80A-工艺图.pdf', type: 'pdf' },
        { name: 'VT-80A-结构图.jpg', type: 'image' }
      ],
      history: [
        { stepKey: 'blanking', stepName: '下料', operatorId: 'u-blanking-1', operator: '李师傅', role: '下料工', completedAt: '2026-05-13 08:20', note: '首件确认通过' }
      ]
    },
    {
      id: 'GD20260516002',
      qrContent: 'GD20260516002',
      customerName: '长江泵阀',
      type: 'VT-60B',
      size: 'φ16×L100',
      dueDate: '2026-05-18',
      material: '316L不锈钢',
      qty: 860,
      singleNo: 'S20260516002',
      status: 'paused',
      urgent: false,
      isReorder: false,
      paused: true,
      currentStepIndex: 2,
      stepKeys: ['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse'],
      drawings: [
        { name: 'VT-60B-工艺图.pdf', type: 'pdf' }
      ],
      history: [
        { stepKey: 'blanking', stepName: '下料', operatorId: 'u-blanking-1', operator: '李师傅', role: '下料工', completedAt: '2026-05-11 09:10', note: '' },
        { stepKey: 'rough_turning', stepName: '粗车', operatorId: 'u-turning-1', operator: '王师傅', role: '粗车工', completedAt: '2026-05-11 14:30', note: '等待热处理排产' }
      ]
    },
    {
      id: 'GD20260515001',
      qrContent: 'GD20260515001',
      customerName: '恒远流体',
      type: 'VT-50C',
      size: 'φ12×L80',
      dueDate: '2026-05-14',
      orderDate: '2026-05-10',
      material: '45#钢',
      qty: 500,
      singleNo: 'S20260515001',
      status: 'completed',
      urgent: false,
      isReorder: false,
      paused: false,
      currentStepIndex: 5,
      stepKeys: ['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse'],
      completedDate: '2026-05-12 10:00',
      drawings: [
        { name: 'VT-50C-工艺图.pdf', type: 'pdf' }
      ],
      history: getStepsByKeys(['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse']).map((step, index) => ({
        stepKey: step.key,
        stepName: step.name,
        operatorId: index === 0 ? 'u-blanking-1' : null,
        operator: index === 0 ? '李师傅' : '系统流转',
        role: step.station,
        completedAt: `2026-05-${10 + Math.floor(index / 2)} 0${(index % 3) + 8}:00`,
        note: ''
      }))
    }
  ],
  logs: [
    { id: 1, action: '创建订单', target: 'GD20260516001', operator: '张主管', at: '2026-05-12 16:10' },
    { id: 2, action: '完成工序', target: 'GD20260516001 / 下料', operator: '李师傅', at: '2026-05-13 08:20' },
    { id: 3, action: '暂停工单', target: 'GD20260516002', operator: '张主管', at: '2026-05-11 15:50' }
  ],
  // 材料库存（单位：吨），按材料名→粗度(mm)→数量 分层存储
  // 例: { '不锈钢304': { '80': 2.0, '100': 1.5 }, '铜': {} }
  materials: {
    '不锈钢420': { '80': 1000.0 },
    '不锈钢304': { '80': 2.0 },
    '不锈钢316': { '100': 1.5 },
    '不锈钢431': {},
    '铜': {},
    '双相钢': {}
  },
  // 材料流水日志（含粗度）
  materialLogs: [
    { id: 0, type: 'in', material: '不锈钢420', roughness: '80', qty: 1000.0, operator: '张主管', operatorId: 'u-admin', at: '2026-05-10 08:00', note: '初始库存入库' },
    { id: 1, type: 'in', material: '不锈钢304', roughness: '80', qty: 2.0, operator: '张主管', operatorId: 'u-admin', at: '2026-05-10 09:00', note: '首批采购入库' },
    { id: 2, type: 'out', material: '不锈钢304', roughness: '80', qty: 1.2, operator: '李师傅', operatorId: 'u-blanking-1', at: '2026-05-13 08:20', note: '工单 GD20260516001 下料', orderId: 'GD20260516001' },
    { id: 3, type: 'in', material: '不锈钢316', roughness: '100', qty: 1.5, operator: '张主管', operatorId: 'u-admin', at: '2026-05-11 14:00', note: '二批采购入库' },
    { id: 4, type: 'out', material: '不锈钢316', roughness: '100', qty: 0.86, operator: '李师傅', operatorId: 'u-blanking-1', at: '2026-05-11 09:10', note: '工单 GD20260516002 下料', orderId: 'GD20260516002' }
  ]
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeStationList(stations, station) {
  if (Array.isArray(stations) && stations.length > 0) {
    return stations.filter(Boolean)
  }
  if (typeof station === 'string' && station.trim()) {
    return [station.trim()]
  }
  return []
}

function findEmployee(employeeId) {
  return state.employees.find((employee) => employee.id === employeeId) || null
}

function isSuperAdmin(employee) {
  return Boolean(employee) && employee.role === 'superadmin'
}

function isAdmin(employee) {
  return Boolean(employee) && (employee.role === 'admin' || employee.role === 'superadmin')
}

function canManageWorker(actor, target) {
  if (isSuperAdmin(actor)) {
    return target.id !== actor.id
  }

  if (actor?.role === 'admin') {
    return target.role === 'worker'
  }

  return false
}

function pushLog(action, target, operator) {
  state.logs.unshift({
    id: state.logs.length + 1,
    action,
    target,
    operator,
    at: formatTime()
  })
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

function isOverdue(order) {
  if (order.status === 'completed') return false
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate())
  return order.dueDate < todayStr
}

function getProgress(order, steps) {
  if (!steps || steps.length === 0) return 0
  const progress = Math.round((order.currentStepIndex / steps.length) * 100)
  return Math.min(progress, 100)
}

function getDashboard() {
  const total = state.orders.length
  // 与 getOrderStatusLabel 保持一致的优先级归类，每个订单只归入一个类别
  let completed = 0, paused = 0, overdue = 0, urgent = 0, processing = 0
  for (const order of state.orders) {
    if (order.status === 'completed') { completed++ }
    else if (order.paused) { paused++ }
    else if (isOverdue(order)) { overdue++ }
    else if (order.urgent) { urgent++ }
    else { processing++ }
  }

  return {
    total,
    completed,
    paused,
    urgent,
    overdue,
    processing,
    pendingEmployees: state.employees.filter((employee) => employee.status === 'pending').length
  }
}

function getMonthKey(dateText) {
  const monthMatch = String(dateText || '').match(/^(\d{4}-\d{2})/)
  return monthMatch ? monthMatch[1] : ''
}

function getMonthLabel(monthKey) {
  const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/)
  if (!match) {
    return monthKey
  }

  return Number(match[2]) + '月'
}

function getYearMonths(year) {
  return Array.from({ length: 12 }, (_, index) => {
    const monthNumber = String(index + 1).padStart(2, '0')
    return {
      key: year + '-' + monthNumber,
      label: (index + 1) + '月'
    }
  })
}

function buildMonthHeaders(year) {
  return Array.from({ length: 12 }, (_, index) => ({
    key: year + '-' + String(index + 1).padStart(2, '0'),
    label: (index + 1) + '月'
  }))
}

function getProductionRows() {
  const rows = []

  state.orders.forEach((order) => {
    order.history.forEach((record) => {
      if (!record.operator || record.operator === '系统流转') {
        return
      }

      rows.push({
        orderId: order.id,
        customerName: order.customerName || '',
        orderQty: Number(order.qty) || 0,
        employeeId: record.operatorId || (findEmployeeByName(record.operator)?.id || ''),
        employeeName: record.operator,
        monthKey: getMonthKey(record.completedAt),
        completedAt: record.completedAt,
        stepName: record.stepName,
        station: record.role
      })
    })
  })

  return rows
}

function findEmployeeByName(employeeName) {
  return state.employees.find((employee) => employee.name === employeeName) || null
}

function getEmployeeMonthlyProduction(employeeId, year = '2026') {
  const employee = findEmployee(employeeId)
  if (!employee) {
    return null
  }

  const months = getYearMonths(year)
  const rows = getProductionRows().filter((row) => row.monthKey.startsWith(year + '-'))
  const monthlyMap = Object.fromEntries(months.map((month) => [month.key, 0]))

  rows.forEach((row) => {
    const matched = row.employeeId ? row.employeeId === employeeId : row.employeeName === employee.name
    if (!matched) {
      return
    }

    if (monthlyMap[row.monthKey] !== undefined) {
      monthlyMap[row.monthKey] += row.orderQty
    }
  })

  const monthlyRoots = months.map((month) => ({
    id: employee.id,
    ...month,
    roots: monthlyMap[month.key] || 0
  }))

  return {
    employee: clone(employee),
    year,
    totalRoots: monthlyRoots.reduce((sum, month) => sum + month.roots, 0),
    monthlyRoots,
    currentMonthRoots: monthlyRoots[new Date().getMonth()]?.roots || 0
  }
}

function getAllEmployeesMonthlyProduction(year = '2026') {
  return state.employees
    .filter((employee) => employee.role !== 'superadmin')
    .map((employee) => getEmployeeMonthlyProduction(employee.id, year))
    .filter(Boolean)
}

function getSystemJoinInviteCode() {
  return SYSTEM_JOIN_INVITE_CODE
}

function getSystemJoinPath() {
  return '/pages/join/index?invite=' + SYSTEM_JOIN_INVITE_CODE
}

function submitJoinApplication(payload, deviceId, inviteCode) {
  const code = String(inviteCode || payload.inviteCode || '').trim()
  if (!isValidJoinInviteCode(code)) {
    throw new Error('入驻码无效或已过期')
  }

  const normalizedDeviceId = String(deviceId || '').trim()
  if (!normalizedDeviceId) {
    throw new Error('设备信息异常，请重新打开小程序')
  }

  const name = String(payload.name || '').trim()
  if (!name) {
    throw new Error('请填写姓名')
  }

  const stations = normalizeStationList(payload.stations, payload.station)
  if (stations.length === 0) {
    throw new Error('请填写岗位')
  }

  const existedByDevice = state.employees.find((employee) => employee.applicantDeviceId === normalizedDeviceId)
  if (existedByDevice) {
    if (existedByDevice.status === 'active') {
      throw new Error('当前设备账号已审批通过，无需重复申请')
    }
    existedByDevice.name = name
    existedByDevice.stations = stations
    existedByDevice.inviteNote = payload.note || ''
    existedByDevice.inviteSource = payload.inviteSource || 'scan'
    existedByDevice.inviteCode = code
    pushLog('更新申请', existedByDevice.name + ' / ' + getEmployeeDisplayStations(existedByDevice), existedByDevice.name)
    return clone(existedByDevice)
  }

  const nextIndex = String(state.employees.length + 1).padStart(2, '0')
  const employee = {
    id: 'u-apply-' + Date.now() + '-' + nextIndex,
    name,
    role: 'worker',
    stations,
    status: 'pending',
    inviteSource: payload.inviteSource || 'scan',
    inviteNote: payload.note || '',
    inviteCode: code,
    applicantDeviceId: normalizedDeviceId
  }

  state.employees.unshift(employee)
  pushLog('提交申请', employee.name + ' / ' + getEmployeeDisplayStations(employee), employee.name)
  return clone(employee)
}

function resolveUserAccess(sessionUserId, deviceId) {
  const sessionId = String(sessionUserId || '').trim()
  if (sessionId) {
    const employee = findEmployee(sessionId)
    if (employee) {
      if (employee.status === 'active') {
        return { state: 'active', user: clone(employee) }
      }
      if (employee.status === 'pending') {
        return { state: 'pending', user: clone(employee) }
      }
    }
  }

  const normalizedDeviceId = String(deviceId || '').trim()
  if (normalizedDeviceId) {
    const employee = state.employees.find((item) => item.applicantDeviceId === normalizedDeviceId)
    if (employee) {
      return {
        state: employee.status === 'active' ? 'active' : 'pending',
        user: clone(employee)
      }
    }
  }

  return { state: 'guest', user: null }
}

function listOrders() {
  return clone(state.orders).map((order) => {
    const steps = getStepsByKeys(order.stepKeys)
    const overdue = isOverdue(order)
    return {
      ...order,
      steps,
      overdue,
      category: getOrderCategory(order),
      categoryLabel: getOrderStatusLabel(order),
      statusLabel: getOrderStatusLabel(order),
      progress: getProgress(order, steps),
      currentStepName: steps[Math.min(order.currentStepIndex, steps.length - 1)]?.name || '已完成',
      currentStation: steps[Math.min(order.currentStepIndex, steps.length - 1)]?.station || '入库完成'
    }
  })
}

function getOrder(orderId) {
  const order = state.orders.find((item) => item.id === orderId)
  if (!order) return null
  const steps = getStepsByKeys(order.stepKeys)
  const overdue = isOverdue(order)
  return clone({
    ...order,
    steps,
    overdue,
    category: getOrderCategory(order),
    categoryLabel: getOrderStatusLabel(order),
    statusLabel: getOrderStatusLabel(order),
    progress: getProgress(order, steps),
    currentStepName: steps[Math.min(order.currentStepIndex, steps.length - 1)]?.name || '已完成',
    currentStation: steps[Math.min(order.currentStepIndex, steps.length - 1)]?.station || '入库完成'
  })
}

function getEmployeeById(employeeId) {
  return clone(findEmployee(employeeId))
}

function listEmployees() {
  return clone(state.employees)
}

function listLogs() {
  return clone(state.logs).sort((left, right) => right.id - left.id)
}

function createOrder(payload, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可创建工单')
  }

  const nextId = String(state.orders.length + 1).padStart(3, '0')
  const id = 'GD20260516' + nextId
  const stepKeys = payload.selectedStepKeys || payload.stepKeys || processLibrary.map((p) => p.key)
  const order = {
    id,
    qrContent: id,
    customerName: payload.customerName,
    type: payload.type,
    size: payload.size,
    material: payload.material,
    dueDate: payload.dueDate,
    qty: Number(payload.qty),
    singleNo: payload.singleNo || ('S20260516' + nextId),
    status: 'processing',
    urgent: Boolean(payload.urgent),
    isReorder: Boolean(payload.isReorder),
    paused: false,
    currentStepIndex: 0,
    stepKeys,
    drawings: payload.drawings || [],
    drawingDetail: payload.drawingDetail || {},
    history: [],
    remarks: '',
    orderDate: formatDate(),   // 下单日期
    completedDate: null
  }

  state.orders.unshift(order)
  pushLog('创建订单', id, operator.name)
  return getOrder(id)
}

function completeCurrentStep(orderId, employeeId, note = '', qty = null, materialConsumption = null) {
  const order = state.orders.find((item) => item.id === orderId)
  const employee = findEmployee(employeeId)
  if (!order) throw new Error('订单不存在')
  if (!employee) throw new Error('员工不存在')
  if (employee.status !== 'active' && !isAdmin(employee)) throw new Error('账号未启用')
  if (order.status === 'completed') throw new Error('订单已完工')
  if (order.paused && !isAdmin(employee)) throw new Error('订单已暂停，仅管理员可处理')

  // 始终从 stepKeys 重新计算 steps，确保数据一致性
  const steps = getStepsByKeys(order.stepKeys)
  const currentStep = steps[order.currentStepIndex]
  if (!currentStep) {
    order.status = 'completed'
    return getOrder(orderId)
  }

  if (!isAdmin(employee) && !_employeeCanDoStation(employee, currentStep.station)) {
    throw new Error('当前仅允许' + currentStep.station + '处理' + currentStep.name)
  }

  // 如果是下料工序且提供了材料消耗信息，扣减库存（优先使用计算后的吨数）
  if (currentStep.key === 'blanking' && materialConsumption && materialConsumption.material) {
    const dedQty = materialConsumption.calcTons || materialConsumption.qty
    if (dedQty && Number(dedQty) > 0) {
      deductMaterialStock(
        materialConsumption.material,
        dedQty,
        employeeId,
        '工单 ' + orderId + ' 下料',
        orderId,
        materialConsumption.roughness || ''
      )
    }
  }

  order.history.push({
    stepKey: currentStep.key,
    stepName: currentStep.name,
    operatorId: employee.id,
    operator: employee.name,
    materialConsumption: materialConsumption && materialConsumption.material ? {
      material: materialConsumption.material,
      roughness: materialConsumption.roughness || '',
      qty: materialConsumption.qty,
      calcTons: materialConsumption.calcTons || null
    } : null,
    role: currentStep.station,
    completedAt: formatTime(),
    note,
    qty: qty !== null && qty !== '' ? Number(qty) : null
  })

  order.currentStepIndex += 1
  if (order.currentStepIndex >= steps.length) {
    order.status = 'completed'
    order.completedDate = formatTime()
  } else {
    order.status = 'processing'
  }

  pushLog('完成工序', orderId + ' / ' + currentStep.name, employee.name)

  return getOrder(orderId)
}

function togglePause(orderId, paused, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可暂停或恢复工单')
  }

  const order = state.orders.find((item) => item.id === orderId)
  if (!order) throw new Error('订单不存在')
  order.paused = Boolean(paused)
  order.status = order.paused ? 'paused' : 'processing'
  pushLog(order.paused ? '暂停工单' : '恢复工单', orderId, operator.name)
  return getOrder(orderId)
}

// 切换工单加急状态（仅管理员可操作）
function toggleOrderUrgent(orderId, urgent, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可修改加急状态')
  }
  const order = state.orders.find((item) => item.id === orderId)
  if (!order) throw new Error('订单不存在')
  order.urgent = Boolean(urgent)
  pushLog(order.urgent ? '设为加急' : '取消加急', orderId, operator.name)
  return getOrder(orderId)
}

// 获取员工岗位显示文本（兼容旧 station 字符串和新 stations 数组）
function getEmployeeDisplayStations(employee) {
  if (!employee) return ''
  const arr = employee.stations || []
  return arr.length > 0 ? arr.join('、') : (employee.station || '')
}

// 判断员工是否可以处理某岗位的工序
function _employeeCanDoStation(employee, station) {
  if (!employee || !station) return false
  const arr = employee.stations
  if (Array.isArray(arr)) return arr.includes(station)
  // 兼容旧的字符串格式
  return employee.station === station
}

// 更新员工岗位列表（仅管理员可操作）
function updateEmployeeStations(employeeId, stations, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可修改员工岗位')
  }
  const employee = findEmployee(employeeId)
  if (!employee) throw new Error('员工不存在')
  if (employee.role === 'superadmin') throw new Error('不能修改超级管理员')

  employee.stations = Array.isArray(stations) ? stations : []
  pushLog('调整岗位', employee.name + ' -> ' + getEmployeeDisplayStations(employee), operator.name)
  return clone(employee)
}

function inviteEmployee(payload, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可邀请员工')
  }

  const nextIndex = String(state.employees.length + 1).padStart(2, '0')
  const role = payload.role === 'admin' && !isSuperAdmin(operator) ? 'worker' : payload.role || 'worker'
  const employee = {
    id: 'u-invite-' + Date.now() + '-' + nextIndex,
    name: payload.name,
    role,
    stations: normalizeStationList(payload.stations, payload.station),
    status: 'pending',
    inviteSource: payload.inviteSource || 'admin',
    inviteNote: payload.note || '',
    inviteCode: payload.inviteCode || ('INV-' + Date.now())
  }

  state.employees.unshift(employee)
  pushLog('邀请员工', employee.name + ' / ' + getEmployeeDisplayStations(employee), operator.name)
  return clone(employee)
}

function approveEmployee(employeeId, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可审批员工')
  }

  const employee = findEmployee(employeeId)
  if (!employee) {
    throw new Error('员工不存在')
  }

  employee.status = 'active'
  pushLog('审批通过', employee.name + ' / ' + getEmployeeDisplayStations(employee), operator.name)
  return clone(employee)
}

function rejectEmployee(employeeId, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可处理员工申请')
  }

  const index = state.employees.findIndex((employee) => employee.id === employeeId)
  if (index < 0) {
    throw new Error('员工不存在')
  }

  const employee = state.employees[index]
  state.employees.splice(index, 1)
  pushLog('驳回申请', employee.name + ' / ' + getEmployeeDisplayStations(employee), operator.name)
  return clone(employee)
}

function deleteEmployee(employeeId, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  const employee = findEmployee(employeeId)
  if (!employee) {
    throw new Error('员工不存在')
  }
  if (!canManageWorker(operator, employee)) {
    throw new Error('没有权限删除该员工')
  }
  if (employee.role === 'superadmin') {
    throw new Error('不能删除超级管理员账号')
  }

  state.employees = state.employees.filter((item) => item.id !== employeeId)
  pushLog('删除员工', employee.name + ' / ' + getEmployeeDisplayStations(employee), operator.name)
  return clone(employee)
}

function updateEmployeeRole(employeeId, role, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isSuperAdmin(operator)) {
    throw new Error('只有超级管理员可以调整管理员权限')
  }

  const employee = findEmployee(employeeId)
  if (!employee) {
    throw new Error('员工不存在')
  }
  if (employee.role === 'superadmin') {
    throw new Error('不能修改超级管理员权限')
  }

  employee.role = role === 'admin' ? 'admin' : 'worker'
  employee.status = employee.status === 'pending' ? 'pending' : 'active'
  if (!Array.isArray(employee.stations)) employee.stations = []
  if (employee.role === 'admin') {
    if (!employee.stations.includes('管理员中心')) {
      employee.stations.unshift('管理员中心')
    }
  }

  pushLog('调整权限', employee.name + ' -> ' + employee.role, operator.name)
  return clone(employee)
}

function setCurrentUser(userId) {
  const employee = findEmployee(userId)
  if (!employee) {
    throw new Error('员工不存在')
  }
  return clone(employee)
}

function revertCompletedStep(orderId, stepKey, operatorId = 'u-root') {
  const order = state.orders.find((item) => item.id === orderId)
  const operator = findEmployee(operatorId)
  if (!order) throw new Error('订单不存在')
  if (!operator) throw new Error('员工不存在')
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可撤回已完成工序')
  }

  const steps = getStepsByKeys(order.stepKeys)

  // 找到要撤回的工序在 steps 中的索引
  const revertIndex = steps.findIndex((s) => s.key === stepKey)
  if (revertIndex < 0) {
    throw new Error('工序不存在于当前工单')
  }

  // 只能撤回已完成的工序（即 index < currentStepIndex 的工序）
  if (revertIndex >= order.currentStepIndex) {
    throw new Error('该工序尚未完成，无法撤回')
  }

  // 下料工序撤回：回退已扣减的库存
  if (stepKey === 'blanking') {
    const blankingHistory = order.history.find((h) => h.stepKey === 'blanking')
    if (blankingHistory && blankingHistory.materialConsumption) {
      const mc = blankingHistory.materialConsumption
      const material = mc.material
      const roughness = mc.roughness || ''
      let returnTons = mc.calcTons
      // 旧记录没有 calcTons，回算：单根重量 × 根数 / 1000
      if (!returnTons) {
        const len = 0  // 旧记录无长度，保守用 qty 本身（根）估算
        const rVal = Number(roughness)
        const qty = Number(mc.qty)
        if (rVal && qty) {
          const coef = getRoughnessCoefficient(rVal) || (rVal * rVal * 0.006165)
          // 用默认长度 1000mm 估算（实际应以历史记录为准，此为兜底）
          const single = 1000 * 1.05 * coef * 0.001
          returnTons = single * qty / 1000
        }
      }
      if (returnTons && Number(returnTons) > 0) {
        // 调用 addMaterialStock 回加库存（等同于入库）
        const matMap = state.materials[material]
        if (!matMap) state.materials[material] = {}
        const rKey = String(roughness)
        state.materials[material][rKey] = (state.materials[material][rKey] || 0) + Number(returnTons)
        state.materialLogs.unshift({
          id: state.materialLogs.length + 1,
          type: 'in',
          material,
          roughness: rKey,
          qty: Number(returnTons),
          operator: operator.name,
          operatorId: operator.id,
          at: formatTime(),
          note: '撤回下料工序 ' + orderId + '，库存回退'
        })
        pushLog('库存回退', material + ' φ' + rKey + ' +' + Number(returnTons).toFixed(4) + '吨（撤回下料）', operator.name)
      }
    }
  }

  // 撤回逻辑：移除该步骤及之后的所有历史记录，将 currentStepIndex 回退到该步骤
  order.history = order.history.filter((h) => h.stepKey !== stepKey)
  order.currentStepIndex = revertIndex

  // 如果之前是 completed 状态，恢复为 processing
  if (order.status === 'completed') {
    order.status = 'processing'
  }
  // 如果之前是 paused，保持 paused

  pushLog('撤回工序', orderId + ' / ' + steps[revertIndex].name, operator.name)

  return getOrder(orderId)
}

function updateOrderStepKeys(orderId, newStepKeys, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!isAdmin(operator)) {
    throw new Error('只有管理员可修改工序')
  }

  const order = state.orders.find((item) => item.id === orderId)
  if (!order) {
    throw new Error('订单不存在')
  }

  order.stepKeys = newStepKeys
  if (order.currentStepIndex >= newStepKeys.length) {
    order.currentStepIndex = newStepKeys.length - 1
  }
  pushLog('修改工序', orderId, operator.name)
  return getOrder(orderId)
}

// ===== 材料库存操作 =====

// 新增材料种类（仅管理员可操作）
function addMaterialType(materialName, operatorId = 'u-root') {
  const operator = findEmployee(operatorId)
  if (!operator) throw new Error('员工不存在')
  if (!isAdmin(operator)) throw new Error('只有管理员可新增材料种类')
  if (!materialName || typeof materialName !== 'string' || !materialName.trim()) {
    throw new Error('材料名称不能为空')
  }
  const name = materialName.trim()
  if (MATERIAL_TYPES.includes(name)) {
    throw new Error('材料「' + name + '」已存在')
  }
  // 添加到材料类型列表
  MATERIAL_TYPES.push(name)
  // 初始化该材料的库存结构
  if (!state.materials[name]) {
    state.materials[name] = {}
  }
  // 记录日志
  pushLog('新增材料', name, operator.name)
  return getMaterialInventory()
}

// 获取当前材料类型列表（供页面 picker 使用）
function getMaterialTypes() {
  return MATERIAL_TYPES.slice()
}

// 查询指定材料和粗度的当前库存（吨），查不到返回 0
function getMaterialStockByRoughness(material, roughness) {
  const rKey = String(roughness || '').trim()
  if (!material || !rKey) return 0
  return Number(state.materials[material] && state.materials[material][rKey]) || 0
}

// 获取材料库存列表（含各粗度明细及不足标记）
function getMaterialInventory() {
  return MATERIAL_TYPES.map((name) => {
    const roughnessMap = state.materials[name] || {}
    const threshold = MATERIAL_LOW_THRESHOLDS[name] || 0
    const roughnessEntries = Object.entries(roughnessMap)
    const totalStock = roughnessEntries.reduce((sum, [, v]) => sum + Number(v), 0)
    // 按粗度数值排序，并标记每个粗度是否低于阈值
    const detail = roughnessEntries
      .map(([roughness, stock]) => ({
        roughness: String(roughness),
        stock: Number(stock),
        isLow: Number(stock) < threshold
      }))
      .sort((a, b) => Number(a.roughness) - Number(b.roughness))
    // 卡片级：任一粗度不足则整张卡片标红
    const hasLowRoughness = detail.some(d => d.isLow)
    return { name, stock: totalStock, detail, hasLowRoughness }
  })
}

// 入库（管理员增加库存）
function addMaterialStock(material, qty, operatorId, note = '', roughness = '') {
  const operator = findEmployee(operatorId)
  if (!operator) throw new Error('员工不存在')
  if (!isAdmin(operator)) throw new Error('只有管理员可入库')
  if (!MATERIAL_TYPES.includes(material)) throw new Error('材料类型无效')
  if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) throw new Error('请输入有效的数量')
  if (roughness === '' || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  const matMap = state.materials[material]
  if (!matMap) state.materials[material] = {}
  state.materials[material][rKey] = (state.materials[material][rKey] || 0) + Number(qty)
  state.materialLogs.unshift({
    id: state.materialLogs.length + 1,
    type: 'in',
    material,
    roughness: rKey,
    qty: Number(qty),
    operator: operator.name,
    operatorId: operator.id,
    at: formatTime(),
    note
  })
  pushLog('材料入库', material + ' φ' + rKey + ' +' + qty + '吨', operator.name)
  return getMaterialInventory()
}

// 出库（消耗库存，下料时调用）
function deductMaterialStock(material, qty, operatorId, note = '', orderId = '', roughness = '') {
  const operator = findEmployee(operatorId)
  if (!operator) throw new Error('员工不存在')
  if (!MATERIAL_TYPES.includes(material)) throw new Error('材料类型无效')
  if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) throw new Error('请输入有效的数量')
  if (roughness === '' || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  const matMap = state.materials[material] || {}
  const current = matMap[rKey] || 0
  if (current < Number(qty)) {
    throw new Error(material + ' φ' + rKey + ' 库存不足，当前剩余 ' + current + ' 吨')
  }

  state.materials[material][rKey] = current - Number(qty)
  // 如果该粗度归零，保留键以便显示历史记录
  state.materialLogs.unshift({
    id: state.materialLogs.length + 1,
    type: 'out',
    material,
    roughness: rKey,
    qty: Number(qty),
    operator: operator.name,
    operatorId: operator.id,
    at: formatTime(),
    note,
    orderId
  })
  pushLog('材料出库', material + ' φ' + rKey + ' -' + qty + '吨', operator.name)
  return getMaterialInventory()
}

// 设置库存（管理员直接修正库存数量，按粗度维度）
function setMaterialStock(material, newStock, operatorId, note = '', roughness = '') {
  const operator = findEmployee(operatorId)
  if (!operator) throw new Error('员工不存在')
  if (!isAdmin(operator)) throw new Error('只有管理员可设置库存')
  if (!MATERIAL_TYPES.includes(material)) throw new Error('材料类型无效')
  if (newStock === null || newStock === undefined || isNaN(Number(newStock)) || Number(newStock) < 0) {
    throw new Error('请输入有效的库存数量')
  }
  if (roughness === '' || isNaN(Number(roughness)) || Number(roughness) < 0 || Number(roughness) > 200) {
    throw new Error('请输入有效的粗度（0-200mm）')
  }

  const rKey = String(roughness)
  if (!state.materials[material]) state.materials[material] = {}
  const oldStock = state.materials[material][rKey] || 0
  const stockNum = Number(newStock)

  state.materials[material][rKey] = stockNum
  state.materialLogs.unshift({
    id: state.materialLogs.length + 1,
    type: 'set',
    material,
    roughness: rKey,
    qty: stockNum,
    operator: operator.name,
    operatorId: operator.id,
    at: formatTime(),
    note: note || ('手动设置库存：' + material + ' φ' + rKey + ' ' + oldStock + ' → ' + stockNum + ' 吨')
  })
  pushLog('设置库存', material + ' φ' + rKey + ' → ' + stockNum + '吨', operator.name)
  return getMaterialInventory()
}

// 获取材料流水记录
function getMaterialLogs() {
  return clone(state.materialLogs)
}

// 获取用于导出的工单完整数据（含工序详情）
function getOrdersForExport(orderIds, dateRange) {
  let orders = clone(state.orders)
  if (orderIds && orderIds.length > 0) {
    orders = orders.filter((o) => orderIds.includes(o.id))
  }
  if (dateRange && (dateRange.start || dateRange.end)) {
    orders = orders.filter((o) => {
      if (!o.orderDate) return false
      const d = o.orderDate
      if (dateRange.start && d < dateRange.start) return false
      if (dateRange.end && d > dateRange.end) return false
      return true
    })
  }
  return orders.map((order) => {
    const steps = getStepsByKeys(order.stepKeys)
    const historyWithStepInfo = (order.history || []).map((h) => {
      const stepInfo = getProcessByKey(h.stepKey)
      return { ...h, station: stepInfo ? stepInfo.station : '' }
    })
    return {
      ...order,
      steps,
      history: historyWithStepInfo,
      statusLabel: getOrderStatusLabel(order),
      category: getOrderCategory(order),
      progress: order.stepKeys.length > 0
        ? Math.round((order.currentStepIndex / order.stepKeys.length) * 100)
        : 0
    }
  })
}

function formatTime() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
}

function formatDate() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
}

module.exports = {
  processLibrary,
  getProcessLibrary,
  getProcessByKey,
  getStepsByKeys,
  getDashboard,
  getEmployeeMonthlyProduction,
  getAllEmployeesMonthlyProduction,
  getProductionRows,
  buildMonthHeaders,
  getSystemJoinInviteCode,
  getSystemJoinPath,
  isValidJoinInviteCode,
  submitJoinApplication,
  resolveUserAccess,
  listOrders,
  getOrderCategory,
  getOrder,
  getEmployeeById,
  listEmployees,
  listLogs,
  createOrder,
  completeCurrentStep,
  togglePause,
  toggleOrderUrgent,
  revertCompletedStep,
  updateOrderStepKeys,
  isOverdue,
  inviteEmployee,
  approveEmployee,
  rejectEmployee,
  deleteEmployee,
  updateEmployeeRole,
  updateEmployeeStations,
  getEmployeeDisplayStations,
  setCurrentUser,
  isAdmin,
  isSuperAdmin,
  MATERIAL_TYPES,
  ROUGHNESS_COEFFICIENTS,
  getRoughnessCoefficient,
  getMaterialInventory,
  getMaterialStockByRoughness,
  addMaterialType,
  getMaterialTypes,
  addMaterialStock,
  deductMaterialStock,
  setMaterialStock,
  getMaterialLogs,
  getOrdersForExport
}
