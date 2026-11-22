import { useEffect, useState, type ReactNode } from 'react';
import {
    Button,
    ChoiceCards,
    CopyButton,
    Dialog,
    DialogCancelButton,
    Dropzone,
    ErrorNote,
    errorNote,
    invalidate,
    ServerHeldNote,
    settingsStyles as shell,
    TextArea,
    TextInput,
    type ErrorNoteInput,
    type PickedFile
} from 'deveye-sdk-client';
import {
    APPLE_ISSUER_ID,
    APPLE_KEY_ID,
    APPLE_VENDOR_NUMBER,
    APPSTORES_SECRET_MAX_LENGTH,
    APPSTORES_SOURCE_LABEL_MAX_LENGTH,
    GOOGLE_BUCKET,
    type AppStore,
    type AppStoresSource,
    type AppStoresSourceInput
} from '../contracts/domain';

import { api, STORE_PROBE_TIMEOUT_MS } from './api';
import {
    CAPABILITY_LABELS,
    CAPABILITY_NEEDS,
    ON_STORE,
    STORE_CAPABILITIES,
    STORE_CONSOLES,
    STORE_VENDORS
} from './format';
import styles from './style.module.css';

/** Ce qu'une clé sait lire, une ligne par capacité, et ce qu'il lui faut pour celles qui manquent. */
function CapabilityChecklist({ source }: { source: AppStoresSource }) {
    return (
        <ul className={styles.checklist}>
            {STORE_CAPABILITIES[source.store].map((capability) => {
                const ok = source.capabilities.includes(capability);
                return (
                    <li key={capability} className={styles.checkItem} data-state={ok ? 'ok' : 'missing'}>
                        <span
                            className={`icon ${ok ? 'icon-check-circle' : 'icon-x-circle'} ${styles.checkIcon}`}
                            aria-hidden='true'
                        />
                        <span className={styles.checkText}>
                            <span className={styles.checkLabel}>
                                {CAPABILITY_LABELS[capability]}
                                <span className={styles.srOnly}>{ok ? ' : lisible' : ' : non lisible'}</span>
                            </span>
                            {!ok && (
                                <span className={styles.checkNeed}>{CAPABILITY_NEEDS[source.store][capability]}</span>
                            )}
                        </span>
                    </li>
                );
            })}
            <li className={styles.checkItem} data-state='later'>
                <span className={`icon icon-clock ${styles.checkIcon}`} aria-hidden='true' />
                <span className={styles.checkText}>
                    <span className={styles.checkLabel}>Répondre aux avis</span>
                    <span className={styles.checkNeed}>
                        Vérifié à la première réponse : l’essayer avant voudrait dire publier.
                    </span>
                </span>
            </li>
        </ul>
    );
}

/** Comment une clé apprend à lire davantage : une clé Apple garde le rôle de sa création. */
const WIDEN: Record<AppStore, string> = {
    apple: 'Une clé garde le rôle choisi à sa création : pour lire davantage, générez-en une au rôle Admin, puis remplacez celle-ci par « Modifier ».',
    google: 'Ce qui lui manque s’accorde dans la Play Console, puis se vérifie par « Tester ».'
};

/** La liste, et comment obtenir ce qui manque. */
export function CapabilityResult({ source }: { source: AppStoresSource }) {
    const missing = STORE_CAPABILITIES[source.store].some((capability) => !source.capabilities.includes(capability));
    return (
        <div className={shell.section}>
            <CapabilityChecklist source={source} />
            {missing && <p className={shell.fieldHint}>{WIDEN[source.store]}</p>}
        </div>
    );
}

/** Le nom du bucket, qu'on colle l'URI copiée dans la Play Console ou le nom seul. */
function bucketOf(input: string): string | null {
    const name = /^(?:gs:\/\/)?([^/\s]+)(?:\/.*)?$/.exec(input.trim())?.[1] ?? null;
    return name !== null && GOOGLE_BUCKET.test(name) ? name : null;
}

