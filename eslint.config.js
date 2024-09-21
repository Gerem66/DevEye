const globals = require('globals');
const pluginJs = require('@eslint/js');
const react = require('eslint-plugin-react');
const configPrettier = require('eslint-config-prettier');
const prettier = require('eslint-plugin-prettier');

module.exports = [
    { files: ['**/*.{js,mjs,cjs,ts}'] },
    { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
    pluginJs.configs.recommended,
    react.configs.flat.recommended,
    configPrettier,
    //react.configs.recommended,
    //pluginReactHooks.configs.recommended,

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
