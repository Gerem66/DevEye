import { useState } from 'react';
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
import { AUDIENCE_ORIGIN_ANY, AUDIENCE_SITE_NAME_MAX_LENGTH, audiencePlatformSchema } from '../contracts/domain';

import { api } from './api';
import { PLATFORM_HINTS, PLATFORM_LABELS } from './format';
import styles from './style.module.css';
import { useSiteDraft } from './useSiteDraft';

/** Les choix fixes, dans l'ordre du contrat : tous visibles, jamais derrière un déroulant. */
const PLATFORM_OPTIONS = audiencePlatformSchema.options.map((value) => ({ value, label: PLATFORM_LABELS[value] }));

/**
 * Le site lui-même : ce qui ne relève ni de la mesure ni des retours mais des
 * deux à la fois. Son identité, la porte que les origines tiennent, l'état de
 * la collecte, et sa suppression.
 *
 * La reconnaissance des visiteurs et la conservation ont quitté cet onglet pour
 * « Fréquentation », les réglages des retours pour « Retours » : un panneau qui
 * portait tout obligeait à savoir d'avance dans quelle moitié chercher.
 *
 * Un site projeté d'un autre espace se lit ici mais se règle chez lui : la
 * ligne se réécrit sous la clé de son espace, et le serveur refuserait.
 */
export default function SiteGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const { site, draft, busy, error, setError, set, save } = useSiteDraft(scope);
    const [removing, setRemoving] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const remove = async () => {
        if (!site) return;
        setRemoving(true);
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
            setRemoving(false);
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

    const editable = canWrite && !busy && !removing;
    const origins = draft.origins
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
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
                {/* Trois états, et le vide est le plus sévère : c'est la garde qui
                    empêche un autre site d'écrire avec votre clé depuis le
                    navigateur d'un visiteur. */}
                <span className={origins.length === 0 ? shell.warning : shell.fieldHint}>
                    {origins.length === 0
                        ? 'Vide : rien n’est accepté, ni mesure ni retour. Déclarez un hôte, ou « * » pour tout accepter.'
                        : origins.includes(AUDIENCE_ORIGIN_ANY)
                          ? '« * » : toute origine est acceptée. Pratique le temps de brancher, large à demeure.'
                          : 'Un hôte par ligne ; le port et le protocole sont ignorés.'}
                </span>
            </label>

            <Switch
                checked={draft.active}
                disabled={!editable}
                onChange={(v) => set('active', v)}
                label='Collecte active'
                hint='Éteinte, plus rien n’entre, retours compris. L’historique déjà là ne bouge pas.'
            />

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || removing} />
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
                        Tout son historique, mesures et retours compris, est effacé, et {projects}. Cette action est
                        définitive.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy || removing}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${site.name} » ?`,
                                    description: `Tout son historique, mesures et retours compris, est effacé, et ${projects}. Cette action est définitive.`,
                                    confirmLabel: 'Supprimer le site',
                                    tone: 'danger',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le site
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={removing} />
        </div>
    );
}
