import { ErrorNote as SharedErrorNote, FeatureSettingsButton } from 'deveye-sdk-client';

import type { ErrorNote as Note } from './errors';

/**
 * Un refus, et le geste qui le lève. Quand la réponse est dans un réglage ou
 * dans la fiche d'un client, le bouton l'ouvre directement : retrouver ce chemin
 * soi-même, au moment précis où l'on est bloqué, n'est pas le travail de
 * l'utilisateur.
 *
 * Le bandeau et le recours au signalement viennent du SDK ; ce qui reste ici
 * est le seul chemin de réparation que Facturation sait nommer.
 */
export default function ErrorNote({
    note,
    client
}: {
    note: Note | null;
    /** Le client du document ouvert, s'il en a un : un refus peut renvoyer à sa fiche. */
    client?: { id: number; name: string } | null;
}) {
    return (
        <SharedErrorNote note={note}>
            {note !== null && note.section !== null && (
                <FeatureSettingsButton
                    scope={{ kind: 'feature', feature: 'invoicing' }}
                    initialSection={note.section}
                />
            )}
            {note !== null && note.clientFiche && client != null && (
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
        </SharedErrorNote>
    );
}
