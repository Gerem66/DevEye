#!/usr/bin/env node
/**
 * Le cliquet des tests de composants. Tout composant (`.tsx`) du client et des
 * modules du dépôt a son test à côté de lui (`X.test.tsx`), ou figure dans la
 * liste `untested` de `ui-tests.json`. Cette liste est une dette : `ceiling`
 * en plafonne la taille et ne fait que baisser, donc un composant nouveau
 * arrive avec son test. Un dossier de `strict` n'y a aucune entrée.
 *
 * `--prune` retire de la liste ce qui a reçu son test ou n'existe plus, et
 * abaisse le plafond d'autant.
 *
 * Le contrôle refuse aussi, dans un test, la comparaison d'un élément du DOM
 * par `assert.equal` et ses semblables : à l'échec, Node inspecte l'élément
 * et, par les fibres que React y accroche, l'application entière, jusqu'à
 * saturer la mémoire au lieu de dire ce qui diffère.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP = new URL('../..', import.meta.url).pathname;
const LIST = new URL('../ui-tests.json', import.meta.url).pathname;

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.tsx')) out.push(relative(APP, full));
    }
    return out;
}

const features = join(APP, 'features');
const roots = [
    join(APP, 'client', 'src'),
    ...readdirSync(features)
        .map((id) => join(features, id, 'src', 'client'))
        .filter((dir) => existsSync(dir))
];
const files = roots.flatMap((root) => walk(root)).sort();
const tests = files.filter((file) => file.endsWith('.test.tsx'));
const tested = new Set(tests.map((file) => file.replace(/\.test\.tsx$/, '.tsx')));
const components = files.filter((file) => !file.endsWith('.test.tsx'));

const list = JSON.parse(readFileSync(LIST, 'utf8'));
const listed = new Set(list.untested);

if (process.argv.includes('--prune')) {
    const kept = list.untested.filter((file) => components.includes(file) && !tested.has(file));
    const removed = list.untested.length - kept.length;
    const pruned = { ...list, ceiling: Math.min(list.ceiling, kept.length), untested: kept };
    // Écrit comme `format:check` l'attend, sans quoi l'élagage casserait la CI.
    const { format, resolveConfig } = await import('prettier');
    writeFileSync(LIST, await format(JSON.stringify(pruned), { ...(await resolveConfig(LIST)), parser: 'json' }));
    console.log(`${removed} entrée(s) retirée(s), plafond à ${pruned.ceiling}.`);
    process.exit(0);
}

const problems = [];

for (const file of components) {
    const strict = list.strict.find((dir) => file.startsWith(`${dir}/`));
    if (tested.has(file)) {
        if (listed.has(file)) problems.push(`${file} a son test : retirez-le de ui-tests.json (--prune).`);
    } else if (strict) {
        problems.push(`${file} n'a pas de test, dans un dossier où chaque composant a le sien (${strict}).`);
    } else if (!listed.has(file)) {
        problems.push(`${file} n'a pas de test : écrivez ${file.replace(/\.tsx$/, '.test.tsx')}.`);
    }
}
for (const file of tested) {
    if (!components.includes(file)) problems.push(`${file.replace(/\.tsx$/, '.test.tsx')} teste un fichier absent.`);
}
for (const file of list.untested) {
    if (!components.includes(file)) problems.push(`${file} n'existe plus : retirez-le de ui-tests.json (--prune).`);
    if (list.strict.some((dir) => file.startsWith(`${dir}/`))) {
        problems.push(`${file} est dans un dossier strict : il n'a pas sa place dans la liste.`);
    }
}
for (const dir of list.strict) {
    if (!existsSync(join(APP, dir))) problems.push(`Dossier strict absent : ${dir}.`);
}
if (list.untested.length > list.ceiling) {
    problems.push(
        `${list.untested.length} composants sans test, pour un plafond de ${list.ceiling} : la liste ne reçoit personne.`
    );
}
if (JSON.stringify(list.untested) !== JSON.stringify([...list.untested].sort())) {
    problems.push('La liste `untested` de ui-tests.json n’est pas triée.');
}

/** Le premier argument d'un appel, de sa parenthèse ouvrante à la première virgule de son niveau. */
function firstArgument(source, from) {
    let depth = 0;
    let quote = null;
    for (let i = from; i < source.length; i += 1) {
        const c = source[i];
        if (quote) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) return source.slice(from, i);
            depth -= 1;
        } else if (c === ',' && depth === 0) return source.slice(from, i);
    }
    return source.slice(from);
}

const EQUALITY = /assert\.(?:not)?(?:[dD]eep)?(?:[sS]trict)?[eE]qual\(/g;
const ELEMENT =
    /^(?:await\s+)?(?:(?:screen|within\(.*?\))\.(?:get|query|find)(?:All)?By\w+(?:<.*?>)?\(.*\)|document\.(?:querySelector(?:All)?\(.*\)|body|activeElement|documentElement))$/s;

for (const file of tests) {
    const source = readFileSync(join(APP, file), 'utf8');
    for (const match of source.matchAll(EQUALITY)) {
        const argument = firstArgument(source, match.index + match[0].length).trim();
        if (!ELEMENT.test(argument)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        problems.push(
            `${file}:${line} compare un élément du DOM par ${match[0].slice(0, -1)} : comparez un texte ou un booléen, ou passez par assert.ok().`
        );
    }
}

if (problems.length > 0) {
    console.error(`Tests de composants : ${problems.length} problème(s).\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
}
console.log(
    `Tests de composants : ${tested.size} composant(s) testé(s), ${list.untested.length} sans test (plafond ${list.ceiling}).`
);
