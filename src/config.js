// 配置持久化 + 设置页构建
// 使用 BetterNCM 的 readConfig/writeConfig（HTTP 异步 API）
const PREFIX = 'easyav.';

export const DEFAULTS = {
    sampleRate: '',      // '' = 自动取 AudioContext 采样率
    fftSize: '1024',
    startFrequency: '50',
    endFrequency: '9000',
    outBandsQty: '300',
    tWeight: '0',
    aWeight: '0',
    filterOn: '0',
    sigma: '1',
    radius: '2',
    multiFFT: '1',       // 多分辨率分体（LFP 与 audio 元素模式均生效）
    maxHeight: '200',    // 柱形条群最大高度 px
    colorMode: 'white',  // 'white' 白色半透明 | 'progress' 进度条颜色 | 'color' 彩色
    opacity: '0.85',     // 柱形条不透明度 0.05~1
    volumeComp: '1',     // LFP 音量电平补偿开关
    playPageOnly: '1',   // 仅在播放页显示频谱
    yOffset: '8',        // 垂直微调 px（正数下移）
    mfLowMid: '330',     // 低/中频分界线 Hz
    mfMidHigh: '1300',   // 中/高频分界线 Hz
    mfLowFft: '8192',    // 低频段支路 fftSize
    mfMidFft: '2048',    // 中频段支路 fftSize
    mfHighFft: '512'     // 高频段支路 fftSize
};

async function readConf(key) {
    try {
        const v = await betterncm.app.readConfig(PREFIX + key, DEFAULTS[key]);
        return v === undefined || v === null || v === '' ? DEFAULTS[key] : String(v);
    } catch (e) {
        return DEFAULTS[key];
    }
}

export async function loadConfig() {
    const cfg = {};
    const keys = Object.keys(DEFAULTS);
    await Promise.all(keys.map(async k => { cfg[k] = await readConf(k); }));
    return cfg;
}

export function saveConfig(cfg, key) {
    try {
        betterncm.app.writeConfig(PREFIX + key, String(cfg[key]));
    } catch (e) {
        console.error('[EasyAudioVisualizer] writeConfig failed', key, e);
    }
}

// ---------- 设置页 ----------
function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.setAttribute('style', style);
    if (text !== undefined) node.textContent = text;
    return node;
}

function row(labelText, title, control) {
    const wrap = el('div', 'margin:9px 0;');
    const r = el('div', 'display:flex;align-items:center;gap:8px;');
    const label = el('label', 'flex:0 0 190px;font-size:13px;opacity:.9;', labelText);
    r.appendChild(label);
    r.appendChild(control);
    wrap.appendChild(r);
    // 说明直接写出来，不依赖悬停
    if (title) {
        wrap.appendChild(el('div', 'font-size:11px;opacity:.5;line-height:1.5;margin-top:3px;', title));
    }
    return wrap;
}

function styledInput() {
    return {
        flex: '1', minWidth: '0', padding: '4px 8px', fontSize: '13px',
        background: 'rgba(255,255,255,.08)', color: 'inherit',
        border: '1px solid rgba(255,255,255,.2)', borderRadius: '4px'
    };
}

function input(value, attrs, onChange) {
    const inp = el('input');
    inp.value = value;
    Object.assign(inp.style, styledInput());
    Object.entries(attrs || {}).forEach(([k, v]) => inp.setAttribute(k, v));
    inp.addEventListener('change', () => onChange(inp.value));
    return inp;
}

function rangeInput(value, attrs, onChange) {
    const inp = el('input');
    inp.type = 'range';
    inp.value = value;
    inp.style.flex = '1';
    inp.style.minWidth = '0';
    Object.entries(attrs || {}).forEach(([k, v]) => inp.setAttribute(k, v));
    inp.addEventListener('input', () => onChange(inp.value));
    return inp;
}

