const api = require('../../utils/api')
const ui = require('../../utils/ui')

function emptyCreateForm() {
  return {
    factory: '',
    customer: '',
    orderDate: '',
    dueDate: '',
    model: '',
    material: '',
    qty: '',
    batchNo: '',
    drawingsText: '',
    remarks: '',
    urgent: false,
    drawingDetail: {
      blankingRoughness: '',
      productRoughness: '',
      length: '',
      topHoleThread: '',
      topHole: '',
      crossHole: '',
      squareHead: ''
    }
  }
}

function emptyInviteForm() {
  return {
    name: '',
    station: '',
    stations: [],
    roleIndex: 0,
    note: ''
  }
}

Page({
  data: {
    currentUser: { role: '', status: 'active' },
    dashboard: {},
    orders: [],
    employees: [],
    pendingEmployees: [],
    logs: [],
    roleOptions: [],
    createForm: emptyCreateForm(),
    inviteForm: emptyInviteForm(),
    employeePanelOpen: false,
    // ===== 系统镜像点 =====
    snapshots: [],
    snapshotLabels: [],
    selectedSnapshotIndex: -1,
    selectedSnapshotId: '',
    snapshotSaving: false,
    snapshotRestoring: false,
    // 进度条
    snapshotProgressVisible: false,
    snapshotProgressPercent: 0,
    snapshotProgressText: '',
    snapshotProgressStep: 0,
    snapshotProgressTotal: 8
  },

  async onShow() {
    const app = getApp()
    await app.waitForAccessReady()
    if (!app.requireActiveAccess('/pages/scan/index')) return
    const currentUser = app.globalData.currentUser
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin') {
      this.setData({ currentUser: null })
      ui.toast('仅管理员可访问管理中心')
      return
    }
    const roleOptions = currentUser.role === 'superadmin' ? ['worker', 'admin'] : ['worker']

    try {
      ui.showLoading('加载中...')
      const [dashboard, orders, employees, logs] = await Promise.all([
        api.getDashboard().catch(() => null),
        api.listOrders(1, 100).catch(() => []),
        api.listEmployees().catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
      const cleanedEmployees = (employees || []).map(e => {
        const nameFallback = (currentUser.id && e.id === currentUser.id && currentUser.name)
          ? currentUser.name : '员工'
        return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role), statusLabel: api.statusLabel(e.status), _stationDisplay: api.getEmployeeDisplayStations(e) }
      })
      const pendingEmployees = cleanedEmployees.filter((employee) => employee.status === 'pending')

      this.setData({
        currentUser,
        dashboard: dashboard || {},
        orders: (orders || []).slice(0, 8),
        employees: cleanedEmployees,
        pendingEmployees,
        logs: (logs || []).slice(0, 12).map(api.normalizeLog).filter(Boolean),
        roleOptions,
        inviteForm: {
          ...this.data.inviteForm,
          roleIndex: Math.min(this.data.inviteForm.roleIndex, roleOptions.length - 1)
        }
      })

      // 后台加载镜像点列表（不阻塞首屏）
      this._loadSnapshots()
    } catch (e) {
      ui.handleError(e, '加载失败')
    } finally {
      ui.hideLoading()
    }
  },

  goHome() { wx.navigateBack({ delta: 1 }) },
  goToHome() { wx.reLaunch({ url: '/pages/home/index' }) },
  goProfile() { wx.navigateTo({ url: '/pages/profile/index' }) },
  goScan() { wx.navigateTo({ url: '/pages/scan/index' }) },
  goMaterial() { wx.navigateTo({ url: '/pages/material/index' }) },

  goCreateOrder() { wx.navigateTo({ url: '/pages/create-order/index' }) },
  goOrdersByCategory(event) {
    const category = event.currentTarget.dataset.category
    wx.navigateTo({ url: `/pages/orders/index?category=${category}` })
  },
  openOrder(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  bindCreateField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({ createForm: { ...this.data.createForm, [field]: value } })
  },

  toggleUrgent(event) {
    this.setData({ createForm: { ...this.data.createForm, urgent: event.detail.value } })
  },

  async submitCreateOrder() {
    const app = getApp()
    try {
      const form = this.data.createForm
      if (!form.factory || !form.customer || !form.dueDate || !form.model || !form.material || !form.qty) {
        ui.toast('请先补全工单信息'); return
      }
      const drawings = (form.drawingsText || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
        .map((name) => ({ name, type: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image' }))
      const result = await api.createOrder({
        customerName: form.customer,
        factory: form.factory,
        orderDate: form.orderDate,
        dueDate: form.dueDate,
        type: form.model,
        size: form.size || '',
        qty: Number(form.qty),
        material: form.material,
        singleNo: form.batchNo,
        urgent: !!form.urgent,
        isReorder: false,
        drawings,
        drawingDetail: form.drawingDetail,
        remarks: form.remarks,
        stepKeys: ['blanking', 'finish_turning', 'heat_treatment', 'quality_check', 'warehouse']
      })
      this.setData({ createForm: emptyCreateForm() })
      await this.onShow()
      ui.toast('工单已创建', 'success')
    } catch (e) {
      ui.handleError(e, '创建失败')
    }
  },

  bindInviteField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({ inviteForm: { ...this.data.inviteForm, [field]: value } })
  },

  bindInviteRole(event) {
    this.setData({ inviteForm: { ...this.data.inviteForm, roleIndex: Number(event.detail.value) } })
  },

  async submitInvite() {
    if (!this.data.inviteForm.name || !this.data.inviteForm.station) {
      ui.toast('请填写姓名和岗位'); return
    }
    const role = this.data.roleOptions[this.data.inviteForm.roleIndex] || 'worker'
    try {
      await api.inviteEmployee({
        name: this.data.inviteForm.name,
        station: this.data.inviteForm.station,
        stations: this.data.inviteForm.stations.length > 0 ? this.data.inviteForm.stations : [this.data.inviteForm.station],
        role,
        note: this.data.inviteForm.note
      })
      this.setData({ inviteForm: emptyInviteForm() })
      await this.onShow()
      ui.toast('已创建待审批账号', 'success')
    } catch (e) {
      ui.handleError(e, '创建失败')
    }
  },

  async approveEmployee(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.approveEmployee(id)
      await this._reloadEmployees()
      ui.toast('已通过审批', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async rejectEmployee(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.rejectEmployee(id)
      await this._reloadEmployees()
      ui.toast('已驳回', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async deleteEmployee(event) {
    const { id } = event.currentTarget.dataset
    const target = this.data.employees.find((employee) => employee.id === id) ||
                   this.data.pendingEmployees.find((employee) => employee.id === id)

    // 禁止管理员删除自己，避免把自己锁在管理中心外
    if (target && this.data.currentUser && target.id === this.data.currentUser.id) {
      ui.toast('不能删除当前登录账号', 'none')
      return
    }

    const targetName = target ? target.name : '该员工'
    const ok = await ui.confirm(
      `确定要永久删除 ${targetName} 吗？\n\n⚠ 此操作会从云端物理删除该员工数据，不可恢复。`,
      '确认永久删除'
    )
    if (!ok) return

    // ========== 乐观更新：先从本地列表移除 ==========
    const prevEmployees = [...this.data.employees]
    const prevPending = [...this.data.pendingEmployees]
    const removedEmployee = this.data.employees.find(e => e.id === id) || null
    const removedPending = this.data.pendingEmployees.find(e => e.id === id) || null

    this.setData({
      employees: this.data.employees.filter(e => e.id !== id),
      pendingEmployees: this.data.pendingEmployees.filter(e => e.id !== id)
    })

    ui.showLoading('删除中...')

    try {
      // ========== 调用云端API物理删除 ==========
      const result = await api.deleteEmployee(id)

      ui.hideLoading()
      ui.toast(result.message || '已删除', 'none')

      // 云端成功后刷新全量列表，确保与云端一致
      await this._reloadEmployees()
    } catch (e) {
      // ========== 云端删除失败 → 回滚本地状态 ==========
      console.error('[admin] 删除员工失败，执行本地回滚:', e)
      this.setData({
        employees: prevEmployees,
        pendingEmployees: prevPending
      })
      ui.hideLoading()
      ui.handleError(e, '删除失败，数据已回滚')
    }
  },

  /**
   * 仅刷新员工列表（不刷新工单、日志等）
   * 用于删除/审批操作后的局部更新
   */
  async _reloadEmployees() {
    try {
      const app = getApp()
      const [employees, logs] = await Promise.all([
        api.listEmployees().catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
      const cleanedEmployees = (employees || []).map(e => {
        const nameFallback = (app.globalData.currentUser &&
          app.globalData.currentUser.id === e.id && app.globalData.currentUser.name)
          ? app.globalData.currentUser.name : '员工'
        return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role), statusLabel: api.statusLabel(e.status), _stationDisplay: api.getEmployeeDisplayStations(e) }
      })
      this.setData({
        employees: cleanedEmployees,
        pendingEmployees: cleanedEmployees.filter(e => e.status === 'pending'),
        logs: (logs || []).slice(0, 12).map(api.normalizeLog).filter(Boolean)
      })
    } catch (e) {
      console.warn('[admin] 刷新员工列表失败:', e)
    }
  },

  async promoteToAdmin(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.updateEmployeeRole(id, 'admin')
      await this._reloadEmployees()
      ui.toast('已设为管理员', 'success')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  async demoteToWorker(event) {
    const { id } = event.currentTarget.dataset
    try {
      await api.updateEmployeeRole(id, 'worker')
      await this._reloadEmployees()
      ui.toast('已取消管理员权限', 'none')
    } catch (e) {
      ui.handleError(e, '操作失败')
    }
  },

  toggleEmployeePanel() {
    this.setData({ employeePanelOpen: !this.data.employeePanelOpen })
  },

  // ===== 系统镜像点管理 =====

  /**
   * 镜像集合列表（与云函数 SNAPSHOT_COLLECTIONS 对应）
   */
  _snapshotCollections: [
    { key: 'orders', label: '工单' },
    { key: 'inventory', label: '库存' },
    { key: 'material_logs', label: '材料日志' },
    { key: 'audit_logs', label: '审计日志' },
    { key: 'users', label: '用户' },
    { key: 'processes', label: '工序' },
    { key: 'invite_codes', label: '邀请码' },
    { key: 'pending_applications', label: '待审批' }
  ],

  /**
   * 后台加载镜像点列表（不阻塞主流程）
   */
  async _loadSnapshots() {
    try {
      const res = await api.listSnapshots()
      if (res && res.success && res.snapshots) {
        const labels = res.snapshots.map(s =>
          `[${s.type}] ${s.createdAt} · ${s.totalRecords}条 · ${s.operator}`
        )
        const prevIndex = this.data.selectedSnapshotIndex
        this.setData({
          snapshots: res.snapshots,
          snapshotLabels: labels,
          selectedSnapshotIndex: prevIndex < labels.length ? prevIndex : -1,
          selectedSnapshotId: prevIndex >= 0 && prevIndex < res.snapshots.length
            ? res.snapshots[prevIndex].snapshotId : ''
        })
      }
    } catch (e) {
      console.warn('[admin] 加载镜像点列表失败:', e)
    }
  },

  /**
   * 启动进度条动画
   * @param {string} mode  'save' | 'restore'
   * @returns {Function} 停止函数，调用后立即跳到 100%
   */
  _startProgressAnimation(mode) {
    const total = this._snapshotCollections.length
    const collections = this._snapshotCollections
    let step = 0
    let stopped = false

    const actionLabel = mode === 'save' ? '正在保存' : '正在恢复'
    const percentPerStep = Math.floor(98 / total) // 留 2% 给最终完成

    const tick = () => {
      if (stopped) return
      if (step >= total) {
        // 循环到最后一轮，保持等待
        step = total - 1
      }
      const col = collections[step]
      const percent = Math.min(step * percentPerStep + percentPerStep, 98)
      this.setData({
        snapshotProgressPercent: percent,
        snapshotProgressStep: step + 1,
        snapshotProgressText: `${actionLabel} ${col.label} 数据… (${step + 1}/${total})`
      })
      step++
    }

    // 立即显示第一帧
    tick()
    // 后台定时推进
    const timer = setInterval(tick, 1800)

    // 返回停止函数
    return () => {
      stopped = true
      clearInterval(timer)
    }
  },

  /**
   * 停止进度条（跳至完成态）
   */
  _finishProgress(success = true) {
    this.setData({
      snapshotProgressPercent: 100,
      snapshotProgressText: success ? '操作完成' : '操作中断',
      snapshotProgressStep: this._snapshotCollections.length
    })
    // 延迟隐藏进度条
    setTimeout(() => {
      this.setData({ snapshotProgressVisible: false })
    }, 800)
  },

  /**
   * 手动保存镜像点
   */
  async createSnapshot() {
    if (this.data.snapshotSaving) return
    const ok = await ui.confirm(
      '即将创建当前系统状态的完整镜像点（覆盖全部业务数据），确定继续吗？',
      '创建镜像点'
    )
    if (!ok) return

    this.setData({
      snapshotSaving: true,
      snapshotProgressVisible: true,
      snapshotProgressPercent: 0,
      snapshotProgressStep: 0,
      snapshotProgressTotal: this._snapshotCollections.length
    })
    const stopProgress = this._startProgressAnimation('save')

    try {
      const res = await api.createSnapshot()
      stopProgress()
      if (res && res.success) {
        this._finishProgress(true)
        ui.toast(res.message || '镜像点创建成功', 'success')
        await this._loadSnapshots()
      } else {
        this._finishProgress(false)
        ui.toast((res && res.error) || '创建失败')
      }
    } catch (e) {
      stopProgress()
      this._finishProgress(false)
      ui.handleError(e, '创建镜像点失败')
    } finally {
      this.setData({ snapshotSaving: false })
    }
  },

  /**
   * 镜像点选择变更
   */
  onSnapshotChange(e) {
    const index = Number(e.detail.value)
    const snapshot = this.data.snapshots[index]
    this.setData({
      selectedSnapshotIndex: index,
      selectedSnapshotId: snapshot ? snapshot.snapshotId : ''
    })
  },

  /**
   * 一键恢复至选中镜像点（二次确认 + 进度条）
   */
  async restoreSnapshot() {
    if (!this.data.selectedSnapshotId) {
      ui.toast('请先选择一个镜像点')
      return
    }
    if (this.data.snapshotRestoring) return

    const snap = this.data.snapshots[this.data.selectedSnapshotIndex]
    if (!snap) return

    // 第一次确认
    const ok1 = await ui.confirm(
      `确认恢复到以下镜像点吗？\n\n` +
      `时间：${snap.createdAt}\n类型：${snap.type}\n记录数：${snap.totalRecords} 条\n操作人：${snap.operator}\n\n` +
      `⚠️ 恢复后当前全部数据将被覆盖`,
      '确认恢复（1/2）'
    )
    if (!ok1) return

    // 第二次确认（更强提示）
    const ok2 = await ui.confirm(
      `⚠️ 最终确认 ⚠️\n\n` +
      `此操作将：\n` +
      `1. 清空当前所有业务数据\n` +
      `2. 从镜像点 ${snap.snapshotId} 完整恢复\n` +
      `3. 自动同步云端关联配置与数据\n\n` +
      `恢复后所有用户需重新登录。\n确定执行吗？`,
      '最终确认（2/2）'
    )
    if (!ok2) return

    this.setData({
      snapshotRestoring: true,
      snapshotProgressVisible: true,
      snapshotProgressPercent: 0,
      snapshotProgressStep: 0,
      snapshotProgressTotal: this._snapshotCollections.length
    })
    const stopProgress = this._startProgressAnimation('restore')

    try {
      const res = await api.restoreSnapshot(snap.snapshotId, true)
      stopProgress()
      if (res && res.success) {
        this._finishProgress(true)
        // ===== 云端数据同步：清除本地缓存并重新加载 =====
        api.clearCache()
        ui.toast(res.message || '恢复成功', 'success')
        setTimeout(() => {
          this._fullReloadAfterRestore()
        }, 1500)
      } else {
        this._finishProgress(false)
        ui.toast((res && res.error) || '恢复失败')
        this.setData({ snapshotRestoring: false })
      }
    } catch (e) {
      stopProgress()
      this._finishProgress(false)
      ui.handleError(e, '恢复失败')
      this.setData({ snapshotRestoring: false })
    }
  },

  /**
   * 恢复后全量重新加载管理页面数据，并同步 app 全局状态
   */
  async _fullReloadAfterRestore() {
    const app = getApp()
    try {
      ui.showLoading('同步云端数据...')
      // 重新鉴权，确保 token / 用户状态同步
      await app.waitForAccessReady()

      // 全量重新加载管理页面数据
      const [dashboard, orders, employees, logs] = await Promise.all([
        api.getDashboard().catch(() => null),
        api.listOrders(1, 100).catch(() => []),
        api.listEmployees().catch(() => []),
        api.listLogs(2).catch(() => [])
      ])
      const cleanedEmployees = (employees || []).map(e => {
        const nameFallback = (app.globalData.currentUser &&
          app.globalData.currentUser.id === e.id && app.globalData.currentUser.name)
          ? app.globalData.currentUser.name : '员工'
        return { ...e, name: api.cleanName(e.name, nameFallback), roleLabel: api.roleLabel(e.role), statusLabel: api.statusLabel(e.status), _stationDisplay: api.getEmployeeDisplayStations(e) }
      })
      const pendingEmployees = cleanedEmployees.filter(e => e.status === 'pending')
      const currentUser = app.globalData.currentUser

      this.setData({
        currentUser,
        dashboard: dashboard || {},
        orders: (orders || []).slice(0, 8),
        employees: cleanedEmployees,
        pendingEmployees,
        logs: (logs || []).slice(0, 12).map(api.normalizeLog).filter(Boolean),
        snapshotRestoring: false
      })

      await this._loadSnapshots()
      ui.toast('云端数据同步完成', 'success')
    } catch (e) {
      console.warn('[admin] 恢复后同步失败:', e)
      this.setData({ snapshotRestoring: false })
    } finally {
      ui.hideLoading()
    }
  },

  onShareAppMessage() {
    return {
      title: '兴祥机械跟单系统',
      path: '/pages/join/index'
    }
  }
})
