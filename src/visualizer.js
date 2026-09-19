// 可视化：数据源（LibFrontendPlay 优先 / audio 元素兜底）+ 播放页进度条上方频谱叠加
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

// 诊断信息落盘，便于远程排查（写入 BetterNCM 数据目录 eav-debug.json）
const diag = {
    time: '',
    lfpDetected: false,
    mediaElements: [],
    source: null,   // 'lfp' | 'element' | 'none' | null(仍在等待)
    anchor: null,
    frames: 0,
    errors: []
};

function flushDiag() {
    try {
        diag.time = new Date().toISOString();
        betterncm.app.getDataPath().then(p => {
            betterncm.fs.writeFileText(p + '/eav-debug.json', JSON.stringify(diag, null, 2));
        }).catch(e => diag.errors.push('getDataPath: ' + e));
    } catch (e) {
        diag.errors.push('flush: ' + e);
    }
}

function scanMediaElements() {
    try {
        diag.mediaElements = Array.from(document.querySelectorAll('audio,video')).map(el => ({
            tag: el.tagName,
            id: el.id || undefined,
            cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 60) || undefined,
            src: String(el.currentSrc || el.src || '').slice(0, 100) || undefined
        }));
    } catch (e) {
        diag.errors.push('scan: ' + e);
    }
}

