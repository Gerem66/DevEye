import { INSTALLED_CLIENT_FEATURES } from '@/generated/features';

import { registerClientModules } from './registry';

/**
 * L'initialiseur : le seul module à importer la glue générée. Importé en tête de
 * `src/index.tsx`, avant App, pour que le registre soit rempli quand le catalogue
 * s'évalue. Le reste de l'app parle à `sdk/registry`, ce qui garde le graphe
 * d'imports acyclique.
 */
registerClientModules(INSTALLED_CLIENT_FEATURES);
