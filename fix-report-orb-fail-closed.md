# 修复报告：fail-closed 降级（分支 fix/orb-fail-closed）

## 分支与范围
- 从 `main`（`796a9fd`）新建 **`fix/orb-fail-closed`**；旧的 `fix/orb-motion-and-diagnostics`（`f4d3fb4`）原样保留，未动。
- 改动目前**未提交**（工作区 8 个文件修改 + 1 个新测试文件）。
- 只做清单里的「必改 + 建议改」；可选第 3 项（静态海报优先 + 异步升级）没做。

## 1. 必改：gpu-probe.ts fail-closed
`web/src/lib/gpu-probe.ts` 的 `looksLikeSoftwareRenderer` 由 fail-open 改为 fail-closed：
`null` / `""` 一律返回 `true`（拿不到 renderer 字符串 = 无法证明硬件，按软件处理）。

- Firefox 自 2020 起屏蔽 `WEBGL_debug_renderer_info`，null 是正常返回值。
- 连带影响（有意取舍的副作用）：
  - 桌面宽屏本来就走静态场景（`main.tsx` 的 `wideDevice` 分支），行为不变。
  - **窄屏 Firefox / 部分隐私模式 Chromium 首次访问**：`isSoftwareGpu()` 现在为 true → 首访默认静态场景 + quality reduced，并 seed `ORB_DEGRADED_KEY`。若不想让非 orb 逻辑也 fail-closed，可把该判断收窄为 orb 专用。
- 新增测试 `web/src/lib/gpu-probe.test.ts`（3 例）：`null`/`""` → true；SwiftShader / llvmpipe / ANGLE-SwiftShader → true；Apple M2 / Intel UHD 630 → false。

## 2. 建议改（一）：WebGPU adapter 为 null 时显式降级
清单里的 `reportOrbBackend()` 在 main 上不存在，按等价语义实现：

- `vendor/ler-sent001-orb/orb-renderer.ts`：`OrbRendererOptions` 新增 `onUnavailable?: (detail: string) => void`；`requestAdapter()` **resolve 为 null** 时调用 `onUnavailable("webgpu-adapter-null")` 后直接返回，不再走 WebGL2。
- `OrbRenderer.ts`：`OrbRendererBackend` 增加 `"static"`；init 传入 `onUnavailable: () => resolve("static")`。
- `AssistantOrb.tsx`：`.then` 收到 `"static"` 时把能力切到 static（reason「WebGPU 适配器不可用，已降级为静态悬浮球」），不创建任何 GPU 上下文。
- 为什么不是清单里的 `.catch(() => null)`：请求**超时/异常**仍应走既有的 WebGL2 兜底（`initTimeoutMs: 2000` 安全网），只有「适配器明确不存在」才判不可用——区分「没有适配器」与「请求失败」。
- 后端记录：`orb-capability.ts` 新增 `ORB_BACKEND_KEY = "msf-assistant-orb-backend"`、`ORB_BACKEND_REASON_KEY = "msf-assistant-orb-backend-reason"`、`writeOrbBackend(backend, reason?)`（storage 异常静默）。取值 `webgpu` / `webgl2` / `static`；reason 为 `device-probe`（静态探针降级）、`webgpu-adapter-null`（适配器缺失）、`measured-slow`（运行时实测过慢）。自查：devtools 里看这两个 key。
- 注意：adapter-null **不**写 `ORB_DEGRADED_KEY`（不把设备永久判死），下次仍会快速探测（requestAdapter 返回 null 很便宜）。

## 3. 建议改（二）：SlowRenderGuard 首帧即判定
`render-guard.ts`：`isFirstFrame = lastRenderAt === 0`；
`degrade = (isFirstFrame && slowCostStreak >= 1) || slowCostStreak >= 2 || slowGapStreak >= 10`。

- 首帧成本 ≥ 150ms 立即降级（首帧可能阻塞数秒，且判定跑在被阻塞的同一主线程上，等不到第二帧）；之后仍要求连续 2 帧贵帧；gap 规则不变。
- 副作用：首帧降级发生在 `onReady()` 之前，`OrbRenderer.init` 的 Promise 不再 settle；但 `onTooSlow` 已把 UI 切 static 并销毁 renderer，pending Promise 无未处理拒绝，安全（既有「ready 前降级」路径本来就如此）。
- 测试重写 `render-guard.test.ts`（6 例）：首帧贵帧立即降级；健康首帧后需两连贵帧；晚到单尖峰不降级；gap 三例保留。

