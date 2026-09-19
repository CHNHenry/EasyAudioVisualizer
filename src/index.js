// EasyAudioVisualizer - BetterNCM/Chromatic 插件入口
import { loadConfig, buildPanel } from './config.js';
import { createVisualizer } from './visualizer.js';

const TAG = '[EasyAudioVisualizer]';

let cfg = null;
let viz = null;
let panel = null;

async function init() {
    cfg = await loadConfig();
    viz = createVisualizer(cfg);
    viz.start();
    console.info(TAG, 'loaded, config =', cfg);
}

// plugin 全局由 BetterNCM 注入；缺失时兜底（便于在普通页面调试）
const pluginRef = typeof plugin !== 'undefined' ? plugin : (window.plugin = window.plugin || {});

pluginRef.onLoad = function () {
    init().catch(e => console.error(TAG, 'init failed', e));
};

pluginRef.onConfig = function () {
    if (!cfg || !viz) {
        const tip = document.createElement('div');
        tip.textContent = 'EasyAudioVisualizer 正在初始化...';
        return tip;
    }
    if (!panel) panel = buildPanel(cfg, viz);
    return panel;
};

// 调试入口
window.EasyAudioVisualizer = {
    get config() { return cfg; },
    get visualizer() { return viz; }
};
