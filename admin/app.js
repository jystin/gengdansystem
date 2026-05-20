function buildQrUrl(text, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`
}

const dashboard = {
  totalOrders: 28,
  inProgress: 12,
  completed: 9,
  paused: 2,
  overdue: 3,
  pendingEmployees: 4
}

const orders = [
  {
    id: 'GD20260516001',
    factory: '华东机械',
    customer: '海龙阀门',
    model: 'VT-80A',
    material: '304不锈钢',
    progress: 18,
    label: '加急',
    tone: 'danger',
    step: '粗车'
  },
  {
    id: 'GD20260516002',
    factory: '中南装备',
    customer: '长江泵阀',
    model: 'VT-60B',
    material: '316L不锈钢',
    progress: 42,
    label: '已暂停',
    tone: 'warning',
    step: '热处理'
  },
  {
    id: 'GD20260515001',
    factory: '东海阀业',
    customer: '恒远流体',
    model: 'VT-50C',
    material: '45#钢',
    progress: 100,
    label: '已完工',
    tone: 'success',
    step: '入库'
  }
]

const employees = [
  { name: '赵师傅', station: '质检员', status: '待审批', tone: 'warning' },
  { name: '陈师傅', station: '电镀工', status: '待审批', tone: 'warning' },
  { name: '孙师傅', station: '磨削工', status: '待审批', tone: 'warning' }
]

const logs = [
  { action: '创建订单', target: 'GD20260516001', operator: '张主管', at: '2026-05-12 16:10' },
  { action: '暂停工单', target: 'GD20260516002', operator: '张主管', at: '2026-05-11 15:50' },
  { action: '完成工序', target: 'GD20260515001 / 质检', operator: '赵师傅', at: '2026-05-14 17:40' }
]

function createMetricCard(label, value, hint) {
  const card = document.createElement('div')
  card.className = 'metric-card'
  card.innerHTML = `
    <div class="metric-label">${label}</div>
    <div class="metric-value">${value}</div>
    <div class="metric-hint">${hint}</div>
  `
  return card
}

function createChip(tone, label) {
  return `<span class="chip chip-${tone}">${label}</span>`
}

function renderMetrics() {
  const root = document.getElementById('metrics')
  const cards = [
    ['总工单', dashboard.totalOrders, '当前系统里所有流转单'],
    ['进行中', dashboard.inProgress, '还在车间流转的订单'],
    ['已完工', dashboard.completed, '已完成并可追溯的订单'],
    ['待审批员工', dashboard.pendingEmployees, '等待管理员审核加入']
  ]

  root.innerHTML = ''
  cards.forEach(([label, value, hint]) => {
    root.appendChild(createMetricCard(label, value, hint))
  })
}

function renderOrders() {
  const root = document.getElementById('orders')
  root.innerHTML = orders
    .map(
      (order) => `
        <div class="order-card">
          <div class="row">
            <div class="order-id">${order.id}</div>
            ${createChip(order.tone, order.label)}
          </div>
          <div class="meta">${order.factory} · ${order.customer}</div>
          <div class="meta">型号 ${order.model} · 材质 ${order.material}</div>
          <div class="progress"><span style="width: ${order.progress}%"></span></div>
          <div class="hint">当前工序：${order.step}</div>
        </div>
      `
    )
    .join('')
}

function renderQrManagement() {
  const root = document.getElementById('qrs')
  root.innerHTML = orders
    .map(
      (order) => `
        <article class="qr-card">
          <img class="qr-image" src="${buildQrUrl(order.id, 240)}" alt="${order.id} 二维码" />
          <div class="qr-meta">
            <div class="order-id">${order.id}</div>
            <div class="meta">${order.factory} · ${order.customer}</div>
            <div class="meta">二维码内容：${order.id}</div>
          </div>
        </article>
      `
    )
    .join('')
}

function renderEmployees() {
  const root = document.getElementById('employees')
  root.innerHTML = employees
    .map(
      (employee) => `
        <div class="employee-card">
          <div class="row">
            <div class="person-name">${employee.name}</div>
            ${createChip(employee.tone, employee.status)}
          </div>
          <div class="meta">${employee.station}</div>
        </div>
      `
    )
    .join('')
}

function renderLogs() {
  const root = document.getElementById('logs')
  root.innerHTML = logs
    .map(
      (log) => `
        <div class="log-card">
          <div class="row">
            <div class="log-action">${log.action}</div>
            <div class="meta">${log.at}</div>
          </div>
          <div class="meta">${log.target} · ${log.operator}</div>
        </div>
      `
    )
    .join('')
}

renderMetrics()
renderOrders()
renderQrManagement()
renderEmployees()
renderLogs()

window.addEventListener('beforeprint', () => {
  document.body.classList.add('printing')
})

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing')
})

window.printDashboard = function printDashboard() {
  window.print()
}
