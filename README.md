# DJ Sync

Um "DJ" colaborativo estilo Nightbot, feito para assistir/ouvir junto durante uma live:
você cria uma sala, cola um link do YouTube e todo mundo que entrou pelo link ouve o
**mesmo vídeo no mesmo segundo**.

## O que ele faz

- **Salas por código/link** (`/r/ABC23`) — você é o DJ, seus amigos são ouvintes.
- **Fila de músicas** — qualquer pessoa pode digitar só o **nome da música** (ex.: `bohemian rhapsody queen`) ou colar um link.
- **Pedidos pelo chat da Twitch** — `$sr nome da música` direto no chat da live, sem abrir o site.
- **Pedidos pelo chat da sala** — `!sr nome da música` (ex.: `!sr bohemian rhapsody queen`). Link também funciona.
- **Sincronização real** — o servidor é a fonte da verdade: guarda `videoId`, posição e
  estado (tocando/pausado). A cada 5 segundos ele reenvia o estado e corrige o relógio
  de quem driftou.
- **Controles do DJ** — play, pausa, próxima, anterior, seek, remover da fila, limpar fila
  e ligar/desligar pedidos.
- **Sincronização tolerante a atraso** — se alguém entrar no meio da música, o player
  começa no segundo correto.
- **Volume individual** — cada pessoa ajusta o próprio volume; não afeta os outros.
- **Chat da sala** com mensagens e avisos do sistema.

## Como funciona

```
Navegador A (DJ) ── WebSocket ─┐
Navegador B (amigo) ─ WebSocket ┼── Servidor Node (estado da sala) ── YouTube IFrame API
Navegador C (amigo) ─ WebSocket ┘
Chat da Twitch ─── IRC ────────┘
```

O servidor não baixa nem hospeda música: ele só guarda o ID do vídeo e a posição.
O áudio vem do player oficial do YouTube em cada navegador.

Quando o pedido é um nome em vez de link, o servidor faz uma busca no próprio YouTube
e escolhe o melhor resultado (prioriza vídeos oficiais/áudio original e evita letras,
covers e remixes). O resultado escolhido aparece na fila e no chat para todo mundo ver.

---

## 1. Rodar localmente

Requer **Node.js 18+** (testado com Node 22/26).

```bash
cd dj-sync
npm install
npm start
```

Abra <http://localhost:3000>. Para testar com outra pessoa na mesma rede, use o IP da
sua máquina (ex.: `http://192.168.1.10:3000`) com a porta liberada no firewall.

## 2. Colocar no ar (deploy gratuito)

### Render.com (mais simples)

1. Crie um repositório no GitHub e envie esta pasta:
   ```bash
   git init
   git add .
   git commit -m "DJ Sync"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/dj-sync.git
   git push -u origin main
   ```
2. Entre em <https://render.com> → **New → Blueprint** → conecte o repositório.
   O arquivo `render.yaml` já vem configurado (plano Free).
3. Em **Environment → Health Check Path** confirme `/health`.
4. Pronto: a URL pública (tipo `https://dj-sync.onrender.com`) é o link da sala.

> **Atenção ao plano gratuito do Render:** a instância "dorme" após ~15 min sem acesso
> e a primeira requisição demora ~30-60s para acordar. Para uma live, abra o site
> alguns minutos antes. Se incomodar, use o plano pago (US$ 7/mês) ou Railway/Fly.io.

### Railway / Fly.io

São alternativas equivalentes: o único requisito é `npm install` + `npm start` e a
variável `PORT` (o servidor já lê `process.env.PORT`).

### Híbrido: site na Vercel + backend na Render/Railway

A Vercel hoje suporta WebSocket em beta, mas no plano gratuito a conexão fecha a cada
**5 minutos** e o estado em memória não é compartilhado entre instâncias. Por isso o
mais estável é deixar só o **frontend estático** na Vercel e manter Node/WS/bot da
Twitch na Render/Railway/Fly.io.

1. Suba esta pasta para o GitHub como no passo 1 do Render.
2. Na Vercel: **Add New → Project** → selecione o repositório. O `vercel.json` já define
   `outputDirectory: public` e o rewrite de `/r/:code` para o `index.html`.
