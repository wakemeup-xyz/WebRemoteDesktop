# Viewer 登录主线程阻塞修复

用户已授权持续修复和验收。本增量沿用已确认的 brainstorming → writing-plans 流程，不重复询问规划路径。

`routes/auth.js` 为每次非空 Viewer 登录执行 `bcrypt.hashSync(expected, 10)`，随后执行 bcryptjs compare。配置保存的本来就是明文环境密钥，没有持久化 bcrypt hash；重新生成盐和 hash 不增加该存储的防离线破解能力，却占用提供网页、健康检查和 Socket 心跳的线程。合成密码只读复现中同步 hash 约111ms，随后比较约123ms；这不是生产总体分位数，也不能解释没有登录请求时的 Host 停顿。

选择复用同文件管理员认证的 `constantTimeSecretEqual`：对两边完整 UTF-8 字节作 SHA-256，使用 `crypto.timingSafeEqual` 比较固定32字节摘要。不缓存配置，不 trim/normalize 用户输入，不记录输入。替代方案是缓存 bcrypt hash 或 worker 隔离；前者仍有主线程JS比较成本，后者增加线程/排队/生命周期而没有此共享明文密钥场景的必要收益。

保留两个登录别名、共享20次/15min单IP限流、缺密码400、错误密码401、成功token/role/有效期和已有配置加载。无有效配置时拒绝认证，不允许空值摘要碰巧相等。保持原有真值非字符串输入到String的兼容。管理员与Host接口不变，不降低bcrypt cost，不安装或删除依赖。

有意收紧旧bcrypt的72字节截断：配置密码超过72字节时只接受完整精确输入，共享前72字节而后缀不同必须拒绝；多字节Unicode同样按完整UTF-8、不归一化。现有正常完整密码继续有效。

验收：实际route正确/错误/空/非字符串/Unicode/长密码/无配置；两个别名限流和token验证回归；用合成密码确认没有bcrypt计算路径。性能测量作为补充，不用脆弱固定毫秒阈值代替语义验证。仅在root确认零Viewer、独立review通过并冻结候选后部署本地Signal；Host/tunnel不因本增量主动重启。长会话及真实input→visible仍独立验收。
