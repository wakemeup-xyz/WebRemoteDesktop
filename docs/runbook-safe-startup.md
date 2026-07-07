# Safe Startup Runbook

本手册用于在 **不影响** `/Users/macstudio1/AI/Claude/StockHub` 的前提下，启动、查看、停止当前仓库 `WebRemoteDesktop` 的完整本地服务链路。

## 启动方式总览

当前仓库推荐按下面优先级选择启动方式：

1. **默认推荐：安全一键启动**：`./scripts/start-safe-wrd.sh`
2. **手动本地启动**：`signal-server` + `./scripts/restart-host.sh`
3. **固定域名启动**：`./scripts/start-fixed-domain.sh`

区别如下：

- `start-safe-wrd.sh`：适合需要本地服务 + trycloudflare 临时公网地址，且不想影响其他仓库进程；若 tunnel 已在运行，后续重启本地服务会复用它，地址默认不变
- 手动本地启动：适合只做本机调试，不需要公网地址；但仍会通过 LaunchAgent 托管 Host
- `start-fixed-domain.sh`：适合已经配置好 Cloudflare 命名隧道，需要长期固定域名

Host 启动语义：

- `./scripts/restart-host.sh` 和 `./scripts/start-safe-wrd.sh` 都会安装并启用 `com.webremotedesktop.host` LaunchAgent
- LaunchAgent 先运行 `scripts/run-host-launchctl.sh`
- wrapper 会先等待 `signal-server /health` 成功，再预检 `HOST_SHARED_SECRET` 对 `/api/auth/login/host` 的认证成功，最后才 `exec python-host/host.py`
- 因此前置条件未满足时，常驻的是 shell wrapper，不会再反复拉起 `host.py` 和 `overlay_window.py`

Tunnel 操作语义：

- 默认不要重启 `trycloudflare` / `scripts/run-safe-quicktunnel.sh` / 对应 `cloudflared` 进程
- 若只是重启本地 `signal-server` 或 `python-host`，必须优先复用现有 tunnel
- 当前有效公网地址始终以 `/tmp/wrd-safe-current-url.txt` 为准
- `重启服务` 不得被解释为重建 quick tunnel；在 tunnel 仍存活时，重启本地服务不应改变 `/tmp/wrd-safe-current-url.txt`
- 只有在用户明确要求“重建 tunnel / 重建 Cloudflare / 重启 tunnel / 重新生成公网地址”时，才允许重建 quick tunnel；tunnel 失效本身不是授权

## 目标

- 只操作当前仓库自己的 `signal-server`、`python-host`、safe quick tunnel
- 不扫描、不清理、不复用 `StockHub` 的服务进程
- 通过独立的 safe PID / URL / LOG 文件管理当前仓库的公网临时入口

## 推荐命令

### 0. 手动本地启动（不走公网）

如果只需要本机访问，不需要 quick tunnel，可使用两个终端分别启动：

```bash
# 终端 1
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
npm start

# 终端 2
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/restart-host.sh
```

手动启动后可直接访问：

- 本地页面：`http://127.0.0.1:8080`
- 健康检查：`http://127.0.0.1:8080/health`
- Host 状态：`http://127.0.0.1:8080/api/status`

说明：

- 前端页面由 `signal-server` 托管，**不要**额外启动 `web-client` 开发服务器
- 当前仓库唯一正确本地入口是 `http://127.0.0.1:8080`
- **不要打开** `http://127.0.0.1:5173`；那通常是本机其他项目的 Vite 页面，不属于当前远程桌面
- 重启 Host 时必须使用 `./scripts/restart-host.sh`，不要手工 `kill` 后重启
- `./scripts/restart-host.sh` 的重启动作是重新注册并 kickstart `com.webremotedesktop.host`，这是预期行为

### 1. 一键安全启动

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-safe-wrd.sh
```

该命令会按顺序：

1. 复用或启动当前仓库的 `signal-server/server.js`
2. 等待 `http://127.0.0.1:8080/health` 正常
3. 通过 `launchctl` 复用或启动当前仓库的 `com.webremotedesktop.host`
4. 在 `scripts/run-host-launchctl.sh` 内等待 `/health` 与 `/api/auth/login/host` 预检都通过
5. 等待 `http://127.0.0.1:8080/api/status` 返回 `hostOnline: true`
6. 复用或启动 `scripts/run-safe-quicktunnel.sh`
7. 只有在该 URL 通过本机 `curl -I -L` reachability 校验后，才把它写入 `/tmp/wrd-safe-current-url.txt` 并输出

重启约定：

