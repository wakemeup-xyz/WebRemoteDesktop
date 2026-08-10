# Host 空闲不自动锁屏、允许熄屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Host 运维策略改为「caffeinate 防系统空闲睡且不禁熄屏 + 可检查的锁定屏幕契约 + 文档边界」，避免远程空闲后掉进密码锁屏。

**Spec:** `docs/superpowers/specs/2026-08-11-host-no-idle-lock-allow-display-sleep-design.md`

**Architecture:** 只动 LaunchAgent 入口脚本、新建只读检查脚本与文档；不改 python-host / web-client 输入路径。`run-awake-keeper.sh` 改为 `caffeinate -ims`；`check-host-lock-policy.sh` 汇总 awake、pmset、assertions 与密码策略可读性。

**Tech Stack:** bash、macOS `caffeinate` / `launchctl` / `pmset`、既有 Node 脚本测试风格（`node --test` 对 shell 契约做文件内容断言）。

## Global Constraints

- caffeinate **默认不得包含 `-d`**（允许显示睡眠）。
- 不自动改写「需要密码」系统设置；以人工/UI 为权威，脚本 best-effort。
- 不修改键盘注入、不宣称远程解锁。
- 检查脚本退出码：`0` OK，`1` 硬失败，`2` 仅警告。
- 本机敏感信息（密码、完整机器序列）不写入仓库文档。

---

## File map

| 文件 | 动作 |
|------|------|
| `scripts/run-awake-keeper.sh` | 改参数 `-dims` → `-ims`，更新注释 |
| `scripts/check-host-lock-policy.sh` | **新建**只读检查 |
| `scripts/host-lock-policy.test.js` | **新建**契约测试（参数与退出码辅助逻辑） |
| `scripts/install-awake-keeper.sh` | 如需则小改说明输出；逻辑可不变 |
| `launchd/com.webremotedesktop.awake.plist` | 通常不改路径；确认仍指向 run-awake-keeper.sh |
| `README.md` | 防睡眠/锁屏策略节 |
| `docs/runbook-safe-startup.md` | 巡检命令 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 系统睡眠/锁屏约束 |

---

### Task 1: caffeinate 参数契约测试 + 改 keeper

**Files:**
- Modify: `scripts/run-awake-keeper.sh`
- Create: `scripts/host-lock-policy.test.js`

**Interfaces:**
- Produces: keeper 文件内容匹配 `/usr/bin/caffeinate -ims`；测试可 `node --test scripts/host-lock-policy.test.js`

- [x] **Step 1: 写失败测试（断言当前文件还含 -dims 或尚未 -ims）**

在 `scripts/host-lock-policy.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const keeperPath = path.join(root, 'scripts/run-awake-keeper.sh');

function caffeinateInvocation(source) {
  const match = source.match(/^\s*exec\s+(\/usr\/bin\/caffeinate\s+[^\n#]+)/m);
  return match ? match[1].trim() : null;
}

test('run-awake-keeper uses caffeinate -ims without display-sleep lock (-d)', () => {
  const source = fs.readFileSync(keeperPath, 'utf8');
  const inv = caffeinateInvocation(source);
  assert.ok(inv, 'exec caffeinate line required');
  assert.match(inv, /caffeinate\s+-ims\b/);
  assert.doesNotMatch(inv, /caffeinate\s+-[a-zA-Z]*d/);
});
```

- [ ] **Step 2: 跑测试确认失败（若仍为 -dims）**

```bash
node --test scripts/host-lock-policy.test.js
```

Expected: FAIL on `-ims` / `-d` 断言。

- [ ] **Step 3: 改 `scripts/run-awake-keeper.sh`**

完整目标内容：

```bash
#!/bin/bash
set -euo pipefail

# Keep the Mac usable as a remote desktop host without forcing the panel on.
# -i prevents idle system sleep.
# -m prevents disk sleep.
# -s prevents system sleep while on AC power.
# Intentionally NO -d: display may sleep (saves power; capture may go black).
# Idle lock/password is a separate OS "Lock Screen" setting (prefer never require
# password after screensaver/display off). This script does not change that.
exec /usr/bin/caffeinate -ims
```

