const api = require('../../utils/api')
const ui = require('../../utils/ui')
const storage = require('../../utils/cloud-storage')
const drawing = require('../../utils/drawing')

function emptyForm() {
  return {
    customerName: '',
    type: '',
    size: '',
    qty: '',
    material: '',
    dueDate: '',
    singleNo: '',
    urgent: null,
    isReorder: null,
    drawings: [],
    drawingDetail: {
      blankingRoughness: '',
      productRoughness: '',
      length: '',
      blankingLength: '',
      topHoleThread: '',
      crossHole: '',
      squareHead: ''
    },
    selectedStepKeys: []
  }
}

Page({
  data: {
    currentUser: { role: '', status: 'active' },
    isAdmin: false,
    isDesktopPlatform: false,
    form: emptyForm(),
    createdOrderId: '',
    processList: [],
    selectedSteps: [],
    showCopyModal: false,
    copyOrders: [],
    templates: [],
    showSaveTemplateModal: false,
    templateName: '',
    templateDesc: ''
  },

  async onLoad() {
    await this._init()
  },

  async _init() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    // 如果距离上次鉴权超过 60 秒，刷新权限（防止管理员权限变更后当前用户拿到旧角色）
    if (Date.now() - (app.globalData._lastAuthSyncTime || 0) > 60000) {
      await app.refreshAuthContext()
    }
    const currentUser = app.globalData.currentUser
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'superadmin'
    if (!isAdmin) {
      ui.toast('只有管理员可创建工单')
      wx.redirectTo({ url: '/pages/home/index' })
      return
    }
    try {
      ui.showLoading('加载中...')
      const processList = api.getProcessLibrary()
      const orders = await api.listOrders(1, 100).catch(() => [])
      // 加载固定工序模板（仅管理员）
      const tplRes = await api.listProcessTemplates().catch(() => ({ templates: [] }))
      const templates = (tplRes && tplRes.templates) || []
      // 为每个模板预计算工序展示名
      const processMap = Object.fromEntries(processList.map(p => [p.key, p]))
      const enrichedTemplates = templates.map(t => ({
        ...t,
        previewSteps: (t.stepKeys || []).map(k => processMap[k]).filter(Boolean)
      }))
      this.setData({
        currentUser,
        isAdmin,
        isDesktopPlatform: drawing.isDesktop(),
        processList,
        copyOrders: orders || [],
        templates: enrichedTemplates,
        selectedSteps: [],
        form: { ...emptyForm(), selectedStepKeys: [] }
      })
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  goToHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onShow() { /* 避免图片上传时表单被重置 */ },

  async chooseDrawing() {
    if (this._choosingLock) return
    this._choosingLock = true
    try {
      const app = getApp()
      const privacyOk = await app.requirePrivacyAuthorize()
      if (!privacyOk) return

      // 移动端：拍照/相册；电脑端：本地文件（支持 PDF）
      const picked = await drawing.chooseDrawings(9)
      if (!picked.length) return

      const drawings = (this.data.form.drawings || []).concat(picked)
      this.setData({ form: { ...this.data.form, drawings } })
    } catch (e) {
      ui.handleError(e, '上传图纸失败')
    } finally {
      this._choosingLock = false
    }
  },

  /** 预览已选图纸（图片左右滑动 / PDF 用系统打开） */
  previewDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    drawing.openDrawing(this.data.form.drawings || [], index)
  },

  removeDrawing(event) {
    const index = Number(event.currentTarget.dataset.index)
    const drawings = this.data.form.drawings.filter((_, i) => i !== index)
    this.setData({ form: { ...this.data.form, drawings } })
  },

  toggleIsReorder() {
    this.setData({
      form: { ...this.data.form, isReorder: !this.data.form.isReorder }
    })
  },

  bindField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({
      form: { ...this.data.form, [field]: value }
    })
  },

  bindDueDate(event) {
    this.setData({ form: { ...this.data.form, dueDate: event.detail.value } })
  },

  setUrgent(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({ form: { ...this.data.form, urgent: value } })
  },

  setIsReorder(event) {
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({ form: { ...this.data.form, isReorder: value } })
  },

  bindSubField(event) {
    const field = event.currentTarget.dataset.field
    const sub = event.currentTarget.dataset.sub
    const value = event.detail.value
    this.setData({
      form: {
        ...this.data.form,
        [sub]: { ...(this.data.form[sub] || {}), [field]: value }
      }
    })
  },

  setDrawingDetailBool(event) {
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({
      form: {
        ...this.data.form,
        drawingDetail: { ...(this.data.form.drawingDetail || {}), [key]: value }
      }
    })
  },

  /** 可重复工序（精车）自动编号：精车1 / 精车2 / 精车3 */
  _renumberSteps(list) {
    const arr = Array.isArray(list) ? list : []
    const total = {}
    arr.forEach(s => { total[s.key] = (total[s.key] || 0) + 1 })
    const seq = {}
    return arr.map(s => {
      seq[s.key] = (seq[s.key] || 0) + 1
      const base = (api.getProcessByKey(s.key) || {}).name || s.name
      return { ...s, name: total[s.key] > 1 ? `${base}${seq[s.key]}` : base }
    })
  },

  addStep(event) {
    const stepKey = event.currentTarget.dataset.key
    const step = this.data.processList.find((p) => p.key === stepKey)
    if (!step) return
    const form = this.data.form
    // 可重复工序（精车）插到同名前一道之后，保持连续；其它工序追加到末尾
    const newSelectedSteps = this._renumberSteps(api.insertStepSmart(this.data.selectedSteps, {
      ...step,
      instanceId: `${stepKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }))
    this.setData({
      selectedSteps: newSelectedSteps,
      form: { ...form, selectedStepKeys: newSelectedSteps.map((s) => s.key) }
    })
  },

  removeSelectedStep(event) {
    const instanceId = event.currentTarget.dataset.instanceId
    // 防御 instanceId 缺失时误清空全部
    if (!instanceId) {
      console.warn('[create-order] 删除工序失败：缺少 instanceId')
      ui.toast('操作失败，请重试')
      return
    }
    const form = this.data.form
    const newSelectedSteps = this._renumberSteps(this.data.selectedSteps.filter((s) => s.instanceId !== instanceId))
    this.setData({
      selectedSteps: newSelectedSteps,
      form: { ...form, selectedStepKeys: newSelectedSteps.map((s) => s.key) }
    })
  },

  async submit() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    // 提交时也检查一次权限是否过期
    if (Date.now() - (app.globalData._lastAuthSyncTime || 0) > 60000) {
      await app.refreshAuthContext()
    }
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      ui.toast('只有管理员可创建工单')
      return
    }
    const form = this.data.form
    const missing = []
    if (!form.customerName) missing.push('客户名称')
    if (!form.type) missing.push('种类')
    if (!form.size) missing.push('尺寸')
    if (!form.qty) missing.push('数量')
    if (!form.material) missing.push('材质')
    if (!form.dueDate) missing.push('交货期')
    if (!form.singleNo) missing.push('单号')
    if (form.urgent !== true && form.urgent !== false) missing.push('是否急要')
    if (form.isReorder !== true && form.isReorder !== false) missing.push('是否补单')
    if (!form.selectedStepKeys || form.selectedStepKeys.length === 0) missing.push('工序配置')
    if (missing.length > 0) {
      ui.toast('请填写：' + missing.join('、'), 'none', 2500)
      return
    }

    try {
      ui.showLoading('上传图纸中...')
      // 上传图纸到云存储（并行控制并发数为3，比串行快约3倍）
      const drawings = []
      const filesToUpload = (form.drawings || []).filter(d => d.tempFilePath)
      // 本地图纸直接保留引用
      for (const d of (form.drawings || [])) {
        if (!d.tempFilePath) drawings.push(d)
      }
      // 分段并行上传
      const CONCURRENCY = 3
      for (let i = 0; i < filesToUpload.length; i += CONCURRENCY) {
        const batch = filesToUpload.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(batch.map(async (d) => {
          const ext = d.ext || drawing.extOf(d.name) || drawing.extOf(d.tempFilePath) || 'jpg'
          const cloudPath = `drawings/${form.singleNo || 'order'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
          const up = await storage.uploadFile(cloudPath, d.tempFilePath)
          return {
            name: d.name,
            fileID: up.fileID,
            cloudPath: up.fileID,
            type: d.isPDF ? 'pdf' : (d.type || 'image')
          }
        }))
        for (const result of results) {
          if (result.status === 'fulfilled') {
            drawings.push(result.value)
          }
        }
      }

      ui.showLoading('创建工单中...')
      const result = await api.createOrder({
        customerName: form.customerName,
        type: form.type,
        size: form.size,
        qty: Number(form.qty),
        material: form.material,
        dueDate: form.dueDate,
        singleNo: form.singleNo,
        urgent: !!form.urgent,
        isReorder: !!form.isReorder,
        drawings,
        stepKeys: form.selectedStepKeys,
        drawingDetail: form.drawingDetail,
        remarks: form.remarks || ''
      })

      const order = result && result.order ? result.order : result
      this.setData({ form: emptyForm(), createdOrderId: order.id || '' })
      ui.hideLoading()
      ui.toast('工单创建成功', 'success')
      // 二维码降级提示（WX_APP_SECRET 未配置等场景）
      // 注意：不能把跳转挂在 modal 回调上（部分环境弹窗会被吞，导致永远不跳转、用户重复下单）
      if (result && result.qrWarning) {
        console.warn('[create-order]', result.qrWarning)
        ui.toast('小程序码生成失败，可在详情页重新生成', 'none', 2500)
      }
      if (order.id) {
        wx.navigateTo({ url: `/pages/order-detail/index?id=${order.id}` })
      }
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '创建工单失败')
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  async openCopyModal() {
    try {
      const orders = await api.listOrders(1, 100)
      this.setData({ showCopyModal: true, copyOrders: orders || [] })
    } catch (e) {
      ui.handleError(e, '加载工单失败')
    }
  },

  closeCopyModal() {
    this.setData({ showCopyModal: false })
  },

  loadFromOrder(event) {
    const orderId = event.currentTarget.dataset.id
    const order = this.data.copyOrders.find((o) => o.id === orderId)
    if (!order) return
    const selectedSteps = this._renumberSteps((order.stepKeys || []).map((key, index) => {
      const proc = this.data.processList.find((p) => p.key === key)
      return proc ? {
        ...proc,
        instanceId: `${key}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`
      } : null
    }).filter(Boolean))

    this.setData({
      form: {
        ...emptyForm(),
        customerName: order.customerName || '',
        type: order.type || '',
        size: order.size || '',
        qty: order.qty !== undefined ? String(order.qty) : '',
        material: order.material || '',
        dueDate: order.dueDate || '',
        singleNo: '',
        drawings: [],
        drawingDetail: (() => {
          const dd = order.drawingDetail || {}
          return {
            blankingRoughness: dd.blankingRoughness || dd.roughness || '',
            productRoughness: dd.productRoughness || dd.bossRoughness || '',
            length: dd.length || '',
            blankingLength: dd.blankingLength || '',
            topHoleThread: dd.topHoleThread || dd.thread || '',
            crossHole: dd.crossHole || dd.markText || '',
            squareHead: dd.squareHead || ''
          }
        })(),
        urgent: null,
        isReorder: null,
        selectedStepKeys: order.stepKeys || []
      },
      selectedSteps,
      showCopyModal: false
    })
    ui.toast('已读取：' + orderId, 'none')
  },

  // ========== 固定工序模板相关 ==========

  applyTemplate(event) {
    const { id, keys } = event.currentTarget.dataset
    const stepKeys = Array.isArray(keys) ? keys : []
    if (stepKeys.length === 0) {
      ui.toast('模板内容为空')
      return
    }
    const tpl = this.data.templates.find(t => t._id === id)
    const tplName = tpl ? tpl.name : ''
    const processMap = Object.fromEntries(this.data.processList.map(p => [p.key, p]))
    const newSelectedSteps = this._renumberSteps(stepKeys.map((key, index) => {
      const proc = processMap[key]
      if (!proc) return null
      return {
        ...proc,
        instanceId: `${key}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`
      }
    }).filter(Boolean))

    if (newSelectedSteps.length === 0) {
      ui.toast('模板中的工序在当前工序库不存在')
      return
    }

    this.setData({
      selectedSteps: newSelectedSteps,
      form: { ...this.data.form, selectedStepKeys: newSelectedSteps.map(s => s.key) },
      templates: this.data.templates.map(t => ({ ...t, _expanded: false }))
    })
    ui.toast(`已导入模板「${tplName}」(${newSelectedSteps.length} 个工序)`, 'success')
  },

  toggleTemplateExpand(event) {
    const { id } = event.currentTarget.dataset
    this.setData({
      templates: this.data.templates.map(t => ({ ...t, _expanded: t._id === id ? !t._expanded : false }))
    })
  },

  openSaveTemplateModal() {
    const keys = this.data.form.selectedStepKeys || []
    if (keys.length === 0) {
      ui.toast('请先在下工序添加要保存的工序')
      return
    }
    this.setData({
      showSaveTemplateModal: true,
      templateName: '',
      templateDesc: ''
    })
  },

  closeSaveTemplateModal() {
    this.setData({ showSaveTemplateModal: false })
  },

  bindTemplateName(event) {
    this.setData({ templateName: event.detail.value })
  },

  bindTemplateDesc(event) {
    this.setData({ templateDesc: event.detail.value })
  },

  async submitSaveTemplate() {
    const { templateName, templateDesc, form } = this.data
    const name = (templateName || '').trim()
    if (!name) { ui.toast('请输入模板名称'); return }
    const stepKeys = form.selectedStepKeys || []
    if (stepKeys.length === 0) {
      ui.toast('当前没有已选工序，无法保存')
      return
    }
    try {
      ui.showLoading('保存中...')
      const res = await api.saveProcessTemplate(name, stepKeys, templateDesc)
      ui.hideLoading()
      const tpl = (res && (res.template || res)) || {}
      const processMap = Object.fromEntries(this.data.processList.map(p => [p.key, p]))
      const newTpl = { ...tpl, previewSteps: (tpl.stepKeys || stepKeys).map(k => processMap[k]).filter(Boolean) }
      this.setData({
        templates: [newTpl, ...this.data.templates],
        showSaveTemplateModal: false
      })
      ui.toast('模板已保存', 'success')
    } catch (e) {
      ui.hideLoading()
      ui.handleError(e, '保存失败')
    }
  },

  async confirmDeleteTemplate(event) {
    const { id, name } = event.currentTarget.dataset
    const ok = await ui.confirm(`确定删除模板「${name}」吗？此操作不可恢复。`, '删除模板', { confirmColor: '#dc2626', confirmText: '删除' })
    if (!ok) return
    try {
      await api.deleteProcessTemplate(id)
      this.setData({ templates: this.data.templates.filter(t => t._id !== id) })
      ui.toast('已删除模板', 'success')
    } catch (e) {
      ui.handleError(e, '删除失败')
    }
  }
})