// 自绘开关：NCM 的全局样式会干扰原生 checkbox 的视觉状态，用 div 开关绕开
// 附带 _setDisabled(bool)：禁用时变灰、忽略点击
function checkbox(checked, onChange) {
    let on = checked === '1' || checked === true;
    let disabled = false;
    const box = el('div');
    Object.assign(box.style, {
        flex: '0 0 auto', width: '38px', height: '20px', borderRadius: '10px',
        cursor: 'pointer', position: 'relative', transition: 'background .15s, opacity .15s',
        background: on ? 'rgba(90,200,130,.9)' : 'rgba(255,255,255,.18)'
    });
    const knob = el('div');
    Object.assign(knob.style, {
        position: 'absolute', top: '2px', left: on ? '20px' : '2px',
        width: '16px', height: '16px', borderRadius: '50%',
        background: '#fff', transition: 'left .15s'
    });
    box.appendChild(knob);
    box._setDisabled = d => {
        disabled = d;
        box.style.opacity = d ? '.35' : '1';
        box.style.cursor = d ? 'not-allowed' : 'pointer';
    };
    box.addEventListener('click', () => {
        if (disabled) return;
        on = !on;
        box.style.background = on ? 'rgba(90,200,130,.9)' : 'rgba(255,255,255,.18)';
        knob.style.left = on ? '20px' : '2px';
        onChange(on ? '1' : '0');
    });
    return box;
}

