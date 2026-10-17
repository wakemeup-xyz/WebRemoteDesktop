# Capture Image Epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 同尺寸媒体档位变化不再丢有效截图，真实尺寸变化只失效一次。
**Architecture:** 区分图像有效性与帧率节奏，复用既有锁/epoch/worker fence。
**Tech Stack:** Python3.11、asyncio、现有纯mock/AST测试。
**Spec:** `docs/superpowers/specs/2026-10-17-capture-image-epoch-design.md`

## Global Constraints

- 不运行真实Host构造器/MSS/nativeinput/浏览器/网络/服务或依赖安装；不改变codec政策、网络或质量参数。
- 只改`python-host/host.py`中相关setter/apply及必要的专用测试，保留M2因果身份和pause/shutdown fencing。
- source/index单写者；root负责文档及review后冻结部署，不用实现过程触碰生产。

### Task 1: 有效尺寸epoch与回归

**Files:** `python-host/host.py`, `python-host/test_frame_worker.py`（或独立`test_capture_image_epoch.py`）。
**Interfaces:** setter仍接收width/height/FPS；apply返回`sizeChanged/width/height`，字段值为实际cap后的尺寸。

- [ ] RED合成track，monitor1792×1120、max1280×720、epoch9，缓存1152×720；apply相同尺寸20→15→20与码率-only均应epoch9，现代码每次+2。无截图时必须继续cache source，保留原capture identity且不是fresh输出。
- [ ] 在`set_max_resolution`锁内按规范化尺寸执行 `changed = (width, height) != (self._max_width, self._max_height)`；仅changed时赋值和epoch+1，锁外仅changed时release，返回change/effective值或由apply锁内读取，避免重复失效。
- [ ] `set_target_fps`在锁内更新target和interval，删除图像epoch/release；相同值直接无副作用。apply报告effective尺寸比较，不将request当effective。
- [ ] 测真实有效resize递增一次并释放一次、cap等价请求不变；在途worker跨FPS仍有效而跨真实尺寸丢弃；pause/shutdown旧结果拒绝。修正仅因旧错误语义而失效的fixture，不弱化真实行为断言。
- [ ] 运行safe frame_worker、media_stage_boundaries、input_frame_causality、quality_lock及encoder_policy测试，禁止真实构造器；具体过滤及排除原因写报告。源码独立task review通过后root部署。
- [ ] 只提交允许源码/测试，交还index；不重启生产。
