// 可视化：数据源（依赖 LibFrontendPlay）+ 播放页进度条上方频谱叠加
// 无任何调试 I/O：帧循环零 DOM 查询，定位走 500ms 低频心跳
import { SoundProcessor } from './processor.js';
import { MultiResolutionFFT } from './multi-fft.js';

const TAG = '[EasyAudioVisualizer]';

function detectLFP() {
    return typeof loadedPlugins !== 'undefined'
        && loadedPlugins
        && loadedPlugins.LibFrontendPlay
        && typeof loadedPlugins.LibFrontendPlay.getFFTData === 'function';
}

export function createVisualizer(cfg) {
    const state = {
        ac: null,
        source: null,
        analyser: null,
        tierAnalysers: null,
        tierBuffers: null,
        tierSizes: null, // 当前支路 fftSize 配置（变化时重建支路）
        processor: null,
        multiProcessor: null,
        anchor: null,
        anchorMode: null,
        colorEl: null, // 最近一次的大进度条滑条元素（取色用，播放页外仍复用）
        colorElSmall: null, // 小进度条（底部播放栏滑条）元素
        accentBig: null,   // 大进度条主题色 [r,g,b]
        accentSmall: null, // 小进度条主题色 [r,g,b]
        dataSource: null, // 'lfp' | null（协商中/不可用）
        lfp: null,
        lfpSr: null,  // LFP 懒构建时记录的采样率（参数变化时用于重建）
        lfpFft: 0,    // LFP 懒构建时记录的 fftSize
        compGain: null, // LFP 音量补偿节点
        tapNode: null,  // 分体支路挂接点（补偿节点或源本身）
        multiDisabled: false, // LFP 分体支路异常时自动降级为单路
        frames: 0,
        maxHeight: parseFloat(cfg.maxHeight) || 120,
        lastSum: -1 // 停顿时跳过重绘
    };

    // ---------- 叠加画布 ----------
    const wrap = document.createElement('div');
    wrap.className = 'eav-visualizer';
    Object.assign(wrap.style, {
        position: 'fixed',
        zIndex: '9999',
        pointerEvents: 'none',
        display: 'none'
    });
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    wrap.appendChild(canvas);
    const ctx2d = canvas.getContext('2d'); // 上下文缓存：避免每帧重复获取

    // 频带级高斯平滑（multiFFT 输出没有走 SoundProcessor 的滤波管线，在此补齐）。
    // 高斯核按 sigma/radius 缓存，参数不变时零重算
    let gaussCache = { key: '', kern: null, sum: 0 };
    function gaussSmooth(arr) {
        const s = Math.max(0.1, parseFloat(cfg.sigma) || 1);
        const r = Math.max(0, Math.round(parseFloat(cfg.radius) || 0));
        if (!r || !arr || !arr.length) return arr;
        const key = s + '/' + r;
        if (gaussCache.key !== key) {
            const kern = [];
            let sum = 0;
            for (let i = -r; i <= r; i++) {
                const w = Math.exp(-(i * i) / (2 * s * s));
                kern.push(w);
                sum += w;
            }
            gaussCache = { key, kern, sum };
        }
        const { kern, sum } = gaussCache;
        const n = arr.length;
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let k = -r; k <= r; k++) {
                const j = Math.min(n - 1, Math.max(0, i + k));
                acc += arr[j] * kern[k + r];
            }
            out[i] = Math.round(acc / sum);
        }
        return out;
    }

    function attachWhenBody() {
        if (document.body) {
            document.body.appendChild(wrap);
            return;
        }
        const iv = setInterval(() => {
            if (document.body) {
                clearInterval(iv);
                document.body.appendChild(wrap);
            }
        }, 50);
    }

    function syncSize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, wrap.clientWidth * dpr);
        const h = Math.max(1, state.maxHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    // ---------- 锚点定位：播放页进度条上方，左右无留白 ----------
    // 返回 { rect, mode }；NCM 3.x 类名为 CSS-modules（前缀稳定、hash 后缀）
    function findAnchor() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 1) 播放页进度条（NCM3 黑胶/全屏播放页）
        const playSlider = document.querySelector('[class*="slider-vinyl"]');
        if (playSlider) {
            const rect = playSlider.getBoundingClientRect();
            if (rect.width > vw * 0.3 && rect.height > 2 && rect.top > vh * 0.5) {
                return { rect, mode: 'playpage-slider-vinyl', el: playSlider };
            }
            // 页面上可能有多个 slider-vinyl（底部迷你条也是），挑几何特征符合播放页的那个
            const all = document.querySelectorAll('[class*="slider-vinyl"]');
            for (const s of all) {
                const r = s.getBoundingClientRect();
                if (r.width > vw * 0.3 && r.height > 2 && r.top > vh * 0.5) {
                    return { rect: r, mode: 'playpage-slider-vinyl', el: s };
                }
            }
        }
        const playPage = document.querySelector('.g-singlec-ct, .g-playpage, [class*="playpage" i], #playpage');
        if (playPage) {
            const rect = playPage.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const candidates = Array.from(playPage.querySelectorAll('[class*="prg"], [class*="progress"], [class*="bar"], [role="slider"]'));
                const bars = candidates
                    .map(el => ({ el, rect: el.getBoundingClientRect() }))
                    .filter(x => x.rect.width > rect.width * 0.35
                        && x.rect.height > 2
                        && x.rect.height < 120
                        && x.rect.top > rect.top + rect.height * 0.55);
                if (bars.length) {
                    bars.sort((a, b) => a.rect.height - b.rect.height);
                    return { rect: bars[0].rect, mode: 'playpage-bar' };
                }
                return { rect: { left: rect.left, top: rect.bottom - 40, width: rect.width }, mode: 'playpage-bottom' };
            }
        }

        // 2) 底部播放栏（NCM3）：频谱贴着播放栏上沿
        // playPageOnly 开启时只在播放页显示，跳过以下所有兜底
        if (cfg.playPageOnly === '1') return null;
        const bottomBar = document.querySelector('[class*="DefaultBarWrapper_"], #main-player, .g-btmbar');
        if (bottomBar) {
            const rect = bottomBar.getBoundingClientRect();
            if (rect.height > 0) {
                return { rect: { left: rect.left, top: rect.top, width: rect.width }, mode: 'bottombar' };
            }
        }

        // 3) 全局搜疑似进度条/滑块（几何特征筛）
        const global = Array.from(document.querySelectorAll('[class*="slider-default"],[class*="prg" i],[class*="progress" i],[role="slider"],[class*="slider" i]'))
            .map(el => el.getBoundingClientRect())
            .filter(r => r.width > vw * 0.3 && r.height > 2 && r.height < 120 && r.top > vh * 0.5);
        if (global.length) {
            global.sort((a, b) => a.height - b.height);
            return { rect: global[0], mode: 'global-slider' };
        }

        // 4) 最终兜底：视口底部 60px（保证可见）
        if (vh > 200) {
            return { rect: { left: 0, top: vh - 60, width: vw }, mode: 'viewport-fallback' };
        }
        return null;
    }

    // 数据源自愈（500ms 心跳）：LFP 就绪即接入；被卸载时回到无数据源状态
    // （画基线），其恢复后由下一拍心跳自动重建
    function ensureDataSource() {
        if (state.dataSource === 'lfp' && !detectLFP()) {
            state.dataSource = null;
            state.lfp = null;
            state.processor = null;
            state.multiProcessor = null;
            state.multiDisabled = false;
            console.warn(TAG, 'LibFrontendPlay 不可用，等待其恢复');
        } else if (!state.dataSource && detectLFP()) {
            useLFP();
        }
    }

    function syncPosition() {
        ensureDataSource();
        const found = findAnchor();
        if (!found) {
            if (wrap.style.display !== 'none') wrap.style.display = 'none';
            state.anchor = null;
            state.anchorMode = null;
            // 播放页外也要继续跟踪主题色（切歌时进度条 CSS 变量仍在更新）
            sampleProgressColor();
            return;
        }
        const rect = found.rect;
        state.anchor = rect;
        state.anchorMode = found.mode;
        // 注意：state.colorEl 是大进度条（播放页滑条）的取色缓存，不能被锚点元素覆盖，
        // 否则底部栏锚点会把主题红当成封面色读进去
        // 取色与锚点解耦：无论是否在播放页，都通过缓存的滑条元素跟踪主题色
        sampleProgressColor();
        // 样式仅在变化时写入，避免无谓的样式重算
        const left = Math.round(rect.left);
        const width = Math.round(rect.width);
        // 底边与进度条顶边对齐；yOffset 仅在播放页锚点生效（用于微调播放页的偏差）
        const yo = found.mode.indexOf('playpage') === 0 ? (parseFloat(cfg.yOffset) || 0) : 0;
        const bottom = Math.max(0, Math.round(window.innerHeight - rect.top - yo));
        if (wrap.style.display !== 'block') {
            wrap.style.display = 'block';
            wrap.style.height = state.maxHeight + 'px';
            wrap._h = state.maxHeight;
        }
        // maxHeight 被配置异步更新时（重载后配置晚到），同步容器高度
        if (wrap._h !== state.maxHeight) {
            wrap.style.height = state.maxHeight + 'px';
            wrap._h = state.maxHeight;
        }
        if (wrap._left !== left) { wrap.style.left = left + 'px'; wrap._left = left; }
        if (wrap._width !== width) { wrap.style.width = width + 'px'; wrap._width = width; }
        if (wrap._bottom !== bottom) { wrap.style.bottom = bottom + 'px'; wrap._bottom = bottom; }
        // 位图尺寸必须在宽高样式就位后同步，否则首帧会用 0 宽位图拉伸导致模糊
        syncSize();
    }

    // ---------- 数据源 A：LibFrontendPlay ----------
    function useLFP() {
        state.dataSource = 'lfp';
        state.lfp = loadedPlugins.LibFrontendPlay;
        console.info(TAG, 'data source = LibFrontendPlay.getFFTData()');
    }

    // 分体支路挂接点：挂在音量补偿节点（或 LFP 源本身）上取多分辨率数据
    function ensureTierAnalysers() {
        if (state.tierAnalysers) return;
        const tap = state.tapNode || state.source;
        const sizes = state.tierSizes || [8192, 2048, 512];
        state.tierAnalysers = sizes.map(size => {
            const an = state.ac.createAnalyser();
            an.fftSize = size;
            tap.connect(an);
            return an;
        });
        state.tierBuffers = state.tierAnalysers.map(an => new Uint8Array(an.frequencyBinCount));
    }

    // ---------- multiFFT 定制（低/中/高分界线与各支路 fftSize） ----------
    const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    function cfgTierSizes() {
        const size = (k, d) => {
            const v = parseInt(cfg[k], 10);
            return FFT_SIZES.includes(v) ? v : d;
        };
        return [size('mfLowFft', 8192), size('mfMidFft', 2048), size('mfHighFft', 512)];
    }
    function cfgSplits() {
        const lo = parseFloat(cfg.mfLowMid);
        const hi = parseFloat(cfg.mfMidHigh);
        return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo ? [lo, hi] : null;
    }
    function multiOptions(sampleRate) {
        return { ...makeParams(sampleRate), tiers: cfgTierSizes(), splits: cfgSplits() };
    }
    // 支路 fftSize 变化时重建支路 analyser
    function syncTierSizes(sizes) {
        if (state.tierAnalysers && state.tierAnalysers.some((an, i) => an.fftSize !== sizes[i])) {
            state.tierAnalysers.forEach(an => { try { an.disconnect(); } catch (e) { /* 忽略 */ } });
            state.tierAnalysers = null;
            state.tierBuffers = null;
        }
        state.tierSizes = sizes;
    }

    // ---------- 数据源协商 ----------
    // 只依赖 LibFrontendPlay：轮询等待其 getFFTData 就绪（失联/恢复由心跳兜底）
    function initData() {
        const poll = () => {
            if (state.dataSource === 'lfp') return;
            if (detectLFP()) {
                useLFP();
                return;
            }
            setTimeout(poll, 1000);
        };
        poll();
    }

    // ---------- 处理器重建（参数变化时调用） ----------
    function makeParams(sampleRate) {
        return {
            sampleRate,
            startFrequency: parseFloat(cfg.startFrequency) || 0,
            endFrequency: parseFloat(cfg.endFrequency) || 10000,
            outBandsQty: Math.max(1, Math.round(parseFloat(cfg.outBandsQty) || 81)),
            tWeight: cfg.tWeight === '1',
            aWeight: cfg.aWeight === '1'
        };
    }

    function buildProcessor(sampleRate, fftSize) {
        if (cfg.multiFFT === '1' && state.tierAnalysers) {
            state.processor = null;
            state.multiProcessor = new MultiResolutionFFT(multiOptions(sampleRate));
            return;
        }
        state.multiProcessor = null;
        if (state.analyser) {
            state.analyser.fftSize = fftSize;
        }
        state.processor = new SoundProcessor({
            ...makeParams(sampleRate),
            fftSize,
            filterParams: cfg.filterOn === '1' ? {
                sigma: parseFloat(cfg.sigma) || 1,
                radius: Math.max(0, Math.round(parseFloat(cfg.radius) || 0))
            } : undefined
        });
    }

    function rebuild() {
        try {
            if (state.dataSource === 'lfp') {
                // LFP 分体：直接用当前挂接的 AudioContext 重建
                if (cfg.multiFFT === '1') {
                    state.multiDisabled = false; // 用户重新勾选时允许再次尝试
                    if (state.ac) {
                        state.processor = null;
                        syncTierSizes(multiOptions(state.ac.sampleRate).tiers);
                        ensureTierAnalysers();
                        state.multiProcessor = new MultiResolutionFFT(multiOptions(state.ac.sampleRate));
                    }
                } else {
                    // 关闭 multiFFT：无论如何先清掉分体处理器（multi 开着时 lfpSr 可能未记录，
                    // 不清理会残留导致下方懒构建被跳过、频谱冻结）
                    state.multiProcessor = null;
                    if (state.lfpSr) {
                        // fftSize 同步到 LFP 内部 analyser
                        const want = parseInt(cfg.fftSize, 10) || 1024;
                        const an = state.lfp.currentAudioAnalyser;
                        if (an && an.fftSize !== want) {
                            an.fftSize = want;
                        }
                        buildProcessor(state.lfpSr, state.lfpFft || want);
                    }
                    // lfpSr 未记录时走帧循环懒构建，自然用上新参数
                }
                return;
            }
            if (!state.ac) return;
            const fftSize = parseInt(cfg.fftSize, 10) || 1024;
            const sampleRate = cfg.sampleRate
                ? parseFloat(cfg.sampleRate)
                : state.ac.sampleRate;
            if (cfg.multiFFT === '1') {
                syncTierSizes(cfgTierSizes());
                ensureTierAnalysers();
            }
            buildProcessor(sampleRate, fftSize);
        } catch (e) {
            console.error(TAG, 'rebuild failed', e);
            state.processor = null;
            state.multiProcessor = null;
        }
    }

    function setMaxHeight(px) {
        state.maxHeight = Math.max(20, px || 120);
        wrap.style.height = state.maxHeight + 'px';
        syncSize();
    }

    // ---------- 绘制 ----------
    // 进度条取色：大进度条（播放页 slider-vinyl，封面衍生彩色）与小进度条（底部播放栏
    // slider-default[aria-label="播放进度调节"]，主题变量色）分别取 --track-color 的
    // 最后一个不透明色标。两条取色均与锚点解耦：元素隐藏后只要还在 DOM 中就继续读色
    // （getComputedStyle 对隐藏元素仍生效，var() 引用会解析成具体 rgb），切歌时 CSS
    // 变量也会更新。显示时按当前锚点选目标色，绘制帧内逐帧插值，实现两色间的平滑过渡。
    // 解析 --track-color：返回 [r,g,b] 或 null
    function parseTrackColor(raw) {
        if (!raw) return null;
        const all = [...raw.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)];
        for (let i = all.length - 1; i >= 0; i--) {
            if (!all[i][4] || parseFloat(all[i][4]) > 0.2) {
                return [parseInt(all[i][1]), parseInt(all[i][2]), parseInt(all[i][3])];
            }
        }
        return null;
    }

    // 大进度条：优先复用缓存的元素；丢失时重扫，跳过近白色（迷你条白系主题）
    function findBigSlider() {
        const all = document.querySelectorAll('[class*="slider-vinyl"]');
        for (const s of all) {
            const m = getComputedStyle(s).getPropertyValue('--track-color').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m && !(+m[1] >= 240 && +m[2] >= 240 && +m[3] >= 240)) return s;
        }
        return null;
    }

    // 小进度条：底部播放栏滑条（aria-label="播放进度调节"），精确选择器，
    // 不做几何扫描（会误抓音量条等）。--track-color 引用主题 CSS 变量
    // （如 var(--colorSecondary1_2)），getComputedStyle 返回解析后的具体 rgb
    function findSmallSlider() {
        return document.querySelector('[class*="slider-default"][aria-label*="进度"]')
            || document.querySelector('[aria-label*="进度" i][class*="slider" i]');
    }

    function sampleProgressColor() {
        // 大进度条
        let big = state.colorEl;
        if (!big || !big.isConnected) {
            big = findBigSlider();
            state.colorEl = big;
        }
        if (big) {
            try {
                state.accentBig = parseTrackColor(getComputedStyle(big).getPropertyValue('--track-color')) || state.accentBig;
            } catch (e) { /* 元素已卸载等，忽略 */ }
        }
        // 小进度条
        let small = state.colorElSmall;
        if (!small || !small.isConnected) {
            small = findSmallSlider();
            state.colorElSmall = small;
        }
        if (small) {
            try {
                state.accentSmall = parseTrackColor(getComputedStyle(small).getPropertyValue('--track-color')) || state.accentSmall;
            } catch (e) { /* 忽略 */ }
        }
    }

    function drawBars(data) {
        // 位图尺寸每帧自检：首帧若在窗口布局未稳时量错了尺寸，下一帧立即纠正
        // （这也是「重载后改一下最大高度就判若两条」的根治）
        syncSize();
        const ctx = ctx2d;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!data || !data.length) return;

        const bw = w / data.length;
        const alpha = Math.min(1, Math.max(0.05, parseFloat(cfg.opacity) || 0.85));
        const colorMode = cfg.colorMode === 'color';
        const progressMode = cfg.colorMode === 'progress';
        // 目标色：播放页锚点用大进度条色，否则用小进度条色；逐帧插值平滑过渡
        const onPlayPage = state.anchorMode && state.anchorMode.indexOf('playpage') === 0;
        const target = (onPlayPage ? state.accentBig : state.accentSmall)
            || state.accentBig || state.accentSmall;
        if (target) {
            if (!state.accent) state.accent = target.slice();
            for (let c = 0; c < 3; c++) {
                state.accent[c] += (target[c] - state.accent[c]) * 0.08;
            }
        }
        const accent = state.accent || [236, 65, 65]; // 兜底：NCM 主题红
        for (let i = 0; i < data.length; i++) {
            let v = data[i];
            if (!Number.isFinite(v)) v = 0; // 非法参数组合（如 startFrequency=0）兜底
            v = Math.min(255, Math.max(0, v));
            const t = v / 255;
            const bh = t * h;
            if (colorMode) {
                ctx.fillStyle = `hsla(${200 + (i / data.length) * 160}, 80%, ${30 + t * 45}%, ${alpha})`;
            } else if (progressMode) {
                // 进度条颜色：亮度随响度变化（与白色模式同款辉光逻辑，色相取自进度条）
                ctx.fillStyle = `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${alpha * (0.25 + 0.75 * t)})`;
            } else {
                // 白色模式：亮度随响度变化（辉光），静音处接近熄灭
                ctx.fillStyle = `rgba(255, 255, 255, ${alpha * (0.25 + 0.75 * t)})`;
            }
            ctx.fillRect(i * bw + 1, h - bh, Math.max(bw - 2, 1), bh);
        }
    }

    function drawBaseline() {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx2d.fillRect(0, canvas.height - 3, canvas.width, 3);
    }

    function frame() {
        requestAnimationFrame(frame);
        if (wrap.style.display === 'none' || !state.anchor) return;

        // 无数据源时画一条基线，证明「画布与定位在工作，只是没数据」
        if (!state.dataSource) {
            drawBaseline();
            return;
        }

        try {
            if (state.dataSource === 'lfp') {
                // 分体 FFT：直接挂到 LFP 的 MediaElementSource 上取多分辨率数据
                // （LFP 每首歌重建 AudioContext，检测到变化即自动重建支路）
                const lfpAc = state.lfp.currentAudioContext;
                if (cfg.multiFFT === '1' && !state.multiDisabled && lfpAc && state.lfp.currentAudioSource) {
                    try {
                        if (state.ac !== lfpAc || !state.multiProcessor) {
                            // 换歌/换 AudioContext：显式断开旧节点（旧 AC 上的 analyser、
                            // 增益节点不断开只能靠 GC 兜底，属隐性泄露）
                            if (state.tierAnalysers) {
                                state.tierAnalysers.forEach(an => { try { an.disconnect(); } catch (e) { /* 忽略 */ } });
                            }
                            if (state.compGain) { try { state.compGain.disconnect(); } catch (e) { /* 忽略 */ } }
                            state.ac = lfpAc;
                            state.source = state.lfp.currentAudioSource;
                            // 音量补偿开关：播放器音量会衰减 MediaElementSource 输出（NCM 音量条），
                            // 插入 1/音量 的增益补偿使分析电平与音量无关（对齐网页版）
                            if (cfg.volumeComp === '1') {
                                state.compGain = lfpAc.createGain();
                                state.source.connect(state.compGain);
                                state.tapNode = state.compGain;
                            } else {
                                state.compGain = null;
                                state.tapNode = state.source;
                            }
                            state.tierAnalysers = null;
                            state.tierBuffers = null;
                            state.processor = null;
                            syncTierSizes(multiOptions(lfpAc.sampleRate).tiers);
                            ensureTierAnalysers();
                            state.multiProcessor = new MultiResolutionFFT(multiOptions(lfpAc.sampleRate));
                            state.lastSum = -1;
                            console.info(TAG, 'multiFFT on LFP source, sampleRate =', lfpAc.sampleRate,
                                'tiers =', state.tierSizes.join('/'), 'splits =', cfgSplits());
                        }
                        // 音量变化时同步补偿增益（上限 4 倍，防止静音附近爆表）
                        if (cfg.volumeComp === '1' && state.compGain) {
                            const vol = typeof state.lfp.volume === 'number' ? state.lfp.volume : 1;
                            const gain = vol > 0.05 ? Math.min(4, 1 / vol) : 1;
                            if (Math.abs(state.compGain.gain.value - gain) > 0.01) {
                                state.compGain.gain.value = gain;
                            }
                        }
                        for (let t = 0; t < state.tierAnalysers.length; t++) {
                            state.tierAnalysers[t].getByteFrequencyData(state.tierBuffers[t]);
                        }
                        const bands = state.multiProcessor.process(state.tierBuffers);
                        drawBars(cfg.filterOn === '1' ? gaussSmooth(bands) : bands);
                        state.frames++;
                    } catch (e) {
                        // 分体支路异常：降级回单路，保证频谱不消失
                        state.multiDisabled = true;
                        state.multiProcessor = null;
                        console.error(TAG, 'multiFFT failed, fallback to single mode', e);
                    }
                } else {
                    // 单路模式（multiDisabled 只阻止分体支路重试，不影响单路绘制）
                    // fftSize 需要同步到 LFP 内部的 analyser（数据由它预先算好）
                    const an = state.lfp.currentAudioAnalyser;
                    const want = parseInt(cfg.fftSize, 10) || 1024;
                    if (an && an.fftSize !== want) an.fftSize = want;
                    const data = state.lfp.getFFTData();
                    if (data && data.length) {
                        // LFP 的 analyser 未设置 fftSize（默认 2048），按实际数据长度懒构建
                        if (!state.processor) {
                            state.multiProcessor = null;
                            const sr = lfpAc ? lfpAc.sampleRate
                                : (parseFloat(cfg.sampleRate) || 48000);
                            state.lfpSr = sr;
                            state.lfpFft = data.length * 2;
                            buildProcessor(sr, state.lfpFft);
                        }
                        // 停顿（全零）时跳过重绘
                        let sum = 0;
                        for (let i = 0; i < data.length; i += 8) sum += data[i];
                        if (sum !== state.lastSum) {
                            state.lastSum = sum;
                            drawBars(state.processor.process(data));
                            state.frames++;
                        }
                    }
                }
            }
        } catch (e) {
            console.error(TAG, 'frame error', e);
        }
    }

    // 运行时状态（供设置页「运行时信息」展示）
    function getStats() {
        const p = state.processor;
        const m = state.multiProcessor;
        const stats = {
            source: state.dataSource,
            anchorMode: state.anchorMode,
            accent: state.accent ? 'rgb(' + state.accent.join(',') + ')' : null,
            sampleRate: p ? p.sampleRate : (m ? m.sampleRate : null),
            fftSize: p ? p.fftSize : null,
            bandwidth: p ? (p.sampleRate / p.fftSize) : null,
            outBandsQty: p ? p.outBandsQty : (m ? m.outBandsQty : null),
            filter: cfg.filterOn === '1'
                ? 'sigma=' + cfg.sigma + ', radius=' + cfg.radius
                : '关闭',
            multiFFT: !!m,
            maxHeight: state.maxHeight,
            frames: state.frames
        };
        if (m) {
            const ts = m.tierStats();
            stats.tiers = m.tiers.map((s, i) => s + '×' + ts.counts[i] + '带');
            stats.crossings = ts.crossings.map(f => Math.round(f) + 'Hz');
        }
        if (state.dataSource === 'lfp' && typeof state.lfp.volume === 'number') {
            stats.lfpVolume = state.lfp.volume;
            stats.compGain = state.compGain ? +state.compGain.gain.value.toFixed(2) : null;
        }
        return stats;
    }

    return {
        start() {
            attachWhenBody();
            // 绘制循环无条件启动：无数据源时画基线，让「定位在工作、只差数据」可见
            requestAnimationFrame(frame);
            initData();
            // 锚点低频跟踪（帧循环零 DOM 查询，保证不卡）
            setTimeout(syncPosition, 1000);
            setInterval(syncPosition, 500);
        },
        rebuild,
        setMaxHeight,
        getStats
    };
}
