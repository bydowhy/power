<?php

namespace App\Events;

use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class PowerMeterUpdated implements ShouldBroadcastNow
{
    use Dispatchable, InteractsWithSockets, SerializesModels;
    public $meters;
    /**
     * Create a new event instance.
     */
    public function __construct($meters)
    {
        $this->meters = $meters;
    }
    
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('power-monitoring'),
        ];
    }

    public function broadcastAs()
    {
        return 'power.updated';
    }
}