/** L'adresse du compte de service, ou ce qui ne va pas dans le fichier. */
function readServiceAccount(text: string): { email: string } | { problem: string } {
    try {
        const parsed = JSON.parse(text) as { type?: unknown; client_email?: unknown; private_key?: unknown };
        if (parsed.type !== 'service_account') {
            return {
                problem: 'Ce fichier n’est pas la clé d’un compte de service : téléchargez la clé au format JSON.'
            };
        }
        if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
            return {
                problem: 'Il manque l’adresse ou la clé privée du compte de service : téléchargez la clé de nouveau.'
            };
        }
        return { email: parsed.client_email };
    } catch {
        return { problem: 'Ce texte n’est pas un fichier JSON complet : collez-le en entier, accolades comprises.' };
    }
}

function Steps({ children }: { children: ReactNode }) {
    return <ol className={styles.steps}>{children}</ol>;
}

function AppleSteps() {
    return (
        <Steps>
            <li>
                Dans{' '}
                <a
                    className={shell.link}
                    href='https://appstoreconnect.apple.com/access/integrations/api'
                    target='_blank'
                    rel='noopener noreferrer'
                >
                    App Store Connect
                </a>
                , ouvrez Utilisateurs et accès › Intégrations › Clés d’équipe, puis Générer une clé.
            </li>
            <li>
                Choisissez l’accès Admin : c’est le seul rôle qui couvre les ventes, les avis et les réponses. Une clé
                moins puissante marche aussi, avec les seules sections qu’elle permet.
            </li>
            <li>Téléchargez le fichier .p8 : Apple ne le laisse télécharger qu’une fois.</li>
            <li>Recopiez l’Issuer ID, affiché en haut de la page des clés, et le Key ID de la nouvelle clé.</li>
            <li>Le numéro de fournisseur est dans Paiements et rapports financiers, en haut à gauche.</li>
        </Steps>
    );
}

function GoogleSteps({ email }: { email: string | null }) {
    return (
        <Steps>
            <li>
                Dans{' '}
                <a
                    className={shell.link}
                    href='https://console.cloud.google.com/'
                    target='_blank'
                    rel='noopener noreferrer'
                >
                    Google Cloud
                </a>
                , créez un projet, activez « Google Play Android Developer API » et « Google Play Developer Reporting
                API », puis créez un compte de service et une clé au format JSON.
            </li>
            <li>
                Dans la{' '}
                <a
                    className={shell.link}
                    href='https://play.google.com/console'
                    target='_blank'
                    rel='noopener noreferrer'
                >
                    Play Console
                </a>
                , ouvrez Utilisateurs et autorisations et invitez l’adresse du compte de service, avec ces autorisations
                du compte : voir les informations sur les applications et télécharger les rapports groupés, voir les
                données financières, répondre aux avis, voir les informations sur la qualité de l’application.
                {email && (
                    <span className={styles.copyRow}>
                        <code className={styles.mono}>{email}</code>
                        <CopyButton value={email} label='Copier l’adresse du compte de service' />
                    </span>
                )}
            </li>
            <li>
                Toujours dans la Play Console, ouvrez Télécharger les rapports › Statistiques, et cliquez sur « Copier
                l’URI Cloud Storage ».
            </li>
        </Steps>
    );
}

interface SourceDialogProps {
    open: boolean;
    /** Le compte à corriger ; `null` pour en relier un. */
    source: AppStoresSource | null;
    onClose: () => void;
}

/**
 * Relier un compte de store, ou le corriger : les étapes chez le store, les
 * champs, puis ce que la clé sait lire. Le serveur essaie la clé avant de
 * l'enregistrer ; un secret laissé vide garde celui en place, jamais renvoyé.
 */
