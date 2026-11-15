<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Head } from '@inertiajs/vue3';

const meters = ref<Record<string, any>>({});

const diagramNodes = ref([
    { id: 'sensor_sim_01', label: 'AC DRIVE', top: '25.5%', left: '33%' },
    { id: 'sensor_sim_02', label: 'UTILITY', top: '25.5%', left: '40%' },
    { id: 'sensor_sim_03', label: 'APF/PM', top: '25.5%', left: '47%' },
    { id: 'sensor_sim_04', label: 'P2', top: '25.5%', left: '53.75%' },
    { id: 'sensor_sim_05', label: 'SP OCC', top: '25.5%', left: '60.9%' },
    { id: 'sensor_sim_06', label: 'SP ONP', top: '25.5%', left: '67.75%' },
]);

onMounted(() => {
    if ((window as any).Echo) {
        (window as any).Echo.private('power-monitoring')
            .listen('.power.updated', (event: any) => {
                if (event && event.meters) {
                    meters.value = event.meters;
                }
            });
    }
});
</script>

<template>
    <Head title="Single Line Diagram" />
    
    <div class="p-4 bg-gray-100 h-auto flex justify-center items-start overflow-auto">
        <div class="relative w-full bg-white shadow-lg rounded-xl overflow-hidden">
            <img src="/img/sld.svg" alt="Single Line Diagram" class="w-full size-max opacity-90" />
            <div 
                v-for="node in diagramNodes" 
                :key="node.id"
                class="absolute bg-white/90 border border-blue-500 rounded px-1.5 py-0.5 shadow-sm text-center transform -translate-x-1/2 -translate-y-1/2 cursor-pointer hover:bg-blue-50 hover:scale-110 transition-all"
                :style="{ top: node.top, left: node.left }">
                <div class="text-[9px] font-bold text-gray-500">{{ node.label }}</div>
                <div class="text-xs font-mono font-bold text-blue-700">
                    {{ meters[node.id]?.total_power || '0.00' }} kW
                </div>
            </div>

        </div>
    </div>
</template>