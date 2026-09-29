#!/usr/bin/env node
/**
 * La première entrée des notes de version (`src/Pages/Home/about/changelog.ts`)
 * doit porter la version de `package.json`, celle qu'affiche la barre du haut :
 * une version qui sort sans ses notes échoue ici plutôt que dans l'« À propos ».
 */
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/Pages/Home/about/changelog.ts', import.meta.url), 'utf8');
const first = /CHANGELOG[^=]*=\s*\[\s*\{\s*version:\s*'([^']+)'/.exec(source)?.[1];

if (first !== version) {
    console.error(
        `Notes de version : la première entrée est ${first ?? 'introuvable'}, package.json dit ${version}.\n` +
            'Ajoutez l’entrée de cette version en tête de src/Pages/Home/about/changelog.ts.'
    );
    process.exit(1);
}
