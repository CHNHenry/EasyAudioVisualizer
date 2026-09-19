// 构建脚本：esbuild 打包 main.js + 生成 .bmc 插件包（zip）
import { execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// 1. bundle（Chrome 91 原生支持 async/await 与 ESM 语法，无需转译）
execSync(
    `npx esbuild src/index.js --bundle --format=iife --target=chrome91 --outfile=main.js`,
    { cwd: root, stdio: 'inherit' }
);

// 2. 打包 .bmc（本质是 zip：manifest.json + main.js 位于压缩包根目录）
const staging = mkdtempSync(join(tmpdir(), 'eav-'));
copyFileSync(join(root, 'manifest.json'), join(staging, 'manifest.json'));
copyFileSync(join(root, 'main.js'), join(staging, 'main.js'));

// Compress-Archive 仅支持 .zip 扩展名，先压 zip 再改名 .bmc
const zipPath = join(root, 'EasyAudioVisualizer.zip');
const bmcPath = join(root, 'EasyAudioVisualizer.bmc');
execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
);
rmSync(staging, { recursive: true, force: true });
rmSync(bmcPath, { force: true });
renameSync(zipPath, bmcPath);
console.log('Done: EasyAudioVisualizer.bmc');
