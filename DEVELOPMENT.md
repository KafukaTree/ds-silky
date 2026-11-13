# 开发与验证

0.19.0 起维护 `src/`，`lib/client.js` 是生成产物，宿主仍只加载这一个文件。构建仅依赖 Node 22+ 内置模块，不新增运行时依赖，也不增加页面请求。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `src/manifest.json` | 源码装配顺序及 CSS 级联顺序 |
| `src/constants.js` | 插件 DOM 标识；版本由 package.json 注入 |
| `src/fonts.js` | 字体目录、分类、查询与值替换的纯逻辑 |
| `src/font-picker.js` | 字体菜单、输入交互、布局、ARIA 和 RAF 所有权 |
| `src/feedback.js` | 复制点击反馈与文件图标标记 |
| `src/lifecycle.js` | 唯一 start/dispose 装配入口、HMR 所有权 |
| `src/highlight.js` | inspect 载荷的语言识别、宿主 React 高亮桥和 DOM 应用 |
| `src/resize.js` | 侧栏拖动时暂停与恢复布局工作 |
| `src/has-freeze.js` | 流式和弹层期间的宿主规则保存、冻结与恢复 |
| `src/scroll-cull.js` | 历史行测高、离屏裁剪、选区恢复 |
| `src/stream-fade.js` | 字符前沿、边界等待、Range 绘制、过程行与 disclosure |
| `src/styles/` | 按主题组织的十个样式片段 |
| `src/host-selectors.json` | 212 个类名选择器／片段，构建期展开 |
| `scripts/build.mjs` | 适配展开、版本注入、语法校验、预算和原子替换 |
| `tests/unit/` | 字体纯逻辑、构建和 CSS 等价护栏 |
| `tests/browser/` | 独立 Chromium 行为回归与结果 |

## 开发流程

在插件目录执行：

```bash
npm run build
```

```bash
npm run verify
```

`verify` 先检查生成文件是否与源码一致，再跑 Node 测试和独立 Chromium 回归。直接改 `lib/client.js` 会导致检查失败。仅验证构建一致性用 `npm run check`，仅跑浏览器用 `npm run test:browser`。

构建在写入前完成适配项、版本、完整脚本语法和预算校验，随后通过同目录临时文件 rename 替换入口。相同源码生成相同产物；版本仅维护 `package.json`，更新说明另写入 README。

浏览器测试默认启动独立 headless Chrome，使用随机调试端口和临时 profile，结束后关闭并清理。macOS 默认使用 Google Chrome 的标准安装路径；其他安装位置通过 `CHROME_PATH` 指定。也可以向运行器传 CDP HTTP origin，它仍然只操作自己新建的页面，不借用已有标签页，不连接真实 DSH 会话。

```bash
npm run test:browser -- http://127.0.0.1:9222
```

结果保存为 `tests/browser/results.json`，包含版本、客户端源码 SHA-256、时间、通过项和错误。开始运行即覆盖旧结果；失败不会继续展示旧的成功报告。

## 宿主适配约定

源码中的 `@host(toolRow.ioCard.contains)` 在构建时展开为原来的 `[class*="UHhYua_ioCard"]`。`contains` 和 `exact` 分别保留子串匹配和完整 class token 匹配的原始语义，不能随意互换。`fragment.*` 是宿主通用类名片段，并不保证稳定。

新增类名选择器先登记适配表，再引用；直接在源码里写 class 属性选择器、未知适配项、无用适配项都会使构建失败。能用稳定 `data-*` 钩子的新增规则优先使用稳定钩子，避免为了匹配成功而扩大选择器范围。

适配表的依据是当前宿主 0.2.2-rc.2 源码与已观察 DOM。集中管理让升级时有明确核对位置，**不代表自动兼容未来宿主**。宿主升级后需核对类名和 DOM 结构，并在真实窗口检查。

## CSS 顺序与预算

0.19.0 重构保留全部 CSS 规则和原来的级联顺序。0.19.1 按用户反馈调整提问卡字体层级和交付卡容器尺寸，经独立预览核对后更新 CSS 基线。单元测试固定去掉行首尾空白与空行后的完整 CSS SHA-256，防止意外改变规则。以后有意调整外观时，应先检查视觉差异，再更新这项基线；不能为了让检查通过直接换 hash。

`manifest.json` 中的顺序属于行为，不应按字母排序。样式文件内历史规则仍可能互相覆盖，不能仅因前面的声明看似重复就删除。

`scripts/budgets.json` 限制客户端 245,000 字节、CSS 110,000 字节、适配项 220 个。阈值来自 0.18.7 体积和当前适配数量，是增长护栏，不是 INP 或帧率承诺。0.19.0 体积减少主要来自缩进与头注释整理；没有据此宣称运行时提速。

## 生命周期约定

字体菜单和复制反馈有 install/stop 配对；stop 负责释放监听、RAF／timer 和自己拥有的临时状态。菜单在丢弃 input 引用之前关闭，恢复其 ARIA；删除锚点的监测始终只有一条 RAF 链。

销毁顺序不能机械地改成逆序栈：先 `rsStop()` 结束拖动，因为恢复拖动可能重新安排高亮和流式工作；随后再停对应消费者。流式 observer 仍转发 has-freeze 事件，所以 `sfStop()` 同时调用 `hfDispose()`。HMR 旧实例 disposer 不能删掉新实例。

## 架构与验证边界

这里采用**按职责拆分源码、构建时装配为同一个闭包**的渐进整理，不是彻底独立的 ES 模块。流式、拖动和样式冻结仍共享状态；保留这种耦合避免改动已验证的调度顺序。`stream-fade.js` 仍是最大的源码文件。

独立 fixture 模拟宿主 DOM 和加载器，不能替代真实 React 应用。尤其真实 Shiki bridge、真实菜单提交与长期会话性能不在这些结果的完整覆盖范围内。本轮没有重新测 INP、长任务或长会话堆内存。

## 品牌与包身份

展示名称由 `locale/en.json` 和 `locale/zh.json` 的 `meta.title` 提供。图标通过 `package.json` 的 `icon` 与 `./icon` 导出提供。客户端注册 ID 从 `package.json.name` 生成，必须与宿主解析的包名一致。

`dsh-anthropic-fonts` 样式标识、`__dshAnthropicFonts` 调试入口和 `daf-*` 内部标识继续保留，以复用现有卸载与热替换逻辑。它们不是展示名称。旧版与新版不应同时在配置中启用；升级时先停用旧版。

## 发布与回滚

运行 `npm run verify` 后执行 `npm pack` 检查发布包。`prepack` 会重建入口并运行单元检查；浏览器回归需单独通过。发布包包含预构建入口、源码、测试、文档及品牌资产，不包含测试结果和旧客户端备份。

出现兼容问题时先停用插件并重载窗口。回滚到已有发布版本可通过 `dsh plugin --profile desktop add @kafukatree/ds-silky@<version>` 安装指定版本；使用其他 profile 时替换名称。首次公开发布为 0.20.0，旧的私有版本没有对应的 npm 发布。
