import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    humanizeError,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    TextInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    audienceVisitorModeSchema,
    type AudienceSite,
    type AudienceVisitorMode
} from '../contracts/domain';

import { api } from './api';
import { VISITOR_HINTS, VISITOR_LABELS } from './format';

/** Les deux modes, dans l'ordre du contrat : un choix fixe, tous deux visibles. */
const VISITOR_OPTIONS = audienceVisitorModeSchema.options.map((value) => ({ value, label: VISITOR_LABELS[value] }));

/** Les trois réglages du panneau, découpés du site chargé. */
interface Tuning {
    active: boolean;
    visitorMode: AudienceVisitorMode;
    /**
     * Gardée telle que saisie : un champ numérique qu'on vide pour retaper ne
     * doit pas sauter à une valeur par défaut sous les doigts. Les bornes du
     * contrat sont vérifiées à l'enregistrement.
     */
    retentionDays: string;
}

function tuningOf(site: AudienceSite): Tuning {
    return { active: site.active, visitorMode: site.visitorMode, retentionDays: String(site.retentionDays) };
}

/**
 * Les réglages d'un site : la mesure, la reconnaissance des visiteurs et la
 * conservation des événements bruts. Le panneau Général de la coquille de
 * réglages, à l'échelle d'un site, à côté de son partage et de ses permissions.
 *
 * Autonome comme tous les panneaux de la coquille : il charge le site et se
 * sauvegarde par `audience.siteUpdate`, dont le contrat prend le site entier,
 * d'où un brouillon recomposé à partir du site chargé, identité conservée telle
 * quelle. Sans le droit d'écriture, les champs restent lisibles mais figés : un
 * formulaire que le serveur refuserait est un écran qui ment.
 *
 * Un site projeté d'un autre espace se lit ici mais se règle chez lui : la
 * ligne se réécrit sous la clé de son espace, et le serveur refuserait.
 */
export default function SiteGeneralPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? scope.itemId : null;
    const [site, setSite] = useState<AudienceSite | null>(null);
    const [draft, setDraft] = useState<Tuning | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (itemId === null) return;
        try {
            const res = await api.send('audience.get', { siteId: itemId });
            setSite(res.site);
            setDraft(tuningOf(res.site));
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, [itemId]);

    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (busy || !site || !draft) return;
        const retentionDays = Number(draft.retentionDays);
        if (
            !Number.isInteger(retentionDays) ||
            retentionDays < AUDIENCE_RETENTION_MIN_DAYS ||
            retentionDays > AUDIENCE_RETENTION_MAX_DAYS
        ) {
            setError(`La conservation va de ${AUDIENCE_RETENTION_MIN_DAYS} à ${AUDIENCE_RETENTION_MAX_DAYS} jours.`);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('audience.siteUpdate', {
                siteId: site.id,
                // L'identité, renvoyée telle quelle : elle se change dans le
                // dialogue du site, pas ici.
                name: site.name,
                description: site.description,
                platform: site.platform,
                origins: site.origins,
                active: draft.active,
                visitorMode: draft.visitorMode,
                retentionDays
            });
            setSite(res.site);
            setDraft(tuningOf(res.site));
            invalidate('audience.detail', 'audience.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (!site || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    if (site.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce site vient d’un autre espace : sa mesure, la reconnaissance de ses visiteurs et sa conservation se
                règlent depuis là-bas.
            </p>
        );
    }

    const set = <K extends keyof Tuning>(key: K, value: Tuning[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
    const editable = canWrite && !busy;

    return (
        <div className={shell.section}>
            <Switch
                checked={draft.active}
                disabled={!editable}
                onChange={(v) => set('active', v)}
                label='Mesure active'
                hint='Éteinte, plus rien n’entre. L’historique déjà là ne bouge pas.'
            />

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Reconnaissance des visiteurs</span>
                <SegmentedControl
                    value={draft.visitorMode}
                    options={VISITOR_OPTIONS}
                    disabled={!editable}
                    onChange={(v) => set('visitorMode', v)}
                    aria-label='Reconnaissance des visiteurs'
                />
                {/* Le mode persistant crée une obligation pour le site suivi : il se
                    lit dans le ton d'un avertissement, pas dans celui d'une aide. */}
                <span className={draft.visitorMode === 'persistent' ? shell.warning : shell.fieldHint}>
                    {VISITOR_HINTS[draft.visitorMode]}
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Conservation des événements (jours)</span>
                <TextInput
                    type='number'
                    value={draft.retentionDays}
                    min={AUDIENCE_RETENTION_MIN_DAYS}
                    max={AUDIENCE_RETENTION_MAX_DAYS}
                    disabled={!editable}
                    onChange={(e) => set('retentionDays', e.target.value)}
                />
                <span className={shell.fieldHint}>
                    Le détail expire ; les totaux par jour sont gardés pour toujours. De {AUDIENCE_RETENTION_MIN_DAYS} à{' '}
                    {AUDIENCE_RETENTION_MAX_DAYS} jours.
                </span>
            </div>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Audience.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
