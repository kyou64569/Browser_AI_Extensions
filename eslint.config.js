// eslint.config.js
// ESLint 9 的 flat config（.eslintrc.json 已不再被 v9 默认读取）。
// 目的不是追求风格统一，而是把「改坏了能立刻发现」的能力建起来：
//   no-undef —— 重构（尤其是拆分巨型模块）后最容易留下悬空引用，这是本次接入的首因
//   no-unused-vars —— 抓出删函数时漏删的 import
//   no-redeclare —— 抓出重复声明（service-worker 曾出现过同名常量两处定义）
import globals from 'globals';

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
        OffscreenCanvas: 'readonly',
        NodeFilter: 'readonly',
        XPathResult: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // catch (_) {} 是本项目的既定写法（"明确表示此处忽略异常"），不算未使用变量；
      // 但 catch (e) 里什么都不做仍要警告——那种多半是漏了日志。
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_$',
      }],
      'no-redeclare': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-cond-assign': ['error', 'except-parens'],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-throw-literal': 'warn',
      'require-atomic-updates': 'off',
    },
  },
  // 内容脚本与 offscreen 是传统脚本（非 module），且运行在页面/离屏文档环境
  {
    files: ['content/**/*.js', 'offscreen/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly' } },
  },
  // AudioWorklet 处理器运行在 AudioWorkletGlobalScope，不是普通浏览器环境
  {
    files: ['offscreen/pcm-worklet.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
      },
    },
  },
  // 测试与本地预览服务跑在 Node 下
  {
    files: ['test/**/*.mjs', 'dev-server.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  { ignores: ['test-pptx/**', 'vendor/**', 'cleanup_backup_*/**', 'node_modules/**', '.tmpcheck/**'] },
];
