/**
 * UI 工具：loading / toast / modal / 防抖节流
 */

let loadingCount = 0

function showLoading(title = '加载中...', mask = true) {
  loadingCount++
  if (loadingCount > 1) return
  wx.showLoading({ title, mask })
}
function hideLoading(force = false) {
  if (force) loadingCount = 0
  else loadingCount = Math.max(0, loadingCount - 1)
  if (loadingCount === 0) {
    wx.hideLoading()
  }
}
function resetLoading() {
  loadingCount = 0
  wx.hideLoading()
}

function toast(title, icon = 'none', duration = 1500) {
  wx.showToast({ title, icon, duration })
}

function modal(options) {
  return new Promise((resolve) => {
    wx.showModal({
      title: options.title || '提示',
      content: options.content || '',
      confirmText: options.confirmText || '确定',
      cancelText: options.cancelText || '取消',
      confirmColor: options.confirmColor || '#0f766e',
      showCancel: options.showCancel !== false,
      success: (res) => resolve(res),
      fail: () => resolve({ confirm: false, cancel: true })
    })
  })
}

async function confirm(content, title = '确认操作', options = {}) {
  const res = await modal({
    title,
    content,
    showCancel: true,
    ...options
  })
  return res.confirm
}

// 节流（固定时间窗口内只执行首次）
function throttle(fn, wait = 300) {
  let last = 0
  let timer = null
  return function (...args) {
    const now = Date.now()
    const remain = wait - (now - last)
    if (remain <= 0) {
      if (timer) { clearTimeout(timer); timer = null }
      last = now
      fn.apply(this, args)
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now()
        timer = null
        fn.apply(this, args)
      }, remain)
    }
  }
}

// 防抖（停止触发 wait 毫秒后才执行）
function debounce(fn, wait = 300) {
  let timer = null
  return function (...args) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), wait)
  }
}

// 错误统一处理
function handleError(err, fallback = '操作失败') {
  const msg = (err && (err.message || err.errMsg)) || fallback
  console.error('[UI] handleError:', err)
  toast(msg, 'none', 2000)
}

module.exports = {
  showLoading,
  hideLoading,
  resetLoading,
  toast,
  modal,
  confirm,
  throttle,
  debounce,
  handleError
}
