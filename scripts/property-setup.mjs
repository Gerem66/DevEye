/**
 * Le réglage de fast-check, préchargé par `npm test` : la même graine à chaque
 * passe, pour qu'un échec se rejoue. `FUZZ_SEED=random` en tire une et
 * l'affiche, `FUZZ_RUNS` change le nombre de tirages par propriété.
 */
const DEFAULT_SEED = 20261124;
const DEFAULT_RUNS = 100;

// Tirée une fois, par le premier processus : ses enfants héritent du nombre.
if (process.env.FUZZ_SEED === 'random') {
    process.env.FUZZ_SEED = String(Math.floor(Math.random() * 0x7fffffff));
    console.log(`# fast-check : graine ${process.env.FUZZ_SEED}`);
}

// Les autres fichiers de test n'ont pas à charger fast-check.
if (process.argv.some((arg) => /\.property\.test\.[cm]?tsx?$/.test(arg))) {
    const { default: fc } = await import('fast-check');
    const seed = Number(process.env.FUZZ_SEED ?? DEFAULT_SEED);
    const numRuns = Number(process.env.FUZZ_RUNS ?? DEFAULT_RUNS);
    if (!Number.isInteger(seed) || !Number.isInteger(numRuns) || numRuns < 1) {
        throw new Error('FUZZ_SEED (un entier, ou « random ») et FUZZ_RUNS (un entier positif) sont mal écrits.');
    }
    fc.configureGlobal({ seed, numRuns });
}
