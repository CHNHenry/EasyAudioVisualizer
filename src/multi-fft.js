// 多分辨率分体 FFT 处理器（恒Q近似）
// 三条支路（默认 8192/2048/512）并行 FFT：
// - 每条倍频程频带自动挑选「频带宽度 ≥ 频点宽度」中 fftSize 最小（响应最快）的支路
// - 支路间按功率谱 bin 宽度做 3dB/倍频程 的接缝校准（对齐到最细支路）
// - 时间计权/A计权按频带粒度应用
import { aWeighting } from './processor.js';

// getByteFrequencyData 把 [minDecibels, maxDecibels]（AnalyserNode 默认 [-100, -30]）映射到 [0, 255]
const BYTES_PER_DB = 255 / 70;

export class MultiResolutionFFT {
    constructor(options) {
        const {
            sampleRate,
            startFrequency,
            endFrequency,
            outBandsQty,
            tWeight = true,
            aWeight = true,
            tiers = [8192, 2048, 512],
            splits = null // [低/中分界, 中/高分界]：按频带中心频率指派支路；null 则按带宽自动选择
        } = options;

        if (!sampleRate || !outBandsQty) {
            throw new Error('sampleRate 与 outBandsQty 必填');
        }

        this.sampleRate = sampleRate;
        this.endFrequency = endFrequency;
        this.outBandsQty = outBandsQty;
        this.tWeight = tWeight;
        this.aWeight = aWeight;
        this.tiers = tiers;

        // start=0 会让倍频程算式 log2(end/start) 失效，与库的行为一致，这里钳到可听下限
        const start = Math.max(20, startFrequency || 20);
        const logSpan = Math.log2(endFrequency / start);
        if (!Number.isFinite(logSpan) || logSpan <= 0) {
            throw new Error('需要 0 < startFrequency < endFrequency');
        }

        const binWidths = tiers.map(size => sampleRate / size);
        const binCounts = tiers.map(size => Math.floor(size / 2));

        // 支路电平校准：bin 越宽单个 bin 捕获能量越多（byte 读数偏高），
        // 按 10*log10(bin宽比值) dB 折算成 byte 偏移，统一对齐到最细支路（8192）
        this.tierOffsets = binWidths.map(bw => -10 * Math.log10(bw / binWidths[0]) * BYTES_PER_DB);

        // 倍频程分带 + 支路指派
        const ratio = Math.pow(2, logSpan / outBandsQty);
        this.bands = [];
        let lower = start;
        for (let i = 0; i < outBandsQty; i++) {
            const upper = Math.min(lower * ratio, endFrequency);
            const width = upper - lower;

            // 指派支路：splits 存在时按中心频率落到低/中/高段；否则从最快支路往回取满足频宽的第一条
            let tierIndex = 0;
            if (splits) {
                const cf = Math.sqrt(lower * upper);
                if (cf > splits[1]) tierIndex = 2;       // 高频段
                else if (cf > splits[0]) tierIndex = 1;  // 中频段
                // 默认 0（低频段）
            } else {
                for (let t = tiers.length - 1; t >= 1; t--) {
                    if (binWidths[t] <= width) {
                        tierIndex = t;
                        break;
                    }
                }
            }

            const bw = binWidths[tierIndex];
            const maxBin = binCounts[tierIndex] - 1;
            const startBin = Math.min(Math.floor(lower / bw), maxBin);
            let endBin = Math.min(Math.floor(upper / bw), maxBin);
            if (endBin < startBin) endBin = startBin;

            this.bands.push({
                lower,
                upper,
                tierIndex,
                startBin,
                endBin,
                aw: aWeighting(Math.sqrt(lower * upper)) // 频带中心频率的 A 计权系数
            });
            lower = upper;
        }

        // 每条频带独立的 5 帧时间计权历史
        this.history = [];
        for (let i = 0; i < outBandsQty; i++) this.history.push([]);

        // 接缝平滑权重：α 在支路切换边界处为 1，向两侧 W 个频带线性衰减到 0
        // 边界处输出 = 50% 自身 + 50% 邻域均值，消除段间接缝的断崖
        const SEAM_W = 4;
        this.seamAlpha = new Float32Array(outBandsQty);
        {
            const dist = new Array(outBandsQty).fill(Infinity);
            for (let i = 1; i < outBandsQty; i++) {
                if (this.bands[i].tierIndex !== this.bands[i - 1].tierIndex) {
                    for (let k = 0; k < SEAM_W; k++) {
                        if (i - 1 - k >= 0) dist[i - 1 - k] = Math.min(dist[i - 1 - k], k);
                        if (i + k < outBandsQty) dist[i + k] = Math.min(dist[i + k], k);
                    }
                }
            }
            for (let i = 0; i < outBandsQty; i++) {
                this.seamAlpha[i] = dist[i] === Infinity ? 0 : 1 - dist[i] / SEAM_W;
            }
        }

        // 帧级缓冲复用：process 每帧调用，避免反复分配
        this._vals = new Float64Array(outBandsQty);
        this._blended = new Float64Array(outBandsQty);
        this._out = new Array(outBandsQty);
    }

    // 支路分配统计：counts[支路序号] = 频带数；crossings = 支路切换处的起始频率
    tierStats() {
        const counts = this.tiers.map(() => 0);
        const crossings = [];
        let prev = this.bands.length ? this.bands[0].tierIndex : -1;
        for (let i = 0; i < this.bands.length; i++) {
            const band = this.bands[i];
            counts[band.tierIndex]++;
            if (band.tierIndex !== prev) {
                crossings.push(band.lower);
                prev = band.tierIndex;
            }
        }
        return { counts, crossings };
    }

    // inputs: 与 tiers 一一对应的 Uint8Array（各支路 getByteFrequencyData 的结果）
    // 返回复用的内部缓冲（调用方当帧消费，不得跨帧持有）
    process(inputs) {
        // 第一遍：各频带取均方值 + 接缝校准 + A计权
        const vals = this._vals;
        for (let i = 0; i < this.outBandsQty; i++) {
            const band = this.bands[i];
            const data = inputs[band.tierIndex];

            // 频带内均方值（与库的 divide() 一致，作用在 byte 值上）
            let count = 0;
            for (let b = band.startBin; b <= band.endBin; b++) {
                count += data[b] * data[b];
            }
            let v = Math.sqrt(count / (band.endBin - band.startBin + 1));

            // 接缝校准（byte 值本身就是 dB 线性，直接相加即可）
            v += this.tierOffsets[band.tierIndex];
            if (v < 0) v = 0;

            if (this.aWeight) v *= band.aw;

            vals[i] = v;
        }

        // 第二遍：接缝平滑（在时间计权之前，边界处混入邻域均值消除断崖）
        const n = this.outBandsQty;
        const blended = this._blended;
        for (let i = 0; i < n; i++) {
            const a = this.seamAlpha[i];
            if (a <= 0) {
                blended[i] = vals[i];
                continue;
            }
            // 邻域均值：±2 频带（越界钳制）
            const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
            let avg = 0;
            for (let j = i0; j <= i1; j++) avg += vals[j];
            avg /= i1 - i0 + 1;
            blended[i] = vals[i] * (1 - a * 0.5) + avg * (a * 0.5);
        }

        // 第三遍：时间计权
        const out = this._out;
        for (let i = 0; i < n; i++) {
            let v = blended[i];
            if (this.tWeight) {
                const h = this.history[i];
                h.push(v);
                if (h.length > 5) h.shift();
                let sum = 0;
                for (let j = 0; j < h.length; j++) sum += h[j];
                v = sum / h.length;
            }
            out[i] = v;
        }
        return out;
    }
}
