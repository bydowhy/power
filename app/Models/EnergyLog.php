<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class EnergyLog extends Model
{
    protected $fillable = [
        'meter_id',
        'shift',
        'voltage',
        'current',
        'power_factor',
        'total_power',
        'total_energy',
        'logged_at',
    ];
}
