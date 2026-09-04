import { useCallback, useEffect, useState } from 'react';
import { humanizeError, invalidate } from 'deveye-sdk-client';
import type { SdkSettingsScope } from '@deveye/types/sdk/client';
import {
    AUDIENCE_QUOTA_MAX,
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    type AudiencePlatform,
    type AudienceSite,
    type AudienceVisitorMode
} from '../contracts/domain';

import { api } from './api';

/**
 * Ce que les trois onglets d'un site partagent : le charger, en tenir un
 * brouillon, l'enregistrer.
 *
 * `audience.siteUpdate` prend le site **entier**, un seul contrat pour un seul
 * objet. Chaque onglet n'en montre donc qu'une part mais les enregistre tous,
 * et c'est pour cela que ce brouillon vit ici plutôt que trois fois : découpé
 * par onglet, le premier enregistrement écraserait ce que les deux autres
 * n'auraient pas relu.
 */

/** Le site tel qu'on le saisit, découpé du site chargé. */
export interface Draft {
    name: string;
    description: string;
    platform: AudiencePlatform;
    /** Une origine par ligne, telle que saisie : le serveur normalise et dédoublonne. */
    origins: string;
    active: boolean;
    visitorMode: AudienceVisitorMode;
    /**
     * Gardés tels que saisis : un champ numérique qu'on vide pour retaper ne
     * doit pas sauter à une valeur par défaut sous les doigts. Les bornes du
     * contrat sont vérifiées à l'enregistrement.
     */
    retentionDays: string;
    formsAuto: boolean;
    submissionIpQuota: string;
    formHourlyQuota: string;
    eventIpQuota: string;
}

function draftOf(site: AudienceSite): Draft {
    return {
        name: site.name,
        description: site.description,
        platform: site.platform,
        origins: site.origins.join('\n'),
        active: site.active,
        visitorMode: site.visitorMode,
        retentionDays: String(site.retentionDays),
        formsAuto: site.formsAuto,
        submissionIpQuota: String(site.submissionIpQuota),
        formHourlyQuota: String(site.formHourlyQuota),
        eventIpQuota: String(site.eventIpQuota)
    };
}

/** Un nombre entier dans ses bornes, ou `null` : la saisie est du texte libre. */
function bounded(raw: string, min: number, max: number): number | null {
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export interface SitePanel {
    site: AudienceSite | null;
    draft: Draft | null;
    /** `true` tant que le site n'est pas lu, ou pendant une écriture. */
    busy: boolean;
    error: string | null;
    setError: (message: string | null) => void;
    set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
    /** Lève sur un refus : le bouton n'annonce « Enregistré » que sur un succès. */
    save: () => Promise<void>;
    reload: () => Promise<void>;
}

export function useSiteDraft(scope: SdkSettingsScope): SitePanel {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [site, setSite] = useState<AudienceSite | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        if (itemId === null) return;
        try {
            const res = await api.send('audience.get', { siteId: itemId });
            setSite(res.site);
            setDraft(draftOf(res.site));
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, [itemId]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
        setDraft((d) => (d ? { ...d, [key]: value } : d));
    }, []);

    const save = useCallback(async () => {
        if (busy || !site || !draft) return;
        const name = draft.name.trim();
        const retentionDays = bounded(draft.retentionDays, AUDIENCE_RETENTION_MIN_DAYS, AUDIENCE_RETENTION_MAX_DAYS);
        const submissionIpQuota = bounded(draft.submissionIpQuota, 0, AUDIENCE_QUOTA_MAX);
        const formHourlyQuota = bounded(draft.formHourlyQuota, 0, AUDIENCE_QUOTA_MAX);
        const eventIpQuota = bounded(draft.eventIpQuota, 0, AUDIENCE_QUOTA_MAX);

        const problem =
            name.length === 0
                ? 'Donnez un nom à ce site.'
                : retentionDays === null
                  ? `La conservation va de ${AUDIENCE_RETENTION_MIN_DAYS} à ${AUDIENCE_RETENTION_MAX_DAYS} jours.`
                  : submissionIpQuota === null || formHourlyQuota === null || eventIpQuota === null
                    ? `Un quota est un entier, de 0 à ${AUDIENCE_QUOTA_MAX}.`
                    : null;
        if (problem) {
            setError(problem);
            throw new Error(problem);
        }

        setBusy(true);
        setError(null);
        try {
            const res = await api.send('audience.siteUpdate', {
                siteId: site.id,
                name,
                description: draft.description.trim(),
                platform: draft.platform,
                origins: draft.origins
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                active: draft.active,
                visitorMode: draft.visitorMode,
                retentionDays: retentionDays as number,
                formsAuto: draft.formsAuto,
                submissionIpQuota: submissionIpQuota as number,
                formHourlyQuota: formHourlyQuota as number,
                eventIpQuota: eventIpQuota as number
            });
            setSite(res.site);
            setDraft(draftOf(res.site));
            invalidate('audience.detail', 'audience.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    }, [busy, site, draft]);

    return { site, draft, busy, error, setError, set, save, reload };
}
