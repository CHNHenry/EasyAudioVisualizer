// 配置持久化 + 设置页构建
// 使用 BetterNCM 的 readConfig/writeConfig（HTTP 异步 API）
const PREFIX = 'easyav.';

export const DEFAULTS = {
    sampleRate: '',      // '' = 自动取 AudioContext 采样率
    fftSize: '1024',
    startFrequency: '150',
    endFrequency: '4500',
    outBandsQty: '81',
    tWeight: '1',
    aWeight: '1',
    filterOn: '1',
    sigma: '1',
    radius: '2',
    multiFFT: '0',       // 多分辨率分体 8192/2048/512（仅 audio 元素模式生效）
    maxHeight: '120'     // 柱形条群最大高度 px
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
    const r = el('div', 'display:flex;align-items:center;gap:8px;margin:6px 0;');
    const label = el('label', 'flex:0 0 190px;font-size:13px;opacity:.85;cursor:default;', labelText);
    label.title = title || '';
    r.appendChild(label);
    r.appendChild(control);
    return r;
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

function checkbox(checked, onChange) {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked === '1' || checked === true;
    box.style.flex = '0 0 auto';
    box.addEventListener('change', () => onChange(box.checked ? '1' : '0'));
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

function numInput(cfg, key, attrs, viz) {
    return input(cfg[key], attrs, v => {
        cfg[key] = v;
        saveConfig(cfg, key);
        viz.rebuild();
    });
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
    root.appendChild(el('div', 'font-size:15px;font-weight:600;margin-bottom:8px;', 'EasyAudioVisualizer 设置'));
    root.appendChild(el('div', 'font-size:12px;opacity:.6;margin-bottom:10px;',
        '所有参数即时生效（重建处理器，不影响播放）。悬停查看各项说明。数据源由运行环境自动协商（LibFrontendPlay 优先，audio 元素兜底）。'));

    // ---------- 运行时信息 ----------
    const statsBox = el('pre',
        'font-size:11px;line-height:1.6;opacity:.75;background:rgba(255,255,255,.05);padding:8px 10px;border-radius:6px;white-space:pre-wrap;margin:0 0 10px;');
    root.appendChild(statsBox);
    const statsTimer = setInterval(() => {
        if (!root.isConnected) {
            clearInterval(statsTimer);
            return;
        }
        try {
            const s = viz.getStats();
            const lines = [
                '数据源: ' + (s.source || '协商中') + '    锚点: ' + (s.anchorMode || '-') + '    绘制帧数: ' + s.frames,
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
        '参与计算频点带宽与倍频程索引，留空自动取真实采样率（推荐）',
        numInput(cfg, 'sampleRate', { type: 'number', min: '8000', max: '192000', step: '100', placeholder: '留空自动' }, viz)));

    const fftRow = row('fftSize',
        'FFT 窗口大小：越大低频越细但响应越慢；multiFFT 开启时忽略此项',
        select(cfg.fftSize, ['256', '512', '1024', '2048', '4096', '8192'], v => {
            cfg.fftSize = v;
            saveConfig(cfg, 'fftSize');
            viz.rebuild();
        }));
    root.appendChild(fftRow);

    root.appendChild(row('startFrequency (Hz)',
        '倍频程起始频率，取该频率以上信号；不能为 0，否则输出全为 NaN',
        numInput(cfg, 'startFrequency', { type: 'number', min: '0', step: '10' }, viz)));
    root.appendChild(row('endFrequency (Hz)',
        '倍频程截止频率上限；一般音乐建议 50~10000',
        numInput(cfg, 'endFrequency', { type: 'number', min: '1', step: '100' }, viz)));
    root.appendChild(row('outBandsQty 输出频带数',
        '可视化柱子数量；越大细节多但单带能量弱',
        numInput(cfg, 'outBandsQty', { type: 'number', min: '1', max: '512', step: '1' }, viz)));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- 开关 ----------
    root.appendChild(row('tWeight 时间计权', '对最近 5 帧取平均，画面更平滑有拖尾；关闭则更硬朗',
        checkInput(cfg, 'tWeight', viz)));
    root.appendChild(row('aWeight A计权', '模拟人耳频率敏感度：压低频、突出中频（人声区）',
        checkInput(cfg, 'aWeight', viz)));
    root.appendChild(row('multiFFT 多分辨率分体', '低频走 8192 求清晰、高频走 512 求迅速（恒Q近似）；开启后忽略 fftSize 与高斯滤波。仅 audio 元素模式生效，LFP 数据源固定 2048 窗',
        checkInput(cfg, 'multiFFT', viz, () => {
            fftRow.querySelector('select').disabled = cfg.multiFFT === '1';
        })));
    root.appendChild(row('maxHeight 最大高度 (px)', '柱形条群的最大显示高度',
        input(cfg.maxHeight, { type: 'number', min: '40', max: '400', step: '4' }, v => {
            cfg.maxHeight = v;
            saveConfig(cfg, 'maxHeight');
            viz.setMaxHeight(parseFloat(v) || 120);
        })));

    root.appendChild(el('hr', 'border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0;'));

    // ---------- 滤波参数 ----------
    root.appendChild(row('filterOn 高斯滤波', '抹平相邻频点突刺，画面更圆润；关闭更锐利',
        checkInput(cfg, 'filterOn', viz)));

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
    root.appendChild(row('sigma', '高斯 σ：越大平滑越强，过大会抹平细节（0.1~250）', sigmaWrap));

    root.appendChild(row('radius 滤波半径', '卷积核半径（核长 2r+1），0 相当于不滤波',
        numInput(cfg, 'radius', { type: 'number', min: '0', max: '20', step: '1' }, viz)));

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
    try { fftRow.querySelector('select').disabled = cfg.multiFFT === '1'; } catch (e) { /* ignore */ }

    return root;
}
