# Mentes do Una Podcast - Sistema de Sorteio

Projeto estatico feito somente com HTML, CSS e JavaScript.

## Rotas

- `/` - tela inicial com links.
- `/painel/` - painel de controle do sorteio.
- `/apresentacao/` - tela publica para TV, monitor, projetor ou telao.

## Recursos

- Sorteio sem repeticao dentro da faixa configurada.
- Nome do evento configuravel.
- Logo configuravel pelo painel e salva no `localStorage`.
- Placeholder elegante `LOGO` quando nenhuma imagem esta salva.
- Aceita PNG, JPG, JPEG e SVG.
- Sincronizacao entre telas via `BroadcastChannel` e evento `storage`.
- Sincronizacao online entre dispositivos via Firebase Realtime Database.
- Historico local e exportacao Excel via SheetJS em `.xlsx`, com fallback `.xls`.
- Sem banco de dados, sem backend, sem framework e sem npm install.

## Evento/sala

Use o parametro `evento` para sincronizar dispositivos na mesma sala:

- `/painel/?evento=mentes-do-una`
- `/apresentacao/?evento=mentes-do-una`

Se o parametro nao for informado, o app usa `mentes-do-una`.

## Deploy na Vercel

Publique esta pasta como projeto estatico na Vercel. Nao existe build command.
O arquivo `vercel.json` ja esta configurado para URLs limpas.

O arquivo `assets/logo-mentes-do-una.png` e usado como logo padrao do sistema.
O espaco da logo usa fundo branco e proporcao `12496 x 5528`, mantendo a imagem
sem distorcao. Use `/painel/ > Configuracoes > Trocar logo` para carregar outra
logo no navegador, ou `Usar placeholder LOGO` para exibir o placeholder.
