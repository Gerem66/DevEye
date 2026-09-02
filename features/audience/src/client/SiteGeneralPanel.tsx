import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    audiencePlatformSchema,
    audienceVisitorModeSchema,
    type AudiencePlatform,
    type AudienceSite,
    type AudienceVisitorMode
} from '../contracts/domain';

import { api } from './api';
import { PLATFORM_HINTS, PLATFORM_LABELS, VISITOR_HINTS, VISITOR_LABELS } from './format';
import styles from './style.module.css';

/** Les choix fixes, dans l'ordre du contrat : tous visibles, jamais derrière un déroulant. */
const PLATFORM_OPTIONS = audiencePlatformSchema.options.map((value) => ({ value, label: PLATFORM_LABELS[value] }));
const VISITOR_OPTIONS = audienceVisitorModeSchema.options.map((value) => ({ value, label: VISITOR_LABELS[value] }));

/** Le site tel qu'on le saisit, découpé du site chargé. */
interface Draft {
    name: string;
    description: string;
    platform: AudiencePlatform;
    /** Une origine par ligne, telle que saisie : le serveur normalise et dédoublonne. */
    origins: string;
    active: boolean;
    visitorMode: AudienceVisitorMode;
    /**
     * Gardée telle que saisie : un champ numérique qu'on vide pour retaper ne
     * doit pas sauter à une valeur par défaut sous les doigts. Les bornes du
     * contrat sont vérifiées à l'enregistrement.
     */
    retentionDays: string;
}

function draftOf(site: AudienceSite): Draft {
    return {
        name: site.name,
        description: site.description,
        platform: site.platform,
        origins: site.origins.join('\n'),
        active: site.active,
        visitorMode: site.visitorMode,
        retentionDays: String(site.retentionDays)
    };
}

/**
 * Le site lui-même : son identité (nom, description, plateforme, origines
 * autorisées), sa mesure, la reconnaissance de ses visiteurs, la conservation
 * des événements bruts, et sa suppression. L'onglet Général de ses réglages,
 * là où le bouton commun mène.
 *
 * L'identité et la suppression vivaient dans un dialogue « Modifier », à côté
 * du bouton de réglages : deux portes pour régler une même chose. Le dialogue
 * ne sert plus qu'à DÉCLARER un site, geste qui n'a pas d'élément à viser.
 *
 * Autonome comme tous les panneaux de la coquille : il charge le site et se
 * sauvegarde par `audience.siteUpdate`, dont le contrat prend le site entier.
 * Sans le droit d'écriture, les champs restent lisibles mais figés : un
 * formulaire que le serveur refuserait est un écran qui ment.
 *
 * Un site projeté d'un autre espace se lit ici mais se règle chez lui : la
 * ligne se réécrit sous la clé de son espace, et le serveur refuserait.
 */
export default function SiteGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [site, setSite] = useState<AudienceSite | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
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
        void load();
    }, [load]);

    const save = async () => {
        if (busy || !site || !draft) return;
        const name = draft.name.trim();
        const retentionDays = Number(draft.retentionDays);
        const problem =
            name.length === 0
                ? 'Donnez un nom à ce site.'
                : !Number.isInteger(retentionDays) ||
                    retentionDays < AUDIENCE_RETENTION_MIN_DAYS ||
                    retentionDays > AUDIENCE_RETENTION_MAX_DAYS
                  ? `La conservation va de ${AUDIENCE_RETENTION_MIN_DAYS} à ${AUDIENCE_RETENTION_MAX_DAYS} jours.`
                  : null;
        if (problem) {
            setError(problem);
            // Rejeté : le bouton n'annonce « Enregistré » que sur un succès.
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
                retentionDays
            });
            setSite(res.site);
            setDraft(draftOf(res.site));
            invalidate('audience.detail', 'audience.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!site) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('audience.siteRemove', { siteId: site.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait un site qui n'existe plus.
            gone();
            invalidate('audience.count', 'audience.list');
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
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
                Ce site vient d’un autre espace : son identité, sa mesure et sa suppression se règlent depuis là-bas.
            </p>
        );
    }

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
    const editable = canWrite && !busy;
    const projects =
        site.projectCount > 0
            ? `les ${site.projectCount} projet${site.projectCount > 1 ? 's' : ''} qui le suivent perdent seulement leur lien`
            : 'les projets qui le suivraient perdraient seulement leur lien';

    return (
        <div className={shell.section}>
            <label className={shell.field}>
                <span className={shell.sectionLabel}>Nom</span>
                <TextInput
                    value={draft.name}
                    maxLength={AUDIENCE_SITE_NAME_MAX_LENGTH}
                    disabled={!editable}
                    placeholder='Vitrine, Application, Blog…'
                    onChange={(e) => set('name', e.target.value)}
                />
            </label>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Description</span>
                <TextInput
                    value={draft.description}
                    disabled={!editable}
                    placeholder='Facultatif'
                    onChange={(e) => set('description', e.target.value)}
                />
            </label>

            {/* La plateforme décide si les origines autorisées sont appliquées :
                la seule décision qui change ce que le serveur accepte. */}
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Plateforme</span>
                <SegmentedControl
                    value={draft.platform}
                    options={PLATFORM_OPTIONS}
                    disabled={!editable}
                    onChange={(v) => set('platform', v)}
                    aria-label='Plateforme'
                />
                <span className={shell.fieldHint}>{PLATFORM_HINTS[draft.platform]}</span>
            </div>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Origines autorisées</span>
                <textarea
                    className={styles.textarea}
                    value={draft.origins}
                    rows={3}
                    disabled={!editable}
                    onChange={(e) => set('origins', e.target.value)}
                    placeholder={'exemple.fr\nwww.exemple.fr'}
                />
                <span className={shell.fieldHint}>
                    Un hôte par ligne ; le port et le protocole sont ignorés.
                    {draft.origins.trim().length === 0 && ' Vide, toute origine est acceptée.'}
                </span>
            </label>

            <Switch
                checked={draft.active}
                disabled={!editable}
                onChange={(v) => set('active', v)}
                label='Mesure active'
                hint='Éteinte, plus rien n’entre. L’historique déjà là ne bouge pas.'
            />

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Reconnaissance des visiteurs</span>
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
                <span className={shell.sectionLabel}>Conservation des événements (jours)</span>
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
                    <SaveButton onSave={save} disabled={busy} />
                </div>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un site : cela relève de l’écriture sur Audience.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer ce site</span>
                    <span className={shell.fieldHint}>
                        Tout son historique de mesures est effacé, et {projects}. Cette action est définitive.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${site.name} » ?`,
                                    description: `Tout son historique de mesures est effacé, et ${projects}. Cette action est définitive.`,
                                    confirmLabel: 'Supprimer le site',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le site
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
