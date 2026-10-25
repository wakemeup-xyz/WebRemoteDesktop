# 重启自启修复执行与审查记录

计划：`../plans/2026-10-26-reboot-autostart.md`；设计：`../specs/2026-10-26-reboot-autostart-design.md`。

## 本轮边界

用户授权开发测试及后续重启恢复。使用原先干净 checkout 的独立分支 `codex/reboot-autostart`，保留生产服务绝对路径。已只安装五个持久用户 plist；未激活或重启生产服务、未操作 tunnel。真实重启、公网画面和输入 NOT RUN。

## 规划审查

| 范围 | 接口与一致性检查 |
| --- | --- |
| Task 1 | 持久 Signal plist 与失败回滚共用既有配置生成函数，测试覆盖无旧文件和有旧文件 |
| Task 2 | named-only wrapper 与持久 restart 共用配置，显式维护与普通本地维护分开 |
| Task 3 | 只安装统一消费前两项配置；五项先验证后写入，不以安装替代运行 |
| Task 1 ↔ 3 | `signal_launch_configuration` / `validate_signal_launch_inputs` 接口一致 |
| Task 2 ↔ 3 | `build_configuration` / `validate_configuration` 接口一致 |
| 所有任务 | 不改 quick tunnel、token daemon；GUI 登录边界；真实验收不由离线测试替代 |

## 实施与测试

### 实现

- Signal 使用持久的用户 plist、Interactive、绝对参数、RunAtLoad/KeepAlive 与 10 秒节流。本机 curl 明确绕过代理并设置连接/总超时，status 从真实项目进程发现 Host/Signal，不依赖重启后消失的 PID 文件。
- 正式 connector 使用 credentials-file、字面参数 wrapper 和同一持久配置。显式维护精确管理项目 label；token、无法确认归属和多 owner 拒绝，移除全局 pkill/nohup/临时 submit 启动路径。
- 安装器只读检查或只写五份配置；先验证全部输入、保存私有备份再原子替换，失败逆序恢复，回滚失败保留旧字节和权限元数据。未知禁用状态不误报 enabled，单份破损 XML 不阻断其余检查。
- 运行维护区分已 staged 磁盘配置和旧 loaded job，注册/健康失败时恢复正确的旧运行参数；正式公网健康等待失败保留一次已注册 connector 并返回失败，不新增健康 bounce。

### RED / GREEN 与验证边界

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| Signal helper | `python3 -m unittest discover -s skills/webremote-service/scripts -p '*_test.py'` | 46 PASS；持久化首轮有效 RED 29 项中 5 failures/5 errors，staged 回滚反例 RED 42 项中 4 failures |
| 正式 LaunchAgent | `python3 -m unittest discover -s scripts -p '*launchagent_test.py'` | 最终主线程复核 28 PASS，含四种禁用状态兼容与未知值拒绝 |
| 统一安装器 | `python3 -m unittest discover -s scripts -p 'reboot_autostart_test.py'` | 12 PASS；先观察缺实现失败，另观察禁用状态、破损 XML、持续写失败与误报 ready 的反例失败，再修复通过 |
| Host 与 Host restart | `node --test --test-concurrency=1 scripts/host-launchctl.test.js scripts/restart-host.test.js` | 34 PASS |
| Formal 脚本及 watcher | `node --test --test-concurrency=1 scripts/start-fixed-domain.test.js scripts/restart-fixed-domain-tunnel.test.js scripts/watch-fixed-domain.test.js scripts/fixed-tunnel-preflight.test.js scripts/upgrade-cloudflared.test.js scripts/probe-fixed-edge.test.js` | 45 PASS，隔离 fixture |
| tunnel 入口契约 | `node --test scripts/tunnel-launchctl.test.js` | 7 PASS |
| tunnel 保护 fixture | `node --test scripts/tunnel-safety-fixture.test.js` | 7 PASS；临时 HOME、工具替身及 URL/进程 canary |

最终共 86 项 Python、93 项 Node 测试通过（179 个不同测试）。没有未解决的测试失败。

修改的 shell 脚本 `bash -n`、Python `py_compile`、`git diff --check` 均通过。测试不启动生产服务，不连接 Viewer、不发送输入。没有改动媒体或前端逻辑，因此不以应用启动/构建制造服务验收。

初跑 Host 34 项中 8 项失败，其中两个等待 marker 超时、六个 fixture 子进程超时；当时本机 load1 约 475，日志已显示健康和认证成功但 marker 尚未调度。采用临时 HOME/无生产 TURN 配置和有界 20 秒 marker、30 秒 fixture 调度余量后，串行全部通过；没有放宽产品启动 SLA 或实际运行阈值。formal Node fixture 同样记录过短超时失败。tunnel safety 初跑 7 项超时，后续 6/7 时发现 fake connector 先写退出标记、后写诊断的 fixture 竞态；调整标记顺序和有界调度等待后最终 7/7。没有修改 quick tunnel 业务脚本；不会用这些调度样本推算产品延迟。

### 测试隔离事件

Signal 第一轮新增 RED 用例遗漏了真实工具拦截，意外将临时 fake node（只 exit 0）注册到此前不存在的 Signal label，并创建空 `/tmp/signal-server.log`。未停止生产服务、未写生产 PID/URL。立即停止该次运行；主线程核实精确 fixture 程序、工作目录和临时 plist 后，仅 bootout 该测试注册并移除空日志，恢复任务前状态。之后 Signal/formal/安装器单元测试均默认禁止真实 subprocess，安装器还禁止真实网络；唯一 wrapper 执行仅显式放行临时目录内的测试程序。不能将这次 fake 注册记为生产激活。

### 独立审查

规划独立审查发现两项 P2，已纳入 spec/plan：明确进程退出恢复与 watcher 健康预算；定义全量启动预检与部分失败语义。

代码审查发现并修复：禁用状态四种输出兼容与未知值、损坏 XML、回滚前私有备份、Signal loaded/disk 快照分离、formal staged 配置激活与回滚、旧 tunnel alias 的跨进程导出、测试全局真实工具保护。限定范围复审通过，未留未解决的必修问题；真实运行证据不能由该结论替代。

### 本机只安装结果

执行 `python3 scripts/install-reboot-autostart.py --install` 返回 0，五个文件均 `exists=true, matches=true`，`activation=NOT RUN`。随后 `--check` 只读复核配置全部匹配，五个项目 label 均 `disabled=false`；loaded/running 状态与安装前一致：Host wrapper、awake、fixed-watch 在运行，Signal 和正式 connector 未加载。本地 `health_ok=false, host_online=false, ready=false`，检查退出 1 正确反映仍未运行。

因此持久配置已准备好供**下次该用户 GUI 登录后**加载，但当前远程服务仍不可接入。没有实际重启、正式入口媒体或真实输入证据，均保持 NOT RUN。本轮未读取/回报密码，因为未启动或重启本地服务；凭据未写入版本化材料。

正式生命周期补充检查：只在注册/启动命令失败时回滚，保存原 disabled 状态并在失败后恢复；无 `kickstart -k`，避免 RunAtLoad 后立即重复 bounce。安装器仍不运行这些生命周期操作。
