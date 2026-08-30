# Desktop Session State 与运行验收设计

**状态：** 已审查，待实施
**范围：** 桌面连接、媒体出画、控制租约和恢复路径的统一状态契约与真实验收
**明确排除：** 网络模式重新设计、协议迁移、Terminal PTY 实现

## 1. 价值与合理性审查

价值高但必须小步推进。当前 `webrtc.js`、媒体 activity、stats 和 control lease 各自有状态；用户可能看到“已连接”但尚未有可见首帧，或断开后短暂残留旧文案。统一 snapshot 能减少错误提示和回归风险，但直接重写重连逻辑不合理，因此本设计只先建立只读聚合和验收矩阵。

## 2. 状态契约

状态源为连接尝试、媒体 paint gate、控制租约和 Socket 生命周期；聚合器输出：

```js
{ attemptId, phase, media: 'none'|'pending'|'live'|'stalled',
  control: 'free'|'granting'|'active'|'revoking'|'blocked',
  socket: 'offline'|'connecting'|'online', canInput, lastTransitionAt }
```

`phase=connected` 只有真实 fresh frame 或 tunnel fresh frame；PeerConnection connected 只能产生 `media=pending`。旧 attempt 的事件不得改变当前 snapshot。

## 3. 用户交互规则

- `idle/disconnected`：显示开始/重新连接 CTA，远程输入和媒体控制不可用。
- `signaling`：显示连接中，禁止刷新风暴和远程输入。
- `media-pending`：显示正在出画，允许取消/断开，不宣称已连接。
- `connected + media=live`：显示已连接，按 control capability 开放输入。
- `media-stalled`：保留最后一帧和恢复 HUD，明确“画面卡顿”，不得继续显示健康 FPS。
- `revoking/blocked`：输入冻结，控制按钮解释复位等待或安全锁定。

## 4. 恢复与错误策略

每个 attempt 拥有独立 generation、timer 和 fresh-frame baseline。自动恢复只作用于当前 attempt；一次 soft recover 和一次 hard refresh 后进入明确失败，不自动改写用户选择的网络模式。disconnect 是终止意图，清除所有 pending timer、旧媒体引用和 UI 连接标志。

## 5. 验收边界

自动化验证状态转换、旧 attempt 隔离、fresh-frame gate、reset barrier 和 bounded retry。真实验收另行记录：首个非黑帧、20 次恢复 P95、15 秒暂停 payload、真实 tunnel frame、双 Viewer 写入拒绝、睡眠唤醒。任何未运行项保持 `NOT RUN`，不以 health 200 或 synthetic frame 替代。

## 6. 价值结论

该设计值得做，原因是它减少跨模块推断和错误承诺；不值得做的是一次性把 WebRTC、Host、Signal 拆成新协议。先做聚合 seam 和验收矩阵，能获得最大 leverage 且可回滚。
