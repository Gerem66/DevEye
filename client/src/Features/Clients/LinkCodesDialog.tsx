import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { Switch } from './Switch';
import { formatExpiry } from './format';
import type { LinkCodes } from './useLinkCodes';
import styles from './Clients.module.css';

/** The "Ajouter un appareil" modal: generate + manage link codes. */
export function LinkCodesDialog({ links, onDownload }: { links: LinkCodes; onDownload: () => void }) {
    return (
        <Dialog
            open={links.showLinkModal}
            onClose={links.closeModal}
            title='Codes de liaison'
            description="Générez un code, puis utilisez-le dans l'agent DevEye pour lier un appareil."
            onSubmit={() => void links.generateLinkCode()}
            headerAction={
                <button
                    className={styles.iconBtn}
                    onClick={links.showLinkInfo}
                    title='Comment lier un appareil ?'
                    aria-label='Aide'
                >
                    <span className='icon icon-info' />
                </button>
            }
            footer={
                <>
                    <Button variant='secondary' icon='cpu' onClick={onDownload}>
                        Télécharger l’agent
                    </Button>
                    <Button variant='secondary' onClick={links.closeModal}>
                        Fermer
                    </Button>
                </>
            }
        >
            {/* Generation controls: pick a validity, then generate. */}
            <div className={styles.genRow}>
                <SelectInput
                    value={links.ttlPreset}
                    onChange={(e) => links.setTtlPreset(e.target.value)}
                    aria-label='Durée de validité'
                >
                    <option value='300'>Valide 5 minutes</option>
                    <option value='900'>Valide 15 minutes</option>
                    <option value='3600'>Valide 1 heure</option>
                    <option value='86400'>Valide 24 heures</option>
                    <option value='custom'>Durée personnalisée…</option>
                    <option value='none'>Sans expiration</option>
                </SelectInput>
                {links.ttlPreset === 'custom' && (
                    <TextInput
                        type='number'
                        min='1'
                        value={links.customMinutes}
                        onChange={(e) => links.setCustomMinutes(e.target.value)}
                        className={styles.minutesInput}
                        aria-label='Durée en minutes'
                        placeholder='minutes'
                    />
                )}
                <Button onClick={links.generateLinkCode} disabled={links.generatingCode}>
                    {links.generatingCode ? 'Génération…' : 'Générer'}
                </Button>
            </div>
            <Switch
                checked={links.autoApprove}
                onChange={links.setAutoApprove}
                label='Approuver automatiquement à la liaison'
                hint='Sinon l’appareil reste « En attente » jusqu’à votre approbation (recommandé).'
            />
            {links.genError && <p className={styles.genError}>{links.genError}</p>}

            {/* Table of active (pending) codes. */}
            {links.codes.length === 0 ? (
                <p className={styles.noCodes}>Aucun code actif. Générez-en un ci-dessus.</p>
            ) : (
                <table className={styles.codeTable}>
                    <thead>
                        <tr>
                            <th>Code</th>
                            <th>Validité</th>
                            <th aria-label='Actions' />
                        </tr>
                    </thead>
                    <tbody>
                        {links.codes.map((c) => (
                            <tr key={c.code}>
                                <td>
                                    <code className={styles.codeCell}>{c.code}</code>
                                </td>
                                <td className={styles.validityCell}>{formatExpiry(c.expiresAt)}</td>
                                <td className={styles.codeRowActions}>
                                    <button
                                        className={`${styles.iconBtn} ${c.autoApprove ? styles.iconApprove : ''}`}
                                        onClick={() => links.toggleAutoApprove(c.code, !c.autoApprove)}
                                        aria-pressed={c.autoApprove}
                                        title={
                                            c.autoApprove
                                                ? 'Auto-approbation activée — cliquer pour désactiver'
                                                : 'Auto-approbation désactivée — cliquer pour activer'
                                        }
                                    >
                                        <span
                                            className={`icon ${c.autoApprove ? 'icon-check-circle' : 'icon-x-circle'}`}
                                        />
                                    </button>
                                    <button
                                        className={`${styles.iconBtn} ${links.copiedCode === c.code ? styles.copied : ''}`}
                                        onClick={() => links.copyCode(c.code)}
                                        title={links.copiedCode === c.code ? 'Copié' : 'Copier'}
                                    >
                                        <span
                                            className={`icon ${links.copiedCode === c.code ? 'icon-check-circle' : 'icon-copy'}`}
                                        />
                                    </button>
                                    <button
                                        className={`${styles.iconBtn} ${styles.iconDanger}`}
                                        onClick={() => links.deleteCode(c.code)}
                                        title='Invalider ce code'
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Dialog>
    );
}
