import { useState } from 'react';

import Button from '@/Components/Button';
import { availableTopbarWidgets } from '@/Components/TopNavbar/topbarWidgets';
import { addSectionWith, addTopbarWidgets } from '@/stores/homeLayout';
import { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
import { HOME_STARTERS, starterFeatures } from './starters';
import styles from './Dashboard.module.css';

export interface EmptyHomeProps {
    /** Le droit de composer la disposition (`workspace.layout`). */
    canLayout: boolean;
    /** Le chemin manuel : passer en organisation sur une section neuve. */
    onCompose: () => void;
}

/**
 * L'accueil neuf : des modèles à cocher, qui posent chacun une section garnie,
 * et le chemin manuel en retrait. Rien ne se confirme, le mode organisation
 * défait tout.
 */
export function EmptyHome({ canLayout, onCompose }: EmptyHomeProps) {
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
    const workspace = useActiveWorkspace();
    const { canFeature } = useWorkspacePermissions();

    if (!canLayout) {
        return (
            <div className={styles.emptyHome}>
                <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
                <span className={styles.emptyHomeTitle}>L’accueil de cet espace est vide</span>
                <span className={styles.emptyHomeHint}>Votre rôle ne permet pas d’en modifier la disposition.</span>
            </div>
        );
    }

    // Un modèle dont aucun module n'est installé n'a rien à poser.
    const starters = HOME_STARTERS.map((starter) => ({ starter, entries: starterFeatures(starter) })).filter(
        ({ entries }) => entries.length > 0
    );

    const toggle = (id: string) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });

    const place = () => {
        const chosen = starters.filter(({ starter }) => picked.has(starter.id));
        for (const { starter, entries } of chosen) {
            addSectionWith(
                starter.label,
                entries.map((entry) => entry.id)
            );
        }
        // Un widget dont le module manque ou que le rôle n'accorde pas ne serait jamais rendu.
        const usable = new Set(availableTopbarWidgets(workspace?.kind, canFeature).map((widget) => widget.id));
        addTopbarWidgets(chosen.flatMap(({ starter }) => starter.topbar).filter((id) => usable.has(id)));
    };

    return (
        <div className={styles.emptyHome}>
            <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
            <span className={styles.emptyHomeTitle}>Votre accueil est vide</span>
            <span className={styles.emptyHomeHint}>
                {starters.length > 0
                    ? 'Choisissez ce que cet espace doit suivre : chaque choix pose une section, que vous réorganiserez à votre guise.'
                    : 'Composez votre première section : appareils, fonctionnalités et raccourcis y cohabitent.'}
            </span>

            {starters.length > 0 && (
                <>
                    <div className={styles.starters}>
                        {starters.map(({ starter, entries }) => {
                            const on = picked.has(starter.id);
                            return (
                                <button
                                    key={starter.id}
                                    type='button'
                                    aria-pressed={on}
                                    className={`${styles.starter} ${on ? styles.starterPicked : ''}`}
                                    onClick={() => toggle(starter.id)}
                                >
                                    <span className={styles.starterHead}>
                                        <span className={`icon icon-${starter.icon} ${styles.starterIcon}`} />
                                        <span className={styles.starterName}>{starter.label}</span>
                                        <span
                                            className={
                                                on ? `icon icon-check-circle ${styles.starterMark}` : styles.starterRing
                                            }
                                        />
                                    </span>
                                    {/* Ce que le choix va poser, lu au catalogue plutôt que
                                        redit dans un texte à maintenir. */}
                                    <span className={styles.starterFeatures}>
                                        {entries.map((entry) => (
                                            <span key={entry.id} className={styles.starterChip}>
                                                <span className={`icon icon-${entry.icon} ${styles.starterChipIcon}`} />
                                                {entry.title}
                                            </span>
                                        ))}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <Button className={styles.starterPlace} disabled={picked.size === 0} onClick={place}>
                        {picked.size > 1 ? `Valider les ${picked.size} sections` : 'Valider'}
                    </Button>
                </>
            )}

            <button type='button' className={styles.emptyManual} onClick={onCompose}>
                Composer moi-même
            </button>
        </div>
    );
}
