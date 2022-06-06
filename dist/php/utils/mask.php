<?php

    function mask($text) {
        $b1 = 0x80 | (0x1 & 0x0f);
        $length = strlen($text);
        if($length <= 125) {
            $header = pack('CC', $b1, $length);
        } else if ($length > 125 && $length < 65536) {
            $header = pack('CCn', $b1, 126, $length);
        } else if ($length >= 65536) {
            // Does not support more than 2^16 bytes
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

    /**
     * @copyright https://github.com/richardfullmer/php-websocket/blob/master/WebSocket/Client.php
     */
    function encodeFrame($payload, $type = 'text', $masked = true) {
        $frameHead = array();
        $frame = '';
        $payloadLength = strlen($payload);

        switch($type)
        {
            case 'ping': // First byte indicates FIN, Ping frame (10001001)
                $frameHead[0] = 137;
                break;

            case 'pong': // First byte indicates FIN, Pong frame (10001010)
                $frameHead[0] = 138;
                break;

            case 'text': // First byte indicates FIN, Text-Frame (10000001)
                $frameHead[0] = 129;
                break;

            case 'close':
                break;
        }

        // Set mask and payload length (using 1, 3 or 9 bytes)
        if($payloadLength > 65535) {
            $payloadLengthBin = str_split(sprintf('%064b', $payloadLength), 8);
            $frameHead[1] = ($masked === true) ? 255 : 127;
            for ($i = 0; $i < 8; $i++) {
                $frameHead[$i+2] = bindec($payloadLengthBin[$i]);
            }

            // Most significant bit MUST be 0 (return false if to much data)
            if($frameHead[2] > 127) {
                return false;
            }
        } else if ($payloadLength > 125) {
            $payloadLengthBin = str_split(sprintf('%016b', $payloadLength), 8);
            $frameHead[1] = ($masked === true) ? 254 : 126;
            $frameHead[2] = bindec($payloadLengthBin[0]);
            $frameHead[3] = bindec($payloadLengthBin[1]);
        } else {
            $frameHead[1] = ($masked === true) ? $payloadLength + 128 : $payloadLength;
        }

        // Convert frame-head to string
        foreach(array_keys($frameHead) as $i) {
            $frameHead[$i] = chr($frameHead[$i]);
        }
        if ($masked === true) {
            // Generate a random mask
            $mask = array();
            for($i = 0; $i < 4; $i++) {
                $mask[$i] = chr(rand(0, 255));
            }
            $frameHead = array_merge($frameHead, $mask);
        }

        // Append payload to frame
        $frame = implode('', $frameHead);
        if ($masked === true) {
            for ($i = 0; $i < $payloadLength; $i++) {
                $frame .= $payload[$i] ^ $mask[$i % 4];
            }
        } else {
            $frame .= $payload;
        }

        return $frame;
    }

    function error_handler($errno, $errtxt) {
        $useless = [ 'timed out', 'Interrupted system call' ];
        foreach ($useless as $useless_txt) {
            if (strpos($errtxt, $useless_txt) !== false) {
                return;
            }
        }
        print_r($errtxt);
        echo("\n");
    }

?>