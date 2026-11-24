import { useEffect, useState } from 'react';
import {
    errorNote,
    ErrorNote,
    invalidate,
    ReadOnlyNotice,
    settingsStyles as shell,
    UnlockCancelledError,
    useResourceVersion,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { Database, DatabaseSecurityTier } from '../contracts/domain';

import { api } from './api';
import { DatabaseTierChoice } from './DatabaseTierChoice';

/**
 * La protection d'une base : l'onglet Chiffrement de ses réglages. La fenêtre
 * d'ajout garde le choix à la création (il décide sous quelle clé ses secrets
 * naissent) ; ensuite, c'est ici.
 *
 * Choisir applique : le serveur rechiffre les deux secrets, et l'envoi du
 * module ouvre l'invite du mot de passe quand la session est verrouillée. Le
 * geste est réversible, il n'a donc pas de confirmation à lui ; ce qu'il coupe
 * (relevé, alertes) est dit sur la carte, et ne se rallume pas seul au retour.
 */
export default function DatabaseEncryptionPanel({ scope, canWrite }: SettingsPanelProps) {
    const databaseId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const version = useResourceVersion('database.detail');
    const [database, setDatabase] = useState<Database | null>(null);
    const [pending, setPending] = useState<DatabaseSecurityTier | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (databaseId === null) return;
        void api
            .send('database.get', { databaseId })
            .then((res) => setDatabase(res.database))
            .catch((e: unknown) => setError(errorNote(e, 'Les réglages n’ont pas pu être lus.')));
    }, [databaseId, version]);

    if (databaseId === null) return null;
    if (!database) return error ? <ErrorNote note={error} /> : <p className={shell.empty}>Chargement…</p>;
    if (database.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette base vient d’un autre espace, qui la partage ici. Sa protection se règle depuis là-bas ; ici, elle
                est toujours ouverte.
            </p>
        );
    }

    const apply = async (tier: DatabaseSecurityTier) => {
        setPending(tier);
        setStatus(null);
        setError(null);
        try {
            const res = await api.send('database.setTier', { databaseId: database.id, securityTier: tier });
            setDatabase(res.database);
            invalidate('database.list', 'database.detail');
            setStatus(
                tier === 'guarded'
                    ? 'La base est maintenant protégée. Son relevé automatique est arrêté et ses alertes sont éteintes.'
                    : 'La base est maintenant ouverte. Son relevé et ses alertes se rallument dans ses réglages.'
            );
        } catch (e) {
            if (!(e instanceof UnlockCancelledError)) setError(errorNote(e, 'Changement impossible.'));
        } finally {
            setPending(null);
        }
    };

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Protection de la base</span>
                <DatabaseTierChoice
                    value={database.securityTier}
                    disabled={!canWrite}
                    pending={pending}
                    onChange={(tier) => void apply(tier)}
                />
            </div>

            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de changer la protection d’une base : elle relève de l’écriture sur Bases
                    de données.
                </ReadOnlyNotice>
            )}

            {status && (
                <p className={shell.notice} role='status'>
                    {status}
                </p>
            )}
            <ErrorNote note={error} />
        </div>
    );
}
