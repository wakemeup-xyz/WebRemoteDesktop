# 重启恢复配置激活与接入验收

日期：2026-10-26，以下时间为 Asia/Shanghai。修复提交 `60d959b`；前一阶段的 [开发与离线验证](2026-10-26-reboot-autostart.md) 保留其当时的未激活状态。本报告记录随后实际启动与接入结果。

## 授权及实际操作

用户要求“启动服务，验收，合入main”，并另行明确选择启动正式命名隧道 `wrd-tunnel`、恢复固定域名及进行公网验收。

1. 按项目 helper 执行 `restart-local`，Signal 以持久 Interactive LaunchAgent 启动（PID 43588）。Host 仅通过既有 `restart-host.sh` 管理。
2. 正式只读预检通过后执行 `scripts/restart-fixed-domain-tunnel.sh`。注册持久 named connector，凭据仍来自本机 credentials-file。正式健康等待第 4 次探测成功，约 33.25 秒。
3. 五份持久配置匹配，五个用户任务 loaded/running=true、disabled=false，`health_ok=true`、`host_online=true`、`ready=true`。
4. quick tunnel 未启动、未停止、未重建；当前 safe URL 文件在操作前后均不存在。历史系统 token daemon 未启用，未操作其他项目。

没有执行电脑重启。用户登录后实际自动恢复的完整重启验收继续为 **NOT RUN**；本轮证明持久配置可以实际加载并提供接入，不能替代一次真实系统重启。

## 启动中的超时与观察

首次 `restart-local` 返回 1：Signal 已正常，但 Host 超过脚本等待时限。脚本输出的 `back-debug.log` 尾部来自 04:35，早于本次启动，不能用来判断新 Host 崩溃。

未重复重启。相同 Host PID 44251 自行于 05:31:18 上线；launch time 05:28:56.920，首个 Host 日志 05:31:11.055，连接成功 05:31:18.720，`Host running` 为 05:31:18.748，总计约 142 秒。健康与认证预检均已通过。

当时系统 load1 样本约 535–708。Host 的重依赖导入早于日志初始化，故依赖导入和系统调度缓慢是合理解释，但没有在该时间窗口采样到具体阻塞点，不能证明单一根因。上线后的 3 秒 sample 主线程正常等待 asyncio 事件，不支持“当前仍有导入或权限死锁”。本轮不放宽产品性能标准，也不修改等待时间掩盖超时。

## 正式入口及浏览器验收

使用 Chromium headless，TLS 校验开启，真实密码表单登录；没有自签 token，没有截图、原始 console 或原始键鼠/剪贴板记录。开始前没有其他 Viewer，控制请求不接管已有控制权。精确脚本与有界 JSON 见 [证据目录](evidence/2026-10-26-reboot-autostart-activation/) 和 [SHA256SUMS](evidence/2026-10-26-reboot-autostart-activation/SHA256SUMS)。

| 检查 | 结果与边界 |
| --- | --- |
| 正式 `/health`、`/api/status` | 浏览器请求均 200，Host 在线 |
| 登录页、Viewer HTML、当前 core | curl 均 200；HTML 含当前 build `c6915df5ba8c0c6f`；core 与本地资产 SHA-256 一致 |
| 真实 Viewer 密码登录 | 两个独立浏览器 context 均 POST `/api/auth/login` 200 |
| 自动模式直连 | host↔host / UDP，1152×720；计划 8 秒观察中 decoded 5→50、独立 rVFC 4→45、产品帧序 3→44、bytes 162434→400320；最后帧龄 43ms、非黑比例 1 |
| 实际 TURN 中继 | relay↔relay / UDP，1152×720；计划 8 秒观察中 decoded 1→36、独立 rVFC 1→30、产品帧序 1→30、bytes 84256→257881；最后帧龄 217ms、非黑比例 1 |
| 控制租约与复位 ACK | 两轮 ACTIVE、租约有效、输入 gate 允许；鼠标/键盘复位经产品校验为 applied，直连确认约 744/769ms，中继约 378/471ms。这是复位确认，不是实际点击/文本的可见效果或真实输入延迟分布 |
| 复位后状态 | relay 的 afterReset/postProbe 中 keyboard READY、pending=0、pressed keys/buttons=0、无 pendingMouseReset、recovery idle、无 blockedReasons |
| 临时 Terminal | 真实 admin 认证和 bootstrap 200；仅创建本次独立临时 session，观察随机 marker 的真实整行输出、input ACK、exit 与 closed；未读写其他共享会话 |
| 收尾 | Host 保持在线，Viewer/relayViewer 均回到 0；临时 Terminal session 已关闭 |

原先 exploratory urllib 客户端对 `/` 与 `/health` 返回 403，保留于 `entry-urllib-probe.json`；随后 canonical curl 和实际浏览器返回 200。没有定位该客户端差异的具体原因，不能据 urllib 失败认定全部入口不可用，也没有把该失败样本删除。

### 性能与未运行边界

两个样本中点击到产品 `first-frame` 标记分别为 18,894.8ms 和 5,710.4ms；该标记不是本脚本独立采集的精确首像素时刻。两个样本不能给出 P95，也没有完成需求中的 20-context 启动性能验收。首轮记录明显慢于 8 秒目标；持续出画成功不代表性能已全部达标。整个首轮 runner 167.803 秒包含启动浏览器、网络和关闭，不能当作媒体连接耗时。

本轮是同机通过正式域名的真实浏览器接入，并实际经过 TURN；异机/手机蜂窝网络、真实原生键鼠可见效果、长会话及电脑重启均为 **NOT RUN**。

## 合入与凭据

合入前工作区干净，`main=0f66413` 是修复提交的直接父节点；离线测试记录为 179 项通过，未因仅补运行证据重复执行相同离线测试。此次原目录 fast-forward 不改变任何已安装绝对路径。运行证据与文档提交后按用户授权合入本地 main，不推送远端。

Viewer 与 Terminal admin 密码只从本机运行配置读取，且分别通过真实认证验证；在对话中回报，不写入本报告或证据。
