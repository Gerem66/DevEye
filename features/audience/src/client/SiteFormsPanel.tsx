import { ReadOnlyNotice, SaveButton, settingsStyles as shell, Switch, TextInput } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { useSiteDraft } from './useSiteDraft';

/**
 * Ce qui ne règle que les retours : qui a le droit de créer un canal, et à quel
 * débit on les remplit.
 *
 * Les formulaires eux-mêmes se déclarent et se modifient **dans la vue**, sous
 * ceux qui existent déjà, comme un projet relie ses bases et ses dépôts : un
 * formulaire est du contenu qu'on ajoute, pas une case à cocher qu'on va
 * chercher derrière un bouton de réglages. Ne restent ici que les trois
 * décisions qui valent pour le site entier.
 */
export default function SiteFormsPanel({ scope, canWrite }: SettingsPanelProps) {
    const { site, draft, busy, error, set, save } = useSiteDraft(scope);

    if (!site || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }
    if (site.foreign) {
        return (
            <p className={shell.sectionHint}>Ce site vient d’un autre espace : ses retours se règlent depuis là-bas.</p>
        );
    }

    const editable = canWrite && !busy;

    return (
        <div className={shell.section}>
            <Switch
                checked={draft.formsAuto}
                disabled={!editable}
                onChange={(v) => set('formsAuto', v)}
                label='Créer les formulaires non déclarés'
                hint='Éteint, un nom inconnu est ignoré. Allumé, qui lit la clé publique dans la page peut faire apparaître des formulaires et des colonnes : à n’ouvrir que le temps d’une intégration.'
            />

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Retours par adresse et par heure</span>
                <TextInput
                    type='number'
                    value={draft.submissionIpQuota}
                    min={0}
                    disabled={!editable}
                    onChange={(e) => set('submissionIpQuota', e.target.value)}
                />
                <span className={shell.fieldHint}>
                    Sur un même formulaire. Personne n’envoie six messages de contact en une heure ; au-delà, l’envoi
                    est ignoré sans rien fermer. 0 = illimité.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Retours par heure et par formulaire</span>
                <TextInput
                    type='number'
                    value={draft.formHourlyQuota}
                    min={0}
                    disabled={!editable}
                    onChange={(e) => set('formHourlyQuota', e.target.value)}
                />
                <span className={shell.fieldHint}>
                    Toutes adresses confondues : c’est la borne contre une rafale venue de partout, que le quota par
                    adresse ne peut pas voir. Dépassé, le formulaire se ferme, daté et motivé, et vous le rouvrez. 0 =
                    illimité.
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
        </div>
    );
}