- [ ] **Step 4: 再跑测试**

```bash
node --test scripts/host-lock-policy.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/run-awake-keeper.sh scripts/host-lock-policy.test.js
git commit -m "$(cat <<'EOF'
fix(host): allow display sleep in awake keeper

Switch caffeinate from -dims to -ims so idle display power-off remains
possible while still preventing idle system/disk sleep.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `check-host-lock-policy.sh`

**Files:**
- Create: `scripts/check-host-lock-policy.sh`
- Modify: `scripts/host-lock-policy.test.js`（增加对检查脚本静态契约的断言）

**Interfaces:**
- Produces: 可执行检查脚本；stdout 含分区标题；exit 0/1/2 按 spec §6
- Consumes: `run-awake-keeper.sh`、`launchd/com.webremotedesktop.awake.plist`、`launchctl`、`pmset`

- [ ] **Step 1: 扩展测试——检查脚本必须存在且声明退出码语义**

```js
const checkPath = path.join(root, 'scripts/check-host-lock-policy.sh');

test('check-host-lock-policy.sh exists and documents exit codes 0/1/2', () => {
  const source = fs.readFileSync(checkPath, 'utf8');
  assert.match(source, /exit 0|EXIT_OK|exit_code=0/);
  assert.match(source, /\b1\b/); // hard fail
  assert.match(source, /\b2\b/); // warnings only
  assert.match(source, /com\.webremotedesktop\.awake/);
  assert.match(source, /manual_verify|需要密码/);
});
```

- [ ] **Step 2: 跑测试确认因文件缺失失败**

```bash
node --test scripts/host-lock-policy.test.js
```

- [ ] **Step 3: 实现 `scripts/check-host-lock-policy.sh`**

要求行为：

1. `set -euo pipefail` 下对外部命令用可控失败（不要因 `launchctl print` 失败直接 set -e 退出而不打印报告）。
2. 解析 `scripts/run-awake-keeper.sh` 的 `exec /usr/bin/caffeinate ...`：若匹配到带 `d` 的短选项簇（如 `-dims`、`-d`）→ 硬失败。
3. `launchctl print gui/$(id -u)/com.webremotedesktop.awake`：失败 → 硬失败（未装/未跑）。
4. `pmset -g custom`：打印 Battery/AC 的 `sleep` 与 `displaysleep`；若 Battery `sleep` ≤ 5（分钟）→ **警告**（不单靠此项变 1）。
5. `pmset -g assertions`：若完全没有 caffeinate/`PreventUserIdleSystemSleep` → 警告或硬失败（若 awake 显示 running 但无断言 → 硬失败）。
6. 尝试 `defaults read com.apple.screensaver askForPassword`；失败则打印 `password_policy=manual_verify` 与 §4 人工核对项 → **计为警告来源，不是 code 1**。
7. 末尾打印一行：`WRD_LOCK_POLICY_SUMMARY ok=... hard_fail=... warn=...`
8. 汇总：`hard_fail>0` → exit 1；否则 `warn>0` → exit 2；否则 exit 0。

实现时保持脚本在仓库根或任意 cwd 可运行：以脚本位置定位 `PROJECT_DIR`。

- [ ] **Step 4: chmod +x 并本地跑一次**

```bash
chmod +x scripts/check-host-lock-policy.sh
./scripts/check-host-lock-policy.sh; echo exit=$?
node --test scripts/host-lock-policy.test.js
```

Expected: 测试 PASS；检查脚本在未装 awake 时 exit 1 且有可读输出。

- [ ] **Step 5: Commit**

```bash
git add scripts/check-host-lock-policy.sh scripts/host-lock-policy.test.js
git commit -m "$(cat <<'EOF'
feat(host): add lock/sleep policy check script

Read-only report for awake keeper, pmset, assertions, and password
policy manual verify guidance with exit codes 0/1/2.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 文档同步

