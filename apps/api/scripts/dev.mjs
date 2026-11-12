/**
 * 文件作用：API 开发模式启动脚本。
 *
 * 关键概念：
 * 1. 为什么不用 tsx / @nestjs/cli？—— 它们基于 esbuild，不产出 emitDecoratorMetadata，
 *    导致 NestJS 依赖注入在运行时拿到的 constructor 参数全是 undefined，服务启动就崩。
 *    详见 Errors & Resolutions #2。
 * 2. 方案：用 tsc --watch 编译（保留装饰器元数据）+ node --watch 运行编译产物。
 *    tsc 改了文件自动重编译，node --watch 检测到 dist/main.js 变化自动重启服务。
 * 3. 启动流程：
 *    a. 先删 dist 目录，避免旧产物干扰。
 *    b. 启动 tsc --watch 开始编译。
 *    c. 轮询等待 dist/main.js 出现（最多等 60 秒）。
 *    d. 出现后再等 1 秒（确保编译完整），然后启动 node --watch dist/main.js。
 * 4. 信号处理：SIGINT/SIGTERM 时同时杀掉 tsc 和 node 子进程，避免残留。
 * 5. 跨平台：Windows 下用 pnpm.cmd，需要 shell:true；Linux/macOS 直接 pnpm。
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * 开发模式：tsc watch 编译（保留 emitDecoratorMetadata）+ node --watch 运行。
 * 不使用 esbuild 类工具，避免 NestJS 依赖注入因缺少装饰器元数据而失效。
 */

// 判断平台，Windows 下命令名和 spawn 行为不同。
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
// tsc 编译参数：使用 tsconfig.build.json（排除测试文件，只编译源码）。
const tscArgs = ['exec', 'tsc', '-p', 'tsconfig.build.json'];

// 启动前清理旧的编译产物，避免 incremental 编译残留旧文件。
rmSync('dist', { recursive: true, force: true });

// 启动 tsc --watch，stdio:'inherit' 让 tsc 的输出直接显示在终端。
const compile = spawn(pnpm, [...tscArgs, '--watch', '--preserveWatchOutput'], {
  stdio: 'inherit',
  shell: isWindows, // Windows 下需要 shell 才能找到 .cmd
});

// node 服务进程，稍后启动。
let serve;
// 关闭标志，防止重复执行 shutdown。
let closing = false;

// 优雅关闭：杀掉 tsc 和 node 子进程，然后退出。
function shutdown(code = 0) {
  if (closing) {
    return;
  }

  closing = true;
  compile.kill();
  serve?.kill();
  process.exit(code);
}

// 监听 Ctrl+C 和终止信号。
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// tsc 异常退出（如编译致命错误）时，把退出码传出去。
compile.on('exit', (code) => {
  if (!closing && code) {
    shutdown(code);
  }
});

// 等待 dist/main.js 生成后启动 node 服务。
async function startServer() {
  // 最多轮询 120 次 * 500ms = 60 秒，防止 tsc 卡死时无限等待。
  for (let attempt = 0; attempt < 120 && !closing; attempt += 1) {
    if (existsSync('dist/main.js')) {
      // 文件出现后再等 1 秒，确保 tsc 把所有依赖文件都编译完（main.js 可能最先生成）。
      await delay(1000);
      break;
    }
    await delay(500);
  }

  if (closing) {
    return;
  }

  // 超时还没生成，报错退出。
  if (!existsSync('dist/main.js')) {
    console.error('编译超时：未生成 dist/main.js');
    shutdown(1);
    return;
  }

  // 启动 node --watch：检测到 dist/main.js 变化自动重启。
  // process.execPath 是当前 node 可执行文件路径，保证用同一个 node 版本。
  serve = spawn(process.execPath, ['--watch', 'dist/main.js'], { stdio: 'inherit' });
  serve.on('exit', (code) => {
    if (!closing && code) {
      shutdown(code);
    }
  });
}

// 启动服务等待逻辑（void 忽略 Promise）。
void startServer();
