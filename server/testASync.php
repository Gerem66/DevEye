<?php

    declare(ticks = 1);         // To ctrl + c to stop the script.
    error_reporting(E_ERROR);   // To hide timeout warnings
    set_time_limit(0);          // disable timeout
    ob_implicit_flush();        // disable output caching 

    function mask($text) {
        $b1 = 0x80 | (0x1 & 0x0f);
        $length = strlen($text);
        if($length <= 125) {
            $header = pack('CC', $b1, $length);
        } else if ($length > 125 && $length < 65536) {
            $header = pack('CCn', $b1, 126, $length);
        } else if ($length >= 65536) {
            $header = pack('CCNN', $b1, 127, $length);
        }
        return $header.$text;
    }

    function unmask($text) {
        $length = @ord($text[1]) & 127;
        if ($length === 126) {
            $masks = substr($text, 4, 4);
            $data = substr($text, 8);
        } else if ($length === 127) {
            $masks = substr($text, 10, 4);
            $data = substr($text, 14);
        } else {
            $masks = substr($text, 2, 4);
            $data = substr($text, 6);
        }

        $text = "";
        for ($i = 0; $i < strlen($data); ++$i) {
            $text .= $data[$i] ^ $masks[$i % 4];
        }
        return $text;
    }

    class WSS
    {
        /** @var resource $server */
        private $server;

        /** @var Client[] $clients */
        private $clients = array();

        /** @var bool $isRunning */
        private $isRunning = false;

        function __construct($ip = '0.0.0.0', $port = 8080, $protocol = 'tls') {
            $addr = "$protocol://$ip:$port";
            $errno = 0;
            $errstr = '';
            $flags = STREAM_SERVER_BIND | STREAM_SERVER_LISTEN;
            $context = stream_context_create(
                array(
                    'ssl' => array(
                        'local_cert' => 'public.pem',
                        'local_pk' => 'private.pem',
                        'allow_self_signed' => true,
                        'verify_peer' => false,
                        'verify_peer_name' => false
                    )
                )
            );

            $this->server = stream_socket_server($addr, $errno, $errstr, $flags, $context);
            if ($this->server === false) {
                echo("$errstr ($errno)\n");
                exit(1);
            }
        }

        private function close() {
            if (!$this->isRunning) {
                return false;
            }
            $this->isRunning = false;
            return true;
        }

        public function run() {
            if ($this->isRunning) {
                return;
            }
            pcntl_signal(SIGINT, array(&$this, "close"));

            echo("WSS server started\n");
            $this->isRunning = true;
            while ($this->isRunning) {
                $this->checkNewClients();
                $this->removeDeadClients();
                $this->checkNewMessages();
            }

            echo("\nClosing...\n");
            foreach ($this->clients as $client) {
                $this->removeClient($client->UID);
            }
            fclose($this->server);
            echo("WSS server stopped\n");
        }

        private function checkNewClients() {
            $socket = stream_socket_accept($this->server, 0.1);
            if ($socket === false) {
                return;
            }

            // Define unique id
            while (isset($this->clients[$uid = uniqid()])) usleep(100);
            $newClient = new Client($socket, $uid);
            $newClient->handshake();

            if (!$newClient->isConnected) {
                echo("Bad handshake\n");
                $this->removeClient($newClient->UID);
                return;
            }

            $this->clients[$uid] = $newClient;
            echo("[$uid] New client connected\n");
        }

        private function checkNewMessages() {
            $read = $this->getClientsSocket();
            if (count($read) === 0) return;

            $write = array();
            $except = array();
            $wait = stream_select($read, $write, $except, 0, 100000);
            if ($wait === false) {
                // Select failed
                return;
            } else if ($wait === 0) {
                // Timeout
                return;
            }


            foreach ($read as $socket) {
                $client = $this->getClientBySocket($socket);
                $this->readMessage($client);
            }
        }

        private function readMessage($client) {
            $buffer = fread($client->socket, 1024);
            if ($buffer === false) {
                echo("Read failed\n");
                return;
            }

            $data = unmask($buffer);
            if ($data === 'exit') {
                $this->removeClient($client->UID);
                return;
            }
            echo("[{$client->UID}] $data\n");

            $resonse = mask("Hello, world!");
            $written = fwrite($client->socket, $resonse);
            if ($written === false) {
                echo("Write failed\n");
                return;
            }
        }

        private function getClientsSocket() {
            $sockets = array();
            foreach ($this->clients as $client) {
                $sockets[] = $client->socket;
            }
            return $sockets;
        }
        private function getClientBySocket($socket) {
            foreach ($this->clients as $client) {
                if ($client->socket === $socket) {
                    return $client;
                }
            }
            return null;
        }
        private function removeDeadClients() {
            foreach ($this->clients as $uid => $client) {
                if (!$client->isConnected) {
                    $this->removeClient($uid);
                }
            }
        }

        private function removeClient($uid) {
            $this->clients[$uid]->close();
            unset($this->clients[$uid]);
            echo("[$uid] Client disconnected\n");
        }
    }

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

    $wss = new WSS();
    $wss->run();

?>