- 若只是重启 `signal-server` 或 `python-host`，默认**不停止**现有 safe quick tunnel
- 只要 `/tmp/wrd-safe-quicktunnel.pid` 对应进程仍存活，公网地址默认沿用，不需要重新通知一个新地址
- 只有在用户明确要求执行 `./scripts/stop-safe-wrd.sh`、明确要求重建 quick tunnel，或切换到固定域名方案时，外部地址才允许变化
- 若 signal-server 尚未就绪或 Host 凭据校验失败，Host LaunchAgent 会停留在 wrapper 等待阶段，而不是反复失败重启
- 若当前 quick tunnel 仍存活，排障时不要为了“保险”主动重启它；先检查本地 `8080`、`/api/status` 和 URL 文件
- 若当前访问入口是 trycloudflare / 其他公网域名，且 TURN 未配置，Viewer 仍会先按所选网络模式尝试直连 / STUN；是否进入 `隧道中继` 取决于后续连接结果，而不是入口 URL 本身
- 若当前 quick tunnel 进程仍在，但 safe URL 已经不可解析或 `curl -I -L` 失败，只能报告“当前公网入口失效/不可达”；不得自行调用会重建 tunnel 的脚本
- 每次启动或重启本地服务后，都要从本机运行配置读取并回报两项密码：Viewer 网页登录密码 `VIEWER_ACCESS_PASSWORD`，Terminal admin 密码 `WRD_TERMINAL_ADMIN_PASSWORD`

启动成功后，优先读取：

```bash
cat /tmp/wrd-safe-current-url.txt
```

该地址是当前仓库自己的临时公网入口。

但要注意：**地址文件里有 URL，不代表公网已经可用**。对外发送前，至少再做下面 3 步校验：

1. `./scripts/status-safe-wrd.sh` 确认 `safe quick tunnel` 为 `running`
2. 确认该 trycloudflare 子域名已经可以解析
3. `curl -I -L <safe-url>` 能拿到 HTTP 响应
4. `scripts/run-safe-quicktunnel.sh` 现在不会在 reachability 失败时发布 URL；如果文件里已经有 URL，就表示脚本至少已经通过了一次本机 reachability 校验
5. 若这台机器自己的系统 DNS 解析不到 `*.trycloudflare.com`，脚本会改用公共 DNS 解析并通过 `curl --resolve` 继续做入口校验，避免把 resolver 问题误判成 tunnel 故障

进一步约束：

1. 若 `curl -I -L <safe-url>` 返回 `Could not resolve host`，说明当前地址连 DNS 都不可用了，只能报告并等待用户明确是否重建 tunnel
2. 若 DNS 已恢复，但 `curl -I -L <safe-url>` 返回 `HTTP 530`、长时间超时，或没有拿到正常入口页，也应视为当前地址不可用，只能报告并等待用户明确授权
3. 不要把“quick tunnel 进程仍在”误判成“公网地址仍可访问”；公网可达性的最终依据始终是 `curl -I -L`
4. 对本仓库来说，`HTTP 530` 和 `Could not resolve host` 都按“当前 trycloudflare 入口不可交付”处理；这一步先归类为 tunnel 侧故障，不要误判成 `signal-server` 或 Host 崩了，也不要自动重建 tunnel
5. 如果只有本机默认 resolver 报 `Could not resolve host`，但公共 DNS 能解析且 `curl --resolve` 返回正常 HTTP，这应归类为本机 DNS 问题，不应让 `run-safe-quicktunnel.sh` 退出并清掉当前 tunnel

如果是在短生命周期的自动化执行环境中启动（例如一次性 shell 命令执行器），`nohup` / `disown` 拉起的后台进程可能在父 shell 结束后被回收。此时应改为在用户自己的常驻终端里执行，或单独保持 `./scripts/run-safe-quicktunnel.sh` 持续运行。

建议的最小交付检查：

```bash
./scripts/status-safe-wrd.sh
SAFE_URL=$(cat /tmp/wrd-safe-current-url.txt)
curl -I -L "$SAFE_URL"
```

### 2. 查看安全链路状态

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/status-safe-wrd.sh
```

会输出：

- safe signal-server PID 状态
- safe host PID 状态
- safe tunnel supervisor PID 状态
- safe quick tunnel PID 状态
- safe URL 文件状态
- 本地 `8080` 健康检查结果
- 本地 `api/status` 返回内容

### 3. 一键安全停止

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/stop-safe-wrd.sh
```

该命令只会读取并停止这些安全状态文件记录的 PID：

- `/tmp/wrd-safe-signal.pid`
- `/tmp/wrd-safe-host.pid`
- `/tmp/wrd-safe-tunnel-supervisor.pid`
- `/tmp/wrd-safe-quicktunnel.pid`

同时删除：

- `/tmp/wrd-safe-current-url.txt`

执行该命令后，safe quick tunnel 也会被停止；下一次再启动若重新创建 tunnel，trycloudflare 地址可能变化。

