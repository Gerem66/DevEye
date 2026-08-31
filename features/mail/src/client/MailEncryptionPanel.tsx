import { useEffect, useState } from 'react';
import {
    Button,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    useActiveWorkspace,
    useResourceVersion,
    withSecrecy
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import { SECURITY_TIER_HINT, SECURITY_TIER_OPTIONS } from './securityTier';

import type { MailAccount, MailSecurityTier } from '../contracts/domain';

/**
 * Le palier de chiffrement d'une boîte : l'onglet Chiffrement de ses réglages.
 * Le formulaire d'ajout garde le choix à la création (il détermine sous quelle
 * clé la boîte naît) ; ensuite, c'est ici.
 *
 * Changer de palier re-chiffre toute la boîte côté serveur (compte, dossiers,
 * enveloppes) : le bouton l'annonce, et `withSecrecy` couvre le déverrouillage
 * qu'exige une boîte protégée.
 *
 * La boîte est l'élément de la portée (`scope.itemId`) ; l'onglet n'existe qu'à
 * cette échelle. Une boîte projetée d'un autre espace n'a pas de palier à régler
 * ici : il relie la boîte au mot de passe de son auteur, et le serveur refuse le
 * changement depuis une fenêtre. L'onglet le dit plutôt que d'ouvrir sur un refus.
 */
export default function MailEncryptionPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const version = useResourceVersion('mail.accountList');
    const workspace = useActiveWorkspace();
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [tier, setTier] = useState<MailSecurityTier>('open');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (accountId === null) return;
        void api
            .send('mail.accountList', {})
            .then((res) => {
                const found = res.accounts.find((a) => a.id === accountId) ?? null;
                setAccount(found);
                if (found) setTier(found.securityTier);
            })
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    if (accountId === null) return null;
    if (!account) return <p className={shell.notice}>{status ?? 'Chargement…'}</p>;
    if (account.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette boîte appartient à un autre espace, qui la partage ici. Son palier se règle depuis son espace
                d’origine ; ici, elle est toujours ouverte.
            </p>
        );
    }
    if (workspace?.kind !== 'personal') {
        return (
            <p className={shell.sectionHint}>
                Dans un espace partagé, la boîte vit sous la clé de l’espace, lisible par tout membre : il n’y a qu’un
                palier, ouvert.
            </p>
        );
    }

    const changed = tier !== account.securityTier;

    const save = async () => {
        setBusy(true);
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
            invalidate('mail.accountList');
            setStatus('Palier changé : la boîte a été re-chiffrée.');
        } catch (e) {
            setStatus(humanizeError(e, 'Changement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Palier</span>
                <SegmentedControl
                    aria-label='Palier de chiffrement'
                    value={tier}
                    disabled={busy || !canWrite}
                    options={SECURITY_TIER_OPTIONS}
                    onChange={setTier}
                />
                <span className={shell.fieldHint}>{SECURITY_TIER_HINT[tier]}</span>
            </div>

            <p className={shell.fieldHint}>
                Changer de palier re-chiffre toute la boîte (identité, dossiers, enveloppes) sous la nouvelle clé.
                Passer en « Protégé » exige que le chiffrement par mot de passe soit activé sur le compte, et retire la
                boîte de la relève de fond.
            </p>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void save()} disabled={busy || !changed}>
                        {busy ? 'Re-chiffrement…' : 'Changer de palier'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de changer le palier d’une boîte : il relève de l’écriture sur Mail.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}
        </div>
    );
}
