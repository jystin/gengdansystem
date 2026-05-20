#!/usr/bin/env node
/**
 * 预发布检查脚本（Node.js）
 * 用途：检查代码中是否包含不适合生产环境的内容
 * 
 * 使用：
 *   node scripts/pre-release-check.js
 * 
 * 如果发现问题，脚本会输出警告并返回非 0 退出码
 */

const fs = require('fs')
const path = require('path')

const MINIPROGRAM_DIR = path.join(__dirname, '..', 'miniprogram')
const CHECKS = []
let WARNINGS = 0
let ERRORS = 0

/**
 * 记录一个检查项
 */
function check(name, fn) {
  CHECKS.push({ name, fn })
}

/**
 * 执行所有检查
 */
async function runChecks() {
  console.log('\n📋 开始进行预发布检查...\n')

  for (const { name, fn } of CHECKS) {
    try {
      const result = await fn()
      if (result.success) {
        console.log(`✅ ${name}`)
      } else {
        if (result.severity === 'error') {
          ERRORS++
          console.log(`❌ ${name}\n   ${result.message}`)
        } else {
          WARNINGS++
          console.log(`⚠️  ${name}\n   ${result.message}`)
        }
      }
    } catch (err) {
      ERRORS++
      console.log(`❌ ${name}\n   异常: ${err.message}`)
    }
  }

  console.log(`\n检查完成: ${ERRORS} 个错误, ${WARNINGS} 个警告\n`)

  if (ERRORS > 0) {
    console.log('❌ 存在严重问题，请在发布前修复')
    process.exit(1)
  } else if (WARNINGS > 0) {
    console.log('⚠️  存在警告，请在发布前审视')
    process.exit(0)
  } else {
    console.log('✅ 所有检查通过，可以发布')
    process.exit(0)
  }
}

/**
 * 在文件中搜索关键字
 */
function searchInFile(filePath, patterns) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const matches = []
    
    for (const pattern of patterns) {
      const regex = typeof pattern === 'string' ? new RegExp(pattern, 'gi') : pattern
      let match
      while ((match = regex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length
        matches.push({ pattern: pattern.toString(), lineNum, text: match[0] })
      }
    }
    
    return matches
  } catch (err) {
    return []
  }
}

/**
 * 递归搜索目录
 */
function findFiles(dir, ext) {
  let files = []
  try {
    const items = fs.readdirSync(dir)
    for (const item of items) {
      if (item.startsWith('.')) continue
      const fullPath = path.join(dir, item)
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        files = files.concat(findFiles(fullPath, ext))
      } else if (fullPath.endsWith(ext)) {
        files.push(fullPath)
      }
    }
  } catch (err) {}
  return files
}

// ========== 检查项定义 ==========

check('不检查: 演示用户 ID (u-root/u-admin) 仅在 mock-store 中', async () => {
  const mockStoreFile = path.join(MINIPROGRAM_DIR, 'utils', 'mock-store.js')
  const matches = searchInFile(mockStoreFile, ['u-root', 'u-admin'])
  
  // 这些在 mock-store 中是允许的，只要它们不在其他地方被硬编码调用
  const problematicFiles = []
  
  const jsFiles = findFiles(MINIPROGRAM_DIR, '.js')
    .filter(f => !f.includes('mock-store.js'))
    .filter(f => !f.includes('node_modules'))
  
  for (const file of jsFiles) {
    const fileMatches = searchInFile(file, ['u-root', 'u-admin'])
    if (fileMatches.length > 0) {
      problematicFiles.push({ file, matches: fileMatches })
    }
  }
  
  if (problematicFiles.length > 0) {
    return {
      success: false,
      severity: 'error',
      message: `发现在页面代码中硬编码使用 'u-root' 或 'u-admin' (非 mock-store):\n${
        problematicFiles.map(p => `  - ${p.file}:${p.matches[0].lineNum}`).join('\n')
      }`
    }
  }
  
  return { success: true }
})

check('检查: 固定邀请码 (JOIN-20260516)', async () => {
  const patterns = ['JOIN-20260516', 'SYSTEM_JOIN_INVITE_CODE']
  const jsFiles = findFiles(MINIPROGRAM_DIR, '.js')
  
  const problematicFiles = []
  for (const file of jsFiles) {
    const matches = searchInFile(file, patterns)
    if (matches.length > 0 && !file.includes('mock-store.js')) {
      problematicFiles.push({ file, count: matches.length })
    }
  }
  
  if (problematicFiles.length > 0) {
    return {
      success: false,
      severity: 'warning',
      message: `发现在非 mock-store 文件中引用固定邀请码（应在生产环境中动态生成）:\n${
        problematicFiles.map(p => `  - ${p.file}`).join('\n')
      }\n  建议：使用云函数动态生成并带有效期的邀请码`
    }
  }
  
  return { success: true }
})

