import { useEffect, useState } from 'react';
import {
    invalidate,
    ReadOnlyNotice,
    settingsStyles as shell,
    UnlockCancelledError,
    useActiveWorkspace,
    useResourceVersion,
    withSecrecy
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import { SecurityTierChoice } from './SecurityTierChoice';

import type { MailAccount, MailSecurityTier } from '../contracts/domain';

/**
 * La protection d'une boîte : l'onglet Chiffrement de ses réglages. Le
 * formulaire d'ajout garde le choix à la création (il détermine sous quelle clé
 * la boîte naît) ; ensuite, c'est ici.
 *
 * Choisir applique : le serveur re-chiffre toute la boîte (compte, dossiers,
 * enveloppes), et `withSecrecy` couvre le déverrouillage qu'exige une boîte
 * protégée. Le geste est réversible, il n'a donc pas de confirmation à lui.
 *
 * La boîte est l'élément de la portée (`scope.itemId`) ; l'onglet n'existe qu'à
 * cette échelle. Une boîte projetée d'un autre espace ne se règle pas ici : sa
 * protection la relie au mot de passe de son auteur, et le serveur refuse le
 * changement depuis une fenêtre. L'onglet le dit plutôt que d'ouvrir sur un refus.
 */
export default function MailEncryptionPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const version = useResourceVersion('mail.accountList');
    const workspace = useActiveWorkspace();
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [pending, setPending] = useState<MailSecurityTier | null>(null);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (accountId === null) return;
        void api
            .send('mail.accountList', {})
            .then((res) => {
                const found = res.accounts.find((a) => a.id === accountId) ?? null;
                setAccount(found);
            })
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    if (accountId === null) return null;
    if (!account) return <p className={shell.notice}>{status ?? 'Chargement…'}</p>;
    if (account.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette boîte appartient à un autre espace, qui la partage ici. Sa protection se règle depuis son espace
                d’origine ; ici, elle est toujours ouverte.
            </p>
        );
    }
    if (workspace?.kind !== 'personal') {
        return (
            <p className={shell.sectionHint}>
                Dans un espace partagé, la boîte vit sous la clé de l’espace, lisible par tout membre : elle y est
                toujours ouverte.
            </p>
        );
    }

    const apply = async (tier: MailSecurityTier) => {
        setPending(tier);
        setStatus(null);
        try {
            await withSecrecy(() =>
                api.send('mail.accountSetProfile', {
                    id: account.id,
                    displayName: account.displayName,
                    securityTier: tier,
                    syncIntervalMinutes: account.syncIntervalMinutes
                })
            );
            setAccount({ ...account, securityTier: tier });
            invalidate('mail.accountList');
            setStatus(tier === 'guarded' ? 'La boîte est maintenant protégée.' : 'La boîte est maintenant ouverte.');
        } catch (e) {
            if (!(e instanceof UnlockCancelledError)) setStatus(humanizeError(e, 'Changement impossible.'));
        } finally {
            setPending(null);
        }
    };

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Protection de la boîte</span>
                <SecurityTierChoice
                    value={account.securityTier}
                    disabled={!canWrite}
                    pending={pending}
                    onChange={(tier) => void apply(tier)}
                />
            </div>

            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de changer la protection d’une boîte : elle relève de l’écriture sur Mail.
                </ReadOnlyNotice>
            )}

            {status && (
                <p className={shell.notice} role='status'>
                    {status}
                </p>
            )}
        </div>
    );
}