3. Antes de publicar, edite `public/config.js` e informe a URL do backend:
   ```js
   window.DJ_SYNC_API = 'https://dj-sync.onrender.com';
   ```
   (sem barra no final). Também dá para testar sem editar nada abrindo
   `https://seu-site.vercel.app/?api=https://dj-sync.onrender.com` — o valor fica salvo
   no navegador.
4. Configure no backend as mesmas variáveis de ambiente (`TWITCH_*`, etc.). O CORS já
   está liberado no servidor.

O link compartilhado continua sendo o da Vercel (`https://seu-site.vercel.app/r/CODIGO`);
só a API e o WebSocket vão para o outro domínio. Se o backend estiver no Render free,
ainda vale o aviso de "acordar" antes da live.

---

## 3. Como usar na live

1. Abra o site → digite seu nome → **Criar sala nova**.
2. Clique em **Copiar link** e mande no chat da live/discord para seus amigos.
3. Clique em **Ativar e ouvir** (obrigatório: navegadores bloqueiam áudio automático).
4. Digite o nome da música na fila (ou `!sr nome da música` no chat). O primeiro vídeo entra automaticamente.
5. Quem entrar depois também clica em **Ativar e ouvir** e escuta a partir do ponto atual.

Dica para OBS: se quiser que o áudio entre na transmissão, pegue a **saída de áudio do
navegador do DJ** no OBS (ex.: `WINDOWS/graphics-capture` com "capurar áudio" ativado).
Lembre-se de **não** marcar "Silenciar áudio do navegador" no OBS, senão o YouTube cai em
"vídeo silenciado" por reconhecer o áudio transmitido. Para uso privado entre amigos,
cada um ouvindo no próprio navegador, isso não é um problema.

## 4. Usar `$sr` no chat da Twitch

O servidor abre uma conexão IRC com o chat da Twitch e lê os comandos direto.
**Não precisa publicar o site**: a conexão é de saída, então funciona com o servidor
rodando na sua máquina. Seus amigos, porém, precisam acessar o site — aí vale publicar
no Render ou liberar a porta na rede.

### 4.1. Gerar o token OAuth

Use uma **conta bot** (recomendado) ou a sua própria conta de Twitch. O token precisa
dos escopos `chat:read` e `chat:write`.

- **Forma rápida:** entre em <https://twitchapps.com/tmi/> com a conta desejada, clique
  em **Connect**, autorize e copie o token (começa com `oauth:`). É um serviço de
  terceiros — se preferir não usá-lo, use a opção abaixo.
