import type { SdkCipher } from '@deveye/types/sdk/server';

import { convertErrorCodeSchema, type ConvertJob } from '../contracts/domain';
import { optionValuesSchema } from '../contracts/options';
import type { JobRow } from './repo';

export const now = (): number => Math.floor(Date.now() / 1000);

/** La clé des réglages de l'espace dans le magasin du module. */
export const SETTINGS_KEY = 'settings';

/** Une taille telle qu'on la dit dans une phrase d'erreur. */
export function formatBytes(bytes: number): string {
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const shown = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${String(shown).replace('.', ',')} ${units[unit]}`;
}

/** Réveille la file depuis un handler ou une route, sans attendre le prochain tour de cadran. */
let waker: (() => void) | null = null;
export function setQueueWaker(next: (() => void) | null): void {
    waker = next;
}
export function wakeQueue(): void {
    waker?.();
}

/** Interrompt la conversion en cours d'un travail, si c'est bien lui qui tourne. */
let aborter: ((jobId: number) => void) | null = null;
export function setJobAborter(next: ((jobId: number) => void) | null): void {
    aborter = next;
}
export function abortJob(jobId: number): void {
    aborter?.(jobId);
}

/** La ligne telle que l'écran la lit. Un nom ou un message illisible se rend `null`, jamais en erreur. */
export async function toJob(row: JobRow, cipher: SdkCipher): Promise<ConvertJob> {
    const [originalName, errorMessage] = await Promise.all([
        cipher.tryDecrypt(row.original_name_enc),
        row.error_enc ? cipher.tryDecrypt(row.error_enc) : Promise.resolve(null)
    ]);
    const options = optionValuesSchema.safeParse(
        typeof row.options === 'string' ? JSON.parse(row.options) : row.options
    );
    const errorCode = convertErrorCodeSchema.safeParse(row.error_code);
    return {
        id: row.id,
        kind: row.kind,
        sourceFormat: row.source_format,
        targetFormat: row.target_format,
        originalName,
        options: options.success ? options.data : {},
        inputBytes: Number(row.input_bytes),
        outputBytes: row.output_bytes === null ? null : Number(row.output_bytes),
        phase: row.phase,
        progress: row.progress_permille,
        errorCode: errorCode.success ? errorCode.data : null,
        errorMessage,
        userId: row.user_id,
        createdAt: Number(row.created),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
        expiresAt: row.expires_at === null ? null : Number(row.expires_at)
    };
}
