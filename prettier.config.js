/** @type {import('prettier').Config} */
export default {
    singleQuote: true,
    tabWidth: 4,
    jsxSingleQuote: true,
    trailingComma: 'none',
    printWidth: 120,
    bracketSpacing: true,
    overrides: [
        {
            files: ['*.json', '*.jsonc', '*.yml'],
            options: { tabWidth: 2 }
        }
    ]
};
