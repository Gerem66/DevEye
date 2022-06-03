<?php

    echo("Start...\n");

    // Create WebSocket.
    $ip = '0.0.0.0';
    $port = 8080;
    $addr = "tls://$ip:$port";
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
    $server = stream_socket_server($addr, $errno, $errstr, $flags, $context);
    if ($server === false) {
        echo("$errstr ($errno)\n");
        exit(1);
    }

    $config = stream_set_timeout($server, 10);
    if ($config === false) {
        echo("stream_set_timeout failed\n");
        exit(1);
    }

    // Accept WebSocket connection.
    $client = stream_socket_accept($server);
    if ($client === false) {
        echo("Accept failed\n");
        exit(1);
    }

    //$headers = stream_get_meta_data($client);
    $headers = fread($client, 8192);
    if ($headers === false) {
        echo("Read failed\n");
        exit(1);
    }

    $secWebSocketKey = preg_match('/Sec-WebSocket-Key: (.*)\r\n/', $headers, $matches) ? $matches[1] : false;
    if ($secWebSocketKey === false) {
        echo("Bad handshake\n");
        exit(1);
    }

    $secWebSocketAccept = sha1($secWebSocketKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    $secWebSocketAccept = pack('H*', $secWebSocketAccept);
    $secWebSocketAccept = base64_encode($secWebSocketAccept);
    $handshake = "HTTP/1.1 101 Switching Protocols\r\n" .
        "Upgrade: websocket\r\n" .
        "Connection: Upgrade\r\n" .
        "Sec-WebSocket-Accept: $secWebSocketAccept\r\n\r\n";
    $handshakeBytes = fwrite($client, $handshake);
    if ($handshakeBytes === false) {
        echo("Write handshake failed\n");
        exit(1);
    }

    echo("Connected\n");

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

    // Read WebSocket data.
    while (true) {
        echo("Waiting...\n");

        // Read and decrypt WebSocket data.
        $buffer = fread($client, 1024);
        if ($buffer === false) {
            echo("Read failed\n");
            break;
        }

        $data = unmask($buffer);
        if ($data === 'exit') {
            echo("Exit by client.\n");
            break;
        }
        echo("Received: $data\n");

        $resonse = mask("Hello, world!");
        $written = fwrite($client, $resonse);
        if ($written === false) {
            echo("Write failed\n");
            break;
        }
    }

    // Close WebSocket connection.
    $info = stream_get_meta_data($client);
    if ($info['timed_out']) {
        echo("Read timed out\n");
    }

    fclose($client);
    fclose($server);
    echo("End...\n");

?>