# EasyAudioVisualizer

网易云音乐（BetterNCM）插件：在播放页进度条上方显示经科学信号处理的实时频谱可视化。

信号处理移植自 [sound-processor](https://github.com/woshizja/sound-processor)（A 计权、时间计权、高斯滤波、倍频程划分），并额外实现了**多分辨率分体 FFT**（恒 Q 近似：低频走 8192 求清晰、高频走 512 求迅速，支路接缝做 3dB/倍频程 校准）。

## 特性

- 频谱柱叠加在播放页进度条上方，左右无留白、自动跟随窗口与页面切换；也可退到底部播放栏上沿显示
- **数据源自动协商，不强依赖任何插件**：
  - 优先使用 [LibFrontendPlay](https://github.com/MicroCBer/LibFrontendPlay)（每首歌重建 AudioContext 时自动跟随，带音量电平补偿）
  - 未安装 LibFrontendPlay 时自动接管 `<audio>` 元素（声音经分析回路原样连回扬声器，不影响播放）
  - 元素被页面移除/替换时自动重新挂钩；运行时信息面板实时显示当前数据源
- 三种颜色模式：白色半透明（辉光随响度）/ 进度条颜色（读取播放页进度条的封面衍生填充色，随歌曲主题联动）/ 蓝紫红渐变
- 全部信号处理参数可在插件设置页调整并持久化，改动即时生效（重建处理器，不中断播放）

## 安装

### 方式一：插件市场（推荐）

BetterNCM 设置 → 插件管理 → 在线插件市场中搜索 `EasyAudioVisualizer`。

### 方式二：手动安装

1. 安装 [BetterNCM](https://github.com/MicroCBer/BetterNCM)
2. 从 [Releases](https://github.com/CHNHenry/EasyAudioVisualizer/releases) 下载 `EasyAudioVisualizer.bmc`
3. 将 `.bmc` 文件放进 BetterNCM 的 `plugins` 目录（或直接拖入网易云窗口）

> 提示：LibFrontendPlay 不是必需依赖，但没有它时数据来自 audio 元素接管，音量较低时建议在设置页开启「音量电平补偿」以外的默认项即可。

## 设置项说明

| 设置项 | 说明 |
|---|---|
| sampleRate | 参与频点带宽与倍频程索引计算，留空自动取真实采样率（推荐） |
| fftSize | FFT 窗口：越大低频越细、响应越慢；multiFFT 开启时忽略 |
| startFrequency / endFrequency | 倍频程划分频段（start 不能为 0） |
| outBandsQty | 输出频带数 = 柱子数量 |
| tWeight | 时间计权：5 帧均值，画面更平滑 |
| aWeight | A 计权：模拟人耳频率敏感度 |
| filterOn + sigma / radius | 高斯滤波抹平频点突刺 |
| multiFFT | 多分辨率分体 FFT（默认 8192/2048/512，恒 Q 近似）；开启后忽略 fftSize 与高斯滤波 |
| mfLowMid / mfMidHigh | multiFFT 低/中、中/高频段分界线 |
| mfLowFft / mfMidFft / mfHighFft | multiFFT 各支路窗长 |
| volumeComp | LFP 音量电平补偿：按 1/音量 增益补偿，频谱形态与音量设置无关 |
| playPageOnly | 仅在播放页显示（推荐开启） |
| maxHeight | 柱形条群最大高度（px） |
| colorMode | 颜色模式：white / progress / color |
| opacity | 柱形条不透明度 |
| yOffset | 频谱底边相对进度条顶边的垂直微调（px） |

设置页底部有「运行时信息」面板，实时显示数据源、锚点模式、生效采样率、支路分配等调试信息。

## 已知限制

- 插件通过启发式选择器定位播放页进度条，网易云音乐版本更新可能导致定位偏移；定位失败时自动退到主界面底部播放栏上方
- 接管 audio 元素会替换原声输出通路（同一元素只能被接管一次），如遇声音异常可禁用本插件排查
- colorMode=progress 依赖播放页进度条滑条的 `--track-color` CSS 变量，NCM 更新样式结构后可能读不到（自动沿用最后一次取到的颜色）

## 开发

```bash
npm install
npm run build   # esbuild 打包 main.js（提交到仓库，供市场自动打包）+ 生成 EasyAudioVisualizer.bmc
```

本地调试：把项目文件夹链接到 BetterNCM 的 `plugins_dev` 目录：

```powershell
mklink /J "<BetterNCM数据目录>\plugins_dev\EasyAudioVisualizer" "<本仓库路径>"
```

## 插件市场收录

本插件已提交至 [BetterNCM 插件库](https://github.com/MicroCBer/betterncm-packed-plugins)（`plugins-list/easy-audio-visualizer.json` 指向本仓库）。市场脚本自动抓取 `manifest.json` 中的版本号，因此发布新版只需：更新版本号 → `npm run build` → 提交 `main.js` 与 `manifest.json` → 推送 → 打 Release。仓库内的 `.betterncm-ignore` 用于从打包结果中过滤源码等非运行时文件。

## License

MIT
