# Viewer Login Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 消除Viewer登录中的重复bcrypt主线程工作，精确认证完整密钥。
**Architecture:** 复用现有constantTimeSecretEqual，不新增认证缓存或worker。
**Tech Stack:** Node.js、Express、crypto、node:test。
**Spec:** `docs/superpowers/specs/2026-10-17-viewer-auth-blocking-design.md`

## Global Constraints

- 不运行npm test/pretest，不重建正在服务的dist，不安装依赖。
- 不修改凭据、限流、JWT、管理员/Host认证或tunnel；主仓HEAD/index和已有dirty保持。
- 实施者只写下列源码/测试，root管理部署和文档，独立review后才加载。

### Task 1: 精确密钥比较及路由回归

**Files:** Modify `signal-server/routes/auth.js`; test `signal-server/test/auth.test.js`（可新增专用auth regression文件）。
**Interfaces:** 输入现有Viewer请求与getConfig；输出原有HTTP响应/token，新增完整UTF-8匹配语义。

- [ ] 添加RED：两个密码 `"a".repeat(72)+"x"` 和 `"a".repeat(72)+"y"`，前者配置时后者必须401；完整前者200。添加多字节跨72byte、不trim、不normalize、无配置和既有真值String转换断言。
- [ ] 用固定Node运行定向文件，保留实际RED；测试只起临时loopback测试app，不连接生产8080，不导入server.js或build。
- [ ] 删除本文件bcrypt导入和verifyPassword，保持loginViewer流程，将valid逻辑改为 `typeof viewerAccessPassword === 'string' && viewerAccessPassword.length > 0 && constantTimeSecretEqual(password, viewerAccessPassword)`。保留缺输入先400和其他路由。
- [ ] 运行auth、terminal-auth、viewer-admission-api相关测试；检查限流共享/成功JWT有效；合成密码测量不接入生产，不断言绝对耗时。
- [ ] 只提交允许源码/测试；自审并交独立task review，root在review通过后处理部署。

### Task 2: Root部署与实际入口复核

- [ ] 冻结审查提交、核对主仓基线0ffb941及保留HEAD/index/四个watcher排除文件，独立增量review。
- [ ] fresh zeroViewer才同步并用service helper仅restart-signal；记录前后Host/tunnel身份、build和认证密码来源，回报运行凭据但不写版本文档。
- [ ] 检查health/Host恢复、正式登录页、真实授权登录及后续被动会话；不把页面或短测PASS写为三小时/原生输入PASS。
