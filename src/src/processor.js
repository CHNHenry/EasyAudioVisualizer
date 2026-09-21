// EasyAudioVisualizer 信号处理核心
// 移植自 sound-processor（https://github.com/takagen99? 原库）src/index.js + src/util.js
// 流水线：高斯滤波 → 时间计权(5帧) → A计权 → 倍频程划分

// A计权（IEC 标准 A 计权曲线），f 为频率
function aWeighting (f) {
    const f2 = f * f;
    return 1.2588966 * 148840000 * f2 * f2 /
        ((f2 + 424.36) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148840000));
}

// 高斯公式（正态分布密度）
function gauss(x, sigma = 1, mu = 0) {
    return Math.pow(Math.E, -(Math.pow(x - mu, 2) / (2 * sigma * sigma)));
}

class SoundProcessor {
    constructor(options = {}) {
        const {
            filterParams,
            sampleRate,
            fftSize,
            endFrequency,
            startFrequency,
            outBandsQty,
            tWeight,
            aWeight
        } = options;

        if (!fftSize || !sampleRate || !outBandsQty) {
            throw new Error('need fftSize, sampleRate and outBandsQty');
        }

        this.sampleRate = sampleRate; // 采样率
        this.fftSize = fftSize || 1024; // fftSize
        this.bandsQty = Math.floor(fftSize / 2); // 频带数
        this.outBandsQty = outBandsQty; // 输出的频带数
        this.bandwidth = sampleRate / fftSize; // 带宽
        this.startFrequency = startFrequency || 0;
        this.endFrequency = endFrequency || 10000;
        this.tWeight = !!tWeight;
        this.aWeight = aWeight === undefined ? true : !!aWeight;

        if (filterParams) {
            // 默认标准正态分布: N(0, 1)
            this.filterParams = {
                mu: 0, // 固定为0
                sigma: filterParams.sigma || 1,
                filterRadius: filterParams.radius === undefined ? 2 : Math.floor(filterParams.radius)
            };
        }

        this.aWeights = [];
        this.bands = [];
        this.gKernel = [];

        this.historyLimit = 5;
        this.history = [];

        this.initWeights();
        this.initBands();
        // 仅在配置了滤波参数时才初始化高斯核，
        // 否则 initGaussKernel 内部解构 undefined 的 filterParams 会抛 TypeError
        if (this.filterParams) {
            this.initGaussKernel();
        }

        this.process = this.process.bind(this);
    }

    initWeights() {
        const { bandwidth, bandsQty, aWeights } = this;
        for (let i = 0; i < bandsQty; i++) {
            aWeights.push(aWeighting(i * bandwidth));
        }
    }

    initBands() {
        const { endFrequency, startFrequency, outBandsQty, bands } = this;

        // 根据起止频谱、频带数量确定倍频数: N
        // fu = 2^(1/N)*fl  => n = 1/N = log2(fu/fl) / bandsQty
        let n = Math.log2(endFrequency / startFrequency) / outBandsQty;
        n = Math.pow(2, n); // n = 2^(1/N)

        const nextBand = {
            lowerFrequency: Math.max(startFrequency, 0),
            upperFrequency: 0
        };

        for (let i = 0; i < outBandsQty; i++) {
            // 频带的上频点是下频点的2^n倍
            const upperFrequency = nextBand.lowerFrequency * n;
            nextBand.upperFrequency = Math.min(upperFrequency, endFrequency);

            bands.push({
                lowerFrequency: nextBand.lowerFrequency,
                upperFrequency: nextBand.upperFrequency
            });
            nextBand.lowerFrequency = upperFrequency;
        }
    }

    initGaussKernel() {
        const { filterParams, gKernel } = this;
        const { mu, sigma, filterRadius } = filterParams;
        const radius = filterRadius;

        for (let i = -radius; i < 1; i++) {
            // step=1
            gKernel.push(gauss(i, sigma, mu));
        }

        for (let i = radius - 1; i > -1; i--) {
            // 对称
            gKernel.push(gKernel[i]);
        }

        this.gKernelSum = gKernel.reduce((prev, curr) => {
            return prev + curr;
        });
        this.filterRadius = filterRadius;
    }

    filter(frequencies) {
        const { gKernel, gKernelSum, filterRadius } = this;

        if (!filterRadius) return;

        // 滤波
        for (let i = 0; i < frequencies.length; i++) {
            let count = 0;
            for (let j = i - filterRadius; j < i + filterRadius; j++) {
                const value = frequencies[j] !== undefined ? frequencies[j] : 0;
                count += value * gKernel[j - i + filterRadius];
            }

            frequencies[i] = (count / gKernelSum);
        }
    }

    aWeighting(frequencies) {
        const { aWeights } = this;

        for (let i = 0; i < frequencies.length; i++) {
            if (aWeights[i] !== undefined) {
                frequencies[i] = frequencies[i] * aWeights[i];
            }
        }
    }

    divide(frequencies) {
        const { outBandsQty, bandwidth, bands } = this;
        const temp = new Array(outBandsQty);

        for (let i = 0; i < bands.length; i++) {
            const band = bands[i];
            const startIndex = Math.floor(band.lowerFrequency / bandwidth);
            const endIndex = Math.min(
                Math.floor(band.upperFrequency / bandwidth),
                frequencies.length - 1
            );

            let count = 0;
            // 均方值
            for (let j = startIndex; j <= endIndex; j++) {
                count += frequencies[j] * frequencies[j];
            }
            temp[i] = Math.sqrt(count / (endIndex + 1 - startIndex));
        }
        return temp;
    }

    timeWeighting(frequencies) {
        const { history, historyLimit } = this;

        if (history.length < 5) {
            history.push(frequencies.slice(0));
        } else {
            history.pop();
            history.unshift(frequencies.slice(0));
            for (let i = 0; i < frequencies.length; i++) {
                let count = 0;
                for (let j = 0; j < historyLimit; j++) {
                    count += history[j][i] / historyLimit;
                }
                frequencies[i] = count;
            }
        }
    }

    process(frequencies) {
        // 1. filter
        if (this.filterParams) {
            this.filter(frequencies);
        }

        // 2. time weight
        if (this.tWeight) {
            this.timeWeighting(frequencies);
        }

        // 3. a weight
        if (this.aWeight) {
            this.aWeighting(frequencies);
        }

        // 4. spectrum divide
        return this.divide(frequencies);
    }
}

export { SoundProcessor, aWeighting };
