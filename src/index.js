// EasyAudioVisualizer - BetterNCM/Chromatic 插件入口
// 设计原则：任何一环失败都不能阻断启动——配置挂起也照常启动可视化
import { loadConfig, buildPanel } from './config.js';
import { createVisualizer } from './visualizer.js';

const TAG = '[EasyAudioVisualizer]';

// ---------- 最早的生存信号：不依赖任何异步 API ----------
function writeBootMarker(payload) {
    const s = JSON.stringify(payload, null, 2);
    // 1) 同步 native API（LFP 验证过可用）
    try {
        if (typeof betterncm_native !== 'undefined' && betterncm_native && betterncm_native.app && betterncm_native.fs) {
            const p = betterncm_native.app.datapath();
            payload.dataPath = p;
            betterncm_native.fs.writeFileText(p + '\\eav-debug.json', s);
            betterncm_native.fs.writeFileText('eav-debug.json', s);
            payload.wrote = 'native';
        }
    } catch (e) {
        payload.nativeErr = String(e);
    }
    // 2) HTTP API 兜底
    try {
        if (typeof betterncm !== 'undefined' && betterncm && betterncm.fs) {
            betterncm.fs.writeFileText('eav-debug.json', s).catch(() => {});
        }
    } catch (e) { /* ignore */ }
    // 3) 窗口标题面包屑（用户可见，零依赖）
    try {
        if (!document.title.includes('[EAV')) {
            window.__eavOrigTitle = document.title;
        }
        document.title = '[EAV ' + payload.phase + (payload.source ? ':' + payload.source : '') + '] ' + (window.__eavOrigTitle || '');
    } catch (e) { /* ignore */ }
}

writeBootMarker({ phase: 'script-loaded', ts: Date.now() });

// 等待 body 就绪后再碰 DOM
function whenBody(cb) {
    if (document.body) return cb();
    const iv = setInterval(() => {
        if (document.body) {
            clearInterval(iv);
            cb();
        }
    }, 50);
}

const cfg = {}; // 活对象：先默认值启动，配置到达后原地更新
const DEFAULTS = {
    sampleRate: '',
    fftSize: '1024',
    startFrequency: '150',
    endFrequency: '4500',
    outBandsQty: '81',
    tWeight: '1',
    aWeight: '1',
    filterOn: '1',
    sigma: '1',
    radius: '2',
    multiFFT: '0',
    maxHeight: '120'
};
Object.assign(cfg, DEFAULTS);

let viz = null;
let booted = false;
let panel = null;

function boot() {
    if (booted) return;
    booted = true;
    try {
        viz = createVisualizer(cfg);
        viz.start();
        writeBootMarker({ phase: 'visualizer-created' });
    } catch (e) {
        writeBootMarker({ phase: 'boot-error', error: String(e && e.stack || e) });
        console.error(TAG, e);
    }
}

// 尽快启动（不等 plugin.onLoad、不等配置）
whenBody(boot);

// 配置异步到达后原地更新
loadConfig().then(real => {
    Object.assign(cfg, real);
    writeBootMarker({ phase: 'config-loaded' });
    if (viz) viz.rebuild();
}).catch(e => {
    writeBootMarker({ phase: 'config-error', error: String(e) });
});

// 兼容 BetterNCM 生命周期：正确用法是「调用 plugin.onLoad/onConfig 注册回调」
// （PluginMarket/LFP 均如此）。直接赋值会覆盖运行时的注册函数，
// 导致插件管理器查不到配置页注册记录而把插件置灰。
const pluginRef = typeof plugin !== 'undefined' ? plugin : (window.plugin = window.plugin || {});

function safeRegister(name, cb) {
    const fn = pluginRef[name];
    if (typeof fn === 'function' && !fn.__eavAssigned) {
        try {
            fn.call(pluginRef, cb);
            return 'registered';
        } catch (e) { /* 落到赋值兜底 */ }
    }
    cb.__eavAssigned = true;
    pluginRef[name] = cb;
    return 'assigned';
}

safeRegister('onLoad', function () {
    whenBody(boot);
});

safeRegister('onConfig', function () {
    if (!viz) {
        const tip = document.createElement('div');
        tip.setAttribute('style', 'padding:12px;font-size:13px;');
        tip.textContent = 'EasyAudioVisualizer 正在初始化...';
        return tip;
    }
    if (!panel) panel = buildPanel(cfg, viz);
    return panel;
});

// 调试入口
window.EasyAudioVisualizer = {
    get config() { return cfg; },
    get visualizer() { return viz; }
};
