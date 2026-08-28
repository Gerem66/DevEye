import type { MinimalUser } from '@deveye/types';
import { Checkbox, Dialog, SelectInput } from 'deveye-sdk-client';
import type { GitCommitAuthor } from '../contracts/domain';

import styles from './style.module.css';

interface AuthorMapDialogProps {
    open: boolean;
    authors: GitCommitAuthor[];
    members: readonly MinimalUser[];
    /** Sans le droit d'écriture, le rattachement se lit mais ne se change pas. */
    canWrite: boolean;
    /** Réunir les auteurs rattachés sous leur membre, dans le graphe. */
    groupByMember: boolean;
    onGroupByMemberChange: (value: boolean) => void;
    onClose: () => void;
    onMap: (authorRef: string, userId: number | null) => void;
}

/**
 * Rattacher les auteurs git aux membres de l'espace.
 *
 * Dans un dialogue, ouvert depuis une pastille de la légende du graphe — et non
 * dans un `<details>` posé sous le graphe, où il flottait entre deux blocs sans
 * appartenir à aucun. La légende est le bon endroit pour l'appeler : c'est là
 * qu'on lit les auteurs, donc là qu'on remarque qu'il en manque un.
 *
 * Le rattachement donne au graphe la couleur de présence de la personne, la même
 * que partout ailleurs dans l'application.
 *
 * **La liste ci-dessous reste toujours complète**, y compris quand le graphe
 * regroupe : c'est ici qu'on fait le rattachement, il faut donc voir chaque
 * auteur git séparément. Le regroupement ne concerne que la lecture du graphe.
 */
export function AuthorMapDialog({
    open,
    authors,
    members,
    canWrite,
    groupByMember,
    onGroupByMemberChange,
    onClose,
    onMap
}: AuthorMapDialogProps) {
    const mapped = authors.filter((a) => a.userId !== null).length;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Rattacher les auteurs aux membres'
            description='Un auteur rattaché prend la couleur de son compte dans le graphe et les listes.'
            width={560}
        >
            <div className={styles.form}>
                {/*
                 * Le réglage d'abord : il décide de ce que le graphe montrera
                 * une fois le travail ci-dessous terminé, et c'est justement en
                 * finissant de rattacher qu'on veut l'atteindre.
                 */}
                <Checkbox checked={groupByMember} onChange={onGroupByMemberChange}>
                    <>
                        <span className={styles.label}>N’afficher que les membres rattachés</span>
                        <span className={styles.hint}>
                            Dans le graphe, les auteurs git rattachés disparaissent au profit du membre lui-même, qui
                            réunit tous leurs points et tous leurs commits. Décoché, la légende garde un jeton par
                            auteur git, avec la couleur du compte lorsqu’il y en a un.
                            {mapped > 0 &&
                                ` Actuellement, ${mapped} auteur${mapped > 1 ? 's' : ''} sur ${authors.length} ${mapped > 1 ? 'sont rattachés' : 'est rattaché'}.`}
                        </span>
                    </>
                </Checkbox>

                <ul className={styles.authorList}>
                    {authors.map((author) => (
                        <li key={author.authorRef}>
                            <span className={styles.authorName}>
                                {author.name || 'Auteur inconnu'}
                                <span className={styles.hint}>{author.email}</span>
                            </span>
                            <SelectInput
                                className={styles.authorSelect}
                                disabled={!canWrite}
                                value={author.userId === null ? '' : String(author.userId)}
                                onChange={(e) =>
                                    onMap(author.authorRef, e.target.value ? Number(e.target.value) : null)
                                }
                            >
                                <option value=''>Non rattaché</option>
                                {members.map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.username}
                                    </option>
                                ))}
                            </SelectInput>
                        </li>
                    ))}
                </ul>
            </div>
        </Dialog>
    );
}

export default AuthorMapDialog;
