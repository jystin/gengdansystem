/**
 * 工单导出 Excel 工具
 * 自动区分平台：
 *   - 手机端（iOS/Android）→ .xls（HTML 表格，微信可直接预览）
 *   - 电脑端（Windows/macOS）→ .csv（Excel 直接打开）
 */

const fs = wx.getFileSystemManager()

// 【优化】isMobile 结果缓存（设备信息在生命周期内不变）
let _isMobileCache = null
function isMobile() {
  if (_isMobileCache !== null) return _isMobileCache
  try {
    const deviceInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : {}
    const platform = deviceInfo.platform || (wx.getSystemInfoSync ? wx.getSystemInfoSync().platform : '')
    _isMobileCache = ['ios', 'android'].includes(platform)
  } catch (e) {
    _isMobileCache = true // 默认按手机处理
  }
  return _isMobileCache
}

// ===================== CSV 格式（电脑端用）=====================

function escapeCsvField(value) {
  if (value === null || value === undefined || value === '') return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function csvRow(fields) {
  return fields.map(escapeCsvField).join(',') + '\n'
}

/**
 * 生成 CSV 内容（每道工序独立一行）
 */
function generateOrderCsv(orders) {
  const headers = [
    '工单号', '客户', '种类', '尺寸', '数量', '单号', '材质',
    '交货日期', '下单日期', '状态', '是否加急', '进度',
    '序号', '工序名称', '生产人员', '岗位', '完成时间', '备注'
  ]
  let csv = '\uFEFF' + csvRow(headers) // UTF-8 BOM

  orders.forEach((order) => {
    const allSteps = order.steps || []
    const historyMap = {}
    ;(order.history || []).forEach((h) => { if (h.stepKey) historyMap[h.stepKey] = h })

    const baseInfo = [
      order.id, order.customerName, order.type, order.size,
      order.qty, order.singleNo, order.material,
      order.dueDate || '', fmtDate(order.orderDate),
      order.statusLabel, order.urgent ? '是' : '否', order.progress + '%'
    ]

    allSteps.forEach((step, index) => {
      const record = historyMap[step.key]
      const row = index === 0 ? [...baseInfo] : new Array(12).fill('')
      row.push(String(index + 1), step.name || '')

      if (record && record.operator) {
        row.push(record.operator, record.role || step.station || '',
                 record.completedAt || '', record.note || '-')
      } else {
        row.push('待处理', step.station || '', '', '')
      }
      csv += csvRow(row)
    })
  })
  return csv
}

// ===================== HTML/xls 格式（手机端用）=====================

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDate(dateStr) {
  if (!dateStr) return '未完成'
  return dateStr.includes(' ') ? dateStr.split(' ')[0] : dateStr
}

/**
 * 生成 HTML 表格内容（每道工序独立一行）
 */
function generateOrderHtml(orders) {
  const headers = [
    '工单号', '客户', '种类', '尺寸', '数量', '单号', '材质',
    '交货日期', '下单日期', '状态', '是否加急', '进度',
    '序号', '工序名称', '生产人员', '岗位', '完成时间', '备注'
  ]
  // 【优化】用数组 push + join 替代多次字符串拼接，减少 GC 压力
  const rowParts = []

  orders.forEach((order) => {
    const allSteps = order.steps || []
    const historyMap = {}
    ;(order.history || []).forEach((h) => { if (h.stepKey) historyMap[h.stepKey] = h })

    const baseInfo = [
      escapeHtml(order.id), escapeHtml(order.customerName),
      escapeHtml(order.type), escapeHtml(order.size),
      escapeHtml(order.qty), escapeHtml(order.singleNo),
      escapeHtml(order.material), fmtDate(order.dueDate),
      fmtDate(order.orderDate), escapeHtml(order.statusLabel),
      order.urgent ? '是' : '否', order.progress + '%'
    ]

    allSteps.forEach((step, index) => {
      const record = historyMap[step.key]
      const isFirst = index === 0

      if (isFirst) {
        const infoCells = baseInfo.map(v =>
          `<td style="background:#f0fdf4;font-weight:bold;">${v}</td>`
        ).join('')
        let stepCells
        if (record && record.operator) {
          stepCells = [
            `<td style="background:#f0fdf4;">${index + 1}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(step.name)}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(record.operator)}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(record.role || step.station || '')}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(record.completedAt || '')}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(record.note || '-')}</td>`
          ].join('')
        } else {
          stepCells = [
            `<td style="background:#f0fdf4;">${index + 1}</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(step.name)}</td>`,
            `<td style="background:#fff3cd;">待处理</td>`,
            `<td style="background:#f0fdf4;">${escapeHtml(step.station || '')}</td>`,
            `<td style="background:#f0fdf4;"></td>`,
            `<td style="background:#f0fdf4;"></td>`
          ].join('')
        }
        rowParts.push(`<tr>${infoCells}${stepCells}</tr>`)
      } else {
        const emptyInfo = new Array(12).fill('<td></td>').join('')
        let stepCells
        if (record && record.operator) {
          stepCells = [
            `<td>${index + 1}</td>`, `<td>${escapeHtml(step.name)}</td>`,
            `<td>${escapeHtml(record.operator)}</td>`,
            `<td>${escapeHtml(record.role || step.station || '')}</td>`,
            `<td>${escapeHtml(record.completedAt || '')}</td>`,
            `<td>${escapeHtml(record.note || '-')}</td>`
          ].join('')
        } else {
          stepCells = [
            `<td>${index + 1}</td>`, `<td>${escapeHtml(step.name)}</td>`,
            `<td style="color:#adb5bd;">待处理</td>`,
            `<td>${escapeHtml(step.station || '')}</td>`,
            `<td></td>`, `<td></td>`
          ].join('')
        }
        rowParts.push(`<tr>${emptyInfo}${stepCells}</tr>`)
      }
    })
  })

  const headerCells = headers.map(h =>
    `<th style="background:#0f766e;color:#fff;padding:8px 10px;border:1px solid #0f766e;">${h}</th>`
  ).join('')

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #d0d7de;padding:6px 10px;font-size:12px;white-space:nowrap}
</style>
</head>
<body>
<table>
<thead><tr>${headerCells}</tr></thead>
<tbody>${rowParts.length > 0 ? rowParts.join('') : '<tr><td colspan="18" style="text-align:center;padding:20px;color:#666;">无数据</td></tr>'}</tbody>
</table>
</body></html>`
}

// ===================== 统一导出入口 =====================

function formatNow() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 导出工单为文件并打开
 * @param {Array} orders - 工单数据数组
 * @param {string} fileName - 文件名（不含扩展名）
 */
function exportOrders(orders, fileName) {
  if (!orders || orders.length === 0) {
    wx.showToast({ title: '没有可导出的工单', icon: 'none' })
    return Promise.reject(new Error('没有可导出的工单'))
  }

  const mobile = isMobile()
  // 统一用 HTML/xls 格式，微信预览器支持下载；电脑上 Excel/WPS 也可直接打开
  const content = generateOrderHtml(orders)
  const fullFileName = (fileName || '工单导出') + '_' + formatNow() + '.xls'
  const tempFilePath = `${wx.env.USER_DATA_PATH}/${fullFileName}`

  return new Promise((resolve, reject) => {
    fs.writeFile({
      filePath: tempFilePath,
      data: content,
      encoding: 'utf8',
      success: () => {
        wx.showLoading({ title: '正在打开...' })
        wx.openDocument({
          filePath: tempFilePath,
          fileType: 'xls',
          showMenu: true,
          success: () => {
            wx.hideLoading()
            resolve()
          },
          fail: (err) => {
            wx.hideLoading()
            console.error('[export] openDocument failed:', err)
            wx.showToast({ title: '文件已生成，请在预览页保存', icon: 'none', duration: 3000 })
            resolve()
          }
        })
      },
      fail: (err) => {
        console.error('[export] writeFile failed:', err)
        wx.showToast({ title: '导出失败，请重试', icon: 'none' })
        reject(err)
      }
    })
  })
}

// ===================== 员工生产详情报表 =====================

/**
 * 生成员工月度生产详情 HTML（含工单明细）
 * @param {Array} rows - getProductionRows() 返回的行数据
 * @param {Object|null} singleEmployee - 单个员工对象（null=全部员工）
 * @param {string} year - 年份
 */
function generateProductionDetailHtml(rows, singleEmployee, year) {
  // 按员工分组，每组内按月份排序
  const grouped = {}
  const allEmployees = new Map()

  rows.forEach(r => {
    const empKey = r.employeeName || '未知'
    if (!grouped[empKey]) grouped[empKey] = []
    grouped[empKey].push(r)
    allEmployees.set(empKey, r.station || '')
  })

  // 每组内按月份+日期排序
  Object.keys(grouped).forEach(k => {
    grouped[k].sort((a, b) => a.monthKey.localeCompare(b.monthKey) || (a.completedAt || '').localeCompare(b.completedAt || ''))
  })

  // 【优化】用数组 push + join 构建 HTML，避免重复字符串拼接
  const bodyParts = []

  const employees = singleEmployee ? [singleEmployee.employee.name] : Object.keys(grouped).sort()
  employees.forEach(empName => {
    const empRows = grouped[empName] || []
    if (empRows.length === 0) return
    const station = allEmployees.get(empName) || ''

    bodyParts.push(`<tr><td colspan="6" style="background:#0f766e;color:#fff;padding:12px 16px;font-weight:700;font-size:14px;">${escapeHtml(empName)} · ${escapeHtml(station)} · 共 ${empRows.length} 条记录</td></tr>`)

    // 表头行
    bodyParts.push(`<tr>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">工单号</th>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">客户</th>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">工序</th>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">数量(根)</th>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">完成时间</th>
      <th style="background:#f1f5f9;padding:8px 10px;border:1px solid #e2e8f0;font-size:11px;">月份</th>
    </tr>`)

    let lastMonth = ''
    empRows.forEach(r => {
      const monthLabel = (r.monthKey || '').split('-')[1] ? (r.monthKey.split('-')[1] + '月') : '-'
      const monthChanged = monthLabel !== lastMonth
      if (monthChanged) {
        lastMonth = monthLabel
      }
      const bg = monthChanged ? '#f0fdf4' : '#ffffff'
      bodyParts.push(`<tr>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;font-weight:600; color:#0369a1;">${escapeHtml(r.orderId)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;">${escapeHtml(r.customerName || '-')}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;">${escapeHtml(r.stepName)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;text-align:center;font-weight:600;">${r.orderQty}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;">${r.completedAt || '-'}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;background:${bg};font-size:12px;text-align:center;">${monthLabel}</td>
      </tr>`)
    })
  })

  const bodyHtml = bodyParts.length > 0 ? bodyParts.join('') : '<tr><td colspan="6" style="text-align:center;padding:40px;color:#94a3b8;">暂无生产记录</td></tr>'

  const title = singleEmployee
    ? `${singleEmployee.employee.name} 月度生产明细 (${year})`
    : `全体员工月度生产明细 (${year})`

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #d0d7de;padding:6px 10px;font-size:12px}
</style></head>
<body>
<div style="font-size:18px;font-weight:700;margin-bottom:16px;">${title}</div>
<div style="font-size:12px;color:#666;margin-bottom:16px;">
每条记录对应一个工序完成事件 | 数量(根)=该工序所属工单的总数量 | 工单号可在系统中搜索查看详情
</div>
<table><tbody>${bodyHtml}</tbody></table>
</body></html>`
}

module.exports = { exportOrders, generateOrderHtml, generateOrderCsv, generateProductionDetailHtml, isMobile }
