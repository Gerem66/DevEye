<?php

    class Client
    {
        /** @var int $UID */
        public $UID;

        /** @var resource $socket */
        public $socket;

        /** @var WSS $wss */
        private $wss = null;

        /**
         * Database user.
         * @var User|null $user
         */
        private $user = null;

        /**
         * Used to store multiple messages before interpreting them.
         * @var array|null $tempMessage
         */
        private $tempMessage = null;

        /**
         * Last page loaded.
         * @var string|null $currentPage
         */
        private $currentPage = null;

        /**
         * Category of last page loaded.
         * @var string|null $currentCategory
         */
        private $currentCategory = null;

        /**
         * Function of last feature loaded.
         * To be used to do some actions in current page.
         * @var function|null $action
         */
        private $action = null;

        /**
         * @param int $UID
         * @param resource $socket
         * @param function $server
         */
        function __construct($UID, $socket, $server) {
            $this->UID = $UID;
            $this->socket = $socket;
            $this->wss = $server;
        }

        public function close() {
            if (!$this->socket) {
                return false;
            }
            return fclose($this->socket);
        }

        public function handshake() {
            $headers = fread($this->socket, 8192);
            if ($headers === false) {
                $this->wss->DebugMessage(1, "[ERR] Handshake: Read failed");
                return false;
            }

            $secWebSocketKey = preg_match('/Sec-WebSocket-Key: (.*)\r\n/', $headers, $matches) ? $matches[1] : false;
            if ($secWebSocketKey === false) {
                $this->wss->DebugMessage(1, "[ERR] Handshake: No Sec-WebSocket-Key");
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
            if ($written) {
                return true;
            }
        }

        public function receive($message) {
            global $db;

            $data = json_decode($message, true);
            if ($data === null) return false;

            $multipleMsgState = $this->checkMultipleMessage($data);
            if ($multipleMsgState !== null) {
                return $multipleMsgState;
            }

            if (!key_exists('type', $data)) {
                return false;
            }

            $type = $data['type'];
            switch ($type) {
                case 'connect': $this->connect($db, $data); break;
                case 'disconnect': $this->disconnect(); break;
                case 'loadScripts': $this->loadScripts(); break;
                case 'loadStyles': $this->loadStyles(); break;
                case 'loadBody': $this->loadBody($db); break;
                case 'loadPage': $this->loadPage($data); break;
                case 'callAction': $this->callAction($db, $data['action']); break;

                default: return false;
            }

            return true;
        }

        /**
         * @param string $message
         * @return bool True if the message has been sent, false otherwise
         */
        public function send($message) {
            $message = frameEncode($message);

            if ($message === false) {
                $this->wss->DebugMessage(1, '[ERR] Mask failed, message skipped');
                return false;
            }

            $written = fwrite($this->socket, $message);
            if ($written === false) {
                $this->wss->DebugMessage(1, "[ERR] Write failed, message skipped");
                return false;
            }

            return true;
        }

        private function connect($db, $data) {
            $username = $data['username'];
            $password = $data['password'];
            if (!isset($username, $password)) {
                $this->send('error');
                return false;
            }

            $hashedPassword = $db->encryption->HashPassword($password);
            $rawUser = $db->GetRowContent('Users', 'Username', $username);
            $user = User::Load($rawUser, $hashedPassword);

            if ($user === null) {
                $db->AddLog(0, 'login', "User connection failed - User \"$username\" not found");
                $this->send('error');
                return false;
            }
    
            if (!password_verify($password, $user->Password)) {
                $db->AddLog($user->ID, 'login', 'User connection failed - wrong password');
                $this->send('error');
                return false;
            }
    
            $db->AddLog($user->ID, 'login', 'User connection successfully.');
            $this->user = $user;
            $this->send('ok');
            $this->wss->DebugMessage(3, "[{$this->UID}] Authentified");
        }

        private function disconnect() {
            unset($this->user);
            $this->user = null;
            $this->wss->DebugMessage(3, "[{$this->UID}] Disconnected");
        }

        private function loadScripts() {
            $root = __DIR__.'/../../..';
            $scriptsIgnore = array(
                'deveye',
                'wss',
                'login',
                'functions',
                'main'
            );
            $content = GetScriptsFiles("$root/dist/js/", 'js', $scriptsIgnore);
            $content .= GetScriptsFiles("$root/features/", 'js');
            $this->send($content);
        }

        private function loadStyles() {
            $root = __DIR__.'/../../..';
            $styleIgnore = array(
                'login',
                'icons',
                'fonts',
                'inputs',
                'loading'
            );
            $content = GetScriptsFiles("$root/dist/css/", 'css', $styleIgnore);
            $content .= GetScriptsFiles("$root/features/", 'css');
            $this->send($content);
        }

        private function loadBody($db) {
            // Load sidebar
            $sidebar = GenerateSidebar($db, $this->user);
        
            // Load default page
            if (array_key_exists('default', $this->user->Settings) && $this->user->Settings['default'] !== 'user') {
                $rawFeature = $db->GetRowContent('Features', 'ID', $this->user->Settings['default']);
                $feature = Feature::Load($rawFeature);
                $correctLevel = $feature->Level <= $this->user->Level;
                $enabled = $feature->EnabledDefault;
                if (array_key_exists($feature->ID, $this->user->Settings)) {
                    $enabled = $this->user->Settings[$feature->ID];
                }
                if ($feature !== null && $correctLevel && $enabled) {
                    // <script>page.defaultPage = '{$feature->Redirect}'</script>
                }
            }
            $variables = array(
                'version' => $GLOBALS['VERSION'],
                'avatar' => $this->user->Avatar,
                'username' => $this->user->Username,
                'sidebar' => $sidebar
            );
            $content = ImportHTML(__DIR__.'/../../html/home.html', $variables);
            $this->send($content);
        }

        private function loadPage($data) {
            $page = $data['page'];
            $category = $data['category'];
            $dirIndex = __DIR__."/../../../features/$page/index.php";

            if (!file_exists($dirIndex)) {
                $this->send('error');
                return false;
            }

            $this->currentPage = $page;
            $this->currentCategory = $category;

            // Features variables
            global $db, $features;
            $user = $this->user;
            $content = include($dirIndex);
            $this->send($content);

            if (isset($action)) {
                $this->action = $action;
            }
        }

        private function callAction($db, $actionData) {
            if ($this->action === null) {
                return;
            }
            if ($this->user === null || $this->currentPage === null) {
                return;
            }
            if (!array_key_exists('type', $actionData)) {
                return;
            }

            $type = $actionData['type'];
            $args = $actionData['args'] ?? null;
            if (!isset($type)) return;

            $response = ($this->action)($db, $this->user, $type, $args);
            $this->send($response);
        }

        private function checkMultipleMessage(&$data) {
            // Initialisation of "multiple message"
            if (key_exists('multiple', $data)) {
                if (gettype($data['multiple']) !== 'integer' || $data['multiple'] < 1) {
                    return false;
                }
                if ($this->tempMessage !== null) {
                    $this->wss->DebugMessage(2, "[WARN] Receive: Multiple messages already received, discarding previous messages");
                }

                $this->tempMessage = $data;
                $this->tempMessage['part'] = 0;
                // tempMessage['multiple'] is the index of last parts (already in array)
                $this->send('ok');
                return true;
            }

            // "multiple message" is initialized but error occured,
            // We need to clean it and ignore other messages
            if ($this->tempMessage !== null && $this->tempMessage['part'] === -1) {
                if (key_exists('part', $data)) {
                    // Skip all parts of this corrupted message
                    return true; // True because error is already sent
                } else {
                    // New message received, reset tempMessage
                    $this->tempMessage = null;
                }
            }

            // "multiple message" is initialized
            // We append current message to it or finish it
            if ($this->tempMessage !== null) {
                if (!key_exists('part', $data)) {
                    $this->wss->DebugMessage(2, "[WARN] Receive: Multiple messages not complete, discarding previous messages");
                    $this->tempMessage = null;
                    // Continue interpreting message
                } else if ($data['part'] !== $this->tempMessage['part'] + 1) {
                    $this->tempMessage['part'] = -1;
                    $this->wss->DebugMessage(2, "[WARN] Receive: Multiple messages part was lost, discarding previous messages");
                    return true; // Return true because error is already sent
                } else {
                    array_concatenate($this->tempMessage, $data);
                    if ($this->tempMessage['part'] !== $this->tempMessage['multiple']) {
                        $this->send('ok'); // Confirm message received
                        return true; // Is not the last part
                    }
                    $data = $this->tempMessage;
                    $this->tempMessage = null;
                    // Continue interpreting all of "multiple message"
                }
            }

            return null;
        }
    }

?>