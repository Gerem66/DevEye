import { terminalUser } from 'deveye-types';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import SelectInput from '@/Components/SelectInput';
import { setTerminalPrefs, useTerminalPrefs } from '@/stores/terminalPrefs';
import styles from './Monitoring.module.css';

/**
 * Settings card for the remote terminal (toggled from the panel's gear button):
 * the default account to open sessions under, and what happens when the shell
 * exits. Persisted via the {@link useTerminalPrefs} store. The user only takes
 * effect on a new session, so a "Relancer" action applies it immediately.
 */
export function TerminalSettings({ onRelaunch }: { onRelaunch: () => void }) {
    const prefs = useTerminalPrefs();
    const userValid = prefs.defaultUser === '' || terminalUser.safeParse(prefs.defaultUser).success;

    return (
        <div className={styles.terminalSettings}>
            <label className={styles.terminalField}>
                <span className={styles.terminalFieldLabel}>Utilisateur par défaut</span>
                <TextInput
                    value={prefs.defaultUser}
                    onChange={(e) => setTerminalPrefs({ defaultUser: e.target.value })}
                    placeholder="utilisateur de l'agent"
                    spellCheck={false}
                    autoCapitalize='off'
                    autoCorrect='off'
                    error={userValid ? undefined : 'Nom d’utilisateur invalide'}
                />
                <span className={styles.terminalFieldHint}>
                    Vide → l’utilisateur de l’agent. Sinon, la session démarre sous ce compte (su -l).
                    Pris en compte à la prochaine session.
                </span>
            </label>

            <label className={styles.terminalField}>
                <span className={styles.terminalFieldLabel}>À la fin de la session</span>
                <SelectInput
                    value={prefs.closeOnExit ? 'close' : 'keep'}
                    onChange={(e) => setTerminalPrefs({ closeOnExit: e.target.value === 'close' })}
                >
                    <option value='close'>Fermer le terminal</option>
                    <option value='keep'>Garder ouvert (Relancer)</option>
                </SelectInput>
            </label>

            <div className={styles.terminalSettingsFooter}>
                <Button variant='secondary' icon='refresh' onClick={onRelaunch} disabled={!userValid}>
                    Relancer la session
                </Button>
            </div>
        </div>
    );
}
