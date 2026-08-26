# pdf-translate 审计修复清单

> 来源：全量代码审计（6 并行查找代理 → 逐条人工复核 → 关键结论实测验证，PyMuPDF 1.25.2 / Pydantic 2.9.2）
> 原始 47 条发现，复核后确认 34 条（致命 1 / 隐患 22 / 代码味道 11），假阳性已剔除（见文末）。

## 使用规则（对修复 agent 生效）

1. 按批次顺序修复，**一次只修一个批次**，修完更新本文件勾选状态后由用户 commit
2. 不引入新依赖，不改公开 API 和配置项
3. 标注「需运行时验证」的条目：先写出复现/验证思路，用户确认后再动手
4. 批次 3 为架构性改动：先给方案（现状 → 方案取舍 → 影响面），用户逐条确认后再写代码
5. 每批完成后：后端跑 pytest，前端跑 tsc；用户做主流程冒烟（打开 PDF → 划词翻译 → 移动文本块 → 保存）

---

## 批次 1：致命 + 一行级高确定性修复（9 条）

- [x] **1.1【致命】`backend/app/services/pdf_edit_service.py:283`**
  `text = e.get("text", info["text"])`：pydantic `model_dump()` 总带 `text: None` 键（已实测），`.get` 拿到 `None`，`str(None)="None"` 为真值，redaction 物理移除原文后把字面字符串 `"None"` 写进 PDF。
  触发：编辑器只移动/缩放/改色任一文本块（不动文字）→ 保存。
  修复：`text = e.get("text") or info["text"]`，或显式 `if text is None: text = info["text"]`。
  **必须补回归测试**：模拟只移动文本块（text=None）的 EditOp，断言输出 PDF 不出现字面 "None"（此文件当前无测试覆盖）。

- [x] **1.2 `backend/app/services/fonts.py:92-102`**
  `@lru_cache` 缓存 None：启动时没找到字体，用户之后装好字体也永远找不到。
  修复：只缓存成功结果，失败不缓存（自维护缓存）。

- [x] **1.3 `backend/app/services/llm.py:69`**
  `message.content` 为 null（内容审查拒答等合法响应）未处理 → 返回 None → 响应模型校验失败 500。
  修复：`content or ""` 并给出可读错误。

- [x] **1.4 `backend/app/services/llm.py:107-108`**
  畸形 SSE 行的 except 只列 `JSONDecodeError/KeyError/IndexError`，漏 `TypeError/AttributeError`（如 delta 为 null），非标端点一行异常结构就掐断整个总结流。
  修复：补 `TypeError, AttributeError`，或直接 `except Exception`。

- [x] **1.5 `src/components/HistoryNotes.tsx:156-163`**
  历史回填只写 lastSelection/lastTranslated，不清 lastTerms/lastTermsError → 旧术语解释错配给回填译文。
  修复：回填时同时清空术语字段。

- [x] **1.6 `src/services/llmDirect.ts:36-52`**
  术语解释直连 LLM 无超时控制 → 端点挂起时术语区永久转圈。
  修复：加 AbortController + 定时中止（90s，与 translateText 一致）。

- [x] **1.7 `src/services/api.ts:42-44`**
  调用方传 signal 时 fetch 用调用方信号，超时定时器的 controller.signal 根本没接上——translateText 的 90s 超时是死代码。
  修复：`AbortSignal.any([init.signal, controller.signal])`；如需兼容性降级方案先说明。

- [x] **1.8 `backend/app/services/file_utils.py:22-27`**
  先补 `.pdf` 后缀再 `[:180]` 截断：超长文件名（>176 字符）会截掉扩展名。
  修复：截断主体、保留后缀。

- [x] **1.9 `src/store/useSettings.ts:204-211`**
  notes 持久化无上限（history 有 50 上限），长期收藏缓慢挤占 localStorage 直至写入失败。
  修复：与 history 一样限额。

---

## 批次 2：行为变更类（12 条，改完人工过一遍交互）

- [x] **2.1 `src/services/api.ts:260-262`（配合 `Summary.tsx:39`）**
  streamSummary 的 `reader.read()` 循环无 try/catch；流中途断开时 Promise reject 无人捕获 → summaryRunning 永久卡在「生成中」。
  修复：循环包 try/catch → onError；Summary.tsx 里 await 外加 catch 兜底。

