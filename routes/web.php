<?php

use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'Welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::inertia('dashboard', 'Dashboard')->name('dashboard');
});

Route::get('/api/meter/{id}/history', function ($id) {
    $key = "meter:{$id}:history";
    $now = time();
    
    // Get the data from the last 30 minutes (1800 seconds)
    $rawData = Redis::zrangebyscore($key, $now - 1800, $now);
    
    $history = [];
    foreach ($rawData as $jsonString) {
        $parsed = json_decode($jsonString, true);
        if ($parsed && isset($parsed['timestamp'], $parsed['total_power'])) {
            $history[] = [
                'time' => date('H:i:s', (int)($parsed['timestamp'] / 1000)), // Node-RED uses milliseconds
                'power' => $parsed['total_power'],
                'voltage' => $parsed['voltage'],
            ];
        }
    }
    
    return response()->json($history);
})->middleware(['auth']);

require __DIR__.'/settings.php';
