微信小程序跟单系统 · 生产部署快速指南

📌 本文档快速总结如何从演示版本升级到生产环境

---

## 🎯 30 秒了解核心变更

| 演示版 | 生产版 | 原因 |
|------|------|-----|
| 本地 mock-store | 微信云开发 + 数据库 | 确保数据持久化与安全 |
| 固定邀请码 | 动态码 + 24h 过期 | 防止外泄与滥用 |
| 前端权限检查 | 后端 token 验证 | 防止作弊与权限逃逸 |
| sessionUserId 存储 | JWT + 云函数 | 实现真正的会话隔离 |

---

## ⚡ 部署快速步骤（预计 30 分钟）

### Step 1: 准备微信小程序账号 
```
1. 进入 https://mp.weixin.qq.com （微信公众平台）
2. 申请小程序（或获得现有账号权限）
3. 记录 AppID、AppSecret、服务器 IP 白名单

4. 在"开发"→"云开发"中创建云开发环境（或使用已有）
5. 记录 env ID （如 prod-1a2b3c）
```

### Step 2: 上传云函数
```
1. 在微信开发者工具中右键"cloudfunctions"文件夹
2. 选择"上传全部"
3. 等待 auth 和 init-db 函数部署完成
```

### Step 3: 初始化数据库
```
1. 在微信开发者工具中打开"云函数"控制台
2. 创建测试用例并调用 init-db 云函数：
   {
     "adminOpenid": "你本人的 openid"（可通过 wx.getUserInfo 获取）
   }
3. 查看返回结果，确认已创建超级管理员账号
```

### Step 4: 修改客户端代码
```
1. 编辑 miniprogram/app.js 中的 syncAccessContext()
   改为调用 wx.cloud.callFunction({ name: 'auth', ... })

2. 编辑 miniprogram/pages/join/index.js
   改为调用 getInviteCode() 获取动态邀请码

3. 提交代码到 release_0.1.0 分支
```

### Step 5: 完整测试
```
1. 在微信开发者工具中重新预览
2. 完整走通：申请 → 审批 → 使用

3. 检查是否有错误：运行 node scripts/pre-release-check.js
```

### Step 6: 提交发布
```
1. 在微信小程序后台上传新版本
2. 填写版本描述："完整生产版发布，使用云函数鉴权"
3. 选择发布方式（自动发布或待审批）
4. 点击提交审核
```

---

## 🔐 关键安全检查

```javascript
// ✅ 后端必须检查 token（以下为伪代码示例）
app.delete('/employee/:id', authenticateToken, authorizeAdmin, (req, res) => {
  // 1. authenticateToken 验证 token 有效性
  // 2. authorizeAdmin 检查用户权限
  // 3. 只有通过两项检查才删除数据
  // 4. 记录审计日志
  db.users.deleteById(req.params.id, { operator: req.user.id })
})

// ❌ 禁止这样做（直接信任前端）
app.delete('/employee/:id', (req, res) => {
  // 没有任何权限检查！容易被作弊
  db.users.deleteById(req.params.id)
})
```

---

## 📊 上线前必须完成的工作

| 项目 | 完成? |
|-----|------|
| AppID 更新到生产小程序 | ☐ |
| 云函数已部署 | ☐ |
| 数据库初始化完成 | ☐ |
| 超级管理员账号创建 | ☐ |
| 移除演示快捷方式 | ☐ |
| 运行预发布检查无 ❌ 错误 | ☐ |
| 完整功能测试通过 | ☐ |
| 版本号已更新 | ☐ |
| 提交 GitHub release/branch | ☐ |

---

## 🆘 常见问题

**Q: 如何获取 openid？**
```javascript
wx.getUserInfo({
  success(res) {
    console.log(res.userInfo)  // 包含 openid
  }
})
```

**Q: 如何调试云函数？**
```
1. 在云函数代码中添加 console.log
2. 提交后在微信开发者工具"云函数"中查看实时日志
3. 或在微信云开发后台查看函数日志
```

**Q: 如何回滚到演示版？**
```
1. 在微信小程序后台"版本管理"中找到上一个版本
2. 选择"灰度"→"回退版本"
3. 同时禁用云函数（以防数据混乱）
```

**Q: 生产环境需要什么配置？**
- ✅ SSL/HTTPS（微信要求）
- ✅ 数据库备份策略
- ✅ 监控告警（云函数错误率等）
- ✅ 审计日志保留期 >= 6 个月

---

## 📚 详细文档索引

| 文档 | 内容 | 适合人群 |
|-----|-----|--------|
| [PRODUCTION.md](./PRODUCTION.md) | 完整部署指南 + 架构设计 | 技术负责人、DevOps |
| [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) | 上线前检查清单 | 测试、发布经理 |
| [cloudfunctions/auth/index.js](./cloudfunctions/auth/index.js) | 授权云函数代码 | 后端开发人员 |
| [scripts/pre-release-check.js](./scripts/pre-release-check.js) | 自动检查工具 | 所有开发人员 |

---

**版本**：v1.0.0-production-ready
**最后更新**：2026-05-20
**下一步**：按照 PRODUCTION.md 进行完整部署
