# Deploy — waizor-v2 em `v2.waizor.com.br`

A VPS já roda um cluster **Docker Swarm** com **Traefik** como reverse proxy
(TLS automático via Let's Encrypt, HTTP challenge). O waizor-v2 é publicado
como **serviço Swarm** na rede overlay existente `minha_rede`, exposto por
**labels do Traefik** — o mesmo padrão dos outros serviços (ex.: `evo_gateway`
→ `api-crm.waizor.com.br`).

> **Não** instale Nginx/Certbot no host: o Traefik já é dono de `:80/:443`.
> O banco é **Supabase Cloud** (`vgyepacjxciicqylurxd.supabase.co`).

Arquivos usados no deploy:

| Arquivo | Função |
|---|---|
| `Dockerfile` | Imagem de produção (Next.js standalone, multi-stage) |
| `docker-compose.yml` | **Builder** da imagem `waizor-v2:latest` (bake dos `NEXT_PUBLIC_*`) |
| `deploy/stack.yml` | Serviço Swarm + labels do Traefik |
| `.env.production.example` | Template → copiar para `.env` no servidor |
| `deploy.sh` | `git pull` + rebuild + `stack deploy` |
| `deploy/cron-ping.sh` | Pinger dos endpoints de cron |

---

## 1. DNS

No painel de `waizor.com.br`, crie:

```
Tipo  Nome  Valor            TTL
A     v2    212.56.33.124    300
```

Confirme: `dig +short v2.waizor.com.br` → `212.56.33.124`.
O Traefik emite o certificado sozinho no primeiro acesso (HTTP challenge),
então o DNS precisa estar propagado **antes** do deploy.

## 2. Código na VPS

```bash
sudo mkdir -p /opt/waizor-v2 && sudo chown "$USER" /opt/waizor-v2
git clone https://github.com/leandromery/waizor-v2.git /opt/waizor-v2
cd /opt/waizor-v2
```

> Repo privado: use deploy key SSH ou um PAT na URL HTTPS.

## 3. Variáveis de ambiente

```bash
cp .env.production.example .env
nano .env   # preencher os valores reais
```

Chaves obrigatórias (ver `.env.production.example`):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SITE_URL=https://v2.waizor.com.br`
- `NEXT_PUBLIC_APP_LOCALE=pt`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  ⚠️ **Reutilize o mesmo valor** se já existem tokens de WhatsApp salvos; trocar orfana os tokens.
- `META_APP_SECRET`, `META_APP_ID`
- `AUTOMATION_CRON_SECRET` — `openssl rand -hex 32`
- `ALLOWED_INVITE_HOSTS=v2.waizor.com.br`

## 4. Build + deploy

```bash
# 1) Build da imagem (Compose lê .env e injeta os NEXT_PUBLIC_* como build args)
docker compose build

# 2) Deploy do serviço Swarm (exporta o .env para interpolar os secrets)
set -a; . ./.env; set +a
docker stack deploy -c deploy/stack.yml waizor

# 3) Acompanhar
docker service ps waizor_app --no-trunc
docker service logs -f waizor_app
```

O Traefik detecta o serviço pelas labels e passa a rotear
`https://v2.waizor.com.br` → container:3000, emitindo o TLS.

## 5. Cron das automações

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
- **Migrations**: confirmar que as migrations de `supabase/migrations/` estão aplicadas no projeto cloud. Se não:
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

1. `dig +short v2.waizor.com.br` → `212.56.33.124`.
2. `curl -I https://v2.waizor.com.br` → 200 + TLS válido (emitido pelo Traefik).
3. Browser: estilos carregam (sem 404 em `/_next/static/*`), login funciona.
4. Dashboard (`/inbox`, `/contacts`, `/pipelines`) renderiza após login.
5. Mensagem de teste no WhatsApp → webhook recebe (`docker service logs -f waizor_app`).
6. `docker service ls | grep waizor` → `1/1` réplicas.
