import { useCallback, useEffect, useState } from 'react';
import {
    ChoiceCards,
    FeatureSettingsButton,
    humanizeError,
    NumberInput,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    StatusBadge,
    Switch,
    TextInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceConfig, FinanceLegalStatus, FinanceStatusSettings } from '../contracts/domain';
import { legalSocialBp, MICRO_ACTIVITIES } from '../contracts/legal';

import { api, refreshFinance } from './api';
import { todayIso } from './format';

/** La part du bénéfice proposée à une entreprise qui n'en a pas encore dit. */
const COMPANY_DEFAULT_BP = 2_500;

/** Un taux en points de base, tel qu'on le lit : « 25,6 % ». */
function percent(bp: number): string {
    return `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
}

/**
 * Panneau Général de la feature : le statut de l'activité, qui dit ce qu'il
 * faut mettre de côté, puis la devise et la TVA. Ces deux-là ne se règlent pas
 * ici : Facturation en a besoin pour émettre, elle les tient, et le livre les
 * suit.
 */
export default function FinanceGeneralPanel({ canWrite }: SettingsPanelProps) {
    const [config, setConfig] = useState<FinanceConfig | null>(null);
    const [draft, setDraft] = useState<FinanceStatusSettings | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.send('finance.config', {});
            setConfig(res.config);
            setDraft(res.config.status);
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    if (config === null || draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = (change: Partial<FinanceStatusSettings>) => setDraft((d) => (d ? { ...d, ...change } : d));

    const choose = (legalStatus: FinanceLegalStatus) =>
        set(
            legalStatus === 'micro'
                ? {
                      legalStatus,
                      microActivity: draft.microActivity ?? 'bnc',
                      declarationPeriod: draft.declarationPeriod ?? 'quarterly',
                      provisionRateBp: draft.legalStatus === 'micro' ? draft.provisionRateBp : null
                  }
                : {
                      legalStatus,
                      provisionRateBp: draft.legalStatus === 'company' ? draft.provisionRateBp : COMPANY_DEFAULT_BP
                  }
        );

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('finance.statusSet', { status: draft });
            setConfig(res.config);
            setDraft(res.config.status);
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const activity = MICRO_ACTIVITIES.find((entry) => entry.id === draft.microActivity);
    const legalBp = draft.microActivity === null ? null : legalSocialBp(draft.microActivity, todayIso());
    const currency = new Intl.DisplayNames('fr-FR', { type: 'currency' }).of(config.currency) ?? config.currency;
    const tracksSince = draft.legalStatus === 'company' || (draft.legalStatus === 'micro' && config.vatEnabled);

    /** Le chemin vers le réglage, dans la phrase qui le nomme : un rôle sans accès à Facturation ne le voit pas. */
    const settingIn = (section: string) =>
        config.invoicing.available ? (
            <>
                {' '}
                <FeatureSettingsButton
                    scope={{ kind: 'feature', feature: 'invoicing' }}
                    initialSection={section}
                    variant='link'
                    label='Régler dans Facturation'
                />
            </>
        ) : null;

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Statut de l’activité</span>
                <ChoiceCards
                    aria-label='Statut de l’activité'
                    value={draft.legalStatus ?? ('' as FinanceLegalStatus)}
                    disabled={!canWrite}
                    onChange={choose}
                    options={[
                        {
                            value: 'micro',
                            label: 'Micro-entreprise',
                            icon: 'icon-users',
                            description: (
                                <p>
                                    Vos cotisations sont une part du chiffre d’affaires encaissé. DevEye calcule ce que
                                    vous déclarez à l’URSSAF, ce qu’il faut garder, et vous prévient avant chaque
                                    échéance.
                                </p>
                            )
                        },
                        {
                            value: 'company',
                            label: 'Entreprise ou société',
                            icon: 'icon-projects',
                            description: (
                                <p>
                                    Entreprise au réel, EURL, SASU… DevEye garde de côté une part du bénéfice pour
                                    l’impôt et les cotisations, et la TVA due quand vous la collectez.
                                </p>
                            )
                        }
                    ]}
                />
            </div>

            {draft.legalStatus === 'micro' && (
                <>
                    <div className={shell.field}>
                        <span className={shell.fieldLabel}>Activité</span>
                        <SegmentedControl
                            aria-label='Activité'
                            value={draft.microActivity ?? 'bnc'}
                            disabled={!canWrite}
                            options={MICRO_ACTIVITIES.map((entry) => ({ value: entry.id, label: entry.label }))}
                            onChange={(microActivity) => set({ microActivity })}
                        />
                        {activity && <span className={shell.fieldHint}>{activity.hint}</span>}
                    </div>

                    <div className={shell.field}>
                        <span className={shell.fieldLabel}>Déclarations à l’URSSAF</span>
                        <SegmentedControl
                            aria-label='Cadence des déclarations'
                            value={draft.declarationPeriod ?? 'quarterly'}
                            disabled={!canWrite}
                            options={[
                                { value: 'monthly' as const, label: 'Chaque mois' },
                                { value: 'quarterly' as const, label: 'Chaque trimestre' }
                            ]}
                            onChange={(declarationPeriod) => set({ declarationPeriod })}
                        />
                    </div>

                    <label className={shell.field} htmlFor='finance-social-rate'>
                        <span className={shell.fieldLabel}>Taux de cotisations</span>
                        <NumberInput
                            id='finance-social-rate'
                            value={draft.provisionRateBp === null ? null : draft.provisionRateBp / 100}
                            min={0}
                            max={100}
                            step={0.1}
                            placeholder={legalBp === null ? '' : String(legalBp / 100).replace('.', ',')}
                            disabled={!canWrite}
                            onChange={(value) =>
                                set({ provisionRateBp: value === null ? null : Math.round(value * 100) })
                            }
                        />
                        <span className={shell.fieldHint}>
                            Vide : le taux légal{legalBp === null ? '' : `, ${percent(legalBp)} aujourd’hui`}. Un autre
                            taux, si le vôtre est réduit (l’ACRE, par exemple). La formation professionnelle s’ajoute
                            d’elle-même.
                        </span>
                    </label>

                    <Switch
                        checked={draft.incomeTaxPrepaid}
                        disabled={!canWrite}
                        onChange={(incomeTaxPrepaid) => set({ incomeTaxPrepaid })}
                        label='Versement libératoire de l’impôt'
                        hint='Vous payez l’impôt sur le revenu avec vos cotisations, à chaque déclaration : il est gardé de côté avec elles.'
                    />
                </>
            )}

            {draft.legalStatus === 'company' && (
                <label className={shell.field} htmlFor='finance-provision-rate'>
                    <span className={shell.fieldLabel}>Part du bénéfice à garder</span>
                    <NumberInput
                        id='finance-provision-rate'
                        value={(draft.provisionRateBp ?? COMPANY_DEFAULT_BP) / 100}
                        min={0}
                        max={100}
                        step={1}
                        disabled={!canWrite}
                        onChange={(value) => set({ provisionRateBp: value === null ? null : Math.round(value * 100) })}
                    />
                    <span className={shell.fieldHint}>
                        En pourcentage, pour l’impôt et les cotisations. Votre expert-comptable vous dira lequel : c’est
                        une estimation, pas un calcul d’impôt.
                    </span>
                </label>
            )}

            {tracksSince && (
                <label className={shell.field}>
                    <span className={shell.fieldLabel}>Suivi depuis le</span>
                    <TextInput
                        type='date'
                        value={draft.trackingSince ?? ''}
                        disabled={!canWrite}
                        onChange={(e) => set({ trackingSince: e.target.value === '' ? null : e.target.value })}
                        onClear={() => set({ trackingSince: null })}
                    />
                    <span className={shell.fieldHint}>
                        {draft.legalStatus === 'company'
                            ? 'La TVA et la part du bénéfice s’additionnent à partir de ce jour'
                            : 'La TVA s’additionne à partir de ce jour'}
                        , moins ce que vous avez versé depuis dans les catégories « Cotisations », « Impôts » ou « TVA
                        ». Ce qui précède a été réglé hors de DevEye.
                    </span>
                </label>
            )}

            {canWrite ? (
                <SaveButton onSave={submit} disabled={busy || draft.legalStatus === null} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Finances.
                </ReadOnlyNotice>
            )}
            {error && <p className={shell.notice}>{error}</p>}

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Devise</span>
                <span>
                    {currency.charAt(0).toUpperCase() + currency.slice(1)} ({config.currency})
                </span>
                <span className={shell.fieldHint}>
                    Celle de vos factures : un règlement dans une autre devise reste dans Facturation.
                    {settingIn('general')}
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>TVA</span>
                <span>
                    <StatusBadge tone={config.vatEnabled ? 'accent' : 'neutral'} dot={false}>
                        {config.vatEnabled ? 'Suivie' : 'Non suivie'}
                    </StatusBadge>
                </span>
                <span className={shell.fieldHint}>
                    {config.vatEnabled
                        ? 'Vos factures portent de la TVA : elle apparaît sur chaque saisie, et ce qui est dû à l’accueil.'
                        : 'Vos factures ne portent pas de TVA (franchise en base) : le livre n’en suit pas.'}
                    {settingIn('taxes')}
                </span>
            </div>

            {!config.invoicing.available && (
                <p className={shell.fieldHint}>Sans Facturation, le livre tient ses montants en euros, sans TVA.</p>
            )}
        </div>
    );
}
