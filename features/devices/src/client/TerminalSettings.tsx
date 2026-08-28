import { terminalUser } from '@deveye/types';
import { SelectInput, settingsStyles as shell, TextInput } from 'deveye-sdk-client';

import { setTerminalPrefs, useTerminalPrefs } from './terminalPrefs';

/**
 * Les réglages du terminal distant : le panneau Général de la coquille, à
 * l'échelle de la FEATURE. Le compte sous lequel ouvrir les sessions, et ce
 * qui se passe quand le shell se termine. Des préférences locales (par
 * navigateur, jamais synchronisées), persistées par le store
 * {@link useTerminalPrefs} ; le compte ne prend effet qu'à la session
 * suivante, que le terminal sait relancer.
 *
 * Ce panneau vivait dans le terminal lui-même, derrière un engrenage à part :
 * la dernière dette de la coquille de réglages.
 */
export function TerminalSettings({ canWrite }: { canWrite: boolean }) {
    const prefs = useTerminalPrefs();
    const userValid = prefs.defaultUser === '' || terminalUser.safeParse(prefs.defaultUser).success;

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Préférences de ce navigateur pour le terminal distant. Une session déjà ouverte garde son compte ; «
                Relancer la session » applique le nouveau.
            </p>
            <label className={shell.field}>
                <span className={shell.fieldLabel}>Utilisateur par défaut</span>
                <TextInput
                    value={prefs.defaultUser}
                    onChange={(e) => setTerminalPrefs({ defaultUser: e.target.value })}
                    placeholder="utilisateur de l'agent"
                    spellCheck={false}
                    autoCapitalize='off'
                    autoCorrect='off'
                    disabled={!canWrite}
                    error={userValid ? undefined : 'Nom d’utilisateur invalide'}
                />
                <span className={shell.fieldHint}>
                    Vide : l’utilisateur de l’agent. Sinon, la session démarre sous ce compte (su -l). Pris en compte à
                    la prochaine session.
                </span>
            </label>

            <label className={shell.field}>
                <span className={shell.fieldLabel}>À la fin de la session</span>
                <SelectInput
                    value={prefs.closeOnExit ? 'close' : 'keep'}
                    disabled={!canWrite}
                    onChange={(e) => setTerminalPrefs({ closeOnExit: e.target.value === 'close' })}
                >
                    <option value='close'>Fermer le terminal</option>
                    <option value='keep'>Garder ouvert (Relancer)</option>
                </SelectInput>
            </label>
        </div>
    );
}
