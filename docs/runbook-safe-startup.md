# Safe Startup Runbook

本手册用于在 **不影响** `/Users/macstudio1/AI/Claude/StockHub` 的前提下，启动、查看、停止当前仓库 `WebRemoteDesktop` 的完整本地服务链路。

## 启动方式总览

当前仓库推荐按下面优先级选择启动方式：

1. **默认推荐：安全一键启动**：`./scripts/start-safe-wrd.sh`
2. **手动本地启动**：`signal-server` + `./scripts/restart-host.sh`
3. **固定域名启动**：`./scripts/start-fixed-domain.sh`

区别如下：

- `start-safe-wrd.sh`：适合需要本地服务 + trycloudflare 临时公网地址，且不想影响其他仓库进程
- 手动本地启动：适合只做本机调试，不需要公网地址
- `start-fixed-domain.sh`：适合已经配置好 Cloudflare 命名隧道，需要长期固定域名

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

### 1. 一键安全启动

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-safe-wrd.sh
```

该命令会按顺序：

1. 复用或启动当前仓库的 `signal-server/server.js`
2. 等待 `http://127.0.0.1:8080/health` 正常
3. 复用或启动当前仓库的 `python-host/host.py`
4. 等待 `http://127.0.0.1:8080/api/status` 返回 `hostOnline: true`
5. 复用或启动 `scripts/run-safe-quicktunnel.sh`
6. 输出 safe quick tunnel 地址

启动成功后，优先读取：

```bash
cat /tmp/wrd-safe-current-url.txt
```

该地址是当前仓库自己的临时公网入口。

但要注意：**地址文件里有 URL，不代表公网已经可用**。对外发送前，至少再做下面 3 步校验：

1. `./scripts/status-safe-wrd.sh` 确认 `safe quick tunnel` 为 `running`
2. 确认该 trycloudflare 子域名已经可以解析
3. `curl -I -L <safe-url>` 能拿到 HTTP 响应

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

启动成功后，固定入口默认为：`https://stockhub.wiki`

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
- 如果本地都通但公网不通：优先看 safe quick tunnel 日志
- 如果 URL 文件里已经有 trycloudflare 地址，但状态脚本显示 `safe quick tunnel: stale`：说明地址文件已经写出，但实际公网进程没有存活，不能把这个链接当作有效入口
- 如果状态脚本把原本 stale 的 PID 自动纠正为 live PID，会显示 `running pid=... (reconciled)`

补充排查：

- 如果本地 `health` 正常，但浏览器页面显示“等待 Host 上线”，说明 `signal-server` 正常、`python-host` 尚未成功回连
- 如果 `restart-host.sh` 执行后很快退出，优先查看 `back-debug.log`
- 如果 fixed domain 不可用，先确认本地 `8080` 正常，再检查 `~/.cloudflared/config.yml` 和隧道配置

### 场景 2：Cloudflare 地址失效

`scripts/run-safe-quicktunnel.sh` 会在日志出现 `Unauthorized: Tunnel not found` 时自动重建 quick tunnel 并刷新：

- `/tmp/wrd-safe-current-url.txt`

手动确认：

```bash
cat /tmp/wrd-safe-current-url.txt
tail -100 /tmp/wrd-safe-quicktunnel.log
```

如果日志中已经打印出 `Your quick Tunnel has been created`，但从外部仍无法访问，再继续区分两类情况：

- 进程还活着，但域名暂时无法解析：优先等待几秒到几十秒，并重复 DNS / `curl` 验证
- 进程已经退出：重新在常驻终端执行 `./scripts/run-safe-quicktunnel.sh`

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
4. 若 `safe quick tunnel` 非 `running`，在常驻终端重新执行 `./scripts/run-safe-quicktunnel.sh`
5. 若 `safe quick tunnel` 为 `running` 但 DNS 仍长期不解析，改用固定域名方案 `./scripts/start-fixed-domain.sh`

## 明确边界

以下行为 **禁止默认执行**：

- 停止或重启 `/Users/macstudio1/AI/Claude/StockHub` 的服务
- 使用全局 `pkill` 扫描共享进程名
- 为了处理当前仓库问题，顺手重启 `StockHub` 的 Vite / 后端 / tunnel

当前仓库的安全脚本设计目标就是：**只影响当前仓库自己记录过的服务**。
