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
- **Normalização de volume** — o servidor mede a loudness de cada música e ajusta o ganho
  automaticamente para todos. O DJ ainda pode corrigir com `−`, `+`, `↺` no painel da faixa;
  o ajuste manual sempre tem prioridade.
- **Chat da sala** com mensagens e avisos do sistema.
- **Letra sincronizada** — painel embaixo do player destaca o verso atual usando a mesma
  posição do servidor; funciona para o DJ e para os ouvintes. As letras vêm do LRCLIB
  (gratuito, sem chave) e ficam cacheadas no navegador.
- **Aguardando o próximo pedido** — se a música acabar e a fila estiver vazia, a sala entra
  em modo de espera e o próximo pedido (pelo site ou pelo `$sr`) começa a tocar sozinho,
  sem precisar apertar play.

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
6. O volume de cada música é medido e equilibrado automaticamente. Se ainda assim alguma
   estiver alta ou baixa, use o painel **🔊 Volume da faixa**: `−` diminui 10%, `+` aumenta
   10% e `↺` volta a 100%. O ajuste vale para aquela música em todas as pessoas da sala e
   fica salvo para quando ela tocar de novo.

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

Use uma **conta bot** ou a sua própria conta de Twitch. Para IRC os escopos necessários
são `chat:read` (ler mensagens) e `chat:edit` (responder) — são os nomes oficiais da Twitch;
`chat:write` é o nome usado pela API HTTP, não pelo IRC.

- **Forma rápida:** <https://twitchtokengenerator.com/> → **Bot Chat Token** → autorize
  com a conta desejada → copie o **Access token**. Se ele vier sem `oauth:`, adicione o
  prefixo na hora de preencher `TWITCH_OAUTH_TOKEN`. (O antigo twitchapps.com/tmi/ foi
  descontinuado.) É um serviço de terceiros — se preferir não usá-lo, use a opção abaixo.
