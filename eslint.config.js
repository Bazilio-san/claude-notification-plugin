import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      'import': importPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'caughtErrorsIgnorePattern': '^_',
        'ignoreRestSiblings': true,
      }],
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { 'avoidEscape': true }],
      'space-before-function-paren': ['error', {
        'anonymous': 'always',
        'named': 'always',
        'asyncArrow': 'always',
      }],
      'object-curly-spacing': ['error', 'always'],
      'curly': ['error', 'all'],
      'brace-style': ['error', '1tbs', { 'allowSingleLine': false }],
      'indent': ['error', 2, { 'SwitchCase': 1 }],
      'eol-last': ['error', 'always'],
    },
  },
  {
    ignores: [
      '.claude/',
      '.idea/',
      'node_modules/',
      'coverage/',
      'dist/',
    ],
  },
];
