<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import { ref, onMounted, onUnmounted } from 'vue';
import { Line } from 'vue-chartjs';
import { usePowerMqtt } from '@/composables/usePowerMqtt';
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  CategoryScale
} from 'chart.js';

ChartJS.register(Title, Tooltip, Legend, LineElement, LinearScale, PointElement, CategoryScale);

const definedMeters = [
    'HA00', 'HB00', 'AA21103', 'AA21302', 'AA21401', 'AA21402', 'AA11202', 'AA11402',
    'OCCSP1', 'ONPSP1', 'DRIVEPM1', 'APFPM1', 'UTILITYPM1', 'BOILER1', 'BOILER2', 'BOILER3',
    'WWT', 'CONVERTING'
];

const { meters } = usePowerMqtt();
const isClient = ref(false);

// Modal State
const selectedMeterId = ref<string | null>(null);
const chartData = ref<any>(null);
const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: { legend: { display: false } },
    scales: {
        x: { display: true, grid: { display: false } },
        y: { display: true }
    }
};

// --- Realtime Clock ---
const currentTime = ref(new Date());
let clockInterval: any;

// --- Online Check Function ---
const checkOnline = (lastSeen: number) => {
    const now = Math.floor(Date.now() / 1000);
    return (now - lastSeen) < 60;
};

// --- Open Detail Function ---
const openDetail = async (meterId: string) => {
    selectedMeterId.value = meterId;
    chartData.value = null;

    try {
        const response = await fetch(`/api/meter/${meterId}/history`);
        const data = await response.json();
        
        chartData.value = {
            labels: data.map((d: any) => d.time),
            datasets: [
                {
                    label: 'Total Power (kW)',
                    backgroundColor: '#3b82f6',
                    borderColor: '#3b82f6',
                    data: data.map((d: any) => d.power),
                    tension: 0.3,
                    pointRadius: 0,
                }
            ]
        };
    } catch (e) {
        console.error("Failed to fetch history", e);
    }
};

onMounted(() => {
    isClient.value = true;

    clockInterval = setInterval(() => {
        currentTime.value = new Date();
    }, 1000);
});

onUnmounted(() => {
    if (clockInterval) clearInterval(clockInterval);
});
</script>

