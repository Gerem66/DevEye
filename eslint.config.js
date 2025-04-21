import react from 'eslint-plugin-react';
import { browser, node } from 'globals';
import { configs } from '@eslint/js';
import { configs as _configs } from 'eslint-plugin-react';
import configPrettier from 'eslint-config-prettier';
import prettier from 'eslint-plugin-prettier';

export default [
    { files: ['**/*.{js,mjs,cjs,ts}'] },
    { languageOptions: { globals: { ...browser, ...node } } },
    configs.recommended,
    _configs.recommended,
    configPrettier,

    {
        settings: {
            react: {
                version: 'detect'
            }
        },
        files: ['**/*.{js,mjs,cjs,ts,tsx}'],
        plugins: { prettier, react },
        rules: {
            semi: ['warn', 'always'],
            quotes: [
                'warn',
                'single',
                {
                    avoidEscape: true,
                    allowTemplateLiterals: true
                }
            ],
            //resolve: {
            //    fullySpecified: false
            //},
            //indent: ['warn', 4],
            'react/no-unescaped-entities': 'off',
            'react/prop-types': 'off',
            'react/react-in-jsx-scope': 'off',
            'no-control-regex': 'off',
            'jsx-quotes': ['warn', 'prefer-single'],
            'comma-dangle': ['warn', 'never'],
            'eol-last': ['warn', 'always'],
            'dot-notation': 'off',
            'no-bitwise': 'off',
            curly: ['warn', 'multi-line'],
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
            'prettier/prettier': [
                'warn',
                {
                    singleQuote: true,
                    parser: 'typescript',
                    tabWidth: 4,
                    jsxSingleQuote: true,
                    avoidEscape: true,
                    trailingComma: 'none',
                    printWidth: 120
                }
            ]
        }
    }
];
