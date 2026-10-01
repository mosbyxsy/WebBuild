#!/usr/bin/env node
import { runCli } from './cli-runner.js';
import { asErrorMessage } from './errors.js';

// bin 文件只桥接真实进程与可测试的 runCli。设置 exitCode 而非立即 process.exit，
// 确保 stdout/stderr 缓冲区可以正常刷新完毕。
runCli(process.argv).catch((error: unknown) => {
  process.stderr.write(`ssb: ${asErrorMessage(error)}\n`);
  process.exitCode = 1;
});
