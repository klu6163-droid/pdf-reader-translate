/**
 * ESLint 配置：React 18 + TypeScript + Prettier 兼容。
 * 使用传统 .eslintrc 格式以兼容 ESLint 8。
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect' },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  rules: {
    // React 18 + TS 下不需要显式引入 React
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',

    // 无用变量：允许下划线前缀参数
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // any 只 warn 不 error（pdfjs 类型缺失场景已知）
    '@typescript-eslint/no-explicit-any': 'warn',

    // 依赖数组遗漏是常见 bug 源头，保留为 warning
    'react-hooks/exhaustive-deps': 'warn',

    // HMR 相关：允许在非组件文件里 export 常量/函数
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  ignorePatterns: [
    'dist/',
    'build/',
    'src-tauri/target/',
    'src-tauri/gen/',
    'node_modules/',
    'coverage/',
    'scripts/',
  ],
};
