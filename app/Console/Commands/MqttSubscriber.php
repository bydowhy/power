<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Redis;
use PhpMqtt\Client\Facades\MQTT;

class MqttSubscriber extends Command
{
    /**
     * Execute the console command.
     */
    protected $signature = 'mqtt:subscribe';
    protected $description = 'Subscribe to EMQX and store data to Redis';

    public function handle()
    {
        $topic = env('MQTT_TOPIC', 'energy/meter');

        $this->info("Connecting to MQTT Broker...");

        // Ambil instance client dari package (TLS & auth otomatis dari .env)
        $mqtt = MQTT::connection();

        $this->info("Connected. Listening to topic: {$topic}");

        $mqtt->subscribe($topic, function (string $topic, string $message) {
            // 1. Tampilkan pesan mentah yang masuk
            $this->info("Message received: " . $message);

            $data = json_decode($message, true);

            // 2. Cek apakah JSON valid
            if (!$data) {
                $this->error("Failed to decode JSON!");
                return;
            }

            // 3. Cek apakah device_id ada
            if (!isset($data['device_id'])) {
                $this->error("Field 'device_id' not found in JSON!");
                return;
            }

            $meterId = $data['device_id'];
            $now = time();

            try {
                // Gunakan hmset untuk multiple field
                Redis::hmset("meter:{$meterId}:latest", [
                    'voltage'      => (string) ($data['voltage'] ?? 0),
                    'current'      => (string) ($data['current'] ?? 0),
                    'power_factor' => (string) ($data['power_factor'] ?? 0),
                    'total_power'  => (string) ($data['total_power'] ?? 0),
                    'total_energy' => (string) ($data['total_energy'] ?? 0),
                    'last_seen'    => (string) $now,
                ]);
                
                $this->info("✅ Success save to Redis for meter: {$meterId}");

                // 2. Simpan history 30 menit (Sorted Set)
                $historyKey = "meter:{$meterId}:history";
                Redis::zadd($historyKey, $now, $message);
                Redis::zremrangebyscore($historyKey, '-inf', $now - 1800);
                Redis::expire($historyKey, 1900);

            } catch (\Exception $e) {
                $this->error("❌ Failed to save to Redis: " . $e->getMessage());
            }

            // 2. Simpan history 30 menit (Sorted Set)
            $historyKey = "meter:{$meterId}:history";
            Redis::zadd($historyKey, $now, $message);

            // Hapus data lebih tua dari 30 menit (1800 detik)
            Redis::zremrangebyscore($historyKey, '-inf', $now - 1800);
            Redis::expire($historyKey, 1900); // safety TTL
        }, 0);

        // Jalankan event loop tanpa batas
        $mqtt->loop(true);
    }
}
