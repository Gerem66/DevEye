import { ActionMenu, Button } from 'deveye-sdk-client';

import { Picto, type PictoId } from './icons';
import { pagesByParity, type Plan } from './model';
import styles from './pdf.module.css';
import type { Workshop } from './usePdfWorkshop';

interface SelectionBarProps {
    workshop: Workshop;
    onRange: () => void;
    /** Choisir des fichiers, ajoutés à la suite des pages. */
    onAdd: () => void;
}

/** Un geste sur la sélection : son picto et son libellé, qui s'efface sur un petit écran. */
function Tool(props: { picto: PictoId; label: string; disabled: boolean; onClick: () => void }) {
    return (
        <Button
            variant='secondary'
            aria-label={props.label}
            title={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <Picto id={props.picto} size={16} />
            <span className={styles.barLabel}>{props.label}</span>
        </Button>
    );
}

const plural = (count: number, one: string, many: string): string => `${count} ${count > 1 ? many : one}`;

/** Ce qu'on fait des pages sélectionnées. Toujours là : la grille ne saute pas quand la sélection apparaît. */
export function SelectionBar({ workshop, onRange, onAdd }: SelectionBarProps) {
    const { plan, selection, act } = workshop;
    const none = selection.length === 0;
    const all = (p: Plan) => p.pages.map((page) => page.id);

    return (
        <div className={styles.bar}>
            <div className={styles.barActions}>
                <Tool
                    picto='rotateLeft'
                    label='Pivoter à gauche'
                    disabled={none}
                    onClick={() => act('rotate', { ids: selection, delta: -90 })}
                />
                <Tool
                    picto='rotateRight'
                    label='Pivoter à droite'
                    disabled={none}
                    onClick={() => act('rotate', { ids: selection, delta: 90 })}
                />
                <Tool
                    picto='duplicate'
                    label='Dupliquer'
                    disabled={none}
                    onClick={() => act('duplicate', { ids: selection })}
                />
                <Tool
                    picto='blank'
                    label='Page blanche'
                    disabled={false}
                    onClick={() => act('blank', { afterId: selection.at(-1) ?? null })}
                />
                <Button
                    variant='secondary'
                    icon='trash'
                    aria-label='Supprimer les pages sélectionnées'
                    title='Supprimer (Suppr)'
                    disabled={none}
                    onClick={() => act('remove', { ids: selection })}
                >
                    <span className={styles.barLabel}>Supprimer</span>
                </Button>
                <Button
                    variant='secondary'
                    icon='add'
                    title='Un PDF ou des images, ajoutés à la suite des pages présentes'
                    onClick={onAdd}
                >
                    Ajouter des pages
                </Button>
            </div>
            <div className={styles.barSelection}>
                <span className={styles.barCount} aria-live='polite'>
                    {none
                        ? plural(plan.pages.length, 'page', 'pages')
                        : plural(selection.length, 'page sélectionnée', 'pages sélectionnées')}
                </span>
                <ActionMenu
                    label='Sélectionner des pages'
                    className={styles.barMenu}
                    trigger={
                        <>
                            Sélectionner <span className='icon icon-chevron-down' aria-hidden='true' />
                        </>
                    }
                    items={[
                        { label: 'Toutes les pages', onSelect: () => act('select', { ids: all(plan), anchor: null }) },
                        { label: 'Aucune', onSelect: () => act('select', { ids: [], anchor: null }), disabled: none },
                        { label: 'Pages impaires', onSelect: () => act('select', { ids: pagesByParity(plan, 'odd') }) },
                        { label: 'Pages paires', onSelect: () => act('select', { ids: pagesByParity(plan, 'even') }) },
                        { label: 'Une plage…', detail: 'Par numéros : « 1-3, 7, 10- »', onSelect: onRange }
                    ]}
                />
            </div>
        </div>
    );
}