check('检查: sessionUserId 存储写入位置', async () => {
  const patterns = [/wx\.setStorageSync\s*\(\s*['"]sessionUserId['"]/, /wx\.removeStorageSync\s*\(\s*['"]sessionUserId['"]/]
  const jsFiles = findFiles(MINIPROGRAM_DIR, '.js')
  
  const problematicFiles = []
  for (const file of jsFiles) {
    const matches = searchInFile(file, patterns)
    if (matches.length > 0) {
      problematicFiles.push({ file, matches: matches.slice(0, 1) })
    }
  }
  
  // app.js 中允许，但其他地方要谨慎
  const nonAppProblems = problematicFiles.filter(p => !p.file.includes('app.js'))
  
  if (nonAppProblems.length > 0) {
    return {
      success: false,
      severity: 'warning',
      message: `页面代码中直接写入 sessionUserId storage（应仅在 app.js 中受控地进行）:\n${
        nonAppProblems.map(p => `  - ${p.file}:${p.matches[0].lineNum}`).join('\n')
      }`
    }
  }
  
  return { success: true }
})

check('检查: console.log 调试输出', async () => {
  const patterns = [/console\s*\.\s*(log|warn|error|debug|info)/]
  const jsFiles = findFiles(MINIPROGRAM_DIR, '.js')
    .filter(f => !f.includes('node_modules'))
  
  const files = jsFiles
    .map(file => ({
      file,
      matches: searchInFile(file, patterns)
    }))
    .filter(f => f.matches.length > 3) // 允许少量 console 调用
  
  if (files.length > 0) {
    return {
      success: false,
      severity: 'warning',
      message: `发现过多的 console 调用（应在生产环境中移除）:\n${
        files.map(f => `  - ${f.file} (${f.matches.length} 处)`).join('\n')
      }\n  建议：使用生产环境构建工具自动移除或使用条件编译`
    }
  }
  
  return { success: true }
})

check('检查: 项目配置文件中是否有开发环境配置', async () => {
  const configFile = path.join(__dirname, '..', 'project.config.json')
  
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    
    // 检查是否为开发配置
    const isDev = config.appid && config.appid.includes('test')
    if (isDev) {
      return {
        success: false,
        severity: 'error',
        message: `项目使用了测试 AppID: ${config.appid}\n  生产环境必须更新为真实的小程序 AppID`
      }
    }
    
    return { success: true }
  } catch (err) {
    return { success: false, severity: 'warning', message: `无法读取 project.config.json: ${err.message}` }
  }
})

check('检查: 是否存在云函数授权配置', async () => {
  const authFunctionFile = path.join(__dirname, '..', 'cloudfunctions', 'auth', 'index.js')
  
  if (!fs.existsSync(authFunctionFile)) {
    return {
      success: false,
      severity: 'warning',
      message: '未找到生产环境授权云函数 (cloudfunctions/auth/index.js)\n  建议：在云环境中部署授权云函数并配置好数据库'
    }
  }
  
  return { success: true }
})

check('检查: 是否有 .gitignore 文件', async () => {
  const gitignoreFile = path.join(__dirname, '..', '.gitignore')
  
  if (!fs.existsSync(gitignoreFile)) {
    return {
      success: false,
      severity: 'warning',
      message: '缺少 .gitignore 文件，敏感信息可能被上传\n  建议：添加 .gitignore 并排除 node_modules、临时文件等'
    }
  }
  
  try {
    const content = fs.readFileSync(gitignoreFile, 'utf8')
    if (!content.includes('node_modules') && !content.includes('.env')) {
      return {
        success: false,
        severity: 'warning',
        message: '.gitignore 文件不完整，缺少常见的忽略规则'
      }
    }
  } catch (err) {}
  
  return { success: true }
})

check('检查: 是否有 README/文档', async () => {
  const readmeFile = path.join(__dirname, '..', 'README.md')
  const deployFile = path.join(__dirname, '..', 'DEPLOY.md')
  
  if (!fs.existsSync(readmeFile) && !fs.existsSync(deployFile)) {
    return {
      success: false,
      severity: 'warning',
      message: '缺少 README.md 或 DEPLOY.md 文档'
    }
  }
  
  return { success: true }
})

// ========== 执行 ==========

runChecks().catch(err => {
  console.error('检查过程出错:', err)
  process.exit(1)
})
