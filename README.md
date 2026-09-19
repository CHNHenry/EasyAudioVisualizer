# EasyAudioVisualizer

网易云音乐（BetterNCM / Chromatic）插件：在播放页进度条上方显示经科学信号处理的实时频谱可视化。

信号处理移植自 [sound-processor](https://github.com/takaspot/sound-processor)（A计权、时间计权、高斯滤波、倍频程划分），并额外实现了**多分辨率分体 FFT**（恒Q近似：低频走 8192 求清晰、高频走 512 求迅速）。

## 特性

- 彩色频谱柱叠加在播放页进度条上方，左右无留白、自动跟随窗口与页面切换
- 接管 `<audio>` 元素获取精确频谱（声音经处理回路原样连回扬声器，不影响播放）
- 全部信号处理参数可在插件设置页调整并持久化：
  sampleRate / fftSize / 起止频率 / 输出频带数 / 时间计权 / A计权 / 高斯滤波（sigma、radius）/ 多分辨率分体 / 柱形最大高度

## 安装

1. 安装 [BetterNCM](https://github.com/MicroCBer/BetterNCM)（或 Chromatic）
2. 从 [Releases](https://github.com/CHNHenry/EasyAudioVisualizer/releases) 下载 `EasyAudioVisualizer.bmc`
3. 将 `.bmc` 文件拖入网易云音乐窗口，或在插件管理器中安装

## 开发

```bash
npm install
npm run build   # esbuild 打包 main.js + 生成 EasyAudioVisualizer.bmc
```

本地调试：把项目文件夹链接到 BetterNCM 的 `plugins_dev` 目录：

```powershell
mklink /J "<BetterNCM数据目录>\plugins_dev\EasyAudioVisualizer" "<本仓库路径>"
```

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
| multiFFT | 多分辨率分体 FFT（8192/2048/512，恒Q近似） |
| maxHeight | 柱形条群最大高度（px） |

## 已知限制

- 插件通过启发式选择器定位播放页进度条，网易云音乐版本更新可能导致定位偏移；定位失败时自动退到主界面底部播放栏上方
- 接管 audio 元素会替换原声输出通路，如遇音量异常可禁用本插件排查

## License

MIT