function select(value, options, onChange) {
    const sel = el('select');
    Object.assign(sel.style, styledInput());
    options.forEach(op => {
        const o = el('option', '', op);
        o.value = op;
        if (String(op) === String(value)) o.selected = true;
        sel.appendChild(o);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

// 数字微调按钮（NCM 全局样式会打乱原生 number spinner 的点击区域，用自绘按钮替代）
function addSteppers(inp, step, min, max, onCommit) {
    const cur = () => parseFloat(inp.value) || 0;
    const clamp = n => {
        if (min !== undefined && n < min) n = min;
        if (max !== undefined && n > max) n = max;
        return Math.round(n * 1000) / 1000;
    };
    const mk = delta => {
        const b = el('button',
            'flex:0 0 22px;padding:0;font-size:14px;cursor:pointer;background:rgba(255,255,255,.1);color:inherit;border:1px solid rgba(255,255,255,.2);border-radius:4px;line-height:1;',
            delta > 0 ? '+' : '−');
        b.addEventListener('click', () => {
            const n = clamp(cur() + delta * step);
            inp.value = String(n);
            onCommit(String(n));
        });
        return b;
    };
    const wrap = el('div', 'display:flex;gap:4px;flex:1;min-width:0;align-items:stretch;');
    wrap.appendChild(mk(-1));
    wrap.appendChild(inp);
    wrap.appendChild(mk(1));
    return wrap;
}

function numInput(cfg, key, attrs, viz) {
    const inp = input(cfg[key], attrs, v => {
        cfg[key] = v;
        saveConfig(cfg, key);
        viz.rebuild();
    });
    return addSteppers(
        inp,
        parseFloat(attrs && attrs.step) || 1,
        attrs && attrs.min !== undefined ? parseFloat(attrs.min) : undefined,
        attrs && attrs.max !== undefined ? parseFloat(attrs.max) : undefined,
        v => { cfg[key] = v; saveConfig(cfg, key); viz.rebuild(); }
    );
}

function checkInput(cfg, key, viz, after) {
    return checkbox(cfg[key], v => {
        cfg[key] = v;
        saveConfig(cfg, key);
        viz.rebuild();
        if (after) after();
    });
}

export function buildPanel(cfg, viz) {
    const root = el('div', 'padding:12px;max-width:560px;');
    root.className = 'eav-panel';
    // 隐藏原生 number spinner（NCM 样式会打乱其点击区域），改用自绘 +/− 按钮
    const style = el('style');
    style.textContent = '.eav-panel input[type=number]::-webkit-inner-spin-button,' +
        '.eav-panel input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}';
    root.appendChild(style);
    root.appendChild(el('div', 'font-size:15px;font-weight:600;margin-bottom:8px;', 'EasyAudioVisualizer 设置'));
    root.appendChild(el('div', 'font-size:12px;opacity:.6;margin-bottom:10px;',
        '所有参数即时生效（重建处理器，不影响播放）。数据源由运行环境自动协商（LibFrontendPlay 优先，audio 元素兜底）。'));

    // ---------- 运行时信息 ----------
    const statsBox = el('pre',
        'font-size:11px;line-height:1.6;background:rgba(0,0,0,.55);color:#fff;padding:8px 10px;border-radius:6px;white-space:pre-wrap;margin:0 0 10px;');
    root.appendChild(statsBox);
    const statsTimer = setInterval(() => {
        if (!root.isConnected) {
            clearInterval(statsTimer);
            return;
        }
        try {
            const s = viz.getStats();
            const srcName = { lfp: 'LibFrontendPlay', element: 'audio 元素' }[s.source] || '协商中';
            const lines = [
                '数据源: ' + srcName + (s.source === 'element' && s.elConnected === false ? '（元素已脱离 DOM，自动重挂中）' : '')
                + '    锚点: ' + (s.anchorMode || '-') + '    绘制帧数: ' + s.frames,
                '生效采样率: ' + (s.sampleRate || '-') + ' Hz    fftSize: ' + (s.fftSize || (s.multiFFT ? '按支路' : '-'))
                + '    带宽: ' + (s.bandwidth ? s.bandwidth.toFixed(2) + ' Hz/点' : '-'),
                '频段: ' + cfg.startFrequency + ' ~ ' + cfg.endFrequency + ' Hz    输出频带: ' + s.outBandsQty
                + '    倍频程倍率: ' + (s.sampleRate && s.outBandsQty
                    ? Math.pow(2, Math.log2(Math.max(20, parseFloat(cfg.endFrequency)) / Math.max(20, parseFloat(cfg.startFrequency))) / s.outBandsQty).toFixed(4)
                    : '-'),
                '高斯滤波: ' + s.filter + '    时间计权: ' + (cfg.tWeight === '1' ? '开' : '关')
                + '    A计权: ' + (cfg.aWeight === '1' ? '开' : '关') + '    柱高上限: ' + s.maxHeight + 'px'
            ];
            if (s.multiFFT) {
                lines.push('multiFFT 支路: ' + s.tiers.join(' / ') + '    交叉点: ' + s.crossings.join(' / '));
            }
            if (s.lfpVolume !== undefined) {
                lines.push('LFP 播放器音量: ' + s.lfpVolume.toFixed(2) + '    分析增益补偿: ×' + (s.compGain || 1));
            }
            if (s.accent) {
                lines.push('进度条取色: ' + s.accent);
            }
            if (cfg.sampleRate) {
                lines.push('⚠ 手动 sampleRate=' + cfg.sampleRate + '（留空可自动匹配真实采样率）');
            }
            statsBox.textContent = lines.join('\n');
        } catch (e) {
            statsBox.textContent = '统计失败: ' + e;
        }
    }, 1000);

    // ---------- 音频基础 ----------
    root.appendChild(row('sampleRate 采样率',
        '音频采样率（Hz），参与频点带宽与倍频程索引的计算。留空自动读取 AudioContext 的真实采样率（推荐）；设置错误会让频谱整体偏移，仅在自动值异常时手动指定。',
        numInput(cfg, 'sampleRate', { type: 'number', min: '8000', max: '192000', step: '100', placeholder: '留空自动' }, viz)));

    const fftRow = row('fftSize',
        'FFT 窗口大小：越大频率分辨率越高（低频更细腻），但时间响应越慢（鼓点瞬态更钝）。multiFFT 开启时此项与高斯滤波均不参与。',
        select(cfg.fftSize, ['256', '512', '1024', '2048', '4096', '8192'], v => {
            cfg.fftSize = v;
            saveConfig(cfg, 'fftSize');
            viz.rebuild();
        }));
    root.appendChild(fftRow);

    root.appendChild(row('startFrequency (Hz)',
        '分析的最低频率，倍频程从此处开始划分。设为 0 会破坏倍频程计算（内部自动钳到 20Hz），建议 20~60。',
        numInput(cfg, 'startFrequency', { type: 'number', min: '0', step: '10' }, viz)));
    root.appendChild(row('endFrequency (Hz)',
        '分析的最高频率。越高包含的高频细节越多；一般音乐建议 9000~10000，超过音源实际频谱的部分没有内容。',
        numInput(cfg, 'endFrequency', { type: 'number', min: '1', step: '100' }, viz)));
    root.appendChild(row('outBandsQty 输出频带数',
        '可视化柱形条数量，整个频段按倍频程均分成这么多带。越大细节越丰富，但单带越窄、读数越抖；300 上下适合高分辨率观感。',
        numInput(cfg, 'outBandsQty', { type: 'number', min: '1', max: '512', step: '1' }, viz)));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- 开关 ----------
    root.appendChild(row('tWeight 时间计权',
        '对最近 5 帧频谱取平均，抑制帧间突变。开启后波形更平滑、有拖尾与呼吸感，鼓点瞬态被柔化，适合缓慢律动的视觉风格；关闭则逐帧忠实还原，跳动更硬朗、更带感。',
        checkInput(cfg, 'tWeight', viz)));
    root.appendChild(row('aWeight A计权',
        '模拟人耳的等响敏感度：压低频、突出中频（人声区）。开启后频谱重心更接近听感——人声更突出，低频隆隆声被压低；关闭则按物理能量显示。',
        checkInput(cfg, 'aWeight', viz)));
    root.appendChild(row('multiFFT 多分辨率分体',
        '用三条不同窗长的 FFT 支路并行分析：低频段走大窗（频率细）、高频段走小窗（响应快），近似恒Q效果。开启后忽略上方 fftSize 与高斯滤波。分界线与各支路窗长在下方「multiFFT 定制」区调整。',
        checkInput(cfg, 'multiFFT', viz, () => {
            fftRow.querySelector('select').disabled = cfg.multiFFT === '1';
            syncFilter();
        })));
    root.appendChild(row('volumeComp 音量电平补偿',
        'LFP 播放器音量会直接衰减分析信号（音量越低频谱越矮越糊）。开启后按 1/音量 自动补偿，让频谱形态与音量设置无关，对齐网页版效果；关闭则反映真实输出电平。',
        checkInput(cfg, 'volumeComp', viz)));
    root.appendChild(row('playPageOnly 仅播放页显示',
        '开启后频谱只在播放页（黑胶页）进度条上方显示，回到其他页面自动隐藏；关闭则在没有播放页锚点时退到底部播放栏上沿或视口底部显示。',
        checkInput(cfg, 'playPageOnly', viz)));
    root.appendChild(row('maxHeight 最大高度 (px)',
        '柱形条群的最大显示高度，拉满音量时柱子到这个高度。建议 200 以上获得更好的层次感。',
        addSteppers(
            input(cfg.maxHeight, { type: 'number', min: '40', max: '400', step: '4' }, v => {
                cfg.maxHeight = v;
                saveConfig(cfg, 'maxHeight');
                viz.setMaxHeight(parseFloat(v) || 120);
            }),
            4, 40, 400,
            v => { cfg.maxHeight = v; saveConfig(cfg, 'maxHeight'); viz.setMaxHeight(parseFloat(v) || 120); }
        )));
    root.appendChild(row('yOffset 垂直微调 (px)',
        '频谱底边相对进度条顶边的偏移：正数向下移、负数向上移。用于消除切换播放页或进度条容器内边距带来的几像素偏差。即时生效。',
        addSteppers(
            input(cfg.yOffset, { type: 'number', min: '-40', max: '200', step: '1' }, v => {
                cfg.yOffset = v;
                saveConfig(cfg, 'yOffset');
            }),
            1, -40, 200,
            v => { cfg.yOffset = v; saveConfig(cfg, 'yOffset'); }
        )));

    // 颜色模式：白色半透明 / 彩色
    const colorSel = el('select');
    Object.assign(colorSel.style, styledInput());
    [['white', '白色半透明（默认）'], ['progress', '进度条颜色'], ['color', '彩色']].forEach(([v, label]) => {
        const o = el('option', '', label);
        o.value = v;
        if (cfg.colorMode === v) o.selected = true;
        colorSel.appendChild(o);
    });
    colorSel.addEventListener('change', () => {
        cfg.colorMode = colorSel.value;
        saveConfig(cfg, 'colorMode');
    });
    root.appendChild(row('colorMode 颜色模式',
        '白色半透明：柱形为白色，亮度随响度变化（辉光感），贴合任何封面背景；进度条颜色：只读播放页进度条的封面衍生填充色，随歌曲主题联动（播放页外沿用最后一次颜色）；彩色：蓝→紫→红的渐变配色，色彩随频率与响度变化。',
        colorSel));

    // 透明度：滑块 + 数字框双向同步（统一保留两位小数，避免滑条与数值不符）
    const opNorm = v => String(Math.min(1, Math.max(0.05, Math.round((parseFloat(v) || 0.85) * 100) / 100)));
    const opNum = input(cfg.opacity, { type: 'number', min: '0.05', max: '1', step: '0.01' }, v => {
        const n = opNorm(v);
        cfg.opacity = n;
        saveConfig(cfg, 'opacity');
        opNum.value = n;
        opRange.value = n;
    });
    opNum.style.flex = '0 0 90px';
    const opRange = rangeInput(cfg.opacity, { min: '0.05', max: '1', step: '0.01' }, v => {
        const n = opNorm(v);
        cfg.opacity = n;
        saveConfig(cfg, 'opacity');
        opNum.value = n;
    });
    const opWrap = el('div', 'display:flex;gap:8px;flex:1;min-width:0;');
    opWrap.appendChild(opNum);
    opWrap.appendChild(opRange);
    root.appendChild(row('opacity 透明度',
        '柱形条不透明度：越低越通透、越高越实。白色模式的辉光亮度也在此基础上随响度缩放。即时生效，无需重建。',
        opWrap));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- 滤波参数 ----------
    const filterCtl = checkInput(cfg, 'filterOn', viz);
    root.appendChild(row('filterOn 高斯滤波',
        '对频谱做空间域高斯卷积平滑：抹平相邻频点的突刺，让柱形群更连贯圆润。关闭则保留逐带的原始起伏，更锐利。multiFFT 开启时自动停用。',
        filterCtl));

    // sigma：数字框 + 滑块双向同步（与网页版一致）
    const sigmaNum = input(cfg.sigma, { type: 'number', min: '0.1', max: '250', step: '0.1' }, v => {
        cfg.sigma = v;
        saveConfig(cfg, 'sigma');
        sigmaRange.value = v;
        viz.rebuild();
    });
    sigmaNum.style.flex = '0 0 90px';
    const sigmaRange = rangeInput(cfg.sigma, { min: '0.1', max: '250', step: '0.1' }, v => {
        cfg.sigma = v;
        saveConfig(cfg, 'sigma');
        sigmaNum.value = v;
        viz.rebuild();
    });
    const sigmaWrap = el('div', 'display:flex;gap:8px;flex:1;min-width:0;');
    sigmaWrap.appendChild(sigmaNum);
    sigmaWrap.appendChild(sigmaRange);
    root.appendChild(row('sigma',
        '高斯核的标准差 σ：越大平滑越强，波形越柔和；过大会把细节和峰都抹平。仅 filterOn 开启时生效。',
        sigmaWrap));

    root.appendChild(row('radius 滤波半径',
        '卷积核半径（核长 = 2×radius+1）：决定每个频点向两侧取多少邻居参与平滑，0 相当于不滤波。仅 filterOn 开启时生效。',
        numInput(cfg, 'radius', { type: 'number', min: '0', max: '20', step: '1' }, viz)));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- multiFFT 定制 ----------
    root.appendChild(el('div', 'font-size:13px;font-weight:600;margin:4px 0 2px;', 'multiFFT 定制'));
    root.appendChild(row('mfLowMid 低/中分界线 (Hz)',
        '低于此频率的频带走低频支路（大窗、频率细），介于两条分界线之间走中频支路。留空或非法值时回退为按带宽自动选择支路。',
        numInput(cfg, 'mfLowMid', { type: 'number', min: '1', step: '10' }, viz)));
    root.appendChild(row('mfMidHigh 中/高分界线 (Hz)',
        '高于此频率的频带走高频支路（小窗、响应快）。',
        numInput(cfg, 'mfMidHigh', { type: 'number', min: '1', step: '50' }, viz)));
    const fftOptions = ['256', '512', '1024', '2048', '4096', '8192', '16384'];
    root.appendChild(row('mfLowFft 低频支路窗长',
        '低频段使用的 FFT 窗长。越大低频分隔越细（如 8192 在 48kHz 下每点约 5.9Hz），代价是低频响应稍慢。默认 8192。',
        select(cfg.mfLowFft, fftOptions, v => { cfg.mfLowFft = v; saveConfig(cfg, 'mfLowFft'); viz.rebuild(); })));
    root.appendChild(row('mfMidFft 中频支路窗长',
        '中频段使用的 FFT 窗长，兼顾分辨率与响应速度。默认 2048。',
        select(cfg.mfMidFft, fftOptions, v => { cfg.mfMidFft = v; saveConfig(cfg, 'mfMidFft'); viz.rebuild(); })));
    root.appendChild(row('mfHighFft 高频支路窗长',
        '高频段使用的 FFT 窗长。越小瞬态响应越快（鼓点嚓声更跟手），高频本身频率高、用小窗分辨率也够。默认 512。',
        select(cfg.mfHighFft, fftOptions, v => { cfg.mfHighFft = v; saveConfig(cfg, 'mfHighFft'); viz.rebuild(); })));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- 恢复默认 ----------
    const resetBtn = el('button', 'padding:5px 14px;font-size:13px;cursor:pointer;background:rgba(255,255,255,.1);color:inherit;border:1px solid rgba(255,255,255,.25);border-radius:4px;', '恢复默认');
    resetBtn.addEventListener('click', () => {
        Object.keys(DEFAULTS).forEach(k => {
            cfg[k] = DEFAULTS[k];
            saveConfig(cfg, k);
        });
        viz.rebuild();
        viz.setMaxHeight(parseFloat(cfg.maxHeight) || 120);
        const fresh = buildPanel(cfg, viz);
        root.replaceWith(fresh);
    });
    root.appendChild(resetBtn);

    // 初始联动状态
    const syncFilter = () => {
        const multiOn = cfg.multiFFT === '1';
        if (multiOn && cfg.filterOn !== '0') {
            // multiFFT 开启时自动取消勾选并停用高斯滤波
            cfg.filterOn = '0';
            saveConfig(cfg, 'filterOn');
        }
        try { filterCtl._setDisabled(multiOn); } catch (e) { /* 忽略 */ }
    };
    syncFilter();
    try { fftRow.querySelector('select').disabled = cfg.multiFFT === '1'; } catch (e) { /* 忽略 */ }

    return root;
}
