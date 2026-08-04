// Minimal, dependency-light ESLint flat config (CommonJS project -- see
// package.json "type": "commonjs").
'use strict';

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Browser globals -- protected/app.js, public/*.js run in the browser.
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        FormData: 'readonly',
        URLSearchParams: 'readonly',
        // login.js MFA input handling, leaflet map globals used inline.
        L: 'readonly',
        Chart: 'readonly',
        ResizeObserver: 'readonly',
        WebSocket: 'readonly',
        confirm: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['node_modules/**', 'protected/vendor/**'],
  },
];
