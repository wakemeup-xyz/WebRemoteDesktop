# 重启后自动恢复设计

日期：2026-10-26（Asia/Shanghai）。用户已授权开发和测试；本轮不启动、重启服务或 tunnel，不重启电脑。

## 问题与证据

本次开机 04:43:47，04:52 检查本机 8080 connection refused，正式入口 `/` 和 `/health` 均 HTTP 530 / 1033。Host、awake、fixed-watch 的持久 LaunchAgent 自动加载，但 Host 停在等待 Signal。Signal helper 用 TemporaryDirectory 中的 plist bootstrap，正式 tunnel 用 launchctl submit；二者没有用户 LaunchAgents 中的持久配置。旧 Host 日志早于本次开机，不作为本次运行证据。

## 方案比较与选择

1. **持久用户 LaunchAgent（采用）**：补齐 Signal 和正式 named tunnel，自启与现有 Host/awake/watch 同属 GUI 用户会话；保留屏幕采集权限和既有运维边界。
2. 系统 LaunchDaemon：登录前可提供网络进程，但不能代替图形会话和屏幕权限，会引入 root 与多 owner，超出本次需要。
3. cron / 登录 shell / 手工重跑启动脚本：无法可靠覆盖崩溃恢复、无交互登录环境和精确进程归属，不采用。

## 契约

- 保证边界为该 macOS 用户**登录后**自动恢复。FileVault 解锁前、登录前和手工锁定会话不承诺远程解锁；重启前内存中的 Terminal 会话不恢复。
- Signal 与正式 tunnel 配置持久安装到 `~/Library/LaunchAgents/`，RunAtLoad=true、KeepAlive=true、ThrottleInterval=10；Signal 保留 ProcessType=Interactive。
- plist 使用字面参数数组、绝对路径，不依赖登录 shell rc，不嵌入密码、token、credentials 正文。named tunnel 继续使用本机 config 的 credentials-file，协议仅 http2/quic；wrapper 清除继承的 tunnel token。
- launchd KeepAlive 负责登录/进程退出后的恢复，按 10 秒节流；存活 connector 的持续健康失败仍只由原 watcher 按 180 秒、每小时最多 2 次的既有预算处理，不新增健康重启循环。
- Host 保留原有健康检查→认证预检→启动顺序。Signal 和 Host 只访问本机 8080，健康检查绕过环境代理并有超时。
- 提供统一只读检查及**只安装配置**命令。安装不 bootstrap、kickstart、enable、停止或启动服务；清楚报告安装与当前运行状态不是同一个结论。
- 配置替换原子完成；所有输入先验证，写入失败恢复此前配置；拒绝符号链接目标。运行替换先做唯一 bootstrap probe，实际注册失败恢复旧配置/旧 job，失败不能报成功。只有本项目精确 label 受管理，非本项目或无法确认归属的运行进程拒绝接管。
- 正式 start/restart/watch 共用持久配置路径，避免后续维护又退回临时 submit。普通本地 restart 不管理正式或 quick tunnel。
- quick tunnel 不安装自启，不读取或改写其 URL/PID，不恢复旧 token daemon，不改 StockHub 等其他项目。
- `start-fixed-domain.sh` 去掉全局 pkill/nohup/临时 submit，复用本地 helper 与正式 connector 的显式维护入口；该脚本仍需要 tunnel 操作授权。
- 全量正式启动在触碰本地服务前完成 formal 参数/config/credential、token/owner 及 bootstrap 能力预检。local 失败不触碰正式 connector；formal 注册/enable/kickstart 失败只回滚自身，保留已恢复的本地服务并报告部分失败。注册成功但公网健康未达标时保留已启动的 connector 并返回失败，不为健康探测再次 bounce，后续继续由既有 watcher 观察。

## 安装与验收

统一入口 `scripts/install-reboot-autostart.py` 默认只读 `--check`，`--install` 只写五个项目任务的持久配置；Host/awake/watch 复用现有模板并绑定当前仓库绝对路径。现有 disabled 状态单独读取报告，安装不声称已启用或运行。

运行激活属于下一阶段：本地 helper 重载 Signal/Host；显式正式 tunnel 操作加载 named connector；需要时启用相应用户任务。不得以本轮开发测试代替该阶段授权。

离线测试必须覆盖临时 HOME 中真实 plist 读写、第二次安装幂等、删除临时运行目录仍保留配置、特殊路径不执行 shell、安装失败回滚、注册失败恢复、token/multiple-owner拒绝、quick canary不变及开机无 `/tmp` 状态依赖。测试使用 fake launchctl/cloudflared 或 mock，禁止连接生产服务、创建 Viewer 或发送输入。

真实重启、正式公网画面和真实输入均保留 NOT RUN；只有后续实际激活并验收后才能报告自动恢复已在本机生效。
