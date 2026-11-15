<p align="center">
  <img src="assets/banner.svg" alt="DS Silky — A smoother space to think." width="100%" />
</p>

<p align="center">
  让 DeepSeek Harness 的文字，顺着思路流动。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kafukatree/ds-silky">npm</a> ·
  <a href="#安装">安装</a> ·
  <a href="#体验">体验</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="DEVELOPMENT.md">开发说明</a>
</p>

---

**DS Silky** 让 DeepSeek Harness 的流式回答读起来更连贯：文字逐步淡入，段落依次展开，行内代码跟着句子一起出现。

## 体验

<p align="center">
  <img src="assets/streaming-demo.gif" alt="DS Silky 流式输出演示：文字连续淡入，段落按顺序展开，行内代码随正文出现" width="900" />
</p>

<sub>由实际插件在 Chromium 中渲染并录制，使用模拟的不规则数据到达；保留录制时长，无加速。独立演示，不是真实桌面录屏。动图循环播放，静态预览见下方。</sub>

<details>
<summary>查看静态预览</summary>

![流式回答完成后的静态画面](assets/streaming-still.png)

</details>

上游有时连续送来几个字，有时停一下再送来一整句。DS Silky 根据到达节奏调节呈现速度，用短暂缓冲减少突兀的成批出现。上一段的尾部完成淡入后，下一段再开始；宿主重绘文字时，也尽量接续已有进度。

- **连贯而不拖沓。** 自适应呈现节奏，输出结束后及时收尾；网络长时间停顿仍会等待真实内容。
- **保持阅读顺序。** 正文与行内代码共用文字进度，减少格式变化带来的不同步。
- **尊重你的操作。** 选中文字时避开淡入，系统开启“减少动态效果”时关闭动画。

排版、提问卡、文件交付和终端样式也做了统一整理，让文字成为界面的重点。

不改变模型或回答内容，不需要替换应用。插件以预构建客户端脚本加载，没有新增运行时依赖或外部字体请求。

## 安装

在 DeepSeek Harness 的插件管理界面搜索 **`@kafukatree/ds-silky`** 并安装。支持命令行的环境，也可以安装到已有的桌面 profile：

```bash
dsh plugin --profile desktop add @kafukatree/ds-silky
```

安装后按 **⌘R** 重载 macOS 窗口；若仍使用旧版，完全退出应用再启动。其他系统使用应用提供的重载方式。若你使用自定义 profile，将命令中的 `desktop` 换成对应名称。

也可以从 [GitHub Releases](https://github.com/KafukaTree/ds-silky/releases) 下载 `.tgz` 发布包，再安装本地文件：

```bash
dsh plugin --profile desktop add ./kafukatree-ds-silky-0.20.3.tgz
```

### 从旧版迁移

DS Silky 原名 `dsh-anthropic-fonts`。安装新版前，在插件管理中停用旧版，避免两份插件同时启用。如果旧版是通过 CLI 安装到同一 profile，可移除旧包：

```bash
dsh plugin --profile desktop remove dsh-anthropic-fonts
```

若旧版是手工加入本地配置的，请停用那条旧配置；不需要删除自己的源码备份。新版保留旧的内部样式与清理标识，帮助热替换时释放已有状态。

### 卸载

```bash
dsh plugin --profile desktop remove @kafukatree/ds-silky
```

随后重载窗口，恢复宿主样式。

## 兼容性

- 宿主声明要求 **DeepSeek Harness ≥ 0.2.2-rc.1**；当前适配依据为 **0.2.2-rc.2** 的源码与已观察结构。
- 插件引用宿主的部分编译类名。宿主升级后可能需要更新适配，版本范围不代表已验证未来版本。
- 字体遵循 DSH 设置及系统回退。仓库不分发字体文件；未安装的字体会回退到可用字体。
- 独立 Chromium 回归覆盖流式、展开收起、热替换与资源清理；真实 React 高亮桥、整应用交互和长期性能仍需实际环境验证。

## 开发

需要 **Node.js 22+**；浏览器回归还需要本机 **Google Chrome**。构建与测试使用 Node 内置模块，无需安装构建依赖。

```bash
npm run build
```

```bash
npm run verify
```

维护 `src/`，不要直接修改生成文件 `lib/client.js`。构建检查宿主适配引用、版本、语法、CSS 基线与产物体积；测试检查生成文件与源码是否一致。

源码按职责拆分，发布时仍组装为一个闭包；共享状态与清理顺序见 [开发说明](DEVELOPMENT.md)。

## 反馈

在 [Issues](https://github.com/KafukaTree/ds-silky/issues) 中提供 DSH 版本、操作系统、复现步骤和截图即可。涉及流式问题时，短录屏通常比静态截图更有帮助；请先移除会话中的私人内容。

---

MIT License · 一个面向 DeepSeek Harness 的社区插件，非官方产品。
