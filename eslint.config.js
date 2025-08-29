import react from 'eslint-plugin-react';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
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
            'react/react-in-jsx-scope': 'off', // React 17+ doesn't need React import
            'react/prop-types': 'off', // Using TypeScript instead
            semi: ['warn', 'always'],
            'object-curly-spacing': ['warn', 'always'], // Spaces between { }
            '@typescript-eslint/no-explicit-any': 'warn',
            quotes: [
                'warn',
                'single',
                {
                    avoidEscape: true,
                    allowTemplateLiterals: true
                }
            ],
            'no-control-regex': 'off',
            'jsx-quotes': ['warn', 'prefer-single'],
            'comma-dangle': ['warn', 'never'],
            'eol-last': ['warn', 'always'],
            'dot-notation': 'off',
            'no-bitwise': 'off',
            // curly: ['warn', 'multi-line'],
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
            'prettier/prettier': [
                'warn',
                {
                    singleQuote: true,
                    tabWidth: 4,
                    jsxSingleQuote: true,
                    trailingComma: 'none',
                    printWidth: 120,
                    bracketSpacing: true
                }
            ]
        },
        settings: {
            react: {
                version: 'detect'
            }
        }
    }
];
