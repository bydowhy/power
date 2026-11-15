<?php

namespace App\Console\Commands;

use App\Models\EnergyLog;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Redis;

class LogShiftEnergy extends Command
{
    /**
     * Execute the console command.
     * 
     */
    protected $signature = 'shift:log {--shift=}';
    protected $description = 'Log total energy from Redis to MySQL every shift change';

    public function handle()
    {
        $currentHour = (int) Carbon::now()->format('H');
        $shift = $this->option('shift');

        if (!$shift) {
            if ($currentHour == 7) $shift = 'Morning';
            elseif ($currentHour == 15) $shift = 'Afternoon';
            elseif ($currentHour == 23) $shift = 'Night';
            else {
                $this->error("Not a shift change time (07, 15, 23). Use --shift=Morning for testing.");
                return;
            }
        }

        $this->info("Processing log for Shift: {$shift}");

        $count = 0;
        
        $allKeys = (array) Redis::keys('*');  

        foreach ($allKeys as $fullKey) {
            if (preg_match('/meter:([a-zA-Z0-9_]+):latest/', $fullKey, $matches)) {
                $meterId = $matches[1]; 
                
                $cleanKey = "meter:{$meterId}:latest";
                
                $data = Redis::hgetall($cleanKey);

                if (!empty($data)) {
                    $exists = EnergyLog::where('meter_id', $meterId)
                        ->where('shift', $shift)
                        ->whereDate('logged_at', Carbon::today())
                        ->exists();

                    if (!$exists) {
                        EnergyLog::create([
                            'meter_id'     => $meterId,
                            'shift'        => $shift,
                            'voltage'      => $data['voltage'] ?? 0,
                            'current'      => $data['current'] ?? 0,
                            'power_factor' => $data['power_factor'] ?? 0,
                            'total_power'  => $data['total_power'] ?? 0,
                            'total_energy' => $data['total_energy'] ?? 0,
                            'logged_at'    => Carbon::now(),
                        ]);
                        $count++;
                        $this->info("✅ Logged data for meter: {$meterId}");
                    } else {
                        $this->warn("ℹ️ Data {$meterId} has already been logged for today.");
                    }
                } else {
                    $this->error("❌ Data is empty for key: {$cleanKey}");
                }
            }
        }

        $this->info("====================================");
        $this->info("✅ Successfully logged {$count} meter data for Shift {$shift}.");
    }
}
