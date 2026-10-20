# 启动修正执行与资源诊断补充草稿（尚未生产加载）

本稿仅汇总已落盘证据；它不是执行票据、验收通过记录或重试授权。读取截止为本稿所列 state.json 字节快照：startupJoinOperationsR3C 仍为 fresh-context-frozen，sourceCopyOrReloadPerformed=false。state 的顶层 stage/lastUpdateEpoch 含历史值，不能把它们视作各子记录的统一观测时间。后续加载由根代理完成后，另补实际最终值；不要把本稿“未加载”外推为持续实时状态。

## 代码、离线结果与运行身份分开记录

最终源码归档为 41c7b0998859a7e9d088cefcc0f3a1eeab190684；实际 Viewer 修正代码为 fefc555aea9640b563bfd22f5b36b6b8ca6365ec，ordinary 工具修正代码为 2822441791b59a021556c7e4eb24715df9d5b277。后端仍 dfb15434e79da90b803b763c533836e16c080c71，诊断模块35不变。fix3源码收据记录 Viewer 定向7/相关561 PASS（先前559/561的测试mock失败保留），工具定向8/相关166 PASS；套件可能重叠，不能相加为独立覆盖数。源码review Approved与这些离线结果均不表示生产已加载。

截至上述快照，最后已加载的 Viewer 仍是 c802a68362459b46b84593c7e8921575e0783394，build bb581651b422e400，builtAt1792336142126；工具仍59bca14209eed299b0e94da58decb8b85e5ce70c。历史R5已加载记录给出 Signal33747/birth1792336141.182036、Host36877/birth1792322600.528357。本稿不重新验证这些PID。四个已有源文件的后续复制、Signal-only重载及同Host身份检查尚待根代理实际记录；不复制53个文档补集、不重启Host/tunnel/watch，primary已知regular1016边界不变。

## 本轮逐阶段事实（2026-10-19，Asia/Shanghai UTC+08）

| 上下文 | 实际结果与覆盖边界 | 发布/重载结论 |
|---|---|---|
| R1，deployment01976df1bc5646b5ab437b96066a6846 | 01:01:36.091686记录exit1；严格check_ref要求canonicalPatch仅path/sha256，root fix2多出bytes/gitDiffFlags。发生在decision解析和deployment mkdir前，目录不存在。fix3仅修收据形状，没有放松消费者。 | 无freeze/build/源复制/重载；原失败与已消费决定保留，不重放。 |
| R2，deployment1a04390f599949ea9bf756f7b3390a36 | freeze成功，4候选/96构建输入。首lower子进程约01:12:13开始，helperExit0、5.472s、无timeout/error/cleanupError/信号，两个已记录身份退出；但coverage含observation-unavailable，外层exit2，templateSHA=null，未运行upper。 | failed-or-indeterminate，资产复审拒绝；无源复制/重载。两个已知退出不能证明完整进程树；异常细节缺失，不能倒推具体异常或阶段。 |
| R3，deploymenta33732f7817a45cabbb7c0db1b622ac6 | freeze成功；01:37:24.763660只读old_service_gate的全局lsof在5s预算触发TimeoutExpired。before build-started/Node creation；build-started、build-result、apply-started、reload-started均不存在。 | 没有构建或服务变更；原窗口/冻结记录保留，因剩余阶段时间不足而退休。 |
| R3B，deploymentb41ee5fe15b442a5afe4212ab3c8a466 | 两时间模板成功：lower3.611s、upper3.620s，均exit0、无信号/异常/额外coverage；诊断events/gaps为空、failed=false，cleanup期望退出计数28/result2。模板SHA52ffe74d49d16f90b195aa0451f8a62df4b1ca5a5e7ee6f64775cae7eeef3d2a、build a3671ba674ad7516、14文件，经实际资产独立审阅。实际混合组件离线检查exit0/5.236094s，4 methods、2 accepted、10 rejected、1262 rows，stderr0。 | 仅私有构建/离线通过。窗口01:46:55.805–01:56:45.805（590s），02:01:30.111387记录retired-unapplied-window-expired；源复制/重载=false。不能延长原窗口或借此宣布生产通过。 |
| R3C，deploymente8ce5532747654b5a1e07ff2573c42a8 | 新决定窗口02:05:30.111–02:15:20.111（590s）；当前快照仅fresh-context-frozen，frozenSHA00cbecd5afa6417f57272af76b6eba60844abef9d4310f1403cf3f25d71d5a5c，primaryMutated=false。 | 未记录加载；后续build/资产/复制/reload/readiness/实际资格不得预填PASS，需新实际记录。 |

