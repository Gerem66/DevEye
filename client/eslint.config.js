import js from '@eslint/js';
import react from 'eslint-plugin-react';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    { ignores: ['build', 'dist', 'node_modules'] },
    { files: ['**/*.{js,mjs,cjs,ts,tsx}'] },
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true
                }
            }
        }
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            react: react,
            prettier: prettierPlugin
        },
        rules: {
            ...react.configs.recommended.rules,
            'react/react-in-jsx-scope': 'off',
            'react/prop-types': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
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
            'prettier/prettier': 'warn'
        },
        settings: {
            react: {
                version: 'detect'
            }
        }
    },
    eslintConfigPrettier
];
