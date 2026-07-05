/**
 * 兴祥机械跟单系统 - Web 管理后台
 * 当前为静态占位版本，数据需通过云函数 API 获取
 * 接入云开发 SDK 后可替换为真实数据渲染
 */

// ====== 工具函数 ======

function buildQrUrl(text, size = 220) {
  // 使用微信云开发 wxacode API 生成小程序码（需接入 SDK）
  // 当前使用第三方 API 仅作占位，生产环境建议替换为 wxacode.getUnlimited
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`
}

// ====== 空状态数据（接入云开发后替换为真实 API 返回） ======

const dashboard = { totalOrders: 0, inProgress: 0, completed: 0, paused: 0, overdue: 0, pendingEmployees: 0 }
const orders = []
const employees = []
const logs = []

// ====== 渲染函数 ======

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

function renderEmptyState(containerId, message) {
  const root = document.getElementById(containerId)
  root.innerHTML = `<div class="empty-state">${message}</div>`
}

function renderOrders() {
  if (orders.length === 0) {
    renderEmptyState('orders', '暂无功单数据，请先在小程序中创建工单')
    return
  }
  const root = document.getElementById('orders')
  root.innerHTML = orders.map(order => `
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
  `).join('')
}

function renderQrManagement() {
  if (orders.length === 0) {
    renderEmptyState('qrs', '暂无二维码数据')
    return
  }
  const root = document.getElementById('qrs')
  root.innerHTML = orders.map(order => `
    <article class="qr-card">
      <img class="qr-image" src="${buildQrUrl(order.id, 240)}" alt="${order.id} 二维码" />
      <div class="qr-meta">
        <div class="order-id">${order.id}</div>
        <div class="meta">${order.factory} · ${order.customer}</div>
        <div class="meta">二维码内容：${order.id}</div>
      </div>
    </article>
  `).join('')
}

function renderEmployees() {
  if (employees.length === 0) {
    renderEmptyState('employees', '暂无待审批员工')
    return
  }
  const root = document.getElementById('employees')
  root.innerHTML = employees.map(employee => `
    <div class="employee-card">
      <div class="row">
        <div class="person-name">${employee.name}</div>
        ${createChip(employee.tone, employee.status)}
      </div>
      <div class="meta">${employee.station}</div>
    </div>
  `).join('')
}

function renderLogs() {
  if (logs.length === 0) {
    renderEmptyState('logs', '暂无操作记录')
    return
  }
  const root = document.getElementById('logs')
  root.innerHTML = logs.map(log => `
    <div class="log-card">
      <div class="row">
        <div class="log-action">${log.action}</div>
        <div class="meta">${log.at}</div>
      </div>
      <div class="meta">${log.target} · ${log.operator}</div>
    </div>
  `).join('')
}

// ====== 初始渲染 ======

// 【优化】缓存所有常用 DOM 查询结果，避免每次 render 都重复 querySelector
const $ = (id) => {
  const el = document.getElementById(id)
  // 将结果缓存到 $ 函数自身，后续调用走缓存
  if (el) $[id] = el
  return el
}

function initRender() {
  renderMetrics()
  renderOrders()
  renderQrManagement()
  renderEmployees()
  renderLogs()
}

document.addEventListener('DOMContentLoaded', initRender)

// 兜底：如果 DOMContentLoaded 已触发则直接渲染
if (document.readyState !== 'loading') {
  initRender()
}

// ====== 打印支持 ======

window.addEventListener('beforeprint', () => {
  document.body.classList.add('printing')
})
window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing')
})
window.printDashboard = function printDashboard() {
  window.print()
}
