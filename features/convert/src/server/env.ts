import os from 'node:os';

const GIB = 1024 ** 3;

const positive = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Les réglages d'exploitation du module, lus une fois. Tout ce qui est ici
 * engage le disque, le processeur ou le temps du serveur : cela se règle par
 * l'environnement, jamais depuis un espace.
 */
export const env = {
    /** Le dossier de travail, vu par le serveur. Même paire hôte/conteneur que les autres stockages. */
    CONVERT_STORAGE_DIR: process.env.CONVERT_STORAGE_DIR || '/data/convert',
    /** Le mur du serveur : aucun fichier plus gros, quelle que soit l'offre du compte. */
    CONVERT_MAX_FILE_BYTES: positive('CONVERT_MAX_FILE_BYTES', 5 * GIB),
    /** Combien de temps un résultat attend d'être récupéré avant d'être retiré du disque. */
    CONVERT_RESULT_TTL_SECONDS: positive('CONVERT_RESULT_TTL_SECONDS', 3600),
    /** Un travail ouvert dont le fichier n'est jamais arrivé cesse de compter après ce délai. */
    CONVERT_UPLOAD_TTL_SECONDS: positive('CONVERT_UPLOAD_TTL_SECONDS', 6 * 3600),
    /** Ce que les travaux d'un même espace peuvent occuper ensemble sur le disque. */
    CONVERT_WORKSPACE_QUOTA_BYTES: positive('CONVERT_WORKSPACE_QUOTA_BYTES', 20 * GIB),
    /** Ce qui doit rester libre sur le disque une fois un fichier accepté. */
    CONVERT_DISK_FLOOR_BYTES: positive('CONVERT_DISK_FLOOR_BYTES', 2 * GIB),
    /** Le budget de temps d'une conversion, deux passes comprises. */
    CONVERT_JOB_TIMEOUT_SECONDS: positive('CONVERT_JOB_TIMEOUT_SECONDS', 2 * 3600),
    /** Sans le moindre avancement depuis ce délai, l'outil est tenu pour bloqué et tué. */
    CONVERT_STALL_SECONDS: positive('CONVERT_STALL_SECONDS', 180),
    /**
     * Un résultat ne dépasse ni ce plafond, ni tant de fois le fichier d'entrée :
     * une vidéo compressée convertie vers un format brut grossit d'un facteur
     * cent, et le plafond d'entrée n'en protège pas.
     */
    CONVERT_MAX_OUTPUT_BYTES: positive('CONVERT_MAX_OUTPUT_BYTES', 10 * GIB),
    CONVERT_OUTPUT_RATIO_MAX: positive('CONVERT_OUTPUT_RATIO_MAX', 30),
    /** Un travail repris après un arrêt brutal du serveur ne l'est qu'autant de fois. */
    CONVERT_MAX_ATTEMPTS: positive('CONVERT_MAX_ATTEMPTS', 2),
    /** Un cœur est laissé au serveur : il répond aux membres pendant qu'une vidéo se convertit. */
    CONVERT_THREADS: positive('CONVERT_THREADS', Math.max(1, os.cpus().length - 1)),
    CONVERT_TICK_SECONDS: positive('CONVERT_TICK_SECONDS', 15),
    CONVERT_UPKEEP_SECONDS: positive('CONVERT_UPKEEP_SECONDS', 300),
    /** La cadence de relecture des taux de change. La source publie une fois par jour ouvré. */
    CONVERT_FX_REFRESH_SECONDS: positive('CONVERT_FX_REFRESH_SECONDS', 6 * 3600)
};
