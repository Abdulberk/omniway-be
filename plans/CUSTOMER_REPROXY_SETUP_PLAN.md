# Müşteri Reproxy Setup Plan - 3 Günlük Test

## 🎯 Hedef

Yuxor'dan aldığınız API key'i reproxy edip müşterinize `omni_` prefix'li kendi API key'inizle hizmet vermek.

**Upstream (Yuxor):**
- Base URL: `https://api.yuxor.tech` (Roo Code/Cline için)
- Claude Code Base URL: `https://api2.yuxor.tech/`
- API Key: `sk-9fe4bddf470a31522efe424b5ddcd023d96af3c3753b58366681404299ed4ca5`
- Desteklenen: Claude Code, Roo Code/Cline, Codex

**Sizin Sistem (Omniway):**
- Customer'a verilecek: `omni_xxxxxxxx` format API key
- Base URL: `http://your-domain.com/v1` (veya `https://`)

---

## 📋 Yapılacaklar Listesi

### 1. ✅ Mevcut Sistem Kontrol (Tamamlandı)
- [x] Gateway proxy service çalışıyor
- [x] API key sistemi hazır
- [x] Rate limiting aktif
- [x] Billing sistemi mevcut
- [x] OpenAI-compatible endpoints hazır (`/v1/chat/completions`)

### 2. 🔧 Upstream Konfigürasyonu (ÖNCELİK: YÜK

SEK)

**Sorun:** Şu an sistemin

iz 3 ayrı provider URL'i kullanıyor ama Yuxor tek URL veriyor.

**Çözüm:** [`model.service.ts`](../src/modules/gateway/model.service.ts:29-71)'daki provider initialization'ı güncelleyin:

```typescript
private initializeProviders(): void {
  // Yuxor upstream - TÜMÜ aynı base URL kullanıyor
  const yuxorBaseUrl = 'https://api.yuxor.tech';
  const yuxorApiKey = this.config.get<string>('UPSTREAM_API_KEY');
  
  const connectTimeout = this.config.get<number>('UPSTREAM_CONNECT_TIMEOUT_MS', 5000);
  const readTimeout = this.config.get<number>('UPSTREAM_READ_TIMEOUT_MS', 120000);

  // OpenAI provider (Yuxor üzerinden)
  this.providerConfigs.set('openai', {
    name: 'openai',
    baseUrl: yuxorBaseUrl,
    apiKey: yuxorApiKey,
    timeout: { connect: connectTimeout, read: readTimeout },
  });

  // Anthropic provider (Yuxor üzerinden)
  this.providerConfigs.set('anthropic', {
    name: 'anthropic',
    baseUrl: yuxorBaseUrl,
    apiKey: yuxorApiKey,
    timeout: { connect: connectTimeout, read: readTimeout },
  });

  // Google/Gemini provider (Yuxor üzerinden)
  this.providerConfigs.set('google', {
    name: 'google',
    baseUrl: yuxorBaseUrl,
    apiKey: yuxorApiKey,
    timeout: { connect: connectTimeout, read: readTimeout },
  });
}
```

**`.env` dosyasına ekleyin:**
```env
UPSTREAM_API_KEY=sk-9fe4bddf470a31522efe424b5ddcd023d96af3c3753b58366681404299ed4ca5
```

### 3. 📊 Database: Test User ve API Key Oluşturma

**Seçenek A: Prisma Studio ile (Kolay)**
```bash
npm run prisma:studio
```

1. `User` tablosuna test user ekle:
   ```
   email: test-customer@example.com
   name: Test Customer
   isActive: true
   ```

2. `Subscription` tablosuna plan bağla (FREE plan)
   
3. `ApiKey` tablosuna key oluştur:
   ```
   name: "Customer Test Key - 3 Days"
   ownerType: USER
   userId: <yukarıdaki user id>
   keyPrefix: omni_test123
   keyHash: <generateApiKey fonksiyonu ile oluşturulmalı>
   scopes: ["chat:write"]
   isActive: true
   expiresAt: <3 gün sonrası>
   ```

**Seçenek B: Admin API ile (Önerilen)**

Önce admin endpoint ekleyin (aşağıda detay).

### 4. 🔐 Admin API Key Oluşturma Endpoint'i Ekle

Müşteri için programatik API key oluşturmak üzere admin endpoint:

**Dosya:** `src/modules/admin/admin.controller.ts`