export function SourceDialog({ open, source, onClose }: SourceDialogProps) {
    const [store, setStore] = useState<AppStore>('apple');
    const [label, setLabel] = useState('');
    const [issuerId, setIssuerId] = useState('');
    const [keyId, setKeyId] = useState('');
    const [vendorNumber, setVendorNumber] = useState('');
    const [reportsUri, setReportsUri] = useState('');
    /** Le contenu du `.p8` ou du JSON, lu dans le navigateur. */
    const [secret, setSecret] = useState('');
    const [secretFile, setSecretFile] = useState<string | null>(null);
    const [pasting, setPasting] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    /** Le compte tel que le serveur l'a éprouvé : le dialogue montre alors ce qu'il sait lire. */
    const [saved, setSaved] = useState<AppStoresSource | null>(null);

    useEffect(() => {
        if (!open) return;
        setStore(source?.store ?? 'apple');
        setLabel(source?.label ?? '');
        setIssuerId(source?.issuerId ?? '');
        setKeyId(source?.keyId ?? '');
        setVendorNumber(source?.vendorNumber ?? '');
        setReportsUri(source?.bucket ?? '');
        setSecret('');
        setSecretFile(null);
        setPasting(false);
        setError(null);
        setSaved(null);
    }, [open, source]);

    const editing = source !== null;
    const apple = store === 'apple';
    const bucket = bucketOf(reportsUri);
    const account = !apple && secret.trim() !== '' ? readServiceAccount(secret.trim()) : null;
    const keyProblem =
        apple && secret.trim() !== '' && !secret.includes('PRIVATE KEY')
            ? 'Ce n’est pas le contenu d’un fichier .p8 : il commence par « -----BEGIN PRIVATE KEY----- ».'
            : null;
    const secretProblem = account && 'problem' in account ? account.problem : keyProblem;
    const email = account && 'email' in account ? account.email : (source?.clientEmail ?? null);

    const fieldsReady = apple
        ? APPLE_ISSUER_ID.test(issuerId.trim()) &&
          APPLE_KEY_ID.test(keyId.trim()) &&
          APPLE_VENDOR_NUMBER.test(vendorNumber.trim())
        : bucket !== null;
    const ready = label.trim() !== '' && fieldsReady && secretProblem === null && (editing || secret.trim() !== '');

    const switchStore = (next: AppStore) => {
        setStore(next);
        setSecret('');
        setSecretFile(null);
        setPasting(false);
        setError(null);
    };

    const onFiles = (files: PickedFile[]) => {
        const file = files[0]?.file;
        if (!file) return;
        if (file.size > APPSTORES_SECRET_MAX_LENGTH) {
            setError({ message: 'Ce fichier est trop lourd pour être une clé de store.', code: 'validation' });
            return;
        }
        void file.text().then((text) => {
            setError(null);
            setSecret(text.trim());
            setSecretFile(file.name);
            // Apple nomme le fichier d'après la clé : AuthKey_<Key ID>.p8.
            const fromName = /AuthKey_([A-Z0-9]{10})\.p8$/i.exec(file.name)?.[1];
            if (apple && fromName && keyId.trim() === '') setKeyId(fromName.toUpperCase());
        });
    };

    const submit = async () => {
        if (busy || !ready) return;
        const input: AppStoresSourceInput = apple
            ? {
                  store: 'apple',
                  label: label.trim(),
                  issuerId: issuerId.trim(),
                  keyId: keyId.trim(),
                  vendorNumber: vendorNumber.trim(),
                  ...(secret.trim() ? { privateKey: secret.trim() } : {})
              }
            : {
                  store: 'google',
                  label: label.trim(),
                  bucket: bucket ?? '',
                  ...(secret.trim() ? { serviceAccount: secret.trim() } : {})
              };
        setBusy(true);
        setError(null);
        try {
            const res = source
                ? await api.send(
                      'appstores.updateSource',
                      { sourceId: source.id, source: input },
                      { timeoutMs: STORE_PROBE_TIMEOUT_MS }
                  )
                : await api.send('appstores.addSource', input, { timeoutMs: STORE_PROBE_TIMEOUT_MS });
            invalidate('appstores.sources', 'appstores.list', 'appstores.detail');
            setSaved(res.source);
        } catch (e) {
            setError(errorNote(e, 'Le compte n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    if (saved) {
        return (
            <Dialog
                open={open}
                onClose={onClose}
                title={editing ? 'Compte enregistré' : 'Compte relié'}
                description={`Voici ce que la clé « ${saved.label} » sait lire chez ${STORE_VENDORS[saved.store]}.`}
                width={580}
                onSubmit={onClose}
                footer={<Button onClick={onClose}>Terminé</Button>}
            >
                <CapabilityResult source={saved} />
            </Dialog>
        );
    }

    const consoleName = STORE_CONSOLES[store];
    const fileWord = apple ? 'fichier .p8' : 'fichier JSON du compte de service';

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={source ? `Modifier « ${source.label} »` : 'Relier un compte de store'}
            description={
                editing
                    ? `Le compte reste ${ON_STORE[store]} : pour l’autre store, reliez-en un nouveau.`
                    : 'Ses chiffres serviront à toutes les apps de cet espace qui le choisissent.'
            }
            width={620}
            onSubmit={() => void submit()}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy || !ready}>
                        {busy ? 'Essai de la clé…' : editing ? 'Enregistrer' : 'Relier le compte'}
                    </Button>
                </>
            }
        >
            <div className={shell.section}>
                {!editing && (
                    <ChoiceCards
                        aria-label='Store du compte'
                        value={store}
                        onChange={switchStore}
                        options={[
                            {
                                value: 'apple',
                                label: 'App Store',
                                icon: 'icon-apple',
                                description:
                                    'Une clé d’API App Store Connect, créée par un administrateur de votre compte développeur Apple.'
                            },
                            {
                                value: 'google',
                                label: 'Google Play',
                                icon: 'icon-google-play',
                                description: 'Un compte de service Google Cloud, invité dans votre Play Console.'
                            }
                        ]}
                    />
                )}

                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Chez {STORE_VENDORS[store]}</span>
                    {apple ? <AppleSteps /> : <GoogleSteps email={email} />}
                    {!apple && (
                        <span className={shell.fieldHint}>
                            Une autorisation donnée dans la Play Console peut mettre jusqu’à 24 h à prendre effet : si
                            l’essai échoue juste après l’invitation, réessayez plus tard.
                        </span>
                    )}
                </div>

                <label className={shell.field}>
                    <span className={shell.sectionLabel}>Nom du compte</span>
                    <TextInput
                        data-autofocus
                        value={label}
                        maxLength={APPSTORES_SOURCE_LABEL_MAX_LENGTH}
                        placeholder={apple ? 'App Store, mon équipe' : 'Google Play, mon studio'}
                        onChange={(e) => setLabel(e.target.value)}
                    />
                </label>

                {apple && (
                    <>
                        <label className={shell.field}>
                            <span className={shell.sectionLabel}>Issuer ID</span>
                            <TextInput
                                value={issuerId}
                                autoComplete='off'
                                spellCheck={false}
                                placeholder='57246542-96fe-1a63-e053-0824d011072a'
                                onChange={(e) => setIssuerId(e.target.value)}
                            />
                            {issuerId.trim() !== '' && !APPLE_ISSUER_ID.test(issuerId.trim()) && (
                                <span className={shell.warning}>
                                    Un Issuer ID compte cinq groupes de lettres et de chiffres séparés par des traits
                                    d’union.
                                </span>
                            )}
                        </label>
                        <label className={shell.field}>
                            <span className={shell.sectionLabel}>Key ID</span>
                            <TextInput
                                value={keyId}
                                autoComplete='off'
                                spellCheck={false}
                                placeholder='2X9R4HXF34'
                                onChange={(e) => setKeyId(e.target.value.toUpperCase())}
                            />
                            {keyId.trim() !== '' && !APPLE_KEY_ID.test(keyId.trim()) && (
                                <span className={shell.warning}>Un Key ID compte dix lettres et chiffres.</span>
                            )}
                        </label>
                    </>
                )}

                <div className={shell.field}>
                    <span className={shell.sectionLabel}>
                        {editing
                            ? `Nouveau ${fileWord} (facultatif)`
                            : fileWord.charAt(0).toUpperCase() + fileWord.slice(1)}
                    </span>
                    {secretFile !== null ? (
                        <span className={styles.fileLoaded}>
                            <span className='icon icon-check-circle' aria-hidden='true' />
                            <span className={styles.mono}>{secretFile}</span>
                            <button
                                type='button'
                                className={styles.linkButton}
                                onClick={() => {
                                    setSecret('');
                                    setSecretFile(null);
                                }}
                            >
                                Changer
                            </button>
                        </span>
                    ) : pasting ? (
                        <TextArea
                            value={secret}
                            rows={6}
                            spellCheck={false}
                            className={styles.mono}
                            placeholder={apple ? '-----BEGIN PRIVATE KEY-----' : '{ "type": "service_account", … }'}
                            onChange={(e) => setSecret(e.target.value)}
                        />
                    ) : (
                        <Dropzone
                            onFiles={onFiles}
                            accept={apple ? '.p8' : '.json,application/json'}
                            title={`Déposez le ${fileWord} ici, ou choisissez-le`}
                            hint='Il est lu dans votre navigateur, puis gardé chiffré : il ne se réaffiche jamais.'
                            disabled={busy}
                        />
                    )}
                    {secretFile === null && (
                        <button type='button' className={styles.linkButton} onClick={() => setPasting((v) => !v)}>
                            {pasting ? 'Choisir le fichier à la place' : 'Coller son contenu à la place'}
                        </button>
                    )}
                    {secretProblem && <span className={shell.warning}>{secretProblem}</span>}
                    {editing && (
                        <span className={shell.fieldHint}>
                            Laissez vide pour garder la clé en place : elle n’est jamais renvoyée.
                        </span>
                    )}
                    <span className={shell.fieldHint}>
                        <ServerHeldNote purpose='relever vos téléchargements, vos ventes et vos avis' />
                    </span>
                </div>

                {apple ? (
                    <label className={shell.field}>
                        <span className={shell.sectionLabel}>Numéro de fournisseur</span>
                        <TextInput
                            value={vendorNumber}
                            inputMode='numeric'
                            autoComplete='off'
                            placeholder='85012345'
                            onChange={(e) => setVendorNumber(e.target.value)}
                        />
                        <span
                            className={
                                vendorNumber.trim() !== '' && !APPLE_VENDOR_NUMBER.test(vendorNumber.trim())
                                    ? shell.warning
                                    : shell.fieldHint
                            }
                        >
                            Les ventes et les téléchargements d’Apple se lisent avec lui : un nombre de cinq à douze
                            chiffres.
                        </span>
                    </label>
                ) : (
                    <label className={shell.field}>
                        <span className={shell.sectionLabel}>URI des rapports</span>
                        <TextInput
                            value={reportsUri}
                            autoComplete='off'
                            spellCheck={false}
                            placeholder='gs://pubsite_prod_rev_01234567890987654321/'
                            onChange={(e) => setReportsUri(e.target.value)}
                        />
                        <span className={reportsUri.trim() !== '' && bucket === null ? shell.warning : shell.fieldHint}>
                            {reportsUri.trim() !== '' && bucket === null
                                ? 'Ce n’est pas l’URI des rapports : elle commence par gs://pubsite_prod_.'
                                : `Collez l’URI telle que la ${consoleName} la copie : seul le nom de son espace de stockage est gardé.`}
                        </span>
                    </label>
                )}

                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default SourceDialog;
