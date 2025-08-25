import styles from './styleContexts.module.css';
import stylesBtn from '../button.module.css';

import { OpenPopup } from '../../Popup';

import type { UserType, ContextType } from 'deveye-types';

const NavContextsProps = {
    user: null as UserType | null,
    onContextClick: (() => {}) as (context: ContextType | null) => void
};

function NavContexts(props = NavContextsProps) {
    const { onContextClick } = props;
    const { user } = props;

    return (
        <>
            <button
                key={'context-back'}
                className={`${stylesBtn.button} ${styles['nav-back-button']}`}
                onClick={() => onContextClick(null)}
            >
                <span className={`icon icon-arrow ${styles.icon}`} />
                <span>Retour</span>
                <span className={`icon icon-blank ${styles['icon-blank']}`} />
            </button>

            {user?.Contexts.map((context) => (
                <ContextButton key={context.id} context={context} onClick={() => onContextClick(context)} />
            ))}

            <button
                key={'context-add'}
                className={`${stylesBtn.button} ${styles['nav-add-button']}`}
                onClick={() => OpenPopup('popup-add-context')}
            >
                <span className={`icon icon-add ${stylesBtn.icon}`} />
                <span>Ajouter</span>
                <span className={`icon ${styles['icon-blank']}`} />
            </button>
        </>
    );
}

function ContextButton({ context, onClick }: { context: ContextType; onClick: () => void }) {
    const { id, name, logo } = context;

    return (
        <button
            key={'context-' + id}
            className={`${stylesBtn.button} ${styles['nav-context-button']}`}
            onClick={onClick}
        >
            <img className={styles['nav-context-logo']} src={'./images/' + logo} alt={name} />
            <span>{name}</span>
        </button>
    );
}

export default NavContexts;
