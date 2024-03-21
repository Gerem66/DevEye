import './styleContexts.css';

/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const NavContextsProps = {
    /** @type {UserType | null} */
    user: null,

    /** @type {(context: ContextType | null) => void} */
    onContextClick: (context) => {}
};


function NavContexts(props = NavContextsProps) {
    const { onContextClick } = props;
    const { user } = props;

    return (
        <>
            <button
                key={'context-back'}
                className='button nav-back-button'
                onClick={() => onContextClick(null)}
            >
                <span className='icon icon-arrow' />
                <span>Retour</span>
                <span className='icon icon-blank' />
            </button>

            {user?.Contexts.map((context) => (
                <ContextButton
                    key={context.id}
                    context={context}
                    onClick={() => onContextClick(context)}
                />
            ))}
        </>
    );
}

/**
 * @param {Object} props
 * @param {ContextType} props.context
 * @param {() => void} props.onClick
 */
function ContextButton({ context, onClick }) {
    const { id, name, logo } = context;

    return (
        <button
            key={'context-' + id}
            className='button nav-context-button'
            onClick={onClick}
        >
            <img
                className='nav-context-logo'
                src={'./images/' + logo}
                alt={name}
            />
            <span>{name}</span>
        </button>
    );
}

export default NavContexts;
