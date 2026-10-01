#!/usr/bin/env node
import { asErrorMessage } from './errors.js';
import { runCli } from './cli-runner.js';

// bin 入口只负责把真实进程参数交给可测试的 CLI 运行器，并统一处理顶层错误。
// 不直接调用 process.exit()，可以让标准输出/错误流正常刷新，同时保留正确退出码。
runCli(process.argv, { commandName: 'extb' }).catch((error: unknown) => {
  process.stderr.write(`extb: ${asErrorMessage(error)}\n`);
  process.exitCode = 1;
});
