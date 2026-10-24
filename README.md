# mcp-sync

Sincroniza a **declaração** dos servidores MCP entre **opencode**, **Claude Code** e **Codex** — em qualquer direção. Adicionar, alterar ou remover um MCP em um agente se reflete nos outros.

O `mcp-sync` **nunca copia credenciais**. Ele propaga só a definição (nome, transporte, url, comando, nomes de variáveis de ambiente) e deixa cada agente autenticar por conta própria.

## Como funciona

Reconcile idempotente em duas etapas — nada de daemon:

```
mcp-sync plan     # mostra o diff entre os agentes (não escreve nada)
mcp-sync apply    # aplica o plano (com backup)
```

- Detecta MCPs novos, alterados e removidos comparando com o snapshot do último sync.
- Remoção propaga para todos, com **tombstone** para impedir re-adição acidental.
- Config inválido/ilegível faz o agente sair da rodada — nunca é tratado como remoção.
- Conflitos (alterado em um e removido em outro) são reportados, não aplicados.

## Instalação

Requer Node.js. Dentro do repositório:

```sh
npm install
npm link          # ou: ln -s "$PWD/bin/mcp-sync" ~/.local/bin/mcp-sync
```

Isso coloca o comando `mcp-sync` no PATH.

## Uso

```sh
mcp-sync plan                      # o que mudaria (somente leitura)
mcp-sync apply --yes               # aplica (faz backup antes)
mcp-sync status                    # status de auth por agente
mcp-sync rollback [timestamp]      # restaura o último backup (ou um específico)
mcp-sync projects add|rm|ls|suggest [path]
mcp-sync forget <nome>             # limpa o tombstone de um servidor
mcp-sync doctor                    # checkup geral (read-only) do plugin neste repositório
mcp-sync refresh                   # reinstala skill/regras a partir das preferências + doctor
mcp-sync check                     # sai != 0 se há drift (para notificação periódica)
mcp-sync targets                   # quais arquivos são lidos/escritos
```

Fluxo típico:

```sh
mcp-sync plan
mcp-sync apply --yes
# autenticar onde o apply indicou:
opencode mcp auth <nome>
codex mcp login <nome>
# Claude: abrir /mcp na TUI
mcp-sync status
```

## Setup e preferências

Na primeira vez, rode o onboarding. Ele pergunta uma vez e grava as preferências em
`~/.config/mcp-sync/config.json` (respeitando `XDG_CONFIG_HOME`):

```sh
mcp-sync setup          # [1] aceitar defaults recomendados  [2] passar pelas perguntas
mcp-sync setup --defaults
mcp-sync config         # mostra as preferências + o caminho do arquivo
mcp-sync config get newServerScope
mcp-sync config set onScopeConflict move
mcp-sync config path
```

Preferências (defaults recomendados):

| Chave | Default | Efeito |
|---|---|---|
| `newServerScope` | `ask` | ao adicionar MCP novo, sempre perguntar (`ask`), ou fixar `global`/`project` |
| `onScopeConflict` | `ask` | quando o nome já existe em outro escopo: `ask` / `move` / `keep-both` |
| `requireApplyConfirmation` | `true` | `apply` só escreve com `--yes` |
| `secretLeakCheck` | `true` | varre segredos após escrever |
| `massDeleteThreshold` | `5` | remoções acima disso exigem `--allow-mass-delete` |
| `skillTargets` | `["agents"]` | roots globais da skill |
| `rulesEnabled` | `true` | instalar o snippet de regra (checkup no início da sessão) |

Completo (`setupComplete: true`), o `mcp-sync` **nunca pergunta** as preferências de novo:
leia/mude com `config` ou editando o arquivo.

### Perguntas são de múltipla escolha

Toda pergunta do `mcp-sync` (e da skill) é apresentada como **múltipla escolha com uma opção
recomendada** — você seleciona e dá enter, sem digitar texto. No CLI:

```
mcp-sync setup — how do you want to configure?
  [1] accept the recommended defaults (fast)  (recommended)
  [2] walk through the preferences
> (Enter = 1)
```

Enter aceita a recomendada; digitar o número escolhe outra. A skill instrui o agente a usar
o menu de seleção do cliente (ex.: `question` do opencode) com uma opção marcada
"(recommended)".

## Escopo: não existe default

Ao adicionar um MCP novo, **não há escopo padrão** — é escolha do usuário (global ou
projeto). O `mcp-sync` nunca decide sozinho: um servidor novo aparece no `plan` com `?`
(escopo ainda não escolhido) e o `apply` **recusa** colocá-lo sem uma escolha explícita.

Resolva de uma das formas:

```sh
mcp-sync apply --yes                 # pergunta interativamente (TTY)
mcp-sync apply --yes --scope global  # global em todos os projetos
mcp-sync apply --yes --scope project # projeto atual
mcp-sync apply --yes --scope "project:/caminho/do/repo"
```

Se o servidor foi declarado no escopo errado (ex.: o default `local` do `claude mcp add`),
escolher outro escopo o **reloca**: remove do escopo antigo e adiciona no escolhido.

Se o **nome já existir em outro escopo**, a escolha aparece **só nesse momento**:
`keep both` (mantém nos dois) ou `move` (remove o outro). Nada disso é configurado no
onboarding.

Para relocar um servidor **já sincronizado**, use o comando dedicado (o `apply --scope` não
mexe em servidor já sincronizado):

```sh
mcp-sync move <nome> --to "project:/caminho/do/repo" [--from global]
```

