<?php
$config = [
    'admin' => [
        'core:AdminPassword',
    ],
    'example-userpass' => [
        'exampleauth:UserPass',
        'admin:password' => [
            'uid' => ['admin'],
            'email' => ['admin@example.com'],
            'givenName' => ['Admin'],
            'sn' => ['User'],
            'displayName' => ['Admin User'],
        ],
        'user:password' => [
            'uid' => ['user'],
            'email' => ['user@example.com'],
            'givenName' => ['Test'],
            'sn' => ['User'],
            'displayName' => ['Test User'],
        ],
    ],
];
