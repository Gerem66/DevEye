#!/usr/bin/env node
/**
 * Détecte les classes définies **deux fois** dans un même module CSS.
 *
 * Pourquoi ce contrôle existe : le module CSS de Projets (aujourd'hui
 * `features/projects/src/client/style.module.css`, du temps du natif
 * `Features/Projects/style.module.css`)
 * a grandi jusqu'à couvrir huit écrans, et deux classes y portaient le même nom
 * — `.grid` pour la grille du portefeuille et pour la couche de fond de la
 * frise. La seconde, en `position: absolute; pointer-events: none`, écrasait la
 * première : les cartes se superposaient dans un coin et ne répondaient plus au
 * clic. Ni TypeScript, ni ESLint, ni le build ne disent quoi que ce soit — la
 * dernière règle gagne, en silence.
 *
 * Le motif « groupe puis surcharge » reste licite :
 *
 *     .gridLine, .gridLineMajor { … }
 *     .gridLineMajor { … }
 *
 * Seules les redéfinitions d'une classe **seule dans son sélecteur** sont
 * signalées : c'est là qu'on écrase sans le vouloir.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * L'app, puis les modules du dépôt (`features/<id>/src/client`) : les natives
 * rapatriées ont emporté leurs feuilles de style avec elles, Projets en tête,
 * et le contrôle les suit. Un module vit sous `features/`, un dépôt de module
 * externe passe par sa propre CI.
 */
const ROOTS = [new URL('../src', import.meta.url).pathname, new URL('../../features', import.meta.url).pathname].filter(
    (dir) => existsSync(dir)
);

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry.endsWith('.module.css')) out.push(full);
    }
    return out;
}

/** Les préludes de règles au premier niveau, commentaires retirés. */
function preludes(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '{') {
            if (depth === 0) found.push({ text: clean.slice(start, i), index: i });
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) start = i + 1;
        }
    }
    return found;
}

let failures = 0;
for (const file of ROOTS.flatMap(walk)) {
    const css = readFileSync(file, 'utf8');
    const seen = new Map();
    for (const { text, index } of preludes(css)) {
        const selectors = text
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        // Une seule classe, sans combinateur ni pseudo : c'est une définition
        // « pleine », celle qui écrase.
        if (selectors.length !== 1) continue;
        const m = /^\.([A-Za-z0-9_-]+)$/.exec(selectors[0]);
        if (!m) continue;
        const line = css.slice(0, index).split('\n').length;
        const previous = seen.get(m[1]);
        if (previous !== undefined) {
            const rel = file.slice(file.lastIndexOf('/src/') + 1);
            console.error(`${rel}: « .${m[1]} » est défini deux fois (lignes ${previous} et ${line}).`);
            console.error('   La seconde écrase la première, en silence. Renommez-en une.');
            failures++;
        } else {
            seen.set(m[1], line);
        }
    }
}

if (failures > 0) {
    console.error(`\n${failures} collision(s) de classe CSS.`);
    process.exit(1);
}
console.log('Modules CSS : aucune classe redéfinie.');