- [x] **2.2 `src/services/api.ts:163-167`**
  SSE onerror 立即 close() 并判失败，无重连；长翻译期间一次瞬时抖动（休眠/唤醒）→ 前端永久显示「进度连接中断」。
  修复：利用后端已有的 last_event 重放能力做指数退避重订阅。

- [x] **2.3 `src/services/pdf.ts:30-48`**
  savePdfFile 用一个 catch 把「用户取消/非 Tauri」与真实写盘失败混为一谈：写盘失败静默降级为无效的浏览器下载，用户以为是自己取消，编辑成果无声丢失。
  修复：区分错误来源，invoke 失败抛给调用方显示真实原因，仅「非 Tauri」才降级。

- [x] **2.4 `src/components/TextTranslate.tsx:53-54`**
  全局单实例共享 abortRef，跨标签划词互相取消，被取消方静默停在空白态。
  修复：按标签 id 存放控制器，或至少给被取消方写「已被新请求取消」状态。

- [x] **2.5 `src/components/PdfEditor.tsx:149-156`、`src/components/PdfAnnotator/index.tsx:300-319`**
  保存快照取自闭包；保存请求 await 期间继续编辑的内容不进产物，但提示保存成功。
  修复：保存期间禁用编辑（现有 saving 态只差禁用交互），或保存完成后比对版本号。

- [x] **2.6 `src-tauri/src/lib.rs:60-63, 97-100`**
  ① `taskkill /IM backend.exe /F` 按映像名全局杀：双开时杀掉另一实例的后端，也可能误杀同名进程；② 端口探测只做裸 TCP 连接，任何占用 8765 的无关进程都会让应用跳过拉起后端并永久「离线」。
  修复：记录 PID 用进程树 kill；探测改为请求 `/api/health`。**先说明方案再动手。**

- [x] **2.7 `backend/start.py:108` ↔ `src/services/api.ts:16` ↔ `src-tauri/src/lib.rs:169`**
  BACKEND_PORT 只有后端遵守，前端 BASE 与 Tauri 探测硬编码 8765 → 用户按文档设置 BACKEND_PORT 后前后端整体断连且无提示。
  修复：三处统一到同一来源，或移除该环境变量。**两个取舍让用户选。**

- [x] **2.8 `backend/app/services/pdf_service.py:785, 798-806`**
  降级纯文本 PDF 按 90 字符折行：中文 10pt 全宽，90 字=900pt 远超 A4 可用 ~515pt，半行文字被裁掉。
  修复：按绘制宽度估算每行字符数（中文≈每 10pt 一字），或 drawString 前量宽。

- [x] **2.9 `backend/app/services/pdf_annot_service.py:301-319`【需运行时验证】**
  打开会话时导入失败的已有批注不在 annotations.json；保存时按 live_xrefs 清理 → 这些批注被静默删除。
  修复：导入失败的批注记录原样保留策略（不参与删除判定），或保存时对照导入清单给警告。

- [x] **2.10 `backend/start.py:20-26, 39-47`**
  日志 5MB 上限只在启动时检查，长会话无限增长；frozen 兜底分支只修 C 层 fd、未替换 sys.stdout/stderr，仍可能复现它本要修的写句柄崩溃。
  修复：运行期滚动检查；兜底分支同步替换 sys.stdout/stderr。

- [x] **2.11 `backend/app/services/llm.py:63-71, 87-108`**
  chat()/chat_stream() 只捕获非 200 状态码；网络异常/超时/200 但非 JSON 裸抛。总结路由 event_gen 只捕 LLMError → SSE 无声截断，前端把残缺内容当正常结束。
  修复：chat/chat_stream 内把 httpx 异常统一包成 LLMError；event_gen 加 `except Exception` 下发 error 事件。

- [x] **2.12 `src/components/PDFViewer.tsx:107-108`、`PdfEditor.tsx:94-95`、`PdfAnnotator/index.tsx:140-142`**
  加载途中卸载时 `if (cancelled) return` 直接返回，拿到的 doc 未 destroy() → pdf.js 文档 + worker 泄漏。
  修复：`if (cancelled) { doc.destroy(); return; }`。

- [ ] **2.13 `backend/app/api/summary.py:46`【3.3 期间发现】**
  async 路由里直接同步调 `pdf_service.extract_text()` 全文抽取：大 PDF 阻塞事件循环数秒 → 期间 /api/health 无法响应、其他请求卡死（与 3.3 同类，但位于路由层而非翻译生成器）。
  修复：`await asyncio.to_thread(pdf_service.extract_text, tmp_path)`（与 3.3 同一模式）。

