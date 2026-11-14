import crypto from 'node:crypto';

import type { SdkCipher } from '@deveye/types/sdk/server';

import type { AssetFormat } from '../../contracts/exposure';
import type { CveProduct } from '../inventory/tools';

/** La clé des réglages de la veille dans le magasin de l'espace. */
export const EXPOSURE_PREFS_KEY = 'exposurePrefs';

/** Ce que `summary_enc` scelle d'un élément : de quoi le lister sans ouvrir son inventaire. */
export interface AssetSummary {
    label: string;
    formats: AssetFormat[];
    notes: string[];
    componentCount: number;
}

export async function sealJson(cipher: SdkCipher, value: unknown): Promise<string> {
    return cipher.encrypt(JSON.stringify(value));
}

/** Un blob illisible vaut `fallback` : un élément mal scellé se relit au passage suivant, il ne casse pas la liste. */
export async function openJson<T>(cipher: SdkCipher, blob: string | null, fallback: T): Promise<T> {
    if (blob === null) return fallback;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return fallback;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return fallback;
    }
}

/** L'empreinte d'un produit du NVD dans `ft_cve_asset_keys` : rien de lisible. */
export function productKey(p: CveProduct): string {
    return crypto.createHash('sha256').update(`product|${p.vendor}:${p.product}`).digest('hex');
}

/** Ce que les commandes attendent du service, posé par lui au démarrage. */
interface ExposureLink {
    /** Un passage maintenant, sans attendre le cadran. */
    wake(): void;
    /** Cet espace se réévalue au prochain passage. */
    markDirty(workspaceId: number): void;
    /** Ce que la dernière évaluation n'a pas pu vérifier, en phrases. */
    noticesOf(workspaceId: number): string[];
}

let link: ExposureLink | null = null;

export function setExposureLink(next: ExposureLink | null): void {
    link = next;
}

export function wakeExposure(): void {
    link?.wake();
}

export function markExposureDirty(workspaceId: number): void {
    link?.markDirty(workspaceId);
    link?.wake();
}

export function exposureNotices(workspaceId: number): string[] {
    return link?.noticesOf(workspaceId) ?? [];
}
