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
            tiers = [8192, 2048, 512]
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

            // 从最快的支路（fftSize 最小）往回找第一条满足「bin宽 ≤ 带宽」的支路
            let tierIndex = 0;
            for (let t = tiers.length - 1; t >= 1; t--) {
                if (binWidths[t] <= width) {
                    tierIndex = t;
                    break;
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
    process(inputs) {
        const out = new Array(this.outBandsQty);
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