**Files:**
- Modify: `README.md`（防睡眠相关节，约「安装 awake」「检查 pmset assertions」处）
- Modify: `docs/runbook-safe-startup.md`（巡检）
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`（系统睡眠约束）

- [ ] **Step 1: README**

替换过时表述：

- 安装仍：`./scripts/install-awake-keeper.sh`
- 运行：`caffeinate -ims`（不是 `-dims`）
- 检查：`./scripts/check-host-lock-policy.sh` 与 `pmset -g assertions`
- **不要**再要求看到 `PreventUserIdleDisplaySleep` 作为必过项
- 增加锁定屏幕推荐表（需要密码=永不；插电 displaysleep 永不；电池可关显示）
- 边界：手动锁、合盖、熄屏可能黑屏、电池系统睡

- [ ] **Step 2: runbook**

在合适「Host 健康/本机依赖」节增加：

```bash
./scripts/check-host-lock-policy.sh
./scripts/install-awake-keeper.sh   # 若 check 报 awake 未跑
```

说明 exit 2 为警告（密码策略需人工看系统设置）。

- [ ] **Step 3: 需求文档**

将「Host 必须通过 `caffeinate -dims` 防止系统/显示/磁盘睡眠」改为：

- 通过 `caffeinate -ims` 防止空闲系统/磁盘睡眠（AC 上含 `-s`）
- **不**强制禁止显示睡眠
- 推荐「屏幕保护或显示器关闭后需要密码 = 永不」
- 明确不支持远程解锁已锁会话

- [ ] **Step 4: 全文搜索残留 `-dims` / PreventUserIdleDisplaySleep 必过**

```bash
rg -n "caffeinate -dims|PreventUserIdleDisplaySleep" README.md docs/runbook-safe-startup.md docs/需求文档 scripts/run-awake-keeper.sh
```

Expected: 需求/README/runbook 无「必须 -dims」；若历史 changelog 保留旧日期记录可保留，但现行约束节必须新表述。

- [ ] **Step 5: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "$(cat <<'EOF'
docs(host): document no-idle-lock and display-sleep policy

Align README, runbook, and requirements with caffeinate -ims and
Lock Screen password=never operational baseline.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 本机安装与验收（不提交密钥）

**Files:** 无仓库必改；可更新 spec 状态为 Implemented（可选）

- [ ] **Step 1: 安装 awake**

```bash
./scripts/install-awake-keeper.sh
launchctl print gui/$(id -u)/com.webremotedesktop.awake | head -40
ps aux | rg '[c]affeinate -ims|[c]affeinate -dims'
```

Expected: service 存在；进程为 `-ims` 而非 `-dims`。

- [ ] **Step 2: 跑检查脚本**

```bash
./scripts/check-host-lock-policy.sh; echo exit=$?
pmset -g assertions | head -30
```

Expected: awake 相关硬失败消失；可能 exit 0 或 2（manual_verify / 电池 sleep 警告）。

- [ ] **Step 3: 单测再跑**

```bash
node --test scripts/host-lock-policy.test.js
```

- [ ] **Step 4: 向用户汇报验收摘要（无密码内容）**

包括：awake 是否 running、caffeinate 参数、check exit code、是否仍需人工确认「需要密码=永不」。

- [ ] **Step 5: 若有文档状态行，可把 spec 状态改为 Implemented（可选 commit）**

---

## Spec coverage checklist

| Spec 项 | Task |
|---------|------|
| S1–S3 awake -ims | Task 1 + 4 |
| S4 check 脚本 | Task 2 |
| S5 文档 | Task 3 |
| S6 密码永不（人工基线） | Task 3 文档 + Task 2 manual_verify + Task 4 汇报 |
| 非目标（不改键盘等） | 全任务不碰 python-host/web-client 输入 |

## Plan self-review

- 无 TBD/占位实现步骤
- 退出码与 spec §6 一致
- 不强制 pmset 写入（与 spec 5.2 一致）
- 测试先于 keeper/check 实现（TDD）
