import { useEffect, useState } from 'react';
import {
    Button,
    Dialog,
    FeatureSettingsButton,
    SearchSelect,
    TextInput,
    humanizeError,
    settingsStyles as shell,
    useDomains
} from 'deveye-sdk-client';

import {
    MAILSERVER_LOCAL_PART_PATTERN,
    MAILSERVER_NAME_MAX,
    MAILSERVER_QUOTA_MB_DEFAULT,
    MAILSERVER_QUOTA_MB_MAX,
    MAILSERVER_QUOTA_MB_MIN,
    type Mailbox
} from '../contracts/domain';
import { api } from './api';
import styles from './style.module.css';

export default function CreateDialog({
    open,
    onClose,
    onCreated
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (mailbox: Mailbox, password: string) => void;
}) {
    const { domains, loading } = useDomains('mailserver');
    const verified = domains.filter((domain) => domain.verifiedAt !== null);
    const [localPart, setLocalPart] = useState('');
    const [domainId, setDomainId] = useState<number | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [quotaMb, setQuotaMb] = useState(MAILSERVER_QUOTA_MB_DEFAULT);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setLocalPart('');
        setDisplayName('');
        setQuotaMb(MAILSERVER_QUOTA_MB_DEFAULT);
        setError(null);
    }, [open]);

    // Un domaine vérifié pendant que le dialogue est ouvert devient choisissable, et choisi s'il est le seul.
    const chosen = verified.find((domain) => domain.id === domainId) ?? verified[0] ?? null;
    const local = localPart.trim().toLowerCase();
    const valid =
        chosen !== null &&
        MAILSERVER_LOCAL_PART_PATTERN.test(local) &&
        quotaMb >= MAILSERVER_QUOTA_MB_MIN &&
        quotaMb <= MAILSERVER_QUOTA_MB_MAX;

    const submit = async () => {
        if (!valid || chosen === null || busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('mailserver.create', {
                localPart: local,
                domainId: chosen.id,
                displayName,
                quotaMb
            });
            onCreated(res.mailbox, res.password);
        } catch (failure) {
            setError(humanizeError(failure, 'Cette adresse n’a pas pu être créée.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Nouvelle adresse'
            description='Une boîte hébergée par DevEye, sur l’un des domaines vérifiés de l’espace.'
            width={520}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' disabled={busy} onClick={onClose}>
                        Annuler
                    </Button>
                    <Button disabled={!valid || busy} onClick={() => void submit()}>
                        Créer l’adresse
                    </Button>
                </>
            }
        >
            {!loading && verified.length === 0 ? (
                <div className={shell.section}>
                    <p className={shell.sectionHint}>
                        Aucun domaine vérifié pour l’instant. Déclarez-en un, publiez ses enregistrements DNS, puis
                        revenez créer vos adresses.
                    </p>
                    <div className={shell.sectionActions}>
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'mailserver' }}
                            initialSection='domains'
                            label='Domaines'
                        />
                    </div>
                </div>
            ) : (
                <div className={shell.section}>
                    <div className={shell.field}>
                        <span className={shell.fieldLabel}>Adresse</span>
                        <div className={styles.addressRow}>
                            <TextInput
                                value={localPart}
                                maxLength={64}
                                placeholder='prenom.nom'
                                aria-label='Avant l’arobase'
                                autoFocus
                                spellCheck={false}
                                onChange={(e) => setLocalPart(e.target.value)}
                            />
                            <span className={styles.at}>@</span>
                            <SearchSelect
                                aria-label='Domaine'
                                value={chosen === null ? '' : String(chosen.id)}
                                onChange={(v) => setDomainId(Number(v))}
                                options={verified.map((domain) => ({ value: String(domain.id), label: domain.host }))}
                            />
                        </div>
                        <span className={shell.fieldHint}>
                            Minuscules, chiffres, et « . », « _ » ou « - » entre deux. L’adresse ne se change plus
                            ensuite.
                        </span>
                    </div>
                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>Nom affiché</span>
                        <TextInput
                            value={displayName}
                            maxLength={MAILSERVER_NAME_MAX}
                            placeholder='Prénom Nom, ou le rôle de la boîte'
                            onChange={(e) => setDisplayName(e.target.value)}
                        />
                    </label>
                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>Espace de stockage (Mo)</span>
                        <TextInput
                            type='number'
                            value={String(quotaMb)}
                            min={MAILSERVER_QUOTA_MB_MIN}
                            max={MAILSERVER_QUOTA_MB_MAX}
                            onChange={(e) => setQuotaMb(Number(e.target.value))}
                        />
                    </label>
                    {error && <p className={shell.errorText}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}
