<?php

    class Client
    {
        public $UID = null;
        public $socket = null;
        public $isConnected = false;

        function __construct($socket, $UID) {
            $this->socket = $socket;
            $this->UID = $UID;
        }

        public function close() {
            if (!$this->isConnected) {
                return false;
            }
            $this->isConnected = false;
            return fclose($this->socket);
        }

        public function handshake() {
            $headers = fread($this->socket, 8192);
            if ($headers === false) {
                echo("Read failed\n");
                exit(1);
            }

            $secWebSocketKey = preg_match('/Sec-WebSocket-Key: (.*)\r\n/', $headers, $matches) ? $matches[1] : false;
            if ($secWebSocketKey === false) {
                return false;
            }

            $secWebSocketAccept = sha1($secWebSocketKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
            $secWebSocketAccept = pack('H*', $secWebSocketAccept);
            $secWebSocketAccept = base64_encode($secWebSocketAccept);
            $handshake = "HTTP/1.1 101 Switching Protocols\r\n" .
                "Upgrade: websocket\r\n" .
                "Connection: Upgrade\r\n" .
                "Sec-WebSocket-Accept: $secWebSocketAccept\r\n\r\n";
            $written = fwrite($this->socket, $handshake);
            if ($written !== false) {
                $this->isConnected = true;
            }
        }
    }

?>