### 4. 固定域名启动

如果你已经完成 Cloudflare 命名隧道配置，可以使用：

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-fixed-domain.sh
```

前提条件：

- 已执行过 `scripts/setup-cloudflare.sh`
- 本机存在 `~/.cloudflared/config.yml`
- 已创建 `wrd-tunnel` 命名隧道

如本地服务不是默认 `8080`，可在执行前覆盖：

```bash
LOCAL_PORT=9000 ./scripts/setup-cloudflare.sh
LOCAL_PORT=9000 ./scripts/start-fixed-domain.sh
```

启动成功后，固定入口默认为：`https://link.stockhub.wiki`

## 关键文件

### Safe 状态文件

- `signal-server PID`: `/tmp/wrd-safe-signal.pid`
- `host PID`: `/tmp/wrd-safe-host.pid`
- `tunnel supervisor PID`: `/tmp/wrd-safe-tunnel-supervisor.pid`
- `quick tunnel PID`: `/tmp/wrd-safe-quicktunnel.pid`
- `safe URL`: `/tmp/wrd-safe-current-url.txt`

### Safe 日志文件

- `safe quick tunnel log`: `/tmp/wrd-safe-quicktunnel.log`
- `safe tunnel supervisor log`: `/tmp/wrd-safe-tunnel-supervisor.log`
- `signal-server log`: `/tmp/signal-server.log`
- `host log`: `back-debug.log`

## 排障顺序

### 场景 1：启动后打不开网页

按下面顺序检查：

1. `./scripts/status-safe-wrd.sh`
2. 先确认自己访问的是 `http://127.0.0.1:8080`，不是 `5173`
3. `curl http://127.0.0.1:8080/health`
4. `curl http://127.0.0.1:8080/api/status`
5. `cat /tmp/wrd-safe-current-url.txt`
6. `tail -100 /tmp/wrd-safe-quicktunnel.log`

判断方法：

- 如果打开的是 `5173` 页面：这是错误入口，切回 `8080` 或 safe URL
- 如果 `health` 不通：优先看 `signal-server`
- 如果 `health` 通但 `hostOnline` 为 `false`：优先看 `back-debug.log`
- 如果 `back-debug.log` 只看到 `Signal server healthy: ...` 但没有 `Host auth preflight succeeded: ...`：优先检查 `HOST_SHARED_SECRET`
- 如果本地都通但公网不通：优先看 safe quick tunnel 日志
- 如果本地都通、DNS 也能解析，但 `curl -I -L` 返回 `HTTP 530`：按“公网入口失效”处理，报告原因并等待用户明确是否重建 tunnel，不要先重启本地 `signal-server` 或 Host
- 如果本地都通、DNS 直接不解析：这同样不是 origin 故障，优先按 quick tunnel 地址失效处理，但不得自动重建 tunnel
- 如果只是本地服务异常，但 `/tmp/wrd-safe-current-url.txt` 仍指向现有 tunnel：只修本地服务，不得重建 tunnel
- 如果 URL 文件里已经有 trycloudflare 地址，但状态脚本显示 `safe quick tunnel: stale`：说明地址文件已经写出，但实际公网进程没有存活，不能把这个链接当作有效入口
- 如果状态脚本把原本 stale 的 PID 自动纠正为 live PID，会显示 `running pid=... (reconciled)`

补充排查：

- 如果本地 `health` 正常，但浏览器页面显示“等待 Host 上线”，说明 `signal-server` 正常、`python-host` 尚未成功回连
- 如果 `restart-host.sh` 执行后很快退出，优先查看 `back-debug.log`
- 如果 fixed domain 不可用，先确认本地 `8080` 正常，再检查 `~/.cloudflared/config.yml` 和隧道配置
- Web Terminal 走的是 Viewer 内部的 Socket.IO 二次授权，不会重启 quick tunnel，也不会占用 WebRTC 媒体链路

### 场景 1b：网页可打开，但远程桌面媒体连接失败

网页入口、登录、Socket.IO 信令和诊断上报可以通过 quick tunnel 正常工作，但这不代表 WebRTC 媒体路径可达。`auto` / `stun` 模式默认遵守 Strict STUN：

- 先尝试 WebRTC direct ICE，允许 `host` / `srflx` / `prflx`
- 媒体链路恶化时自动降载：720p/20fps → 540p/15fps → 480p/12fps → 360p/8fps
- 降载仍失败时主动尝试一次 ICE restart
- 恢复预算耗尽后明确失败并自动上传诊断
- 不自动切 TURN，不自动走 Cloudflare/Socket.IO 媒体 tunnel

排查顺序：

