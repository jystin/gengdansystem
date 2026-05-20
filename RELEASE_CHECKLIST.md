生产版本迁移检查清单（release_0.1.0）

此文档用于跟踪从演示版本迁移到生产版本的完成度。
在提交 PR 到 main/master 分支前，确保所有检查项都标记为完成。

---

## ✅ 核心迁移项

### 1. 后端授权系统
- [ ] 云函数 `auth/index.js` 已创建并部署
- [ ] 云函数支持 login/verify/logout/createInviteCode/submitJoinApplication 操作
- [ ] JWT token 或签名验证方案已选择并实现
- [ ] 云函数错误处理与日志记录完善

### 2. 数据库架构
- [ ] 在云开发环境创建以下集合（或使用自建后端数据库对应表）：
  - [ ] users （用户表）
  - [ ] pending_applications （待审批申请）
  - [ ] invite_codes （邀请码与其状态）
  - [ ] orders （工单表）
  - [ ] inventory （库存表）
  - [ ] processes （工序库）
  - [ ] audit_logs （审计日志）
  - [ ] material_logs （材料流水）

### 3. 数据迁移
- [ ] 已从 mock-store 导出初始工序数据
- [ ] 已从 mock-store 导出初始员工（active）数据
- [ ] 已从 mock-store 导出初始工单数据
- [ ] 已从 mock-store 导出初始库存数据
- [ ] 初始化脚本 `init-db/index.js` 已创建
- [ ] 超级管理员账号已通过 init-db 创建（使用真实 openid）

### 4. 客户端代码修改
- [ ] `miniprogram/app.js` 中 `syncAccessContext()` 已改为调用云函数 auth
- [ ] `miniprogram/app.js` 中 `setCurrentUser()` 已改为使用云函数验证
- [ ] 移除演示用户 ID 初始化（u-root, u-admin 等）
- [ ] 所有写操作前都添加了 token 验证
- [ ] 邀请码改为动态调用 `createInviteCode` 云函数获取

### 5. 移除演示快捷方式
搜索并确认以下代码已移除或禁用：

#### 5.1 硬编码用户 ID
```javascript
// ❌ 检查是否已移除（miniprogram/utils/mock-store.js 中的演示员工）
const state = {
  employees: [
    // { id: 'u-root', name: '我', role: 'superadmin', ... }  ← 应删除
    // { id: 'u-admin', name: '张主管', role: 'admin', ... }  ← 应删除
  ]
}
```
- [ ] 已确认无页面代码直接调用 'u-root' 或 'u-admin'
- [ ] 若 mock-store 保留用于开发，已添加条件编译标记或文件头注释

#### 5.2 固定邀请码
```javascript
// ❌ 原代码
const SYSTEM_JOIN_INVITE_CODE = 'JOIN-20260516'

// ✅ 应改为
async function getInviteCode() {
  return wx.cloud.callFunction({ 
    name: 'auth', 
    data: { action: 'createInviteCode', token } 
  })
}
```
- [ ] 搜索结果确认 `JOIN-20260516` 仅存在于 mock-store（非业务代码）

#### 5.3 会话存储直接操作
```javascript
// ❌ 开发者快捷方式（应移除）
wx.setStorageSync('sessionUserId', 'u-root')

// ✅ 仅保留在 app.js 的受控鉴权流程中
syncAccessContext() { 
  // ... 通过云函数验证后才 setStorageSync
}
```
- [ ] 搜索确认无页面代码直接调用 `wx.setStorageSync('sessionUserId', ...)`
- [ ] 仅 app.js 可在 syncAccessContext 中设置

#### 5.4 Console 调试输出
```javascript
// ⚠️ 保留必要的错误日志，移除开发调试日志
console.log('[DEBUG] ...') // ❌ 移除
console.error('[ERROR] ...') // ✅ 保留
```
- [ ] 运行 `node scripts/pre-release-check.js`，检查 console 调用是否过多

### 6. 权限与审计
- [ ] 所有写操作都记录了审计日志（action, operator, timestamp）
- [ ] 权限检查在后端进行，前端仅显示 UI
- [ ] 邀请码生成和使用都有记录
- [ ] 员工状态变更（申请→待审→激活）有日志
- [ ] 工单修改（创建、流转、撤回）有日志

