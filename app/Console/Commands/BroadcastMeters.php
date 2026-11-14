<?php

namespace App\Console\Commands;

use App\Events\PowerMeterUpdated;
use Illuminate\Console\Command;

class BroadcastMeters extends Command
{
    /**
     * Execute the console command.
     */
    protected $signature = 'meters:broadcast';
    protected $description = 'Broadcast latest meter data from Redis to Frontend every 3 seconds';
    
    public function handle()
    {
        $this->info("Starting broadcast data meter to Reverb...");
        $meterIds = [
            'sensor_sim_01', 
            'sensor_sim_02', 
            'sensor_sim_03', 
            'sensor_sim_04', 
            'sensor_sim_05',
            'sensor_sim_06',
            'sensor_sim_07',
            'sensor_sim_08',
            'sensor_sim_09',
            'sensor_sim_10',
            'sensor_sim_11',
            'sensor_sim_12',
            'sensor_sim_13',
            'sensor_sim_14',
            'sensor_sim_15',
            'sensor_sim_16',
            'sensor_sim_17',
            'sensor_sim_18',
            'sensor_sim_19',
            'sensor_sim_20',
            'sensor_sim_21',
            'sensor_sim_22',
            'sensor_sim_23',
            'sensor_sim_24',
            'sensor_sim_25',
            'sensor_sim_26',
            'sensor_sim_27',
            'sensor_sim_28',
            'sensor_sim_29',
            'sensor_sim_30',
        ];

        while (true) {
            $metersData = [];

            foreach ($meterIds as $meterId) {
                $key = "meter:{$meterId}:latest";
                
                $data = \Illuminate\Support\Facades\Redis::hgetall($key);

                if (!empty($data)) {
                    $metersData[$meterId] = [
                        'voltage'      => (float) $data['voltage'],
                        'current'      => (float) $data['current'],
                        'power_factor' => (float) $data['power_factor'],
                        'total_power'  => (float) $data['total_power'],
                        'total_energy' => (float) $data['total_energy'],
                        'last_seen'    => (int) $data['last_seen'],
                    ];
                }
            }

            if (!empty($metersData)) {
                $this->info("Sending data to Reverb: " . json_encode(array_keys($metersData)));
                
                try {
                    broadcast(new PowerMeterUpdated($metersData));
                    $this->info("✅ Success broadcasting to Reverb");
                } catch (\Throwable $e) {
                    $this->error("❌ Failed to broadcast to Reverb: " . $e->getMessage());
                }
            }

            sleep(3);
        }
    }
}
