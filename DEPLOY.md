# Deploy — waizor-v2 em `v2.waizor.com.br`

Guia para publicar o app numa VPS com **Docker Compose**, atrás de **Nginx + Certbot**.
O banco é **Supabase Cloud** (`vgyepacjxciicqylurxd.supabase.co`) — não roda na VPS.

Arquivos deste repo usados no deploy:

| Arquivo | Função |
|---|---|
| `Dockerfile` | Imagem de produção (Next.js standalone, multi-stage) |
| `docker-compose.yml` | Sobe o container `app` em `127.0.0.1:3000` |
| `.env.production.example` | Template → copiar para `.env` no servidor |
| `deploy.sh` | `git pull` + rebuild + restart |
| `deploy/nginx/v2.waizor.com.br.conf` | Vhost do Nginx |
| `deploy/cron-ping.sh` | Pinger dos endpoints de cron |

---

## 1. DNS

No painel do domínio `waizor.com.br`, crie:

```
Tipo  Nome  Valor            TTL
A     v2    <IP_DA_VPS>      300
```

Confirme a propagação:

```bash
dig +short v2.waizor.com.br
```

## 2. Pré-requisitos na VPS

```bash
# Docker + Compose plugin (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin nginx certbot python3-certbot-nginx

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

## 3. Código

```bash
sudo mkdir -p /opt/waizor-v2 && sudo chown "$USER" /opt/waizor-v2
git clone https://github.com/leandromery/waizor-v2.git /opt/waizor-v2
cd /opt/waizor-v2
```

> Repo privado: use um **deploy key** SSH (`git clone git@github.com:...`) ou um
> Personal Access Token na URL HTTPS.

## 4. Variáveis de ambiente

```bash
cp .env.production.example .env
nano .env   # preencher os valores reais
```

Chaves obrigatórias (ver `.env.production.example` para detalhes):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase → Settings → API)
- `NEXT_PUBLIC_SITE_URL=https://v2.waizor.com.br`
- `NEXT_PUBLIC_APP_LOCALE=pt`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  ⚠️ **Reutilize o mesmo valor já em uso** se já existem tokens de WhatsApp salvos; trocar orfana os tokens.
- `META_APP_SECRET`, `META_APP_ID`
- `AUTOMATION_CRON_SECRET` — `openssl rand -hex 32`
- `ALLOWED_INVITE_HOSTS=v2.waizor.com.br`

## 5. Build e subida

```bash
docker compose up -d --build
docker compose logs -f app     # conferir que subiu sem erro de env
curl -I http://127.0.0.1:3000  # deve responder 200/3xx localmente
```

## 6. Nginx + SSL

```bash
sudo cp deploy/nginx/v2.waizor.com.br.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/v2.waizor.com.br.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Emite o certificado e reescreve o vhost para HTTPS + redirect
sudo certbot --nginx -d v2.waizor.com.br
```

Renovação é automática (timer do certbot). Teste: `sudo certbot renew --dry-run`.

## 7. Cron das automações

Necessário se usar passos "Wait" em automações ou flows agendados.

```bash
chmod +x /opt/waizor-v2/deploy/cron-ping.sh
crontab -e
# adicionar (troque o segredo pelo AUTOMATION_CRON_SECRET do .env):
*/5 * * * * AUTOMATION_CRON_SECRET=xxxx /opt/waizor-v2/deploy/cron-ping.sh >> /var/log/waizor-cron.log 2>&1
```

---

## Configuração fora do servidor

### Supabase
- **Migrations**: confirmar que as 35 migrations de `supabase/migrations/` estão aplicadas no projeto cloud. Se não:
  ```bash
  supabase link --project-ref vgyepacjxciicqylurxd
  supabase db push
  ```
- **Auth → URL Configuration**: Site URL = `https://v2.waizor.com.br` e adicionar aos Redirect URLs.
- **Storage**: garantir que os buckets de avatares/mídia existem.

### Meta / WhatsApp
- Callback URL do webhook: `https://v2.waizor.com.br/api/whatsapp/webhook`
- Verify token + assinatura HMAC via `META_APP_SECRET`; reinscrever os campos (messages, etc.).

---

## Atualizações futuras

```bash
cd /opt/waizor-v2
./deploy.sh
```

## Verificação end-to-end

1. `curl -I https://v2.waizor.com.br` → 200 + TLS válido.
2. Abrir no browser: estilos carregam (sem 404 em `/_next/static/*`), login funciona.
3. Dashboard (`/inbox`, `/contacts`, `/pipelines`) renderiza após login.
4. Mensagem de teste no WhatsApp → webhook recebe (`docker compose logs -f app`).
5. Reboot da VPS → container volta sozinho (`restart: unless-stopped`).