### 7. 安全检查
- [ ] 数据库集合设置了访问权限（仅云函数可写，客户端不可直接操作）
- [ ] API 请求都带有 token 校验
- [ ] 表单输入都经过类型与范围校验（防止 NoSQL 注入）
- [ ] 敏感操作（如权限提升）需要额外确认
- [ ] 所有认证信息（token/openid）都通过 HTTPS 传输

### 8. 文档与工具
- [ ] `PRODUCTION.md` 已编写（完整上线指南）
- [ ] `DEPLOY.md` 已更新或保留用于参考
- [ ] 初始化脚本 `init-db/index.js` 已测试
- [ ] 预发布检查脚本 `scripts/pre-release-check.js` 已创建并测试
- [ ] 版本号已更新（package.json 或 app.json）

---

## 🧪 测试覆盖率

### 鉴权与会话
- [ ] 新设备首次打开 → 显示 guest，能看到申请入口
- [ ] 扫码申请 → 显示 pending，无法访问内部页面
- [ ] 管理员审批 → 状态变为 active，可正常使用
- [ ] 登出后重启 → 需重新授权
- [ ] Token 过期 → 自动跳转到重新授权
- [ ] 离线时 → 使用本地缓存（如有实现）

### 权限隔离
- [ ] worker 无法创建工单
- [ ] worker 无法管理其他员工
- [ ] admin 无法提升其他 admin 为 superadmin
- [ ] superadmin 可做所有操作
- [ ] 权限检查在后端进行（即使前端作弊也无效）

### 数据一致性
- [ ] 创建工单 → 审计日志记录
- [ ] 完成工序 → 库存自动扣减，记录日志
- [ ] 撤回工序 → 库存自动回退
- [ ] 导出工单 → 数据完整、格式正确
- [ ] 并发操作 → 无数据竞争

### 性能
- [ ] 列表翻页 → 加载时间 < 2s
- [ ] 批量导出 → < 10s
- [ ] 复杂查询（如按日期范围导出） → < 5s
- [ ] 高并发下（如 10 用户同时完成工序） → 无超时

---

## 📋 代码审查检查表

- [ ] 所有新增文件已添加到版本控制
- [ ] Git commit 消息清晰、遵循规范
- [ ] 代码风格一致（缩进、命名、格式）
- [ ] 无硬编码的密钥或敏感信息
- [ ] 无大量注释掉的代码（若有应删除）
- [ ] 所有依赖已明确列出（package.json）
- [ ] 无循环依赖或不必要的模块引入

---

## 🚀 部署前最终检查

```bash
# 1️⃣  运行预发布检查
node scripts/pre-release-check.js
# 预期结果：无 ❌ 错误

# 2️⃣  在微信开发者工具中完整测试
# - 新设备申请流程
# - 管理员审批流程
# - 工单创建与流转
# - 库存入出库
# - 权限检查

# 3️⃣  检查 Git 状态
git status  # 无未提交更改
git log -1  # 查看最近提交信息

# 4️⃣  标记版本
git tag -a v1.0.0 -m "Production Release v1.0.0"

# 5️⃣  在微信小程序后台上传新版本
# - 在微信管理后台上传代码
# - 填写版本说明
# - 选择自动发布或待审批发布
```

---

## 📞 发布经理检查

- [ ] 有紧急回滚方案（保持前一版本体验版）
- [ ] 监控告警已配置（云函数错误率、响应时间等）
- [ ] 客户支持团队已告知关键变更
- [ ] 用户反馈渠道已打开（如反馈表单、客服群）

---

## 签名确认

| 角色 | 签名 | 日期 | 备注 |
|-----|------|------|------|
| 开发人员 | _____ | ____ | 代码完成与测试 |
| 测试人员 | _____ | ____ | 功能与性能测试 |
| 产品经理 | _____ | ____ | 需求符合性确认 |
| 技术负责人 | _____ | ____ | 安全与架构审查 |
| 发布经理 | _____ | ____ | 最终发布批准 |

---

**检查清单版本**：v1.0.0
**最后更新**：2026-05-20
**下一次发布计划**：[填写日期]