- **Forma oficial:** instale a [Twitch CLI](https://dev.twitch.tv/docs/cli/) e rode:
  ```bash
  twitch token -u -s "chat:read chat:edit"
  ```
  Copie o token exibido e adicione o prefixo `oauth:` se necessário.

### 4.2. Configurar

Copie `.env.example` para `.env` na pasta `dj-sync` e preencha:

```env
TWITCH_CHANNEL=seucanal
TWITCH_BOT_NICK=seucanal
TWITCH_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_ROOM=LIVE23
TWITCH_SR_COMMANDS=$sr,!sr
TWITCH_CHAT_REPLY=true
TWITCH_ADMINS=outraconta,amigo   # opcional
```

- `TWITCH_CHANNEL`: canal que o bot vai ler, sem `#`.
- `TWITCH_BOT_NICK`: nome da conta do token. Se for a sua conta, use o mesmo nome do canal.
- `TWITCH_ROOM`: código fixo da sala. O servidor **cria essa sala sozinho** ao iniciar.
  Abra `http://localhost:3000/r/LIVE23` e compartilhe esse link com seus amigos.
- `TWITCH_SR_COMMANDS`: aceita `$sr` e `!sr` por padrão (não conflita com os `!` do Nightbot).
- `TWITCH_ADMINS`: opcional. Moderadores e o broadcaster já podem controlar o player pelo
  chat; use esta variável para autorizar contas extras.

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

Digite `$comandos` (ou `$help`, `$ajuda`, com `!` também) para o bot responder com a lista
atualizada, já separando o que qualquer pessoa pode usar do que é exclusivo dos moderadores.

Quando a música termina, a próxima da fila começa automaticamente para todo mundo. Para
isso, o DJ precisa manter a aba aberta e ter clicado em **Ativar e ouvir** (os navegadores
só permitem áudio depois de um clique). Se a fila estiver vazia, a sala entra em modo
**aguardando o próximo pedido**: o próximo `$sr` (ou pedido pelo site) começa tocando sozinho.

### 4.4. Controlar o player pelo chat (moderadores)

Moderadores e o broadcaster do canal podem controlar o player **sem entrar na sala como DJ**:

```
$pausar    # pausa para todos
$pular     # toca a próxima da fila
$voltar    # volta para a música anterior
```

Os aliases `!pausar`, `!pular`, `!voltar`, `$pause`, `$next` e `$previous` também funcionam.
O bot confirma no chat, por exemplo: `⏭️ Tocando agora: PSY – GANGNAM STYLE... (por @moduser)`.
Qualquer outra pessoa recebe `@user: esse comando é só para moderadores do chat.` (no máximo
uma vez a cada 30 s, para não floodingar o chat). Para autorizar contas extras, use
`TWITCH_ADMINS`.

### 4.5. Histórico de pedidos por pessoa (gosto musical)

Todo pedido (do chat da Twitch, do `!sr` da sala ou do campo da fila) fica guardado com o
nome de quem pediu. No site, o painel **Gosto musical** mostra cada pessoa e suas músicas;
o botão **+ fila** coloca uma música antiga de volta na fila, para tocar em outro momento.

No chat da Twitch:

```
$lista @eagle     # últimos pedidos de eagle
$lista            # ranking de quem mais pediu
```

Os nomes `!lista`, `$list` e `!list` também funcionam. O histórico é guardado no servidor
enquanto ele estiver no ar e também no navegador do DJ. Se o servidor reiniciar (plano free
da Render), o DJ reconstrói o histórico automaticamente ao entrar na sala.

### 4.6. Problemas comuns

| Sintoma | Causa provável |
|---------|----------------|
| `Login authentication failed` no console | Token inválido/expirado — gere outro. |
| `Improperly formatted auth` | Confira se o token está completo (com ou sem `oauth:`). |
| Bot conecta mas não responde | Confira `TWITCH_CHANNEL` (minúsculas, sem `#`) e se `TWITCH_CHAT_REPLY` não é `false`. |
| Responde "sala ainda não está aberta" | `TWITCH_ROOM` diferente da sala usada no site. |
| Responde que os pedidos estão desativados | O DJ desmarcou **Permitir pedidos da fila** na interface. |
| Moderador recebe "só para moderadores" | A conta não tem badge de mod no canal, ou o bot reconectou antes do `CAP REQ :twitch.tv/tags`. Adicione a conta em `TWITCH_ADMINS` como alternativa. |
| Não quer resposta no chat | `TWITCH_CHAT_REPLY=false` (necessário se o token só tiver `chat:read`). |

## Normalização automática de volume (LUFS)

O player do YouTube é um iframe e não permite ler o áudio da página. Em vez de baixar o
vídeo (o YouTube bloqueia IPs de datacenter com "Sign in to confirm you're not a bot"),
o servidor lê a loudness integrada que o próprio YouTube publica na página do vídeo:

1. O servidor abre `youtube.com/watch?v=...` e lê o `ytInitialPlayerResponse`.
2. Dele tira `playerConfig.audioConfig.trackAbsoluteLoudnessLkfs` — o nível médio da faixa
   em LUFS, calculado pelo próprio YouTube. Não precisa de `yt-dlp`, `ffmpeg` ou cookies.
3. O servidor calcula o ganho para chegar a **−16 LUFS**, salva no mapa `gains` por `videoId`
   e manda para todos os ouvintes. O valor entra com um fade curto para não dar solavanco.
4. O resultado fica em cache: vídeos repetidos não são medidos de novo. Se falhar, o ajuste
   manual continua funcionando normalmente.

Variáveis opcionais:

| Variável | Padrão | O que faz |
|----------|--------|-----------|
| `DJ_SYNC_LOUDNESS` | `true` | `false` desativa a medição automática. |
| `DJ_SYNC_TARGET_LUFS` | `-16` | Nível alvo. Quanto mais negativo, mais baixo o resultado. |

Quando o ajuste acontece, o painel mostra um selo com a seta e o percentual (ex.: `↓ 53%`) e
o DJ recebe um aviso: `🔊 ↓ Volume de "..." ajustado automaticamente para 47%`.

Ajustes feitos pelo DJ no painel **🔊 Volume da faixa** nunca são sobrescritos pela medição.
A leitura pode demorar alguns segundos e, raramente, falhar se o YouTube não devolver os dados
da página — nesses casos o ganho simplesmente não muda.

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
