import { useEffect, useState } from 'react';
import {
    Button,
    ChoiceCards,
    Dialog,
    DialogCancelButton,
    humanizeError,
    SearchSelect,
    SegmentedControl,
    SelectInput,
    settingsStyles as shell,
    TextInput
} from 'deveye-sdk-client';
import {
    BANK_COUNTRIES,
    BANK_LABEL_MAX_LENGTH,
    type BankConnection,
    type BankInstitution,
    type BankProvider,
    type BankPsuType
} from '../contracts/banking';

import { api, refreshFinance } from './api';
import { ConsentError, consentAtBank } from './bankWindow';

interface ConnectionDialogProps {
    open: boolean;
    /** La connexion corrigée, ou `null` pour en relier une. */
    connection: BankConnection | null;
    /** L'instance sait relier d'autres banques que Qonto. */
    enableBanking: boolean;
    onClose: () => void;
}

const PSU_TYPES: { value: BankPsuType; label: string }[] = [
    { value: 'business', label: 'Compte professionnel' },
    { value: 'personal', label: 'Compte de particulier' }
];

/**
 * Relier une banque, ou corriger une connexion. Qonto se relie par la clé d'API
 * de l'organisation ; une autre banque par le consentement donné chez elle,
 * dans une fenêtre à part, d'où elle renvoie ici. Rien ne s'enregistre que la
 * banque refuse.
 */
