<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('energy_logs', function (Blueprint $table) {
			$table->id();
			$table->string('meter_id');
			$table->string('shift'); // Pagi, Sore, Malam
			$table->decimal('voltage', 8, 2)->nullable();
			$table->decimal('current', 8, 2)->nullable();
			$table->decimal('power_factor', 5, 2)->nullable();
			$table->decimal('total_power', 10, 2)->nullable();
			$table->decimal('total_energy', 15, 2)->nullable();
			$table->timestamp('logged_at');
			$table->timestamps();
		});
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('energy_logs');
    }
};
