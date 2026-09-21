// EasyAudioVisualizer - BetterNCM/Chromatic 插件入口
// 设计原则：任何一环失败都不能阻断启动——配置挂起也照常启动可视化
import { loadConfig, buildPanel, DEFAULTS } from './config.js';
import { createVisualizer } from './visualizer.js';

const TAG = '[EasyAudioVisualizer]';

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
    } catch (e) {
        console.error(TAG, 'boot failed', e);
    }
}

// 尽快启动（不等 plugin.onLoad、不等配置）
whenBody(boot);

// 配置异步到达后原地更新
loadConfig().then(real => {
    Object.assign(cfg, real);
    if (viz) {
        viz.rebuild();
        // maxHeight 在 visualizer 创建时被快照进状态，配置晚到时必须显式应用
        if (typeof viz.setMaxHeight === 'function') {
            viz.setMaxHeight(parseFloat(cfg.maxHeight) || 120);
        }
    }
}).catch(e => {
    console.error(TAG, 'config load failed', e);
});

// BetterNCM 生命周期：调用注册式 API（与 PluginMarket/LFP 一致）
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
