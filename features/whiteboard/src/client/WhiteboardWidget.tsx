import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

export function WhiteboardWidget() {
    const state = useWorkspaceCount('whiteboard.count');
    return (
        <CountWidget
            state={state}
            noun='tableau'
            plural='tableaux'
            hint='Schémas et croquis à plusieurs'
            empty='Aucun tableau'
        />
    );
}

export default WhiteboardWidget;
