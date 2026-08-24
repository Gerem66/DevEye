/**
 * Le contrôle anti-drift de la surface SDK client (`npm run check:sdk`).
 *
 * `@deveye/types` publie le portrait typé du barrel (`src/sdk/client-ambient.d.ts`,
 * la déclaration ambiante que les repos de modules consomment pour leur
 * typecheck autonome). Ici, on vérifie MÉCANIQUEMENT que le vrai barrel
 * honore ce portrait : le fichier est compilé par `tsconfig.sdkcheck.json`,
 * qui retire l'alias `deveye-sdk-client` — l'import par nom résout donc la
 * déclaration ambiante, et l'affectation ci-dessous exige que chaque export
 * déclaré existe dans le barrel avec un type compatible.
 *
 * Un export du barrel PAS ENCORE déclaré passe (la surface stable est ce qui
 * est déclaré, pas tout ce qui existe) ; un export déclaré qui manque ou qui
 * a changé de forme CASSE la CI de l'app — plus jamais le build d'un tiers.
 */

// Une référence et non un import : un import n'enregistre pas une déclaration
// ambiante hors du graphe de modules ; la référence est le mécanisme prévu.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../node_modules/@deveye/types/src/sdk/client-ambient.d.ts" />

import * as real from '../src/sdk';

type Declared = typeof import('deveye-sdk-client');

const check: Declared = real;
void check;
