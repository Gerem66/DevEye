import { useState } from 'react';

import Checkbox from '@/Components/Checkbox';
import ChoiceCards from '@/Components/ChoiceCards';
import NumberInput from '@/Components/NumberInput';
import SearchSelect from '@/Components/SearchSelect';
import SegmentedControl from '@/Components/SegmentedControl';
import SelectInput from '@/Components/SelectInput';
import Slider from '@/Components/Slider';
import Switch from '@/Components/Switch';
import TextInput from '@/Components/TextInput';
import { Specimen, useGalleryDisabled, Variant } from '../Specimen';

const CURRENCIES = [
    { value: 'EUR', label: 'Euro', detail: 'EUR', group: 'Europe' },
    { value: 'CHF', label: 'Franc suisse', detail: 'CHF', group: 'Europe' },
    { value: 'GBP', label: 'Livre sterling', detail: 'GBP', group: 'Europe' },
    { value: 'USD', label: 'Dollar américain', detail: 'USD', group: 'Amériques' },
    { value: 'CAD', label: 'Dollar canadien', detail: 'CAD', group: 'Amériques' },
    { value: 'JPY', label: 'Yen', detail: 'JPY', group: 'Asie', disabled: true }
];

export default function Inputs() {
    const disabled = useGalleryDisabled();
    const [text, setText] = useState('Texte saisi');
    const [number, setNumber] = useState<number | null>(30);
    const [currency, setCurrency] = useState('EUR');
    const [choice, setChoice] = useState<'open' | 'guarded' | 'private'>('open');
    const [slider, setSlider] = useState(60);
    const [checks, setChecks] = useState([true, false]);
    const [toggle, setToggle] = useState(true);
    const [two, setTwo] = useState<'on' | 'off'>('on');
    const [three, setThree] = useState<'day' | 'week' | 'month'>('week');
    const [four, setFour] = useState<'1' | '2' | '3' | '4'>('2');

    return (
        <>
            <Specimen title='TextInput'>
                <Variant label='vide'>
                    <TextInput placeholder='Nom du site' disabled={disabled} />
                </Variant>
                <Variant label='rempli'>
                    <TextInput value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} />
                </Variant>
                <Variant label='erreur'>
                    <TextInput value='pas-une-adresse' readOnly error='Adresse invalide' disabled={disabled} />
                </Variant>
                <Variant label='mot de passe'>
                    <TextInput type='password' defaultValue='secret' enableShowHideButton disabled={disabled} />
                </Variant>
                <Variant label='désactivé'>
                    <TextInput value='Lecture seule' disabled readOnly />
                </Variant>
            </Specimen>
            <Specimen title='NumberInput' note='Borné à 0..100, pas de 5 ; la molette ne marche que champ actif.'>
                <Variant label='0..100 / 5'>
                    <NumberInput value={number} onChange={setNumber} min={0} max={100} step={5} disabled={disabled} />
                </Variant>
            </Specimen>
            <Specimen title='SelectInput et SearchSelect'>
                <Variant label='SelectInput'>
                    <SelectInput defaultValue='week' disabled={disabled}>
                        <option value='day'>Chaque jour</option>
                        <option value='week'>Chaque semaine</option>
                        <option value='month'>Chaque mois</option>
                    </SelectInput>
                </Variant>
                <Variant label='SearchSelect groupé'>
                    <SearchSelect
                        value={currency}
                        options={CURRENCIES}
                        onChange={setCurrency}
                        aria-label='Devise'
                        searchPlaceholder='Chercher une devise'
                        disabled={disabled}
                    />
                </Variant>
            </Specimen>
            <Specimen title='ChoiceCards' note='Un choix qui engage : chaque carte dit ce qu’elle implique.'>
                <Variant label='trois cartes, une indisponible' wide>
                    <ChoiceCards
                        value={choice}
                        onChange={setChoice}
                        disabled={disabled}
                        aria-label='Niveau de protection'
                        options={[
                            { value: 'open', label: 'Ouvert', description: 'Lisible par le serveur.', icon: 'unlock' },
                            {
                                value: 'guarded',
                                label: 'Protégé',
                                description: 'Déchiffré par votre mot de passe.',
                                icon: 'lock'
                            },
                            {
                                value: 'private',
                                label: 'Privé',
                                description: 'Pour vous seul.',
                                icon: 'key',
                                unavailable: 'Réservé à l’offre Pro'
                            }
                        ]}
                    />
                </Variant>
            </Specimen>
            <Specimen title='Slider'>
                <Variant label='repères' wide>
                    <Slider
                        value={slider}
                        onChange={setSlider}
                        min={0}
                        max={100}
                        step={10}
                        label='Opacité'
                        valueLabel={`${slider} %`}
                        marks={['0 %', '50 %', '100 %']}
                        indicator={80}
                        hint='Le trait marque la valeur par défaut.'
                        disabled={disabled}
                    />
                </Variant>
            </Specimen>
            <Specimen title='Checkbox et Switch'>
                <Variant label='Checkbox'>
                    {checks.map((checked, i) => (
                        <Checkbox
                            key={i}
                            checked={checked}
                            disabled={disabled}
                            onChange={(on) => setChecks((c) => c.map((v, j) => (j === i ? on : v)))}
                        >
                            Option {i + 1}
                        </Checkbox>
                    ))}
                    <Checkbox checked disabled onChange={() => undefined}>
                        Désactivée
                    </Checkbox>
                </Variant>
                <Variant label='Switch'>
                    <Switch
                        checked={toggle}
                        onChange={setToggle}
                        label='Notifications'
                        hint='Un mail par alerte.'
                        disabled={disabled}
                    />
                    <Switch checked={false} onChange={() => undefined} aria-label='Désactivé' disabled />
                </Variant>
            </Specimen>
            <Specimen title='SegmentedControl' note='De 2 à 5 choix fixes ; au-delà, une liste.'>
                <Variant label='2'>
                    <SegmentedControl
                        value={two}
                        onChange={setTwo}
                        aria-label='Deux choix'
                        disabled={disabled}
                        options={[
                            { value: 'on', label: 'Activé' },
                            { value: 'off', label: 'Coupé' }
                        ]}
                    />
                </Variant>
                <Variant label='3'>
                    <SegmentedControl
                        value={three}
                        onChange={setThree}
                        aria-label='Trois choix'
                        disabled={disabled}
                        options={[
                            { value: 'day', label: 'Jour' },
                            { value: 'week', label: 'Semaine' },
                            { value: 'month', label: 'Mois' }
                        ]}
                    />
                </Variant>
                <Variant label='4, pleine largeur, avec détail' wide>
                    <SegmentedControl
                        value={four}
                        onChange={setFour}
                        aria-label='Quatre choix'
                        fullWidth
                        disabled={disabled}
                        options={[
                            { value: '1', label: 'Original', detail: '4K' },
                            { value: '2', label: 'Haute', detail: '1080p' },
                            { value: '3', label: 'Moyenne', detail: '720p' },
                            { value: '4', label: 'Basse', detail: '480p' }
                        ]}
                    />
                </Variant>
            </Specimen>
        </>
    );
}
