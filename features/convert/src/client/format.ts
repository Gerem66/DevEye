import type { ConvertKind } from '../contracts/catalogue';
import type { ConvertErrorCode, ConvertPhase } from '../contracts/domain';

export const PHASE_LABELS: Record<ConvertPhase, string> = {
    awaiting_upload: 'En attente du fichier',
    uploading: 'Envoi en cours',
    queued: 'En file d’attente',
    running: 'Conversion en cours',
    done: 'Prêt',
    error: 'Échec',
    canceled: 'Annulé',
    expired: 'Résultat retiré'
};

/** Ce qu'on dit quand le serveur n'a pas laissé de phrase à montrer. */
export const ERROR_LABELS: Record<ConvertErrorCode, string> = {
    unsupported: 'Ce fichier ne peut pas être converti ainsi.',
    format_mismatch: 'Ce fichier n’est pas du format annoncé.',
    engine_missing: 'L’outil de conversion est absent du serveur.',
    timeout: 'La conversion a pris trop de temps.',
    stalled: 'La conversion n’avançait plus : le fichier est peut-être abîmé.',
    too_large: 'Fichier trop lourd.',
    output_too_large: 'Le fichier produit serait trop lourd : choisir des réglages plus légers.',
    target_too_small: 'La taille visée est trop petite pour cette vidéo.',
    disk_full: 'Le serveur manque de place. Réessayer plus tard.',
    corrupt: 'Ce fichier ne se lit pas : il est peut-être abîmé.',
    upload_interrupted: 'L’envoi du fichier a été interrompu.',
    interrupted: 'Le serveur a redémarré pendant la conversion.',
    file_lost: 'Le fichier n’est plus sur le serveur. Relancer la conversion.',
    engine_failed: 'La conversion a échoué.'
};

export const KIND_NOUNS: Record<ConvertKind, string> = {
    video: 'une vidéo',
    audio: 'un fichier audio',
    image: 'une image',
    document: 'un document'
};

/** « 3 min 20 s », « 45 s », « 1 h 05 ». */
export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total} s`;
    if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
    return `${Math.floor(total / 3600)} h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
}

/** Dans combien de temps, dit simplement : « dans 40 min », « dans moins d’une minute ». */
export function formatRemaining(untilEpochSeconds: number): string {
    const seconds = untilEpochSeconds - Date.now() / 1000;
    if (seconds <= 60) return 'dans moins d’une minute';
    if (seconds < 3600) return `dans ${Math.round(seconds / 60)} min`;
    return `dans ${Math.round(seconds / 3600)} h`;
}

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 });
const AMOUNT = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatNumber = (value: number): string => NUMBER.format(value);
export const formatAmount = (value: number): string => AMOUNT.format(value);

/** Une saisie française (« 1 234,5 ») lue comme un nombre. `null` : rien d'exploitable. */
export function parseNumber(raw: string): number | null {
    // `\s` couvre aussi les espaces insécables qu'une saisie française glisse entre les milliers.
    const cleaned = raw.replace(/\s/g, '').replace(',', '.');
    if (cleaned === '' || cleaned === '-') return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
}
