<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    if (isset($post['code'])) {
        $code = $post['code'];
        $output = array(
            'status' => 'error',
            'result' => 'empty'
        );

        if ($user->Level >= 2) {
            //$result = eval($code);
            $result = eval($code);
            if ($result === null) {
                $output['result'] = 'Failed to execute the code';
            } else {
                $output['result'] = $result;
                $output['status'] = 'ok';
            }
        }

        $output = json_encode($output);
        echo($output);
        exit();
    }

    $variables = array(
        'username' => $user->Username
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>