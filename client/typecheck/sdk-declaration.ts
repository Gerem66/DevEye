/**
 * Le contrôle anti-drift de la surface SDK client (`npm run check:sdk`).
 *
 * `@deveye/types` publie le portrait typé du barrel (`src/sdk/client-ambient.d.ts`,
 * la déclaration ambiante que les repos de modules consomment pour leur
 * typecheck autonome). Ici, on vérifie MÉCANIQUEMENT que le vrai barrel et ce
 * portrait coïncident : le fichier est compilé par `tsconfig.sdkcheck.json`,
 * qui retire l'alias `deveye-sdk-client`, donc l'import par nom résout la
 * déclaration ambiante.
 *
 * Trois contrôles, parce qu'une affectation ne voit pas tout :
 *  1. chaque export déclaré existe dans le barrel avec un type compatible ;
 *  2. rien « en douce » : chaque export du barrel est déclaré ;
 *  3. les exports de TYPE coïncident, et les types que le portrait importe de
 *     `@deveye/types` sont bien résolus (un import cassé les dégrade en `any`,
 *     ce qui passerait les deux premiers contrôles sans bruit).
 */

// Une référence et non un import : un import n'enregistre pas une déclaration
// ambiante hors du graphe de modules ; la référence est le mécanisme prévu.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../node_modules/@deveye/types/src/sdk/client-ambient.d.ts" />

import type * as declared from 'deveye-sdk-client';

import * as real from '../src/sdk';

type Declared = typeof import('deveye-sdk-client');

// 1. Chaque export déclaré existe, sous une forme compatible.
const check: Declared = real;
void check;

// 2. Chaque export du barrel est déclaré.
type Undeclared = Exclude<keyof typeof real, keyof Declared>;
const undeclared: Undeclared extends never ? true : Undeclared = true;
void undeclared;

// 3. Les exports de type coïncident, et rien n'a dégénéré en `any`.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type NotAny<T> = 0 extends 1 & T ? false : true;
const types: [
    Same<real.LiveSegmentKind, declared.LiveSegmentKind>,
    Same<real.InputChange, declared.InputChange>,
    Same<real.ExternalResourceKey, declared.ExternalResourceKey>,
    Same<real.SecrecyState, declared.SecrecyState>,
    Same<real.LiveOutlineProps, declared.LiveOutlineProps>,
    Same<real.ConfirmRequest, declared.ConfirmRequest>,
    NotAny<Parameters<Declared['featureApi']>[0]>,
    NotAny<ReturnType<Declared['useWorkspacePermissions']>['canFeature']>
] = [true, true, true, true, true, true, true, true];
void types;
