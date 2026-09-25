import type { ReactNode } from 'react';
import type { UserColor } from '@deveye/types';
import { PAGE_ACCENTS, type PageTheme, type PageThemeChoice } from '@deveye/types/sdk';

import settingsStyles from '@/Components/FeatureSettings/FeatureSettings.module.css';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import { useCurrentUser } from '@/stores/currentUser';
import styles from './PageLook.module.css';

const THEME_LABELS: Readonly<Record<PageThemeChoice, string>> = {
    auto: 'Automatique',
    light: 'Clair',
    dark: 'Sombre'
};

/** La couleur du compte d'abord : c'est celle qu'on propose en premier. */
function orderedAccents(mine: UserColor | undefined): UserColor[] {
    const names = Object.keys(PAGE_ACCENTS) as UserColor[];
    return mine === undefined ? names : [mine, ...names.filter((name) => name !== mine)];
}

export interface PageLookFieldsProps<T extends PageThemeChoice> {
    theme: T;
    /** Un nom de couleur de compte, un `#rrggbb`, ou vide pour l'accent de la page. */
    accent: string;
    /** Les thèmes proposés, dans cet ordre. */
    themes: readonly T[];
    /** L'accent de la page quand aucun n'est choisi, par thème : sa pastille. */
    ownAccent: Readonly<Record<PageTheme, string>>;
    disabled?: boolean;
    onChange: (next: { theme: T; accent: string }) => void;
    /** Sous les champs : une vignette de la page, à l'allure choisie. */
    preview?: ReactNode;
}

/**
 * L'allure d'une page publique qu'un module sert : son thème et son accent, les
 * mêmes choix partout où une page se montre hors de l'app.
 */
export function PageLookFields<T extends PageThemeChoice>({
    theme,
    accent,
    themes,
    ownAccent,
    disabled = false,
    onChange,
    preview
}: PageLookFieldsProps<T>) {
    const me = useCurrentUser();
    const mine = me?.color;
    const own = ownAccent[theme === 'dark' ? 'dark' : 'light'];

    return (
        <>
            <div className={styles.row}>
                <div className={settingsStyles.field}>
                    <span className={settingsStyles.fieldLabel}>Thème</span>
                    <SegmentedControl
                        aria-label='Thème de la page publique'
                        value={theme}
                        options={themes.map((value) => ({ value, label: THEME_LABELS[value] }))}
                        disabled={disabled}
                        onChange={(value) => onChange({ theme: value, accent })}
                    />
                    {themes.includes('auto' as T) && (
                        <span className={settingsStyles.fieldHint}>
                            Automatique suit le réglage clair ou sombre du visiteur.
                        </span>
                    )}
                </div>
                <div className={settingsStyles.field}>
                    <span className={settingsStyles.fieldLabel}>Couleur d’accent</span>
                    <div className={styles.swatches}>
                        {orderedAccents(mine).map((name) => (
                            <button
                                key={name}
                                type='button'
                                disabled={disabled}
                                title={name === mine ? 'Votre couleur de profil' : undefined}
                                aria-label={name === mine ? 'Votre couleur de profil' : `Couleur d’accent ${name}`}
                                aria-pressed={accent === name}
                                className={accent === name ? styles.swatchOn : styles.swatch}
                                style={{ background: PAGE_ACCENTS[name] }}
                                onClick={() => onChange({ theme, accent: name })}
                            />
                        ))}
                        <button
                            type='button'
                            disabled={disabled}
                            aria-label='Accent d’origine'
                            title='Accent d’origine'
                            aria-pressed={accent === ''}
                            className={accent === '' ? styles.swatchOn : styles.swatch}
                            style={{ background: own }}
                            onClick={() => onChange({ theme, accent: '' })}
                        />
                    </div>
                    <TextInput
                        value={accent.startsWith('#') ? accent : ''}
                        placeholder={own}
                        maxLength={7}
                        disabled={disabled}
                        aria-label='Une autre couleur, en hexadécimal'
                        onChange={(event) => onChange({ theme, accent: event.target.value.trim() })}
                    />
                    <span className={settingsStyles.fieldHint}>
                        Une pastille, ou votre propre couleur en hexadécimal. La première pastille est votre couleur de
                        profil.
                    </span>
                </div>
            </div>
            {preview}
        </>
    );
}
