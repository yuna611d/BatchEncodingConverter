import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['out/**', 'node_modules/**', '.vscode-test/**']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                ecmaVersion: 2018,
                sourceType: 'module'
            }
        },
        rules: {
            // Carried over from the tslint config this replaces.
            'curly': 'error',
            'eqeqeq': 'error',
            'semi': 'error',
            'no-throw-literal': 'error',
            '@typescript-eslint/no-unused-expressions': 'error',
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'typeLike', format: ['PascalCase'] }
            ]
        }
    }
);
