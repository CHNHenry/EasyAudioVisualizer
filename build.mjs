// 构建脚本：esbuild 打包 main.js + 生成 .bmc 插件包（zip）
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// 产物统一落在固定临时目录（沙箱对工作区二进制写入有限制/会被虚拟化重定向，
// 且重定向可能让 esbuild 打进旧代码），安装时从该目录复制
const outDir = join(tmpdir(), 'eav-build');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. bundle（Chrome 91 原生支持 async/await 与 ESM 语法，无需转译）。
// main.js 落在仓库根目录：插件市场的自动打包脚本会抓取仓库树，
// manifest injects 引用的 ./main.js 必须随仓库提交
execSync(
    `npx esbuild src/index.js --bundle --format=iife --target=chrome91 --outfile=main.js`,
    { cwd: root, stdio: 'inherit' }
);

// 2. 打包 .bmc（本质是 zip：manifest.json + main.js 位于压缩包根目录）
const staging = mkdtempSync(join(tmpdir(), 'eav-'));
copyFileSync(join(root, 'manifest.json'), join(staging, 'manifest.json'));
copyFileSync(join(root, 'main.js'), join(staging, 'main.js'));

// Compress-Archive 仅接受 .zip 扩展名，压到 outDir 后改名为 .bmc（内容即 zip，扩展名无关）
const zipPath = join(outDir, 'plugin.zip');
execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
);
const bmcPath = join(outDir, 'EasyAudioVisualizer.bmc');
copyFileSync(zipPath, bmcPath);
rmSync(staging, { recursive: true, force: true });
console.log('Build OK:', bmcPath);