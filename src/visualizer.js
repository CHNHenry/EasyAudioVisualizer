// 可视化：接管 NCM 的 audio 元素，在播放页进度条上方叠加频谱画布
import { SoundProcessor } from './processor.js';
import { MultiResolutionFFT } from './multi-fft.js';

const AC = window.AudioContext || window.webkitAudioContext;

const TAG = '[EasyAudioVisualizer]';

// getByteFrequencyData 把 [minDecibels, maxDecibels]（默认 [-100, -30]）映射到 [0, 255]
const BYTES_PER_DB = 255 / 70;

function waitForAudio() {
    return new Promise(resolve => {
        const found = document.querySelector('audio');
        if (found) return resolve(found);
        const obs = new MutationObserver(() => {
            const el = document.querySelector('audio');
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
        // 播放页（全屏正在播放页）
        const playPage = document.querySelector('.g-playpage, [class*="playpage" i], #playpage');
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

    // ---------- 音频接入 ----------
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

    async function hookAudio() {
        const audio = await waitForAudio();
        state.ac = new AC();
        // MediaElementSource 接管 audio 输出，必须连回 destination 才有声音
        state.source = state.ac.createMediaElementSource(audio);
        state.analyser = state.ac.createAnalyser();
        state.source.connect(state.analyser);
        state.analyser.connect(state.ac.destination);
        audio.addEventListener('play', () => {
            state.ac.resume();
        });
        console.info(TAG, 'audio hooked, sampleRate =', state.ac.sampleRate);
        rebuild();
        requestAnimationFrame(frame);
    }

    // ---------- 处理器重建（参数变化时调用） ----------
    function rebuild() {
        if (!state.ac) return;
        const sampleRate = cfg.sampleRate
            ? parseFloat(cfg.sampleRate)
            : state.ac.sampleRate;
        const params = {
            sampleRate,
            startFrequency: parseFloat(cfg.startFrequency) || 0,
            endFrequency: parseFloat(cfg.endFrequency) || 10000,
            outBandsQty: Math.max(1, Math.round(parseFloat(cfg.outBandsQty) || 81)),
            tWeight: cfg.tWeight === '1',
            aWeight: cfg.aWeight === '1'
        };
        try {
            if (cfg.multiFFT === '1') {
                ensureTierAnalysers();
                state.processor = null;
                state.multiProcessor = new MultiResolutionFFT(params);
            } else {
                state.multiProcessor = null;
                state.analyser.fftSize = parseInt(cfg.fftSize, 10) || 1024;
                state.processor = new SoundProcessor({
                    ...params,
                    fftSize: parseInt(cfg.fftSize, 10) || 1024,
                    filterParams: cfg.filterOn === '1' ? {
                        sigma: parseFloat(cfg.sigma) || 1,
                        radius: Math.max(0, Math.round(parseFloat(cfg.radius) || 0))
                    } : undefined
                });
            }
        } catch (e) {
            console.error(TAG, 'rebuild failed', e);
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
        if (!state.analyser || wrap.style.display === 'none') return;

        // 锚点位置每帧跟随（页面切换时进度条会移动）
        const rect = state.anchor;
        if (rect) {
            const live = findAnchor();
            if (live) {
                wrap.style.left = live.left + 'px';
                wrap.style.width = live.width + 'px';
                wrap.style.bottom = Math.max(0, window.innerHeight - live.top + 2) + 'px';
            }
        }

        if (state.multiProcessor) {
            for (let t = 0; t < state.tierAnalysers.length; t++) {
                state.tierAnalysers[t].getByteFrequencyData(state.tierBuffers[t]);
            }
            drawBars(state.multiProcessor.process(state.tierBuffers));
        } else if (state.processor) {
            const len = state.analyser.frequencyBinCount;
            if (!state.raw || state.raw.length !== len) {
                state.raw = new Uint8Array(len);
            }
            state.analyser.getByteFrequencyData(state.raw);
            drawBars(state.processor.process(state.raw));
        }
    }

    // BYTES_PER_DB 保留给未来对外 API 使用（多支路校准已内置在 multi-fft 中）
    void BYTES_PER_DB;

    return {
        start() {
            hookAudio().catch(e => console.error(TAG, 'init failed', e));
        },
        rebuild,
        setMaxHeight
    };
}