- **Forma oficial:** instale a [Twitch CLI](https://dev.twitch.tv/docs/cli/) e rode:
  ```bash
  twitch login
  twitch token -u -s "chat:read chat:write"
  ```
  Copie o token exibido.

### 4.2. Configurar

Copie `.env.example` para `.env` na pasta `dj-sync` e preencha:

```env
TWITCH_CHANNEL=seucanal
TWITCH_BOT_NICK=seucanal
TWITCH_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_ROOM=LIVE23
TWITCH_SR_COMMANDS=$sr,!sr
TWITCH_CHAT_REPLY=true
```

- `TWITCH_CHANNEL`: canal que o bot vai ler, sem `#`.
- `TWITCH_BOT_NICK`: nome da conta do token. Se for a sua conta, use o mesmo nome do canal.
- `TWITCH_ROOM`: código fixo da sala. O servidor **cria essa sala sozinho** ao iniciar.
  Abra `http://localhost:3000/r/LIVE23` e compartilhe esse link com seus amigos.
- `TWITCH_SR_COMMANDS`: aceita `$sr` e `!sr` por padrão (não conflita com os `!` do Nightbot).

Reinicie o servidor (`npm start`). No console deve aparecer:

```
DJ Sync rodando em http://localhost:3000
Sala da Twitch: LIVE23 → http://localhost:3000/r/LIVE23
Twitch: conectando em #seucanal → sala LIVE23
```

### 4.3. Usar na live

No chat da Twitch:

```
$sr bohemian rhapsody queen
```

O bot responde `✅ Queen – Bohemian Rhapsody (Official Video Remastered) adicionado à fila por @voce`
e a música aparece na fila do DJ Sync para todo mundo.

### 4.4. Problemas comuns

| Sintoma | Causa provável |
|---------|----------------|
| `Login authentication failed` no console | Token inválido/expirado — gere outro. |
| `Improperly formatted auth` | Confira se o token está completo (com ou sem `oauth:`). |
| Bot conecta mas não responde | Confira `TWITCH_CHANNEL` (minúsculas, sem `#`) e se `TWITCH_CHAT_REPLY` não é `false`. |
| Responde "sala ainda não está aberta" | `TWITCH_ROOM` diferente da sala usada no site. |
| Responde que os pedidos estão desativados | O DJ desmarcou **Permitir pedidos da fila** na interface. |
| Não quer resposta no chat | `TWITCH_CHAT_REPLY=false` (necessário se o token só tiver `chat:read`). |

## Busca por nome e links aceitos

**Busca por nome (padrão):** digite `!sr bohemian rhapsody queen` no chat, ou escreva
`bohemian rhapsody queen` no campo da fila. Não precisa de chave de API nem de configuração.
A busca usa o endpoint interno de pesquisa do YouTube; se o YouTube mudar esse endpoint,
a busca pode parar de funcionar — os links diretos continuam funcionando normalmente.

**Opcional e mais estável:** se você tiver uma *YouTube Data API v3* (Google Cloud →
Ativar API → criar chave), defina a variável de ambiente `YOUTUBE_API_KEY` no servidor.
O app usa a API oficial primeiro e só cai para o método sem chave se ela falhar.
No Render: **Environment → Add Environment Variable** → `YOUTUBE_API_KEY`.

**Links aceitos diretamente:**

- `https://www.youtube.com/watch?v=ID`
- `https://youtu.be/ID`
- `https://www.youtube.com/shorts/ID`
- `https://www.youtube.com/embed/ID`
- `https://www.youtube.com/live/ID`
- o próprio ID de 11 caracteres

Títulos e canais vêm do endpoint público de oEmbed do YouTube (sem API key). Se o
YouTube estiver fora do ar ou bloquear a consulta, o título aparece como `Vídeo ID` e
o player continua funcionando.

## Limitações conhecidas

- A sincronia é "por poll": o servidor corrige a cada 5s e quando o desvio passa de
  ~1,4s. Em conexões muito instáveis pode dar um pequeno pulo.
- Alguns vídeos bloqueiam reprodução incorporada (embed). Nesses casos o player mostra
  a mensagem do próprio YouTube; use outro vídeo.
- O estado das salas fica **em memória**. Se o servidor reiniciar, as salas são perdidas
  (os amigos só precisam criar/entrar de novo).
- Salas vazias são apagadas após 30 minutos. O DJ é transferido automaticamente para
  outra pessoa 15s depois que o DJ original sai.
- Sem login: qualquer pessoa com o código da sala entra. Use um código difícil de adivinhar
  (o gerador já evita caracteres ambíguos).
- Para evitar spam, cada pessoa pode pedir no máximo 1 música por nome a cada 2,5s
  (links diretos: 1 a cada 1,2s).

## API

| Rota | Método | Descrição |
|------|--------|-----------|
| `/health` | GET | Health check para o Render |
| `/api/room` | POST | Cria sala → `{ code, url }` |
| `/api/room/:code` | GET | Info básica da sala |
| `/ws` | WebSocket | Canal de estado, fila e chat |

## Estrutura

```
dj-sync/
├── server.js            # Express + ws, salas, sincronização, oEmbed
├── public/
│   ├── index.html       # Landing + sala
│   ├── styles.css
│   ├── app.js           # Cliente: WebSocket + YouTube IFrame API
│   └── config.js        # URL do backend (vazio = mesmo domínio)
├── package.json
├── render.yaml
├── vercel.json             # deploy do frontend estático
├── .env.example            # configuração do bot da Twitch
└── README.md
```
