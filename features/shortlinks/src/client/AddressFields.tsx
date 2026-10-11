import { FeatureSettingsButton, SearchSelect, settingsStyles as shell, TextInput, useDomains } from 'deveye-sdk-client';

import { normaliseSlug, SHORTLINK_SLUG_MAX, SHORTLINK_SLUG_PATTERN } from '../contracts/domain';
import styles from './style.module.css';

/** L'alias saisi est-il recevable sur un domaine ? Vide l'est : c'est la racine. */
export function slugValid(slug: string): boolean {
    return SHORTLINK_SLUG_PATTERN.test(normaliseSlug(slug));
}

interface AddressFieldsProps {
    idPrefix: string;
    domainId: number | null;
    slug: string;
    onChange: (next: { domainId: number | null; slug: string }) => void;
    /** Le domaine déjà choisi par le lien : proposé même s'il retombe en attente, le taire ferait croire qu'il n'est plus choisi. */
    keepDomainId?: number | null;
    /** La classe des intitulés : celle d'un dialogue ou celle d'un onglet de réglages. */
    labelClassName: string;
    disabled?: boolean;
}

/**
 * Où le lien répond : sur l'adresse de DevEye seule, ou en plus sous un nom
 * choisi sur un domaine vérifié de l'espace. L'adresse partagée de DevEye ne
 * prend jamais de nom choisi : un lien qui se ferait passer pour une marque y
 * engagerait tout le monde.
 */
export default function AddressFields({
    idPrefix,
    domainId,
    slug,
    onChange,
    keepDomainId = null,
    labelClassName,
    disabled
}: AddressFieldsProps) {
    const { domains, loading } = useDomains('shortlinks');
    const offered = domains.filter(
        (domain) => (domain.verifiedAt !== null && !domain.planPaused) || domain.id === keepDomainId
    );
    const chosen = domainId === null ? null : (domains.find((domain) => domain.id === domainId) ?? null);
    const normalised = normaliseSlug(slug);
    const invalid = domainId !== null && !SHORTLINK_SLUG_PATTERN.test(normalised);
    const selectId = `${idPrefix}-domain`;
    const slugId = `${idPrefix}-slug`;

    if (!loading && offered.length === 0 && domainId === null) {
        return (
            <div className={shell.field}>
                <span className={labelClassName}>Adresse</span>
                <span className={styles.fixedValue}>Adresse de DevEye, avec un code tiré au hasard</span>
                <span className={shell.fieldHint}>
                    Pour choisir le nom du lien, ajoutez un domaine à vous dans les réglages (offre Pro).{' '}
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'shortlinks' }}
                        initialSection='domains'
                        variant='link'
                        label='Ajouter un domaine'
                    />
                </span>
            </div>
        );
    }

    return (
        <>
            <div className={shell.field}>
                <label className={labelClassName} htmlFor={selectId}>
                    Adresse
                </label>
                <SearchSelect
                    id={selectId}
                    aria-label='Adresse du lien'
                    value={domainId === null ? '' : String(domainId)}
                    disabled={disabled}
                    onChange={(value) => onChange({ domainId: value === '' ? null : Number(value), slug })}
                    options={[
                        { value: '', label: 'Adresse de DevEye', detail: 'Un code tiré au hasard' },
                        ...offered.map((domain) => ({
                            value: String(domain.id),
                            label: domain.host,
                            detail:
                                domain.verifiedAt === null
                                    ? 'En attente de vérification'
                                    : domain.planPaused
                                      ? 'En pause, au-delà de l’offre'
                                      : 'Un nom que vous choisissez'
                        }))
                    ]}
                />
                {chosen !== null && (chosen.verifiedAt === null || chosen.planPaused) ? (
                    <span className={shell.warning}>
                        {`${chosen.host} ne sert pas encore de liens : celui-ci reste sur l’adresse de DevEye d’ici là.`}
                    </span>
                ) : (
                    <span className={shell.fieldHint}>
                        Le lien garde toujours son adresse sur DevEye. Un domaine à vous lui ajoute une adresse au nom
                        de votre choix.
                    </span>
                )}
            </div>

            {chosen !== null && (
                <div className={shell.field}>
                    <label className={labelClassName} htmlFor={slugId}>
                        Nom du lien sur {chosen.host}
                    </label>
                    <span className={styles.slugField}>
                        <span className={styles.slugPrefix}>{chosen.host}/</span>
                        <TextInput
                            id={slugId}
                            value={slug}
                            maxLength={SHORTLINK_SLUG_MAX}
                            placeholder='promo'
                            disabled={disabled}
                            aria-invalid={invalid}
                            onChange={(event) => onChange({ domainId, slug: event.target.value.toLowerCase() })}
                        />
                    </span>
                    {invalid ? (
                        <span className={shell.errorText}>
                            Des minuscules, des chiffres et des tirets, sans espace, accent ni point.
                        </span>
                    ) : (
                        <span className={shell.fieldHint}>
                            {normalised.length === 0
                                ? `Vide, le lien répond à la racine : https://${chosen.host}`
                                : `Le lien sera https://${chosen.host}/${normalised}`}
                        </span>
                    )}
                </div>
            )}
        </>
    );
}
