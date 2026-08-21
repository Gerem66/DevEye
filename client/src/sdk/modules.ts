import { INSTALLED_CLIENT_FEATURES } from '@/generated/features';

import { registerClientModules } from './registry';

/**
 * L'initialiseur : le SEUL module à importer la glue générée. Importé en tête
 * de `src/index.tsx`, avant App, pour que le registre soit rempli quand le
 * catalogue s'évalue. Tout le reste de l'app parle à `sdk/registry`, jamais au
 * généré : c'est ce qui garde le graphe d'imports acyclique (voir le
 * commentaire du registre).
 */
registerClientModules(INSTALLED_CLIENT_FEATURES);
