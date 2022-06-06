<?php

    declare(ticks = 1); // To ctrl + c to stop the script.

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
                        'local_cert' => __DIR__.'/certs/public.pem',
                        'local_pk' => __DIR__.'/certs/private.pem',
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
            readline('Press enter to exit...');
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

            set_error_handler('error_handler');
            $wait = stream_select($read, $write, $except, 0, 100000);
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
            $client->receive($data);
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
            if (!isset($this->clients[$uid])) {
                return;
            }
            $this->clients[$uid]->close();
            unset($this->clients[$uid]);
            echo("[$uid] Client disconnected\n");
        }
    }

?>