## 验证结果
- `npm run typecheck` → exit 0
- `npm run test` → **62 文件 / 307 用例全过**（含新增 gpu-probe.test.ts；定向跑 3 个相关文件 20 用例全过）
- `npm run build` → vite build 成功（11.91s），产物写入 `internal/server/web/dist/`
- **未跑 go build / fpk**：本机 PATH 里没有 Go 工具链。现有 `dist/msf_0.6.12_x86.fpk` 是旧二进制（嵌旧 web dist）。要在 NAS 上试，需在有 Go 的机器重建：`GOCACHE=/tmp/gocache-msf CGO_ENABLED=0 go build -trimpath -o dist/msf-linux-amd64 ./cmd/msf`，再按原流程打 fpk。

## 与旧分支的关系
- 旧分支 `f4d3fb4`：7 文件 +284/−23，「两级降级（motionless/lite）+ 诊断面板」方案；新分支是清单的最小补丁（8 文件 +110/−47，另加 1 个测试文件），两者不冲突、可对比。

## 4. 打包产物（本次，VERSION=0.6.13）
- 工具链：`/tmp/go/bin/go` = go1.24.13（满足 go.mod 的 `go 1.24.13`），`GOCACHE=/tmp/gocache-msf`，`GOPATH=/vol1/@appshare/Harness/go`，fnpack 用缓存 `~/.cache/fnpack/fnpack-1.2.1-linux-amd64`。
- 二进制：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=true -trimpath -ldflags "$LDFLAGS" -o dist/msf-linux-amd64 ./cmd/msf`
  - `dist/msf-linux-amd64`（35,696,824 字节，md5 `4b3a29ce7840ac7bb600adaa264806a8`）
  - `./dist/msf-linux-amd64 version` → `msf 0.6.13 commit=796a9fd30be8f39cb1064a3f6ef46545429425bc tag=v0.6.13 source=796a9fd30be8f39cb1064a3f6ef46545429425bc dirty=true`
- 安装包：`APP_NAME=msf VERSION=0.6.13 DIST=dist ARCH=amd64 packaging/fnos/build-fpk.sh` → `dist/msf_0.6.13_x86.fpk`（13,986,849 字节）。
- 包内一致性：fpk 根 = `manifest` / `app.tgz` / `cmd/` / `config/` / `wizard/` / `ICON*.PNG`；`app.tgz` md5 前 16 位 `215f504721a90539` 恰好等于 manifest 的 `checksum`（fnOS 按 app.tgz 记校验，不是二进制 md5，属预期）；`app.tgz` 内 `msf` 与 `dist/msf-linux-amd64` 的 md5 完全一致。
- 运行时验证：用临时数据目录 `./dist/msf-linux-amd64 serve -c <tmp> -p 18081` 起服务，`curl /assets/AppShell-DAPmzZwV.js` 命中 `msf-assistant-orb-backend`，`/` 正常返回 index.html；不影响正在运行的 7777 服务。
- 版本 0.6.13 的理由：与已存在的 0.6.12 产物区分、避免覆盖，fnOS 应用中心可直接覆盖安装；旧 `dist/msf_0.6.12_x86.fpk` 保留未动。
- 注意：二进制标记 `dirty=true`、commit 796a9fd —— 改动尚未提交，属本地测试包；要出正式版需先 commit 再用干净工作树重打。

---

# 0.6.14：堵住「设置里选动态球」绕过全部保护（装机后仍卡的真凶）

## 用户现场
装 0.6.13 后仍然卡；用户在设置里把悬浮球/场景切成**静态**后不再卡。→ 证实动态渲染路径就是冻结源，且 0.6.13 的保护可被服务端 `orb_mode=dynamic` 绕过。

## 根因（两条，均已定位到行）
1. **`AssistantOrb.tsx:72`（0.6.13 及以前）**：`if (mode !== "auto") clearDegraded();` + `initialCapability(mode)`。
   只要后端设置是 `dynamic`，**每次挂载都清掉 `ORB_DEGRADED_KEY` 降级记录**并强制动态渲染——0.6.13 的软件渲染 fail-closed、弱设备判定、首帧守卫的持久化全部被这条绕过。于是每次刷新重新冻结一次，用户观感就是「一直卡」。
2. **`orb-capability.ts:54`（0.6.13 及以前）**：`preference === "dynamic"` 在**所有安全判定之前**直接 return dynamic，连「软件渲染 / 读不到 GPU 字符串」这种硬件事实都不看。

## 0.6.14 改动
### `web/src/components/assistant/orb/orb-capability.ts`
- `resolveOrbCapability` 重排判定顺序：`static` → `embedded` → **`looksLikeSoftwareRenderer`（硬件事实，含 null fail-closed，连显式 dynamic 也否决）** → `dynamic` → `reducedMotion` → `isWeakDevice` → dynamic。
  即：显式 dynamic 仍可在「已验证的真实 GPU」上强制动画（保留用户意图），但绝不能把重着色器塞给软件光栅化器。
- 新增 `ORB_SAFE_MODE_KEY = "msf-assistant-orb-safe"`、`OrbStartupInput`、`OrbStartupDecision`、`resolveOrbStartup()`：
  - `degraded=true` 时**无论 auto 还是 dynamic** 都启动 static，且 `clearDegraded=false`（跨刷新生效）；
  - `safeMode=true`（`?safe=1` 写入）时钉死 static，`clearSafe=false`；
  - `explicitChoice=true`（**仅当 mode 在挂载期间真的变化**，即用户刚在设置里保存了新选择）才允许一次有意的 dynamic 重试，且只有重试**确实进入 dynamic** 时才 `clearDegraded/clearSafe=true`；若重试仍被硬件事实否决，记录保留。

### `web/src/components/assistant/orb/AssistantOrb.tsx`
- 删除 `initialCapability()` 与挂载时的无条件 `clearDegraded()`；改用 `decideCapability(mode, explicitChoice)` + `prevModeRef` 计算 `explicitChoice`。
- `LOW_POWER_EVENT` 处理去掉 `if (mode === "auto")` 限制：整页 watchdog 判定掉帧时，**即使服务端强制 dynamic 也立即转静态**。

### `web/src/components/assistant/AssistantWidget.tsx`
- 新增 `?ai=off` / `?ai=on` 逃生口（`AI_DISABLED_KEY = "msf-assistant-disabled"`，localStorage 持久、仅本浏览器）：冻结到进不了设置时，直接开 `?ai=off` 就能整块隐藏助手（球 + 面板）。`?ai=on` 恢复。

### `web/src/main.tsx`
- `?safe=1` 现在同时写 `ORB_SAFE_MODE_KEY`，即一次 `?safe=1` 把**场景 + 悬浮球**一起钉成静态，而不是只压场景。

### 测试 `orb-capability.test.ts`
- 改写 1 例、新增 8 例（共 20 例）：软件渲染下显式 dynamic 仍 static；renderer 字符串被屏蔽时仍 static；真实 GPU 上显式 dynamic 生效；`resolveOrbStartup` 覆盖「dynamic+degraded 刷新仍 static」「显式重试清记录」「重试被否决不清记录」「safe 钉死」「显式选择解除 safe」「static 永不清记录」。

## 验证
- `npm run typecheck` → exit 0
- `npx vitest run` 三个相关文件 → 29 例全过；`npm run test` → **62 文件 / 316 用例全过**
- `npm run build` → vite build 成功（10.51s），产物 `AppShell-DagP_D7m.js` / `index-QuvnSyI8.js`
- `go build` 0.6.14 + `build-fpk.sh` → `dist/msf_0.6.14_x86.fpk`（13,986,949 字节）
  - `./dist/msf-linux-amd64 version` → `msf 0.6.14 commit=796a9fd… tag=v0.6.14 dirty=true`
  - fpk 内 `app.tgz` md5 = `f22a7de2f3fda5a69c6bad9fbebd55a7` = manifest checksum；`app.tgz` 内 `msf` 与 `dist/msf-linux-amd64` md5 一致（`8b5b8166…`）
  - 临时目录起服务 `-p 18083`，HTTP 拉 `assets/AppShell-DagP_D7m.js` 命中 `msf-assistant-disabled`；未触碰 7777

## 用户可用的三条逃生路径
1. **服务端真关**：设置 → AI 助手 → 取消勾选「启用」→ 保存（推荐，所有浏览器生效）
2. **本浏览器临时关**：`http://<nas>:7777/?ai=off`（0.6.14+），恢复用 `?ai=on`
3. **一键安全模式**：`http://<nas>:7777/?safe=1`（0.6.13+，0.6.14 起同时锁静态球）