R3诊断封装没有改变原Registry决策、扫描/信号或coverage门槛。supported异常event并不自动等于diagnostic.failed：state AccessDenied可能只记event而原coverage不变；scan NoSuchProcess/AccessDenied/OSError仍会产生原observation-unavailable并拒绝。R3B没有该gap不能反向修正R2。所有完整进程树退出仍UNKNOWN；独立Popen注册失败监督缺口在该窄delta中未修，且并非这次已注册、exit0的R2失败路径。

## 端口查询与资源压力：关联证据，非唯一根因

已授权诊断的原始查询窗口为01:41:11.228032–01:41:29.568556。相同全局命令 `/usr/sbin/lsof -nP -t -iTCP:8080 -sTCP:LISTEN` 三次5s预算均超时，实际等待5.048003/5.012638/5.014267s，退出码null且输出空。这些是右删失等待结果，包含清理开销，不是完成时间。唯一PID限定比较（加-a -p33747）3.244640s返回33747；它只能证明目标有匹配listener，不能排除其他所有者，未替换全局门槛。该窗口load1约233–237、逻辑CPU12；负载均值不是CPU利用率。

补充健康窗口01:42:09.232215–01:42:09.449889记录/health200、ok、0.078843s；/api/status200、Host在线、Viewer0/relay0、0.004053s。已知Signal/Host/tunnel/watch身份与先前值相同。这只是后来窗口的本地健康，不能追认01:37失败时状态，更不是浏览器/媒体/输入或长会话验收。

名为0143的资源快照实际epoch覆盖01:42:46.925778–01:42:47.852622（约0.927s）：load1/5/15约167.366/170.517/107.873，12逻辑CPU；823进程，其中状态首字符R89、S732、Z2；swap used11169.50M/total12288.00M（原工具单位保留）。进程名称计数与CPU标量支持当时存在系统资源压力，但不是所有权/可回收性判据；累计换页计数也不是本窗口换页速率。多个CPU/内存/调度因素可能有关，没有同窗栈、阻塞syscall或受控对照，不能证明资源压力是唯一根因，更不能将它套用为R2缺失异常细节的确定解释。

01:48:53.050003–01:48:53.111149的一次netstat -anv -p tcp，0.061269s/exit0、EOF完整、47567B stdout，观察到pid/epid列及8080 tcp4 PID33747/epid0。只保存有界schema/目标摘要，状态SCHEMA_OBSERVED_ONLY；未刷新birth。PCB单值pid/epid是否枚举共享/继承FD所有者、完整可见性及与lsof FD所有权的等价性未建立，不能用它替换独占所有者证明或作为PASS。

01:51:28.282850–01:51:28.570290另获独立授权的一次15s诊断预算，仍用原全局lsof命令，在0.287494s内exit0返回[33747]，无需超时清理。此时load1已降至9.190918；这个后来的样本甚至落在原5s之内，不能证明先前高负载时给15s会通过，也不能证明需要改生产超时。生产全局lsof门槛仍5s、fail-closed；没有被PID限定结果、netstat或该独立诊断注入替代。不同窗口样本不能构成稳定P95/总体分布或唯一因果结论。

本稿没有新采样、进程枚举、信号、服务或网络操作。不得按名称/数量/CPU值回收未知进程；现有证据没有赋予它们任务所有权，也不授权杀进程、调整服务、重建tunnel或自动重试。只能对另获授权、身份明确的任务自有资源遵循原有有限清理规则。

## 真实输入与最终验收仍缺测

| 指标 | 本轮新有效样本 | 数值/状态 |
|---|---:|---|
| inputAckRtt | 0 | null / NOT_RUN |
| hostQueue | 0 | null / NOT_RUN |
| hostApply | 0 | null / NOT_RUN |
| hostAdapterAwait | 0 | null / NOT_RUN |
| inputToPostApplyFrame | 0 | null / NOT_RUN |
| inputToVisibleEffect | 0 | null / NOT_RUN |

门禁开放、ACTIVE租约、ACK、应用后的帧与真实可见像素变化是不同证据层级。离线1262行不能替代实际普通Viewer baseline300/within390/after390/continuity10800资格；本轮新源码的这些真实场景尚无通过记录。三个历史实际失败（2f0f2a…、af76a8…、5ef3358…）及21已知身份边界继续保留，不清除或重放。独立GUI输入环境与真实输入到可见效果因果链尚未建立，物理设备/光学效果亦NOT_RUN，不宣称150–200ms或“彻底可用”。

## 根代理完成实际加载后补录

另补实际源复制结果、14或实际模板推导的dist文件图及buildId/builtAt、Signal新PID/birth、Host原身份保留、fresh readiness/occupancy、实际普通场景各自窗口/终态/失败，以及六输入指标的真实样本或继续null。只能由对应实际记录支持，不从R3B离线模板预测最终值。密码只由根代理按既定要求在聊天报告，不写本稿或版本化正文。

