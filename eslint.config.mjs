import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One project service for every type-aware block (typescript-eslint keeps a single instance)
const typedParserOptions = {
	projectService: true,
	tsconfigRootDir: import.meta.dirname,
};

export default [
	{
		ignores: [
			'**/node_modules/**',
			'site/vendor/**',
			'out/**',
			'code/**',
			'data/**',
		],
	},
	// A stale `eslint-disable` comment fails the run
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'error',
		},
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	// Turns off stylistic rules that conflict with Prettier; must come before the rules below
	prettierConfig,
	{
		files: ['**/*.{ts,js,mjs}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
		},
		plugins: {
			import: importPlugin,
		},
		rules: {
			'linebreak-style': ['error', 'unix'],
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
			curly: ['error', 'all'],
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-non-null-assertion': 'warn',
			'import/order': [
				'error',
				{
					groups: [
						'builtin',
						'external',
						'internal',
						'parent',
						'sibling',
						'index',
					],
					'newlines-between': 'always',
					alphabetize: { order: 'asc', caseInsensitive: true },
				},
			],
		},
	},
	// Collector, tools and tests run in Node: type-aware check for promises that are neither awaited nor handled
	{
		files: ['src/**/*.ts', 'tools/**/*.ts', 'test/**/*.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
			parserOptions: typedParserOptions,
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
		},
	},
	// node:test returns a promise from test(), describe() and similar; those calls are not floating
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': [
				'error',
				{
					allowForKnownSafeCalls: [
						{
							from: 'package',
							package: 'node:test',
							name: [
								'test',
								'it',
								'describe',
								'suite',
								'before',
								'after',
								'beforeEach',
								'afterEach',
							],
						},
					],
				},
			],
		},
	},
	// Repository scripts run in Node
	{
		files: ['scripts/**/*.mjs', '*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	// The dashboard is plain JavaScript for the browser (no build step)
	{
		files: ['site/**/*.js'],
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
];