---

## 批次 3：架构性改动（6 条，先出方案，逐条确认后再改）

- [x] **3.1 `backend/app/services/pdf_service.py:227-229`【需运行时验证触发频率】**
  `asyncio.wait_for(asyncio.to_thread(translate…))` 超时只取消等待，线程无法终止：僵尸 pdf2zh 线程（含 4 个 LLM 并发）与后续重试竞争写同一 out_dir，结果文件可能交叉污染。
  方向：可中断执行器（子进程 + kill），或超时后不再复用同一 out_dir、每次尝试独立子目录。
  **措辞修正**：现实现超时后 `timed_out → break` 跳过修复重试链，僵尸的真实并发对象是
  覆盖翻译（共享 out_dir 并发），而非下一次 pdf2zh 尝试；跨尝试污染的真实通道是
  babeldoc 被 wait_for 掐断后的残留产物被 `_find_output`「任意 .pdf」兜底捡到。
  已修（选型 C：协作取消 + 每次尝试独立 out_dir；子进程方案 A 对比后留作升级路径，
  `run_pdf2zh_cli` 签名未动，换 A 是同接缝替换）：
  ① pdf2zh 路线利用其原生 `cancellation_event`（页边界检查）：超时置位事件，线程最迟
  下一页边界 CancelledError 退出，止住 LLM 额度燃烧；随后等待至多 `GRACE_REAP_SECONDS`
  （60s）确认退出（回收成功），超上限「放弃回收」并记录——取消信号已置位，产物限于
  本次尝试目录。② babeldoc 路线：其 `async_translate` 吞 CancelledError 并无界等待内部
  worker，直接 wait_for 会拖死编排——改「主超时 + 回收上限」两段有界等待。
  ③ 编排层每次尝试独立子目录 `attempt-{mode}/`、修复副本 `repaired-{mode}/`，
  `_clean_stale_outputs` 退役。超时/回收/放弃结果统一进 `_log_attempt`。
  先红后绿：基线测试在未修复代码上坐实「任务报超时返回 0.9s 内、线程未停、1.5s 后
  zombie-late.pdf 写入同一 out_dir」；改写为回归断言后 4 项在未修复代码全红、修复后全绿
  （`tests/test_pdf2zh_zombie.py`：回收成功/放弃回收/babeldoc 有界/目录隔离）。
  全量 26 项 pytest 通过。待用户运行时验证触发频率：临时把 1200 调小（如 30）+ 大文件
  或慢假 LLM 端点复现超时，观察 backend.log 的回收/放弃记录（验毕还原，不进代码）。

- [x] **3.2 `backend/app/services/task_manager.py:19, 39-43`（配 `pdf_trans.py:121-125`）【需运行时验证】**
  进度队列破坏性单消费：多 SSE 连接瓜分事件；finish() 不唤醒等待者 → 某端可能永远等不到 done。
  方向：订阅者模型（每连接独立队列，或 last_event 轮询 + 完成广播）。
  已修（选型 A：每连接独立订阅队列；方案 B「last_event 轮询 + 完成广播」对比后弃用，
  理由：合并语义下慢消费者丢中间事件、严格上无法保证「两边都收全」，与验收标准冲突；
  A 的有界队列已把最坏内存压到 ~75KB/连接，B 的内存优势无实际意义）：
  ① task_manager 改订阅者模型：`subscribe/unsubscribe` 每连接一个有界队列
  （`MAX_QUEUE_SIZE=256`，满时丢最旧——进度是状态量、done 永远最新不会被丢；
  生产者广播全程 `put_nowait`，慢/卡消费者不阻塞翻译任务，不踢人）；
  `push()` 广播 + 记 last_event；`finish()` 置标志外另向每个订阅者注入兜底 done
  唤醒全部等待者（生产者已先推 done 时重复注入幂等无害）。
  ② 消费端统一为 `subscribe_events()`：先注册订阅再取快照（之间无 await，不漏事件；
  快照含 seq/last_event/finished/error，防 yield 挂起期间任务完成导致重放旧事件），
  入场重放 last_event（2.2 重连与切标签自愈语义不变），重叠事件按内部 seq 去重
  （seq 不进 SSE payload，事件格式不变），收到 done 退出，finally 无条件退订
  （客户端断开/异常不泄漏订阅队列）。`pdf_trans`/`overlay_trans` 两处 event_gen 同构重写。
  ③ 任务对象清理时机不变（沿用 `cleanup_later` 6h TTL，`/result` 下载依赖）。
  先红后绿：`tests/test_progress_fanout.py`（httpx ASGITransport 打真实 app 走完整
  SSE 路径，仅 monkeypatch 翻译生成器）并发开两个 SSE 连接——未修复代码实测瓜分实锤：
  连接 A 收 step-1,3,5,7,9 + done，连接 B 只收偶数位且永等 done（wait_for 超时应诊），
  全文/覆盖两条路由均红；修复后两边各收全量 11 条有序事件并正常结束。
  单测补：双订阅全量广播、finish 唤醒全部等待者、满队列丢最旧保最新、重放恰好一次
  无重复无缺口、完成后重放 done 一次、无事件 finish 合成 done 兜底、退订防泄漏。
  全量 34 项 pytest 通过，前端零改动、tsc 0 错误。

