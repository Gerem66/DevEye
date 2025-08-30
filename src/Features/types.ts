import type SQL from '../Services/SQL';
import type Encryption from '../Services/Encryption';
import type { ProfileType } from '../Server';
import type { RequestClientToServer } from 'deveye-types';
import type { RequestServerToClient } from 'deveye-types';

import type { TCPRequestSendHeader } from 'deveye-types';
import type { TCPRequestReceiveHeader } from 'deveye-types';

export type { TCPRequestSendHeader } from 'deveye-types';
export type { TCPRequestReceiveHeader } from 'deveye-types';

export type RequestTypes = keyof RequestClientToServer & keyof RequestServerToClient;

export interface TCPFeatureProps<T extends RequestTypes> {
    db: SQL;
    crypt: Encryption;
    profile: ProfileType;
    data: TCPRequestSendHeader<T>['content'];
}

export type TCPFeatureType<T extends RequestTypes> = (
    props: TCPFeatureProps<T>
) => Promise<TCPRequestReceiveHeader<T>['content']>;

export default null;
