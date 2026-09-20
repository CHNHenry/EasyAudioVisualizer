// 可视化：数据源（LibFrontendPlay 优先 / audio 元素兜底）+ 播放页进度条上方频谱叠加
// 无任何调试 I/O：帧循环零 DOM 查询，定位走 500ms 低频心跳
import { SoundProcessor } from './processor.js';
import { MultiResolutionFFT } from './multi-fft.js';

const AC = window.AudioContext || window.webkitAudioContext;
const TAG = '[EasyAudioVisualizer]';

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function detectLFP() {
    return typeof loadedPlugins !== 'undefined'
        && loadedPlugins
        && loadedPlugins.LibFrontendPlay
        && typeof loadedPlugins.LibFrontendPlay.getFFTData === 'function';
}

function waitForMedia() {
    return new Promise(resolve => {
        const found = document.querySelector('audio,video');
        if (found) return resolve(found);
        const obs = new MutationObserver(() => {
            const el = document.querySelector('audio,video');
            if (el) {
                obs.disconnect();
                resolve(el);
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
    });
}

export function createVisualizer(cfg) {
    const state = {
        ac: null,
        source: null,
        analyser: null,
        tierAnalysers: null,
        tierBuffers: null,
        processor: null,
        multiProcessor: null,
        raw: null,
        anchor: null,
        anchorMode: null,
        dataSource: null, // 'lfp' | 'element'
        lfp: null,
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
                return { rect, mode: 'playpage-slider-vinyl' };
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

    function syncPosition() {
        const found = findAnchor();
        if (!found) {
            if (wrap.style.display !== 'none') wrap.style.display = 'none';
            state.anchor = null;
            state.anchorMode = null;
            return;
        }
        const rect = found.rect;
        state.anchor = rect;
        state.anchorMode = found.mode;
        // 样式仅在变化时写入，避免无谓的样式重算
        const left = Math.round(rect.left);
        const width = Math.round(rect.width);
        const bottom = Math.max(0, Math.round(window.innerHeight - rect.top + 2));
        if (wrap.style.display !== 'block') {
            wrap.style.display = 'block';
            wrap.style.height = state.maxHeight + 'px';
            syncSize();
        }
        if (wrap._left !== left) { wrap.style.left = left + 'px'; wrap._left = left; }
        if (wrap._width !== width) { wrap.style.width = width + 'px'; wrap._width = width; }
        if (wrap._bottom !== bottom) { wrap.style.bottom = bottom + 'px'; wrap._bottom = bottom; }
    }

    // ---------- 数据源 A：LibFrontendPlay ----------
    function useLFP() {
        state.dataSource = 'lfp';
        state.lfp = loadedPlugins.LibFrontendPlay;
        console.info(TAG, 'data source = LibFrontendPlay.getFFTData()');
    }

    // ---------- 数据源 B：接管 audio 元素 ----------
    function ensureTierAnalysers() {
        if (state.tierAnalysers) return;
        state.tierAnalysers = [8192, 2048, 512].map(size => {
            const an = state.ac.createAnalyser();
            an.fftSize = size;
            state.source.connect(an);
            return an;
        });
        state.tierBuffers = state.tierAnalysers.map(an => new Uint8Array(an.frequencyBinCount));
    }

    function hookElement(audio) {
        state.ac = new AC();
        // MediaElementSource 接管 audio 输出，必须连回 destination 才有声音
        state.source = state.ac.createMediaElementSource(audio);
        state.analyser = state.ac.createAnalyser();
        state.source.connect(state.analyser);
        state.analyser.connect(state.ac.destination);
        audio.addEventListener('play', () => {
            state.ac.resume();
        });
        state.dataSource = 'element';
        console.info(TAG, 'data source = audio element, sampleRate =', state.ac.sampleRate);
        rebuild();
    }

    // ---------- 数据源协商 ----------
    async function initData() {
        // 1) LFP（插件加载顺序不定，轮询等待；检测是属性访问，零开销）
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            if (detectLFP()) {
                useLFP();
                return;
            }
            await delay(1000);
        }
        // 2) 页面媒体元素（NCM2 或装了同类前端播放插件时存在）
        const el = await waitForMedia();
        try {
            hookElement(el);
        } catch (e) {
            console.error(TAG, 'hook audio failed', e);
        }
    }

    // ---------- 处理器重建（参数变化时调用） ----------
    function buildProcessor(sampleRate, fftSize) {
        const params = {
            sampleRate,
            startFrequency: parseFloat(cfg.startFrequency) || 0,
            endFrequency: parseFloat(cfg.endFrequency) || 10000,
            outBandsQty: Math.max(1, Math.round(parseFloat(cfg.outBandsQty) || 81)),
            tWeight: cfg.tWeight === '1',
            aWeight: cfg.aWeight === '1'
        };
        if (cfg.multiFFT === '1' && state.dataSource === 'element') {
            ensureTierAnalysers();
            state.processor = null;
            state.multiProcessor = new MultiResolutionFFT(params);
        } else {
            state.multiProcessor = null;
            if (state.analyser) {
                state.analyser.fftSize = fftSize;
            }
            state.processor = new SoundProcessor({
                ...params,
                fftSize,
                filterParams: cfg.filterOn === '1' ? {
                    sigma: parseFloat(cfg.sigma) || 1,
                    radius: Math.max(0, Math.round(parseFloat(cfg.radius) || 0))
                } : undefined
            });
        }
    }

    function rebuild() {
        if (state.dataSource === 'lfp') return; // lfp 模式按实际数据长度懒构建
        if (!state.ac) return;
        const fftSize = parseInt(cfg.fftSize, 10) || 1024;
        const sampleRate = cfg.sampleRate
            ? parseFloat(cfg.sampleRate)
            : state.ac.sampleRate;
        try {
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
    function drawBars(data) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!data || !data.length) return;

        const bw = w / data.length;
        for (let i = 0; i < data.length; i++) {
            let v = data[i];
            if (!Number.isFinite(v)) v = 0; // 非法参数组合（如 startFrequency=0）兜底
            v = Math.min(255, Math.max(0, v));
            const t = v / 255;
            const bh = t * h;
            ctx.fillStyle = `hsla(${200 + (i / data.length) * 160}, 80%, ${30 + t * 45}%, 1)`;
            ctx.fillRect(i * bw + 1, h - bh, Math.max(bw - 2, 1), bh);
        }
    }

    function drawBaseline() {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.fillRect(0, canvas.height - 3, canvas.width, 3);
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
                const data = state.lfp.getFFTData();
                if (data && data.length) {
                    // LFP 的 analyser 未设置 fftSize（默认 2048），按实际数据长度懒构建
                    if (!state.processor && !state.multiProcessor) {
                        const sr = (state.lfp.currentAudioContext && state.lfp.currentAudioContext.sampleRate)
                            || parseFloat(cfg.sampleRate) || 48000;
                        buildProcessor(sr, data.length * 2);
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
            } else if (state.dataSource === 'element') {
                if (state.multiProcessor) {
                    for (let t = 0; t < state.tierAnalysers.length; t++) {
                        state.tierAnalysers[t].getByteFrequencyData(state.tierBuffers[t]);
                    }
                    drawBars(state.multiProcessor.process(state.tierBuffers));
                    state.frames++;
                } else if (state.processor) {
                    const len = state.analyser.frequencyBinCount;
                    if (!state.raw || state.raw.length !== len) {
                        state.raw = new Uint8Array(len);
                    }
                    state.analyser.getByteFrequencyData(state.raw);
                    drawBars(state.processor.process(state.raw));
                    state.frames++;
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