- [x] **3.3 `backend/app/services/pdf_service.py:612, 635`（及 560-587 覆盖翻译路径）**
  降级/覆盖翻译在 async 生成器里直接跑同步重活（全文抽取、fitz 逐页、reportlab 写盘），阻塞整个事件循环 → /api/health 无法响应，前端判「离线」。
  方向：所有同步重调用 `await asyncio.to_thread(…)`（编辑/批注路由已是正确示范）。

- [x] **3.4 `src/components/PDFViewer.tsx:223-225`（另 :144 已渲染页不回收）**
  每页加载即分配 canvas 位图（~2.8MB/页），渲染后永不释放 → 长 PDF × 8 标签页 → GB 级内存。
  方向：canvas 尺寸延迟到进入视口再分配；远离视口的页释放位图保留 div。
  已修：位图延迟到进入 ±900px 预取区才分配；双 IntersectionObserver，离开 ±3000px 回收区释放位图与文本层、保留占位 div（epoch + RenderTask.cancel 防竞态）。验收（300+ 页滚动内存不随滚动增长）待用户冒烟。

- [x] **3.5 `src/services/pdf.ts:12, 36`**
  整份 PDF 以 `number[]` JSON 走 IPC：8~16 倍内存放大 + 巨慢序列化（上传上限 200MB）→ 大文件卡死或 OOM。
  方向：Rust 侧 `tauri::ipc::Response`/字节通道传 `Vec<u8>`，或临时文件 + plugin-fs。
  已修（选型 A：ipc::Response + Request 裸字节通道；临时文件 + plugin-fs 方案经对比弃用，
  理由：plugin-fs 未注册需新增 Rust 依赖 + scope 配置，且其裸字节能力本就来自同一套机制）：
  读路径 `read_pdf_file` 改返回 `tauri::ipc::Response`，前端收 ArrayBuffer（number[] 仅作防御兜底）；
  写路径 `write_file` 改收 `tauri::ipc::Request`，字节以裸请求体（octet-stream）传输、
  路径经请求头 percent 编码传入（与 tauri-plugin-fs 的 write_file 同款机制，
  tauri 2 内置，零新依赖）；手写 `percent_decode` 配套集成测试（`src-tauri/tests/percent_decode.rs`）。
  200MB 文件内存峰值从 ~3.5-4GB（Rust JSON 串 + V8 number[] + Value 中间态）降到 ~450MB，
  传输耗时从数十秒/卡死降到 ~1-2s。write_file 保留 Json(number[]) 兜底分支仅作防御。
  上传后端的 HTTP 路径（FormData+Blob）本就是二进制传输，不在本条范围，未动。
  附带：`src-tauri/build.rs` 把 winres 资源档（含应用清单）以 `rustc-link-arg-tests` 链给测试目标——
  否则测试 exe 缺 comctl32 v6 激活，加载即 0xc0000139（tauri-build 只发 bins，上游同款坑）；
  为此把测试放 `tests/` 集成测试目录（cargo 拒收该指令除非包内有显式测试目标）。
  待用户冒烟：大文件（数十~200MB）拖入打开 → 编辑器保存 → 导出，确认无卡顿、内存峰值 ~0.5GB 量级。

