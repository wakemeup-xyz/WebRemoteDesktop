# JPEG 新鲜度失效的键盘复位协议修复

状态：设计已确定；实现与运行验收待完成。补充现有 M6，不改变其媒体身份、新鲜度或准入规则。

## 问题与证据

Host 单调时钟修复后，公网 JPEG 暂停/恢复测试实际运行 69.744991s，恢复成功后新图片加载停止 5200.4ms，测试失败。浏览器 post-recovery tick45 首次出现 frameStale=true，同时 keyboard lastSent 从0变1、pending1、RESET_REQUIRED，Socket disconnect0；这是测试清理之前触发的真实复位。Signal 后续明确拒绝该 reset：INVALID_RESET_REASON。

`WebRTC.invalidateRelayInputProof(reason)` 把 `relay-frame-stale` 或 `relay-start` 传给 `Input.setActive(false, {resetKeyboard:true, reason})`；真实 Input→KeyboardController→KeyboardTransport 把 reason 原样写入 schemaVersion2 keyboard reset payload。Signal `lib/remote-input-contract.js` 和 Host `remote_keyboard_state.py` 的严格白名单均不包含这两个值。该确定缺陷阻碍失效后的安全复位，不解释先发生的5.2秒停帧。

## 方案比较与选择

选择保留本页诊断原因，并将复位协议原因映射为已有的 `deactivated`。不扩展 Signal/Host 白名单，避免为了一个本地媒体状态增加跨版本协议值；不在底层吞掉所有非法 reason，避免掩盖其它调用错误；不关闭 reset 或放宽 gate。

在 `Input.setActive(active, meta)` 新增可选的本地 `meta.keyboardResetReason`，只用于实际调用 resetKeyboard 的参数，缺省继续用现有 reason。生命周期记录、releasePointer 和 UI 的 `meta.reason` 保持原有诊断语义。M6 调用者传 `{resetKeyboard:true, reason, keyboardResetReason:'deactivated'}`。原本已 inactive、但 pressedKeyCount>0 或 RESET_REQUIRED 的补充 reset 分支也用 `deactivated`。

该 metadata 不进入 wire，不新增共享模块或协议字段。`lastKeyboardResetReason`/keyboard-reset trace 自然记录真实协议原因 deactivated；媒体 UI 和 Input active lifecycle 仍保留 relay-frame-stale/relay-start。不要求同一个字段同时表达两种语义。

## 保留边界

保持单 Viewer、lease/epoch、seq、inputIds、attempt/socket/generation、reset barrier、ACK deadline和无业务输入重放。旧 ACK 不得解锁，新鲜图片不能越过未完成 reset；当前 reset ACK 本身不能越过 stale media。只有当前 reset ACK 与当前合格图片均满足时才可恢复 gate。已有 resetKeyboard:false/default 行为不变，已 inactive 且无按键/无需 reset 时不额外发送。

不改阈值、网络策略、FPS、质量、Host/Signal协议、tunnel或详细追踪开关。测试完全离线，不触发系统输入。

## 验证与交付

使用加载真实 Input/WebRTC/KeyboardTransport 的既有 VM fixture，触发真实 freshness timer 和 relay-start 路径，验证实际发送 envelope 经 Signal 的 `validateRemoteInput` 通过；不能仅 stub resetKeyboard 或只检查字符串。覆盖 active与already-inactive分支、ACK与合格load的两种顺序、旧scope/ACK拒绝及缺省行为。先记录旧代码 RED，再实现并运行必要相邻回归，独立 spec/quality review。

与已复审的 Viewer duration clocks 一起做临时构建和受控本地加载，记录真实构建身份。零 Viewer 时才部署，保留用户主 checkout/index和现有 tunnel。公网短测仍可能因资源/媒体停顿失败；该修复的通过不能冒充原生输入到可见效果或长时间连续性通过。
