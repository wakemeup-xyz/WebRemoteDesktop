# 登录阻塞与截图失效增量

代码已完成，独立任务review已通过；本页首次归档时尚未生产部署。

|增量|证据|边界|
|---|---|---|
|e996467 Viewer共享明文密钥认证|真实路由RED证明bcrypt72字节错误后缀200；修复后25项PASS，独立25项复核PASS；复用管理员既有固定摘要恒时比较|保持令牌/限流/别名；完整UTF-8匹配有意拒绝旧截断错误后缀，不修改凭据；不证明Host停顿已解决|
|83c513e 有效图像epoch|三项RED复现同尺寸epoch+2、cache变blank、在途像素被丢；105项PASS，独立105项PASS；仅真实有效尺寸变化epoch+1|真实构造器3项按禁止MSS/native边界排除；不改codec峰值资格、旧自适应或Quality Lock；保留旧capture身份，不把复用当新帧|

测试范围存在重叠，不把重复复审次数相加。主仓部署须冻结审查提交、fresh zeroViewer、保留HEAD/index及已有修改、四个watcher文件不加载，使用service helper本地restart-local；所有服务恢复后再做实际验收。此前256秒长测失效、3小时未完成和input→visible NOT RUN仍有效。

恢复策略仍需区分：用户分辨率锁定不代表历史FPS/码率微调被关闭；20→15FPS退出既有peak资格、进入软件编码的往返是真实已有路径。当前增量消除额外blank/尺寸重开，不放宽资格、不假称消除整个codec往返。无堆栈仍不能唯一归因首个停顿；大量换页和整机调度压力仍是实测风险，需要受控资源窗口及实测。

详情：[认证review](2026-10-17-viewer-auth-task-review.md)、[截图review](2026-10-17-capture-image-epoch-task-review.md)、[故障窗口](2026-10-17-turn-long-failure-analysis.md)、[采样器修复](2026-10-17-sample-observation-implementation.md)。
