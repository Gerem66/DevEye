import type { RequestCommands } from 'deveye-types';
import type { TCPRequestSendHeader } from 'deveye-types';
import type { TCPRequestReceiveHeader } from 'deveye-types';

import type SQL from '@/Services/SQL';
import type Encryption from '@/Services/Encryption';
import type { ClientSession } from '@/Interfaces/IClient';

interface TCPFeatureProps<T extends keyof RequestCommands> {
    db: SQL;
    crypt: Encryption;
    profile: ClientSession;
    data: TCPRequestSendHeader<T>['content'];
}

export type IFeature<T extends keyof RequestCommands> = (
    props: TCPFeatureProps<T>
) => Promise<TCPRequestReceiveHeader<T>['content']>;