export default function ConnectionDialog({ open, connection, enableBanking, onClose }: ConnectionDialogProps) {
    const [kind, setKind] = useState<BankProvider>('qonto');
    const [label, setLabel] = useState('');
    const [login, setLogin] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [country, setCountry] = useState('FR');
    const [banks, setBanks] = useState<BankInstitution[] | null>(null);
    const [bank, setBank] = useState('');
    const [psuType, setPsuType] = useState<BankPsuType>('business');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setKind(connection?.provider ?? 'qonto');
        setLabel(connection?.label ?? '');
        setLogin('');
        setSecretKey('');
        setCountry(connection?.country ?? 'FR');
        setBank('');
        setPsuType('business');
        setError(null);
    }, [open, connection]);

    const choosing = connection === null && kind === 'enablebanking';
    useEffect(() => {
        if (!open || !choosing) return;
        let cancelled = false;
        setBanks(null);
        setBank('');
        api.send('finance.bankList', { country })
            .then((res) => !cancelled && setBanks(res.banks))
            .catch(
                (e: unknown) => !cancelled && setError(humanizeError(e, 'La liste des banques n’a pas pu être lue.'))
            );
        return () => {
            cancelled = true;
        };
    }, [open, choosing, country]);

    const chosen = banks?.find((entry) => entry.name === bank) ?? null;
    const types = PSU_TYPES.filter((type) => chosen?.psuTypes.includes(type.value) ?? true);
    const holder = types.some((type) => type.value === psuType) ? psuType : (types[0]?.value ?? 'personal');

    const run = async (work: () => Promise<void>, fallback: string) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (e) {
            setError(e instanceof ConsentError ? e.message : humanizeError(e, fallback));
        } finally {
            setBusy(false);
        }
    };

    const submit = () => {
        if (connection !== null) {
            void run(async () => {
                await api.send('finance.connectionUpdate', {
                    connectionId: connection.id,
                    label: label.trim() || connection.bankName,
                    login: kind === 'qonto' && login.trim() ? login.trim() : null,
                    secretKey: kind === 'qonto' && secretKey.trim() ? secretKey.trim() : null
                });
                refreshFinance();
                onClose();
            }, 'La connexion n’a pas pu être enregistrée.');
            return;
        }
        if (kind === 'qonto') {
            void run(async () => {
                await api.send('finance.connectionAddQonto', {
                    label: label.trim() || 'Qonto',
                    login: login.trim(),
                    secretKey: secretKey.trim()
                });
                refreshFinance();
                onClose();
            }, 'Qonto n’a pas pu être relié.');
            return;
        }
        if (chosen === null) return;
        void run(async () => {
            const { authUrl } = await api.send('finance.connectionStart', {
                connectionId: null,
                label: label.trim() || chosen.name,
                bank: { name: chosen.name, country: chosen.country },
                psuType: holder
            });
            await consentAtBank(authUrl);
            refreshFinance();
            onClose();
        }, 'La banque n’a pas pu être reliée.');
    };

    const ready =
        connection !== null
            ? label.trim() !== '' || connection.bankName !== ''
            : kind === 'qonto'
              ? login.trim() !== '' && secretKey.trim() !== ''
              : chosen !== null;

    const action = connection !== null ? 'Enregistrer' : kind === 'qonto' ? 'Relier Qonto' : 'Se connecter à ma banque';
    const waiting = connection === null && kind === 'enablebanking' ? 'En attente de la banque…' : 'Enregistrement…';

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={connection === null ? 'Relier une banque' : `Modifier « ${connection.label} »`}
            description={
                connection === null
                    ? 'Ses comptes se relèveront d’eux-mêmes, toutes les six heures, dans les comptes du livre qui les choisissent.'
                    : undefined
            }
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={submit} disabled={busy || !ready}>
                        {busy ? waiting : action}
                    </Button>
                </>
            }
        >
            <div className={shell.section}>
                {connection === null && (
                    <ChoiceCards
                        aria-label='Banque à relier'
                        value={kind}
                        onChange={setKind}
                        options={[
                            {
                                value: 'qonto',
                                label: 'Qonto',
                                icon: 'key',
                                description: 'Par la clé d’API de votre organisation, en lecture seule.'
                            },
                            {
                                value: 'enablebanking',
                                label: 'Autre banque',
                                icon: 'finance',
                                description:
                                    'La plupart des banques françaises et européennes, par le consentement que vous donnez chez elle.',
                                unavailable: enableBanking
                                    ? undefined
                                    : 'Ce serveur ne relie pas encore d’autres banques : importez vos relevés, ou reliez Qonto.'
                            }
                        ]}
                    />
                )}

                {kind === 'enablebanking' && connection === null && (
                    <>
                        <label className={shell.field}>
                            <span className={shell.sectionLabel}>Pays</span>
                            <SelectInput value={country} onChange={(e) => setCountry(e.target.value)}>
                                {BANK_COUNTRIES.map((entry) => (
                                    <option key={entry.code} value={entry.code}>
                                        {entry.label}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                        <div className={shell.field}>
                            <span className={shell.sectionLabel}>Banque</span>
                            <SearchSelect
                                aria-label='Banque'
                                value={bank}
                                disabled={banks === null}
                                placeholder={banks === null ? 'Chargement…' : 'Choisir votre banque'}
                                searchPlaceholder='Rechercher une banque'
                                emptyText='Aucune banque de ce nom dans ce pays.'
                                options={(banks ?? []).map((entry) => ({ value: entry.name, label: entry.name }))}
                                onChange={setBank}
                            />
                        </div>
                        {types.length > 1 && (
                            <div className={shell.field}>
                                <span className={shell.sectionLabel}>Type de compte</span>
                                <SegmentedControl
                                    aria-label='Type de compte'
                                    value={holder}
                                    options={types}
                                    onChange={setPsuType}
                                />
                            </div>
                        )}
                    </>
                )}

                <label className={shell.field}>
                    <span className={shell.sectionLabel}>Nom de la connexion</span>
                    <TextInput
                        data-autofocus
                        value={label}
                        maxLength={BANK_LABEL_MAX_LENGTH}
                        placeholder={kind === 'qonto' ? 'Qonto' : chosen?.name || 'Ma banque'}
                        onChange={(e) => setLabel(e.target.value)}
                    />
                </label>

                {kind === 'qonto' && (
                    <>
                        <label className={shell.field}>
                            <span className={shell.sectionLabel}>
                                {connection === null ? 'Identifiant' : 'Nouvel identifiant (facultatif)'}
                            </span>
                            <TextInput
                                value={login}
                                autoComplete='off'
                                placeholder='mon-entreprise-1234'
                                onChange={(e) => setLogin(e.target.value)}
                            />
                        </label>
                        <label className={shell.field}>
                            <span className={shell.sectionLabel}>
                                {connection === null ? 'Clé secrète' : 'Nouvelle clé secrète (facultatif)'}
                            </span>
                            <TextInput
                                type='password'
                                enableShowHideButton
                                autoComplete='off'
                                value={secretKey}
                                onChange={(e) => setSecretKey(e.target.value)}
                            />
                            <span className={shell.fieldHint}>
                                {connection === null
                                    ? 'Dans Qonto : Paramètres, Intégrations et partenariats, Clé API. Elle ne permet que de lire : aucun virement ne peut partir d’ici.'
                                    : 'Laissez vide pour garder ceux en place : ils ne sont jamais renvoyés.'}
                            </span>
                        </label>
                    </>
                )}

                {kind === 'enablebanking' && (
                    <p className={shell.fieldHint}>
                        {connection === null
                            ? 'Vous consentirez chez votre banque, dans une fenêtre à part. Le consentement dure jusqu’à 90 jours selon la banque : DevEye vous prévient une semaine avant sa fin.'
                            : 'Pour renouveler le consentement, utilisez « Reconnecter » dans la liste.'}
                    </p>
                )}

                {error && <p className={shell.notice}>{error}</p>}
            </div>
        </Dialog>
    );
}