function waitForMedia(timeoutMs) {
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
        if (timeoutMs) {
            setTimeout(() => {
                obs.disconnect();
                scanMediaElements();
                flushDiag();
                resolve(null);
            }, timeoutMs);
        }
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
        dataSource: null, // 'lfp' | 'element'
        lfp: null,
        maxHeight: parseFloat(cfg.maxHeight) || 120
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
    document.body.appendChild(wrap);

    function syncSize() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, wrap.clientWidth * dpr);
        canvas.height = Math.max(1, state.maxHeight * dpr);
    }

    // ---------- 锚点定位：播放页进度条上方，左右无留白 ----------
    function findAnchor() {
        // 播放页（全屏正在播放页）；.g-singlec-ct 为 SAV 验证过的播放页容器
        const playPage = document.querySelector('.g-singlec-ct, .g-playpage, [class*="playpage" i], #playpage');
        if (playPage) {
            const rect = playPage.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                // 在播放页里找进度条：横向够宽、位于页面下部、尽量矮（排除容器）
                const candidates = Array.from(playPage.querySelectorAll('[class*="prg"], [class*="progress"], [class*="bar"]'));
                const bars = candidates
                    .map(el => ({ el, rect: el.getBoundingClientRect() }))
                    .filter(x => x.rect.width > rect.width * 0.35
                        && x.rect.height > 2
                        && x.rect.top > rect.top + rect.height * 0.55
                        && x.rect.bottom < rect.bottom + 8);
                if (bars.length) {
                    bars.sort((a, b) => a.rect.height - b.rect.height);
                    return bars[0].rect;
                }
                // 兜底：贴播放页底部
                return { left: rect.left, top: rect.bottom - 40, width: rect.width };
            }
        }
        // 兜底：底部播放栏
        const bottomBar = document.querySelector('#main-player') || document.querySelector('.g-btmbar');
        if (bottomBar) {
            const rect = bottomBar.getBoundingClientRect();
            if (rect.height > 0) {
                return { left: rect.left, top: rect.top, width: rect.width };
            }
        }
        return null;
    }

    function syncPosition() {
        const rect = findAnchor();
        if (!rect) {
            wrap.style.display = 'none';
            return;
        }
        state.anchor = rect;
        wrap.style.display = 'block';
        wrap.style.left = rect.left + 'px';
        wrap.style.width = rect.width + 'px';
        wrap.style.top = 'auto';
        wrap.style.height = state.maxHeight + 'px';
        wrap.style.bottom = Math.max(0, window.innerHeight - rect.top + 2) + 'px';
        syncSize();
    }

    // 进度条/页面结构变化时重新定位（节流）
    let repositionTimer = null;
    const observer = new MutationObserver(() => {
        if (repositionTimer) return;
        repositionTimer = setTimeout(() => {
            repositionTimer = null;
            syncPosition();
        }, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', syncPosition);

    // ---------- 数据源 A：LibFrontendPlay ----------
    function useLFP() {
        state.dataSource = 'lfp';
        state.lfp = loadedPlugins.LibFrontendPlay;
        diag.source = 'lfp';
        diag.lfpDetected = true;
        flushDiag();
        console.info(TAG, 'data source = LibFrontendPlay.getFFTData()');
        requestAnimationFrame(frame);
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
        diag.source = 'element';
        flushDiag();
        console.info(TAG, 'data source = audio element, sampleRate =', state.ac.sampleRate);
        rebuild();
        requestAnimationFrame(frame);
    }

    // ---------- 数据源协商 ----------
    async function initData() {
        flushDiag();
        // 1) LFP（插件加载顺序不定，轮询等待）
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            if (detectLFP()) {
                useLFP();
                return;
            }
            await delay(500);
            scanMediaElements();
            if ((Date.now() - t0) % 8000 < 500) flushDiag();
        }
        diag.lfpDetected = detectLFP();
        // 2) 页面媒体元素
        const el = await waitForMedia(15000);
        if (el) {
            scanMediaElements();
            try {
                hookElement(el);
            } catch (e) {
                diag.errors.push('hook: ' + e);
                flushDiag();
            }
            return;
        }
        // 3) 无数据源
        diag.source = diag.source || 'none';
        flushDiag();
        console.warn(TAG, 'no data source: neither LibFrontendPlay nor <audio>/<video> found', diag);
        // 60s 内持续再探测（页面可能延迟创建）
        setTimeout(function retry() {
            if (detectLFP()) return useLFP();
            const el2 = document.querySelector('audio,video');
            if (el2) {
                try { hookElement(el2); } catch (e) { diag.errors.push('hook2: ' + e); }
                return;
            }
            flushDiag();
            setTimeout(retry, 10000);
        }, 10000);
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
            diag.errors.push('rebuild: ' + e);
            state.processor = null;
            state.multiProcessor = null;
        }
    }

    function setMaxHeight(px) {
        state.maxHeight = Math.max(20, px || 120);
        syncPosition();
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

    function frame() {
        requestAnimationFrame(frame);
        if (wrap.style.display === 'none') return;

        // 锚点位置每帧跟随（页面切换时进度条会移动）
        const live = findAnchor();
        if (live) {
            state.anchor = live;
            wrap.style.left = live.left + 'px';
            wrap.style.width = live.width + 'px';
            wrap.style.bottom = Math.max(0, window.innerHeight - live.top + 2) + 'px';
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
                    drawBars(state.processor.process(data));
                    diag.frames++;
                }
            } else if (state.dataSource === 'element') {
                if (state.multiProcessor) {
                    for (let t = 0; t < state.tierAnalysers.length; t++) {
                        state.tierAnalysers[t].getByteFrequencyData(state.tierBuffers[t]);
                    }
                    drawBars(state.multiProcessor.process(state.tierBuffers));
                    diag.frames++;
                } else if (state.processor) {
                    const len = state.analyser.frequencyBinCount;
                    if (!state.raw || state.raw.length !== len) {
                        state.raw = new Uint8Array(len);
                    }
                    state.analyser.getByteFrequencyData(state.raw);
                    drawBars(state.processor.process(state.raw));
                    diag.frames++;
                }
            }
        } catch (e) {
            diag.errors.push('frame: ' + e);
            if (diag.errors.length < 20) flushDiag();
        }
    }

    return {
        start() {
            initData();
            // 画布随时待命：找到锚点就显示（哪怕还没有数据源，先空着）
            setTimeout(syncPosition, 1000);
        },
        rebuild,
        setMaxHeight
    };
}
