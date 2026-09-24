import os from 'node:os';
import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

const GIB = 1024 ** 3;

/**
 * Les réglages d'exploitation du module, lus une fois. Tout ce qui est ici
 * engage le disque, le processeur ou le temps du serveur : cela se règle par
 * l'environnement, jamais depuis un espace.
 */
export const CONVERT_ENV = defineModuleEnv({
    /** Le dossier de travail, vu par le serveur. Même paire hôte/conteneur que les autres stockages. */
    CONVERT_STORAGE_DIR: { kind: 'path', default: '/data/convert' },
    /** Le mur du serveur : aucun fichier plus gros, quelle que soit l'offre du compte. */
    CONVERT_MAX_FILE_BYTES: { kind: 'int', default: 5 * GIB },
    /** Combien de temps un résultat attend d'être récupéré avant d'être retiré du disque. */
    CONVERT_RESULT_TTL_SECONDS: { kind: 'int', default: 3600 },
    /**
     * Le temps laissé à un envoi pour COMMENCER : le ticket est lu à l'arrivée des
     * en-têtes, avant le premier octet, si bien que la durée de la montée n'entre
     * pas en compte. Passé ce délai, un travail dont le fichier n'est jamais venu
     * cesse de compter : sinon un onglet fermé au mauvais moment tiendrait
     * pendant des heures la seule place d'une offre gratuite.
     */
    CONVERT_UPLOAD_TTL_SECONDS: { kind: 'int', default: 600 },
    /** Ce que les travaux d'un même espace peuvent occuper ensemble sur le disque. */
    CONVERT_WORKSPACE_QUOTA_BYTES: { kind: 'int', default: 20 * GIB },
    /** Ce qui doit rester libre sur le disque une fois un fichier accepté. */
    CONVERT_DISK_FLOOR_BYTES: { kind: 'int', default: 2 * GIB },
    /** Le budget de temps d'une conversion, deux passes comprises. */
    CONVERT_JOB_TIMEOUT_SECONDS: { kind: 'int', default: 2 * 3600 },
    /** Sans le moindre avancement depuis ce délai, l'outil est tenu pour bloqué et tué. */
    CONVERT_STALL_SECONDS: { kind: 'int', default: 180 },
    /**
     * Un résultat ne dépasse ni ce plafond, ni tant de fois le fichier d'entrée :
     * une vidéo compressée convertie vers un format brut grossit d'un facteur
     * cent, et le plafond d'entrée n'en protège pas.
     */
    CONVERT_MAX_OUTPUT_BYTES: { kind: 'int', default: 10 * GIB },
    CONVERT_OUTPUT_RATIO_MAX: { kind: 'int', default: 30 },
    /** Un travail repris après un arrêt brutal du serveur ne l'est qu'autant de fois. */
    CONVERT_MAX_ATTEMPTS: { kind: 'int', default: 2 },
    /** Un cœur est laissé au serveur : il répond aux membres pendant qu'une vidéo se convertit. */
    CONVERT_THREADS: { kind: 'int', default: Math.max(1, os.cpus().length - 1) },
    CONVERT_TICK_SECONDS: { kind: 'int', default: 15 },
    CONVERT_UPKEEP_SECONDS: { kind: 'int', default: 300 },
    /** La cadence de relecture des taux de change. La source publie une fois par jour ouvré. */
    CONVERT_FX_REFRESH_SECONDS: { kind: 'int', default: 6 * 3600 }
});

export const env = readModuleEnv(CONVERT_ENV).values;
