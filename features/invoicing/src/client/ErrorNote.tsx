import { FeatureSettingsButton } from 'deveye-sdk-client';

import type { ErrorNote as Note } from './errors';
import styles from './style.module.css';

/**
 * Un refus, et le geste qui le lève. Quand la réponse est dans un réglage ou
 * dans la fiche d'un client, le bouton l'ouvre directement : retrouver ce chemin
 * soi-même, au moment précis où l'on est bloqué, n'est pas le travail de
 * l'utilisateur.
 */
export default function ErrorNote({
    note,
    client
}: {
    note: Note | null;
    /** Le client du document ouvert, s'il en a un : un refus peut renvoyer à sa fiche. */
    client?: { id: number; name: string } | null;
}) {
    if (note === null) return null;
    return (
        <div className={styles.error} role='alert'>
            <span className={styles.errorText}>{note.message}</span>
            {note.section !== null && (
                <FeatureSettingsButton
                    scope={{ kind: 'feature', feature: 'invoicing' }}
                    initialSection={note.section}
                />
            )}
            {note.clientFiche && client != null && (
                <FeatureSettingsButton
                    scope={{
                        kind: 'item',
                        feature: 'invoicing',
                        itemId: String(client.id),
                        itemLabel: client.name
                    }}
                    initialSection='general'
                    label='Compléter la fiche'
                />
            )}
        </div>
    );
}