## 精确证据索引与读取限制

以下均为已存在的小型摘要/JSON/报告；只读其必要内容和hash，未重扫约280MB旧日志、未读取密码/环境。state是可变汇总，下面hash绑定本稿读取字节，后续变化应以新增实际记录说明。历史文档的旧运行值只用于指标边界，不冒充本轮运行。

- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/state.json`
  - SHA256 `68f00d9f65970876703e47925526be1f9ed2d0ce4248c6980aab1eafa0b3feec`；49830 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-VIEWER-TOOLS-FINAL-SOURCE-REVIEW-fix3.json`
  - SHA256 `dff8d03693e11e14448d838459edd6626105dffb009a9d21dbe4b0e6fd532029`；24382 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R1-FREEZE-FAILURE.json`
  - SHA256 `da1d584b766707d0c080751c11a9cc00540b6da63b9515fae2091deee875039e`；1411 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r2-orrzbxl6/deployment-1a04390f599949ea9bf756f7b3390a36/build-result.json`
  - SHA256 `d6cdeec27ec086f43b97f1f2d79437bf27b203ae6addfb0817f1f0aa1a248c31`；1972 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3-READONLY-PREFLIGHT-FAILURE.json`
  - SHA256 `25619b4f8486d3b1b8c624b35645a8dadc0b1855dbe703c2e6c787c3b4e10856`；812 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r3-_77m0ogi/deployment-b41ee5fe15b442a5afe4212ab3c8a466/build-result.json`
  - SHA256 `33eb22a0f6bd2b76e40fd17c2f7dbf10b5a46c493b3bf655d4448f5c417505ca`；4841 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3B-ASSET-REVIEW.json`
  - SHA256 `bebe63e660b5e454be5ad967053b7907fe7546ab482721d7ce61f76a39061fcb`；538 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3B-MIXED-INTEGRATION-EXECUTION.json`
  - SHA256 `49666cc5e2fdc75a44c6ca8066370f9bba3bd497b04169913fc51400d1a782f1`；784 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3B-MIXED-INTEGRATION-RESULT.json`
  - SHA256 `cf484d747f310c4699535a035c68c0dd7b20bf6cf0a0c254cf1a262a8f86155b`；436 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3B-DEPLOYMENT-DECISION.json`
  - SHA256 `d5c70067512ff1ffedfb8662a6d01af17654e7a0e08e83a5a3011c5f0e6276eb`；671 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3C-DEPLOYMENT-DECISION.json`
  - SHA256 `a1c6347cc22ed2562d787658278a2ce5dd8b81be0dd3f0654dc5d0694153ec39`；671 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/SYSTEM-RESOURCE-PRESSURE-SNAPSHOT-20261019-0143.json`
  - SHA256 `1d4bf29a8f652f508541f29eed4710496cfb7eb184070f61ebb36110412d0c75`；5560 bytes。
- `/tmp/wrd-port-owner-global-15s-diagnostic-20261019.md`
  - SHA256 `31778cec441581cf0a19cf09cd98cf896ed97017ac334365e51d3fd8c84af736`；4508 bytes。
- `/tmp/wrd-port-owner-lookup-latency-assessment-20261019.md`
  - SHA256 `6a37ca087c273a2bf75a8556e92ab1891d6c4b77378ec9d0f203b06dcccf7cac`；10499 bytes。
- `/tmp/wrd-port-owner-netstat-runtime-schema-20261019.md`
  - SHA256 `bf304be373183ee2291b0b1fcd4b2562a0902fa16fa15a9035c1752140a693fd`；6116 bytes。
- `/tmp/wrd-port-owner-global-15s-diagnostic-20261019.json`
  - SHA256 `881f84fa4c8305840a4f73fd521bfad7f791472e59ce55e303f4e6523c7a8f05`；3923 bytes。
- `/tmp/wrd-port-owner-lookup-latency-assessment-20261019.json`
  - SHA256 `36bbbe3d167395855293f6f59e8f74c8bb646f84ca53d5f0a78f99a338cb49f9`；11382 bytes。
- `/tmp/wrd-port-owner-netstat-runtime-schema-20261019.json`
  - SHA256 `0631c3f5175a51bd1a3f4c290f694191b003e06ce3d4fd9341c650330102bf4b`；5758 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/remaining-input-acceptance-target-assessment.md`
  - SHA256 `a021cab57879b75cff27b21f8defb14bea62acc3ef4c03515690fce3b0343f4a`；12422 bytes。
- `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/docs/superpowers/reports/2026-10-18-connectivity-latency-followup.md`
  - SHA256 `8bd5d02b05910fd74acbcd29fef7ba39b86d4d2c2419ce5e8ef257df2f1666b1`；9909 bytes。
