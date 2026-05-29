# Safe Startup Runbook

本手册用于在 **不影响** `/Users/macstudio1/AI/Claude/StockHub` 的前提下，启动、查看、停止当前仓库 `WebRemoteDesktop` 的完整本地服务链路。

## 目标

- 只操作当前仓库自己的 `signal-server`、`python-host`、safe quick tunnel
- 不扫描、不清理、不复用 `StockHub` 的服务进程
- 通过独立的 safe PID / URL / LOG 文件管理当前仓库的公网临时入口

## 推荐命令

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
2. `curl http://127.0.0.1:8080/health`
3. `curl http://127.0.0.1:8080/api/status`
4. `cat /tmp/wrd-safe-current-url.txt`
5. `tail -100 /tmp/wrd-safe-quicktunnel.log`

判断方法：

- 如果 `health` 不通：优先看 `signal-server`
- 如果 `health` 通但 `hostOnline` 为 `false`：优先看 `back-debug.log`
- 如果本地都通但公网不通：优先看 safe quick tunnel 日志

### 场景 2：Cloudflare 地址失效

`scripts/run-safe-quicktunnel.sh` 会在日志出现 `Unauthorized: Tunnel not found` 时自动重建 quick tunnel 并刷新：

- `/tmp/wrd-safe-current-url.txt`

手动确认：

```bash
cat /tmp/wrd-safe-current-url.txt
tail -100 /tmp/wrd-safe-quicktunnel.log
```

### 场景 3：状态脚本显示 safe PID 文件缺失，但 8080 仍然正常

这通常表示：

- 当前本地 `signal-server` / `host` 是通过非 safe 脚本启动的
- 或 safe PID 文件被删掉了，但服务进程还在运行

这时不要直接全局清理；先确认当前服务是否是你想保留的，再决定是否用 safe 脚本重新接管。

## 明确边界

以下行为 **禁止默认执行**：

- 停止或重启 `/Users/macstudio1/AI/Claude/StockHub` 的服务
- 使用全局 `pkill` 扫描共享进程名
- 为了处理当前仓库问题，顺手重启 `StockHub` 的 Vite / 后端 / tunnel

当前仓库的安全脚本设计目标就是：**只影响当前仓库自己记录过的服务**。
