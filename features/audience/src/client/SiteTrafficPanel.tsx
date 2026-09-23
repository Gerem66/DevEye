import { ReadOnlyNotice, SaveButton, SegmentedControl, settingsStyles as shell, TextInput } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    AUDIENCE_MAX_TRANSIT_PATHS,
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    audienceVisitorModeSchema
} from '../contracts/domain';

import { VISITOR_LABELS, visitorHint } from './format';
import styles from './style.module.css';
import { useSiteDraft } from './useSiteDraft';

const VISITOR_OPTIONS = audienceVisitorModeSchema.options.map((value) => ({ value, label: VISITOR_LABELS[value] }));

/**
 * Ce qui ne règle que la mesure : comment un visiteur est reconnu, ce que le
 * rebond ne compte pas, combien de temps le détail est gardé, et le débit
 * qu'une même adresse peut y verser.
 *
 * Le quota d'événements est le seul des trois à ne pas être compté en base :
 * le chemin de la mesure ne fait aucune requête, et lui en donner une par
 * visite reviendrait à défaire ce qui le fait tenir. Il est donc approximatif,
 * remis à zéro au redémarrage, et éteint par défaut.
 */
export default function SiteTrafficPanel({ scope, canWrite }: SettingsPanelProps) {
    const { site, draft, busy, error, set, save } = useSiteDraft(scope);

    if (!site || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }
    if (site.foreign) {
        return <p className={shell.sectionHint}>Ce site vient d’un autre espace : sa mesure se règle depuis là-bas.</p>;
    }

    const editable = canWrite && !busy;

    return (
        <div className={shell.section}>
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
                    {visitorHint(draft.visitorMode, draft.platform)}
                </span>
            </div>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Pages de transit</span>
                <textarea
                    className={styles.textarea}
                    value={draft.transitPaths}
                    rows={3}
                    disabled={!editable}
                    onChange={(e) => set('transitPaths', e.target.value)}
                    placeholder={'/loading\n/onboarding\n/login'}
                />
                <span className={shell.fieldHint}>
                    Un chemin par ligne, {AUDIENCE_MAX_TRANSIT_PATHS} au plus. Le taux de rebond ne les compte pas : une
                    visite qui n’a vu que ces pages, ou une seule autre, est un rebond. Utile quand chaque lancement
                    ouvre un écran de chargement ou de connexion avant la première vraie page. Elles restent comptées
                    partout ailleurs, et le changement vaut pour tout l’historique.
                </span>
            </label>

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
                    {AUDIENCE_RETENTION_MAX_DAYS} jours. Les retours, eux, ne sont soumis à aucune conservation.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Événements par visiteur et par heure</span>
                <TextInput
                    type='number'
                    value={draft.eventIpQuota}
                    min={0}
                    disabled={!editable}
                    onChange={(e) => set('eventIpQuota', e.target.value)}
                />
                <span className={shell.fieldHint}>
                    Volontairement haut : une même adresse peut porter tout un bureau ou un opérateur mobile, et un
                    plafond trop bas ferait disparaître des visites réelles. 0 = ne rien plafonner. Compté en mémoire,
                    donc approximatif et remis à zéro au redémarrage.
                </span>
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un site : cela relève de l’écriture sur Audience.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
