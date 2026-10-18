# Formal403：四请求只读对照 — 2026-10-19

The formal health responses differ by UA-header profile in this bounded observation. This supports an association with request conditions, but does not prove a specific UA/IP rule or browser acceptance; origin/tunnel failure is not established.

窗口：2026-10-18T19:19:15.587301+00:00–2026-10-18T19:19:16.620432+00:00；并行总耗时1.032932秒。仅四次GET，每次timeout5秒、正文最多4096字节，不重试、不跟随重定向、不登录。默认UA为Python urllib默认值；browser仅切换UA字符串，不是真实浏览器。全部显式direct/no-proxy，未读取或保存环境/代理配置。

| Request | HTTP | Elapsed s | Server | Content type | Body bytes read | Edge code |
| --- | --- | --- | --- | --- | --- | --- |
| formal_health_python | 403 | 0.724616 | cloudflare | text/plain; charset=UTF-8 | 17 | 1010 |
| formal_health_browser | 200 | 1.023364 | cloudflare | application/json; charset=utf-8 | 54 | None |
| formal_root_browser | 200 | 1.019847 | cloudflare | text/html; charset=UTF-8 | 1347 | None |
| local_health_python | 200 | 0.005817 | None | application/json; charset=utf-8 | 54 | None |

两次同health路径不同UA的状态差异：True；三次formal均403：False；local health HTTP200：True。响应白名单headers详见JSON；原始正文已丢弃，仅提取带error-code语境的四位数字。local只证明这次HTTP层，不替代Host/输入/画面验收。

UA差异至多是请求条件关联。未观测出口IP、具体规则、边缘策略日志或源站响应链，因此不能宣称UA/IP策略根因，不能单凭server=cloudflare认定产生403的层，也不能据此判定源站/隧道损坏。若UA改变仍403，保留该失败事实；若某次成功，也不能抹去root此前同条件失败或宣称持续恢复。

root此前02:56CST formal health200、随后formal health/root403及03:16CST本地health/status200/Host在线/Viewer0作为parent context保留，未重新查询。四个已知PID出生与safe URL状态也仅为parent context。此前客户端/代理条件与本次direct urllib可能不同，不能当成只改变UA的跨时对照。

未进行服务/tunnel/watch/DNS诊断/config/env/进程/Git/日志操作，无kill、重启或重建。普通HTTP请求所需解析和TLS不构成另一次诊断；无额外外网浏览。HTTP200不代表应用登录、资源、媒体或控制已验收；本轮预算已耗尽。

JSON：/tmp/wrd-formal-403-readonly-diagnosis-20261019.json；报告均private0600。