1. 查看 Host 日志里的 `VIEWER_STATS`、`WRD_MEDIA_PROFILE`、`WRD_STUN_FAILURE`
2. 如果出现 `WRD_MEDIA_PROFILE`，说明 Viewer 已检测到弱链路并尝试降载
3. 如果最终出现 `strict-stun-exhausted`，优先判断公司网 UDP/NAT、家庭路由器 NAT、IPv6、防火墙，而不是重启 quick tunnel
4. quick tunnel 的 `curl -I -L` 只能证明网页入口可达，不能证明媒体直连可达

家庭路由器端口转发只有在 Host 侧 WebRTC UDP 端口范围可控时才有稳定意义。当前 aiortc/aioice 默认随机绑定本地 UDP 端口，因此不要把 TP-LINK “虚拟服务器”里配置单个端口当作已解决 Strict STUN 可达性问题。

### 场景 2：Cloudflare 地址失效

如果日志出现 `Unauthorized: Tunnel not found`，说明当前 quick tunnel 很可能已经在 Cloudflare 侧失效。Agent 只能报告该结论；除非用户明确要求重建 tunnel，否则不得自动重建或刷新：

- `/tmp/wrd-safe-current-url.txt`

手动确认：

```bash
cat /tmp/wrd-safe-current-url.txt
tail -100 /tmp/wrd-safe-quicktunnel.log
```

如果日志中已经打印出 `Your quick Tunnel has been created`，但从外部仍无法访问，再继续区分两类情况：

- 进程还活着，但域名暂时无法解析：优先等待几秒到几十秒，并重复 DNS / `curl` 验证
- 进程已经退出：报告状态，等待用户明确是否在常驻终端执行 `./scripts/run-safe-quicktunnel.sh`

补充说明：

- 现在脚本不会在“只拿到 URL 但还没验通”的阶段更新 `/tmp/wrd-safe-current-url.txt`
- 因此一旦地址文件变化，就意味着旧地址已经不应再继续对外使用；新的当前地址只认这个文件

### 场景 3：状态脚本显示 safe PID 文件缺失，但 8080 仍然正常

这通常表示：

- 当前本地 `signal-server` / `host` 是通过非 safe 脚本启动的
- 或 safe PID 文件被删掉了，但服务进程还在运行

这时不要直接全局清理；先确认当前服务是否是你想保留的，再决定是否用 safe 脚本重新接管。

### 场景 4：URL 已生成，但 trycloudflare 域名一直无法解析

这通常表示：

- Cloudflare quick tunnel 域名传播尚未完成
- 或当前 quick tunnel 进程已经退出，只留下旧的 URL 文件
- 或 tunnel 是在短生命周期自动化 shell 中启动，子进程被回收

按下面顺序处理：

1. `./scripts/status-safe-wrd.sh`
2. `tail -100 /tmp/wrd-safe-quicktunnel.log`
3. 确认本地源站仍正常：`curl http://127.0.0.1:8080/health`
4. 若 `safe quick tunnel` 非 `running`，报告状态，等待用户明确是否重新执行 `./scripts/run-safe-quicktunnel.sh`
5. 若 `safe quick tunnel` 为 `running` 但 DNS 仍长期不解析，改用固定域名方案 `./scripts/start-fixed-domain.sh`
6. 若公共 DNS 已能解析、而只有本机 resolver 长期不解析，应优先修本机 DNS；当前脚本已会在这类情况下保留 tunnel，不再把它误判成不可交付

## 明确边界

以下行为 **禁止默认执行**：

- 停止或重启 `/Users/macstudio1/AI/Claude/StockHub` 的服务
- 使用全局 `pkill` 扫描共享进程名
- 为了处理当前仓库问题，顺手重启 `StockHub` 的 Vite / 后端 / tunnel

当前仓库的安全脚本设计目标就是：**只影响当前仓库自己记录过的服务**。

## Web Terminal 约束

- Terminal 只在 Viewer 里开启，前提是先完成 Viewer 登录，再做 admin 二次授权
- Terminal 是所有 admin 已授权用户共用的 shared shell session pool，而不是单浏览器私有会话
- 多个浏览器可以同时附着到同一个共享 shell；输入是共享的，并会立即作用到同一个 PTY
- 关闭某个 Terminal 标签页或整个 Viewer 页面，只会断开该浏览器，不会 kill 底层 PTY；会话会保留到显式关闭或服务重启
- Viewer 的 `断开连接` 按钮以及网络模式切换只影响远程桌面链路，不会关闭 Terminal 会话
- `signal-server` / Host 重启通常会保留当前 tunnel 地址，但共享 Terminal 会话在内存中维护，因此会随服务重启结束
- Terminal 失败应直接报错并上送诊断日志，不要自动退回媒体 tunnel 或 TURN
- `http://localhost:5173/` 只作为前端开发映射时的 API 入口，不是当前仓库的正式页面入口
