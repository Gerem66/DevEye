import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
    { ignores: ['dist', 'node_modules'] },
    { files: ['**/*.{js,mjs,cjs,ts}'] },
    {
        languageOptions: {
            // Pin the TS root to this config's directory so typescript-eslint
            // doesn't bail when the editor lints from the workspace root, where
            // both this repo and client/ are candidate roots.
            parserOptions: {
                tsconfigRootDir: import.meta.dirname
            },
            globals: {
                ...globals.node
            }
        }
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            prettier: prettierPlugin
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-control-regex': 'off',
            'dot-notation': 'off',
            'no-bitwise': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            'max-len': [
                'error',
                {
                    code: 120,
                    ignoreUrls: true,
                    ignoreComments: true,
                    ignoreStrings: true,
                    ignoreTemplateLiterals: true
                }
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true
                }
            ],
            'prettier/prettier': 'warn'
        }
    },
    eslintConfigPrettier
];
