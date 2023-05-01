<?php

    declare(ticks = 1); // To ctrl + c to stop the script.

    require(__DIR__.'/client.php');
    require(__DIR__.'/config.php');

    class WSS
    {
        /** @var resource $server */
        private $server;

        /** @var Client[] $clients */
        private $clients = array();

        /**
         * If the server is running.
         * @var bool $isRunning
         */
        private $isRunning = false;

        private $attempsIPs = array();

        function __construct($ip = '0.0.0.0', $port = 8080, $protocol = 'tls') {
            $addr = "$protocol://$ip:$port";
            $errno = 0;
            $errstr = '';
            $flags = STREAM_SERVER_BIND | STREAM_SERVER_LISTEN;
            $context = stream_context_create(
                array(
                    'ssl' => array(
                        'local_cert' => __DIR__.'/certs/public.pem',
                        'local_pk' => __DIR__.'/certs/private.pem',
                        'allow_self_signed' => true,
                        'verify_peer' => false,
                        'verify_peer_name' => false
                    )
                )
            );

            $this->attempsIPs = array();
            $this->server = stream_socket_server($addr, $errno, $errstr, $flags, $context);
            if ($this->server === false) {
                throw new Exception("Failed to create server socket: $errstr ($errno)");
            }

            if (WSSConfig::$isDebug >= 3) {
                $this->DebugMessage(3, '[WARN] Debug messages are enabled. All requests will be displayed in clear text, including user passwords.');
            }
            //stream_socket_enable_crypto($this->server, true, STREAM_CRYPTO_METHOD_TLS_SERVER);
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

            $this->DebugMessage(2, "[INFO] WSS server started");
            $this->isRunning = true;
            while ($this->isRunning) {
                $this->checkNewClients();
                $this->checkNewMessages();
                $this->removeDeadClients();
            }

            $this->DebugMessage(2, "\nClosing...");
            foreach ($this->clients as $client) {
                $this->removeClient($client->UID);
            }
            fclose($this->server);
            $this->DebugMessage(2, "WSS server stopped");
        }

        private function checkNewClients() {
            set_error_handler('error_handler');
            $socket = stream_socket_accept($this->server, 0.1);
            restore_error_handler();

            if ($socket === false) {
                return;
            }

            // Define unique id
            while (isset($this->clients[$uid = uniqid()])) usleep(100);
            $newClient = new Client($uid, $socket, $this);
            $handChecked = $newClient->handshake();

            if (!$handChecked) {
                $this->DebugMessage(2, "[WARN] Bad handshake, client disconnected");
                return;
            }

            if (WSSConfig::$maxClients > 0 && count($this->clients) >= WSSConfig::$maxClients) {
                $newClient->send(json_encode(array('type' => 'error', 'message' => 'Server is full')));
                $newClient->close();
                $this->DebugMessage(2, "[WARN] Client rejected, server is full");
                return;
            }

            $this->clients[$uid] = $newClient;
            $this->DebugMessage(3, "[$uid] New client connected");
        }

        /**
         * @param int $level
         * @param string $message
         */
        public function DebugMessage($level, $message) {
            if (WSSConfig::$isDebug === 0 || WSSConfig::$isDebug < $level) {
                return;
            }
            $now = date("y-m-d H:i:s");
            echo("[$now] $message\n");
        }

        private function checkNewMessages() {
            $read = $this->getSocketsClients();
            if (count($read) === 0) return;

            $write = array();
            $except = array();

            set_error_handler('error_handler');
            $wait = stream_select($read, $write, $except, 0, 10000);
            restore_error_handler();

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

        /**
         * @param Client $client
         */
        private function readMessage($client) {
            $t1 = microtime(true);
            $buffer = fread($client->socket, 8192);
            if ($buffer === false) {
                $this->DebugMessage(1, "[ERR] Read failed, message skipped");
                return;
            }

            $headers = array();
            $data = frameDecode($buffer, $headers);

            if ($data === null) {
                $this->DebugMessage(1, "[ERR] Bad frame, message skipped ({$client->UID})");
                $now = microtime(true);
                if ($client->lastBadFrame === 0) {
                    $client->lastBadFrame = microtime(true);
                } else if (($now - $client->lastBadFrame) * 1000 > 100) { // Less than 100ms
                    $this->DebugMessage(1, "[WARN] Too bad frame, client disconnecting ({$client->UID})");
                    $client->close();
                }
                return;
            }

            $dataObject = json_decode($data ?? '', true);
            if ($data === 'exit' || $dataObject === null) {
                $this->removeClient($client->UID);
                return;
            }

            $now = time();
            $UIP = $client->user !== null ? $client->user->IP : null;
            if ($UIP !== null && key_exists($UIP, $this->attempsIPs)) {
                // Remove old attempts
                $this->attempsIPs[$UIP] = array_filter($this->attempsIPs[$UIP], function ($time) use ($now) {
                    return ($now - $time) < 60;
                });

                // Check attempts
                if (count($this->attempsIPs[$UIP]) > WSSConfig::$maxAttemptsPerMinute) {
                    $this->DebugMessage(1, "[WARN] Too many failed attempts, client disconnecting ({$client->UID})");
                    $client->close();
                    return;
                }
            }

            $received = $client->receive($dataObject);

            if ($received === 'error') {
                $this->DebugMessage(1, "[ERR] Bad message, message skipped ({$client->UID} - {$data})");
                return;
            } else

            if ($received === 'connectionFailed') {
                $this->DebugMessage(1, "[{$client->UID}] Authentification failed");

                $UIP = $client->user->IP;
                if (!key_exists($UIP, $this->attempsIPs)) {
                    $this->attempsIPs[$UIP] = array();
                }
                array_push($this->attempsIPs[$UIP], $now);
            }

            $t2 = microtime(true);
            $tt = round(($t2 - $t1) * 1000, 2);
            $this->DebugMessage(3, "[{$client->UID}] $data ($tt ms)");
        }



        private function getSocketsClients() {
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
                $isntResource = gettype($client->socket) !== 'resource';
                $isntAlive = $client->socket === null || gettype($client->socket) === 'resource (closed)';
                if ($isntResource || $isntAlive) {
                    $this->removeClient($uid);
                }
            }
        }
        private function removeClient($UID) {
            if (!isset($this->clients[$UID])) {
                return;
            }
            $this->clients[$UID]->close();
            unset($this->clients[$UID]);
            $this->DebugMessage(3, "[$UID] Client disconnected");
        }
    }

?>