<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('shift:log')->dailyAt('07:40')->timezone('Asia/Jakarta');
Schedule::command('shift:log')->dailyAt('15:00')->timezone('Asia/Jakarta');
Schedule::command('shift:log')->dailyAt('23:00')->timezone('Asia/Jakarta');

Schedule::call(function () {
    \App\Models\EnergyLog::where('logged_at', '<', now()->subMonths(6))->delete();
})->dailyAt('00:00')->timezone('Asia/Jakarta');