<template>
    <Head title="Monitor" />

    <div
        class="flex h-full flex-1 flex-col gap-4 overflow-x-auto rounded-xl p-4">
        <div class="p-6 min-h-screen w-full rounded-xl pb-20">
            <div v-if="isClient && Object.keys(meters).length === 0" class="text-gray-500 flex items-center gap-2">
                <span class="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></span>
                Waiting for data from MQTT...
            </div>

            <!-- Grid Card -->
            <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                <div 
                    v-for="(data, meterId) in meters" 
                    :key="meterId" 
                    @click="openDetail(meterId)"
                    class="bg-white p-4 rounded-xl shadow-sm border border-gray-200 hover:shadow-md hover:border-blue-400 cursor-pointer transition-all relative overflow-hidden"
                    :class="{ 'opacity-60 grayscale-50 bg-gray-50': !checkOnline(data.last_seen) }">
                    <!-- Online Indicator -->
                    <div class="flex justify-between items-start mb-2">
                        <h2 class="font-bold text-md text-gray-700 truncate mr-2">{{ meterId }}</h2>
                        
                        <div v-if="checkOnline(data.last_seen)" class="flex items-center gap-1.5 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                            <span class="relative flex h-2 w-2">
                              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                              <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                            </span>
                            <span class="text-[10px] font-semibold text-green-700 uppercase tracking-wider">Online</span>
                        </div>
                        <div v-else class="flex items-center gap-1.5 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                            <span class="h-2 w-2 rounded-full bg-red-500"></span>
                            <span class="text-[10px] font-semibold text-red-700 uppercase tracking-wider">Offline</span>
                        </div>
                    </div>

                    <div class="flex flex-col">
                        <span class="text-sm text-gray-500">Total Energy</span>
                        <!-- Offline Status Logic -->
                        <span 
                            class="font-mono text-xl font-bold transition-colors duration-300"
                            :class="checkOnline(data.last_seen) ? 'text-green-600' : 'text-gray-400'"
                        >
                            {{ checkOnline(data.last_seen) ? data.total_energy : '0.00' }} 
                            <span class="text-sm">kWh</span>
                        </span>
                    </div>
                </div>
            </div>

            <!-- Real-time Clock -->
            <div class="flex mt-6 items-center gap-2 dark:text-gray-300 py-1.5 rounded-full">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span class="font-mono font-bold tracking-wide">
                    {{ currentTime.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }) }}, 
                    {{ currentTime.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':') }}
                </span>
            </div>
        </div>
    </div>

    <div v-if="selectedMeterId" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-3xl overflow-hidden flex flex-col">
            <!-- Header Modal -->
            <div class="flex justify-between items-center p-4 border-b bg-gray-50">
                <h3 class="text-lg font-bold text-gray-800">
                    Detail: {{ selectedMeterId }} 
                    <span v-if="meters[selectedMeterId] && !checkOnline(meters[selectedMeterId].last_seen)" class="ml-2 text-sm text-red-500 font-normal">(Offline)</span>
                </h3>
                <button @click="selectedMeterId = null" class="text-gray-500 hover:text-red-500 font-bold text-xl">&times;</button>
            </div>

            <!-- Body Modal -->
            <div class="p-6 flex flex-col md:flex-row gap-6">
                <!-- Kolom Kiri: Nilai Realtime -->
                <div class="w-full md:w-1/3 space-y-4">
                    <div class="bg-blue-50 p-3 rounded-lg border border-blue-100">
                        <p class="text-xs text-blue-500 uppercase font-semibold">Voltage</p>
                        <p class="font-mono text-slate-600 text-lg">
                            {{ meters[selectedMeterId] && checkOnline(meters[selectedMeterId].last_seen) ? `${meters[selectedMeterId].voltage} V` : '0 V' }}
                        </p>
                    </div>
                    <div class="bg-blue-50 p-3 rounded-lg border border-blue-100">
                        <p class="text-xs text-blue-500 uppercase font-semibold">Current</p>
                        <p class="font-mono text-slate-600 text-lg">
                            {{ meters[selectedMeterId] && checkOnline(meters[selectedMeterId].last_seen) ? `${meters[selectedMeterId].current} A` : '0 A' }}
                        </p>
                    </div>
                    <div class="bg-blue-50 p-3 rounded-lg border border-blue-100">
                        <p class="text-xs text-blue-500 uppercase font-semibold">Power Factor</p>
                        <p class="font-mono text-slate-600 text-lg">
                            {{ meters[selectedMeterId] && checkOnline(meters[selectedMeterId].last_seen) ? meters[selectedMeterId].power_factor : '0' }}
                        </p>
                    </div>
                    <div class="bg-yellow-50 p-3 rounded-lg border border-yellow-100">
                        <p class="text-xs text-yellow-600 uppercase font-semibold">Total Power</p>
                        <p class="font-mono text-slate-600 text-lg font-bold">
                            {{ meters[selectedMeterId] && checkOnline(meters[selectedMeterId].last_seen) ? `${meters[selectedMeterId].total_power} kW` : '0 kW' }}
                        </p>
                    </div>
                </div>

                <!-- Kolom Kanan: Grafik 30 Menit -->
                <div class="w-full md:w-2/3 bg-white border rounded-lg p-4 flex flex-col">
                    <h4 class="text-sm font-semibold text-gray-600 mb-2">Total Power Trend</h4>
                    <div class="flex-1 min-h-62.5 relative">
                        <div v-if="!chartData" class="absolute inset-0 flex items-center justify-center text-gray-400">
                            Graphic Loading...
                        </div>
                        <Line v-else :data="chartData" :options="chartOptions" />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
