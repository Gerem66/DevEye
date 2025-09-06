import styles from './styleWorkspaces.module.css';
import stylesBtn from '../button.module.css';

import { OpenPopup } from '../../Popup';

import type { DBType_User, DBType_Workspace } from 'deveye-types';

const NavWorkspacesProps = {
    user: null as DBType_User | null,
    onWorkspaceClick: (() => {}) as (workspace: DBType_Workspace | null) => void
};

function NavWorkspaces(props = NavWorkspacesProps) {
    const { onWorkspaceClick } = props;
    const { user } = props;

    return (
        <>
            <button
                key={'workspace-back'}
                className={`${stylesBtn.button} ${styles['nav-back-button']}`}
                onClick={() => onWorkspaceClick(null)}
            >
                <span className={`icon icon-arrow ${styles.icon}`} />
                <span>Retour</span>
                <span className={`icon icon-blank ${styles['icon-blank']}`} />
            </button>

            {user?.Workspaces.map((workspace) => (
                <WorkspaceButton key={workspace.id} workspace={workspace} onClick={() => onWorkspaceClick(workspace)} />
            ))}

            <button
                key={'workspace-add'}
                className={`${stylesBtn.button} ${styles['nav-add-button']}`}
                onClick={() => OpenPopup('popup-add-workspace')}
            >
                <span className={`icon icon-add ${stylesBtn.icon}`} />
                <span>Ajouter</span>
                <span className={`icon ${styles['icon-blank']}`} />
            </button>
        </>
    );
}

function WorkspaceButton({ workspace, onClick }: { workspace: DBType_Workspace; onClick: () => void }) {
    const { id, name, logo } = workspace;

    return (
        <button
            key={'workspace-' + id}
            className={`${stylesBtn.button} ${styles['nav-workspace-button']}`}
            onClick={onClick}
        >
            <img className={styles['nav-workspace-logo']} src={'./images/' + logo} alt={name} />
            <span>{name}</span>
        </button>
    );
}

export default NavWorkspaces;
