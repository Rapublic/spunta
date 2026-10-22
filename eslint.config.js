'use strict';
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['main.js', 'preload.js', 'eslint.config.js', 'src/**/*.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: { ...globals.node } },
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2023, globals: { ...globals.browser, module: 'readonly' } },
  },
  {
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
];