Ao adicionar nativamente, escolha o escopo correto na hora:

| Escopo | Claude Code | opencode | Codex |
|---|---|---|---|
| global | `claude mcp add -s user ...` | `opencode mcp add ...` | `codex mcp add ...` |
| projeto | `claude mcp add -s project ...` | editar `<repo>/opencode.json` | `<repo>/.codex/config.toml` (se existir) |

A skill reforça isso: o agente sempre pergunta o escopo antes de adicionar.

## O que sincroniza

| | Claude Code | opencode | Codex |
|---|---|---|---|
| global | `~/.claude.json` → `mcpServers` | `~/.config/opencode/opencode.json` → `mcp` | `~/.codex/config.toml` → `[mcp_servers]` |
| projeto (compartilhado) | `<p>/.mcp.json` | `<p>/opencode.json` | `<p>/.codex/config.toml` (só se existir) |
| projeto (privado) | `~/.claude.json` → `projects[p].mcpServers` | — | — |

Só projetos **registrados** (`mcp-sync projects add <path>`) são sincronizados.

## O que NÃO sincroniza

- Valores de segredo (token, header `Authorization`, env sensível).
- `approval_mode` / permissões por ferramenta.
- MCPs fornecidos por plugin (ex.: o ai-memory como plugin do Codex).
- Hermes.

## Segredos

Valores nunca são copiados. Na propagação eles viram referência no formato do agente de destino:

| Agente | Referência |
|---|---|
| opencode | `{env:VAR}` |
| Claude Code | `${VAR}` |
| Codex | `env_vars = ["VAR"]`, `bearer_token_env_var`, `env_http_headers` |

Depois de escrever, um scanner procura por `Authorization`/`Bearer`/alta entropia nos arquivos e aborta aquele arquivo se encontrar algo suspeito.

## Segurança

- **Backup** de todo arquivo antes de escrever, em `~/.local/state/mcp-sync/backups/<ts>/`.
- **Rollback** com um comando restaura byte a byte.
- **Escrita atômica** (tmp + rename), preservando chaves e formatação desconhecidas.
- **Lock** durante o `apply`.
- **Remoção em massa** (> 5 servidores, ou > 50% dos conhecidos) exige `--allow-mass-delete`.
- **Privado no Claude** só vai para arquivo de projeto se ele não estiver versionado no git; senão aparece como `blocked`.

## Auth

Não existe "fila de auth": ao fim do `apply` o `mcp-sync` imprime um checklist com o comando oficial de cada agente. `mcp-sync status` consulta o status do opencode e do Codex; o Claude não expõe status de auth por CLI (aparece como desconhecido).

## Notificação periódica (opcional)

`mcp-sync check` não escreve nada e sai com código `!= 0` quando há drift. Pode ser agendado (ex.: LaunchAgent no macOS) só para avisar:

```sh
mcp-sync check || echo "mcp-sync: drift detectado"
```

## Agent Skill (opcional)

O repositório inclui uma Agent Skill (`skill/mcp-sync/`) que ensina o agente a usar o
`mcp-sync` por **intenção semântica** ("sincroniza meus MCPs", "remove o MCP X", "meus MCPs
estão em sync?") e a rodar um **checkup de setup/saúde** no início da sessão.

Instale no seu escopo global:

```sh
mcp-sync skill install          # ~/.agents/skills/mcp-sync (symlink) + snippet de regra
mcp-sync skill status           # onde está instalado
mcp-sync skill uninstall        # remove (só o que é gerenciado pelo mcp-sync)
```

- `--target agents|claude|opencode|all` escolhe o root global (default `agents`).
- `--copy` copia em vez de symlinkar.
- `--no-rules` não escreve o snippet em `~/.config/opencode/AGENTS.md` / `~/.claude/CLAUDE.md`.
- `--force` sobrescreve/remove itens não gerenciados.

O snippet de regra só manda **carregar a skill e rodar o checkup** (read-only); ele nunca
aplica mudanças sozinho. O checkup também pode ser rodado direto:

```sh
mcp-sync doctor                  # relatório completo (read-only)
bash skill/mcp-sync/scripts/checkup.sh
```

## Checkup geral (`doctor`)

`mcp-sync doctor` é um relatório **read-only** do plugin dentro do repositório atual:
binário/versão, preferências, diretórios (XDG), agentes detectados, projetos registrados,
estado da skill/regras, drift, conflitos e bloqueados. Termina numa linha `HEALTH:` e sai
com código `!= 0` quando há problema (ex.: `needs-setup`, `conflicts`, `blocked`,
`skill-missing`) — útil para CI ou para a skill no início da sessão.

```sh
mcp-sync doctor || echo "mcp-sync: precisa de atenção"
```

`mcp-sync refresh` reinstala a skill e os snippets de regra a partir das preferências
(`skillTargets`, `rulesEnabled`) e roda o `doctor` em seguida — o "consertar e verificar".

## Desenvolvimento

```sh
npm test          # suíte de testes (node --test via tsx)
npm run typecheck # tsc --noEmit
```

## Limitações

- O Codex não tem escopo de projeto por CLI; `<p>/.codex/config.toml` só é usado se já existir.
- Conflitos são apenas reportados (não há resolução automática de "quem vence"); use `mcp-sync move` para relocar.
- Formatos dos CLIs mudam entre versões; os leitores/escritores refletem opencode 1.19.3, Claude Code 2.1.63 e Codex 0.163.0.