```typescript
@Post('users/:userId/api-keys')
@UseGuards(AdminGuard, AdminRateLimitGuard)
async createUserApiKeyAsAdmin(
  @Param('userId') userId: string,
  @Body() dto: { name: string; expiresInDays?: number; scopes?: string[] },
  @Req() req: AdminRequest,
): Promise<{ id: string; key: string; prefix: string; expiresAt: Date }> {
  const user = await this.prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundException('User not found');
  }

  // Generate API key
  const { key, prefix, hash } = this.generateApiKey();
  
  const expiresAt = dto.expiresInDays 
    ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const apiKey = await this.prisma.apiKey.create({
    data: {
      name: dto.name,
      keyPrefix: prefix,
      keyHash: hash,
      ownerType: 'USER',
      userId,
      scopes: dto.scopes || ['chat:write'],
      isActive: true,
      expiresAt,
    },
  });

  // Audit log
  await this.prisma.auditLog.create({
    data: {
      actorId: req.adminUser.id,
      actorType: 'admin',
      action: 'API_KEY_CREATED',
      targetType: 'api_key',
      targetId: apiKey.id,
      metadata: { userId, keyPrefix: prefix, expiresInDays: dto.expiresInDays },
    },
  });

  return { 
    id: apiKey.id, 
    key, // ⚠️ Sadece bir kez döndürülür!
    prefix, 
    expiresAt: apiKey.expiresAt 
  };
}

private generateApiKey(): { key: string; prefix: string; hash: string } {
  const randomPart = crypto.randomBytes(24).toString('base64url');
  const key = `omni_${randomPart}`;
  const prefix = key.substring(0, 12);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, prefix, hash };
}
```

**Kullanım:**
```bash
POST /admin/users/<user-id>/api-keys
Authorization: Bearer <admin-jwt-token>
Content-Type: application/json

{
  "name": "Customer Test - 3 Days",
  "expiresInDays": 3,
  "scopes": ["chat:write"]
}

# Response:
{
  "id": "...",
  "key": "omni_XxXxXxXxXxXxXxXxXxXxXxXx", 
  "prefix": "omni_XxXxXx",
  "expiresAt": "2026-02-28T12:00:00.000Z"
}
```

### 5. 🧪 Test Senaryoları

#### A. Roo Code / Cline Test (OpenAI Compatible)

**Customer Setup:**
```bash
# Roo Code ayarları
Base URL: http://your-domain.com/v1
API Key: omni_XxXxXxXxXxXxXxXxXxXxXxXx
Model: gpt-4 (veya database'deki model ID'si)
```

**Test Request:**
```bash
curl http://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer omni_XxXxXxXxXxXxXxXxXxXxXxXx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**Beklenen Akış:**
```
Customer → Omniway Gateway → Yuxor API → OpenAI/Anthropic
         (omni_xxx)       (yuxor sk-xxx)
```

#### B. Claude Code Test (Anthropic SDK Format)

**⚠️ ÖNEMLİ:** Claude Code Anthropic SDK kullanır, yani `/v1/messages` endpoint'i bekler.

**Mevcut sistem sadece `/v1/chat/completions` var!**

**İki Seçenek:**

**Seçenek 1: Anthropic Format Desteği Ekle (Önerilen)**

Yeni controller endpoint:
```typescript
// src/modules/gateway/gateway.controller.ts
@Post('messages') // Anthropic format
@UseGuards(AuthGuard, RateLimitGuard, ConcurrencyGuard, BillingGuard)
async anthropicMessages(@Body() body: any, @Req() request, @Res() reply) {
  // Anthropic → OpenAI format dönüşümü
  const openAIRequest = {
    model: body.model,
    messages: body.messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream,
  };
  
  // Mevcut chat completions logic'ini kullan
  return this.chatCompletions(openAIRequest, request, reply);
}
```

**Seçenek 2: Yuxor'un Claude Code URL'ini Direk Ver (Geçici)**

Customer'a doğrudan Yuxor'un Claude Code URL'ini verin:
```
ANTHROPIC_BASE_URL=https://api2.yuxor.tech/
ANTHROPIC_AUTH_TOKEN=sk-9fe4bddf470a31522efe424b5ddcd023d96af3c3753b58366681404299ed4ca5
```

**Bu durumda reproxy olmuyor, customer direkt Yuxor'u kullanıyor!**

### 6. 📈 Monitoring & Limits

**3 Günlük Test İçin Ayarlar:**

1. **Rate Limiting:**
   ```sql
   -- User plan limitlerini ayarlayın
   UPDATE "Plan" SET 
     "limitPerMinute" = 20,
     "limitPerHour" = 100,
     "limitPerDay" = 500
   WHERE slug = 'free'; -- Test user'ın plan'ı
   ```

2. **Wallet Balance (Opsiyonel):**
   ```sql
   -- Test için $10 yükleyin (1000 cents)
   INSERT INTO "WalletBalance" (id, "userId", "balanceCents") 
   VALUES (gen_random_uuid(), '<user-id>', 1000);
   ```

3. **Usage Tracking:**
   - `RequestEvent` tablosunda tüm istekler otomatik log'lanıyor
   - `/me/usage` endpoint'i ile customer'ın usage'ını görebilirsiniz

### 7. 🚀 Deployment Checklist

- [ ] `.env` dosyasına `UPSTREAM_API_KEY` ekle
- [ ] Database migration'ları çalıştır: `npm run prisma:migrate:deploy`
- [ ] Test user oluştur
- [ ] API key oluştur (admin endpoint veya Prisma Studio)
- [ ] Upstream base URL'leri Yuxor'a point et
- [ ] Redis ve PostgreSQL bağlantılarını doğrula
- [ ] `npm run start:prod` ile prod build test et
- [ ] Stripe webhook'ları disable et (test için)
- [ ] CORS ayarlarını customer domain'i için güncelle

### 8. 📝 Customer Onboarding Dokümanı

**Email Template:**

```
Merhaba [Customer Name],

