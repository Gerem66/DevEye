import { useEffect, useMemo, useState } from 'react';
import { Button, SelectInput, useResource } from 'deveye-sdk-client';

import { convertCurrency } from '../contracts/units';
import { api } from './api';
import { NumberField } from './controls/NumberField';
import { formatAmount } from './format';
import styles from './style.module.css';

/** Le nom d'une devise dans la langue de l'écran, d'après son code. Le navigateur les connaît toutes. */
const NAMES = new Intl.DisplayNames(['fr'], { type: 'currency' });
const nameOf = (code: string): string => {
    try {
        return NAMES.of(code) ?? code;
    } catch {
        return code;
    }
};

const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export function Currency({ onBack }: { onBack: () => void }) {
    const rates = useResource(
        'convert.rates',
        () => api.send('convert.rates', {}),
        'Impossible de lire les taux de change.'
    );
    const settings = useResource(
        'convert.settings',
        () => api.send('convert.settingsGet', {}).then((r) => r.settings),
        'Impossible de lire les réglages.'
    );
    const [amount, setAmount] = useState<number | null>(100);
    const [from, setFrom] = useState('EUR');
    const [to, setTo] = useState('USD');

    // La devise de référence de l'espace n'est connue qu'après coup : elle ne
    // s'impose qu'une fois, à l'arrivée des réglages, pas à chaque relecture.
    const base = settings.data?.baseCurrency;
    useEffect(() => {
        if (!base) return;
        setFrom(base);
        setTo((current) => (current === base ? (base === 'EUR' ? 'USD' : 'EUR') : current));
    }, [base]);

    const codes = useMemo(
        () => Object.keys(rates.data?.rates ?? {}).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'fr')),
        [rates.data]
    );
    const result = amount === null || !rates.data ? null : convertCurrency(rates.data.rates, from, to, amount);
    const unit = rates.data ? convertCurrency(rates.data.rates, from, to, 1) : null;

    const options = codes.map((code) => (
        <option key={code} value={code}>
            {nameOf(code)} ({code})
        </option>
    ));

    return (
        <div className={styles.stepBody}>
            {rates.error && (
                <p className={styles.problem} role='alert'>
                    {rates.error}
                </p>
            )}
            {rates.data && codes.length === 0 && (
                <p className={styles.note}>
                    Les taux de change n’ont pas encore été relevés : le serveur les lit à son démarrage, puis plusieurs
                    fois par jour.
                </p>
            )}

            {codes.length > 0 && (
                <>
                    <div className={styles.converter}>
                        <div className={styles.converterSide}>
                            <NumberField aria-label='Montant à convertir' value={amount} min={0} onChange={setAmount} />
                            <SelectInput
                                aria-label='Devise de départ'
                                value={from}
                                onChange={(e) => setFrom(e.target.value)}
                            >
                                {options}
                            </SelectInput>
                        </div>
                        <button
                            type='button'
                            className={styles.swap}
                            aria-label='Inverser les deux devises'
                            onClick={() => {
                                setFrom(to);
                                setTo(from);
                            }}
                        >
                            ⇄
                        </button>
                        <div className={styles.converterSide}>
                            <output className={styles.result} aria-live='polite'>
                                {result === null ? '…' : `${formatAmount(result)} ${to}`}
                            </output>
                            <SelectInput
                                aria-label='Devise d’arrivée'
                                value={to}
                                onChange={(e) => setTo(e.target.value)}
                            >
                                {options}
                            </SelectInput>
                        </div>
                    </div>
                    <p className={styles.note}>
                        {unit !== null && `1 ${from} = ${formatAmount(unit)} ${to}. `}
                        {rates.data?.asOf &&
                            `Taux de référence de la Banque centrale européenne du ${DAY.format(new Date(`${rates.data.asOf}T12:00:00`))}. `}
                        {rates.data?.stale && 'La source ne répond plus depuis un moment : ces taux peuvent dater. '}
                        Un bureau de change ou une banque applique en plus sa propre marge.
                    </p>
                </>
            )}

            <div className={styles.stepNav}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Convertisseur
                </Button>
            </div>
        </div>
    );
}
