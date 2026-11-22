# PROJECT CONTEXT: Power Monitoring System

## 1. Project Overview
Aplikasi ini adalah sistem monitoring daya (Power Meter) real-time menggunakan Laravel 13, Vue 3 (Inertia), dan EMQX sebagai MQTT Broker. Data dikirim oleh perangkat ESP32 setiap detik.

## 2. Arsitektur Transisi (PENTING)
Saat ini, kita sedang memigrasikan MQTT Subscriber dari Laravel ke Node.js.
- **SEBELUMNYA:** Laravel menggunakan `php-mqtt/laravel-client` (TCP) dan Laravel Reverb/Echo untuk broadcast.
- **TARGET BARU:** Node.js (sidecar service) menangani MQTT (via WebSocket WSS) dan Socket.IO. Laravel bertugas untuk UI, API, dan Cronjob (membaca Redis -> MySQL).

## 3. Tech Stack & Environment
- **Backend Utama:** Laravel 13 (PHP 8.2+)
- **Frontend:** Vue 3 + Inertia.js + Vite
- **MQTT Service Baru:** Node.js (Express/Socket.IO)
- **Database:** MySQL
- **Cache/Queue:** Redis (Digunakan untuk menyimpan data sementara sebelum di-flush oleh Laravel Cronjob)
- **MQTT Broker:** EMQX (Docker) diakses via Cloudflare Tunnel (WebSocket WSS).

## 4. Aturan Wajib untuk AI Agent (Constraints)
1. **JANGAN** mengubah skema database MySQL (migrasi) kecuali diminta.
2. **JANGAN** mengubah logika Cronjob `LogShiftEnergy.php` (hanya boleh disesuaikan pembacaan Redis-nya jika diperlukan).
3. **FORMAT REDIS:** Node.js harus menulis ke Redis dengan format persis sama seperti yang sebelumnya dilakukan oleh `MqttSubscriber.php` (Laravel). 
4. **FRONTEND:** Hapus ketergantungan Laravel Echo/Pusher. Gunakan `socket.io-client` yang terhubung ke port `3001`.
5. **ENV:** Kredensial MQTT dipindahkan dari `.env` Laravel ke `mqtt-service/.env`.

## 5. Key Files Map (Peta File)
- `app/Console/Commands/LogShiftEnergy.php` -> Cronjob 8 jam (JANGAN DISENTUH).
- `app/Console/Commands/MqttSubscriber.php` -> File lama, TARGET UNTUK DIHAPUS.
- `resources/js/app.ts` -> Hapus inisialisasi Echo/Pusher di sini.
- `resources/js/pages/...` -> File Vue Dashboard, ubah listener data ke Socket.IO.
- `mqtt-service/index.js` -> (File Baru) Node.js script untuk MQTT & Socket.IO.