- [x] **3.6 `src-tauri/src/lib.rs:79-82`**
  后端拉起一次性 fire-and-forget：运行中崩溃无任何重拉路径；发布版无控制台，只能重启整个应用。
  方向：监听子进程退出事件并限次重拉，或前端提供「重启后端」按钮。
  已修：消费 spawn() 返回的 Receiver 监听 CommandEvent::Terminated（事件驱动，不轮询）；
  限 3 次重拉、退避 2/4/8s、上一实例存活 ≥60s 才崩则计数器清零；耗尽后 emit 事件，
  离线卡显示退出码与日志路径（backend.log 崩溃详情 + backend-restart.log 重启轨迹，
  均在 %LOCALAPPDATA%\PDF Reader Translate\）。新增 restart_backend 命令 + 离线卡「重启后端」
  按钮，强制换新语义：先按 PID 杀进程树再拉起，不做探活短路（health 200 ≠ 健康）；
  只杀本应用持有句柄的进程，外部后端返回可读错误。前端新增 'reconnecting' 状态（蓝条显示
  重启进度），轮询在该状态下不降级为 offline，恢复仍由 /api/health 轮询判定。
  epoch 机制防止新旧 watcher 各自重拉混战；关窗置 ShuttingDown 标志，退出时不触发重拉。
  待用户冒烟：杀后端进程看蓝条→变绿；连续崩溃 3 次落黄卡；正常关窗无多余重启。

---

## 批次 4：代码味道（8 条，隐患清完稳定运行后再处理）

- [ ] **4.1 `backend/app/api/pdf_edit.py:43-45, 58-64`** — _edit_dir 缺 isalnum() 校验（非法 edit_id 应 400 而非 500）；analyze 失败残留上传目录。修复：复用 pdf_annot._work 的校验；失败路径 remove_path。
- [ ] **4.2 `src/components/PdfAnnotator/index.tsx:312`** — 会话失效重试依赖错误文案正则 `/会话|重新打开|404/`，后端改文案即静默失效。修复：按 HTTP 状态码 404 判断。
- [ ] **4.3 `src/components/PdfAnnotator/AnnotPage.tsx:128`** — 渲染 effect 依赖内联 reportHasText，父组件重渲染取消重启进行中的页渲染。修复：useCallback 稳定化或移出依赖。
- [ ] **4.4 `src/components/PdfAnnotator/AnnotPage.tsx:160`**【需运行时验证】— 画笔 move 用渲染闭包里的旧 draft 追加点，高刷快速划动可能丢点。修复：函数式 `setDraft(d => …)`。
- [ ] **4.5 `src/services/annotStash.ts:71-76`** — docKey 对整份 PDF 多做一次全量拷贝（bytes.slice(0)），大文件多上百 MB。修复：digest 直接接收原数组（只读用途）。
- [ ] **4.6 `src/App.tsx:168-170, 466-471`** — 多文件拖入提示被成功路径 `setDropError('')` 立即清空；DropErrorBanner 的 onDismiss 内联导致 3 秒计时反复重置。修复：成功路径仅在无提示时清空；onDismiss 用 useCallback。
- [ ] **4.7 `src/components/PDFViewer.tsx:418, 403-405`** — 页码输入框 onBlur 无条件跳转；导出失败只 console.error。修复：仅回车/失焦且值变化时跳转；失败给 toast。
- [ ] **4.8 `backend/app/services/pdf_service.py:539`** — 独立「生成译文 PDF」也走 generate_overlay_translation，首条进度从 0.65 起、文案是「切换为覆盖翻译模式」。修复：入口区分，独立任务从 0 报进度、用中性文案。

---

## 附 1：已排除的假阳性（复核不成立，勿重复上报）

- 「切标签丢失翻译 done 事件」（useTranslateTask.ts:87）：不成立——后端 /progress 对已完成任务会重放 last_event，切回标签即自愈。
- 「annotStash 暴露内部数组引用导致静默丢失」：所有状态更新均为纯函数式（生成新数组），无原地 mutation。
- 「导入的画笔批注解析错误」：实测 PyMuPDF 1.25.2 的 ink.vertices 确实返回逐笔画嵌套列表，_import_annot 的写法是对的。

## 附 2：未覆盖范围（知晓即可）

- pdf2zh/babeldoc/pdf.js 等第三方库内部不在审计范围。
- src-tauri/capabilities 权限清单：read_pdf_file/write_file 只校验 .pdf 扩展名，可读写本机任意位置 PDF——桌面应用属合理信任域，但值得知晓。
