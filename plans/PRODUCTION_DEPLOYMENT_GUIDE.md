# Production Deployment Guide - Omniway API Reproxy

## 🎯 Amaç
Müşteriler Claude Code veya Roo Code'da **SADECE senin markanı (Omniway)** görecek, Yuxor'u asla görmeyecek. Tüm istekler senin domain'inden geçecek.

---

## 📋 Önkoşullar Checklist

- [ ] Domain satın alındı (örn: `api.omniway.ai`)
- [ ] VPS/Cloud sunucu (DigitalOcean, AWS, Hetzner vs.)
- [ ] PostgreSQL veritabanı
- [ ] Redis kurulumu
- [ ] SSL sertifikası (Let's Encrypt)
- [ ] Node.js 18+ kurulu

---

## 1️⃣ DOMAIN AYARLARI

### A) Domain Satın Al ve DNS Ayarla

```bash
# Örnek domain: api.omniway.ai
# DNS kayıtları (domain panelinden):

Type: A
Name: api
Value: <SUNUCU-IP-ADRESI>
TTL: 3600
```

**Test Et:**
```bash
ping api.omniway.ai
# Sunucu IP'sine ping atmalı
```

---

## 2️⃣ SUNUCU KURULUMU (Ubuntu 22.04 Örneği)

### A) Sunucuya Bağlan

```bash
ssh root@<SUNUCU-IP>
```

### B) Temel Kurulumlar

```bash
# Sistemi güncelle
apt update && apt upgrade -y

# Node.js 20 LTS kur
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PM2 kur (production process manager)
npm install -g pm2

# Nginx kur (reverse proxy)
apt install -y nginx

# PostgreSQL kur
apt install -y postgresql postgresql-contrib

# Redis kur
apt install -y redis-server

# Certbot kur (SSL sertifikası için)
apt install -y certbot python3-certbot-nginx
```

---

## 3️⃣ POSTGRESQL AYARLARI

```bash
# PostgreSQL'e geç
sudo -u postgres psql

# Database ve kullanıcı oluştur
CREATE DATABASE omniway;
CREATE USER omniway WITH ENCRYPTED PASSWORD 'güçlü_şifre_buraya';
GRANT ALL PRIVILEGES ON DATABASE omniway TO omniway;

# Database'e bağlan ve schema oluştur
\c omniway
CREATE SCHEMA IF NOT EXISTS public;
GRANT ALL ON SCHEMA public TO omniway;
\q
```

---

## 4️⃣ REDIS AYARLARI

```bash
# Redis config düzenle
nano /etc/redis/redis.conf

# Bu satırları değiştir/ekle:
bind 127.0.0.1
requirepass güçlü_redis_şifresi

# Redis'i başlat
systemctl enable redis-server
systemctl restart redis-server
```

---

## 5️⃣ PROJE DEPLOY

### A) Projeyi Sunucuya Aktar

```bash
# Lokal makinenden (Windows):
# Önce projeyi git'e push et veya scp ile aktar

# Sunucuda proje dizini oluştur
mkdir -p /var/www/omniway-api
cd /var/www/omniway-api

# Git ile çek (veya scp/ftp ile aktar)
git clone https://github.com/YOUR-REPO/omniway-be.git .
# VEYA
# Windows'tan: scp -r e:/omniway-be root@SUNUCU-IP:/var/www/omniway-api
```

### B) Production .env Oluştur

```bash
nano /var/www/omniway-api/.env
```

`.env` içeriği:
```env
# Application
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
API_BASE_URL=https://api.omniway.ai

# Database
DATABASE_URL=postgresql://omniway:güçlü_şifre@localhost:5432/omniway?schema=public
DATABASE_POOL_SIZE=20

# Redis
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=güçlü_redis_şifresi

# Upstream Providers (YUXOR - MÜŞTERİ ASLA GÖRMEYECEK)
UPSTREAM_OPENAI_URL=https://api.yuxor.tech
UPSTREAM_ANTHROPIC_URL=https://api.yuxor.tech
UPSTREAM_OPENAI_COMPATIBLE_URL=https://api.yuxor.tech
UPSTREAM_API_KEY=sk_your_real_upstream_api_key

# JWT
JWT_SECRET=production-çok-güçlü-256-bit-secret-buraya-değiştir
JWT_EXPIRES_IN=7d

# Security
API_KEY_PREFIX=omni_
API_KEY_PEPPER=32-byte-random-pepper-production
CORS_ORIGINS=https://omniway.ai,https://app.omniway.ai

# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Rate Limiting
DEFAULT_LIMIT_PER_MINUTE=60
DEFAULT_LIMIT_PER_HOUR=1000
DEFAULT_LIMIT_PER_DAY=10000
```

### C) Dependencies Kur ve Build

```bash
cd /var/www/omniway-api

# Dependencies
npm ci --production=false

# Prisma generate
npx prisma generate

# Database migrate
npx prisma migrate deploy

# Model catalog seed
psql -U omniway -d omniway -f prisma/seeds/01_model_catalog.sql

# Build
npm run build

# Production dependencies
npm prune --production
```

---

## 6️⃣ PM2 İLE UYGULAMAYI BAŞLAT

### A) PM2 Ecosystem Dosyası

```bash
nano /var/www/omniway-api/ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'omniway-api',
    script: 'dist/main.js',
    instances: 2, // CPU core sayısına göre ayarla
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/var/log/omniway-api/error.log',
    out_file: '/var/log/omniway-api/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '1G',
  }]
};
```

### B) Log Dizini Oluştur ve Başlat

```bash
# Log dizini
mkdir -p /var/log/omniway-api

# PM2 ile başlat
pm2 start ecosystem.config.js

# Sistem başlangıcında otomatik başlat
pm2 startup
pm2 save

# Logları kontrol et
pm2 logs omniway-api
```

---

## 7️⃣ NGINX REVERSE PROXY VE SSL

### A) Nginx Config

```bash
nano /etc/nginx/sites-available/omniway-api
```

```nginx
# HTTP (SSL yönlendirmesi için)
server {
    listen 80;
    listen [::]:80;
    server_name api.omniway.ai;

    # Let's Encrypt doğrulama için
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # HTTPS'e yönlendir
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.omniway.ai;

    # SSL sertifikaları (certbot sonrası eklenecek)
    ssl_certificate /etc/letsencrypt/live/api.omniway.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.omniway.ai/privkey.pem;
    
    # SSL ayarları (güvenlik)
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/m;
    limit_req zone=api_limit burst=20 nodelay;

    # Max body size
    client_max_body_size 10M;

    # Proxy to Node.js app
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts (streaming için uzun)
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}
```

### B) SSL Sertifikası Al (Let's Encrypt)

```bash
# Nginx config'i aktif et
ln -s /etc/nginx/sites-available/omniway-api /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default  # Default config'i kaldır

# Nginx syntax check
nginx -t

# İlk seferde HTTP modunda başlat (SSL yok)
nano /etc/nginx/sites-available/omniway-api
# SSL kısmını yoruma al (# ile başlat), sadece HTTP kısmını bırak

# Nginx'i başlat
systemctl restart nginx

# SSL sertifikası al
certbot --nginx -d api.omniway.ai --email admin@omniway.ai --agree-tos --no-eff-email

# Sertifika otomatik yenileme test et
certbot renew --dry-run

# Nginx config'e SSL kısmını geri ekle
nano /etc/nginx/sites-available/omniway-api
# Yukarıdaki full config'i kullan

# Nginx'i restart et
systemctl restart nginx
```

---

## 8️⃣ TEST ET

### A) Health Check

```bash
curl https://api.omniway.ai/health

# Beklenen response:
{
  "status": "ok",
  "timestamp": "2026-02-25T12:00:00.000Z",
  "database": "connected",
  "redis": "connected"
}
```

### B) Admin Giriş ve API Key Oluştur

```bash
# 1. Admin kullanıcı oluştur (database'de)
psql -U omniway -d omniway

INSERT INTO "User" (id, email, name, password, role, "isActive", "isSuperAdmin", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  'admin@omniway.ai',
  'Admin User',
  '$2b$10$YourHashedPasswordHere',  -- bcrypt hash kullan
  'ADMIN',
  true,
  true,
  NOW(),
  NOW()
);

# 2. Admin login
curl -X POST https://api.omniway.ai/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@omniway.ai",
    "password": "admin-şifresi"
  }'

# Response'dan JWT token'ı al

# 3. Test user oluştur
curl -X POST https://api.omniway.ai/admin/users \
  -H "Authorization: Bearer <JWT-TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "customer@example.com",
    "name": "Test Customer"
  }'

# 4. API key oluştur
curl -X POST https://api.omniway.ai/admin/api-keys \
  -H "Authorization: Bearer <JWT-TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Customer Test Key - 3 Days",
    "userId": "<user-id-from-previous-step>",
    "scopes": ["chat:write", "models:read"]
  }'

# Response'dan API key'i al (omni_ ile başlayan)
```

### C) Chat Completion Test

```bash
# OpenAI format test (Roo Code/Cline için)
curl https://api.omniway.ai/v1/chat/completions \
  -H "Authorization: Bearer omni_XXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "Merhaba! Bu bir test mesajı."}
    ],
    "stream": false
  }'

# Streaming test
curl https://api.omniway.ai/v1/chat/completions \
  -H "Authorization: Bearer omni_XXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Count to 5 slowly"}
    ],
    "stream": true
  }'
```

---

## 9️⃣ MÜŞTERİYE VERİLECEK BİLGİLER

### Roo Code / Cline Konfigürasyonu

Müşteri Roo Code veya Cline ayarlarında şunları görecek:

```json
{
  "apiProvider": "openai-native",
  "openai": {
    "baseUrl": "https://api.omniway.ai",
    "apiKey": "omni_XXXXXXXXXXXXXXXX"
  }
}
```

VEYA Environment Variables:
```bash
OPENAI_API_BASE_URL=https://api.omniway.ai
OPENAI_API_KEY=omni_XXXXXXXXXXXXXXXX
```

### Claude Code İçin (Anthropic SDK Format)

**ÖNEMLİ:** Claude Code, Anthropic SDK formatı kullanır. Eğer müşteri Claude Code kullanacaksa, `/v1/messages` endpoint'i eklememiz gerekiyor.

---

## 🔟 CLAUDE CODE İÇİN EK ENDPOINT (OPSİYONEL)

Eğer müşteri Claude Code kullanacaksa, Anthropic SDK uyumlu endpoint eklemeliyiz:

### A) Gateway Controller'a Ekle

```typescript
// src/modules/gateway/gateway.controller.ts

@Post('v1/messages')
@HttpCode(HttpStatus.OK)
async anthropicMessages(
  @Req() request: FastifyRequest,
  @Body() body: any,
) {
  // Anthropic SDK formatını OpenAI formatına çevir
  const openAIRequest = {
    model: body.model,
    messages: body.messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream || false,
  };

  // Proxy service kullan
  return this.proxyChatCompletion(request, openAIRequest);
}
```

### Müşteri Konfigürasyonu (Claude Code için)

```bash
# Environment variables
ANTHROPIC_API_BASE_URL=https://api.omniway.ai
ANTHROPIC_API_KEY=omni_XXXXXXXXXXXXXXXX
```

---

## 1️⃣1️⃣ MONİTORİNG VE LOGGING

### A) PM2 Monitoring

```bash
# Real-time monitoring
pm2 monit

# Detaylı bilgi
pm2 show omniway-api

# CPU ve Memory kullanımı
pm2 status
```

### B) Nginx Access Logs

```bash
# Real-time access logs
tail -f /var/log/nginx/access.log

# Error logs
tail -f /var/log/nginx/error.log
```

### C) Application Logs

```bash
# PM2 logs
pm2 logs omniway-api --lines 100

# Veya direkt dosyadan
tail -f /var/log/omniway-api/out.log
tail -f /var/log/omniway-api/error.log
```

---

## 1️⃣2️⃣ GÜNCELLEME VE BAKIM

### Kod Güncellemesi (Zero Downtime)

```bash
cd /var/www/omniway-api

# Yeni kodu çek
git pull origin main

# Dependencies güncelle (varsa)
npm ci --production=false

# Prisma migration (varsa)
npx prisma migrate deploy

# Build
npm run build

# Production dependencies
npm prune --production

# PM2 reload (zero downtime)
pm2 reload omniway-api
```

### Database Backup

```bash
# Otomatik backup script
nano /usr/local/bin/backup-omniway-db.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/omniway"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup
pg_dump -U omniway omniway | gzip > "$BACKUP_DIR/omniway_$DATE.sql.gz"

# 7 günden eski backupları sil
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

echo "Backup completed: omniway_$DATE.sql.gz"
```

```bash
chmod +x /usr/local/bin/backup-omniway-db.sh

# Crontab'a ekle (günlük 3:00 AM)
crontab -e
0 3 * * * /usr/local/bin/backup-omniway-db.sh
```

---

## 1️⃣3️⃣ FIREWALL AYARLARI

```bash
# UFW kur ve aktif et
apt install -y ufw

# Temel kurallar
ufw default deny incoming
ufw default allow outgoing

# SSH, HTTP, HTTPS izin ver
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp

# PostgreSQL ve Redis sadece localhost (zaten bind 127.0.0.1)
# Firewall'da kapatık olması gerek

# Firewall'u aktif et
ufw enable

# Durumu kontrol et
ufw status verbose
```

---

## ✅ DEPLOYMENT CHECKLIST

### Production'a Almadan Önce

- [ ] `.env` dosyasında tüm production değerler set edildi
- [ ] JWT_SECRET ve API_KEY_PEPPER production için değiştirildi
- [ ] PostgreSQL şifreleri güçlü
- [ ] Redis şifreli
- [ ] SSL sertifikası kurulu ve çalışıyor
- [ ] Nginx reverse proxy çalışıyor
- [ ] PM2 cluster mode aktif
- [ ] Firewall kuralları set edildi
- [ ] Database backup cron job kuruldu
- [ ] Log rotation ayarlandı
- [ ] Model catalog seed çalıştırıldı
- [ ] Admin kullanıcı oluşturuldu
- [ ] Test API key'i oluşturuldu ve test edildi

### Müşteriye Vermeden Önce

- [ ] API key 3 günlük sınırla oluşturuldu
- [ ] Rate limit ve kota ayarlandı
- [ ] Monitoring ve alerting set edildi
- [ ] Müşteri dokümantasyonu hazırlandı
- [ ] Test senaryoları çalıştırıldı

---

## 🎉 SONUÇ

Müşteri artık şunu görecek:

**Roo Code/Cline'da:**
```
Base URL: https://api.omniway.ai
API Key: omni_xxxxxxxxxxxxx
Provider: Omniway API
```

**Claude Code'da:**
```
API Base URL: https://api.omniway.ai
API Key: omni_xxxxxxxxxxxxx
```

Yuxor hiçbir yerde görünmüyor, tüm branding senin! 🚀

---

## 🆘 SORUN GİDERME

### 1. "UPSTREAM_API_KEY" Required Hatası
```bash
# .env dosyasını kontrol et
cat /var/www/omniway-api/.env | grep UPSTREAM

# Eksikse ekle
nano /var/www/omniway-api/.env
# UPSTREAM_API_KEY satırını ekle

# Uygulamayı restart et
pm2 restart omniway-api
```

### 2. SSL Sertifikası Alınamıyor
```bash
# DNS'in doğru çalıştığını kontrol et
nslookup api.omniway.ai

# Nginx'in 80 portunda çalıştığını kontrol et
netstat -tulpn | grep :80

# Let's Encrypt loglarını kontrol et
cat /var/log/letsencrypt/letsencrypt.log
```

### 3. Database Connection Error
```bash
# PostgreSQL çalışıyor mu?
systemctl status postgresql

# Connection string doğru mu?
psql -U omniway -d omniway -h localhost
```

### 4. Redis Connection Error
```bash
# Redis çalışıyor mu?
systemctl status redis-server

# Redis'e bağlanabiliyor muyuz?
redis-cli -a güçlü_redis_şifresi ping
# PONG dönmeli
```