3 günlük test erişiminiz hazır! 🎉

API Key: omni_XxXxXxXxXxXxXxXxXxXxXxXx
Base URL: https://api.yourdomain.com/v1
Expires: 28.02.2026

🔧 Roo Code / Cline Kurulumu:
1. Settings → API Key → [yukarıdaki key]
2. Base URL → https://api.yourdomain.com/v1
3. Model → gpt-4 (veya istediğiniz model)

🔧 Claude Code Kurulumu:
[TODO: Anthropic endpoint hazır olduktan sonra]

📊 Usage Dashboard:
https://api.yourdomain.com/me/usage
(API key ile erişim)

⚠️ Limitler:
- 20 req/dakika
- 100 req/saat  
- 500 req/gün

Sorularınız için: support@yourdomain.com
```

---

## 🔐 Güvenlik Notları

1. **API Key Rotation:** 3 gün sonra otomatik expire olacak
2. **IP Whitelisting:** Customer'ın IP'sini öğrenip `allowedIps` arrayine ekleyebilirsiniz
3. **Audit Logs:** Tüm API key kullanımları `AuditLog` tablosunda
4. **Rate Limiting:** Redis-based, bypass edilemez
5. **Upstream Key Gizleme:** Customer hiçbir zaman Yuxor key'ini görmez

---

## 🐛 Olası Sorunlar & Çözümler

### "Model not found" Hatası

**Neden:** Database'de model katalog'u boş.

**Çözüm:**
```sql
-- Model catalog seed
INSERT INTO "ModelCatalog" ("modelId", "provider", "upstreamModelId", "displayName", 
"supportsStreaming", "isActive", "sortOrder") VALUES
('gpt-4', 'openai', 'gpt-4', 'GPT-4', true, true, 1),
('gpt-3.5-turbo', 'openai', 'gpt-3.5-turbo', 'GPT-3.5 Turbo', true, true, 2),
('claude-3-opus', 'anthropic', 'claude-3-opus-20240229', 'Claude 3 Opus', true, true, 3);
```

### "Upstream error (401)" Hatası

**Neden:** Yuxor API key'i yanlış veya expire olmuş.

**Çözüm:**
- `.env` dosyasındaki `UPSTREAM_API_KEY`'i kontrol edin
- Yuxor'dan yeni key isteyin

### Claude Code "Invalid base URL" Hatası

**Neden:** Anthropic SDK `/v1/messages` endpoint'i bulamıyor.

**Çözüm:** Yukarıdaki "Seçenek 1" ile Anthropic format desteği ekleyin.

---

## 📊 Success Metrics (3 Günlük Test)

Başarı kriterleri:
- [ ] Customer API key ile ilk başarılı request
- [ ] Roo Code/Cline entegrasyonu çalışıyor
- [ ] Rate limiting doğru çalışıyor (test edin: 21. request → 429 hatası)
- [ ] Usage tracking doğru (RequestEvent tablosu doluyor)
- [ ] 3 gün sonra key otomatik expire oluyor

---

## 🎯 Sonraki Adımlar (Test Sonrası)

1. **Pricing Model:** Wallet vs Subscription belirleme
2. **Stripe Integration:** Ödeme sistemi aktifleştirme
3. **Self-Service Onboarding:** Customer'ın kendi API key'ini oluşturması
4. **Claude Code Full Support:** Anthropic format implementasyonu
5. **Analytics Dashboard:** Grafana/Metabase entegrasyonu

---

## ⚡ Hızlı Start Komutu

```bash
# 1. Environment variables
cp .env.example .env
# .env'yi düzenle: UPSTREAM_API_KEY=sk-9fe4...

# 2. Database setup
npm run prisma:migrate:deploy
npm run prisma:generate

# 3. Start services
docker-compose up -d  # Redis + PostgreSQL
npm run start:dev

# 4. Create test user & API key
# (Prisma Studio veya admin endpoint kullan)

# 5. Test
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer omni_testkey"
```

---

**Hazırlayan:** Roo  
**Tarih:** 25.02.2026  
**Versiyon:** 1.0
